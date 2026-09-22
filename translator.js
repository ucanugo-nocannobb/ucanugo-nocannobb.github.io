/*
 * 翻譯插件 translator.js
 * ─────────────────────────────────────────────────────────────
 * 用法：在任何頁面加上
 *   <script src="translator.js" defer></script>
 * 右下角會出現 🌐 按鈕，選擇語言即可把整頁文字翻譯過去，
 * 選「原文」即還原。支援 React 等動態更新的頁面（MutationObserver）。
 *
 * 不想被翻譯的區塊：加上 class="notranslate" 或屬性 translate="no"
 * 可選設定（載入前設定）：
 *   window.TRANSLATOR_CONFIG = { source: 'zh-TW', languages: [...], position: 'right' }
 */
(function () {
  'use strict';
  if (window.__translatorLoaded) return;
  window.__translatorLoaded = true;

  const CFG = Object.assign({
    source: document.documentElement.lang || 'auto',
    position: 'right',
    languages: [
      { code: 'en',    label: 'English' },
      { code: 'ja',    label: '日本語' },
      { code: 'ko',    label: '한국어' },
      { code: 'zh-CN', label: '简体中文' },
      { code: 'vi',    label: 'Tiếng Việt' },
      { code: 'th',    label: 'ภาษาไทย' },
      { code: 'id',    label: 'Bahasa Indonesia' },
      { code: 'es',    label: 'Español' },
      { code: 'fr',    label: 'Français' },
    ],
  }, window.TRANSLATOR_CONFIG || {});

  const STORE_LANG  = 'translator.lang';
  const STORE_CACHE = 'translator.cache.v1';
  const CACHE_MAX   = 4000;
  const SKIP_TAGS   = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'SVG', 'svg', 'IFRAME', 'TEMPLATE']);
  const ATTRS       = ['placeholder', 'title', 'aria-label'];
  const HAS_WORD    = /[\p{L}]/u;

  const safeGet = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ── 快取：{ "en\u0001原文": "translation" } ──────────────────────
  let cache = safeGet(STORE_CACHE, {});
  let cacheDirty = false;
  function saveCacheSoon() {
    if (cacheDirty) return;
    cacheDirty = true;
    setTimeout(() => {
      cacheDirty = false;
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) keys.slice(0, keys.length - CACHE_MAX).forEach(k => delete cache[k]);
      safeSet(STORE_CACHE, cache);
    }, 1000);
  }
  const ck = (lang, text) => lang + '\u0001' + text;

  // ── 翻譯 API ────────────────────────────────────────────────────
  // 主要：Google 公開端點（一次送多行）；失敗時逐句改用 MyMemory
  const SEP = '\n';
  async function googleBatch(texts, target) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
      + '&sl=' + encodeURIComponent(CFG.source) + '&tl=' + encodeURIComponent(target);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'q=' + encodeURIComponent(texts.join(SEP)),
    });
    if (!res.ok) throw new Error('google ' + res.status);
    const data = await res.json();
    const joined = (data[0] || []).map(seg => seg[0] || '').join('');
    const parts = joined.split(SEP);
    if (parts.length !== texts.length) throw new Error('google: line mismatch');
    return parts;
  }
  async function myMemory(text, target) {
    const src = CFG.source === 'auto' ? 'zh-TW' : CFG.source;
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
      + '&langpair=' + encodeURIComponent(src + '|' + target);
    const res = await fetch(url);
    if (!res.ok) throw new Error('mymemory ' + res.status);
    const data = await res.json();
    return (data.responseData && data.responseData.translatedText) || text;
  }
  async function translateTexts(texts, target) {
    const out = new Array(texts.length);
    // 分批，避免 URL/內容過長
    let batch = [], idx = [], size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const b = batch, ix = idx;
      batch = []; idx = []; size = 0;
      let res;
      try { res = await googleBatch(b, target); }
      catch (e) {
        res = [];
        for (const t of b) {
          try { res.push(await myMemory(t, target)); } catch { res.push(null); }
        }
      }
      res.forEach((r, i) => { out[ix[i]] = r; });
    };
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (size + t.length > 3500 || batch.length >= 80) await flush();
      batch.push(t); idx.push(i); size += t.length + 1;
    }
    await flush();
    return out;
  }

  // ── 狀態 ────────────────────────────────────────────────────────
  // 文字節點 → { orig: 原文, shown: 目前顯示的譯文 }
  const textState = new WeakMap();
  // 元素 → { attr: { orig, shown } }
  const attrState = new WeakMap();
  const tracked = new Set();            // 所有動過的節點（還原用）
  let currentLang = null;
  let applying = false;                 // 自己在改 DOM 時，忽略 observer
  let pending = new Set();
  let scheduled = null;

  function isSkipped(el) {
    for (let n = el; n && n !== document.body; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      if (SKIP_TAGS.has(n.tagName)) return true;
      if (n.isContentEditable) return true;
      if (n.classList && (n.classList.contains('notranslate') || n.classList.contains('__translator'))) return true;
      if (n.getAttribute && n.getAttribute('translate') === 'no') return true;
    }
    return false;
  }

  function collect(root, into) {
    if (!root) return;
    if (root.nodeType === 3) { if (root.parentNode && !isSkipped(root.parentNode)) into.add(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && isSkipped(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (SKIP_TAGS.has(n.tagName) || n.isContentEditable
            || n.classList.contains('notranslate') || n.classList.contains('__translator')
            || n.getAttribute('translate') === 'no') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    if (root.nodeType === 1) into.add(root);
    let n;
    while ((n = walker.nextNode())) into.add(n);
  }

  // 取得節點「現在的原文」：若 DOM 內容跟我們上次寫入的不同，代表頁面自己更新了
  function origOfText(node) {
    const st = textState.get(node);
    const cur = node.nodeValue;
    if (st && cur === st.shown) return st.orig;
    return cur;
  }
  function origOfAttr(el, a) {
    const st = attrState.get(el);
    const cur = el.getAttribute(a);
    if (st && st[a] && cur === st[a].shown) return st[a].orig;
    return cur;
  }

  async function process(nodes) {
    const lang = currentLang;
    if (!lang) return;
    const jobs = [];   // { apply(translated), key }
    const need = new Map(); // core text -> true

    const addJob = (orig, apply) => {
      if (!orig || !HAS_WORD.test(orig)) return;
      const m = orig.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const core = m[2].replace(/\s*\n\s*/g, ' ');
      if (!core) return;
      jobs.push({ core, apply: t => apply(m[1] + t + m[3]) });
      if (!(ck(lang, core) in cache)) need.set(core, true);
    };

    for (const node of nodes) {
      if (!node.isConnected) continue;
      if (node.nodeType === 3) {
        const orig = origOfText(node);
        addJob(orig, t => {
          textState.set(node, { orig, shown: t });
          tracked.add(node);
          if (node.nodeValue !== t) node.nodeValue = t;
        });
      } else if (node.nodeType === 1) {
        for (const a of ATTRS) {
          if (!node.hasAttribute(a)) continue;
          const orig = origOfAttr(node, a);
          addJob(orig, t => {
            const st = attrState.get(node) || {};
            st[a] = { orig, shown: t };
            attrState.set(node, st);
            tracked.add(node);
            if (node.getAttribute(a) !== t) node.setAttribute(a, t);
          });
        }
      }
    }
    if (!jobs.length) return;

    if (need.size) {
      setBusy(true);
      const list = [...need.keys()];
      const res = await translateTexts(list, lang);
      list.forEach((t, i) => { if (res[i] != null) cache[ck(lang, t)] = res[i]; });
      saveCacheSoon();
      setBusy(false);
      if (!list.some((t, i) => res[i] != null)) toast('翻譯服務暫時無法連線，請稍後再試');
    }
    if (currentLang !== lang) return; // 期間切換了語言

    applying = true;
    try {
      for (const j of jobs) {
        const t = cache[ck(lang, j.core)];
        if (t != null) j.apply(t);
      }
    } finally {
      observer.takeRecords();
      applying = false;
    }
  }

  function schedule(nodes) {
    nodes.forEach(n => pending.add(n));
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      const batch = pending;
      pending = new Set();
      process(batch);
    }, 120);
  }

  const observer = new MutationObserver(records => {
    if (applying || !currentLang) return;
    const set = new Set();
    for (const r of records) {
      if (r.type === 'characterData') collect(r.target, set);
      else if (r.type === 'attributes') { if (!isSkipped(r.target)) set.add(r.target); }
      else r.addedNodes.forEach(n => collect(n, set));
    }
    if (set.size) schedule(set);
  });

  function restore() {
    applying = true;
    try {
      for (const node of tracked) {
        if (node.nodeType === 3) {
          const st = textState.get(node);
          if (st && node.nodeValue === st.shown) node.nodeValue = st.orig;
          textState.delete(node);
        } else {
          const st = attrState.get(node) || {};
          for (const a in st) if (node.getAttribute(a) === st[a].shown) node.setAttribute(a, st[a].orig);
          attrState.delete(node);
        }
      }
      tracked.clear();
    } finally {
      observer.takeRecords();
      applying = false;
    }
  }

  function setLanguage(lang) {
    if (lang === currentLang) return;
    observer.disconnect();
    restore();
    currentLang = lang || null;
    safeSet(STORE_LANG, currentLang);
    document.documentElement.setAttribute('data-translated', currentLang || '');
    renderMenu();
    if (!currentLang) return;
    const all = new Set();
    collect(document.body, all);
    const t = document.querySelector('title');
    process(all);
    if (t) process(new Set([t.firstChild].filter(Boolean)));
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }

  // ── 介面 ────────────────────────────────────────────────────────
  const css = `
  .__translator{position:fixed;bottom:20px;${CFG.position === 'left' ? 'left' : 'right'}:20px;z-index:2147483000;
    font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px}
  .__translator .tr-btn{width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;background:#4f46e5;color:#fff;
    font-size:22px;box-shadow:0 6px 20px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;position:relative}
  .__translator .tr-btn:hover{background:#4338ca}
  .__translator .tr-btn.busy::after{content:'';position:absolute;inset:-4px;border-radius:50%;border:3px solid transparent;
    border-top-color:#a5b4fc;animation:tr-spin .8s linear infinite}
  @keyframes tr-spin{to{transform:rotate(360deg)}}
  .__translator .tr-menu{position:absolute;bottom:58px;${CFG.position === 'left' ? 'left' : 'right'}:0;background:#fff;color:#111827;
    border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px;min-width:180px;max-height:60vh;overflow:auto;display:none}
  .__translator.open .tr-menu{display:block}
  .__translator .tr-head{padding:8px 10px 6px;font-size:12px;color:#6b7280;font-weight:600}
  .__translator .tr-item{display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;border:none;
    background:none;padding:8px 10px;border-radius:8px;cursor:pointer;color:inherit;font:inherit}
  .__translator .tr-item:hover{background:#eef2ff}
  .__translator .tr-item.active{background:#e0e7ff;color:#3730a3;font-weight:600}
  .__translator .tr-toast{position:absolute;bottom:58px;${CFG.position === 'left' ? 'left' : 'right'}:0;white-space:nowrap;
    background:#111827;color:#fff;padding:8px 12px;border-radius:10px;font-size:13px}
  @media (prefers-color-scheme: dark){
    .__translator .tr-menu{background:#1f2937;color:#f3f4f6}
    .__translator .tr-item:hover{background:#374151}
    .__translator .tr-item.active{background:#312e81;color:#e0e7ff}
  }`;

  let wrap, btn, menu;
  function build() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    wrap = document.createElement('div');
    wrap.className = '__translator notranslate';
    wrap.setAttribute('translate', 'no');
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tr-btn';
    btn.title = 'Translate / 翻譯';
    btn.setAttribute('aria-label', 'Translate / 翻譯');
    btn.textContent = '🌐';
    menu = document.createElement('div');
    menu.className = 'tr-menu';
    menu.setAttribute('role', 'menu');
    wrap.append(menu, btn);
    document.body.appendChild(wrap);

    btn.addEventListener('click', e => { e.stopPropagation(); wrap.classList.toggle('open'); });
    document.addEventListener('click', e => { if (!wrap.contains(e.target)) wrap.classList.remove('open'); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') wrap.classList.remove('open'); });
    renderMenu();
  }

  function renderMenu() {
    if (!menu) return;
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tr-head';
    head.textContent = '翻譯 Translate';
    menu.appendChild(head);
    const items = [{ code: null, label: '原文 Original' }, ...CFG.languages];
    for (const l of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tr-item' + (l.code === currentLang ? ' active' : '');
      b.setAttribute('role', 'menuitem');
      b.textContent = l.label;
      if (l.code === currentLang) b.append(document.createTextNode('✓'));
      b.addEventListener('click', () => { wrap.classList.remove('open'); setLanguage(l.code); });
      menu.appendChild(b);
    }
  }

  let busyCount = 0;
  function setBusy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    if (btn) btn.classList.toggle('busy', busyCount > 0);
  }

  let toastTimer;
  function toast(msg) {
    if (!wrap) return;
    let el = wrap.querySelector('.tr-toast');
    if (!el) { el = document.createElement('div'); el.className = 'tr-toast'; wrap.appendChild(el); }
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3500);
  }

  // 對外 API：window.Translator.set('en') / .reset() / .current()
  window.Translator = {
    set: setLanguage,
    reset: () => setLanguage(null),
    current: () => currentLang,
    clearCache: () => { cache = {}; safeSet(STORE_CACHE, cache); },
  };

  function init() {
    build();
    const saved = safeGet(STORE_LANG, null);
    // 等待 React 等框架第一次渲染完再翻譯
    if (saved) setTimeout(() => setLanguage(saved), 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
