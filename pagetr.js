// Injected on demand (popup toggle): translates the visible text of the page into the user's language
// via the background worker (Gemini). Originals are kept so everything can be restored.
(() => {
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  // After an extension reload an old copy may still be attached to the page: replace it.
  if (window.__dubPageTr) {
    if (window.__dubPageTr.alive()) return; // already running, its listener handles messages
    try { window.__dubPageTr.shutdown(); } catch {}
  }

  const ATTRS = ["placeholder", "title", "aria-label", "alt"];
  const ATTR_SEL = ATTRS.map((a) => `[${a}]`).join(",");
  const SKIP_SEL =
    'script,style,noscript,textarea,pre,code,kbd,samp,svg,math,canvas,iframe,[translate="no"],.notranslate,[contenteditable=""],[contenteditable="true"]';
  const HAS_LETTER = /\p{L}/u;
  const MAX_TEXT = 1500;
  const BATCH_ITEMS = 25; // small batches + parallel requests: first text appears sooner
  const BATCH_CHARS = 2500;
  const CONCURRENCY = 4;
  const MAX_REQ_PER_MIN = 120;

  const S = { on: false, lang: "" };
  const RTL_LANGS = new Set(["fa", "ar", "he", "ur", "ps", "sd", "ug", "yi", "dv", "ckb", "ku"]);
  const isRtl = (l) => RTL_LANGS.has(String(l || "").toLowerCase().split(/[-_]/)[0]);
  const dirState = new Map(); // element -> { dir, align } original values, for restoring
  const BLOCKISH = new Set(["block", "list-item", "table-cell", "flow-root", "inline-block"]);
  const tState = new WeakMap(); // text node -> { orig, tr }
  const settled = new WeakMap(); // text node -> value that needs no translation
  const aState = new WeakMap(); // element -> { [attr]: { orig, tr } }
  let records = []; // { ref, attr, orig, tr } for restoring
  const cache = new Map(); // trimmed source text -> translation (this page, this language)
  const dirty = new Set();
  let fullScan = false;
  let timer = null;
  let running = false;
  let blockedUntil = 0;
  let reqTimes = [];
  let observer = null;

  // Could this text node be translated at all (ignoring where it is on the page)?
  const eligible = (n) => {
    const v = n.nodeValue;
    if (!v || v.length > MAX_TEXT || !HAS_LETTER.test(v)) return false;
    const el = n.parentElement;
    return !!el && !el.closest(SKIP_SEL);
  };

  const textOk = (n) => {
    const v = n.nodeValue;
    const st = tState.get(n);
    if (st && st.tr === v) return false; // our own translation
    if (settled.get(n) === v) return false; // already in the target language
    return eligible(n);
  };

  // Progress over the whole page: translated (or already-target-language) text nodes / all translatable ones.
  let statsAt = 0, statsVal = { done: 0, total: 0 };
  function stats() {
    const now = Date.now();
    if (now - statsAt < 400) return statsVal;
    let done = 0, total = 0;
    if (S.on && document.body) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!eligible(n)) continue;
        total++;
        const v = n.nodeValue;
        if (tState.get(n)?.tr === v || settled.get(n) === v) done++;
      }
    }
    statsAt = now;
    return (statsVal = { done, total });
  }

  // Gather translatable items under `root`: { node|el, attr?, text (with whitespace) }
  function collect(root, out) {
    if (root.nodeType === 3) {
      if (textOk(root)) out.push({ node: root, text: root.nodeValue });
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && root.closest && root.closest(SKIP_SEL)) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (textOk(n)) out.push({ node: n, text: n.nodeValue });
    const els = [];
    if (root.nodeType === 1 && root.matches(ATTR_SEL)) els.push(root);
    root.querySelectorAll(ATTR_SEL).forEach((e) => els.push(e));
    for (const el of els) {
      if (el.closest(SKIP_SEL)) continue;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (!v || v.length > MAX_TEXT || !HAS_LETTER.test(v)) continue;
        const st = aState.get(el)?.[a];
        if (st && st.tr === v) continue;
        out.push({ node: el, attr: a, text: v });
      }
    }
  }

  const split = (text) => {
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { lead: m[1], core: m[2], trail: m[3] };
  };

  // Make translated text read in the right direction: RTL languages right-aligned, LTR left-aligned.
  // Only plain block containers are touched (flex/grid containers would reorder their children).
  function fixDir(textNode) {
    let el = textNode.parentElement;
    for (let i = 0; el && el !== document.body && i < 8; i++, el = el.parentElement) {
      const d = getComputedStyle(el).display;
      if (d.startsWith("inline") && d !== "inline-block") continue;
      if (d === "contents") continue;
      break;
    }
    if (!el) return;
    if (dirState.has(el)) return;
    const cs = getComputedStyle(el);
    if (!BLOCKISH.has(cs.display)) return;
    const want = isRtl(S.lang) ? "rtl" : "ltr";
    if (cs.direction === want && cs.textAlign !== (want === "rtl" ? "left" : "right")) return;
    if (dirState.size > 3000) for (const k of dirState.keys()) if (!k.isConnected) dirState.delete(k);
    dirState.set(el, { dir: el.getAttribute("dir"), align: el.style.textAlign });
    el.setAttribute("dir", want);
    if (cs.textAlign === "left" || cs.textAlign === "right") el.style.textAlign = want === "rtl" ? "right" : "left";
  }

  function apply(item, translated) {
    const { lead, trail } = split(item.text);
    const value = lead + translated + trail;
    if (value === item.text) {
      if (!item.attr && item.node.nodeValue === item.text) settled.set(item.node, item.text);
      return;
    }
    if (item.attr) {
      const el = item.node;
      if (el.getAttribute(item.attr) !== item.text) return; // changed meanwhile
      const st = (aState.get(el) || {});
      const orig = item.text; // current value is, by construction, the page's own text
      st[item.attr] = { orig, tr: value };
      aState.set(el, st);
      records.push({ ref: new WeakRef(el), attr: item.attr, orig, tr: value });
      el.setAttribute(item.attr, value);
    } else {
      const n = item.node;
      if (n.nodeValue !== item.text) return;
      const orig = item.text;
      tState.set(n, { orig, tr: value });
      records.push({ ref: new WeakRef(n), orig, tr: value });
      n.nodeValue = value;
      fixDir(n);
    }
  }

  function restoreAll() {
    for (const r of records) {
      const node = r.ref.deref();
      if (!node) continue;
      if (r.attr) {
        if (node.getAttribute(r.attr) === r.tr) node.setAttribute(r.attr, r.orig);
        const st = aState.get(node);
        if (st) delete st[r.attr];
      } else {
        if (node.nodeValue === r.tr) node.nodeValue = r.orig;
        tState.delete(node);
      }
    }
    records = [];
    for (const [el, o] of dirState) {
      if (o.dir === null) el.removeAttribute("dir"); else el.setAttribute("dir", o.dir);
      el.style.textAlign = o.align;
    }
    dirState.clear();
  }

  function rateOk() {
    const now = Date.now();
    reqTimes = reqTimes.filter((t) => now - t < 60000);
    return reqTimes.length < MAX_REQ_PER_MIN;
  }

  async function translateTexts(texts) {
    reqTimes.push(Date.now());
    const r = await chrome.runtime.sendMessage({ type: "pageTranslate", lang: S.lang, texts });
    if (!r || r.error || !Array.isArray(r.texts) || r.texts.length !== texts.length) throw new Error(r?.error || "bad response");
    return r.texts;
  }

  async function run() {
    if (running || !S.on) return;
    running = true;
    try {
      while (S.on && (fullScan || dirty.size)) {
        if (!alive()) return shutdown();
        const wait = blockedUntil - Date.now();
        if (wait > 0) { schedule(wait + 50); return; }
        if (!rateOk()) { schedule(10000); return; }

        const roots = fullScan ? [document.body] : [...dirty];
        fullScan = false;
        dirty.clear();
        const items = [];
        for (const root of roots) if (root && (root.isConnected ?? true)) collect(root, items);
        if (!items.length) continue;

        // group by source text; answer from cache where possible
        const groups = new Map(); // core -> items[]
        for (const it of items) {
          const core = split(it.text).core;
          if (!core) continue;
          if (cache.has(core)) { apply(it, cache.get(core)); continue; }
          (groups.get(core) || groups.set(core, []).get(core)).push(it);
        }
        // Map keeps first-occurrence order = document order, so the page is translated top to bottom.
        const cores = [...groups.keys()];
        const batches = [];
        let cur = [], chars = 0;
        for (const c of cores) {
          if (cur.length && (cur.length >= BATCH_ITEMS || chars + c.length > BATCH_CHARS)) { batches.push(cur); cur = []; chars = 0; }
          cur.push(c); chars += c.length;
        }
        if (cur.length) batches.push(cur);

        const lang = S.lang;
        let failed = false;
        let next = 0;
        const worker = async () => {
          while (next < batches.length && S.on && lang === S.lang && !failed) {
            if (!rateOk()) { failed = true; break; }
            const batch = batches[next++];
            try {
              const out = await translateTexts(batch);
              if (!S.on || lang !== S.lang) return;
              batch.forEach((core, i) => {
                const tr = String(out[i] ?? core).trim() || core;
                cache.set(core, tr);
                for (const it of groups.get(core)) apply(it, tr);
              });
            } catch (e) {
              failed = true;
              if (!alive()) return;
              blockedUntil = Date.now() + 20000;
              console.warn("[Dub Live] page translation failed:", e?.message || e);
              // retry these later
              for (const core of batch) for (const it of groups.get(core)) dirty.add(it.node);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
        if (failed) { fullScan = true; schedule(blockedUntil > Date.now() ? blockedUntil - Date.now() + 50 : 10000); return; }
      }
    } finally {
      running = false;
    }
  }

  function schedule(delay = 60) {
    if (!S.on) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; run().catch(() => {}); }, delay);
  }


  // ---- On-page progress badge (bottom-left), shown while translating, hidden at 100% -------------------
  const ui = { working: "Translating page…", done: "Translation complete", rtl: false };
  let ov = null, ovTimer = null, ovHide = null, ovShown = false;

  function ensureOverlay() {
    if (ov) return ov;
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;pointer-events:none;display:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .b{box-sizing:border-box;width:230px;padding:10px 12px;border-radius:10px;background:rgba(16,22,30,.93);color:#e6edf5;
         font:600 12px/1.5 Vazirmatn,Tahoma,system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.12)}
      .t{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}
      .p{direction:ltr}
      .bar{height:6px;border-radius:999px;background:rgba(255,255,255,.14);overflow:hidden;direction:ltr}
      .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#8b5cf6,#06b6d4);transition:width .25s}
    </style><div class="b"><div class="t"><span class="l"></span><span class="p"></span></div><div class="bar"><i></i></div></div>`;
    ov = { host, box: root.querySelector(".b"), l: root.querySelector(".l"), p: root.querySelector(".p"), i: root.querySelector("i") };
    document.documentElement.appendChild(host);
    return ov;
  }
  document.addEventListener("fullscreenchange", () => {
    if (ov) (document.fullscreenElement || document.documentElement).appendChild(ov.host);
  });

  function showOverlay(pct, finished) {
    const o = ensureOverlay();
    o.box.dir = ui.rtl ? "rtl" : "ltr";
    o.l.textContent = finished ? ui.done : ui.working;
    o.p.textContent = pct + "%";
    o.i.style.width = pct + "%";
    o.host.style.display = "block";
    ovShown = true;
  }
  function hideOverlay() {
    clearTimeout(ovHide); ovHide = null;
    if (ov) ov.host.style.display = "none";
    ovShown = false;
  }

  function tick() {
    ovTimer = null;
    if (!S.on) return;
    const t0 = performance.now();
    const s = stats();
    const cost = performance.now() - t0;
    const pending = s.total - s.done;
    if (pending > 0 && (ovShown || pending >= 3)) {
      clearTimeout(ovHide); ovHide = null;
      showOverlay(Math.floor((s.done / s.total) * 100), false);
    } else if (pending <= 0 && ovShown && !ovHide) {
      showOverlay(100, true);
      ovHide = setTimeout(hideOverlay, 900);
    }
    ovTimer = setTimeout(tick, Math.max(500, cost * 8)); // back off on huge pages
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      if (!S.on) return;
      for (const m of muts) {
        if (m.type === "childList") {
          m.addedNodes.forEach((n) => { if (n.nodeType === 1 || n.nodeType === 3) dirty.add(n); });
        } else if (m.type === "characterData") {
          if (tState.get(m.target)?.tr !== m.target.nodeValue) dirty.add(m.target);
        } else if (m.type === "attributes") {
          const st = aState.get(m.target)?.[m.attributeName];
          if (!st || st.tr !== m.target.getAttribute(m.attributeName)) dirty.add(m.target);
        }
      }
      if (dirty.size) schedule(60);
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  }

  function start(lang) {
    const changed = S.on && S.lang !== lang;
    S.lang = lang;
    if (changed) { restoreAll(); cache.clear(); }
    if (!S.on) {
      S.on = true;
      startObserver();
    }
    blockedUntil = 0;
    fullScan = true;
    schedule(0);
    if (!ovTimer) ovTimer = setTimeout(tick, 300);
  }

  function stop() {
    S.on = false;
    clearTimeout(timer);
    observer?.disconnect();
    observer = null;
    clearTimeout(ovTimer); ovTimer = null;
    hideOverlay();
    dirty.clear();
    fullScan = false;
    restoreAll();
    cache.clear();
  }

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type === "pageTrCfg") {
      if (msg.ui && typeof msg.ui === "object") {
        for (const k of ["working", "done"]) if (typeof msg.ui[k] === "string") ui[k] = msg.ui[k].slice(0, 80);
        ui.rtl = !!msg.ui.rtl;
      }
      if (msg.on) start(String(msg.lang || "en").trim() || "en");
      else stop();
      sendResponse?.({ ok: true });
    } else if (msg?.type === "pageTrState") {
      statsAt = 0;
      sendResponse?.({ on: S.on, ...stats() });
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function shutdown() {
    stop();
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    window.__dubPageTr = null;
  }

  // Detect an extension reload/update: from then on chrome.* calls throw.
  const heartbeat = setInterval(() => { if (!alive()) { clearInterval(heartbeat); shutdown(); } }, 3000);

  window.__dubPageTr = { alive, shutdown };
})();
