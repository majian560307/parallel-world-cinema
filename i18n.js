/* i18n.js — runtime dictionary i18n for the Parallel World Cinema site.
   Dictionaries: window.I18N = { en:{...}, ja:{...}, ko:{...} } (zh = DOM source, no dict).
   Strategy: walk text nodes, translate by trimmed exact match; MutationObserver
   catches script-injected content (ticker, scene captions, hero copy). */
(function () {
  const LANGS = ["zh", "en", "ja", "ko"];
  const LABEL = { zh: "中文", en: "EN", ja: "日本語", ko: "한국어" };
  const KEY = "***";
  let lang = localStorage.getItem(KEY) || detect();
  if (!LANGS.includes(lang)) lang = "zh";

  function detect() {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGS.includes(saved)) return saved;
    const nav = (navigator.language || "zh").toLowerCase();
    if (nav.startsWith("ja")) return "ja";
    if (nav.startsWith("ko")) return "ko";
    if (nav.startsWith("zh")) return "zh";
    return "en"; // 其他语言默认英文
  }
  window.__lang = () => lang;

  function dict() { return (window.I18N || {})[lang] || {}; }
  function t(text) {
    const key = text.trim();
    if (!key) return null;
    const v = dict()[key];
    if (v === undefined) return null;
    // 保留首尾空白
    const lead = text.slice(0, text.length - text.trimStart().length);
    const tail = text.slice(text.trimEnd().length);
    return lead + v + tail;
  }

  function translateNode(node) {
    // 迭代遍历，防深层 DOM 爆栈
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType === 3) {
        if (n.parentElement && ["SCRIPT", "STYLE", "NOSCRIPT"].includes(n.parentElement.tagName)) continue;
        if (n.__i18n && n.__i18n.lang === lang) continue;
        const rep = t(n.nodeValue);
        if (rep !== null && rep !== n.nodeValue) {
          n.__i18n = { lang: lang, zh: n.nodeValue };
          n.nodeValue = rep;
        }
        continue;
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) continue;
      if (n.nodeType === 1 && ["SCRIPT", "STYLE", "NOSCRIPT"].includes(n.tagName)) continue;
      let c = n.firstChild;
      while (c) { stack.push(c); c = c.nextSibling; }
    }
  }

  /* 页面静态标题等 */
  const TITLES = {
    "index.html": {
      zh: "平行世界电影院 · 开源元宇宙 | Parallel World Cinema",
      en: "Parallel World Cinema · Open Source Metaverse",
      ja: "並行世界シネマ · オープンソース・メタバース",
      ko: "평행세계 시네마 · 오픈소스 메타버스"
    },
    "creators.html": {
      zh: "创作者专区 · 平行世界电影院 | For Makers",
      en: "For Makers · Parallel World Cinema",
      ja: "クリエイターラウンジ · 並行世界シネマ",
      ko: "크리에이터 라운지 · 평행세계 시네마"
    }
  };
  function applyChrome() {
    const file = location.pathname.split("/").pop() || "index.html";
    const tt = (TITLES[file] || TITLES["index.html"])[lang];
    if (tt) document.title = tt;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
    renderSwitchers();
  }

  /* —— 语言切换器：注入顶栏 + 替换页脚 LANGUAGES 块 —— */
  function switcherHTML(name) {
    return `<div class="lang-switch" role="group" aria-label="${name}">` +
      LANGS.map(l => `<button type="button" class="lang-btn${l === lang ? " on" : ""}" data-lang="${l}">${LABEL[l]}</button>`).join("") +
      `</div>`;
  }
  function renderSwitchers() {
    document.querySelectorAll(".lang-switch").forEach(s => {
      s.querySelectorAll(".lang-btn").forEach(b =>
        b.classList.toggle("on", b.dataset.lang === lang));
    });
  }
  function mountSwitchers() {
    const css = document.createElement("style");
    css.textContent = `
.lang-switch{display:inline-flex;gap:6px;align-items:center;flex:none}
.lang-btn{font:inherit;font-size:.82rem;letter-spacing:.06em;cursor:pointer;
  padding:5px 11px;border-radius:999px;color:inherit;opacity:.6;white-space:nowrap;
  background:transparent;border:1px solid transparent;transition:.25s}
header nav a,footer nav a{white-space:nowrap}
.lang-btn:hover{opacity:1}
.lang-btn.on{opacity:1;color:var(--gold,#e8c476);border-color:rgba(232,196,118,.5);
  background:rgba(232,196,118,.08)}`;
    document.head.appendChild(css);
    // 顶栏（desktop & mobile）
    document.querySelectorAll("header .nav, header nav").forEach(nav => {
      if (nav.querySelector(".lang-switch")) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = switcherHTML("Language");
      const cta = nav.querySelector(".cta, a.btn, a[class*=cta]");
      if (cta) nav.insertBefore(wrap.firstChild, cta);
      else nav.appendChild(wrap.firstChild);
    });
    // 页脚 .langs 静态块 → 活切换器
    document.querySelectorAll(".langs").forEach(box => {
      if (box.querySelector(".lang-btn")) return;
      box.innerHTML = LANGS.map(l =>
        `<button type="button" class="lang-btn${l === lang ? " on" : ""}" data-lang="${l}">${LABEL[l]}</button>`).join("");
    });
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".lang-btn");
    if (!b) return;
    lang = b.dataset.lang;
    localStorage.setItem(KEY, lang);
    // 还原所有已译节点，再整页重译
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = walk.nextNode())) {
      if (n.__i18n) { n.nodeValue = n.__i18n.zh; n.__i18n = null; }
    }
    translateNode(document.body);
    applyChrome();
  });

  /* —— 启动 + 动态内容兜底 —— */
  function boot() {
    mountSwitchers();
    translateNode(document.body);
    applyChrome();
    if (!window.__i18nObs) {
      window.__i18nObs = 1;
      new MutationObserver(muts => {
        for (const m of muts) m.addedNodes.forEach(translateNode);
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
