/* 影片錄製:1080P / 2K / 4K / 8K,30 / 60 FPS */
(() => {
'use strict';
const A = window.A;
const $ = A.$;
const S = A.S;

const RES = {
  '1080P': { w: 1920, h: 1080, bps: 12e6 },
  '2K': { w: 2560, h: 1440, bps: 20e6 },
  '4K': { w: 3840, h: 2160, bps: 40e6 },
  '8K': { w: 7680, h: 4320, bps: 90e6 },
};

/** 開啟錄影用串流(含麥克風);解析度/FPS 取自設定,系統不支援時會以最接近的規格開啟 */
A.openVideoStream = async (deviceConstraint) => {
  const st = A.settings, r = RES[st.videoRes] || RES['4K'];
  const mk = (audio, exact) => ({
    video: {
      deviceId: deviceConstraint,
      width: exact ? { exact: r.w } : { ideal: r.w },
      height: exact ? { exact: r.h } : { ideal: r.h },
      frameRate: exact ? { exact: st.videoFps } : { ideal: st.videoFps },
    },
    audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
  });
  const tries = [mk(true, true), mk(true, false), mk(false, false)];
  let lastErr = null, stream = null, i = 0;
  for (; i < tries.length; i++) {
    try { stream = await navigator.mediaDevices.getUserMedia(tries[i]); break; } catch (e) { lastErr = e; }
  }
  if (!stream) throw lastErr || new Error('無法開啟錄影串流');
  S.videoExact = i === 0;
  S.videoNoAudio = i === 2;
  const t = stream.getVideoTracks()[0], s = t.getSettings();
  const got = (s.width || 0) + '×' + (s.height || 0) + ' @' + Math.round(s.frameRate || 0);
  if (!S.videoExact) {
    A.toast('此鏡頭無法達到 ' + st.videoRes + ' ' + st.videoFps + 'fps,實際使用 ' + got, 5000);
  }
  if (S.videoNoAudio) A.toast('沒有麥克風權限,將錄製無聲影片', 4000);
  return stream;
};

A.syncVideoOpts = () => {
  const st = A.settings;
  document.querySelectorAll('#segRes button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.videoRes));
  document.querySelectorAll('#segFps button').forEach((b) => b.classList.toggle('on', parseInt(b.dataset.v, 10) === st.videoFps));
};
async function optChanged() {
  A.syncVideoOpts();
  if (S.recording || A.busy || S.mode !== 'video') return;
  try { await A.restartLens(); } catch (e) { A.toast('套用失敗:' + A.errMsg(e), 4000); }
}
document.querySelectorAll('#segRes button').forEach((b) => {
  b.onclick = () => { if (S.recording) return; A.settings.videoRes = b.dataset.v; A.saveSettings(); optChanged(); };
});
document.querySelectorAll('#segFps button').forEach((b) => {
  b.onclick = () => { if (S.recording) return; A.settings.videoFps = parseInt(b.dataset.v, 10); A.saveSettings(); optChanged(); };
});

/* ------------------------------------------------------------------ 錄製(原生 Camera2 + 硬體編碼) */

let t0 = 0, timer = null, nativeRec = false;

function tick() {
  const s = Math.floor((performance.now() - t0) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  $('recBadge').textContent = '● REC ' + mm + ':' + ss;
}

A.nativeVideoZoom = () => {
  if (!nativeRec) return;
  const L = S.lens[S.lensKey];
  const base = L && L.base ? L.base : (L ? L.ratio : 1);
  const z = Math.max(1, S.Z / base);
  A.needNative().setVideoZoom({ zoom: z }).catch(() => {});
};

async function start() {
  const N = A.needNative();
  const L = S.lens[S.lensKey];
  if (!L) return;
  const st = A.settings, r = RES[st.videoRes] || RES['4K'];
  const rect = $('frame').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const base = L.base ? L.base : L.ratio;
  A.busy = true;
  A.hud('準備錄影', '切換為原生錄影…');
  // WebView 必須先釋放鏡頭,Camera2 才能獨占
  A.stopStream();
  await new Promise((res) => setTimeout(res, 250));
  document.body.classList.add('native-rec');
  let info;
  try {
    info = await N.startNativeVideo({
      cameraId: String(L.dev.id),
      width: r.w, height: r.h, fps: st.videoFps,
      bitrate: Math.round(r.bps * (st.videoFps >= 60 ? 1.5 : 1)),
      audio: true,
      mirror: !!(S.front && st.selfieMirror),
      left: Math.round(rect.left * dpr), top: Math.round(rect.top * dpr),
      w: Math.round(rect.width * dpr), h: Math.round(rect.height * dpr),
      zoom: Math.max(1, S.Z / base),
    });
  } catch (e) {
    document.body.classList.remove('native-rec');
    A.busy = false; A.hudHide();
    try { await A.restartLens(); } catch (e2) { /* ignore */ }
    throw e;
  }
  nativeRec = true;
  S.recording = true;
  A.busy = false;
  A.hudHide();
  const got = info.width + '×' + info.height + ' @' + info.fps + 'fps' + (info.audio ? '' : '(無聲)');
  A.toast('原生錄影 ' + got + (info.note ? ' — ' + info.note : ''), info.note ? 6000 : 2500);
  t0 = performance.now();
  $('recBadge').hidden = false;
  tick();
  timer = setInterval(tick, 500);
  $('btnShutter').classList.add('rec');
  if (navigator.vibrate) navigator.vibrate(20);
}

async function stop() {
  if (!nativeRec) return;
  nativeRec = false;
  clearInterval(timer);
  $('btnShutter').classList.remove('rec');
  $('recBadge').hidden = true;
  A.busy = true;
  A.hud('儲存影片', '請稍候…');
  try {
    await A.needNative().stopNativeVideo();
    A.toast('影片已儲存到 Movies/AICamera', 3500);
    A.refreshThumb();
  } catch (e) {
    A.toast('影片儲存失敗:' + A.errMsg(e), 6000);
  } finally {
    S.recording = false;
    document.body.classList.remove('native-rec');
    A.busy = false;
    A.hudHide();
    try { await A.restartLens(); A.applyPreviewZoom(); } catch (e) { A.toast('預覽恢復失敗:' + A.errMsg(e), 4000); }
  }
}

A.toggleRecord = async () => {
  if (A.busy && !S.recording) return;
  try {
    if (S.recording) await stop(); else await start();
  } catch (e) {
    S.recording = false; nativeRec = false;
    $('btnShutter').classList.remove('rec');
    $('recBadge').hidden = true;
    A.toast('錄影失敗:' + A.errMsg(e), 6000);
  }
};

// App 退到背景時,先把影片收尾
document.addEventListener('visibilitychange', () => { if (document.hidden && S.recording) stop(); });
})();
