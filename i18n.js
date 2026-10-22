// Popup localisation: Persian and English, both bundled.
var DubI18n = (() => {
  const FA = {
    tagline: "مترجم زنده جلسه",
    geminiSettings: "تنظیمات Gemini",
    apiKey: "Gemini API Key",
    apiKeyPh: "API Key",
    showKey: "نمایش کلید",
    hideKey: "مخفی کردن کلید",
    toggleKeyTitle: "نمایش / مخفی کردن",
    getKey: "دریافت کلید Gemini از Google AI Studio ↗",
    liveModel: "مدل ترجمه زنده",
    liveModelPh: "پیش‌فرض: gemini-3.5-live-translate-preview",
    yourLang: "زبان شما",
    meetLang: "زبان جلسه",
    convTitle: "ترجمه مکالمه",
    origVol: "صدای اصلی جلسه",
    voiceOn: "پخش ترجمه صدای جلسه/ویدیو",
    micOn: "ترجمه گفتار من برای جلسه",
    helpTitle: "راهنما و حریم خصوصی",
    help1: "صدای دوستتان به زبان شما پخش می‌شود و گفتار شما پس از ترجمه از میکروفون جلسه برای او فرستاده می‌شود.",
    help2: "وقتی «ترجمهٔ گفتار من» روشن است، صدای خام شما به تماس فرستاده نمی‌شود.",
    help3: "اگر آن را خاموش کنید، میکروفون شما بدون ترجمه و دست‌نخورده به تماس می‌رود و چیزی از میکروفون به Gemini ارسال نمی‌شود.",
    help4: "صدای جلسه و میکروفون با API Key شما به Gemini ارسال می‌شود.",
    help5: "اگر تماس از قبل برقرار است، بعد از شروع ترجمه یک‌بار دوباره به تماس وصل شوید.",
    help6: "وقتی «ترجمه متن‌های صفحه» روشن است، متن‌های قابل‌مشاهده‌ی صفحه با API Key شما به Gemini ارسال می‌شود؛ در صفحه‌هایی که اطلاعات حساس دارند آن را روشن نکنید.",
    subsTitle: "زیرنویس",
    subs: "زیرنویس",
    subsOrig: "نمایش متن اصلی",
    pageTitle: "ترجمه متن صفحه",
    pageTr: "ترجمه متن‌های صفحه به زبان شما",
    start: "شروع مترجم",
    stop: "توقف",
    errPrefix: "خطا: ",
    errNoKey: "ابتدا Gemini API Key را وارد کنید.",
    errNotHttp: "صفحهٔ جلسه باید یک وب‌سایت http یا https باشد.",
    stActiveMic: "مترجم جلسه فعال است؛ اگر تماس باز است دوباره به تماس وصل شوید.",
    stActiveNoMic: "مترجم جلسه فعال است؛ گفتار شما ترجمه نمی‌شود.",
    stStopped: "مترجم جلسه متوقف شد",
    stPageOn: "ترجمه متن صفحه فعال شد.",
    stPageOff: "ترجمه متن صفحه خاموش شد و متن اصلی برگشت.",
    stPageNeedKey: "برای ترجمه متن صفحه ابتدا API Key را وارد کنید.",
    stPageNeedHttp: "ترجمه متن صفحه فقط روی صفحه‌های http/https کار می‌کند.",
  };

  const EN = {
    tagline: "Live meeting translator",
    geminiSettings: "Gemini settings",
    apiKey: "Gemini API Key",
    apiKeyPh: "API Key",
    showKey: "Show key",
    hideKey: "Hide key",
    toggleKeyTitle: "Show / hide",
    getKey: "Get a Gemini key from Google AI Studio ↗",
    liveModel: "Live translation model",
    liveModelPh: "Default: gemini-3.5-live-translate-preview",
    yourLang: "Your language",
    meetLang: "Meeting language",
    convTitle: "Conversation translation",
    origVol: "Original meeting volume",
    voiceOn: "Play translated meeting/video audio",
    micOn: "Translate my speech for the meeting",
    helpTitle: "Help & privacy",
    help1: "Your friend's voice is played in your language, and your speech is translated and sent to them through the meeting microphone.",
    help2: "While “Translate my speech” is on, your raw voice is not sent to the call.",
    help3: "If you turn it off, your microphone goes to the call untouched and nothing from the microphone is sent to Gemini.",
    help4: "Meeting audio and your microphone are sent to Gemini with your API Key.",
    help5: "If the call is already connected, reconnect to the call once after starting the translator.",
    help6: "While “Translate page text” is on, the visible text of the page is sent to Gemini with your API Key; don't enable it on pages with sensitive information.",
    subsTitle: "Subtitles",
    subs: "Subtitles",
    subsOrig: "Show original text",
    pageTitle: "Page text translation",
    pageTr: "Translate page text into your language",
    start: "Start translator",
    stop: "Stop",
    errPrefix: "Error: ",
    errNoKey: "Enter your Gemini API Key first.",
    errNotHttp: "The meeting page must be an http or https website.",
    stActiveMic: "Meeting translator is active; if the call is already open, reconnect to it.",
    stActiveNoMic: "Meeting translator is active; your own speech is not translated.",
    stStopped: "Meeting translator stopped",
    stPageOn: "Page text translation is on.",
    stPageOff: "Page text translation is off; original text restored.",
    stPageNeedKey: "Enter your API Key first to translate page text.",
    stPageNeedHttp: "Page text translation only works on http/https pages.",
  };

  const BUILTIN = { fa: FA, en: EN };
  const RTL = new Set(["fa", "ar", "he", "ur", "ps", "sd", "ug", "yi", "dv", "ckb", "ku"]);
  const norm = (c) => String(c || "").trim().toLowerCase();
  const base = (c) => norm(c).split(/[-_]/)[0];

  let dict = FA;
  let lang = "fa";

  function t(key, vars) {
    let s = dict[key] ?? EN[key] ?? FA[key] ?? key;
    if (vars) for (const k in vars) s = s.replaceAll("{" + k + "}", vars[k]);
    return s;
  }

  function render() {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = RTL.has(base(lang)) ? "rtl" : "ltr";
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
    const eye = document.getElementById("toggleKey");
    if (eye) eye.setAttribute("aria-label", t(eye.getAttribute("aria-pressed") === "true" ? "hideKey" : "showKey"));
  }

  // Persian (default) or English.
  function setLang(code) {
    lang = base(code) === "en" ? "en" : "fa";
    dict = BUILTIN[lang];
    render();
  }

  return { t, setLang, render };
})();
