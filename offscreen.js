let voiceOn = true; // false = translated voice muted (subtitles keep working)
let ctx,
  origCtx,
  stream,
  proc,
  out,
  levelTimer,
  useBrowser = false,
  faVoice = null,
  live = null;
const playState = { next: 0 };
let seq = 0,
  nextPlay = 0;
const done = new Map();
const st = (status) =>
  chrome.runtime.sendMessage({ type: "status", status }).catch(() => {});

function flushPlayback() {
  // drop everything already scheduled
  if (!ctx) return;
  try {
    out.disconnect();
  } catch {}
  out = ctx.createGain();
  out.gain.value = voiceOn ? 1 : 0;
  out.connect(ctx.destination);
  playState.next = 0;
}

function speakBrowser(text, lang) {
  if (!voiceOn) return;
  const base = String(lang || "").toLowerCase().split("-")[0];
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().replace("_", "-").split("-")[0] === base);
  if (v) u.voice = v;
  else st({ stage: "tts_no_browser_voice", lang });
  if (speechSynthesis.pending) speechSynthesis.cancel(); // keep up with the call instead of queueing
  speechSynthesis.speak(u);
}

/* ---------- Engine A: streaming session (Gemini Live / OpenAI Realtime / pipeline, see providers.js) ---------- */
function liveStart(cfg) {
  const L = (live = { active: true, session: null, sent: 0, recv: 0, cap: 0 });
  L.statTimer = setInterval(
    () =>
      st({
        stage: "live_stats",
        sentChunks: L.sent,
        audioChunksReceived: L.recv,
        captionFragments: L.cap,
      }),
    10000,
  );
  speechSynthesis.getVoices(); // prime the voice list
  const QUIET = new Set(["heard", "said", "audio_sent", "audio_received"]);
  L.session = DubProviders.createSession({
    cfg: cfg.pc,
    source: cfg.srcLang, // language of the call
    target: cfg.lang, // language the user wants to hear
    keepAlive: false,
    onAudio: (pcm, rate) => {
      if (!ctx) return;
      L.recv++;
      if (playState.next - ctx.currentTime > 10) flushPlayback(); // fell too far behind: resync
      __DubKit.playPcm(ctx, out, pcm, rate || 24000, playState);
    },
    onInterrupted: flushPlayback,
    onSpeak: (text, lang) => speakBrowser(text, lang),
    onText: (x) => {
      if (x.translated) L.cap++;
      chrome.runtime.sendMessage({ type: "caption", ...x }).catch(() => {});
    },
    onStatus: (stage, extra) => {
      if (!QUIET.has(stage)) st({ stage: "live_" + stage, ...extra });
    },
  });

  const node = new AudioWorkletNode(ctx, "pcm-tap", {
    channelCount: 1,
    channelCountMode: "explicit",
  });
  node.port.onmessage = (e) => {
    if (!live) return;
    live.sent++;
    live.session.sendFrame(DubProviders.f32ToPcm16B64(e.data));
  };
  return node;
}

/* ---------- Engine B: chunked requests (old pipeline) ---------- */
function flush() {
  while (done.has(nextPlay)) {
    const r = done.get(nextPlay);
    done.delete(nextPlay);
    nextPlay++;
    if (ctx && r && r.pcm) __DubKit.playPcm(ctx, out, r.pcm, r.rate, playState);
    else if (ctx && r && r.text && useBrowser && voiceOn) {
      if (speechSynthesis.pending) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(r.text);
      u.lang = "fa-IR";
      if (faVoice) u.voice = faVoice;
      u.rate = 1.15;
      speechSynthesis.speak(u);
    }
  }
}

async function onSeg(f32, rate) {
  const id = seq++;
  let r = {};
  try {
    r = await chrome.runtime.sendMessage({
      type: "dub",
      dir: "en2fa",
      wav: __DubKit.toWavBase64(f32, rate),
      textOnly: useBrowser,
    });
    if (r && r.error) console.warn("[dub]", r.error);
  } catch (e) {
    console.warn("[dub]", e);
  }
  done.set(id, r);
  flush();
}

async function findFaVoice() {
  const pick = () =>
    speechSynthesis
      .getVoices()
      .find((v) => v.lang.toLowerCase().startsWith("fa"));
  if (!pick())
    await new Promise((res) => {
      speechSynthesis.onvoiceschanged = res;
      setTimeout(res, 1500);
    });
  return pick() || null;
}

function beep() {
  const o = ctx.createOscillator(),
    g = ctx.createGain();
  g.gain.value = 0.2;
  o.frequency.value = 880;
  o.connect(g);
  g.connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.2);
}

/* ---------- lifecycle ---------- */
async function start(cfg) {
  await stop();
  const isLive = cfg.engine === "live";
  if (!isLive) {
    faVoice = cfg.ttsMode === "browser" ? await findFaVoice() : null;
    useBrowser = !!faVoice;
    st({
      stage: "tts_mode",
      browserVoice: faVoice ? faVoice.name : null,
      using: useBrowser ? "browser" : "gemini",
    });
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: cfg.streamId,
      },
    },
  });
  ctx = isLive ? new AudioContext({ sampleRate: 16000 }) : new AudioContext();
  await ctx.resume();
  voiceOn = cfg.voiceOn !== false;
  out = ctx.createGain();
  out.gain.value = voiceOn ? 1 : 0;
  out.connect(ctx.destination);
  beep();
  const src = ctx.createMediaStreamSource(stream); // not routed to destination => original audio stays muted
  const an = ctx.createAnalyser();
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  levelTimer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let p = 0;
    for (const v of buf) p = Math.max(p, Math.abs(v));
    chrome.runtime
      .sendMessage({ type: "level", peak: +p.toFixed(4), ctxState: ctx.state })
      .catch(() => {});
  }, 1000);
  if (isLive && cfg.origVol > 0) {
    origCtx = new AudioContext(); // separate full-rate context so the original isn't downsampled to 16 kHz
    await origCtx.resume();
    const g = origCtx.createGain();
    g.gain.value = cfg.origVol / 100;
    origCtx.createMediaStreamSource(stream).connect(g);
    g.connect(origCtx.destination);
  }
  if (isLive) {
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    const p = liveStart(cfg);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(p);
    p.connect(mute);
    mute.connect(ctx.destination);
  } else {
    proc = await __DubKit.tap(ctx, src, onSeg, { minSeg: 6, maxSeg: 12 });
    st({ stage: "capturing", ctxState: ctx.state });
  }
}

async function stop() {
  clearInterval(levelTimer);
  if (live) {
    clearInterval(live.statTimer);
    live.active = false;
    try {
      live.session.close();
    } catch {}
    live = null;
  }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (origCtx) {
    await origCtx.close();
    origCtx = null;
  }
  if (ctx) await ctx.close();
  speechSynthesis.cancel();
  stream = ctx = proc = out = null;
  playState.next = 0;
  seq = nextPlay = 0;
  done.clear();
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== "offscreen") return;
  if (m.type === "start")
    start(m).catch((e) => {
      console.error(e);
      st({ stage: "error", error: "start failed: " + e.message });
    });
  if (m.type === "stop") stop();
  if (m.type === "cfg") {
    voiceOn = m.voiceOn !== false;
    if (out) out.gain.value = voiceOn ? 1 : 0;
    if (!voiceOn) speechSynthesis.cancel();
  }
});
