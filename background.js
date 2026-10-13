importScripts("common.js", "providers.js");

let coolUntil = 0,
  inflight = 0;
let meetingMicLive = null;
let meetingMicLogQueue = Promise.resolve();
const chains = {
  fa2en: Promise.resolve(),
  en2fa: Promise.resolve(),
  fa2target: Promise.resolve(),
};

const PROMPTS = {
  fa2en:
    "Transcribe this Persian (Farsi) speech and translate it into natural, concise English. Output ONLY the English translation. If there is no intelligible speech, output exactly: NO_SPEECH",
  en2fa:
    "Transcribe this English speech and translate it into natural, colloquial Persian (Farsi script). Output ONLY the Persian translation. If there is no intelligible speech, output exactly: NO_SPEECH",
};

function meetingTranslationPrompt(source, target) {
  const sourceName = DubProviders.languageName(source);
  const targetName = DubProviders.languageName(target);
  return `Transcribe this ${sourceName} speech and translate it into natural, concise ${targetName}. Output ONLY the ${targetName} translation. If there is no intelligible speech, output exactly: NO_SPEECH`;
}

async function fetchTimed(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function gemini(model, body) {
  const { key } = await chrome.storage.local.get("key");
  if (!key) throw new Error("API key not set");
  let r;
  for (let i = 0; i < 3; i++) {
    r = await fetchTimed(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      },
      30000,
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
  const r = await fetchTimed(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    {
      headers: { "x-goog-api-key": key },
    },
    15000,
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

function logMeetingMic(stage, extra = {}) {
  const record = { source: "meeting_mic", stage, ...extra };
  meetingMicLogQueue = meetingMicLogQueue.then(async () => {
    await setStatus(record);
    const { log = [] } = await chrome.storage.local.get("log");
    log.push({ t: new Date().toLocaleTimeString(), ...record });
    await chrome.storage.local.set({ log: log.slice(-100) });
  }).catch(() => {});
  return meetingMicLogQueue;
}

async function logMicStatus(o) {
  await setStatus(o);
  const { log = [] } = await chrome.storage.local.get("log");
  log.push({ t: new Date().toLocaleTimeString(), source: "mic", ...o });
  await chrome.storage.local.set({ log: log.slice(-100) });
}

async function dub(dir, wav, textOnly, target, source) {
  const update = dir === "fa2target" || dir === "meetingMic" ? logMicStatus : setStatus;
  await update({ stage: "received", dir });
  const s = await chrome.storage.local.get(["sttModel", "ttsModel", "voice", "target"]);
  const prompt = dir === "meetingMic"
    ? meetingTranslationPrompt(source, target)
    : dir === "fa2target"
      ? meetingTranslationPrompt("fa", target || s.target)
      : PROMPTS[dir];
  await update({ stage: "transcribing", dir, model: s.sttModel || "auto" });
  const t = await callAuto("stt", s.sttModel, {
    contents: [
      {
        parts: [
          { text: prompt },
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
    await update({ stage: "no_speech", dir });
    return {};
  }
  await update({ stage: "translated", dir, text });
  if (textOnly) return { text };
  await update({ stage: "synthesizing", dir, model: s.ttsModel || "auto" });
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
  await update({
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

function stopMeetingMicLive() {
  const session = meetingMicLive;
  meetingMicLive = null;
  if (!session) return;
  session.stopped = true;
  try { session.impl?.close(); } catch {}
}

// Translates the user's own microphone (userLang -> friendLang) with the selected provider.
function startMeetingMicLive(config) {
  stopMeetingMicLive();
  const session = meetingMicLive = {
    tabId: config.tabId,
    trackId: null,
    stopped: false,
    receivedChunks: 0,
    hookCount: 0,
    impl: null,
  };
  const toPage = (extra) =>
    chrome.tabs.sendMessage(session.tabId, { type: "meetingMicAudio", trackId: session.trackId, ...extra }).catch(() => {});
  session.impl = DubProviders.createSession({
    cfg: config.cfg,
    source: config.source,
    target: config.target,
    keepAlive: true,
    onAudio: (pcm, rate) => {
      if (meetingMicLive !== session || !session.trackId) return;
      session.receivedChunks++;
      if (session.receivedChunks === 1 || session.receivedChunks % 25 === 0)
        logMeetingMic("audio_to_page", { chunks: session.receivedChunks, trackId: session.trackId });
      toPage({ pcm, rate });
    },
    onInterrupted: () => { if (meetingMicLive === session && session.trackId) toPage({ interrupted: true }); },
    onText: () => {},
    onStatus: (stage, extra) => { if (meetingMicLive === session) logMeetingMic(stage, extra); },
  });
}

// OpenAI's translation WebSocket authenticates with an Authorization header, which page-style WebSockets
// cannot set. This rule adds it (only for requests initiated by this extension) while a session runs.
const OPENAI_RULE_ID = 9001;
async function setOpenAIAuthRule(key) {
  let { oaSafetyId } = await chrome.storage.local.get("oaSafetyId");
  if (!oaSafetyId) {
    oaSafetyId = crypto.randomUUID();
    await chrome.storage.local.set({ oaSafetyId });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OPENAI_RULE_ID],
    addRules: [{
      id: OPENAI_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Authorization", operation: "set", value: "Bearer " + key },
          { header: "OpenAI-Safety-Identifier", operation: "set", value: oaSafetyId },
        ],
      },
      condition: {
        urlFilter: "||api.openai.com/v1/realtime/translations",
        resourceTypes: ["websocket"],
        initiatorDomains: [chrome.runtime.id],
      },
    }],
  });
}
const clearOpenAIAuthRule = () =>
  chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [OPENAI_RULE_ID] }).catch(() => {});
chrome.runtime.onStartup.addListener(clearOpenAIAuthRule);
chrome.runtime.onInstalled.addListener(clearOpenAIAuthRule);

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.target === "offscreen") return;
  if (msg.type === "meetingMicHook") {
    const session = meetingMicLive;
    if (!session || session.tabId !== _sender.tab?.id) return;
    session.trackId = msg.trackId || session.trackId;
    session.hookCount++;
    logMeetingMic("track_hooked", { trackId: msg.trackId, tracks: session.hookCount });
    return;
  }
  if (msg.type === "meetingMicFrame") {
    const session = meetingMicLive;
    if (!session || session.tabId !== _sender.tab?.id || !msg.pcm) return;
    // Only one microphone route may feed the translation session. If the page exposes the same mic
    // through two tracks (clones / re-negotiation), forwarding both would send every word twice
    // and the translation would repeat. A different track is accepted only after the active one
    // has been silent for 1.5s (a genuine track swap).
    const now = Date.now();
    if (msg.trackId && session.trackId && msg.trackId !== session.trackId &&
        now - (session.lastFrameAt || 0) < 1500) {
      if (!session.multiTrackLogged) {
        session.multiTrackLogged = true;
        logMeetingMic("multiple_mic_tracks", { active: session.trackId, ignored: msg.trackId });
      }
      return;
    }
    session.trackId = msg.trackId || session.trackId;
    session.lastFrameAt = now;
    session.impl?.sendFrame(msg.pcm);
    return;
  }
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
      dub(msg.dir, msg.wav, msg.textOnly, msg.target).catch(async (e) => {
        const error = String(e.message || e);
        if (/Gemini 429/.test(error)) {
          const m = error.match(/retry in ([\d.]+)s/); // honour the server's retry hint
          coolUntil =
            Date.now() + (m ? Math.ceil(parseFloat(m[1])) + 1 : 20) * 1000;
        }
        const update = msg.dir === "fa2target" || msg.dir === "meetingMic" ? logMicStatus : setStatus;
        await update({ stage: "error", dir: msg.dir, error });
        return { error };
      });
    // en2fa runs in parallel (offscreen re-orders playback); fa2en stays serial
    const p = msg.dir === "en2fa" ? run() : (chains[msg.dir] || Promise.resolve()).then(run);
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
        ...DubProviders.STORAGE_KEYS,
        "ttsMode",
        "engine",
        "voice",
        "target",
        "userLang",
        "friendLang",
        "origVol",
        "voiceOn",
        "subs",
        "subsOrig",
        "micOn",
      ]);
      const engine = s.engine || "live";
      const pc = DubProviders.configFromStorage(s);
      const userLang = msg.userLang || s.userLang || s.target || "fa";
      const friendLang = msg.friendLang || s.friendLang || "en";
      const micOn = msg.micOn ?? (s.micOn !== false);
      if (!DubProviders.keyFor(pc)) {
        send({ error: "API key not set for provider: " + pc.provider });
        return;
      }
      if (pc.provider === "openai") await setOpenAIAuthRule(pc.openaiKey);
      else await clearOpenAIAuthRule();
      // Translating the user's own speech is optional: skip the mic session entirely when off.
      if (micOn) {
        startMeetingMicLive({ tabId: msg.tabId, cfg: pc, source: userLang, target: friendLang });
      } else {
        stopMeetingMicLive();
      }
      await ensureOffscreen();
      if (msg.tabId != null) {
        await chrome.storage.local.set({ captionTabId: msg.tabId, meetingTabId: msg.tabId });
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
        voice: s.voice,
        pc,
        lang: userLang, // language the user wants to hear
        srcLang: friendLang, // language spoken in the call
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
  if (msg.type === "micLevel") {
    chrome.storage.local.set({
      micLevel: { t: Date.now(), peak: msg.peak, ctxState: msg.ctxState },
    });
    return;
  }
  if (msg.type === "status") {
    setStatus(msg.status);
    chrome.storage.local.get("log").then(({ log = [] }) => {
      log.push({ t: new Date().toLocaleTimeString(), ...msg.status });
      chrome.storage.local.set({ log: log.slice(-100) });
    });
    return;
  }
  if (msg.type === "stopTab") {
    stopMeetingMicLive();
    clearOpenAIAuthRule();
    chrome.storage.local.get(["captionTabId", "meetingTabId"]).then((s) => {
      if (s.captionTabId != null)
        chrome.tabs
          .sendMessage(s.captionTabId, { type: "captionCfg", on: false })
          .catch(() => {});
      if (s.meetingTabId != null)
        chrome.tabs.sendMessage(s.meetingTabId, {
          type: "meetingCfg", enabled: false,
        }).catch(() => {});
      chrome.storage.local.remove(["meetingTabId"]);
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
