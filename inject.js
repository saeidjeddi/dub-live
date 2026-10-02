(() => {
  if (!navigator.mediaDevices || window.__dubInjected) return;
  window.__dubInjected = true;
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let cfg = { micDub: false },
    ctx,
    ttsGain,
    passGain;
  const playState = { next: 0 };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || !d.dubExt) return;
    if (d.type === "cfg") {
      cfg.micDub = !!d.micDub;
      if (passGain) passGain.gain.value = cfg.micDub ? 0 : 1;
    } else if (d.type === "play" && ctx && ttsGain) {
      __DubKit.playPcm(ctx, ttsGain, d.pcm, d.rate, playState);
    }
  });

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const real = await orig(constraints);
    if (!constraints || !constraints.audio) return real;
    ctx = ctx || new AudioContext();
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    passGain = ctx.createGain();
    passGain.gain.value = cfg.micDub ? 0 : 1; // real mic muted while dubbing
    ttsGain = ctx.createGain();
    const src = ctx.createMediaStreamSource(real);
    src.connect(passGain);
    passGain.connect(dest);
    ttsGain.connect(dest);
    __DubKit.tap(ctx, src, (f32, rate) => {
      if (!cfg.micDub) return;
      window.postMessage(
        { dubExt: true, type: "seg", wav: __DubKit.toWavBase64(f32, rate) },
        "*",
      );
    });
    return new MediaStream([
      ...dest.stream.getAudioTracks(),
      ...real.getVideoTracks(),
    ]);
  };

  window.postMessage({ dubExt: true, type: "ready" }, "*");
})();
