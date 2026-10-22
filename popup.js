const $ = (id) => document.getElementById(id);
const t = (k, v) => DubI18n.t(k, v);
const setSt = (text) => { $("st").textContent = text; };
const myLang = () => $("userLang").value.trim() || "fa";
// Interface language: Persian (default) or English.
const applyUi = () => DubI18n.setLang($("uiLang").value === "en" ? "en" : "fa");

const FIELDS = {
  key: "key",
  stt: "liveModel",
  userLang: "userLang",
  friendLang: "friendLang",
  origVol: "origVol",
  subs: "subs",
  subsOrig: "subsOrig",
  uiLang: "uiLang",
  voiceOn: "voiceOn",
  micOn: "micOn",
};

chrome.storage.local.get([...Object.values(FIELDS), "target"]).then((s) => {
  $("key").value = s.key || "";
  $("stt").value = s.liveModel || "";
  $("userLang").value = s.userLang || s.target || "fa";
  $("friendLang").value = s.friendLang || "en";
  $("origVol").value = s.origVol == null ? 0 : s.origVol;
  $("uiLang").value = s.uiLang || "fa";
  $("subs").checked = s.subs !== false;
  $("subsOrig").checked = !!s.subsOrig;
  $("voiceOn").checked = s.voiceOn !== false;
  $("micOn").checked = s.micOn !== false;
  showVol();
  applyUi();
  refreshPageTr();
});

const showVol = () => { $("vv").textContent = $("origVol").value + "%"; };
const save = () => chrome.storage.local.set({
  key: $("key").value.trim(),
  liveModel: $("stt").value.trim(),
  userLang: $("userLang").value.trim() || "fa",
  friendLang: $("friendLang").value.trim() || "en",
  // Keep the legacy field aligned for compatibility with old config readers.
  target: $("userLang").value.trim() || "fa",
  origVol: +$("origVol").value,
  subs: $("subs").checked,
  subsOrig: $("subsOrig").checked,
  uiLang: $("uiLang").value,
  voiceOn: $("voiceOn").checked,
  micOn: $("micOn").checked,
  engine: "live",
});

Object.keys(FIELDS).forEach((id) => $(id).addEventListener("change", save));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Page text translation is per tab: ask the page whether it is currently translating.
async function refreshPageTr() {
  try {
    const tab = await activeTab();
    const r = await chrome.tabs.sendMessage(tab.id, { type: "pageTrState" });
    $("pageTr").checked = !!r?.on;
  } catch { $("pageTr").checked = false; }
}

async function applyPageTr(on) {
  const tab = await activeTab();
  if (on) {
    if (!tab?.id || !/^https?:/.test(tab.url || "")) { $("pageTr").checked = false; setSt(t("stPageNeedHttp")); return; }
    if (!$("key").value.trim()) { $("pageTr").checked = false; setSt(t("stPageNeedKey")); return; }
    await save();
    try {
      // activeTab is granted because the user opened the popup on this tab.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["pagetr.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "pageTrCfg", on: true, lang: myLang() });
      setSt(t("stPageOn"));
    } catch (e) {
      $("pageTr").checked = false;
      setSt(t("errPrefix") + (e.message || e));
    }
  } else if (tab?.id) {
    await chrome.tabs.sendMessage(tab.id, { type: "pageTrCfg", on: false }).catch(() => {});
    setSt(t("stPageOff"));
  }
}
$("pageTr").addEventListener("change", () => applyPageTr($("pageTr").checked));

$("uiLang").addEventListener("change", applyUi);
// A running page translation follows "your language".
$("userLang").addEventListener("change", () => { if ($("pageTr").checked) applyPageTr(true); });
$("origVol").addEventListener("input", showVol);

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
  await save();
  $("start").disabled = true;
  try {
    const key = $("key").value.trim();
    if (!key) throw new Error(t("errNoKey"));
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      throw new Error(t("errNotHttp"));
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
    await chrome.runtime.sendMessage({
      type: "startTab",
      streamId,
      tabId: tab.id,
      userLang: $("userLang").value.trim() || "fa",
      friendLang: $("friendLang").value.trim() || "en",
      micOn,
    });
    setSt(t(micOn ? "stActiveMic" : "stActiveNoMic"));
  } catch (e) {
    setSt(t("errPrefix") + (e.message || e));
    await chrome.runtime.sendMessage({ type: "stopTab" }).catch(() => {});
  } finally {
    $("start").disabled = false;
  }
};

$("stop").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "stopTab" });
  chrome.action.setBadgeText({ text: "" });
  setSt(t("stStopped"));
};

$("voiceOn").addEventListener("change", () => {
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "cfg",
    voiceOn: $("voiceOn").checked,
  }).catch(() => {});
});

$("ver").textContent = "v" + chrome.runtime.getManifest().version;
