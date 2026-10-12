(() => {
  if (window.__dubMeetingBridgeInstalled) return;
  window.__dubMeetingBridgeInstalled = true;

  // After the extension is reloaded/updated, this script stays alive in already-open pages but every
  // chrome.* call throws "Extension context invalidated" (synchronously, so .catch() never sees it).
  // Detect that, detach our listeners and release the install guard so a fresh bridge can be injected.
  let dead = false;
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };
  const shutdown = () => {
    if (dead) return;
    dead = true;
    clearInterval(heartbeat);
    window.removeEventListener("message", onWindowMessage);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
    window.__dubMeetingBridgeInstalled = false;
    console.warn("[Dub Live] extension was reloaded; reload this tab to use the translator again.");
  };
  const heartbeat = setInterval(() => { if (!alive()) shutdown(); }, 2000);
  const send = async (message) => {
    if (!alive()) { shutdown(); return; }
    try { await chrome.runtime.sendMessage(message); }
    catch (error) {
      if (!alive()) shutdown();
      else console.warn("[Dub Live] failed to send message to the extension", error);
    }
  };

  const sendCfg = async (configuration) => {
    if (!alive()) { shutdown(); return; }
    const cfg = configuration || await chrome.storage.local.get(["userLang", "friendLang"]);
    window.postMessage({
      dubExt: true,
      type: "cfg",
      enabled: configuration?.enabled === true,
      sourceLang: configuration?.sourceLang || cfg.userLang || "fa",
      targetLang: configuration?.targetLang || cfg.friendLang || "en",
      workletUrl: chrome.runtime.getURL("pcm-worklet.js"),
    }, "*");
  };

  function onRuntimeMessage(message) {
    if (message.type === "meetingCfg") {
      sendCfg(message).catch(() => {});
    } else if (message.type === "meetingMicAudio") {
      window.postMessage({ dubExt: true, type: "translatedMic", trackId: message.trackId, pcm: message.pcm, rate: message.rate }, "*");
    } else if (message.type === "captionCfg" || message.type === "caption") {
      // Captions are handled by caption.js, if enabled for this site.
      window.dispatchEvent(new CustomEvent("dub-live-caption", { detail: message }));
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  function onWindowMessage(event) {
    const data = event.data;
    if (event.source !== window || !data?.dubExt) return;
    if (data.type === "micHookActive") {
      send({ type: "meetingMicHook", trackId: data.trackId });
    } else if (data.type === "micHookError") {
      send({
        type: "status",
        status: { source: "mic", stage: "mic_hook_error", error: data.error },
      });
    } else if (data.type === "micFrame") {
      send({
        type: "meetingMicFrame",
        trackId: data.trackId,
        sourceLang: data.sourceLang,
        targetLang: data.targetLang,
        pcm: data.pcm,
      });
    }
  }
  window.addEventListener("message", onWindowMessage);

  sendCfg().catch(() => {});
  window.postMessage({ dubExt: true, type: "bridgeReady" }, "*");
})();
