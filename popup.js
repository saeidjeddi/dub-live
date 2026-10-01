const $ = (id) => document.getElementById(id);
chrome.storage.local
  .get([
    "key",
    "sttModel",
    "ttsModel",
    "voice",
    "target",
    "origVol",
    "subs",
    "subsOrig",
  ])
  .then((s) => {
    $("key").value = s.key || "";
    $("stt").value = s.sttModel || "";
    $("tts").value = s.ttsModel || "";
    $("voice").value = s.voice || "";
    $("target").value = s.target || "fa";
    $("origVol").value = s.origVol == null ? 20 : s.origVol;
    $("vv").textContent = $("origVol").value;
    $("subs").checked = s.subs !== false;
    $("subsOrig").checked = !!s.subsOrig;
  });
const save = () =>
  chrome.storage.local.set({
    key: $("key").value.trim(),
    sttModel: $("stt").value.trim(),
    ttsModel: $("tts").value.trim(),
    voice: $("voice").value.trim(),
    target: $("target").value.trim() || "fa",
    origVol: +$("origVol").value,
    subs: $("subs").checked,
    subsOrig: $("subsOrig").checked,
  });
[
  "key",
  "stt",
  "tts",
  "voice",
  "target",
  "origVol",
  "subs",
  "subsOrig",
].forEach((id) => $(id).addEventListener("change", save));

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
    $("st").textContent = "فعال شد ✅ (صدای اصلی تب قطع و دوبله پخش می‌شود)";
  } catch (e) {
    $("st").textContent = "خطا: " + e.message;
  }
};
$("stop").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "stopTab" });
    chrome.action.setBadgeText({ text: "" });
  $("st").textContent = "متوقف شد";
};

