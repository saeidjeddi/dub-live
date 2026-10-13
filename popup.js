const $ = (id) => document.getElementById(id);

const FIELDS = {
  provider: "provider",
  key: "key",
  stt: "liveModel",
  openaiKey: "openaiKey",
  oaRealtimeModel: "oaRealtimeModel",
  pBase: "pBase",
  pStt: "pStt",
  pChat: "pChat",
  pTts: "pTts",
  pVoice: "pVoice",
  groqKey: "groqKey",
  gStt: "gStt",
  gChat: "gChat",
  gTts: "gTts",
  gVoice: "gVoice",
  userLang: "userLang",
  friendLang: "friendLang",
  origVol: "origVol",
  subs: "subs",
  subsOrig: "subsOrig",
  voiceOn: "voiceOn",
  micOn: "micOn",
};

const DEFAULT_BASE = "https://api.openai.com/v1";
const showProvider = () => {
  const p = $("provider").value;
  document.querySelectorAll("[data-for]").forEach((el) => {
    el.hidden = !el.dataset.for.split(" ").includes(p);
  });
};

chrome.storage.local.get([...Object.values(FIELDS), "target"]).then((s) => {
  $("provider").value = s.provider || "gemini";
  $("key").value = s.key || "";
  $("stt").value = s.liveModel || "";
  $("openaiKey").value = s.openaiKey || "";
  $("oaRealtimeModel").value = s.oaRealtimeModel || "";
  $("pBase").value = s.pBase || "";
  $("pStt").value = s.pStt || "";
  $("pChat").value = s.pChat || "";
  // empty TTS model is meaningful (captions only), so only a never-saved value falls back to the placeholder
  $("pTts").value = typeof s.pTts === "string" ? s.pTts : "gpt-4o-mini-tts";
  $("pVoice").value = s.pVoice || "";
  $("groqKey").value = s.groqKey || "";
  $("gStt").value = s.gStt || "";
  $("gChat").value = s.gChat || "";
  $("gTts").value = typeof s.gTts === "string" ? s.gTts : "browser";
  $("gVoice").value = s.gVoice || "";
  showProvider();
  $("userLang").value = s.userLang || s.target || "fa";
  $("friendLang").value = s.friendLang || "en";
  $("origVol").value = s.origVol == null ? 0 : s.origVol;
  $("subs").checked = s.subs !== false;
  $("subsOrig").checked = !!s.subsOrig;
  $("voiceOn").checked = s.voiceOn !== false;
  $("micOn").checked = s.micOn !== false;
  showVol();
});

const showVol = () => { $("vv").textContent = $("origVol").value + "%"; };
const save = () => chrome.storage.local.set({
  provider: $("provider").value,
  key: $("key").value.trim(),
  liveModel: $("stt").value.trim(),
  openaiKey: $("openaiKey").value.trim(),
  oaRealtimeModel: $("oaRealtimeModel").value.trim(),
  pBase: $("pBase").value.trim(),
  pStt: $("pStt").value.trim(),
  pChat: $("pChat").value.trim(),
  pTts: $("pTts").value.trim(),
  pVoice: $("pVoice").value.trim(),
  groqKey: $("groqKey").value.trim(),
  gStt: $("gStt").value.trim(),
  gChat: $("gChat").value.trim(),
  gTts: $("gTts").value.trim(),
  gVoice: $("gVoice").value.trim(),
  userLang: $("userLang").value.trim() || "fa",
  friendLang: $("friendLang").value.trim() || "en",
  // Keep the legacy field aligned for compatibility with old config readers.
  target: $("userLang").value.trim() || "fa",
  origVol: +$("origVol").value,
  subs: $("subs").checked,
  subsOrig: $("subsOrig").checked,
  voiceOn: $("voiceOn").checked,
  micOn: $("micOn").checked,
  engine: "live",
});

Object.keys(FIELDS).forEach((id) => $(id).addEventListener("change", save));
$("origVol").addEventListener("input", showVol);
$("provider").addEventListener("change", showProvider);

// A custom OpenAI-compatible server needs host permission; must be requested from a user gesture.
async function ensureBaseAccess() {
  const raw = $("pBase").value.trim() || DEFAULT_BASE;
  let origin;
  try { origin = new URL(raw).origin; } catch { throw new Error("Base URL نامعتبر است."); }
  if (origin === new URL(DEFAULT_BASE).origin) return;
  const origins = [origin + "/*"];
  if (await chrome.permissions.contains({ origins })) return;
  if (!(await chrome.permissions.request({ origins }))) throw new Error("دسترسی به " + origin + " داده نشد.");
}

async function installMeetingBridge(tabId) {
  // The page-world hook replaces the outgoing WebRTC microphone track.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["common.js", "inject.js"],
  });
  // The isolated bridge forwards live microphone frames to the Gemini service worker.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["content.js"],
  });
}

$("start").onclick = async () => {
  $("start").disabled = true;
  try {
    const provider = $("provider").value;
    if (provider === "gemini") {
      if (!$("key").value.trim()) throw new Error("ابتدا Gemini API Key را وارد کنید.");
    } else if (provider === "groq") {
      if (!$("groqKey").value.trim()) throw new Error("ابتدا Groq API Key را وارد کنید.");
    } else {
      if (!$("openaiKey").value.trim()) throw new Error("ابتدا API Key را وارد کنید.");
      if (provider === "pipeline" || $("pBase").value.trim()) await ensureBaseAccess();
    }
    await save();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      throw new Error("صفحهٔ جلسه باید یک وب‌سایت http یا https باشد.");
    }

    await chrome.runtime.sendMessage({ type: "stopTab" }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));
    await chrome.storage.local.set({ log: [] });
    await chrome.storage.local.remove(["status", "level", "micLevel"]);

    const micOn = $("micOn").checked;
    // When "translate my speech" is off, the page's microphone is left untouched:
    // no hook is installed and the raw mic goes to the call as usual.
    if (micOn) {
      // activeTab permission is granted because the user clicked the extension action.
      await installMeetingBridge(tab.id);
      await chrome.tabs.sendMessage(tab.id, {
        type: "meetingCfg",
        enabled: true,
        sourceLang: $("userLang").value.trim() || "fa",
        targetLang: $("friendLang").value.trim() || "en",
        workletUrl: chrome.runtime.getURL("pcm-worklet.js"),
      });
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({
      type: "startTab",
      streamId,
      tabId: tab.id,
      userLang: $("userLang").value.trim() || "fa",
      friendLang: $("friendLang").value.trim() || "en",
      micOn,
    });
    if (res?.error) throw new Error(res.error);
    $("st").textContent = micOn
      ? "مترجم جلسه فعال است؛ اگر تماس باز است دوباره به تماس وصل شوید."
      : "مترجم جلسه فعال است؛ گفتار شما ترجمه نمی‌شود.";
  } catch (e) {
    $("st").textContent = "خطا: " + (e.message || e);
    await chrome.runtime.sendMessage({ type: "stopTab" }).catch(() => {});
  } finally {
    $("start").disabled = false;
  }
};

$("stop").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "stopTab" });
  chrome.action.setBadgeText({ text: "" });
  $("st").textContent = "مترجم جلسه متوقف شد";
};

$("voiceOn").addEventListener("change", () => {
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "cfg",
    voiceOn: $("voiceOn").checked,
  }).catch(() => {});
});

$("ver").textContent = "v" + chrome.runtime.getManifest().version;
const ago = (o) => Math.round((Date.now() - o.t) / 1000) + "s ago";
const showStatus = async () => {
  const { status, level, micLevel } = await chrome.storage.local.get(["status", "level", "micLevel"]);
  $("dbg").textContent = "status: " + (status ? JSON.stringify(status) + " " + ago(status) : "none") +
    "\nlevel: " + (level ? JSON.stringify(level) + " " + ago(level) : "none") +
    "\nmic level: " + (micLevel ? JSON.stringify(micLevel) + " " + ago(micLevel) : "none");
};
const showLog = async () => {
  const { log = [] } = await chrome.storage.local.get("log");
  $("log").textContent = log.slice().reverse().map((entry) => JSON.stringify(entry)).join("\n");
};
setInterval(() => { showStatus(); showLog(); }, 1000);
showStatus();
showLog();

$("copy").onclick = async () => {
  const { log = [], status, level, micLevel } = await chrome.storage.local.get(["log", "status", "level", "micLevel"]);
  await navigator.clipboard.writeText(JSON.stringify({ version: chrome.runtime.getManifest().version, status, level, micLevel, log }, null, 1));
  $("st").textContent = "لاگ کپی شد ✅";
};
$("clear").onclick = async () => {
  await chrome.storage.local.remove(["log", "status", "level", "micLevel"]);
  chrome.action.setBadgeText({ text: "" });
  $("st").textContent = "لاگ پاک شد 🧹";
  showStatus();
  showLog();
};

