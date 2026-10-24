/* 照片編輯:EV/對比/亮部/陰影/飽和/色調/色溫/自訂白平衡/細節增強/AI 強化 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;

const E = { uri: null, look: null, base: null, neutral: null, w: 0, h: 0, ctrl: null, pick: null, raf: 0, built: false,
  raw: false, devKey: '', devTimer: 0, devBusy: false };
const cv = $('eCanvas');
const ctx = cv.getContext('2d', { willReadFrequently: true });

function render() {
  E.raf = 0;
  if (!E.base) return;
  const img = new ImageData(new Uint8ClampedArray(E.base.data), E.w, E.h);
  let p = A.lookParams(E.look);
  // RAW:EV 與白平衡增益已在原生端於線性空間處理,這裡只做其餘調整
  if (E.raw) p = Object.assign({}, p, { ev: 0, gains: [1, 1, 1] });
  A.processPixels(img.data, p);
  if (p.detail > 0) A.unsharp(img.data, E.w, E.h, A.detailAmount(p.detail), A.detailRadius(E.w, E.h));
  ctx.putImageData(img, 0, 0);
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
    E.devKey = key;
    render();
  } catch (e) { A.toast('RAW 顯影失敗:' + A.errMsg(e), 3000); }
  finally { E.devBusy = false; }
  if (devKeyOf() !== E.devKey) E.devTimer = setTimeout(redevelop, 60);
}

function buildPanel() {
  const panel = $('ePanel');
  panel.innerHTML = '';

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

cv.addEventListener('click', (e) => {
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
  E.base = null; E.neutral = null; E.devKey = '';
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
  } catch (e) {
    A.toast('無法載入影像:' + A.errMsg(e), 4000);
    A.closeOverlay($('editor'));
  } finally { A.hudHide(); }
};

$('eBack').onclick = () => A.closeOverlay($('editor'));
$('eReset').onclick = () => { E.look = A.neutralLook(); if (E.ctrl) E.ctrl.refresh(); schedule(); };
document.addEventListener('overlayclose', (e) => {
  if (e.target && e.target.id === 'editor') { E.base = null; E.neutral = null; E.raw = false; clearTimeout(E.devTimer); E.pick = null; $('ePickHint').hidden = true; }
});

async function saveEdited(prefix) {
  const p = A.lookParams(E.look);
  return A.needNative().editImage({ uri: E.uri, look: p, quality: A.settings.jpegQuality, prefix: prefix || 'EDIT' });
}

$('eSave').onclick = async () => {
  if (A.busy || !E.base) return;
  if (!E.raw && A.paramsNeutral(A.lookParams(E.look))) { A.toast('尚未做任何調整'); return; }
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
    if (E.raw || !A.paramsNeutral(A.lookParams(E.look))) {
      A.hud(E.raw ? 'RAW 顯影' : '套用調整', '');
      uri = (await saveEdited('EDIT')).uri;
    }
    const r = await A.runGemini(uri, true, { prompt: A.settings.enhancePrompt || A.DEFAULT_ENHANCE_PROMPT, prefix: 'AIENH', hudTitle: 'Gemini 強化中' });
    if (r) await A.showViewerUri(r.uri);
  } catch (e) { A.toast('AI 強化失敗:' + A.errMsg(e), 7000); }
  finally { A.hudHide(); A.busy = false; }
}
})();
