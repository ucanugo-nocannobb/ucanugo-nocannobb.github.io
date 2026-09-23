const DEFAULTS = { enabled: true, target: 'zh-TW', mode: 'bilingual', fontSize: 24 };
const $ = id => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, s => {
  $('enabled').checked = s.enabled;
  $('target').value = s.target;
  $('mode').value = s.mode;
  $('fontSize').value = s.fontSize;
});

$('enabled').addEventListener('change', e => chrome.storage.sync.set({ enabled: e.target.checked }));
$('target').addEventListener('change', e => chrome.storage.sync.set({ target: e.target.value }));
$('mode').addEventListener('change', e => chrome.storage.sync.set({ mode: e.target.value }));
$('fontSize').addEventListener('input', e => chrome.storage.sync.set({ fontSize: Number(e.target.value) }));
