/* 相簿(瀏覽/多選刪除)與檢視器(縮放/原生像素分塊載入) */
(() => {
'use strict';
const A = window.A;
const $ = A.$;
const { clamp } = A;

const G = A.gallery = { items: [], sel: new Set(), selMode: false };

/* ------------------------------------------------------------------ 縮圖載入佇列 */

const thumbCache = new Map();
const pending = [];
let running = 0;
function pump() {
  while (running < 3 && pending.length) {
    const job = pending.shift();
    running++;
    A.needNative().readThumb({ uri: job.uri, size: 256 })
      .then((r) => job.ok('data:image/jpeg;base64,' + r.data))
      .catch(() => job.ok(''))
      .finally(() => { running--; pump(); });
  }
}
function loadThumb(uri) {
  if (thumbCache.has(uri)) return Promise.resolve(thumbCache.get(uri));
  return new Promise((ok) => {
    pending.push({ uri, ok: (v) => { if (thumbCache.size > 400) thumbCache.clear(); thumbCache.set(uri, v); ok(v); } });
    pump();
  });
}
const io = new IntersectionObserver((ents) => {
  ents.forEach((en) => {
    if (!en.isIntersecting) return;
    const img = en.target;
    io.unobserve(img);
    loadThumb(img.dataset.uri).then((src) => { if (src) img.src = src; });
  });
}, { root: $('gridWrap'), rootMargin: '300px' });

/* ------------------------------------------------------------------ 列表 */

const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

async function reload() {
  try {
    const r = await A.needNative().listRecent({ limit: 500 });
    G.items = r.items || [];
  } catch (e) { G.items = []; A.toast('讀取相簿失敗:' + A.errMsg(e), 4000); }
  render();
}

function updateSelUi() {
  $('gSelBar').hidden = !G.selMode;
  $('gSelect').textContent = G.selMode ? '取消' : '選取';
  $('gCount').textContent = '已選 ' + G.sel.size;
  $('gTitle').textContent = '相簿' + (G.items.length ? '(' + G.items.length + ')' : '');
  $('grid').classList.toggle('sel-mode', G.selMode);
}

function render() {
  const grid = $('grid');
  grid.innerHTML = '';
  $('gEmpty').hidden = G.items.length > 0;
  const frag = document.createDocumentFragment();
  G.items.forEach((it) => {
    const c = document.createElement('div');
    c.className = 'cell' + (G.sel.has(it.uri) ? ' picked' : '');
    const img = document.createElement('img');
    img.dataset.uri = it.uri; img.alt = ''; img.decoding = 'async';
    c.appendChild(img);
    if (it.type === 'video') {
      const b = document.createElement('span');
      b.className = 'badge'; b.textContent = '▶ ' + fmtDur(it.duration);
      c.appendChild(b);
    }
    const ck = document.createElement('span');
    ck.className = 'check'; ck.textContent = '✓';
    c.appendChild(ck);
    c.onclick = () => {
      if (G.selMode) {
        if (G.sel.has(it.uri)) G.sel.delete(it.uri); else G.sel.add(it.uri);
        c.classList.toggle('picked', G.sel.has(it.uri));
        updateSelUi();
      } else A.showViewerUri(it.uri);
    };
    let lp = null;
    c.addEventListener('pointerdown', () => {
      lp = setTimeout(() => {
        lp = null;
        if (!G.selMode) { G.selMode = true; }
        G.sel.add(it.uri); c.classList.add('picked'); updateSelUi();
      }, 480);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach((ev) => c.addEventListener(ev, () => { if (lp) { clearTimeout(lp); lp = null; } }));
    frag.appendChild(c);
    io.observe(img);
  });
  grid.appendChild(frag);
  updateSelUi();
}

A.openGallery = async () => {
  G.selMode = false; G.sel.clear();
  A.openOverlay($('gallery'));
  await reload();
};
$('btnThumb').onclick = () => A.openGallery();
$('gBack').onclick = () => A.closeOverlay($('gallery'));
$('gSelect').onclick = () => { G.selMode = !G.selMode; G.sel.clear(); render(); };
$('gAll').onclick = () => {
  if (G.sel.size === G.items.length) G.sel.clear(); else G.items.forEach((i) => G.sel.add(i.uri));
  render();
};

async function deleteUris(uris) {
  if (!uris.length) return false;
  if (!confirm('確定刪除 ' + uris.length + ' 個檔案?此動作無法復原。')) return false;
  try {
    const r = await A.needNative().deleteImages({ uris });
    A.toast('已刪除 ' + r.deleted + ' 個' + (r.failed ? ',' + r.failed + ' 個失敗' : ''), 2500);
    uris.forEach((u) => thumbCache.delete(u));
    return true;
  } catch (e) { A.toast('刪除失敗:' + A.errMsg(e), 5000); return false; }
}
$('gDelete').onclick = async () => {
  if (!G.sel.size) { A.toast('請先選取要刪除的項目'); return; }
  if (await deleteUris(Array.from(G.sel))) {
    G.sel.clear(); G.selMode = false;
    await reload(); A.refreshThumb();
  }
};
document.addEventListener('overlayclose', (e) => { if (e.target && e.target.id === 'gallery') { G.selMode = false; G.sel.clear(); } });

/* ------------------------------------------------------------------ 檢視器 */

const V = {
  uri: null, item: null, w: 1, h: 1, fw: 0, fh: 0, vw: 0, vh: 0, s: 1, tx: 0, ty: 0, max: 8,
  ptrs: new Map(), pinch: null, seq: 0, timer: null, tap: null, lastTap: 0, mp: 0, isVideo: false,
};
const vStage = $('vStage'), vContent = $('vContent'), vTile = $('vTile');

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
  vContent.style.width = fw + 'px'; vContent.style.height = fh + 'px';
  V.max = Math.max(8, (V.w / fw) * 3);
  V.s = 1; V.tx = (V.vw - fw) / 2; V.ty = (V.vh - fh) / 2;
  vTile.hidden = true;
  vApply();
}
function vZoomAt(px, py, ns) {
  ns = clamp(ns, 1, V.max);
  const k = ns / V.s;
  V.tx = px - (px - V.tx) * k; V.ty = py - (py - V.ty) * k; V.s = ns;
  vApply();
}
function vSchedule() { clearTimeout(V.timer); V.timer = setTimeout(vLoadTile, 260); }
async function vLoadTile() {
  if (V.isVideo || V.s < 1.25) { vTile.hidden = true; return; }
  const my = ++V.seq;
  const x0 = clamp(-V.tx / V.s, 0, V.fw), y0 = clamp(-V.ty / V.s, 0, V.fh);
  const x1 = clamp((V.vw - V.tx) / V.s, 0, V.fw), y1 = clamp((V.vh - V.ty) / V.s, 0, V.fh);
  if (x1 - x0 < 2 || y1 - y0 < 2) return;
  const outMax = Math.min(2400, Math.ceil(Math.max(V.vw, V.vh) * (window.devicePixelRatio || 1)));
  try {
    const r = await A.needNative().readRegion({ uri: V.uri, x0: x0 / V.fw, y0: y0 / V.fh, x1: x1 / V.fw, y1: y1 / V.fh, outMax });
    if (my !== V.seq) return;
    vTile.src = 'data:image/jpeg;base64,' + r.data;
    vTile.style.left = (r.x0 * 100) + '%'; vTile.style.top = (r.y0 * 100) + '%';
    vTile.style.width = ((r.x1 - r.x0) * 100) + '%'; vTile.style.height = ((r.y1 - r.y0) * 100) + '%';
    vTile.hidden = false;
  } catch (e) { /* ignore */ }
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
    vZoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, V.pinch.s * (d / V.pinch.d));
  } else if (V.ptrs.size === 1) { V.tx += dx; V.ty += dy; vApply(); }
});
function vEnd(e) {
  if (!V.ptrs.has(e.pointerId)) return;
  V.ptrs.delete(e.pointerId);
  const rect = vStage.getBoundingClientRect();
  if (V.tap && !V.tap.moved && performance.now() - V.tap.t < 300) {
    const now = performance.now();
    if (now - V.lastTap < 320) {
      if (V.s > 1.5) { V.s = 1; V.tx = (V.vw - V.fw) / 2; V.ty = (V.vh - V.fh) / 2; vApply(); }
      else vZoomAt(V.tap.x - rect.left, V.tap.y - rect.top, Math.min(4, V.max));
      V.lastTap = 0;
    } else V.lastTap = now;
  }
  if (V.ptrs.size < 2) V.pinch = null;
  if (V.ptrs.size === 0) { V.tap = null; vSchedule(); }
}
vStage.addEventListener('pointerup', vEnd);
vStage.addEventListener('pointercancel', vEnd);

A.showViewerUri = async (uri) => {
  if (!G.items.some((g) => g.uri === uri)) {
    try { const r = await A.needNative().listRecent({ limit: 500 }); G.items = r.items || []; } catch (e) { /* ignore */ }
  }
  A.closeOverlay($('editor'));
  if ($('viewer').hidden) A.openOverlay($('viewer'));
  const item = G.items.find((g) => g.uri === uri) || null;
  V.uri = uri; V.item = item; V.isVideo = !!(item && item.type === 'video');
  $('vInfo').textContent = '載入中…';
  vTile.hidden = true;
  $('vPlay').hidden = !V.isVideo;
  ['vEdit', 'vUpscale', 'vGemini'].forEach((id) => { $(id).hidden = V.isVideo; });
  $('vHint').style.opacity = V.isVideo ? 0 : 1;
  setTimeout(() => { $('vHint').style.opacity = 0; }, 4000);
  $('vInfo').style.whiteSpace = 'pre-line';
  try {
    if (V.isVideo) {
      const r = await A.needNative().readThumb({ uri, size: 1024 });
      if (V.uri !== uri) return;
      $('vBase').src = 'data:image/jpeg;base64,' + r.data;
      await new Promise((ok) => { $('vBase').onload = ok; setTimeout(ok, 400); });
      V.w = $('vBase').naturalWidth || item.width || 16; V.h = $('vBase').naturalHeight || item.height || 9;
      vLayout();
      $('vInfo').textContent = item.name + '\n' + (item.width || '?') + '×' + (item.height || '?') + ' · ' + fmtDur(item.duration);
      return;
    }
    const r = await A.needNative().readImage({ uri, maxDim: 2048, quality: 88 });
    if (V.uri !== uri) return;
    V.w = r.width; V.h = r.height; V.mp = r.megapixels;
    $('vBase').src = 'data:image/jpeg;base64,' + r.data;
    vLayout();
    $('vInfo').textContent = (item ? item.name : '') + '\n' + r.width + '×' + r.height + ' · ' + r.megapixels.toFixed(1) + ' MP';
    $('vUpscale').disabled = r.megapixels >= A.settings.targetMP * 0.98;
  } catch (e) { A.toast('無法開啟:' + A.errMsg(e)); }
};

function vStep(delta) {
  const i = G.items.findIndex((g) => g.uri === V.uri);
  if (i < 0) return;
  const n = G.items[i + delta];
  if (n) A.showViewerUri(n.uri); else A.toast(delta > 0 ? '已是最舊的一張' : '已是最新的一張', 1500);
}
$('vPrev').onclick = () => vStep(1);
$('vNext').onclick = () => vStep(-1);
$('vClose').onclick = () => A.closeOverlay($('viewer'));
$('vPlay').onclick = async () => {
  try { await A.needNative().openExternal({ uri: V.uri, mime: (V.item && V.item.mime) || 'video/*' }); }
  catch (e) { A.toast('無法開啟播放器:' + A.errMsg(e)); }
};
$('vEdit').onclick = () => { if (!V.isVideo && A.openEditor) A.openEditor(V.uri); };

$('vUpscale').onclick = async () => {
  if (A.busy) return;
  A.busy = true;
  try { await A.runUpscale(V.uri); } catch (e) { A.toast('放大失敗:' + A.errMsg(e), 5000); } finally { A.hudHide(); A.busy = false; }
};
$('vGemini').onclick = async () => {
  if (A.busy) return;
  A.busy = true;
  try { await A.runGemini(V.uri, false); } catch (e) { A.toast('Gemini 回推失敗:' + A.errMsg(e), 7000); } finally { A.hudHide(); A.busy = false; }
};
$('vDelete').onclick = async () => {
  const uri = V.uri;
  const i = G.items.findIndex((g) => g.uri === uri);
  if (!(await deleteUris([uri]))) return;
  G.items = G.items.filter((g) => g.uri !== uri);
  A.refreshThumb();
  const next = G.items[i] || G.items[i - 1];
  if (next) A.showViewerUri(next.uri);
  else { A.closeOverlay($('viewer')); render(); }
};
document.addEventListener('overlayclose', (e) => {
  if (e.target && e.target.id === 'viewer' && !$('gallery').hidden) reload();
});
})();
