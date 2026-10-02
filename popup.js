const $ = (id) => document.getElementById(id);

// field id -> storage key (the first input is the Live Translate model)
const FIELDS = {
  key: "key",
  stt: "liveModel",
  tts: "ttsModel",
  voice: "voice",
  target: "target",
  origVol: "origVol",
  subs: "subs",
  subsOrig: "subsOrig",
  mic: "micDub",
  voiceOn: "voiceOn",
};

const showVol = () => {
  $("vv").textContent = $("origVol").value + "%";
};

chrome.storage.local.get(Object.values(FIELDS)).then((s) => {
  $("key").value = s.key || "";
  $("stt").value = s.liveModel || "";
  $("tts").value = s.ttsModel || "";
  $("voice").value = s.voice || "Kore";
  $("target").value = s.target || "fa";
  $("origVol").value = s.origVol == null ? 20 : s.origVol;
  $("subs").checked = s.subs !== false;
  $("subsOrig").checked = !!s.subsOrig;
  $("mic").checked = !!s.micDub;
  $("voiceOn").checked = s.voiceOn !== false;
  showVol();
});

const save = () =>
  chrome.storage.local.set({
    key: $("key").value.trim(),
    liveModel: $("stt").value.trim(),
    ttsModel: $("tts").value.trim(),
    voice: $("voice").value,
    target: $("target").value.trim() || "fa",
    origVol: +$("origVol").value,
    subs: $("subs").checked,
    subsOrig: $("subsOrig").checked,
    micDub: $("mic").checked,
    voiceOn: $("voiceOn").checked,
    engine: "live", // this popup has no engine switch; avoid being stuck on an old "chunk" value
  });

Object.keys(FIELDS).forEach((id) => $(id).addEventListener("change", save));
$("origVol").addEventListener("input", showVol);

$("start").onclick = async () => {
  await save();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    $("st").textContent = "تب فعالی پیدا نشد";
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: "stopTab" }); // release any previous capture first
    await new Promise((r) => setTimeout(r, 400));
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
    await chrome.runtime.sendMessage({
      type: "startTab",
      streamId,
      tabId: tab.id,
    });
    $("st").textContent = "فعال شد ✅";
  } catch (e) {
    $("st").textContent = "خطا: " + e.message;
  }
};

$("stop").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "stopTab" });
  chrome.action.setBadgeText({ text: "" });
  $("st").textContent = "متوقف شد";
};

/* ---------- diagnostics ---------- */
$("ver").textContent = "v" + chrome.runtime.getManifest().version;

const ago = (o) => Math.round((Date.now() - o.t) / 1000) + "s ago";

const showStatus = async () => {
  const { status, level } = await chrome.storage.local.get(["status", "level"]);
  $("dbg").textContent =
    "status: " +
    (status ? JSON.stringify(status) + " " + ago(status) : "none") +
    "\nlevel: " +
    (level ? JSON.stringify(level) + " " + ago(level) : "none");
};

const showLog = async () => {
  const { log = [] } = await chrome.storage.local.get("log");
  $("log").textContent = log
    .slice()
    .reverse()
    .map((l) => JSON.stringify(l))
    .join("\n");
};

setInterval(() => {
  showStatus();
  showLog();
}, 1000);
showStatus();
showLog();

$("copy").onclick = async () => {
  const {
    log = [],
    status,
    level,
  } = await chrome.storage.local.get(["log", "status", "level"]);
  await navigator.clipboard.writeText(
    JSON.stringify(
      { version: chrome.runtime.getManifest().version, status, level, log },
      null,
      1,
    ),
  );
  $("st").textContent = "لاگ کپی شد ✅";
};

$("clear").onclick = async () => {
  await chrome.storage.local.remove(["log", "status", "level"]);
  chrome.action.setBadgeText({ text: "" });
  $("st").textContent = "لاگ پاک شد 🧹";
  showStatus();
  showLog();
};
