/* 照片編輯:畫質提升 / 角度與變形 / 色彩 / 物件橡皮擦 / AI 強化 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;

const E = { uri: null, origUri: null, look: null, base: null, neutral: null, w: 0, h: 0, ctrl: null, pick: null, raf: 0,
  raw: false, devKey: '', devTimer: 0, devBusy: false, enhSt: null, dn: null, dnKey: '', dnTimer: 0,
  geo: A.geoZero(), tool: null, brush: 10, undo: [], dirtyMask: false, erased: false };
const cv = $('eCanvas');
const ctx = cv.getContext('2d', { willReadFrequently: true });
const mk = $('eMask');
const mctx = mk.getContext('2d', { willReadFrequently: true });
const wrap = $('eWrap');
const stage = $('eStage');
const tmpc = document.createElement('canvas');
const tctx = tmpc.getContext('2d', { willReadFrequently: true });

/** 讓畫布以「完整顯示」的大小置於舞台 */
function fit() {
  const cw = cv.width || 4, ch = cv.height || 3;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) return;
  const k = Math.min(sw / cw, sh / ch);
  wrap.style.width = Math.round(cw * k) + 'px';
  wrap.style.height = Math.round(ch * k) + 'px';
  zmApply();
}
function setCv(w, h) {
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; fit(); }
}

function render() {
  E.raf = 0;
  if (!E.base) return;
  const img = new ImageData(new Uint8ClampedArray(dnBase().data), E.w, E.h);
  let p = A.lookParams(E.look);
  // RAW:EV 與白平衡增益已在原生端於線性空間處理,這裡只做其餘調整
  if (E.raw) p = Object.assign({}, p, { ev: 0, gains: [1, 1, 1] });
  A.processPixels(img.data, p);
  if (p.detail > 0) A.unsharp(img.data, E.w, E.h, A.detailAmount(p.detail), A.detailRadius(E.w, E.h));
  const en = enhNow();
  if (en.sharp > 0) A.sharpenRGBA(img.data, E.w, E.h, en.sharp);
  const useGeo = E.tool !== 'erase' && !E.pick && !A.geoNeutral(E.geo);
  if (useGeo) {
    const o = A.geoApply(img, E.geo);
    setCv(o.w, o.h);
    ctx.putImageData(o.img, 0, 0);
  } else {
    setCv(E.w, E.h);
    ctx.putImageData(img, 0, 0);
  }
  mk.style.display = useGeo ? 'none' : '';
}

const enhNow = () => A.enhEff(E.enhSt);
/** 降噪後的底圖(有快取;參數變動時延遲重算,預覽為近似效果) */
function dnBase() {
  const en = enhNow();
  if (!(en.dnL > 0 || en.dnC > 0 || en.dnS > 0)) return E.base;
  const key = en.dnL + '|' + en.dnC + '|' + en.dnS;
  if (E.dn && E.dnKey === key) return E.dn;
  return E.dn || E.base;
}
function scheduleDn() {
  clearTimeout(E.dnTimer);
  E.dnTimer = setTimeout(() => {
    if (!E.base) return;
    const en = enhNow();
    if (en.dnL > 0 || en.dnC > 0 || en.dnS > 0) {
      const key = en.dnL + '|' + en.dnC + '|' + en.dnS;
      if (E.dnKey !== key) {
        const d = new ImageData(new Uint8ClampedArray(E.base.data), E.w, E.h);
        A.denoiseRGBA(d.data, E.w, E.h, en.dnL, en.dnC, en.dnS);
        E.dn = d; E.dnKey = key;
      }
    }
    schedule();
  }, 180);
}
function schedule() {
  if (!E.raf) E.raf = requestAnimationFrame(render);
  if (E.raw) { clearTimeout(E.devTimer); E.devTimer = setTimeout(redevelop, 220); }
}

const devKeyOf = () => { const p = A.lookParams(E.look); return p.ev + '|' + p.gains.join(','); };

async function redevelop() {
  if (!E.raw || !E.base) return;
  if (E.devBusy) { E.devTimer = setTimeout(redevelop, 120); return; }
  const key = devKeyOf();
  if (key === E.devKey) return;
  E.devBusy = true;
  try {
    const p = A.lookParams(E.look);
    const r = await A.needNative().developRaw({ uri: E.uri, maxDim: 1600, ev: p.ev, gains: p.gains });
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('解碼失敗')); img.src = 'data:image/jpeg;base64,' + r.data; });
    if (!E.raw || !E.base) return;
    tctx.drawImage(img, 0, 0, E.w, E.h);
    E.base = tctx.getImageData(0, 0, E.w, E.h);
    E.dn = null; E.dnKey = '';
    E.devKey = key;
    render();
  } catch (e) { A.toast('RAW 顯影失敗:' + A.errMsg(e), 3000); }
  finally { E.devBusy = false; }
  if (devKeyOf() !== E.devKey) E.devTimer = setTimeout(redevelop, 60);
}


/* ------------------------------------------------------------------ 工具面板 */

const row = (name, min, max, step, get, set, fmt) => {
  const r = document.createElement('div');
  r.className = 'look-ctrl';
  r.innerHTML = `<div class="row"><span class="n" style="width:70px">${name}</span><input type="range" min="${min}" max="${max}" step="${step}"><span class="v"></span></div>`;
  const inp = r.querySelector('input'), val = r.querySelector('.v');
  const f = fmt || ((v) => String(Math.round(v)));
  inp.value = get(); val.textContent = f(+inp.value);
  inp.oninput = () => { set(parseFloat(inp.value)); val.textContent = f(+inp.value); };
  r.refresh = () => { inp.value = get(); val.textContent = f(+inp.value); };
  return r;
};
const btn = (txt, cls, fn) => { const b = document.createElement('button'); b.className = cls; b.textContent = txt; b.onclick = fn; return b; };

function toolQuality(p) {
  const box = document.createElement('div');
  p.appendChild(box);
  A.buildEnhPanel(box, E.enhSt, { toggleLabel: '套用畫質提升', showBurst: false, showHal: false, showNN: true, onChange: () => { scheduleDn(); schedule(); } });
  const n = document.createElement('p');
  n.className = 'note';
  n.textContent = '預覽的降噪為縮圖近似效果;儲存時以原始解析度處理。AI 放大只適用 ≤2.5MP 的影像,輸出約 2 倍邊長。';
  p.appendChild(n);
}

function toolGeo(p) {
  const g = E.geo;
  const sl = [
    row('角度', -45, 45, 0.1, () => g.angle, (v) => { g.angle = v; schedule(); }, (v) => v.toFixed(1) + '°'),
    row('垂直變形', -100, 100, 1, () => g.pv, (v) => { g.pv = v; schedule(); }),
    row('水平變形', -100, 100, 1, () => g.ph, (v) => { g.ph = v; schedule(); }),
  ];
  sl.forEach((r) => p.appendChild(r));
  const b = document.createElement('div');
  b.className = 'wb-row';
  b.appendChild(btn('⟳ 旋轉 90°', 'mini', () => { g.rot = (g.rot + 1) & 3; fit(); schedule(); }));
  b.appendChild(btn('⇋ 水平翻轉', 'mini', () => { g.flip = !g.flip; schedule(); }));
  b.appendChild(btn('重設變形', 'mini', () => { Object.assign(g, A.geoZero()); sl.forEach((r) => r.refresh()); fit(); schedule(); }));
  p.appendChild(b);
  const n = document.createElement('p');
  n.className = 'note';
  n.textContent = '畫面會自動放大裁掉空白邊角。角度可用格線對齊水平線;垂直/水平變形用來修正仰拍或側拍造成的梯形。';
  p.appendChild(n);
}

function toolColor(p) {
  const prof = document.createElement('div');
  prof.className = 'k-row';
  prof.innerHTML = '<div style="margin-bottom:6px">色彩檔案</div>';
  const chips = document.createElement('div');
  chips.className = 'wb-row';
  prof.appendChild(chips);
  p.appendChild(prof);
  const ctrlBox = document.createElement('div');
  p.appendChild(ctrlBox);
  const fillChips = () => {
    chips.innerHTML = '';
    A.allProfiles().forEach((pr) => {
      chips.appendChild(btn(pr.name, 'mini', () => { E.look = A.cloneLook(pr.look); E.ctrl.refresh(); schedule(); }));
    });
  };
  fillChips();
  E.ctrl = A.buildLookControls(ctrlBox, {
    get: () => A.cloneLook(E.look),
    set: (l) => { E.look = A.cloneLook(l); schedule(); },
    pickGray: (cb) => { E.pick = cb; $('ePickHint').hidden = false; schedule(); },
  });
  const r = document.createElement('div');
  r.className = 'wb-row';
  r.appendChild(btn('存成色彩檔案', 'mini', () => {
    const name = prompt('色彩檔案名稱');
    if (!name || !name.trim()) return;
    A.saveCustomProfile(name.trim(), E.look);
    fillChips();
    if (A.updateProfileChip) A.updateProfileChip();
    A.toast('已儲存色彩檔案「' + name.trim() + '」');
  }));
  p.appendChild(r);
}

function toolErase(p) {
  p.appendChild(row('筆刷大小', 1, 40, 1, () => E.brush, (v) => { E.brush = v; }));
  const b = document.createElement('div');
  b.className = 'wb-row';
  b.appendChild(btn('↶ 復原一筆', 'mini', undoStroke));
  b.appendChild(btn('清除塗抹', 'mini', clearMask));
  p.appendChild(b);
  const go = document.createElement('div');
  go.className = 'editor-actions';
  go.appendChild(btn('✨ AI 移除(Gemini)', 'act accent', () => runErase('ai')));
  go.appendChild(btn('⚡ 快速移除(本機)', 'act', () => runErase('local')));
  p.appendChild(go);
  const n = document.createElement('p');
  n.className = 'note';
  n.textContent = '用手指塗滿要移除的物件(塗到邊緣外一點更好),兩指可縮放與移動畫面。AI 移除效果最自然,需要 Gemini API key 與網路;快速移除在手機本機以周圍紋理補洞,適合小物件與單純背景。移除後會另存成新照片,編輯會接著套用在新照片上。';
  p.appendChild(n);
}

function toolAi(p) {
  const n = document.createElement('p');
  n.className = 'note';
  n.textContent = '把目前的調整套用後,送 Gemini 做整體畫質強化(提示詞可在設定頁修改)。';
  p.appendChild(n);
  p.appendChild(btn('✨ AI 強化(Gemini)', 'act accent', aiEnhance));
}

const TOOLS = { quality: toolQuality, geo: toolGeo, color: toolColor, erase: toolErase, ai: toolAi };

function openTool(name) {
  const panel = $('ePanel');
  const was = E.tool;
  E.tool = name === was ? null : name;
  document.querySelectorAll('#eTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === E.tool));
  panel.innerHTML = '';
  panel.hidden = !E.tool;
  if (E.tool) TOOLS[E.tool](panel);
  $('eGrid').hidden = E.tool !== 'geo';
  if (E.tool !== 'erase') $('eRing').hidden = true;
  requestAnimationFrame(() => { fit(); schedule(); });
}
document.querySelectorAll('#eTabs button').forEach((b) => { b.onclick = () => openTool(b.dataset.t); });
if (window.ResizeObserver) new ResizeObserver(() => fit()).observe(stage);

/* ------------------------------------------------------------------ 橡皮擦遮罩 */

function clearMask() { mctx.clearRect(0, 0, mk.width, mk.height); E.undo = []; E.dirtyMask = false; }
function undoStroke() {
  const s = E.undo.pop();
  if (!s) { return; }
  mctx.putImageData(s, 0, 0);
  E.dirtyMask = E.undo.length > 0;
}
const toMask = (e) => {
  const r = wrap.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * mk.width, y: (e.clientY - r.top) / r.height * mk.height };
};
function brushPx() { return Math.max(2, E.brush * Math.max(E.w, E.h) / 800); }
let paint = null;
function strokeTo(pt) {
  mctx.strokeStyle = 'rgba(255,60,80,0.55)';
  mctx.fillStyle = 'rgba(255,60,80,0.55)';
  mctx.lineWidth = brushPx() * 2;
  mctx.lineCap = 'round'; mctx.lineJoin = 'round';
  mctx.beginPath(); mctx.moveTo(paint.x, paint.y); mctx.lineTo(pt.x, pt.y); mctx.stroke();
  paint = pt;
}
function beginStroke(e) {
  E.undo.push(mctx.getImageData(0, 0, mk.width, mk.height));
  if (E.undo.length > 6) E.undo.shift();
  paint = toMask(e);
  strokeTo({ x: paint.x + 0.01, y: paint.y });
  E.dirtyMask = true;
}
function moveRing(e) {
  const ring = $('eRing');
  if (E.tool !== 'erase') { ring.hidden = true; return; }
  const r = stage.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const d = brushPx() * 2 * (wr.width / mk.width);
  ring.style.width = ring.style.height = d + 'px';
  ring.style.left = (e.clientX - r.left) + 'px';
  ring.style.top = (e.clientY - r.top) + 'px';
  ring.hidden = false;
}

async function runErase(mode) {
  if (A.busy || !E.base) return;
  if (E.raw) { A.toast('RAW 請先儲存一次(轉成 JPEG)再使用橡皮擦', 4000); return; }
  if (!E.dirtyMask) { A.toast('請先用手指塗抹要移除的物件'); return; }
  if (mode === 'ai' && !A.settings.apiKey) { A.toast('AI 移除需要 Gemini API key,請到設定輸入'); return; }
  const model = A.effectiveModel();
  if (mode === 'ai' && !model) { A.toast('請在設定選擇模型'); return; }
  A.busy = true;
  A.hud(mode === 'ai' ? 'AI 移除物件' : '快速移除物件', mode === 'ai' ? '約 20~90 秒' : '約 5~30 秒');
  try {
    const data = mk.toDataURL('image/png').split(',')[1];
    const r = await A.needNative().eraseObjects({
      uri: E.uri, mask: data, mode, apiKey: (A.settings.apiKey || '').trim(), model,
      imageSize: A.settings.imageSize === '4K' ? '2K' : (A.settings.imageSize || '2K'), quality: A.settings.jpegQuality,
    });
    A.refreshThumb();
    E.uri = r.uri; E.erased = true;
    clearMask();
    await loadPreview(r.uri);
    A.toast('已移除並另存成新照片,可繼續編輯', 3500);
  } catch (e) { A.toast('移除失敗:' + A.errMsg(e), 7000); }
  finally { A.hudHide(); A.busy = false; }
}

/* ------------------------------------------------------------------ 放大檢視與手勢 */

const Zm = { s: 1, x: 0, y: 0, ptrs: new Map(), pinch: null, moved: false, lastTap: 0 };
const badge = document.createElement('button');
badge.className = 'mini';
badge.style.cssText = 'position:absolute;right:10px;top:10px;z-index:3;opacity:.85';
badge.hidden = true;
badge.onclick = () => zmSet(1, 0, 0);
stage.appendChild(badge);
function zmApply() {
  const cw = wrap.offsetWidth, ch = wrap.offsetHeight;
  const mx = Math.max(0, (cw * Zm.s - stage.clientWidth) / 2), my = Math.max(0, (ch * Zm.s - stage.clientHeight) / 2);
  Zm.x = A.clamp(Zm.x, -mx, mx); Zm.y = A.clamp(Zm.y, -my, my);
  wrap.style.transform = Zm.s === 1 ? '' : 'translate(' + Zm.x + 'px,' + Zm.y + 'px) scale(' + Zm.s + ')';
  cv.style.imageRendering = Zm.s >= 4 ? 'pixelated' : '';
  badge.hidden = Zm.s === 1;
  badge.textContent = Math.round(Zm.s * 100) + '% ✕';
}
function zmSet(s, x, y) { Zm.s = s; Zm.x = x; Zm.y = y; zmApply(); }
function zmAt(px, py, ns) {
  ns = A.clamp(ns, 1, 12);
  const k = ns / Zm.s;
  Zm.x = px - (px - Zm.x) * k; Zm.y = py - (py - Zm.y) * k; Zm.s = ns;
  zmApply();
}
const stagePt = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
const mid = () => { const [a, b] = [...Zm.ptrs.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };
let pinchMid = null;
stage.addEventListener('pointerdown', (e) => {
  if (e.target === badge) return;
  stage.setPointerCapture(e.pointerId);
  Zm.ptrs.set(e.pointerId, stagePt(e));
  Zm.moved = false;
  if (Zm.ptrs.size === 2) {
    paint = null;
    const m = mid();
    Zm.pinch = { d: m.d, s: Zm.s };
    pinchMid = { x: m.x, y: m.y };
  } else if (Zm.ptrs.size === 1 && E.tool === 'erase' && !E.pick) {
    beginStroke(e);
  }
});
stage.addEventListener('pointermove', (e) => {
  if (E.tool === 'erase') moveRing(e);
  if (!Zm.ptrs.has(e.pointerId)) return;
  const prev = Zm.ptrs.get(e.pointerId), cur = stagePt(e);
  Zm.ptrs.set(e.pointerId, cur);
  if (Zm.ptrs.size >= 2 && Zm.pinch) {
    const m = mid();
    Zm.moved = true;
    Zm.x += m.x - pinchMid.x; Zm.y += m.y - pinchMid.y;
    pinchMid = { x: m.x, y: m.y };
    zmAt(m.x, m.y, Zm.pinch.s * m.d / Zm.pinch.d);
  } else if (paint) {
    Zm.moved = true;
    strokeTo(toMask(e));
  } else if (Zm.s > 1) {
    const dx = cur.x - prev.x, dy = cur.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) { Zm.moved = true; Zm.x += dx; Zm.y += dy; zmApply(); }
  }
});
const zmEnd = (e) => {
  if (!Zm.ptrs.has(e.pointerId)) return;
  Zm.ptrs.delete(e.pointerId);
  paint = null;
  if (Zm.ptrs.size < 2) Zm.pinch = null;
  if (Zm.ptrs.size === 0 && !Zm.moved && e.type === 'pointerup' && !E.pick && E.tool !== 'erase') {
    const now = Date.now();
    if (now - Zm.lastTap < 300) { const p = stagePt(e); if (Zm.s > 1.05) zmSet(1, 0, 0); else zmAt(p.x, p.y, 3); Zm.lastTap = 0; }
    else Zm.lastTap = now;
  }
};
stage.addEventListener('pointerup', zmEnd);
stage.addEventListener('pointercancel', zmEnd);
window.addEventListener('resize', () => { fit(); });

cv.addEventListener('click', (e) => {
  if (Zm.moved) return;
  if (!E.pick || !E.base) return;
  const r = cv.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) / r.width * E.w), y = Math.round((e.clientY - r.top) / r.height * E.h);
  const n = 5;
  let sr = 0, sg = 0, sb = 0, c = 0;
  for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
    const xx = A.clamp(x + dx, 0, E.w - 1), yy = A.clamp(y + dy, 0, E.h - 1), o = (yy * E.w + xx) * 4;
    const src = (E.raw && E.neutral) ? E.neutral : E.base;
    sr += src.data[o]; sg += src.data[o + 1]; sb += src.data[o + 2]; c++;
  }
  const cb = E.pick;
  E.pick = null;
  $('ePickHint').hidden = true;
  cb(A.grayGains(sr / c, sg / c, sb / c));
  schedule();
});

/* ------------------------------------------------------------------ 載入 / 儲存 */

async function loadPreview(uri) {
  let r;
  if (E.raw) {
    try {
      r = await A.needNative().developRaw({ uri, maxDim: 1600, ev: 0, gains: [1, 1, 1] });
      E.devKey = '0|1,1,1';
    } catch (e) {
      if (!/UNSUPPORTED_RAW/.test(A.errMsg(e))) throw e;
      A.toast('此 DNG 格式無法自行顯影,改用系統解碼(RAW 專屬調整不可用)', 4500);
      E.raw = false;
    }
  }
  if (!r) r = await A.needNative().readImage({ uri, maxDim: 1600, quality: 90 });
  const img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('解碼失敗')); img.src = 'data:image/jpeg;base64,' + r.data; });
  E.w = img.naturalWidth; E.h = img.naturalHeight;
  tmpc.width = E.w; tmpc.height = E.h;
  tctx.drawImage(img, 0, 0);
  E.base = tctx.getImageData(0, 0, E.w, E.h);
  E.neutral = E.raw ? E.base : null;
  E.dn = null; E.dnKey = '';
  mk.width = E.w; mk.height = E.h;
  setCv(E.w, E.h);
  fit();
  scheduleDn();
  schedule();
}

A.openEditor = async (uri) => {
  if (A.busy) return;
  E.uri = uri; E.origUri = uri; E.erased = false;
  E.look = A.neutralLook();
  E.geo = A.geoZero();
  E.base = null; E.neutral = null; E.devKey = ''; E.dn = null; E.dnKey = '';
  zmSet(1, 0, 0);
  A.ensureEnhState();
  { const s0 = A.settings.enhSet; E.enhSt = { on: !!s0.on, id: s0.id, enh: A.cloneEnh(s0.enh) }; }
  const item = (A.gallery.items || []).find((g) => g.uri === uri);
  E.raw = !!(item && A.isRawItem(item));
  E.tool = 'none';
  openTool('none');          // 收合面板,讓照片佔滿畫面
  E.tool = null;
  clearMask();
  A.openOverlay($('editor'));
  A.hud(E.raw ? 'RAW 顯影中' : '載入影像', '');
  try {
    await loadPreview(uri);
  } catch (e) {
    A.toast('無法載入影像:' + A.errMsg(e), 4000);
    A.closeOverlay($('editor'));
  } finally { A.hudHide(); }
};

$('eBack').onclick = () => A.closeOverlay($('editor'));
$('eReset').onclick = async () => {
  E.look = A.neutralLook(); E.enhSt.on = false; E.geo = A.geoZero(); clearMask();
  zmSet(1, 0, 0);
  if (E.uri !== E.origUri && !A.busy) {
    E.uri = E.origUri; E.erased = false;
    try { await loadPreview(E.uri); } catch (e) { A.toast('還原失敗:' + A.errMsg(e), 4000); }
  }
  const t = E.tool; E.tool = null; if (t) openTool(t);
  scheduleDn(); schedule();
};
document.addEventListener('overlayclose', (e) => {
  if (e.target && e.target.id === 'editor') { E.base = null; E.neutral = null; E.raw = false; clearTimeout(E.devTimer); clearTimeout(E.dnTimer); E.dn = null; E.pick = null; E.undo = []; $('ePickHint').hidden = true; }
});

const geoArgs = () => ({ geo: { angle: E.geo.angle, pv: E.geo.pv, ph: E.geo.ph, rot: E.geo.rot & 3, flip: !!E.geo.flip } });
const hasEdits = () => !(A.paramsNeutral(A.lookParams(E.look)) && !A.enhActive(enhNow()) && A.geoNeutral(E.geo));

async function saveEdited(prefix) {
  const p = A.lookParams(E.look);
  return A.needNative().editImage(Object.assign({ uri: E.uri, look: p, quality: A.settings.jpegQuality, prefix: prefix || 'EDIT' }, A.enhArgs(enhNow()), geoArgs()));
}

$('eSave').onclick = async () => {
  if (A.busy || !E.base) return;
  if (!E.raw && !hasEdits()) { A.toast(E.erased ? '橡皮擦結果已另存為新照片' : '尚未做任何調整'); return; }
  A.busy = true;
  A.hud(E.raw ? 'RAW 顯影並儲存' : '儲存編輯', '以原始解析度處理');
  try {
    const r = await saveEdited('EDIT');
    A.refreshThumb();
    A.toast('已另存 ' + r.width + '×' + r.height, 2500);
    await A.showViewerUri(r.uri);
  } catch (e) { A.toast('儲存失敗:' + A.errMsg(e), 6000); }
  finally { A.hudHide(); A.busy = false; }
};

async function aiEnhance() {
  if (A.busy || !E.base) return;
  A.busy = true;
  try {
    let uri = E.uri;
    if (E.raw || hasEdits()) {
      A.hud(E.raw ? 'RAW 顯影' : '套用調整', '');
      uri = (await saveEdited('EDIT')).uri;
    }
    const r = await A.runGemini(uri, true, { prompt: A.settings.enhancePrompt || A.DEFAULT_ENHANCE_PROMPT, prefix: 'AIENH', hudTitle: 'Gemini 強化中' });
    if (r) await A.showViewerUri(r.uri);
  } catch (e) { A.toast('AI 強化失敗:' + A.errMsg(e), 7000); }
  finally { A.hudHide(); A.busy = false; }
}
})();
