let coolUntil = 0,
  inflight = 0;
const chains = { fa2en: Promise.resolve(), en2fa: Promise.resolve() };

const PROMPTS = {
  fa2en:
    "Transcribe this Persian (Farsi) speech and translate it into natural, concise English. Output ONLY the English translation. If there is no intelligible speech, output exactly: NO_SPEECH",
  en2fa:
    "Transcribe this English speech and translate it into natural, colloquial Persian (Farsi script). Output ONLY the Persian translation. If there is no intelligible speech, output exactly: NO_SPEECH",
};

async function gemini(model, body) {
  const { key } = await chrome.storage.local.get("key");
  if (!key) throw new Error("API key not set");
  let r;
  for (let i = 0; i < 3; i++) {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      },
    );
    if (r.status !== 503) break; // temporary overload: retry with backoff
    await new Promise((res) => setTimeout(res, 700 * (i + 1)));
  }
  if (!r.ok)
    throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 700)}`);
  return r.json();
}

// List usable models for this key, newest first (lite variants last). Each model has its OWN free quota.
const exhausted = {};
async function listModels(kind) {
  const { key } = await chrome.storage.local.get("key");
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    {
      headers: { "x-goog-api-key": key },
    },
  );
  if (!r.ok)
    throw new Error(
      `ListModels ${r.status}: ${(await r.text()).slice(0, 300)}`,
    );
  const { models = [] } = await r.json();
  const ver = (n) =>
    parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const lite = (n) => (/lite/.test(n) ? 1 : 0);
  const ok = models
    .filter((m) =>
      (m.supportedGenerationMethods || []).includes("generateContent"),
    )
    .map((m) => m.name.replace("models/", ""))
    .filter((n) =>
      kind === "tts"
        ? /tts/.test(n)
        : /flash/.test(n) &&
          !/(tts|image|live|native|embed|robotics|computer|thinking)/.test(n),
    )
    .sort(
      (a, b) =>
        lite(a) - lite(b) || ver(b) - ver(a) || (/preview/.test(a) ? 1 : -1),
    );
  if (!ok.length) throw new Error(`no ${kind} model found for this key`);
  return ok.slice(0, 6);
}

async function callAuto(kind, userModel, body) {
  if (userModel) return gemini(userModel, body);
  const cacheKey = kind === "tts" ? "autoTts" : "autoStt";
  const listKey = cacheKey + "List";
  const st = await chrome.storage.local.get([cacheKey, listKey]);
  let cands = st[listKey];
  if (!cands || !cands.length) {
    cands = await listModels(kind);
    await chrome.storage.local.set({ [listKey]: cands });
  }
  // try the last working model first, then the rest
  if (st[cacheKey] && cands.includes(st[cacheKey]))
    cands = [st[cacheKey], ...cands.filter((m) => m !== st[cacheKey])];
  let lastErr;
  for (const m of cands) {
    if ((exhausted[m] || 0) > Date.now()) continue;
    try {
      const res = await gemini(m, body);
      await chrome.storage.local.set({ [cacheKey]: m });
      return res;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message);
      if (/Gemini 429/.test(msg)) {
        const t = msg.match(/retry in ([\d.]+)s/);
        exhausted[m] =
          Date.now() +
          Math.max(60, t ? Math.ceil(parseFloat(t[1])) + 1 : 0) * 1000;
        continue; // quota is per model: try the next one
      }
      if (/Gemini 404/.test(msg)) continue;
      throw e;
    }
  }
  throw lastErr || new Error("all candidate models are rate-limited");
}

// Newest model that supports the Live (bidi) API for this key
async function pickLiveModel() {
  const { key } = await chrome.storage.local.get("key");
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    { headers: { "x-goog-api-key": key } },
  );
  if (!r.ok) throw new Error("ListModels " + r.status);
  const { models = [] } = await r.json();
  const ver = (n) => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const c = models
    .filter((m) =>
      (m.supportedGenerationMethods || []).includes("bidiGenerateContent"),
    )
    .map((m) => m.name.replace("models/", ""))
    .filter((n) => !/transcribe/.test(n))
    .sort((a, b) => ver(b) - ver(a));
  if (!c.length) throw new Error("no live model");
  return c[0];
}

async function setStatus(o) {
  await chrome.storage.local.set({ status: { t: Date.now(), ...o } });
  const bad = o.stage === "error";
  chrome.action.setBadgeBackgroundColor({ color: bad ? "#d33" : "#2a2" });
  chrome.action.setBadgeText({
    text: bad ? "ERR" : o.stage === "ok" ? "OK" : "…",
  });
}

async function dub(dir, wav, textOnly) {
  await setStatus({ stage: "received", dir });
  const s = await chrome.storage.local.get(["sttModel", "ttsModel", "voice"]);
  const t = await callAuto("stt", s.sttModel, {
    contents: [
      {
        parts: [
          { text: PROMPTS[dir] },
          { inline_data: { mime_type: "audio/wav", data: wav } },
        ],
      },
    ],
  });
  const text = (t.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  if (!text || text.includes("NO_SPEECH")) {
    await setStatus({ stage: "no_speech", dir });
    return {};
  }
  await setStatus({ stage: "translated", dir, text });
  if (textOnly) return { text };
  const a = await callAuto("tts", s.ttsModel, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice || "Kore" } },
      },
    },
  });
  const pcm = a.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData || p.inline_data,
  );
  const data = pcm && (pcm.inlineData || pcm.inline_data).data;
  if (!data)
    throw new Error(
      "TTS returned no audio: " + JSON.stringify(a).slice(0, 300),
    );
  const used = await chrome.storage.local.get(["autoStt", "autoTts"]);
  await setStatus({
    stage: "ok",
    dir,
    text,
    stt: s.sttModel || used.autoStt,
    tts: s.ttsModel || used.autoTts,
  });
  return { pcm: data, rate: 24000, text };
}

async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (ctxs.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture tab audio and play dubbed speech",
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.target === "offscreen") return;
  if (msg.type === "dub") {
    if (msg.dir === "en2fa") {
      if (Date.now() < coolUntil) {
        setStatus({
          stage: "cooldown",
          dir: msg.dir,
          until: new Date(coolUntil).toLocaleTimeString(),
        });
        send({});
        return true;
      }
      if (inflight >= 2) {
        send({});
        return true;
      } // drop segment instead of falling further behind
      inflight++;
    }
    const run = () =>
      dub(msg.dir, msg.wav, msg.textOnly).catch(async (e) => {
        const error = String(e.message || e);
        if (/Gemini 429/.test(error)) {
          const m = error.match(/retry in ([\d.]+)s/); // honour the server's retry hint
          coolUntil =
            Date.now() + (m ? Math.ceil(parseFloat(m[1])) + 1 : 20) * 1000;
        }
        await setStatus({ stage: "error", dir: msg.dir, error });
        return { error };
      });
    // en2fa runs in parallel (offscreen re-orders playback); fa2en stays serial
    const p = msg.dir === "en2fa" ? run() : chains[msg.dir].then(run);
    if (msg.dir !== "en2fa") chains[msg.dir] = p.catch(() => {});
    p.then((r) => {
      if (msg.dir === "en2fa") inflight--;
      send(r);
    });
    return true;
  }
  if (msg.type === "startTab") {
    (async () => {
      await chrome.storage.local.set({ log: [] });
      const s = await chrome.storage.local.get([
        "ttsMode",
        "engine",
        "key",
        "voice",
        "liveModel",
        "target",
        "origVol",
        "voiceOn",
        "subs",
        "subsOrig",
      ]);
      const engine = s.engine || "live";
      const liveModel = s.liveModel || "gemini-3.5-live-translate-preview";
      await ensureOffscreen();
      if (msg.tabId != null) {
        await chrome.storage.local.set({ captionTabId: msg.tabId });
        if (s.subs !== false) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: msg.tabId },
              files: ["caption.js"],
            });
            await chrome.tabs.sendMessage(msg.tabId, {
              type: "captionCfg",
              on: true,
              showOrig: !!s.subsOrig,
            });
          } catch (e) {
            setStatus({
              stage: "caption_error",
              error: String(e.message || e),
            });
          }
        }
      }
      chrome.runtime.sendMessage({
        target: "offscreen",
        type: "start",
        streamId: msg.streamId,
        engine,
        ttsMode: s.ttsMode || "browser",
        key: s.key,
        voice: s.voice,
        liveModel,
        lang: s.target || "fa",
        origVol: s.origVol == null ? 20 : s.origVol,
        voiceOn: s.voiceOn !== false,
      });
      send({ ok: true });
    })();
    return true;
  }
  if (msg.type === "caption") {
    chrome.storage.local.get(["captionTabId", "subs"]).then((s) => {
      if (s.subs !== false && s.captionTabId != null)
        chrome.tabs.sendMessage(s.captionTabId, msg).catch(() => {});
    });
    return;
  }
  if (msg.type === "level") {
    chrome.storage.local.set({
      level: { t: Date.now(), peak: msg.peak, ctxState: msg.ctxState },
    });
    return;
  }
  if (msg.type === "status") {
    setStatus(msg.status);
    chrome.storage.local.get("log").then(({ log = [] }) => {
      log.push({ t: new Date().toLocaleTimeString(), ...msg.status });
      chrome.storage.local.set({ log: log.slice(-30) });
    });
    return;
  }
  if (msg.type === "stopTab") {
    chrome.storage.local.get("captionTabId").then((s) => {
      if (s.captionTabId != null)
        chrome.tabs
          .sendMessage(s.captionTabId, { type: "captionCfg", on: false })
          .catch(() => {});
    });
    chrome.runtime
      .sendMessage({ target: "offscreen", type: "stop" })
      .catch(() => {});
    send({ ok: true });
  }
});

// toggling "play dubbed voice" in the popup applies instantly to a running session
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.voiceOn) {
    chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: "cfg",
        voiceOn: changes.voiceOn.newValue !== false,
      })
      .catch(() => {});
  }
});
