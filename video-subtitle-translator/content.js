// 內容腳本：讀取影片目前的字幕 → 翻譯 → 疊加在影片上
(() => {
  'use strict';
  if (window.__vstLoaded) return;
  window.__vstLoaded = true;

  const DEFAULTS = { enabled: true, target: 'zh-TW', mode: 'bilingual', fontSize: 24 };
  let S = { ...DEFAULTS };

  // 各影音網站自己畫字幕的位置（網站改版時可能需要更新）
  const SITES = [
    { host: /(^|\.)youtube\.com$/,  container: '#movie_player',
      lines: '.ytp-caption-window-container .caption-visual-line', hide: '.ytp-caption-window-container' },
    { host: /(^|\.)netflix\.com$/,  container: '.watch-video--player-view',
      lines: '.player-timedtext-text-container', hide: '.player-timedtext' },
    { host: /(^|\.)bilibili\.com$/, container: '.bpx-player-video-area',
      lines: '.bpx-player-subtitle-panel-text', hide: '.bpx-player-subtitle-wrap' },
  ];
  const site = SITES.find(s => s.host.test(location.hostname));

  // ── 翻譯與快取 ──────────────────────────────────────────────────
  const cache = new Map();     // key → 譯文
  const inflight = new Set();
  const key = t => S.target + '\u0001' + t;

  function send(texts, target) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'vst-translate', texts, target }, res => {
          void chrome.runtime.lastError;
          resolve(res && res.ok ? res.result : null);
        });
      } catch { resolve(null); } // 擴充功能被重新載入時
    });
  }

  function fetchTexts(texts) {
    const target = S.target;
    const todo = [...new Set(texts)].filter(t => t && !cache.has(target + '\u0001' + t) && !inflight.has(target + '\u0001' + t));
    for (let i = 0; i < todo.length; i += 40) {
      const batch = todo.slice(i, i + 40);
      batch.forEach(t => inflight.add(target + '\u0001' + t));
      send(batch, target).then(res => {
        batch.forEach((t, j) => {
          inflight.delete(target + '\u0001' + t);
          if (res && res[j] != null) cache.set(target + '\u0001' + t, res[j]);
        });
        lastRender = ''; // 譯文到了，下一輪重畫
      });
    }
  }

  function lookup(text) {
    const k = key(text);
    if (cache.has(k)) return cache.get(k);
    fetchTexts([text]);
    return null;
  }

  // ── 取得目前字幕 ────────────────────────────────────────────────
  const ownedTracks = new Set();   // 被我們接手（設成 hidden）的 textTrack
  const prefetched = new WeakMap(); // track → 已預翻的 cue 數

  const cueText = c => {
    try { if (c.getCueAsHTML) return c.getCueAsHTML().textContent.trim(); } catch {}
    return String(c.text || '').replace(/<[^>]+>/g, '').trim();
  };

  function fromSite() {
    const container = document.querySelector(site.container);
    if (!container) return null;
    const text = [...container.querySelectorAll(site.lines)]
      .map(e => e.innerText.trim()).filter(Boolean).join('\n');
    return { container, text };
  }

  function fromTextTracks() {
    for (const video of document.querySelectorAll('video')) {
      for (const t of video.textTracks) {
        if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
        if (t.mode === 'showing') { t.mode = 'hidden'; ownedTracks.add(t); }
        if (!ownedTracks.has(t) || t.mode !== 'hidden') continue;
        // 預先把整條字幕翻好，播放時就沒有延遲
        if (t.cues && prefetched.get(t) !== t.cues.length + S.target) {
          prefetched.set(t, t.cues.length + S.target);
          fetchTexts([...t.cues].map(cueText));
        }
        const text = [...(t.activeCues || [])].map(cueText).filter(Boolean).join('\n');
        return { container: video.parentElement, text };
      }
    }
    return null;
  }

  function releaseTracks() {
    for (const t of ownedTracks) if (t.mode === 'hidden') t.mode = 'showing';
    ownedTracks.clear();
  }

  // ── 疊加層 ──────────────────────────────────────────────────────
  const style = document.createElement('style');
  let overlay = null;
  let lastRender = '';

  function updateStyle() {
    style.textContent = `
      .__vst-overlay{position:absolute;left:50%;bottom:10%;transform:translateX(-50%);z-index:2147483647;
        width:max-content;max-width:90%;text-align:center;pointer-events:none;
        font-family:system-ui,-apple-system,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif}
      .__vst-overlay:empty{display:none}
      .__vst-line{display:inline-block;margin:2px 0;padding:2px 10px;border-radius:6px;
        background:rgba(8,8,8,.75);color:#fff;line-height:1.4;white-space:pre-line;font-size:${S.fontSize}px}
      .__vst-orig{font-size:${Math.round(S.fontSize * 0.75)}px;color:#e5e5e5}
      .__vst-trans{color:#ffe36e}
      .__vst-pending{opacity:.6}
      ${site && S.enabled ? `${site.hide}{opacity:0 !important}` : ''}`;
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  }

  function ensureOverlay(container) {
    if (!overlay) { overlay = document.createElement('div'); overlay.className = '__vst-overlay notranslate'; overlay.setAttribute('translate', 'no'); }
    if (overlay.parentNode !== container) {
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(overlay);
    }
    return overlay;
  }

  function line(cls, text) {
    const wrap = document.createElement('div');
    const span = document.createElement('span');
    span.className = '__vst-line ' + cls;
    span.textContent = text;
    wrap.appendChild(span);
    return wrap;
  }

  function render(cur) {
    if (!cur) { overlay?.remove(); lastRender = ''; return; }
    const trans = cur.text ? lookup(cur.text) : null;
    const sig = [cur.text, trans, S.mode, S.fontSize].join('\u0002');
    if (sig === lastRender && overlay?.parentNode === cur.container) return;
    lastRender = sig;
    const el = ensureOverlay(cur.container);
    el.replaceChildren();
    if (!cur.text) return;
    if (S.mode === 'bilingual') el.appendChild(line('__vst-orig', cur.text));
    if (trans != null) el.appendChild(line('__vst-trans', trans));
    else if (S.mode !== 'bilingual') el.appendChild(line('__vst-pending', cur.text));
  }

  // ── 主迴圈 ──────────────────────────────────────────────────────
  function tick() {
    if (!S.enabled) return;
    if (!document.querySelector('video')) { render(null); return; }
    render((site && fromSite()) || fromTextTracks());
  }

  function applySettings() {
    updateStyle();
    lastRender = '';
    if (!S.enabled) { render(null); releaseTracks(); }
  }

  try {
    chrome.storage.sync.get(DEFAULTS, s => { S = { ...DEFAULTS, ...s }; applySettings(); });
    chrome.storage.onChanged.addListener(changes => {
      for (const k in changes) S[k] = changes[k].newValue;
      applySettings();
    });
  } catch {}
  applySettings();
  setInterval(tick, 200);
})();
