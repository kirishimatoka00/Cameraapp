/* 人臉偵測 / 自動人臉對焦 / 物體追焦 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;
const S = A.S;
const video = $('video');
const frame = $('frame');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

const MODES = ['single', 'face', 'track'];
const MODE_LABEL = { single: '點對焦', face: '人臉', track: '追焦' };

const V = {
  faces: [],            // {x,y,w,h,id} 正規化(影像座標)
  focusedFaceId: null,
  lastFaceFocus: 0,
  faceBusy: false,
  track: null,          // {u,v,tw,th,tpl,lost,lastFocus}
  trackFocusAt: 0,
};

/* ------------------------------------------------------------------ 繪製 */

A.redrawOverlay = () => {
  const dpr = window.devicePixelRatio || 1;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.scale(dpr, dpr);
  const mode = A.settings.focusAssist;
  if (mode === 'face' || (mode !== 'track' && A.settings.faceAuto)) drawFaces();
  if (mode === 'track' && V.track) drawTrack();
};

function bracket(x, y, w, h, color, lw) {
  const L = Math.min(w, h) * 0.28;
  octx.strokeStyle = color; octx.lineWidth = lw; octx.lineCap = 'round';
  octx.beginPath();
  octx.moveTo(x, y + L); octx.lineTo(x, y); octx.lineTo(x + L, y);
  octx.moveTo(x + w - L, y); octx.lineTo(x + w, y); octx.lineTo(x + w, y + L);
  octx.moveTo(x + w, y + h - L); octx.lineTo(x + w, y + h); octx.lineTo(x + w - L, y + h);
  octx.moveTo(x + L, y + h); octx.lineTo(x, y + h); octx.lineTo(x, y + h - L);
  octx.stroke();
}

function faceRect(f) {
  const [x1, y1] = A.vidToFrame(f.x, f.y);
  const [x2, y2] = A.vidToFrame(f.x + f.w, f.y + f.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function drawFaces() {
  V.faces.forEach((f) => {
    const r = faceRect(f);
    const focused = f.id === V.focusedFaceId;
    bracket(r.x, r.y, r.w, r.h, focused ? '#ffb02e' : 'rgba(255,255,255,.85)', focused ? 2.5 : 1.5);
  });
  if (V.faces.length) {
    octx.fillStyle = 'rgba(255,176,46,.95)';
    octx.font = '600 11px ui-monospace, monospace';
    octx.fillText('FACE ' + V.faces.length, 10, frame.clientHeight - 10 - (A.S.mode === 'video' ? 0 : 0));
  }
}

function drawTrack() {
  const t = V.track;
  const [cx, cy] = A.vidToFrame(t.u, t.v);
  const [x2] = A.vidToFrame(t.u + t.tw, t.v);
  const w = Math.max(36, Math.abs(x2 - cx));
  const color = t.lost ? '#ff5577' : '#ffb02e';
  bracket(cx - w / 2, cy - w / 2, w, w, color, 2.5);
  octx.fillStyle = color;
  octx.font = '600 11px ui-monospace, monospace';
  octx.fillText(t.lost ? 'LOST' : 'TRACK', cx - w / 2, cy - w / 2 - 6);
}

/* ------------------------------------------------------------------ 取樣小圖 */

const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });

function grabFrame(width, jpeg) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return null;
  const w = width, h = Math.round(width * vh / vw);
  if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
  gctx.drawImage(video, 0, 0, w, h);
  if (jpeg) return grab.toDataURL('image/jpeg', 0.6).split(',')[1];
  return gctx.getImageData(0, 0, w, h);
}

/* ------------------------------------------------------------------ 人臉偵測 */

async function faceTick() {
  const mode = A.settings.focusAssist;
  const want = mode === 'face' || (mode !== 'track' && A.settings.faceAuto);
  if (!want || !S.stream || document.hidden || V.faceBusy || A.busy) {
    if (!want && V.faces.length) { V.faces = []; A.redrawOverlay(); }
    return;
  }
  const data = grabFrame(320, true);
  if (!data) return;
  V.faceBusy = true;
  try {
    const res = await A.CT().detectFaces({ data, max: 10 });
    V.faces = (res && res.faces) || [];
  } catch (e) {
    V.faces = [];
  }
  V.faceBusy = false;
  if (!V.faces.some((f) => f.id === V.focusedFaceId)) V.focusedFaceId = null;
  autoFaceFocus();
  A.redrawOverlay();
}
setInterval(faceTick, 280);

function focusFace(f, show) {
  V.focusedFaceId = f.id;
  V.lastFaceFocus = performance.now();
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  if (show) { const [fx, fy] = A.vidToFrame(cx, cy); A.showReticle(fx, fy); }
  A.focusAtVid(cx, cy);
}

/** 沒有手動指定時,自動對最大的人臉對焦 */
let manualFaceUntil = 0;
function autoFaceFocus() {
  if (!A.settings.faceAuto && A.settings.focusAssist !== 'face') return;
  if (!V.faces.length || S.focusManual || S.recording === 'busy') return;
  const now = performance.now();
  if (now < manualFaceUntil) {
    // 使用者點選過某張臉:持續跟著該臉
    const f = V.faces.find((q) => q.id === V.focusedFaceId);
    if (f && now - V.lastFaceFocus > 900) focusFace(f, false);
    return;
  }
  const big = V.faces.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (big.id !== V.focusedFaceId || now - V.lastFaceFocus > 1500) focusFace(big, false);
}

/* ------------------------------------------------------------------ 物體追焦(樣板比對) */

const TW = 160; // 追焦分析寬度
let prevGray = null;

function toGray(img) {
  const n = img.width * img.height, g = new Uint8Array(n), d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

function startTrack(u, v) {
  const img = grabFrame(TW, false);
  if (!img) return;
  const gray = toGray(img);
  const T = 22; // 樣板邊長(像素,分析座標)
  const px = Math.round(u * img.width), py = Math.round(v * img.height);
  const x0 = A.clamp(px - T / 2, 0, img.width - T), y0 = A.clamp(py - T / 2, 0, img.height - T);
  const tpl = new Uint8Array(T * T);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) tpl[y * T + x] = gray[(y0 + y) * img.width + x0 + x];
  V.track = {
    cx: x0 + T / 2, cy: y0 + T / 2, T, tpl, lost: false, lostCount: 0,
    W: img.width, H: img.height,
    u: (x0 + T / 2) / img.width, v: (y0 + T / 2) / img.height, tw: T / img.width, th: T / img.height,
    lastFocusU: u, lastFocusV: v,
  };
  A.focusAtVid(V.track.u, V.track.v);
  V.trackFocusAt = performance.now();
  A.redrawOverlay();
}

function stopTrack() { V.track = null; A.redrawOverlay(); }
A.stopTrack = stopTrack;

function trackTick() {
  const t = V.track;
  if (!t || A.settings.focusAssist !== 'track' || !S.stream || document.hidden) return;
  const img = grabFrame(TW, false);
  if (!img) return;
  if (img.width !== t.W || img.height !== t.H) { stopTrack(); return; }
  const g = toGray(img), T = t.T, W = img.width, H = img.height;
  const R = 14; // 搜尋半徑
  const bx0 = Math.round(t.cx - T / 2), by0 = Math.round(t.cy - T / 2);
  let best = 1e9, bxx = bx0, byy = by0;
  for (let dy = -R; dy <= R; dy += 1) {
    const y0 = by0 + dy;
    if (y0 < 0 || y0 + T > H) continue;
    for (let dx = -R; dx <= R; dx += 1) {
      const x0 = bx0 + dx;
      if (x0 < 0 || x0 + T > W) continue;
      let sad = 0;
      for (let y = 0; y < T && sad < best; y += 2) {
        const ro = (y0 + y) * W + x0, to = y * T;
        for (let x = 0; x < T; x += 2) sad += Math.abs(g[ro + x] - t.tpl[to + x]);
      }
      if (sad < best) { best = sad; bxx = x0; byy = y0; }
    }
  }
  const per = best / ((T / 2) * (T / 2));       // 每取樣點平均差
  if (per > 38) {
    t.lostCount++;
    if (t.lostCount > 8) t.lost = true;
  } else {
    t.lostCount = 0; t.lost = false;
    t.cx = bxx + T / 2; t.cy = byy + T / 2;
    // 緩慢更新樣板以適應外觀變化
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const o = y * T + x;
      t.tpl[o] = (t.tpl[o] * 7 + g[(byy + y) * W + bxx + x]) >> 3;
    }
    t.u = t.cx / W; t.v = t.cy / H;
    const moved = Math.hypot(t.u - t.lastFocusU, t.v - t.lastFocusV);
    const now = performance.now();
    if ((moved > 0.04 && now - V.trackFocusAt > 350) || now - V.trackFocusAt > 2500) {
      t.lastFocusU = t.u; t.lastFocusV = t.v; V.trackFocusAt = now;
      A.noContinuousAfter = false;
      A.focusAtVid(t.u, t.v);
    }
  }
  A.redrawOverlay();
}
setInterval(trackTick, 90);

/* ------------------------------------------------------------------ 點擊與模式 */

A.handleTap = (x, y) => {
  const mode = A.settings.focusAssist;
  const [u, v] = A.frameToVid(x, y);
  if (mode === 'track') {
    A.showReticle(x, y);
    startTrack(u, v);
    return;
  }
  if (mode === 'face' || A.settings.faceAuto) {
    // 命中人臉 → 對該臉對焦並鎖定
    const hit = V.faces.find((f) => u >= f.x - 0.02 && u <= f.x + f.w + 0.02 && v >= f.y - 0.02 && v <= f.y + f.h + 0.02);
    if (hit) {
      manualFaceUntil = performance.now() + 12000;
      focusFace(hit, true);
      A.redrawOverlay();
      return;
    }
  }
  manualFaceUntil = 0;
  A.focusAtFrame(x, y);
};

A.updateFocusChip = () => {
  const m = A.settings.focusAssist;
  const b = $('btnFocusAssist');
  b.textContent = MODE_LABEL[m];
  b.classList.toggle('on', m !== 'single');
};

$('btnFocusAssist').onclick = () => {
  const i = MODES.indexOf(A.settings.focusAssist);
  const next = MODES[(i + 1) % MODES.length];
  A.settings.focusAssist = next;
  A.saveSettings();
  if (next !== 'track') stopTrack();
  if (next !== 'face') { V.focusedFaceId = null; manualFaceUntil = 0; }
  A.updateFocusChip();
  A.toast(next === 'face' ? '人臉偵測:最多 10 張,點臉可指定對焦'
    : next === 'track' ? '追焦:點擊畫面中的物體後會持續追蹤對焦'
    : '點擊畫面對焦', 2200);
  A.redrawOverlay();
};

A.vision = V;
})();
