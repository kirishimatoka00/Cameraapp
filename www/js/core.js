/* 核心:命名空間、設定、通用 UI 工具、覆蓋頁堆疊 */
(() => {
'use strict';
const A = window.A = {};

A.VERSION = '3.0.0';
A.$ = (id) => document.getElementById(id);
A.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
A.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
A.errMsg = (e) => (e && (e.message || e.errorMessage)) || String(e);

A.CT = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CameraTools) || null;
A.needNative = () => {
  const p = A.CT();
  if (!p) throw new Error('原生外掛未載入,請在 Android App 內執行');
  return p;
};

/* ------------------------------------------------------------------ 提示詞 */

A.DEFAULT_PROMPT =
  'This photo was taken with digital zoom (cropped and upscaled), so it looks soft and has interpolation artifacts, noise and compression damage. ' +
  'Reconstruct it into a clean, sharp, natural, high-resolution photograph. ' +
  'Keep the exact composition, framing, object positions, colors and lighting. ' +
  'Do not add, remove or change any object, text, logo or face. Only recover plausible fine detail and remove noise and artifacts.';

A.DEFAULT_ENHANCE_PROMPT =
  'Enhance this photograph: improve clarity, micro-contrast, dynamic range and natural color, and reduce noise. ' +
  'Keep the exact composition, framing, objects, text, logos and faces unchanged. Do not add or remove anything. ' +
  'The result must look like a real, naturally lit photo, not an illustration.';

/* ------------------------------------------------------------------ 設定 */

A.DEFAULTS = {
  // Gemini
  apiKey: '',
  model: 'gemini-nano-banana-2.1',
  modelCustom: '',
  imageSize: '4K',
  maxInput: 2048,
  autoRestore: false,
  autoThreshold: 1.5,
  prompt: A.DEFAULT_PROMPT,
  enhancePrompt: A.DEFAULT_ENHANCE_PROMPT,
  // HDR
  hdrOn: false,
  hdrCount: 5,
  hdrRange: 2,
  hdrSettle: 550,
  // 輸出
  jpegQuality: 95,
  targetMP: 100,
  // 取景
  ratio: '3:4',          // 3:4 | 1:1 | 9:16 | full
  grid: false,
  histogram: true,
  focusAssist: 'single', // single | face | track
  faceAuto: true,
  // 色彩
  look: null,            // 目前色彩設定(null = 中性)
  profileId: 'standard',
  profiles: [],          // 自訂色彩檔案 [{id,name,look}]
  applyOnCapture: true,
  keepOriginal: true,
  rawOn: false,
  selfieMirror: true,
  zoomOutMp: 9,
  lensLock: false,
  nativePreview: true,
  enhProfiles: [],       // 自訂畫質設定檔 [{id,name,enh}]
  enhCap: null,          // 拍攝選單的畫質提升 {on,id,enh}
  enhSet: null,          // 設定頁(後期修圖/相簿)的畫質提升
  rawJpeg: true,
  teleNativeId: '',
  // 影片
  videoRes: '4K',
  videoFps: 30,
  // 鏡頭對應
  lensMap: { wide: '', main: '', tele: '' },
};

function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem('aicam.settings.v3') || 'null') || JSON.parse(localStorage.getItem('aicam.settings.v2') || '{}');
  } catch (e) { raw = {}; }
  const s = Object.assign({}, A.DEFAULTS, raw);
  s.lensMap = Object.assign({}, A.DEFAULTS.lensMap, raw.lensMap || {});
  if (!Array.isArray(s.profiles)) s.profiles = [];
  return s;
}
A.settings = loadSettings();
A.saveSettings = () => {
  try { localStorage.setItem('aicam.settings.v3', JSON.stringify(A.settings)); } catch (e) { /* ignore */ }
};
A.effectiveModel = () => (A.settings.model === '__custom' ? (A.settings.modelCustom || '').trim() : A.settings.model);

/* ------------------------------------------------------------------ UI 工具 */

let toastTimer;
A.toast = (msg, ms = 3000) => {
  const t = A.$('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
};
A.hud = (main, sub = '') => {
  A.$('hudMain').textContent = main;
  A.$('hudSub').textContent = sub;
  A.$('hud').hidden = false;
};
A.hudSub = (sub) => { A.$('hudSub').textContent = sub; };
A.hudHide = () => { A.$('hud').hidden = true; };

/* 覆蓋頁堆疊 + Android 返回鍵 */
A.overlays = [];
A.openOverlay = (el) => {
  if (!el.hidden) return;
  el.hidden = false;
  A.overlays.push(el);
  history.pushState({ ov: el.id }, '');
  el.dispatchEvent(new CustomEvent('overlayopen'));
};
A.closeOverlay = (el) => {
  if (el.hidden) return;
  if (A.overlays[A.overlays.length - 1] === el) {
    history.back();
  } else {
    el.hidden = true;
    const i = A.overlays.indexOf(el);
    if (i >= 0) A.overlays.splice(i, 1);
    el.dispatchEvent(new CustomEvent('overlayclose'));
  }
};
window.addEventListener('popstate', () => {
  const el = A.overlays.pop();
  if (el) {
    el.hidden = true;
    el.dispatchEvent(new CustomEvent('overlayclose'));
  }
});

/* 事件鎖:拍攝/處理中避免重複操作 */
A.busy = false;

/* base64 / blob */
A.blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => {
    const s = String(fr.result);
    resolve(s.slice(s.lastIndexOf(',') + 1));
  };
  fr.onerror = () => reject(fr.error || new Error('讀取失敗'));
  fr.readAsDataURL(blob);
});

A.bindProgress = () => {
  const p = A.CT();
  if (!p || !p.addListener) return;
  try {
    p.addListener('progress', (e) => {
      if (!e || !e.stage) return;
      if (!A.$('hud').hidden) A.hudSub(e.stage);
      else if (A.bg.n > 0) A.bgShow(e.stage);
    });
    p.addListener('jobDone', (e) => A.bgDone(e || {}));
  } catch (e) { /* ignore */ }
};

/* ------------------------------------------------------------------ 背景處理佇列 */
A.bg = { n: 0 };
A.bgShow = (stage) => {
  const b = A.$('bgBadge');
  if (!b) return;
  b.hidden = A.bg.n <= 0;
  b.textContent = '背景處理 ' + A.bg.n + (stage ? ' · ' + stage : '');
};
A.bgAdd = (k) => { A.bg.n += k; A.bgShow(''); };
A.bgDone = (e) => {
  A.bg.n = Math.max(0, A.bg.n - 1);
  A.bgShow('');
  if (A.refreshThumb) A.refreshThumb();
  if (e.error) A.toast('背景處理失敗:' + e.error, 6000);
  else {
    if (e.note) A.toast(e.note, 3000);
    A.toast('已儲存 ' + e.width + '×' + e.height + '(' + (e.megapixels || 0).toFixed(1) + ' MP)' + (e.hasRaw ? ' + DNG' : ''), 2500);
    if (e.auto && e.uri && A.runGemini && !A.busy) A.runGemini(e.uri, true).catch((x) => A.toast('Gemini 回推失敗:' + A.errMsg(x), 5000));
  }
};
})();
