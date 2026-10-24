/* 拍照 / HDR / Gemini 回推 / 放大 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;
const S = A.S;
const { clamp, sleep } = A;
const video = $('video');

A.refreshHdrChip = () => {
  const st = A.settings, b = $('btnHdr');
  if (st.hdrOn) { b.textContent = 'HDR ' + st.hdrCount + '張 ±' + st.hdrRange; b.classList.add('on'); }
  else { b.textContent = 'HDR 關'; b.classList.remove('on'); }
  $('btnShutter').classList.toggle('hdr', !!st.hdrOn);
};
A.refreshSrChip = () => {
  const st = A.settings, b = $('btnSR');
  if (st.srOn) { b.textContent = '超解析 ' + st.srCount + '張'; b.classList.add('on'); }
  else { b.textContent = '超解析 關'; b.classList.remove('on'); }
};
$('btnSR').onclick = () => {
  A.settings.srOn = !A.settings.srOn; A.saveSettings(); A.refreshSrChip();
  if (A.settings.srOn) A.toast('超解析:數位變焦 ≥1.5× 時連拍 ' + A.settings.srCount + ' 張合成,請盡量穩穩手持', 3500);
};
$('btnHdr').onclick = () => { A.settings.hdrOn = !A.settings.hdrOn; A.saveSettings(); A.refreshHdrChip(); };

A.refreshThumb = async () => {
  try {
    const r = await A.needNative().listRecent({ limit: 1 });
    const it = (r.items || [])[0];
    if (!it) { $('thumbImg').removeAttribute('src'); return; }
    const t = await A.needNative().readThumb({ uri: it.uri, size: 160 });
    $('thumbImg').src = 'data:image/jpeg;base64,' + t.data;
  } catch (e) { /* ignore */ }
};

async function takeStill() {
  if (S.capture) {
    try {
      if (!S.photoCaps) S.photoCaps = await S.capture.getPhotoCapabilities();
      const pc = S.photoCaps, opt = {};
      if (pc.imageWidth && pc.imageHeight) { opt.imageWidth = pc.imageWidth.max; opt.imageHeight = pc.imageHeight.max; }
      if (S.lightMode === 'flash' && pc.fillLightMode && pc.fillLightMode.includes('flash')) opt.fillLightMode = 'flash';
      return await S.capture.takePhoto(opt);
    } catch (e) { console.warn('takePhoto 失敗,改用預覽畫面', e); }
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
    if (cap) { v = clamp(v, cap.min, cap.max); if (cap.step) v = Math.round(v / cap.step) * cap.step; }
    out.push(+v.toFixed(2));
  }
  return out;
}

function baseOpts() {
  return {
    cropZoom: S.within > 1.01 ? S.within : 1,
    cropAspect: S.frameAR,
    quality: A.settings.jpegQuality,
    prefix: 'IMG',
    look: A.captureLookParams(),
    keepOriginal: !!A.settings.keepOriginal,
    mirror: !!(S.front && A.settings.selfieMirror),
    zoomOutMp: A.settings.zoomOutMp || 0,
  };
}

async function shootHdr(opts) {
  const N = A.needNative();
  const manual = S.man.exp && S.caps.exposureTime;
  const cap = S.caps.exposureCompensation;
  if (!manual && !cap) {
    A.toast('此鏡頭不支援曝光補償,已改拍單張');
    return N.saveImage(Object.assign({ data: await A.blobToBase64(await takeStill()) }, opts));
  }
  const evs = buildEvs(A.settings.hdrCount, A.settings.hdrRange, manual ? null : cap);
  if (!manual && Math.max(...evs) - Math.min(...evs) < 0.3) A.toast('裝置曝光補償範圍很小,HDR 效果有限');
  await N.clearFrames();
  const userEv = S.ev, userT = S.man.t;
  try {
    for (let i = 0; i < evs.length; i++) {
      A.hudSub('HDR ' + (i + 1) + '/' + evs.length + '(EV ' + (evs[i] > 0 ? '+' : '') + evs[i].toFixed(1) + ')');
      if (manual) {
        const et = S.caps.exposureTime;
        S.man.t = clamp(userT * Math.pow(2, evs[i]), et.min, et.max);
        await A.applyManualExposure(true);
      } else {
        try { await S.track.applyConstraints({ advanced: [{ exposureCompensation: evs[i] }] }); } catch (e) { /* ignore */ }
      }
      await sleep(A.settings.hdrSettle);
      await N.cacheFrame({ index: i, data: await A.blobToBase64(await takeStill()) });
    }
  } finally {
    if (manual) { S.man.t = userT; await A.applyManualExposure(true); }
    else { try { await S.track.applyConstraints({ advanced: [{ exposureCompensation: userEv }] }); } catch (e) { /* ignore */ } }
  }
  A.hudSub('合成 HDR');
  return N.mergeHdr(Object.assign({ count: evs.length }, opts));
}

/** 多張合成超解析:連拍後在原生端對齊、合成並放大 */
async function shootSR(opts) {
  const N = A.needNative();
  const n = A.settings.srCount;
  await N.clearFrames();
  for (let i = 0; i < n; i++) {
    A.hudSub('連拍 ' + (i + 1) + '/' + n + '(請保持穩定)');
    await N.cacheFrame({ index: i, data: await A.blobToBase64(await takeStill()) });
  }
  A.hudSub('對齊與合成中(約 10~40 秒)');
  return N.mergeSuperRes(Object.assign({ count: n }, opts));
}

/** 以原生 Camera2 拍攝(RAW / 隱藏的望遠鏡頭)。會暫時釋放 WebView 預覽。 */
async function shootNative(opts, rawWanted) {
  const N = A.needNative();
  const key = S.lensKey;
  const info = A.nativeLensInfo();
  const st = A.settings;
  A.hudSub('釋放預覽,切換原生相機');
  const man = S.mode === 'manual' && S.man.exp;
  const args = Object.assign({}, opts, {
    cameraId: info.id,
    raw: rawWanted,
    jpeg: !rawWanted || st.rawJpeg,
    exposureMs: man && S.man.t ? S.man.t / 10 : 0,
    iso: man && S.man.iso ? Math.round(S.man.iso) : 0,
    focusMeters: S.mode === 'manual' && S.focusManual && S.focusDist ? S.focusDist : 0,
    ev: man ? 0 : S.ev,
    torch: S.lightMode === 'torch',
    zoom: S.within > 1.01 ? S.within : 1,
    burst: rawWanted ? 1 : (st.nativeBurst || 1),
    focusU: S.lastFocus ? S.lastFocus.u : -1,
    focusV: S.lastFocus ? S.lastFocus.v : -1,
  });
  A.stopStream();
  await A.stopNativePrev();
  await sleep(300);
  try {
    return await N.captureNative(args);
  } finally {
    try { await A.startLens(key); A.applyPreviewZoom(); } catch (e) { A.toast('預覽恢復失敗:' + A.errMsg(e), 4000); }
  }
}

async function shoot() {
  if (A.busy || (!S.track && !S.nativePrev)) return;
  A.busy = true;
  const st = A.settings;
  $('btnShutter').classList.add('busy');
  A.hud(st.hdrOn ? '拍攝 HDR' : '拍攝中', '請保持穩定');
  try {
    if (navigator.vibrate) navigator.vibrate(15);
    const opts = baseOpts();
    const info = A.nativeLensInfo();
    const rawWanted = S.mode === 'manual' && st.rawOn && !!(info && info.raw);
    const useNative = !!info && (info.virtual || rawWanted);
    let res = null;
    if (useNative) {
      if (st.hdrOn) A.toast('原生拍攝(RAW/隱藏望遠)暫不支援 HDR,改拍單張', 3000);
      try {
        res = await shootNative(opts, rawWanted);
        if (res.notes) A.toast(res.notes, 4000);
      } catch (e) {
        if (!info.virtual) throw e;
        A.toast('望遠鏡頭無法由原生開啟(' + A.errMsg(e) + '),改用主鏡頭數位放大', 6000);
        opts.cropZoom = S.Z > 1.01 ? S.Z : 1;
        res = null;
        A.forceWeb = true;
        try { await A.startLens(S.lensKey); } catch (e2) { /* ignore */ }
      }
    }
    if (!res) {
      if (st.srOn && opts.cropZoom >= 1.45 && !rawWanted) {
        if (st.hdrOn) A.toast('超解析與 HDR 不能同時使用,本張以超解析為主', 3000);
        res = await shootSR(opts);
      } else if (st.hdrOn) res = await shootHdr(opts);
      else {
        const blob = await takeStill();
        A.hudSub('儲存中');
        res = await A.needNative().saveImage(Object.assign({ data: await A.blobToBase64(blob) }, opts));
      }
    }
    A.refreshThumb();
    const jpegSaved = !(res.hasRaw && res.uri === res.rawUri);
    if (jpegSaved && st.autoRestore && st.apiKey && S.within >= st.autoThreshold) {
      try { await A.runGemini(res.uri, true); } catch (e) { A.toast('Gemini 回推失敗:' + A.errMsg(e), 5000); }
    } else {
      A.toast('已儲存 ' + res.width + '×' + res.height + '(' + res.megapixels.toFixed(1) + ' MP)' +
        (res.hasRaw ? ' + DNG' : ''));
    }
  } catch (e) {
    A.toast('拍攝失敗:' + A.errMsg(e), 5000);
  } finally {
    A.forceWeb = false;
    A.hudHide();
    A.busy = false;
    $('btnShutter').classList.remove('busy');
  }
}

$('btnShutter').onclick = () => {
  if (S.mode === 'video') { if (A.toggleRecord) A.toggleRecord(); } else shoot();
};

/* ------------------------------------------------------------------ Gemini / 放大 */

/** opts: { prompt, prefix } */
A.runGemini = async (uri, silentOpen, opts) => {
  const st = A.settings;
  opts = opts || {};
  if (!st.apiKey) { A.toast('請先在設定輸入 Gemini API key'); A.openOverlay($('settings')); return null; }
  const model = A.effectiveModel();
  if (!model) { A.toast('請在設定選擇或輸入模型 ID'); return null; }
  A.hud(opts.hudTitle || 'Gemini 回推中', '最高 4K 輸出,可能需要 30~120 秒');
  const r = await A.needNative().geminiRestore({
    uri, apiKey: st.apiKey.trim(), model, imageSize: st.imageSize,
    prompt: opts.prompt || st.prompt || A.DEFAULT_PROMPT, maxInputDim: st.maxInput,
    quality: st.jpegQuality, prefix: opts.prefix || 'AI',
  });
  A.refreshThumb();
  A.toast('完成:' + r.width + '×' + r.height + '(' + r.megapixels.toFixed(1) + ' MP)', 3500);
  if (!silentOpen && A.showViewerUri) await A.showViewerUri(r.uri);
  return r;
};

A.runUpscale = async (uri) => {
  A.hud('放大中', '正在配置大型畫布…');
  const st = A.settings;
  const r = await A.needNative().upscale({ uri, targetMegapixels: st.targetMP, quality: st.jpegQuality });
  A.refreshThumb();
  let m = '完成:' + r.width + '×' + r.height + '(' + r.megapixels.toFixed(1) + ' MP)';
  if (r.actualMp && r.actualMp < st.targetMP - 0.5) m += ',記憶體不足已降級';
  A.toast(m, 4000);
  if (A.showViewerUri) await A.showViewerUri(r.uri);
  return r;
};
})();
