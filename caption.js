// Injected into the dubbed tab: draws live Persian subtitles over the page.
(() => {
  if (window.__dubCaption) return;
  window.__dubCaption = true;

  const host = document.createElement("div");
  host.style.cssText =
    "all:initial;position:fixed;left:0;right:0;bottom:8%;z-index:2147483647;display:none;justify-content:center;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .b{max-width:80%;text-align:center;background:rgba(0,0,0,.72);color:#fff;border-radius:8px;padding:8px 14px;
       font:600 22px/1.7 Vazirmatn,Tahoma,system-ui,sans-serif;direction:rtl;text-shadow:0 1px 2px #000;display:none}
    .o{direction:ltr;font:400 15px/1.5 system-ui,sans-serif;color:#ccc;margin-bottom:4px}
  </style><div class="b"><div class="o"></div><div class="t"></div></div>`;
  const box = root.querySelector(".b"),
    oEl = root.querySelector(".o"),
    tEl = root.querySelector(".t");
  document.documentElement.appendChild(host);
  document.addEventListener("fullscreenchange", () =>
    (document.fullscreenElement || document.documentElement).appendChild(host),
  ); // keep visible in fullscreen

  let tText = "",
    oText = "",
    showOrig = false,
    idle = null,
    reset = false;
  const MAX = 140;
  const trim = (s) => (s.length > MAX ? "…" + s.slice(-MAX) : s);

  function render() {
    tEl.textContent = tText;
    oEl.textContent = showOrig ? oText : "";
    oEl.style.display = showOrig && oText ? "block" : "none";
    box.style.display = tText || (showOrig && oText) ? "block" : "none";
  }
  function armIdle() {
    clearTimeout(idle);
    idle = setTimeout(() => {
      tText = oText = "";
      render();
    }, 4000);
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "captionCfg") {
      host.style.display = m.on ? "flex" : "none";
      showOrig = !!m.showOrig;
      if (!m.on) {
        tText = oText = "";
        render();
      }
      return;
    }
    if (m.type !== "caption") return;
    if (m.end) {
      reset = true;
      armIdle();
      return;
    }
    if (reset && (m.translated || m.heard)) {
      tText = oText = "";
      reset = false;
    }
    if (m.translated) tText = trim(tText + m.translated);
    if (m.heard) oText = trim(oText + m.heard);
    render();
    armIdle();
  });
})();
