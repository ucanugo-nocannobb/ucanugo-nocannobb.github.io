// 背景服務：代替頁面呼叫翻譯 API（避開網站的 CORS / CSP 限制）
const SEP = '\n';

async function googleBatch(texts, target) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto'
    + '&tl=' + encodeURIComponent(target);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(texts.join(SEP)),
  });
  if (!res.ok) throw new Error('translate ' + res.status);
  const data = await res.json();
  return (data[0] || []).map(seg => seg[0] || '').join('').split(SEP);
}

async function translate(texts, target) {
  // 字幕內的換行先壓成空白，才能用換行當分隔
  const flat = texts.map(t => t.replace(/\s*\n\s*/g, ' '));
  const parts = await googleBatch(flat, target);
  if (parts.length === flat.length) return parts;
  // 行數對不上時逐句翻
  const out = [];
  for (const t of flat) out.push((await googleBatch([t], target)).join(' '));
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'vst-translate') return;
  translate(msg.texts, msg.target).then(
    result => sendResponse({ ok: true, result }),
    err => sendResponse({ ok: false, error: String(err) }),
  );
  return true; // 非同步回應
});
