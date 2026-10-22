const $ = (id) => document.getElementById(id);
const t = (k, v) => DubI18n.t(k, v);
const setSt = (text) => { $("st").textContent = text; };
const myLang = () => $("userLang").value.trim() || "fa";
// Interface language: Persian (default) or English.
const applyUi = () => DubI18n.setLang($("uiLang").value === "en" ? "en" : "fa");

const FIELDS = {
  key: "key",
  stt: "liveModel",
  pageModel: "pageTextModel",
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
  $("stt").value = s.liveModel || "gemini-3.5-live-translate-preview";
  const pageTextModel = !s.pageTextModel || s.pageTextModel === "gemini-3.8-flash"
    ? "gemini-3.5-flash-lite"
    : s.pageTextModel;
  $("pageModel").value = pageTextModel;
  if (pageTextModel !== s.pageTextModel) chrome.storage.local.set({ pageTextModel });
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
  liveModel: $("stt").value.trim() || "gemini-3.5-live-translate-preview",
  pageTextModel: $("pageModel").value.trim() || "gemini-3.5-flash-lite",
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

// Page text translation is per tab: ask the page whether it is translating and how far it got.
let prTimer = null;
function formatRetryDuration(value) {
  const parts = [...String(value).matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)];
  if (!parts.length) return String(value).trim();
  const total = Math.ceil(parts.reduce((sum, [, n, unit]) => sum + Number(n) * ({ d: 86400, h: 3600, m: 60, s: 1 }[unit.toLowerCase()]), 0));
  let rest = total;
  const values = [Math.floor(rest / 86400)]; rest %= 86400;
  values.push(Math.floor(rest / 3600)); rest %= 3600;
  values.push(Math.floor(rest / 60)); rest %= 60;
  values.push(rest);
  const labels = DubI18n.isRtlUi()
    ? ["روز", "ساعت", "دقیقه", "ثانیه"]
    : ["day", "hour", "minute", "second"];
  const first = Math.max(0, values.findIndex((n) => n > 0));
  return values.slice(first).map((n, i) => {
    const unit = labels[first + i];
    return `${n} ${unit}${!DubI18n.isRtlUi() && n !== 1 ? "s" : ""}`;
  }).join(" : ");
}
function pageErrorText(raw) {
  const model = raw.match(/model:\s*([a-z0-9.-]+)/i)?.[1] || $("pageModel").value.trim() || "Gemini";
  if (/Gemini 429/.test(raw)) {
    const retryRaw = raw.match(/retry in\s+([^"\\]+)/i)?.[1]?.trim().replace(/[.\s]+$/, "") || "later";
    const retry = formatRetryDuration(retryRaw);
    return t("pageErrQuota", { model, retry });
  }
  if (/Gemini 503/.test(raw)) return t("pageErrBusy");
  if (/Gemini 404/.test(raw)) return t("pageErrModel", { model });
  return t("pageErrGeneric", { error: raw.slice(0, 360) });
}
function showProgress(r) {
  const error = String(r?.error || "");
  $("prError").hidden = !error;
  if (error) {
    $("prError").textContent = pageErrorText(error);
    $("prError").title = error;
  }
  const on = !!r?.on;
  $("prWrap").hidden = !on;
  if (!on) return;
  const total = r.total || 0, done = r.done || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 100;
  $("prBar").style.width = pct + "%";
  $("prBar").parentElement.setAttribute("aria-valuenow", String(pct));
  $("prTxt").textContent = t("pageProgress", { pct, done, total });
}
async function refreshPageTr() {
  try {
    const tab = await activeTab();
    const r = await chrome.tabs.sendMessage(tab.id, { type: "pageTrState" });
    $("pageTr").checked = !!r?.on;
    showProgress(r);
    if (r?.on && !prTimer) prTimer = setInterval(refreshPageTr, 700);
    if (!r?.on && prTimer) { clearInterval(prTimer); prTimer = null; }
  } catch {
    $("pageTr").checked = false;
    showProgress(null);
    if (prTimer) { clearInterval(prTimer); prTimer = null; }
  }
}

async function applyPageTr(on) {
  const tab = await activeTab();
  if (on) {
    if (!tab?.id || !/^https?:/.test(tab.url || "")) { $("pageTr").checked = false; setSt(t("stPageNeedHttp")); return false; }
    if (!$("key").value.trim()) { $("pageTr").checked = false; setSt(t("stPageNeedKey")); return false; }
    await save();
    try {
      // activeTab is granted because the user opened the popup on this tab.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["pagetr.js"] });
      await chrome.tabs.sendMessage(tab.id, {
        type: "pageTrCfg", on: true, lang: myLang(),
        ui: {
          working: t("pageWorking"), done: t("pageDone"), rtl: DubI18n.isRtlUi(),
          error: t("pageErrTitle"), quota: t("pageErrQuota"), busy: t("pageErrBusy"), modelError: t("pageErrModel"),
        },
      });
      setSt(t("stPageOn"));
      refreshPageTr();
      return true;
    } catch (e) {
      $("pageTr").checked = false;
      setSt(t("errPrefix") + (e.message || e));
      return false;
    }
  } else if (tab?.id) {
    await chrome.tabs.sendMessage(tab.id, { type: "pageTrCfg", on: false }).catch(() => {});
    setSt(t("stPageOff"));
    refreshPageTr();
  }
  return false;
}
// Selecting page translation only arms it. The main Start button actually begins it.
$("pageTr").addEventListener("change", () => {
  if (!$("pageTr").checked) applyPageTr(false);
});

$("uiLang").addEventListener("change", applyUi);
// A running page translation follows "your language".
$("userLang").addEventListener("change", async () => {
  if (!$("pageTr").checked) return;
  try {
    const tab = await activeTab();
    const state = await chrome.tabs.sendMessage(tab.id, { type: "pageTrState" });
    if (state?.on) applyPageTr(true);
  } catch {}
});
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
    // Page text translation starts only when selected in the toggle and Start is clicked.
    if ($("pageTr").checked) await applyPageTr(true);
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
  $("pageTr").checked = false;
  await applyPageTr(false);
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
