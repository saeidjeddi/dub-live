// Isolated world: bridge between page and extension


window.addEventListener("message", async (e) => {
  const d = e.data;
  if (e.source !== window || !d || !d.dubExt) return;
  if (d.type === "ready") sendCfg();
  if (d.type === "seg") {
    try {
      const r = await chrome.runtime.sendMessage({
        type: "dub",
        dir: "fa2en",
        wav: d.wav,
      });
      if (r && r.pcm)
        window.postMessage(
          { dubExt: true, type: "play", pcm: r.pcm, rate: r.rate },
          "*",
        );
      else if (r && r.error) console.warn("[dub]", r.error);
    } catch (err) {
      console.warn("[dub]", err);
    }
  }
});
chrome.storage.onChanged.addListener(sendCfg);
sendCfg();
