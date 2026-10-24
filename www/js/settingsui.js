/* 設定頁:綁定、鏡頭對應、設定檔匯出/匯入 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;
const S = A.S;
const st = A.settings;

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
  sel.value = st.lensMap[role] || '';
}

function renderCamList() {
  const box = $('camList');
  box.innerHTML = '';
  const roleOf = (d) => Object.entries(S.lens).filter(([, l]) => l.dev === d).map(([k]) => A.ROLE_LABEL[k]).join('/');
  S.devices.forEach((d) => {
    const div = document.createElement('div');
    const role = roleOf(d);
    div.innerHTML = '#' + d.id + ' ' + (d.facing === 'back' ? '後' : d.facing === 'front' ? '前' : '?') +
      (d.eq ? ' · 約 ' + Math.round(d.eq) + 'mm(35mm 等效)' : '') +
      (d.native && d.native.sensorMp ? ' · ' + d.native.sensorMp.toFixed(1) + 'MP' : '') +
      (d.aperture ? ' · f/' + d.aperture.toFixed(1) : '') +
      (d.native && d.native.raw ? ' · RAW' : '') +
      (d.usable ? '' : ' · 不可用') +
      (role ? ' <span class="role">→ ' + role + '</span>' : '');
    box.appendChild(div);
  });
  (S.nativeOnly || []).forEach((n) => {
    const div = document.createElement('div');
    const roleNat = Object.entries(S.lens).filter(([, l]) => l.nativeId === n.id).map(([k]) => A.ROLE_LABEL[k]).join('/');
    div.innerHTML = '#' + n.id + (n.facing === 'back' ? ' 後' : n.facing === 'front' ? ' 前' : '') +
      (n.equivMm ? ' · 約 ' + Math.round(n.equivMm) + 'mm' : '') + (n.raw ? ' · RAW' : '') +
      (n.hidden ? ' · 隱藏鏡頭(系統未列出,可由原生嘗試開啟)' : ' · WebView 看不到,僅能原生使用') +
      (roleNat ? ' <span class="role">→ ' + roleNat + '(原生)</span>' : '');
    box.appendChild(div);
  });
  if (!S.devices.length) box.textContent = '尚未偵測到鏡頭';
}
A.renderCamList = renderCamList;

function sync() {
  $('setKey').value = st.apiKey;
  const known = ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image'];
  $('setModel').value = known.includes(st.model) ? st.model : '__custom';
  $('setModelCustom').hidden = $('setModel').value !== '__custom';
  $('setModelCustom').value = st.modelCustom || (known.includes(st.model) ? '' : st.model);
  $('setSize').value = st.imageSize;
  $('setMaxInput').value = String(st.maxInput);
  $('setAuto').checked = st.autoRestore;
  $('setThreshold').value = st.autoThreshold;
  $('setPrompt').value = st.prompt;
  $('setEnhance').value = st.enhancePrompt;
  $('setHist').checked = st.histogram;
  $('setFaceAuto').checked = st.faceAuto;
  $('setHdrOn').checked = st.hdrOn;
  $('setHdrCount').value = String(st.hdrCount);
  $('setHdrRange').value = String(st.hdrRange);
  $('setSettle').value = st.hdrSettle;
  $('setApply').checked = st.applyOnCapture;
  $('setKeep').checked = st.keepOriginal;
  $('setRawJpeg').checked = st.rawJpeg;
  $('setMirror').checked = st.selfieMirror;
  $('setTeleId').value = st.teleNativeId || '';
  $('setQuality').value = st.jpegQuality;
  $('qVal').textContent = st.jpegQuality;
  $('setMP').value = String(st.targetMP);
  fillSelect($('mapWide'), 'wide');
  fillSelect($('mapMain'), 'main');
  fillSelect($('mapTele'), 'tele');
  renderCamList();
  $('aboutText').textContent = 'AI Camera Pro v' + A.VERSION + '\n相簿位置:Pictures/AICamera、Movies/AICamera';
  $('aboutText').style.whiteSpace = 'pre-line';
}
A.syncSettingsUI = sync;

/** 設定變動後,讓整個 UI 與相機狀態跟上 */
A.applySettingsToUi = () => {
  A.refreshHdrChip();
  A.updateRatioChip();
  A.updateGrid();
  A.updateFocusChip();
  A.updateProfileChip();
  A.syncVideoOpts();
  A.layoutFrame();
  A.refreshLookPreview();
  A.refreshReadouts();
  $('hist').hidden = !st.histogram;
};

A.bindSettings = () => {
  $('btnSettings').onclick = () => { sync(); A.openOverlay($('settings')); };
  $('sClose').onclick = () => A.closeOverlay($('settings'));

  $('setKey').oninput = (e) => { st.apiKey = e.target.value.trim(); A.saveSettings(); };
  $('btnShowKey').onclick = () => {
    const k = $('setKey'), show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    $('btnShowKey').textContent = show ? '隱藏' : '顯示';
  };
  $('setModel').onchange = (e) => {
    $('setModelCustom').hidden = e.target.value !== '__custom';
    st.model = e.target.value; A.saveSettings();
  };
  $('setModelCustom').oninput = (e) => { st.modelCustom = e.target.value; A.saveSettings(); };
  $('setSize').onchange = (e) => { st.imageSize = e.target.value; A.saveSettings(); };
  $('setMaxInput').onchange = (e) => { st.maxInput = parseInt(e.target.value, 10); A.saveSettings(); };
  $('setAuto').onchange = (e) => { st.autoRestore = e.target.checked; A.saveSettings(); };
  $('setThreshold').onchange = (e) => {
    st.autoThreshold = A.clamp(parseFloat(e.target.value) || 1.5, 1, 10);
    e.target.value = st.autoThreshold; A.saveSettings();
  };
  $('setPrompt').oninput = (e) => { st.prompt = e.target.value; A.saveSettings(); };
  $('btnResetPrompt').onclick = () => { st.prompt = A.DEFAULT_PROMPT; $('setPrompt').value = st.prompt; A.saveSettings(); };
  $('setEnhance').oninput = (e) => { st.enhancePrompt = e.target.value; A.saveSettings(); };
  $('btnResetEnhance').onclick = () => { st.enhancePrompt = A.DEFAULT_ENHANCE_PROMPT; $('setEnhance').value = st.enhancePrompt; A.saveSettings(); };

  $('setHist').onchange = (e) => { st.histogram = e.target.checked; A.saveSettings(); $('hist').hidden = !st.histogram; };
  $('setFaceAuto').onchange = (e) => { st.faceAuto = e.target.checked; A.saveSettings(); };

  $('setHdrOn').onchange = (e) => { st.hdrOn = e.target.checked; A.saveSettings(); A.refreshHdrChip(); };
  $('setHdrCount').onchange = (e) => { st.hdrCount = parseInt(e.target.value, 10); A.saveSettings(); A.refreshHdrChip(); };
  $('setHdrRange').onchange = (e) => { st.hdrRange = parseFloat(e.target.value); A.saveSettings(); A.refreshHdrChip(); };
  $('setSettle').onchange = (e) => {
    st.hdrSettle = A.clamp(parseInt(e.target.value, 10) || 550, 200, 2000);
    e.target.value = st.hdrSettle; A.saveSettings();
  };

  $('setApply').onchange = (e) => { st.applyOnCapture = e.target.checked; A.saveSettings(); };
  $('setKeep').onchange = (e) => { st.keepOriginal = e.target.checked; A.saveSettings(); };
  $('setMirror').onchange = (e) => { st.selfieMirror = e.target.checked; A.saveSettings(); };
  $('setRawJpeg').onchange = (e) => { st.rawJpeg = e.target.checked; A.saveSettings(); };
  $('setTeleId').onchange = async (e) => {
    st.teleNativeId = e.target.value.replace(/[^0-9]/g, '');
    e.target.value = st.teleNativeId;
    A.saveSettings();
    A.assignLenses();
    renderCamList();
    if (S.lensKey && !S.lens[S.lensKey]) await A.startLens(A.chooseLens(S.Z) || 'main');
  };
  $('setQuality').oninput = (e) => {
    st.jpegQuality = parseInt(e.target.value, 10);
    $('qVal').textContent = st.jpegQuality; A.saveSettings();
  };
  $('setMP').onchange = (e) => { st.targetMP = parseInt(e.target.value, 10); A.saveSettings(); };
  $('btnManageProfiles').onclick = () => A.openProfileSheet();

  const mapChange = (role) => async (e) => {
    st.lensMap[role] = e.target.value;
    A.saveSettings();
    A.assignLenses();
    renderCamList();
    const key = A.chooseLens(S.Z);
    if (key && key !== S.lensKey) await A.setZoom(S.Z, true);
    else if (S.lensKey && !S.lens[S.lensKey]) await A.startLens(A.chooseLens(S.Z));
  };
  $('mapWide').onchange = mapChange('wide');
  $('mapMain').onchange = mapChange('main');
  $('mapTele').onchange = mapChange('tele');

  $('btnRescan').onclick = async () => {
    try {
      A.stopStream();
      await A.scanCameras();
      sync();
      await A.startLens(A.chooseLens(S.Z) || 'main');
      A.applyPreviewZoom();
      A.toast('已重新偵測鏡頭');
    } catch (e) { A.toast('偵測失敗:' + A.errMsg(e)); }
  };

  $('btnTestKey').onclick = async () => {
    const out = $('testResult');
    out.className = 'test-result'; out.textContent = '測試中…';
    try {
      const r = await A.needNative().testGemini({ apiKey: st.apiKey, model: A.effectiveModel() });
      out.textContent = r.message; out.classList.add(r.ok ? 'ok' : 'err');
    } catch (e) { out.textContent = A.errMsg(e); out.classList.add('err'); }
  };

  /* 設定檔匯出 / 匯入 */
  $('btnExport').onclick = async () => {
    const copy = JSON.parse(JSON.stringify(st));
    if (!$('expKey').checked) delete copy.apiKey;
    const doc = { app: 'AICameraPro', version: A.VERSION, exportedAt: new Date().toISOString(), settings: copy };
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = 'AICamera_settings_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.json';
    try {
      await A.needNative().exportFile({ name, text: JSON.stringify(doc, null, 2), mime: 'application/json' });
      A.toast('已匯出到 下載/AICamera/' + name, 4500);
    } catch (e) { A.toast('匯出失敗:' + A.errMsg(e), 5000); }
  };
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      const s = doc && (doc.settings || doc);
      if (!s || typeof s !== 'object' || (doc.app && doc.app !== 'AICameraPro')) throw new Error('不是有效的設定檔');
      const keepKey = st.apiKey;
      const clean = Object.assign({}, A.DEFAULTS, s);
      clean.lensMap = Object.assign({}, A.DEFAULTS.lensMap, s.lensMap || {});
      if (!Array.isArray(clean.profiles)) clean.profiles = [];
      clean.profiles = clean.profiles.filter((p) => p && p.id && p.name).map((p) => ({ id: String(p.id), name: String(p.name), look: A.cloneLook(p.look) }));
      clean.look = A.cloneLook(clean.look);
      if (!clean.apiKey) clean.apiKey = keepKey;
      if (!['3:4', '1:1', '9:16', 'full'].includes(clean.ratio)) clean.ratio = '3:4';
      if (!['single', 'face', 'track'].includes(clean.focusAssist)) clean.focusAssist = 'single';
      Object.keys(st).forEach((k) => delete st[k]);
      Object.assign(st, clean);
      A.saveSettings();
      A.assignLenses();
      sync();
      A.applySettingsToUi();
      document.dispatchEvent(new CustomEvent('lookchange'));
      A.toast('已匯入設定', 2500);
    } catch (err) { A.toast('匯入失敗:' + A.errMsg(err), 5000); }
  };
};
})();
