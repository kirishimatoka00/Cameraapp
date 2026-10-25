/* 啟動 */
(() => {
'use strict';
const A = window.A;
const S = A.S;

async function init() {
  A.initLookUI();
  A.initEnhUI();
  A.bindSettings();
  A.bindProgress();
  A.applySettingsToUi();
  A.layoutFrame();

  if (!A.CT()) A.toast('原生外掛未載入:僅能預覽,無法存檔', 5000);
  try {
    await A.scanCameras();
    const key = S.lens.main ? 'main' : Object.keys(S.lens)[0];
    if (!key) throw new Error('找不到可用鏡頭');
    S.Z = S.lens[key].ratio;
    await A.startLens(key);
    A.applyPreviewZoom();
    A.refreshThumb();
    A.toast(S.lens.tele ? '偵測到望遠鏡頭:2× 為光學望遠' : '未偵測到獨立望遠鏡頭:2× 以上為數位變焦', 3000);
  } catch (e) {
    A.toast('相機啟動失敗:' + A.errMsg(e) + '(請確認已允許相機權限)', 6000);
  }
}

/* 檢視/編輯相片時關閉鏡頭,回到相機時再開 */
const camOverlays = ['gallery', 'viewer', 'editor', 'settings'].map((id) => A.$(id));
const anyViewOpen = () => camOverlays.some((el) => el && !el.hidden);
async function camPause() {
  if (S.recording || A.busy) return;
  A.stopStream(); await A.stopNativePrev();
}
async function camResume() {
  if (anyViewOpen() || !S.lensKey || S.stream || S.nativePrev || S.starting) return;
  S.starting = true;
  try { await A.startLens(S.lensKey); A.applyPreviewZoom(); } catch (e) { /* ignore */ }
  S.starting = false;
}
camOverlays.forEach((el) => {
  if (!el) return;
  el.addEventListener('overlayopen', camPause);
  el.addEventListener('overlayclose', () => setTimeout(camResume, 60));
});

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    if (!S.recording) { A.stopStream(); A.stopNativePrev(); }
  } else if (S.lensKey && !S.stream && !S.nativePrev && !S.starting && !anyViewOpen()) {
    S.starting = true;
    try { await A.startLens(S.lensKey); A.applyPreviewZoom(); } catch (e) { /* ignore */ }
    S.starting = false;
  }
});

init();
})();
