// Shared helpers (VAD segmenter, WAV encoding, PCM playback)
var __DubKit = (() => {
  const TH = 0.01,
    SILENCE = 0.4,
    MIN_VOICE = 0.3,
    MAX_SEG = 6;

  function concat(chunks, len) {
    const out = new Float32Array(len);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  function makeSegmenter(inRate, onSegment, opts = {}) {
    const minSeg = opts.minSeg || 0,
      maxSeg = opts.maxSeg || MAX_SEG;
    let buf = [],
      len = 0,
      speaking = false,
      silent = 0,
      voiced = 0,
      prev = null;
    return (f32) => {
      let s = 0;
      for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
      const rms = Math.sqrt(s / f32.length),
        dur = f32.length / inRate;
      const copy = new Float32Array(f32);
      if (rms > TH) {
        if (!speaking && prev) {
          buf.push(prev);
          len += prev.length;
        }
        speaking = true;
        silent = 0;
        voiced += dur;
      } else if (speaking) silent += dur;
      if (speaking) {
        buf.push(copy);
        len += copy.length;
      }
      prev = copy;
      if (
        speaking &&
        ((silent >= SILENCE && len / inRate >= minSeg) ||
          len / inRate >= maxSeg)
      ) {
        if (voiced >= MIN_VOICE) onSegment(concat(buf, len), inRate);
        buf = [];
        len = 0;
        speaking = false;
        silent = 0;
        voiced = 0;
      }
    };
  }

  function toWavBase64(f32, inRate) {
    const target = 16000,
      ratio = inRate / target;
    const n = Math.floor(f32.length / ratio);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio),
        b = Math.min(f32.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < b; j++) sum += f32[j];
      const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + n * 2),
      dv = new DataView(buf);
    const w = (o, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
    };
    w(0, "RIFF");
    dv.setUint32(4, 36 + n * 2, true);
    w(8, "WAVE");
    w(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, target, true);
    dv.setUint32(28, target * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    w(36, "data");
    dv.setUint32(40, n * 2, true);
    new Int16Array(buf, 44).set(pcm);
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // base64 PCM s16le mono -> scheduled playback on `node`
  function playPcm(ctx, node, b64, rate, state) {
    const bin = atob(b64),
      n = bin.length >> 1,
      f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v & 0x8000) v -= 0x10000;
      f32[i] = v / 32768;
    }
    const ab = ctx.createBuffer(1, n, rate || 24000);
    ab.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(node);
    const t = Math.max(ctx.currentTime + 0.05, state.next || 0);
    src.start(t);
    state.next = t + ab.duration;
  }

  function tap(ctx, sourceNode, onSegment, opts) {
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const seg = makeSegmenter(ctx.sampleRate, onSegment, opts);
    proc.onaudioprocess = (e) => seg(e.inputBuffer.getChannelData(0));
    const mute = ctx.createGain();
    mute.gain.value = 0;
    sourceNode.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    return proc;
  }

  return { toWavBase64, playPcm, tap };
})();
