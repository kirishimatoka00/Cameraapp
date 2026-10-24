/* AI Camera Pro — 前端邏輯
 * 取景/變焦/HDR 在 WebView 內進行,存圖、HDR 合成、1 億畫素放大、Gemini 呼叫由原生外掛 CameraTools 負責。
 */
(() => {
'use strict';

const VERSION = '2.0.0';
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const CT = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CameraTools) || null;
function needNative() {
  const p = CT();
  if (!p) throw new Error('原生外掛未載入,請在 Android App 內執行');
  return p;
}

/* ------------------------------------------------------------------ 設定 */

const DEFAULT_PROMPT =
  'This photo was taken with digital zoom (cropped and upscaled), so it looks soft and has interpolation artifacts, noise and compression damage. ' +
  'Reconstruct it into a clean, sharp, natural, high-resolution photograph. ' +
  'Keep the exact composition, framing, object positions, colors and lighting. ' +
  'Do not add, remove or change any object, text, logo or face. Only recover plausible fine detail and remove noise and artifacts.';

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-nano-banana-2.1',
  modelCustom: '',
  imageSize: '4K',
  maxInput: 2048,
  autoRestore: false,
  autoThreshold: 1.5,
  prompt: DEFAULT_PROMPT,
  hdrOn: false,
  hdrCount: 5,
  hdrRange: 2,
  hdrSettle: 550,
  jpegQuality: 95,
  targetMP: 100,
  lensMap: { wide: '', main: '', tele: '' },
};

let settings = loadSettings();

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('aicam.settings.v2') || '{}');
    return Object.assign({}, DEFAULTS, raw, { lensMap: Object.assign({}, DEFAULTS.lensMap, raw.lensMap || {}) });
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}
function saveSettings() {
  try { localStorage.setItem('aicam.settings.v2', JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
function effectiveModel() {
  return settings.model === '__custom' ? (settings.modelCustom || '').trim() : settings.model;
}

/* ------------------------------------------------------------------ 狀態 */

const S = {
  devices: [],        // 偵測到的鏡頭
  lens: {},           // {wide, main, tele} -> {dev, ratio}
  lensKey: null,
  stream: null,
  track: null,
  capture: null,
  caps: {},
  photoCaps: null,
  Z: 1,               // 總變焦(以主鏡頭為 1×)
  within: 1,          // 目前鏡頭上的數位倍率
  lightMode: 'off',   // off | flash | torch
  focusMode: 'af',
  busy: false,
  switching: false,
  ev: 0,
  gallery: [],
  starting: false,
};

const video = $('video');
const frame = $('frame');

/* ------------------------------------------------------------------ 小工具 UI */

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function hud(main, sub = '') {
  $('hudMain').textContent = main;
  $('hudSub').textContent = sub;
  $('hud').hidden = false;
}
function hudSub(sub) { $('hudSub').textContent = sub; }
function hudHide() { $('hud').hidden = true; }
const errMsg = (e) => (e && (e.message || e.errorMessage)) || String(e);

/* 覆蓋頁與返回鍵 */
function openOverlay(el) {
  if (!el.hidden) return;
  el.hidden = false;
  history.pushState({ ov: el.id }, '');
}
function closeOverlay(el) {
  if (el.hidden) return;
  history.back();
}
window.addEventListener('popstate', () => {
  $('viewer').hidden = true;
  $('settings').hidden = true;
});

/* ------------------------------------------------------------------ 鏡頭偵測 */

const ROLE_LABEL = { wide: '廣角', main: '主鏡頭', tele: '望遠' };

async function scanCameras() {
  const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  tmp.getTracks().forEach((t) => t.stop());
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');

  let native = [];
  try {
    const r = await needNative().getCameras();
    native = r.cameras || [];
  } catch (e) { console.warn('getCameras', e); }

  S.devices = devs.map((d, i) => {
    const m = /camera2?\s*(\d+)/i.exec(d.label || '');
    const id = m ? m[1] : String(i);
    const nat = native.find((n) => n.id === id) || null;
    let facing = nat ? nat.facing : null;
    if (!facing) {
      const f = /facing\s+(back|front)/i.exec(d.label || '');
      facing = f ? f[1].toLowerCase() : 'unknown';
    }
    return {
      deviceId: d.deviceId,
      label: d.label || ('Camera ' + id),
      id,
      facing,
      eq: nat && nat.equivMm ? nat.equivMm : 0,
      usable: nat ? nat.usable !== false : true,
      native: nat,
    };
  });
  S.nativeOnly = native.filter((n) => !S.devices.some((d) => d.id === n.id));
  assignLenses();
}

function assignLenses() {
  const back = S.devices.filter((d) => d.facing === 'back' && d.usable);
  const byId = (id) => back.find((d) => d.id === id || d.deviceId === id) || null;
  const map = settings.lensMap;

  // 主鏡頭
  let main = byId(map.main);
  if (!main) main = back.find((d) => d.id === '0') || null;
  if (!main && back.length) {
    main = back.slice().sort((a, b) => Math.abs((a.eq || 26) - 26) - Math.abs((b.eq || 26) - 26))[0];
  }
  if (!main) main = S.devices[0] || null;

  const mainEq = main && main.eq ? main.eq : 0;
  const others = back.filter((d) => d !== main && d.eq > 0 && mainEq > 0);

  let wide = byId(map.wide);
  if (!wide) {
    const c = others.filter((d) => d.eq <= mainEq * 0.8).sort((a, b) => a.eq - b.eq);
    wide = c[0] || null;
  }
  let tele = byId(map.tele);
  if (!tele) {
    const c = others.filter((d) => d.eq >= mainEq * 1.5).sort((a, b) => a.eq - b.eq);
    tele = c[0] || null;
  }

  const ratioOf = (d, fallback) => {
    if (!d || !mainEq || !d.eq) return fallback;
    return Math.max(0.3, Math.round((d.eq / mainEq) * 2) / 2);
  };

  S.lens = {};
  if (wide && wide !== main) S.lens.wide = { dev: wide, ratio: Math.min(ratioOf(wide, 0.5), 0.9) };
  if (main) S.lens.main = { dev: main, ratio: 1 };
  if (tele && tele !== main) S.lens.tele = { dev: tele, ratio: Math.max(ratioOf(tele, 2), 1.5) };
  renderLensButtons();
}

function lensRatios() {
  return Object.values(S.lens).map((l) => l.ratio).sort((a, b) => a - b);
}
function minZoom() { const r = lensRatios(); return r.length ? r[0] : 1; }
const MAX_ZOOM = 10;

function chooseLens(Z) {
  const entries = Object.entries(S.lens).sort((a, b) => a[1].ratio - b[1].ratio);
  let pick = entries[0];
  for (const e of entries) if (e[1].ratio <= Z * 1.02) pick = e;
  return pick ? pick[0] : null;
}

/* ------------------------------------------------------------------ 串流 */

function stopStream() {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null; S.track = null; S.capture = null; S.photoCaps = null;
  video.srcObject = null;
}

async function startLens(key) {
  const L = S.lens[key];
  if (!L) return false;
  stopStream();
  const id = { exact: L.dev.deviceId };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: id, width: { ideal: 1920 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } }, audio: false,
    });
  } catch (e) {
    stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id }, audio: false });
  }
  S.stream = stream;
  S.track = stream.getVideoTracks()[0];
  S.lensKey = key;
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* autoplay */ }
  S.caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
  if (window.ImageCapture) {
    try { S.capture = new ImageCapture(S.track); } catch (e) { S.capture = null; }
  }
  updateFrameAspect();
  await applyBaseControls();
  setupProControls();
  updateLensTag();
  return true;
}

function updateFrameAspect() {
  const w = video.videoWidth, h = video.videoHeight;
  if (w && h) frame.style.aspectRatio = w + ' / ' + h;
}
video.addEventListener('loadedmetadata', updateFrameAspect);
video.addEventListener('resize', updateFrameAspect);

async function applyBaseControls() {
  const adv = [];
  if (S.caps.focusMode && S.caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
  if (S.caps.exposureCompensation) adv.push({ exposureCompensation: S.ev });
  for (const c of adv) { try { await S.track.applyConstraints({ advanced: [c] }); } catch (e) { /* ignore */ } }
  S.focusMode = 'af';
  if (S.lightMode === 'torch') await applyTorch(true);
}

function updateLensTag() {
  const L = S.lens[S.lensKey];
  if (!L) { $('lensTag').textContent = '—'; return; }
  const mm = L.dev.eq ? ' · ' + Math.round(L.dev.eq) + 'mm' : '';
  $('lensTag').textContent = ROLE_LABEL[S.lensKey] + mm + ' · #' + L.dev.id;
}

/* ------------------------------------------------------------------ 變焦 */

const zToSlider = (z) => 100 * Math.log(z / 0.5) / Math.log(20);
const sliderToZ = (v) => 0.5 * Math.pow(20, v / 100);

function applyPreviewZoom() {
  const L = S.lens[S.lensKey];
  const ratio = L ? L.ratio : 1;
  S.within = Math.max(1, S.Z / ratio);
  video.style.transform = S.within > 1.001 ? 'scale(' + S.within.toFixed(3) + ')' : '';
  const badge = $('zoomBadge');
  badge.textContent = S.Z.toFixed(S.Z < 10 ? 1 : 0) + '×';
  badge.classList.toggle('digital', S.within > 1.01);
  $('zoomRange').value = zToSlider(clamp(S.Z, 0.5, MAX_ZOOM));
  document.querySelectorAll('.lens-btn').forEach((b) => {
    b.classList.toggle('active', Math.abs(parseFloat(b.dataset.z) - S.Z) < 0.04);
  });
}

async function setZoom(Z, allowSwitch) {
  Z = clamp(Z, minZoom(), MAX_ZOOM);
  S.Z = Z;
  if (allowSwitch && !S.switching && !S.busy) {
    const key = chooseLens(Z);
    if (key && key !== S.lensKey) {
      S.switching = true;
      try { await startLens(key); } catch (e) { toast('切換鏡頭失敗:' + errMsg(e)); }
      S.switching = false;
    }
  }
  applyPreviewZoom();
}

function renderLensButtons() {
  const row = $('lensRow');
  row.innerHTML = '';
  const ratios = lensRatios();
  const set = new Set([1, 2, 5, 10].concat(ratios));
  const presets = Array.from(set).filter((p) => p >= minZoom() - 0.001).sort((a, b) => a - b);
  presets.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'lens-btn';
    b.dataset.z = String(p);
    const optical = ratios.some((r) => Math.abs(r - p) < 0.01);
    if (!optical) b.classList.add('digital');
    b.textContent = (p < 1 ? p.toFixed(1) : String(p)) + (p < 1 ? '' : '×');
    b.onclick = () => setZoom(p, true);
    row.appendChild(b);
  });
  applyPreviewZoom();
}

/* 雙指縮放 + 點擊對焦 */
const stage = $('stage');
const ptrs = new Map();
let pinch = null;
let tapInfo = null;

stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) tapInfo = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  if (ptrs.size === 2) {
    const [a, b] = Array.from(ptrs.values());
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), Z: S.Z };
    tapInfo = null;
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tapInfo && Math.hypot(e.clientX - tapInfo.x, e.clientY - tapInfo.y) > 12) tapInfo.moved = true;
  if (pinch && ptrs.size >= 2) {
    const [a, b] = Array.from(ptrs.values());
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    S.pinchTarget = clamp(pinch.Z * (d / pinch.d), minZoom(), MAX_ZOOM);
    setZoom(S.pinchTarget, false);
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (pinch && ptrs.size < 2) {
    pinch = null;
    setZoom(S.pinchTarget || S.Z, true);
  } else if (tapInfo && !tapInfo.moved && performance.now() - tapInfo.t < 400 && ptrs.size === 0) {
    tapFocus(tapInfo.x, tapInfo.y);
  }
  if (ptrs.size === 0) tapInfo = null;
}
stage.addEventListener('pointerup', endPtr);
stage.addEventListener('pointercancel', endPtr);

async function tapFocus(cx, cy) {
  const r = frame.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return;
  const ret = $('reticle');
  ret.style.left = (cx - r.left) + 'px';
  ret.style.top = (cy - r.top) + 'px';
  ret.classList.remove('show');
  void ret.offsetWidth;
  ret.classList.add('show');
  if (!S.track) return;
  const nx = (cx - r.left) / r.width;
  const ny = (cy - r.top) / r.height;
  // 預覽以中心放大,換算回感光元件座標
  const px = clamp(0.5 + (nx - 0.5) / S.within, 0, 1);
  const py = clamp(0.5 + (ny - 0.5) / S.within, 0, 1);
  try {
    await S.track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: px, y: py }] }] });
  } catch (e) { /* 不支援就略過 */ }
  try {
    await S.track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
  } catch (e) { /* ignore */ }
  setTimeout(() => {
    if (S.focusMode === 'af' && S.track && S.caps.focusMode && S.caps.focusMode.includes('continuous')) {
      S.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
  }, 2500);
}

/* ------------------------------------------------------------------ 專業控制:EV / 手動對焦 / 閃光 */

function setupProControls() {
  const ev = $('evRange');
  const ec = S.caps.exposureCompensation;
  if (ec) {
    ev.min = ec.min; ev.max = ec.max; ev.step = ec.step || 0.1;
    ev.disabled = false;
  } else {
    ev.disabled = true;
  }
  ev.value = S.ev;
  $('evVal').textContent = (+S.ev).toFixed(1);

  const canManual = S.caps.focusMode && S.caps.focusMode.includes('manual') && S.caps.focusDistance;
  const fb = $('btnFocusMode');
  fb.textContent = 'AF';
  fb.classList.remove('manual');
  $('focusRange').disabled = true;
  $('focusVal').textContent = canManual ? '自動' : '不支援';
  fb.disabled = !canManual;
}

$('evRange').oninput = async function () {
  S.ev = parseFloat(this.value);
  $('evVal').textContent = S.ev.toFixed(1);
  if (S.track && S.caps.exposureCompensation) {
    try { await S.track.applyConstraints({ advanced: [{ exposureCompensation: S.ev }] }); } catch (e) { /* ignore */ }
  }
};

$('btnFocusMode').onclick = async () => {
  const fb = $('btnFocusMode');
  if (S.focusMode === 'af') {
    S.focusMode = 'mf';
    fb.textContent = 'MF'; fb.classList.add('manual');
    const fd = S.caps.focusDistance;
    const r = $('focusRange');
    r.disabled = false;
    $('focusVal').textContent = '手動';
    try { await S.track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: fd.min }] }); } catch (e) { /* ignore */ }
    r.value = 0;
  } else {
    S.focusMode = 'af';
    fb.textContent = 'AF'; fb.classList.remove('manual');
    $('focusRange').disabled = true;
    $('focusVal').textContent = '自動';
    try { await S.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* ignore */ }
  }
};
$('focusRange').oninput = async function () {
  const fd = S.caps.focusDistance;
  if (!fd || S.focusMode !== 'mf') return;
  const v = fd.min + (fd.max - fd.min) * (this.value / 100);
  try { await S.track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: v }] }); } catch (e) { /* ignore */ }
};

$('btnPro').onclick = () => { $('proPanel').hidden = !$('proPanel').hidden; };

async function applyTorch(on) {
  if (!S.track || !S.caps.torch) return;
  try { await S.track.applyConstraints({ advanced: [{ torch: !!on }] }); } catch (e) { /* ignore */ }
}
$('btnLight').onclick = async () => {
  const order = ['off', 'flash', 'torch'];
  S.lightMode = order[(order.indexOf(S.lightMode) + 1) % order.length];
  $('btnLight').textContent = { off: '🚫', flash: '⚡', torch: '🔦' }[S.lightMode];
  await applyTorch(S.lightMode === 'torch');
  if (S.lightMode !== 'off' && !S.caps.torch) toast('此鏡頭不支援補光燈');
};

/* ------------------------------------------------------------------ HDR 開關顯示 */

function refreshHdrChip() {
  const b = $('btnHdr');
  if (settings.hdrOn) {
    b.textContent = 'HDR ' + settings.hdrCount + '張 ±' + settings.hdrRange;
    b.classList.add('on');
  } else {
    b.textContent = 'HDR 關';
    b.classList.remove('on');
  }
  $('btnShutter').classList.toggle('hdr', !!settings.hdrOn);
}
$('btnHdr').onclick = () => {
  settings.hdrOn = !settings.hdrOn;
  saveSettings();
  refreshHdrChip();
};

/* ------------------------------------------------------------------ 拍攝 */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = () => reject(fr.error || new Error('讀取影像失敗'));
    fr.readAsDataURL(blob);
  });
}

async function takeStill() {
  if (S.capture) {
    try {
      if (!S.photoCaps) S.photoCaps = await S.capture.getPhotoCapabilities();
      const pc = S.photoCaps;
      const opt = {};
      if (pc.imageWidth && pc.imageHeight) {
        opt.imageWidth = pc.imageWidth.max;
        opt.imageHeight = pc.imageHeight.max;
      }
      if (S.lightMode === 'flash' && pc.fillLightMode && pc.fillLightMode.includes('flash')) opt.fillLightMode = 'flash';
      return await S.capture.takePhoto(opt);
    } catch (e) {
      console.warn('takePhoto 失敗,改用預覽畫面', e);
    }
  }
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
}

function buildEvs(n, range, cap) {
  const out = [];
  for (let k = 0; k < n; k++) {
    let v = n === 1 ? 0 : -range + k * (2 * range / (n - 1));
    if (cap) {
      v = clamp(v, cap.min, cap.max);
      if (cap.step) v = Math.round(v / cap.step) * cap.step;
    }
    out.push(+v.toFixed(2));
  }
  return out;
}

async function shootHdr(cropZoom) {
  const cap = S.caps.exposureCompensation;
  if (!cap) {
    toast('此鏡頭不支援曝光補償,已改拍單張');
    const blob = await takeStill();
    return needNative().saveImage({ data: await blobToBase64(blob), cropZoom, quality: settings.jpegQuality, prefix: 'IMG' });
  }
  const evs = buildEvs(settings.hdrCount, settings.hdrRange, cap);
  const spread = Math.max(...evs) - Math.min(...evs);
  if (spread < 0.3) toast('裝置曝光補償範圍很小,HDR 效果有限');
  await needNative().clearFrames();
  const userEv = S.ev;
  try {
    for (let i = 0; i < evs.length; i++) {
      hudSub('HDR ' + (i + 1) + '/' + evs.length + '(EV ' + (evs[i] > 0 ? '+' : '') + evs[i].toFixed(1) + ')');
      try { await S.track.applyConstraints({ advanced: [{ exposureCompensation: evs[i] }] }); } catch (e) { /* ignore */ }
      await sleep(settings.hdrSettle);
      const blob = await takeStill();
      await needNative().cacheFrame({ index: i, data: await blobToBase64(blob) });
    }
  } finally {
    try { await S.track.applyConstraints({ advanced: [{ exposureCompensation: userEv }] }); } catch (e) { /* ignore */ }
  }
  hudSub('合成 HDR');
  return needNative().mergeHdr({ count: evs.length, quality: settings.jpegQuality, cropZoom });
}

async function shoot() {
  if (S.busy || !S.track) return;
  S.busy = true;
  $('btnShutter').classList.add('busy');
  hud(settings.hdrOn ? '拍攝 HDR' : '拍攝中', '請保持穩定');
  try {
    if (navigator.vibrate) navigator.vibrate(15);
    const cropZoom = S.within > 1.01 ? S.within : 1;
    let res;
    if (settings.hdrOn) {
      res = await shootHdr(cropZoom);
    } else {
      const blob = await takeStill();
      hudSub('儲存中');
      res = await needNative().saveImage({ data: await blobToBase64(blob), cropZoom, quality: settings.jpegQuality, prefix: 'IMG' });
    }
    await refreshGallery();

    if (settings.autoRestore && settings.apiKey && S.within >= settings.autoThreshold) {
      try {
        await runGemini(res.uri, true);
      } catch (e) {
        toast('Gemini 回推失敗:' + errMsg(e), 5000);
      }
    } else {
      toast('已儲存 ' + res.width + '×' + res.height + '(' + res.megapixels.toFixed(1) + ' MP)');
    }
  } catch (e) {
    toast('拍攝失敗:' + errMsg(e), 5000);
  } finally {
    hudHide();
    S.busy = false;
    $('btnShutter').classList.remove('busy');
  }
}
$('btnShutter').onclick = shoot;

/* ------------------------------------------------------------------ Gemini / 放大 */

async function runGemini(uri, silentOpen) {
  if (!settings.apiKey) {
    toast('請先在設定輸入 Gemini API key');
    openOverlay($('settings'));
    return null;
  }
  const model = effectiveModel();
  if (!model) { toast('請在設定選擇或輸入模型 ID'); return null; }
  hud('Gemini 回推中', '最高 4K 輸出,可能需要 30~120 秒');
  const r = await needNative().geminiRestore({
    uri, apiKey: settings.apiKey.trim(), model, imageSize: settings.imageSize,
    prompt: settings.prompt || DEFAULT_PROMPT, maxInputDim: settings.maxInput, quality: settings.jpegQuality,
  });
  await refreshGallery();
  toast('完成:' + r.width + '×' + r.height + '(' + r.megapixels.toFixed(1) + ' MP)', 3500);
  if (!silentOpen) await showViewerUri(r.uri);
  return r;
}

async function runUpscale(uri) {
  hud('放大中', '正在配置大型畫布…');
  const r = await needNative().upscale({ uri, targetMegapixels: settings.targetMP, quality: settings.jpegQuality });
  await refreshGallery();
  let m = '完成:' + r.width + '×' + r.height + '(' + r.megapixels.toFixed(1) + ' MP)';
  if (r.actualMp && r.actualMp < settings.targetMP - 0.5) m += ',記憶體不足已降級';
  toast(m, 4000);
  await showViewerUri(r.uri);
}

function bindProgress() {
  const p = CT();
  if (!p || !p.addListener) return;
  try {
    p.addListener('progress', (e) => { if (e && e.stage) hudSub(e.stage); });
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ 相簿 / 縮圖 */

async function refreshGallery() {
  try {
    const r = await needNative().listRecent({ limit: 80 });
    S.gallery = r.items || [];
  } catch (e) { S.gallery = []; }
  if (S.gallery[0]) {
    try {
      const t = await needNative().readImage({ uri: S.gallery[0].uri, maxDim: 160, quality: 80 });
      $('thumbImg').src = 'data:image/jpeg;base64,' + t.data;
    } catch (e) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ 檢視器 */

const V = {
  uri: null, w: 1, h: 1, fw: 0, fh: 0, vw: 0, vh: 0, s: 1, tx: 0, ty: 0, max: 8,
  ptrs: new Map(), pinch: null, seq: 0, timer: null, tap: null, lastTap: 0, mp: 0,
};
const vStage = $('vStage');
const vContent = $('vContent');
const vTile = $('vTile');

function vApply() {
  const sw = V.fw * V.s, sh = V.fh * V.s;
  V.tx = sw <= V.vw ? (V.vw - sw) / 2 : clamp(V.tx, V.vw - sw, 0);
  V.ty = sh <= V.vh ? (V.vh - sh) / 2 : clamp(V.ty, V.vh - sh, 0);
  vContent.style.transform = 'translate(' + V.tx + 'px,' + V.ty + 'px) scale(' + V.s + ')';
}
function vLayout() {
  V.vw = vStage.clientWidth; V.vh = vStage.clientHeight;
  const ar = V.w / V.h;
  let fw = V.vw, fh = fw / ar;
  if (fh > V.vh) { fh = V.vh; fw = fh * ar; }
  V.fw = fw; V.fh = fh;
  vContent.style.width = fw + 'px';
  vContent.style.height = fh + 'px';
  V.max = Math.max(8, (V.w / fw) * 3);
  V.s = 1; V.tx = (V.vw - fw) / 2; V.ty = (V.vh - fh) / 2;
  vTile.hidden = true;
  vApply();
}
function vZoomAt(px, py, ns) {
  ns = clamp(ns, 1, V.max);
  const k = ns / V.s;
  V.tx = px - (px - V.tx) * k;
  V.ty = py - (py - V.ty) * k;
  V.s = ns;
  vApply();
}
function vSchedule() {
  clearTimeout(V.timer);
  V.timer = setTimeout(vLoadTile, 260);
}
async function vLoadTile() {
  if (V.s < 1.25) { vTile.hidden = true; return; }
  const my = ++V.seq;
  const x0 = clamp(-V.tx / V.s, 0, V.fw), y0 = clamp(-V.ty / V.s, 0, V.fh);
  const x1 = clamp((V.vw - V.tx) / V.s, 0, V.fw), y1 = clamp((V.vh - V.ty) / V.s, 0, V.fh);
  if (x1 - x0 < 2 || y1 - y0 < 2) return;
  const outMax = Math.min(2400, Math.ceil(Math.max(V.vw, V.vh) * (window.devicePixelRatio || 1)));
  try {
    const r = await needNative().readRegion({
      uri: V.uri, x0: x0 / V.fw, y0: y0 / V.fh, x1: x1 / V.fw, y1: y1 / V.fh, outMax,
    });
    if (my !== V.seq) return;
    vTile.src = 'data:image/jpeg;base64,' + r.data;
    vTile.style.left = (r.x0 * 100) + '%';
    vTile.style.top = (r.y0 * 100) + '%';
    vTile.style.width = ((r.x1 - r.x0) * 100) + '%';
    vTile.style.height = ((r.y1 - r.y0) * 100) + '%';
    vTile.hidden = false;
  } catch (e) { /* 忽略 */ }
}

vStage.addEventListener('pointerdown', (e) => {
  vStage.setPointerCapture(e.pointerId);
  V.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (V.ptrs.size === 1) V.tap = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  if (V.ptrs.size === 2) {
    const [a, b] = Array.from(V.ptrs.values());
    V.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: V.s };
    V.tap = null;
  }
});
vStage.addEventListener('pointermove', (e) => {
  const p = V.ptrs.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  V.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (V.tap && Math.hypot(e.clientX - V.tap.x, e.clientY - V.tap.y) > 10) V.tap.moved = true;
  const rect = vStage.getBoundingClientRect();
  if (V.pinch && V.ptrs.size >= 2) {
    const [a, b] = Array.from(V.ptrs.values());
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2 - rect.left, my = (a.y + b.y) / 2 - rect.top;
    vZoomAt(mx, my, V.pinch.s * (d / V.pinch.d));
  } else if (V.ptrs.size === 1) {
    V.tx += dx; V.ty += dy;
    vApply();
  }
});
function vEnd(e) {
  if (!V.ptrs.has(e.pointerId)) return;
  V.ptrs.delete(e.pointerId);
  const rect = vStage.getBoundingClientRect();
  if (V.tap && !V.tap.moved && performance.now() - V.tap.t < 300) {
    const now = performance.now();
    if (now - V.lastTap < 320) {
      const px = V.tap.x - rect.left, py = V.tap.y - rect.top;
      if (V.s > 1.5) { V.s = 1; V.tx = (V.vw - V.fw) / 2; V.ty = (V.vh - V.fh) / 2; vApply(); }
      else vZoomAt(px, py, Math.min(4, V.max));
      V.lastTap = 0;
    } else {
      V.lastTap = now;
    }
  }
  if (V.ptrs.size < 2) V.pinch = null;
  if (V.ptrs.size === 0) { V.tap = null; vSchedule(); }
}
vStage.addEventListener('pointerup', vEnd);
vStage.addEventListener('pointercancel', vEnd);

async function showViewerUri(uri) {
  openOverlay($('viewer'));
  V.uri = uri;
  $('vInfo').textContent = '載入中…';
  vTile.hidden = true;
  $('vHint').style.opacity = 1;
  setTimeout(() => { $('vHint').style.opacity = 0; }, 4000);
  try {
    const r = await needNative().readImage({ uri, maxDim: 2048, quality: 88 });
    if (V.uri !== uri) return;
    V.w = r.width; V.h = r.height; V.mp = r.megapixels;
    $('vBase').src = 'data:image/jpeg;base64,' + r.data;
    vLayout();
    const item = S.gallery.find((g) => g.uri === uri);
    $('vInfo').textContent = (item ? item.name : '') + '\n' + r.width + '×' + r.height + ' · ' + r.megapixels.toFixed(1) + ' MP';
    $('vInfo').style.whiteSpace = 'pre-line';
    $('vUpscale').disabled = r.megapixels >= settings.targetMP * 0.98;
  } catch (e) {
    toast('無法開啟影像:' + errMsg(e));
  }
}

function vStep(delta) {
  const i = S.gallery.findIndex((g) => g.uri === V.uri);
  if (i < 0) return;
  const n = S.gallery[i + delta];
  if (n) showViewerUri(n.uri); else toast(delta > 0 ? '已是最舊的一張' : '已是最新的一張', 1500);
}
$('vPrev').onclick = () => vStep(1);
$('vNext').onclick = () => vStep(-1);
$('vClose').onclick = () => closeOverlay($('viewer'));
$('btnThumb').onclick = () => {
  if (S.gallery[0]) showViewerUri(S.gallery[0].uri); else toast('還沒有照片');
};

$('vUpscale').onclick = async () => {
  if (S.busy) return;
  S.busy = true;
  try { await runUpscale(V.uri); } catch (e) { toast('放大失敗:' + errMsg(e), 5000); } finally { hudHide(); S.busy = false; }
};
$('vGemini').onclick = async () => {
  if (S.busy) return;
  S.busy = true;
  try { await runGemini(V.uri, false); } catch (e) { toast('Gemini 回推失敗:' + errMsg(e), 7000); } finally { hudHide(); S.busy = false; }
};

/* ------------------------------------------------------------------ 設定頁 */

function fillSelect(sel, role) {
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = ''; auto.textContent = '自動偵測';
  sel.appendChild(auto);
  S.devices.filter((d) => d.facing === 'back' && d.usable).forEach((d) => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = '#' + d.id + (d.eq ? ' · ' + Math.round(d.eq) + 'mm' : '') + ' · ' + d.label;
    sel.appendChild(o);
  });
  sel.value = settings.lensMap[role] || '';
}

function renderCamList() {
  const box = $('camList');
  box.innerHTML = '';
  const roleOf = (d) => Object.entries(S.lens).filter(([, l]) => l.dev === d).map(([k]) => ROLE_LABEL[k]).join('/');
  S.devices.forEach((d) => {
    const div = document.createElement('div');
    const role = roleOf(d);
    div.innerHTML = '#' + d.id + ' ' + (d.facing === 'back' ? '後' : d.facing === 'front' ? '前' : '?') +
      (d.eq ? ' · 約 ' + Math.round(d.eq) + 'mm(35mm 等效)' : '') +
      (d.native && d.native.sensorMp ? ' · ' + d.native.sensorMp.toFixed(1) + 'MP' : '') +
      (d.usable ? '' : ' · 不可用') +
      (role ? ' <span class="role">→ ' + role + '</span>' : '');
    box.appendChild(div);
  });
  (S.nativeOnly || []).forEach((n) => {
    const div = document.createElement('div');
    div.textContent = '#' + n.id + ' 系統有此鏡頭,但 WebView 沒有開放(無法使用)';
    box.appendChild(div);
  });
  if (!S.devices.length) box.textContent = '尚未偵測到鏡頭';
}

function syncSettingsUI() {
  $('setKey').value = settings.apiKey;
  const known = ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image'];
  $('setModel').value = known.includes(settings.model) ? settings.model : '__custom';
  $('setModelCustom').hidden = $('setModel').value !== '__custom';
  $('setModelCustom').value = settings.modelCustom || (known.includes(settings.model) ? '' : settings.model);
  $('setSize').value = settings.imageSize;
  $('setMaxInput').value = String(settings.maxInput);
  $('setAuto').checked = settings.autoRestore;
  $('setThreshold').value = settings.autoThreshold;
  $('setPrompt').value = settings.prompt;
  $('setHdrOn').checked = settings.hdrOn;
  $('setHdrCount').value = String(settings.hdrCount);
  $('setHdrRange').value = String(settings.hdrRange);
  $('setSettle').value = settings.hdrSettle;
  $('setQuality').value = settings.jpegQuality;
  $('qVal').textContent = settings.jpegQuality;
  $('setMP').value = String(settings.targetMP);
  fillSelect($('mapWide'), 'wide');
  fillSelect($('mapMain'), 'main');
  fillSelect($('mapTele'), 'tele');
  renderCamList();
  $('aboutText').textContent = 'AI Camera Pro v' + VERSION + '\n相簿位置:Pictures/AICamera';
  $('aboutText').style.whiteSpace = 'pre-line';
}

function bindSettings() {
  $('btnSettings').onclick = () => { syncSettingsUI(); openOverlay($('settings')); };
  $('sClose').onclick = () => closeOverlay($('settings'));

  $('setKey').oninput = (e) => { settings.apiKey = e.target.value.trim(); saveSettings(); };
  $('btnShowKey').onclick = () => {
    const k = $('setKey');
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    $('btnShowKey').textContent = show ? '隱藏' : '顯示';
  };
  $('setModel').onchange = (e) => {
    const v = e.target.value;
    $('setModelCustom').hidden = v !== '__custom';
    settings.model = v;
    saveSettings();
  };
  $('setModelCustom').oninput = (e) => { settings.modelCustom = e.target.value; saveSettings(); };
  $('setSize').onchange = (e) => { settings.imageSize = e.target.value; saveSettings(); };
  $('setMaxInput').onchange = (e) => { settings.maxInput = parseInt(e.target.value, 10); saveSettings(); };
  $('setAuto').onchange = (e) => { settings.autoRestore = e.target.checked; saveSettings(); };
  $('setThreshold').onchange = (e) => {
    settings.autoThreshold = clamp(parseFloat(e.target.value) || 1.5, 1, 10);
    e.target.value = settings.autoThreshold;
    saveSettings();
  };
  $('setPrompt').oninput = (e) => { settings.prompt = e.target.value; saveSettings(); };
  $('btnResetPrompt').onclick = () => { settings.prompt = DEFAULT_PROMPT; $('setPrompt').value = DEFAULT_PROMPT; saveSettings(); };

  $('setHdrOn').onchange = (e) => { settings.hdrOn = e.target.checked; saveSettings(); refreshHdrChip(); };
  $('setHdrCount').onchange = (e) => { settings.hdrCount = parseInt(e.target.value, 10); saveSettings(); refreshHdrChip(); };
  $('setHdrRange').onchange = (e) => { settings.hdrRange = parseFloat(e.target.value); saveSettings(); refreshHdrChip(); };
  $('setSettle').onchange = (e) => {
    settings.hdrSettle = clamp(parseInt(e.target.value, 10) || 550, 200, 2000);
    e.target.value = settings.hdrSettle;
    saveSettings();
  };
  $('setQuality').oninput = (e) => {
    settings.jpegQuality = parseInt(e.target.value, 10);
    $('qVal').textContent = settings.jpegQuality;
    saveSettings();
  };
  $('setMP').onchange = (e) => { settings.targetMP = parseInt(e.target.value, 10); saveSettings(); };

  const mapChange = (role) => async (e) => {
    settings.lensMap[role] = e.target.value;
    saveSettings();
    assignLenses();
    renderCamList();
    const key = chooseLens(S.Z);
    if (key && key !== S.lensKey) await setZoom(S.Z, true);
    else if (S.lensKey && !S.lens[S.lensKey]) await startLens(chooseLens(S.Z));
  };
  $('mapWide').onchange = mapChange('wide');
  $('mapMain').onchange = mapChange('main');
  $('mapTele').onchange = mapChange('tele');

  $('btnRescan').onclick = async () => {
    try {
      stopStream();
      await scanCameras();
      syncSettingsUI();
      await startLens(chooseLens(S.Z) || 'main');
      applyPreviewZoom();
      toast('已重新偵測鏡頭');
    } catch (e) { toast('偵測失敗:' + errMsg(e)); }
  };

  $('btnTestKey').onclick = async () => {
    const out = $('testResult');
    out.className = 'test-result';
    out.textContent = '測試中…';
    try {
      const r = await needNative().testGemini({ apiKey: settings.apiKey, model: effectiveModel() });
      out.textContent = r.message;
      out.classList.add(r.ok ? 'ok' : 'err');
    } catch (e) {
      out.textContent = errMsg(e);
      out.classList.add('err');
    }
  };
}

/* ------------------------------------------------------------------ 啟動 */

async function init() {
  bindSettings();
  bindProgress();
  refreshHdrChip();
  $('zoomRange').addEventListener('input', (e) => setZoom(sliderToZ(parseFloat(e.target.value)), false));
  $('zoomRange').addEventListener('change', (e) => setZoom(sliderToZ(parseFloat(e.target.value)), true));

  if (!CT()) toast('原生外掛未載入:僅能預覽,無法存檔', 5000);

  try {
    await scanCameras();
    const key = S.lens.main ? 'main' : Object.keys(S.lens)[0];
    if (!key) throw new Error('找不到可用鏡頭');
    S.Z = S.lens[key].ratio;
    await startLens(key);
    applyPreviewZoom();
    await refreshGallery();
    if (S.lens.tele) toast('偵測到望遠鏡頭:2× 為光學望遠', 2500);
    else toast('未偵測到獨立望遠鏡頭:2× 以上為數位變焦', 3500);
  } catch (e) {
    toast('相機啟動失敗:' + errMsg(e) + '(請確認已允許相機權限)', 6000);
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    stopStream();
  } else if (S.lensKey && !S.stream && !S.starting) {
    S.starting = true;
    try { await startLens(S.lensKey); applyPreviewZoom(); } catch (e) { /* ignore */ }
    S.starting = false;
  }
});

init();
})();
