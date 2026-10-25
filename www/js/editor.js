/* 照片編輯:EV/對比/亮部/陰影/飽和/色調/色溫/自訂白平衡/細節增強/AI 強化 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;

const E = { uri: null, look: null, base: null, neutral: null, w: 0, h: 0, ctrl: null, pick: null, raf: 0, built: false,
  raw: false, devKey: '', devTimer: 0, devBusy: false, enhSt: null, dn: null, dnKey: '', dnTimer: 0 };
const cv = $('eCanvas');
const ctx = cv.getContext('2d', { willReadFrequently: true });

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
  if (en.sharp > 0) A.unsharp(img.data, E.w, E.h, en.sharp / 100 * 1.2, A.detailRadius(E.w, E.h));
  ctx.putImageData(img, 0, 0);
}

const enhNow = () => A.enhEff(E.enhSt);
/** 降噪後的底圖(有快取;參數變動時延遲重算,預覽為近似效果) */
function dnBase() {
  const en = enhNow();
  if (!(en.dnL > 0 || en.dnC > 0)) return E.base;
  const key = en.dnL + '|' + en.dnC;
  if (E.dn && E.dnKey === key) return E.dn;
  return E.dn || E.base;
}
function scheduleDn() {
  clearTimeout(E.dnTimer);
  E.dnTimer = setTimeout(() => {
    if (!E.base) return;
    const en = enhNow();
    if (en.dnL > 0 || en.dnC > 0) {
      const key = en.dnL + '|' + en.dnC;
      if (E.dnKey !== key) {
        const d = new ImageData(new Uint8ClampedArray(E.base.data), E.w, E.h);
        A.denoiseRGBA(d.data, E.w, E.h, en.dnL, en.dnC);
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
    ctx.drawImage(img, 0, 0, E.w, E.h);
    E.base = ctx.getImageData(0, 0, E.w, E.h);
    E.dn = null; E.dnKey = '';
    E.devKey = key;
    render();
  } catch (e) { A.toast('RAW 顯影失敗:' + A.errMsg(e), 3000); }
  finally { E.devBusy = false; }
  if (devKeyOf() !== E.devKey) E.devTimer = setTimeout(redevelop, 60);
}

function buildPanel() {
  const panel = $('ePanel');
  panel.innerHTML = '';
  const enhBox = document.createElement('div');
  enhBox.style.marginBottom = '18px';
  const enhTitle = document.createElement('div');
  enhTitle.className = 'k-row'; enhTitle.style.marginBottom = '8px'; enhTitle.textContent = '畫質提升(降噪、銳利、AI 放大)';
  const enhInner = document.createElement('div');
  enhBox.appendChild(enhTitle); enhBox.appendChild(enhInner);
  panel.appendChild(enhBox);
  A.buildEnhPanel(enhInner, E.enhSt, { toggleLabel: '套用畫質提升', showBurst: false, showNN: true, onChange: () => { scheduleDn(); schedule(); } });
  const enhNote = document.createElement('p');
  enhNote.className = 'note';
  enhNote.textContent = '預覽的降噪為縮圖近似效果;儲存時以原始解析度處理。AI 放大只適用 ≤2.5MP 的影像(裁切圖/小圖),輸出約 2 倍邊長。';
  panel.appendChild(enhNote);


  const prof = document.createElement('div');
  prof.className = 'k-row';
  prof.innerHTML = '<div style="margin-bottom:6px">色彩檔案</div>';
  const chips = document.createElement('div');
  chips.className = 'wb-row';
  prof.appendChild(chips);
  panel.appendChild(prof);

  const ctrlBox = document.createElement('div');
  panel.appendChild(ctrlBox);

  const row = document.createElement('div');
  row.className = 'wb-row';
  row.style.marginTop = '14px';
  const bSave = document.createElement('button');
  bSave.className = 'mini'; bSave.textContent = '存成色彩檔案';
  const bAi = document.createElement('button');
  bAi.className = 'act accent'; bAi.textContent = '✨ AI 強化(Gemini)';
  row.appendChild(bSave); row.appendChild(bAi);
  panel.appendChild(row);

  const fillChips = () => {
    chips.innerHTML = '';
    A.allProfiles().forEach((p) => {
      const b = document.createElement('button');
      b.className = 'mini'; b.textContent = p.name;
      b.onclick = () => { E.look = A.cloneLook(p.look); E.ctrl.refresh(); schedule(); };
      chips.appendChild(b);
    });
  };
  fillChips();

  E.ctrl = A.buildLookControls(ctrlBox, {
    get: () => A.cloneLook(E.look),
    set: (l) => { E.look = A.cloneLook(l); schedule(); },
    pickGray: (cb) => {
      E.pick = cb;
      $('ePickHint').hidden = false;
    },
  });

  bSave.onclick = () => {
    const name = prompt('色彩檔案名稱');
    if (!name || !name.trim()) return;
    A.saveCustomProfile(name.trim(), E.look);
    fillChips();
    if (A.updateProfileChip) A.updateProfileChip();
    A.toast('已儲存色彩檔案「' + name.trim() + '」');
  };
  bAi.onclick = aiEnhance;
}

/* ---- 放大檢視:雙指縮放、單指拖曳、雙擊切換 ---- */
const stage = $('eStage');
const Zm = { s: 1, x: 0, y: 0, ptrs: new Map(), pinch: null, moved: false, lastTap: 0 };
const badge = document.createElement('button');
badge.className = 'mini';
badge.style.cssText = 'position:absolute;right:10px;top:10px;z-index:3;opacity:.85';
badge.hidden = true;
badge.onclick = () => zmSet(1, 0, 0);
stage.appendChild(badge);
function zmApply() {
  const cw = cv.offsetWidth, ch = cv.offsetHeight;
  const mx = Math.max(0, (cw * Zm.s - stage.clientWidth) / 2), my = Math.max(0, (ch * Zm.s - stage.clientHeight) / 2);
  Zm.x = A.clamp(Zm.x, -mx, mx); Zm.y = A.clamp(Zm.y, -my, my);
  cv.style.transform = Zm.s === 1 ? '' : 'translate(' + Zm.x + 'px,' + Zm.y + 'px) scale(' + Zm.s + ')';
  cv.style.imageRendering = Zm.s >= 4 ? 'pixelated' : '';
  badge.hidden = Zm.s === 1;
  badge.textContent = Math.round(Zm.s * 100) + '% ✕';
}
function zmSet(s, x, y) { Zm.s = s; Zm.x = x; Zm.y = y; zmApply(); }
/** 以舞台座標 (px,py)(相對舞台中心)為不動點縮放 */
function zmAt(px, py, ns) {
  ns = A.clamp(ns, 1, 12);
  const k = ns / Zm.s;
  Zm.x = px - (px - Zm.x) * k; Zm.y = py - (py - Zm.y) * k; Zm.s = ns;
  zmApply();
}
const stagePt = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
stage.addEventListener('pointerdown', (e) => {
  if (e.target === badge) return;
  stage.setPointerCapture(e.pointerId);
  Zm.ptrs.set(e.pointerId, stagePt(e));
  Zm.moved = false;
  if (Zm.ptrs.size === 2) {
    const [a, b] = [...Zm.ptrs.values()];
    Zm.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: Zm.s };
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!Zm.ptrs.has(e.pointerId)) return;
  const prev = Zm.ptrs.get(e.pointerId), cur = stagePt(e);
  Zm.ptrs.set(e.pointerId, cur);
  if (Zm.ptrs.size >= 2 && Zm.pinch) {
    const [a, b] = [...Zm.ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    Zm.moved = true;
    zmAt((a.x + b.x) / 2, (a.y + b.y) / 2, Zm.pinch.s * d / Zm.pinch.d);
  } else if (Zm.s > 1) {
    const dx = cur.x - prev.x, dy = cur.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) { Zm.moved = true; Zm.x += dx; Zm.y += dy; zmApply(); }
  }
});
const zmEnd = (e) => {
  if (!Zm.ptrs.has(e.pointerId)) return;
  Zm.ptrs.delete(e.pointerId);
  if (Zm.ptrs.size < 2) Zm.pinch = null;
  if (Zm.ptrs.size === 0 && !Zm.moved && e.type === 'pointerup' && !E.pick) {
    const now = Date.now();
    if (now - Zm.lastTap < 300) { const p = stagePt(e); if (Zm.s > 1.05) zmSet(1, 0, 0); else zmAt(p.x, p.y, 3); Zm.lastTap = 0; }
    else Zm.lastTap = now;
  }
};
stage.addEventListener('pointerup', zmEnd);
stage.addEventListener('pointercancel', zmEnd);
window.addEventListener('resize', zmApply);

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
});

A.openEditor = async (uri) => {
  if (A.busy) return;
  E.uri = uri;
  E.look = A.neutralLook();
  E.base = null; E.neutral = null; E.devKey = ''; E.dn = null; E.dnKey = '';
  zmSet(1, 0, 0);
  A.ensureEnhState();
  { const s0 = A.settings.enhSet; E.enhSt = { on: !!s0.on, id: s0.id, enh: A.cloneEnh(s0.enh) }; }
  const item = (A.gallery.items || []).find((g) => g.uri === uri);
  E.raw = !!(item && A.isRawItem(item));
  if (!E.built) { E.built = true; }
  buildPanel();
  A.openOverlay($('editor'));
  A.hud(E.raw ? 'RAW 顯影中' : '載入影像', '');
  try {
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
    cv.width = E.w; cv.height = E.h;
    ctx.drawImage(img, 0, 0);
    E.base = ctx.getImageData(0, 0, E.w, E.h);
    if (E.raw) E.neutral = E.base;
    scheduleDn();
  } catch (e) {
    A.toast('無法載入影像:' + A.errMsg(e), 4000);
    A.closeOverlay($('editor'));
  } finally { A.hudHide(); }
};

$('eBack').onclick = () => A.closeOverlay($('editor'));
$('eReset').onclick = () => { E.look = A.neutralLook(); E.enhSt.on = false; buildPanel(); scheduleDn(); schedule(); };
document.addEventListener('overlayclose', (e) => {
  if (e.target && e.target.id === 'editor') { E.base = null; E.neutral = null; E.raw = false; clearTimeout(E.devTimer); clearTimeout(E.dnTimer); E.dn = null; E.pick = null; $('ePickHint').hidden = true; }
});

async function saveEdited(prefix) {
  const p = A.lookParams(E.look);
  return A.needNative().editImage(Object.assign({ uri: E.uri, look: p, quality: A.settings.jpegQuality, prefix: prefix || 'EDIT' }, A.enhArgs(enhNow())));
}

$('eSave').onclick = async () => {
  if (A.busy || !E.base) return;
  if (!E.raw && A.paramsNeutral(A.lookParams(E.look)) && !A.enhActive(enhNow())) { A.toast('尚未做任何調整'); return; }
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
    if (E.raw || !A.paramsNeutral(A.lookParams(E.look)) || A.enhActive(enhNow())) {
      A.hud(E.raw ? 'RAW 顯影' : '套用調整', '');
      uri = (await saveEdited('EDIT')).uri;
    }
    const r = await A.runGemini(uri, true, { prompt: A.settings.enhancePrompt || A.DEFAULT_ENHANCE_PROMPT, prefix: 'AIENH', hudTitle: 'Gemini 強化中' });
    if (r) await A.showViewerUri(r.uri);
  } catch (e) { A.toast('AI 強化失敗:' + A.errMsg(e), 7000); }
  finally { A.hudHide(); A.busy = false; }
}
})();
