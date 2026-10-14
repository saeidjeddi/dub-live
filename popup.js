const $ = (id) => document.getElementById(id);

const FIELDS = {
  key: "key",
  stt: "liveModel",
  userLang: "userLang",
  friendLang: "friendLang",
  origVol: "origVol",
  subs: "subs",
  subsOrig: "subsOrig",
  voiceOn: "voiceOn",
  micOn: "micOn",
};

chrome.storage.local.get([...Object.values(FIELDS), "target"]).then((s) => {
  $("key").value = s.key || "";
  $("stt").value = s.liveModel || "";
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
  key: $("key").value.trim(),
  liveModel: $("stt").value.trim(),
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
    if (!key) throw new Error("ابتدا Gemini API Key را وارد کنید.");
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
    await chrome.runtime.sendMessage({
      type: "startTab",
      streamId,
      tabId: tab.id,
      userLang: $("userLang").value.trim() || "fa",
      friendLang: $("friendLang").value.trim() || "en",
      micOn,
    });
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
