(() => {
  if (window.__dubMeetingBridgeInstalled) return;
  window.__dubMeetingBridgeInstalled = true;

  const sendCfg = async (configuration) => {
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "meetingCfg") {
      sendCfg(message);
    } else if (message.type === "meetingMicAudio") {
      window.postMessage({ dubExt: true, type: "translatedMic", trackId: message.trackId, pcm: message.pcm, rate: message.rate }, "*");
    } else if (message.type === "captionCfg" || message.type === "caption") {
      // Captions are handled by caption.js, if enabled for this site.
      window.dispatchEvent(new CustomEvent("dub-live-caption", { detail: message }));
    }
  });

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (event.source !== window || !data?.dubExt) return;
    if (data.type === "micHookActive") {
      chrome.runtime.sendMessage({ type: "meetingMicHook", trackId: data.trackId }).catch(() => {});
      return;
    }
    if (data.type === "micHookError") {
      chrome.runtime.sendMessage({
        type: "status",
        status: { source: "mic", stage: "mic_hook_error", error: data.error },
      }).catch(() => {});
      return;
    }
    if (data.type !== "micFrame") return;
    try {
      await chrome.runtime.sendMessage({
        type: "meetingMicFrame",
        trackId: data.trackId,
        sourceLang: data.sourceLang,
        targetLang: data.targetLang,
        pcm: data.pcm,
      });
    } catch (error) {
      console.warn("[Dub Live] failed to send microphone audio for translation", error);
    }
  });

  sendCfg();
  window.postMessage({ dubExt: true, type: "bridgeReady" }, "*");
})();
