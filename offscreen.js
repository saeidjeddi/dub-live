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

/* ---------- Engine A: Live API (streaming) ---------- */
function liveStart(cfg) {
  const L = (live = {
    active: true,
    ready: false,
    tries: 0,
    variant: 0,
    ws: null,
    sent: 0,
    recv: 0,
    cap: 0,
  });
  L.statTimer = setInterval(
    () =>
      st({
        stage: "live_stats",
        ready: L.ready,
        wsState: L.ws && L.ws.readyState,
        sentChunks: L.sent,
        audioChunksReceived: L.recv,
        captionFragments: L.cap,
      }),
    3000,
  );
  const connect = () => {
    const url =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
      encodeURIComponent(cfg.key);
    const ws = (L.ws = new WebSocket(url));
    L.ready = false;
    st({ stage: "live_connecting", model: cfg.liveModel, try: L.tries });
    ws.onopen = () => {
      // The server's real schema differs from the docs example (it rejected inputAudioTranscription inside generationConfig),
      // so we try schema variants in order and move to the next one whenever the server answers 1007 (invalid payload).
      const tr = {
        translationConfig: {
          targetLanguageCode: cfg.lang || "fa",
          echoTargetLanguage: false,
        },
      };
      const V = L.variant;
      const gen = { responseModalities: ["AUDIO"] };
      const setup = { model: "models/" + cfg.liveModel, generationConfig: gen };
      if (V === 0 || V === 2) Object.assign(gen, tr);
      else Object.assign(setup, tr);
      if (V === 0 || V === 1) {
        setup.inputAudioTranscription = {};
        setup.outputAudioTranscription = {};
      }
      st({
        stage: "live_setup_variant",
        variant: V,
        setup: JSON.stringify(setup),
      });
      ws.send(JSON.stringify({ setup }));
    };
    ws.onmessage = async (e) => {
      let m;
      try {
        m = JSON.parse(
          typeof e.data === "string" ? e.data : await e.data.text(),
        );
      } catch {
        return;
      }
      if (!m.setupComplete && !m.serverContent)
        st({ stage: "live_msg", raw: JSON.stringify(m).slice(0, 400) });
      if (m.setupComplete) {
        L.ready = true;
        L.tries = 0;
        st({ stage: "live_ready", model: cfg.liveModel, variant: L.variant });
        return;
      }
      const sc = m.serverContent;
      if (sc) {
        if (sc.interrupted) flushPlayback();
        for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) {
          if (p.inlineData && p.inlineData.data && ctx) {
            L.recv++;
            if (playState.next - ctx.currentTime > 10) flushPlayback(); // fell too far behind: resync
            __DubKit.playPcm(ctx, out, p.inlineData.data, 24000, playState);
          }
        }
        const cap = (x) =>
          chrome.runtime.sendMessage({ type: "caption", ...x }).catch(() => {});
        if (sc.inputTranscription && sc.inputTranscription.text)
          cap({ heard: sc.inputTranscription.text });
        if (sc.outputTranscription && sc.outputTranscription.text) {
          L.cap++;
          cap({ translated: sc.outputTranscription.text });
        }
        if (sc.turnComplete || sc.generationComplete) cap({ end: true });
      }
    };
    ws.onerror = () =>
      st({
        stage: "live_ws_error",
        note: "websocket error event (details are in the close event)",
      });
    ws.onclose = (e) => {
      const wasReady = L.ready;
      L.ready = false;
      st({ stage: "live_closed", code: e.code, reason: e.reason, wasReady });
      if (!L.active) return;
      if (!wasReady && e.code === 1007 && L.variant < 3) {
        L.variant++;
        return connect();
      } // payload rejected: try next schema
      if (L.tries++ < 5)
        setTimeout(() => L.active && connect(), 1000 * L.tries);
      else
        st({
          stage: "error",
          error: `live: gave up. last close ${e.code} ${e.reason}`,
        });
    };
  };
  connect();

  const node = new AudioWorkletNode(ctx, "pcm-tap", {
    channelCount: 1,
    channelCountMode: "explicit",
  });
  node.port.onmessage = (e) => {
    if (!live || !live.ready || live.ws.readyState !== 1) return;
    const f = e.data,
      i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++)
      i16[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    live.sent++;
    live.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: btoa(bin), mimeType: "audio/pcm;rate=16000" },
        },
      }),
    );
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
    proc = __DubKit.tap(ctx, src, onSeg, { minSeg: 6, maxSeg: 12 });
    st({ stage: "capturing", ctxState: ctx.state });
  }
}

async function stop() {
  clearInterval(levelTimer);
  if (live) {
    clearInterval(live.statTimer);
    live.active = false;
    try {
      live.ws.close();
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
