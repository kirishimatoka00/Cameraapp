/* 相機核心:鏡頭偵測/切換、取景框比例、變焦、對焦、手動控制、白平衡、直方圖 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;
const { clamp } = A;

const S = A.S = {
  devices: [], lens: {}, lensKey: null,
  stream: null, track: null, capture: null, caps: {}, photoCaps: null,
  Z: 1, within: 1, cssZoom: 1,
  lightMode: 'off',
  mode: 'photo',               // photo | manual | video
  ev: 0,
  man: { exp: false, t: null, iso: null },  // 手動曝光
  focusManual: false, focusDist: null,
  hwWb: false,
  frameAR: 0.75,
  switching: false, starting: false, recording: false,
  pickGray: null,
  activeParam: null,
};

const video = $('video');
const frame = $('frame');
const app = $('app');
const viewfinder = $('viewfinder');

/* ------------------------------------------------------------------ 鏡頭偵測 */

const ROLE_LABEL = { wide: '廣角', main: '主鏡頭', tele: '望遠' };
A.ROLE_LABEL = ROLE_LABEL;

A.scanCameras = async () => {
  const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  tmp.getTracks().forEach((t) => t.stop());
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');

  let native = [];
  try { native = (await A.needNative().getCameras()).cameras || []; } catch (e) { console.warn('getCameras', e); }

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
      deviceId: d.deviceId, label: d.label || ('Camera ' + id), id, facing,
      eq: nat && nat.equivMm ? nat.equivMm : 0,
      aperture: nat && nat.apertures && nat.apertures.length ? nat.apertures[0] : 0,
      usable: nat ? nat.usable !== false : true,
      native: nat,
    };
  });
  S.nativeAll = native;
  S.nativeOnly = native.filter((n) => !S.devices.some((d) => d.id === n.id));
  A.assignLenses();
};

A.assignLenses = () => {
  const wantFacing = S.front ? 'front' : 'back';
  const back = S.devices.filter((d) => d.facing === wantFacing && d.usable);
  const byId = (id) => back.find((d) => d.id === id || d.deviceId === id) || null;
  const map = S.front ? { wide: '', main: '', tele: '' } : A.settings.lensMap;

  let main = byId(map.main);
  if (!main && !S.front) main = back.find((d) => d.id === '0') || null;
  if (!main && back.length) {
    main = back.slice().sort((a, b) => Math.abs((a.eq || 26) - 26) - Math.abs((b.eq || 26) - 26))[0];
  }
  if (!main) main = back[0] || (S.front ? null : S.devices[0]) || null;

  const mainEq = main && main.eq ? main.eq : 0;
  const others = back.filter((d) => d !== main && d.eq > 0 && mainEq > 0);
  let wide = byId(map.wide);
  if (!wide) wide = others.filter((d) => d.eq <= mainEq * (S.front ? 0.93 : 0.8)).sort((a, b) => a.eq - b.eq)[0] || null;
  let tele = byId(map.tele);
  if (!tele) tele = others.filter((d) => d.eq >= mainEq * (S.front ? 1.05 : 1.5)).sort((a, b) => a.eq - b.eq)[0] || null;

  const ratioOf = (d, fb) => (!d || !mainEq || !d.eq ? fb : Math.max(0.3, Math.round((d.eq / mainEq) * 2) / 2));
  S.lens = {};
  if (wide && wide !== main) S.lens.wide = { dev: wide, ratio: Math.min(ratioOf(wide, 0.5), 0.9) };
  if (main) S.lens.main = { dev: main, ratio: 1 };
  if (tele && tele !== main) S.lens.tele = { dev: tele, ratio: S.front ? Math.max(1.1, Math.round((tele.eq / mainEq) * 10) / 10) : Math.max(ratioOf(tele, 2), 1.5) };
  else if (main && !tele && !S.front) {
    // WebView 看不到望遠鏡頭 → 找系統隱藏的原生鏡頭(例如 Note 10+ 的 ID 4)
    const manual = (A.settings.teleNativeId || '').trim();
    const cand = (S.nativeOnly || []).filter((n) => n.facing === 'back' && n.equivMm > 0 && mainEq > 0 && n.equivMm >= mainEq * 1.5)
      .sort((a, b) => a.equivMm - b.equivMm)[0] || null;
    // Note 10+:以 com.samsung.android.ruler 身分執行時,邏輯鏡頭 21 即 2× 望遠
    const id52 = (S.nativeAll || []).find((n) => n.id === '52' && n.facing === 'back') || null;
    const id21 = (S.nativeAll || []).find((n) => n.id === '21' && n.facing === 'back') || null;
    const info = manual ? ((S.nativeAll || []).find((n) => n.id === manual) || { id: manual }) : (id52 || id21 || cand);
    if (info && info.id !== main.id) {
      const r = info.equivMm && mainEq ? Math.max(2, Math.round((info.equivMm / mainEq) * 2) / 2) : 2;  // 隱藏望遠至少視為 2×
      S.lens.tele = { dev: main, ratio: r, base: 1, nativeId: info.id, native: info };
    }
  }
  A.renderLensButtons();
};

const lensRatios = () => Object.values(S.lens).map((l) => l.ratio).sort((a, b) => a - b);
const minZoom = () => { const r = lensRatios(); return r.length ? r[0] : 1; };
const MAX_ZOOM = 10;

function chooseLens(Z) {
  const entries = Object.entries(S.lens).sort((a, b) => a[1].ratio - b[1].ratio);
  let pick = entries[0];
  for (const e of entries) if (e[1].ratio <= Z * 1.02) pick = e;
  return pick ? pick[0] : null;
}
A.chooseLens = chooseLens;

/* ------------------------------------------------------------------ 串流 */

function stopStream() {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null; S.track = null; S.capture = null; S.photoCaps = null;
  video.srcObject = null;
}
A.stopStream = stopStream;

async function openPhotoStream(id) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { deviceId: id, width: { ideal: 1920 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } }, audio: false,
    });
  } catch (e) {
    return navigator.mediaDevices.getUserMedia({ video: { deviceId: id }, audio: false });
  }
}

A.startLens = async (key) => {
  const L = S.lens[key];
  if (!L) return false;
  stopStream();
  const id = { exact: L.dev.deviceId };
  const stream = S.mode === 'video' ? await A.openVideoStream(id) : await openPhotoStream(id);
  S.stream = stream;
  S.track = stream.getVideoTracks()[0];
  S.lensKey = key;
  video.srcObject = stream;
  try { await video.play(); } catch (e) { A.toast('預覽播放失敗:' + A.errMsg(e), 4000); }
  setTimeout(() => {
    if (S.track && video.readyState < 2) A.toast('相機沒有輸出畫面(#' + L.dev.id + '),可到設定改選其他鏡頭', 5000);
  }, 2500);
  S.caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
  if (window.ImageCapture && S.mode !== 'video') {
    try { S.capture = new ImageCapture(S.track); } catch (e) { S.capture = null; }
  }
  A.layoutFrame();
  await applyBaseControls();
  A.refreshReadouts();
  updateLensTag();
  A.updateRawChip();
  return true;
};
A.restartLens = () => A.startLens(S.lensKey);

async function applyBaseControls() {
  const adv = [];
  if (S.caps.focusMode && S.caps.focusMode.includes('continuous') && !S.focusManual) adv.push({ focusMode: 'continuous' });
  if (S.caps.exposureCompensation && !S.man.exp) adv.push({ exposureCompensation: S.ev });
  for (const c of adv) { try { await S.track.applyConstraints({ advanced: [c] }); } catch (e) { /* ignore */ } }
  if (S.man.exp) await applyManualExposure(true);
  if (S.focusManual && S.focusDist != null) await applyManualFocus(S.focusDist);
  if (S.lightMode === 'torch') await applyTorch(true);
  await A.applyHwWb();
  A.refreshLookPreview();
}

function updateLensTag() {
  const L = S.lens[S.lensKey];
  if (!L) { $('lensTag').textContent = '—'; return; }
  const eq = L.nativeId ? (L.native && L.native.equivMm) : L.dev.eq;
  const mm = eq ? ' ' + Math.round(eq) + 'mm' : '';
  $('lensTag').textContent = (S.front ? { wide: '前置廣角', main: '前置 1', tele: '前置 2' } : ROLE_LABEL)[S.lensKey] + mm + (L.nativeId ? ' · 原生#' + L.nativeId : '');
}

/* ------------------------------------------------------------------ 取景框比例與版面 */

const RATIO_ORDER = ['3:4', '1:1', '9:16', 'full'];
const RATIO_LABEL = { '3:4': '3:4', '1:1': '1:1', '9:16': '9:16', full: '全螢幕' };

A.layoutFrame = () => {
  const W = viewfinder.clientWidth, H = viewfinder.clientHeight;
  if (!W || !H) return;
  const topH = $('topbar').offsetHeight, botH = $('bottom').offsetHeight;
  const ratio = S.mode === 'video' ? 'full' : A.settings.ratio;
  let fw, fh, left, top, overlayUI = false;

  if (ratio === 'full') {
    fw = W; fh = H; left = 0; top = 0; overlayUI = true;
  } else if (ratio === '9:16') {
    fw = W; fh = W * 16 / 9;
    if (fh > H) { fh = H; fw = H * 9 / 16; }
    left = (W - fw) / 2; top = (H - fh) / 2; overlayUI = true;
  } else {
    const ar = ratio === '1:1' ? 1 : 3 / 4;
    fw = W; fh = W / ar;
    const avail = H - topH - botH;
    if (fh > avail) { fh = avail; fw = fh * ar; }
    left = (W - fw) / 2; top = topH + Math.max(0, (avail - fh) / 2);
  }
  frame.style.left = Math.round(left) + 'px';
  frame.style.top = Math.round(top) + 'px';
  frame.style.width = Math.round(fw) + 'px';
  frame.style.height = Math.round(fh) + 'px';
  S.frameAR = fw / fh;
  app.dataset.overlay = overlayUI ? '1' : '0';
  app.dataset.ratio = ratio;
  A.resizeOverlay();
};
new ResizeObserver(() => A.layoutFrame()).observe($('bottom'));
new ResizeObserver(() => A.layoutFrame()).observe($('topbar'));
window.addEventListener('resize', () => A.layoutFrame());

A.updateRatioChip = () => {
  $('btnRatio').textContent = S.mode === 'video' ? '影片' : RATIO_LABEL[A.settings.ratio];
  $('btnRatio').classList.toggle('on', A.settings.ratio !== '3:4' && S.mode !== 'video');
};
$('btnRatio').onclick = () => {
  if (S.mode === 'video') { A.toast('影片固定使用滿版取景'); return; }
  const i = RATIO_ORDER.indexOf(A.settings.ratio);
  A.settings.ratio = RATIO_ORDER[(i + 1) % RATIO_ORDER.length];
  A.saveSettings();
  A.updateRatioChip();
  A.layoutFrame();
  A.toast(A.settings.ratio === 'full' ? '全螢幕:影像滿版,介面疊在影像上'
    : A.settings.ratio === '9:16' ? '9:16:影像滿寬,介面疊在影像上' : '比例 ' + A.settings.ratio, 1800);
};

A.updateGrid = () => {
  $('gridLines').hidden = !A.settings.grid;
  $('btnGrid').classList.toggle('on', A.settings.grid);
};
$('btnGrid').onclick = () => { A.settings.grid = !A.settings.grid; A.saveSettings(); A.updateGrid(); };

/* 座標轉換:影像(0..1)↔ 取景框像素(含 object-fit: cover 與預覽縮放) */
A.vidToFrame = (u, v) => {
  const vw = video.videoWidth || 3, vh = video.videoHeight || 4;
  const w = frame.clientWidth, h = frame.clientHeight;
  const sc = Math.max(w / vw, h / vh);
  const dw = vw * sc, dh = vh * sc;
  let x = (w - dw) / 2 + u * dw, y = (h - dh) / 2 + v * dh;
  x = w / 2 + (x - w / 2) * S.cssZoom;
  y = h / 2 + (y - h / 2) * S.cssZoom;
  if (S.front) x = w - x;
  return [x, y];
};
A.frameToVid = (x, y) => {
  const vw = video.videoWidth || 3, vh = video.videoHeight || 4;
  const w = frame.clientWidth, h = frame.clientHeight;
  const sc = Math.max(w / vw, h / vh);
  const dw = vw * sc, dh = vh * sc;
  if (S.front) x = w - x;
  const px = w / 2 + (x - w / 2) / S.cssZoom, py = h / 2 + (y - h / 2) / S.cssZoom;
  return [clamp(((px - (w - dw) / 2) / dw), 0, 1), clamp(((py - (h - dh) / 2) / dh), 0, 1)];
};
A.resizeOverlay = () => {
  const c = $('overlay'), dpr = window.devicePixelRatio || 1;
  const w = Math.round(frame.clientWidth * dpr), h = Math.round(frame.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  if (A.redrawOverlay) A.redrawOverlay();
};

/* ------------------------------------------------------------------ 變焦 */

const zToSlider = (z) => 100 * Math.log(z / 0.5) / Math.log(20);
const sliderToZ = (v) => 0.5 * Math.pow(20, v / 100);

A.applyPreviewZoom = () => {
  const L = S.lens[S.lensKey];
  const ratio = L ? L.ratio : 1;
  const base = L && L.base ? L.base : ratio;       // 預覽畫面實際的光學倍率(虛擬望遠 = 主鏡頭 1×)
  S.within = Math.max(1, S.Z / ratio);              // 相對「拍攝鏡頭」的數位倍率(裁切用)
  const prevWithin = Math.max(1, S.Z / base);
  let css = prevWithin;
  if (S.recording && A.nativeVideoZoom) {
    A.nativeVideoZoom();
    css = 1;
  } else if (S.mode === 'video' && S.caps.zoom && S.track) {
    // 影片:用硬體變焦,錄下來的畫面才會跟著放大
    const z = clamp(prevWithin, S.caps.zoom.min, S.caps.zoom.max);
    S.track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
    css = Math.max(1, prevWithin / z);
  }
  S.cssZoom = css;
  video.style.transform = (S.front ? 'scaleX(-1) ' : '') + (css > 1.001 ? 'scale(' + css.toFixed(3) + ')' : '');
  const badge = $('zoomBadge');
  badge.textContent = S.Z.toFixed(S.Z < 10 ? 1 : 0) + '×';
  badge.classList.toggle('digital', S.within > 1.01);
  $('zoomRange').value = zToSlider(clamp(S.Z, 0.5, MAX_ZOOM));
  document.querySelectorAll('.lens-btn').forEach((b) => {
    b.classList.toggle('active', Math.abs(parseFloat(b.dataset.z) - S.Z) < 0.04);
  });
  if (A.redrawOverlay) A.redrawOverlay();
};

A.setZoom = async (Z, allowSwitch) => {
  Z = clamp(Z, minZoom(), MAX_ZOOM);
  S.Z = Z;
  if (allowSwitch && !S.switching && !A.busy && !S.recording) {
    const key = chooseLens(Z);
    if (key && key !== S.lensKey) {
      S.switching = true;
      const cur = S.lens[S.lensKey];
      if (cur && S.lens[key].dev === cur.dev && S.stream) {
        S.lensKey = key;            // 虛擬望遠與主鏡頭共用預覽,不必重開串流
        updateLensTag();
        A.updateRawChip();
      } else {
        try { await A.startLens(key); } catch (e) { A.toast('切換鏡頭失敗:' + A.errMsg(e)); }
      }
      S.switching = false;
    }
  }
  A.applyPreviewZoom();
};

A.renderLensButtons = () => {
  const row = $('lensRow');
  row.innerHTML = '';
  const ratios = lensRatios();
  const set = new Set([1, 2, 5, 10].concat(ratios));
  const presets = Array.from(set).filter((p) => p >= minZoom() - 0.001).sort((a, b) => a - b);
  presets.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'lens-btn';
    b.dataset.z = String(p);
    if (!ratios.some((r) => Math.abs(r - p) < 0.01)) b.classList.add('digital');
    b.textContent = (p < 1 ? p.toFixed(1) : String(p)) + (p < 1 ? '' : '×');
    b.onclick = () => A.setZoom(p, true);
    row.appendChild(b);
  });
  A.applyPreviewZoom();
};
A.minZoom = minZoom;

$('zoomRange').addEventListener('input', (e) => A.setZoom(sliderToZ(parseFloat(e.target.value)), false));
$('zoomRange').addEventListener('change', (e) => A.setZoom(sliderToZ(parseFloat(e.target.value)), true));

/* ------------------------------------------------------------------ 觸控:雙指縮放 + 點擊 */

const ptrs = new Map();
let pinch = null, tapInfo = null, pinchTarget = null;

viewfinder.addEventListener('pointerdown', (e) => {
  viewfinder.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) tapInfo = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  if (ptrs.size === 2) {
    const [a, b] = Array.from(ptrs.values());
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), Z: S.Z };
    tapInfo = null;
  }
});
viewfinder.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tapInfo && Math.hypot(e.clientX - tapInfo.x, e.clientY - tapInfo.y) > 12) tapInfo.moved = true;
  if (pinch && ptrs.size >= 2) {
    const [a, b] = Array.from(ptrs.values());
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    pinchTarget = clamp(pinch.Z * (d / pinch.d), minZoom(), MAX_ZOOM);
    A.setZoom(pinchTarget, false);
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (pinch && ptrs.size < 2) {
    pinch = null;
    A.setZoom(pinchTarget || S.Z, true);
  } else if (tapInfo && !tapInfo.moved && performance.now() - tapInfo.t < 400 && ptrs.size === 0) {
    A.onTap(tapInfo.x, tapInfo.y);
  }
  if (ptrs.size === 0) tapInfo = null;
}
viewfinder.addEventListener('pointerup', endPtr);
viewfinder.addEventListener('pointercancel', endPtr);

A.onTap = (cx, cy) => {
  const r = frame.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return;
  const x = cx - r.left, y = cy - r.top;
  if (S.pickGray) { pickGrayAt(x, y); return; }
  if (A.handleTap) A.handleTap(x, y); else A.focusAtFrame(x, y);
};

A.showReticle = (x, y) => {
  const ret = $('reticle');
  ret.style.left = x + 'px';
  ret.style.top = y + 'px';
  ret.classList.remove('show');
  void ret.offsetWidth;
  ret.classList.add('show');
};

/** 在取景框座標 (x,y) 對焦 */
A.focusAtFrame = (x, y, silent) => {
  if (!silent) A.showReticle(x, y);
  const [u, v] = A.frameToVid(x, y);
  A.focusAtVid(u, v);
};
let focusTimer;
A.focusAtVid = async (u, v) => {
  if (!S.track || S.focusManual) return;
  try { await S.track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: u, y: v }] }] }); } catch (e) { /* ignore */ }
  try { await S.track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }); } catch (e) { /* ignore */ }
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (!S.focusManual && !A.noContinuousAfter && S.track && S.caps.focusMode && S.caps.focusMode.includes('continuous')) {
      S.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
  }, 2500);
};

/* 灰點取樣(自訂白平衡) */
function pickGrayAt(x, y) {
  const cb = S.pickGray;
  S.pickGray = null;
  const [u, v] = A.frameToVid(x, y);
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const vw = video.videoWidth, vh = video.videoHeight;
  const sw = Math.max(8, Math.round(vw * 0.02)), sh = Math.max(8, Math.round(vh * 0.02));
  ctx.drawImage(video, clamp(u * vw - sw / 2, 0, vw - sw), clamp(v * vh - sh / 2, 0, vh - sh), sw, sh, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  A.showReticle(x, y);
  cb(A.grayGains(r / n, g / n, b / n));
}

/* ------------------------------------------------------------------ 閃光 / 補光 */

async function applyTorch(on) {
  if (!S.track || !S.caps.torch) return;
  try { await S.track.applyConstraints({ advanced: [{ torch: !!on }] }); } catch (e) { /* ignore */ }
}
$('btnLight').onclick = async () => {
  const order = ['off', 'flash', 'torch'];
  S.lightMode = order[(order.indexOf(S.lightMode) + 1) % order.length];
  $('btnLight').textContent = { off: '🚫', flash: '⚡', torch: '🔦' }[S.lightMode];
  await applyTorch(S.lightMode === 'torch');
  if (S.lightMode !== 'off' && !S.caps.torch) A.toast('此鏡頭不支援補光燈');
};

/* ------------------------------------------------------------------ 手動控制(快門 / ISO / EV / 對焦 / 白平衡 / 光圈) */

const logMap = (cap, s) => { const mn = Math.max(cap.min, 1e-3); return mn * Math.pow(cap.max / mn, s / 100); };
const logInv = (cap, v) => { const mn = Math.max(cap.min, 1e-3); return 100 * Math.log(Math.max(v, mn) / mn) / Math.log(cap.max / mn); };
const fmtShutter = (v) => {
  const sec = v * 1e-4; // exposureTime 以 100µs 為單位
  if (sec >= 0.5) return sec.toFixed(1) + '"';
  return '1/' + Math.round(1 / sec);
};

async function applyManualExposure(force) {
  if (!S.track || !S.caps.exposureTime) return false;
  const st = S.track.getSettings ? S.track.getSettings() : {};
  const et = S.caps.exposureTime, iso = S.caps.iso;
  if (S.man.t == null) S.man.t = st.exposureTime || Math.sqrt(Math.max(et.min, 1e-3) * et.max);
  if (S.man.iso == null && iso) S.man.iso = st.iso || iso.min;
  const c = { exposureMode: 'manual', exposureTime: clamp(S.man.t, et.min, et.max) };
  if (iso && S.man.iso != null) c.iso = clamp(S.man.iso, iso.min, iso.max);
  try { await S.track.applyConstraints({ advanced: [c] }); } catch (e) { /* ignore */ }
  const now = S.track.getSettings ? S.track.getSettings() : {};
  if (!force && now.exposureMode && now.exposureMode !== 'manual') {
    A.toast('此鏡頭不接受手動曝光');
    return false;
  }
  return true;
}
A.applyManualExposure = applyManualExposure;

async function setExposureAuto() {
  S.man.exp = false;
  if (!S.track) return;
  try { await S.track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] }); } catch (e) { /* ignore */ }
  if (S.caps.exposureCompensation) {
    try { await S.track.applyConstraints({ advanced: [{ exposureCompensation: S.ev }] }); } catch (e) { /* ignore */ }
  }
}

async function applyManualFocus(dist) {
  if (!S.track) return;
  S.focusManual = true; S.focusDist = dist;
  try { await S.track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: dist }] }); } catch (e) { /* ignore */ }
}
async function setFocusAuto() {
  S.focusManual = false; S.focusDist = null;
  if (!S.track) return;
  try { await S.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* ignore */ }
}

/* 參數定義 */
const PARAMS = {
  shutter: {
    label: '快門',
    ok: () => S.mode === 'manual' && !!S.caps.exposureTime,
    isAuto: () => !S.man.exp,
    cap: () => S.caps.exposureTime,
    toSlider: () => logInv(S.caps.exposureTime, S.man.t || S.caps.exposureTime.min),
    apply: async (s) => {
      S.man.exp = true; S.man.t = logMap(S.caps.exposureTime, s);
      await applyManualExposure();
      return fmtShutter(S.man.t);
    },
    text: () => (S.man.exp ? fmtShutter(S.man.t) : 'AUTO'),
    auto: setExposureAuto,
  },
  iso: {
    label: 'ISO',
    ok: () => S.mode === 'manual' && !!S.caps.iso,
    isAuto: () => !S.man.exp,
    cap: () => S.caps.iso,
    toSlider: () => logInv(S.caps.iso, S.man.iso || S.caps.iso.min),
    apply: async (s) => {
      S.man.exp = true; S.man.iso = Math.round(logMap(S.caps.iso, s));
      await applyManualExposure();
      return String(S.man.iso);
    },
    text: () => (S.man.exp && S.man.iso != null ? String(Math.round(S.man.iso)) : 'AUTO'),
    auto: setExposureAuto,
  },
  ev: {
    label: 'EV',
    ok: () => !!S.caps.exposureCompensation && !S.man.exp,
    isAuto: () => S.ev === 0,
    cap: () => S.caps.exposureCompensation,
    toSlider: () => { const c = S.caps.exposureCompensation; return 100 * (S.ev - c.min) / (c.max - c.min); },
    apply: async (s) => {
      const c = S.caps.exposureCompensation;
      let v = c.min + (c.max - c.min) * s / 100;
      if (c.step) v = Math.round(v / c.step) * c.step;
      S.ev = +v.toFixed(2);
      try { await S.track.applyConstraints({ advanced: [{ exposureCompensation: S.ev }] }); } catch (e) { /* ignore */ }
      return (S.ev > 0 ? '+' : '') + S.ev.toFixed(1);
    },
    text: () => (S.ev > 0 ? '+' : '') + S.ev.toFixed(1),
    auto: async () => {
      S.ev = 0;
      if (S.track && S.caps.exposureCompensation) {
        try { await S.track.applyConstraints({ advanced: [{ exposureCompensation: 0 }] }); } catch (e) { /* ignore */ }
      }
    },
  },
  focus: {
    label: '對焦',
    ok: () => S.mode === 'manual' && !!(S.caps.focusMode && S.caps.focusMode.includes('manual') && S.caps.focusDistance),
    isAuto: () => !S.focusManual,
    cap: () => S.caps.focusDistance,
    toSlider: () => {
      const c = S.caps.focusDistance;
      return S.focusDist == null ? 0 : 100 * (S.focusDist - c.min) / (c.max - c.min);
    },
    apply: async (s) => {
      const c = S.caps.focusDistance;
      const d = c.min + (c.max - c.min) * s / 100;
      await applyManualFocus(d);
      return d.toFixed(2) + 'm';
    },
    text: () => (S.focusManual && S.focusDist != null ? 'MF ' + S.focusDist.toFixed(2) : 'AF'),
    auto: setFocusAuto,
  },
};

let paramToken = 0;
function selectParam(name) {
  const row = $('paramRow');
  if (S.activeParam === name) { S.activeParam = null; row.hidden = true; A.refreshReadouts(); return; }
  const p = PARAMS[name];
  if (!p || !p.ok()) return;
  S.activeParam = name;
  row.hidden = false;
  $('paramLabel').textContent = p.label;
  const r = $('paramRange');
  r.value = p.toSlider();
  $('paramVal').textContent = p.text();
  $('paramAuto').classList.toggle('on', p.isAuto());
  A.refreshReadouts();
}

$('paramRange').addEventListener('input', async (e) => {
  const p = PARAMS[S.activeParam];
  if (!p) return;
  const my = ++paramToken;
  const txt = await p.apply(parseFloat(e.target.value));
  if (my !== paramToken) return;
  $('paramVal').textContent = txt;
  $('paramAuto').classList.remove('on');
  A.refreshReadouts();
});
$('paramAuto').onclick = async () => {
  const p = PARAMS[S.activeParam];
  if (!p) return;
  await p.auto();
  $('paramRange').value = p.toSlider();
  $('paramVal').textContent = p.text();
  $('paramAuto').classList.add('on');
  A.refreshReadouts();
};

document.querySelectorAll('#readouts .ro').forEach((b) => {
  b.onclick = () => {
    const n = b.dataset.p;
    if (n === 'wb') { A.openColorSheet(); return; }
    if (n === 'aperture') {
      const L = S.lens[S.lensKey];
      A.toast(L && L.dev.aperture
        ? '光圈固定 f/' + L.dev.aperture.toFixed(1) + '(此機型沒有開放第三方 App 調整光圈)'
        : '此鏡頭沒有回報光圈資訊', 3500);
      return;
    }
    const p = PARAMS[n];
    if (p && !p.ok()) {
      A.toast(S.mode !== 'manual' && n !== 'ev' ? '請切換到「手動」模式' : '此鏡頭不支援這項控制', 2200);
      return;
    }
    selectParam(n);
  };
});

A.refreshReadouts = () => {
  const set = (id, txt, auto, disabled, sel) => {
    const b = $(id); b.textContent = txt;
    const ro = b.closest('.ro');
    ro.classList.toggle('auto', !!auto);
    ro.classList.toggle('disabled', !!disabled);
    ro.classList.toggle('sel', !!sel);
  };
  const a = S.activeParam;
  set('roShutter', PARAMS.shutter.text(), !S.man.exp, !PARAMS.shutter.ok(), a === 'shutter');
  set('roIso', PARAMS.iso.text(), !S.man.exp, !PARAMS.iso.ok(), a === 'iso');
  set('roEv', PARAMS.ev.text(), S.ev === 0, !PARAMS.ev.ok(), a === 'ev');
  set('roWb', A.wbLabel(A.currentLook()), A.currentLook().wbMode === 'auto', false, false);
  const L = S.lens[S.lensKey];
  set('roAp', L && L.dev.aperture ? 'f/' + L.dev.aperture.toFixed(1) : '—', true, false, false);
  set('roFocus', PARAMS.focus.text(), !S.focusManual, !PARAMS.focus.ok(), a === 'focus');
  // 目前選取的參數若已不可用就收起
  if (a && !PARAMS[a].ok()) { S.activeParam = null; $('paramRow').hidden = true; }
};

/* ------------------------------------------------------------------ RAW / 原生拍攝 */

/** 目前鏡頭用 Camera2 拍攝時的鏡頭 ID 與 RAW 能力 */
A.nativeLensInfo = () => {
  const L = S.lens[S.lensKey];
  if (!L) return null;
  const nat = L.nativeId ? L.native : L.dev.native;
  return { id: L.nativeId || L.dev.id, virtual: !!L.nativeId, raw: !!(nat && nat.raw) };
};
A.updateRawChip = () => {
  const b = $('btnRaw');
  const info = A.nativeLensInfo();
  const show = S.mode === 'manual';
  b.hidden = !show;
  if (!show) return;
  const ok = !!(info && info.raw);
  b.classList.toggle('on', ok && A.settings.rawOn);
  b.classList.toggle('off', !ok);
  b.textContent = ok ? (A.settings.rawOn ? 'RAW 開' : 'RAW 關') : 'RAW ✕';
};
$('btnRaw').onclick = () => {
  const info = A.nativeLensInfo();
  if (!info || !info.raw) { A.toast('此鏡頭沒有回報 RAW 能力,無法拍 RAW', 3000); return; }
  A.settings.rawOn = !A.settings.rawOn;
  A.saveSettings();
  A.updateRawChip();
  A.toast(A.settings.rawOn
    ? 'RAW 已開:拍照時會暫停預覽、改用原生相機輸出 DNG' + (A.settings.rawJpeg ? '+JPEG' : '')
    : 'RAW 已關', 2800);
};

/* ------------------------------------------------------------------ 白平衡 / 色彩 → 預覽與硬體 */

A.applyHwWb = async () => {
  S.hwWb = false;
  if (!S.track) return;
  const look = A.currentLook();
  const wm = S.caps.whiteBalanceMode;
  try {
    if (look.wbMode === 'kelvin' && wm && wm.includes('manual') && S.caps.colorTemperature) {
      const c = S.caps.colorTemperature;
      await S.track.applyConstraints({ advanced: [{ whiteBalanceMode: 'manual', colorTemperature: clamp(look.kelvin, c.min, c.max) }] });
      const st = S.track.getSettings ? S.track.getSettings() : {};
      S.hwWb = st.whiteBalanceMode === 'manual';
    } else if (wm && wm.includes('continuous')) {
      await S.track.applyConstraints({ advanced: [{ whiteBalanceMode: 'continuous' }] });
    }
  } catch (e) { S.hwWb = false; }
};

A.refreshLookPreview = () => {
  A.updatePreviewFilter(A.lookParams(A.currentLook(), { skipWb: S.hwWb }));
};

/** 拍攝時要送給原生端的色彩參數(沒有調整 → null) */
A.captureLookParams = () => {
  if (!A.settings.applyOnCapture) return null;
  const p = A.lookParams(A.currentLook(), { skipWb: S.hwWb });
  return A.paramsNeutral(p) ? null : p;
};

let lookTimer;
document.addEventListener('lookchange', () => {
  A.refreshLookPreview();
  A.refreshReadouts();
  clearTimeout(lookTimer);
  lookTimer = setTimeout(async () => { await A.applyHwWb(); A.refreshLookPreview(); A.refreshReadouts(); }, 150);
});

/* ------------------------------------------------------------------ 模式切換 */

A.setMode = async (m) => {
  if (A.busy || S.recording || S.mode === m) return;
  const prev = S.mode;
  S.mode = m;
  app.dataset.mode = m;
  document.querySelectorAll('#modeTabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('videoOpts').hidden = m !== 'video';
  $('btnShutter').setAttribute('aria-label', m === 'video' ? '錄影' : '拍照');
  $('btnHdr').hidden = m === 'video';
  A.updateRatioChip();
  if (prev === 'manual' && m !== 'manual') {
    await setExposureAuto();
    await setFocusAuto();
    S.activeParam = null; $('paramRow').hidden = true;
  }
  if (m === 'video' || prev === 'video') {
    try { await A.restartLens(); } catch (e) { A.toast('切換模式失敗:' + A.errMsg(e), 4000); }
  } else {
    A.layoutFrame();
  }
  A.applyPreviewZoom();
  A.refreshReadouts();
  A.updateRawChip();
  if (A.syncVideoOpts) A.syncVideoOpts();
  if (m === 'manual' && !S.caps.exposureTime) A.toast('此鏡頭不開放手動快門/ISO,僅提供 EV 與對焦等可用項目', 4000);
};
document.querySelectorAll('#modeTabs button').forEach((b) => { b.onclick = () => A.setMode(b.dataset.mode); });

/* ------------------------------------------------------------------ 直方圖 */

const hist = $('hist');
const hctx = hist.getContext('2d');
const hcv = document.createElement('canvas');
hcv.width = 64; hcv.height = 48;
const hcx = hcv.getContext('2d', { willReadFrequently: true });
setInterval(() => {
  hist.hidden = !A.settings.histogram;
  if (!A.settings.histogram || document.hidden || !S.stream || video.readyState < 2 || S.recording) return;
  try {
    hcx.drawImage(video, 0, 0, 64, 48);
    const d = hcx.getImageData(0, 0, 64, 48).data;
    const bins = new Array(32).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      bins[((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 256 * 32) | 0]++;
    }
    const mx = Math.max(...bins) || 1;
    hctx.clearRect(0, 0, hist.width, hist.height);
    const bw = hist.width / 32;
    hctx.fillStyle = 'rgba(255,255,255,.8)';
    bins.forEach((v, i) => {
      const h = Math.max(1, (v / mx) * (hist.height - 6));
      hctx.fillRect(i * bw + 1, hist.height - h - 2, bw - 2, h);
    });
    // 過曝提示
    if (bins[31] / (64 * 48) > 0.04) { hctx.fillStyle = '#ff5577'; hctx.fillRect(hist.width - 5, 2, 3, 3); }
  } catch (e) { /* ignore */ }
}, 500);

/* 影像資訊列 */
setInterval(() => {
  if (!S.track) return;
  const st = S.track.getSettings ? S.track.getSettings() : {};
  const w = st.width || video.videoWidth, h = st.height || video.videoHeight;
  const fps = st.frameRate ? Math.round(st.frameRate) : 0;
  $('infoLine').textContent = (w && h ? w + '×' + h : '') + (fps && S.mode === 'video' ? ' · ' + fps + 'fps' : '');
}, 1500);
})();

/* ------------------------------------------------------------------ 前/後鏡頭切換 */
(() => {
  const S = A.S;
  const b = document.getElementById('btnFlip');
  b.onclick = async () => {
    if (A.busy || S.recording || S.switching) return;
    S.switching = true;
    const prev = S.front;
    S.front = !S.front;
    try {
      A.assignLenses();
      const key = S.lens.main ? 'main' : Object.keys(S.lens)[0];
      if (!key) throw new Error(S.front ? '找不到前鏡頭' : '找不到後鏡頭');
      S.Z = S.lens[key].ratio;
      S.ev = 0; S.man.exp = false; S.man.t = null; S.man.iso = null; S.focusManual = false; S.focusDist = null;
      b.classList.toggle('on', S.front);
      await A.startLens(key);
      A.applyPreviewZoom();
      A.toast(S.front ? '前鏡頭' + (S.lens.wide ? '(含廣角)' : '') : '後鏡頭', 1500);
    } catch (e) {
      S.front = prev;
      A.assignLenses();
      A.toast('切換失敗:' + A.errMsg(e), 4000);
      const key = S.lens.main ? 'main' : Object.keys(S.lens)[0];
      try { S.Z = S.lens[key].ratio; await A.startLens(key); A.applyPreviewZoom(); } catch (e2) { /* ignore */ }
    }
    S.switching = false;
  };
})();
