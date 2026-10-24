/* 影片錄製:1080P / 2K / 4K / 8K,30 / 60 FPS */
(() => {
'use strict';
const A = window.A;
const $ = A.$;
const S = A.S;

const RES = {
  '1080P': { w: 1920, h: 1080, bps: 20e6 },
  '2K': { w: 2560, h: 1440, bps: 32e6 },
  '4K': { w: 3840, h: 2160, bps: 55e6 },
  '8K': { w: 7680, h: 4320, bps: 120e6 },
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

/* ------------------------------------------------------------------ 錄製 */

let rec = null, queue = Promise.resolve(), t0 = 0, timer = null, writeErr = null;

function pickMime() {
  const c = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function tick() {
  const s = Math.floor((performance.now() - t0) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  $('recBadge').textContent = '● REC ' + mm + ':' + ss;
}

async function start() {
  if (!window.MediaRecorder) { A.toast('此裝置的 WebView 不支援錄影'); return; }
  if (!S.stream) return;
  const mime = pickMime();
  if (!mime) { A.toast('找不到可用的影片編碼'); return; }
  const st = A.settings, r = RES[st.videoRes] || RES['4K'];
  const N = A.needNative();
  writeErr = null; queue = Promise.resolve();
  await N.beginVideo({ mime });
  let mr;
  try {
    mr = new MediaRecorder(S.stream, { mimeType: mime, videoBitsPerSecond: r.bps, audioBitsPerSecond: 192000 });
  } catch (e) {
    try { mr = new MediaRecorder(S.stream, { mimeType: mime }); }
    catch (e2) { await N.abortVideo(); throw e2; }
  }
  mr.ondataavailable = (ev) => {
    if (!ev.data || !ev.data.size) return;
    queue = queue.then(async () => {
      if (writeErr) return;
      try { await N.appendVideo({ data: await A.blobToBase64(ev.data) }); } catch (e) { writeErr = e; }
    });
  };
  rec = mr;
  mr.start(1000);
  S.recording = true;
  t0 = performance.now();
  $('recBadge').hidden = false;
  tick();
  timer = setInterval(() => {
    tick();
    if (writeErr) { A.toast('寫入失敗,停止錄影:' + A.errMsg(writeErr), 5000); stop(); }
  }, 500);
  $('btnShutter').classList.add('rec');
  if (navigator.vibrate) navigator.vibrate(20);
}

async function stop() {
  if (!rec) return;
  const mr = rec; rec = null;
  clearInterval(timer);
  $('btnShutter').classList.remove('rec');
  $('recBadge').hidden = true;
  A.busy = true;
  A.hud('儲存影片', '請稍候…');
  try {
    await new Promise((res) => { mr.onstop = res; try { mr.stop(); } catch (e) { res(); } });
    await queue;
    const N = A.needNative();
    if (writeErr) { await N.abortVideo(); throw writeErr; }
    await N.finishVideo();
    A.toast('影片已儲存到 Movies/AICamera', 3500);
    A.refreshThumb();
  } catch (e) {
    A.toast('影片儲存失敗:' + A.errMsg(e), 6000);
  } finally {
    S.recording = false;
    A.busy = false;
    A.hudHide();
  }
}

A.toggleRecord = async () => {
  if (A.busy && !S.recording) return;
  try {
    if (S.recording) await stop(); else await start();
  } catch (e) {
    S.recording = false;
    $('btnShutter').classList.remove('rec');
    $('recBadge').hidden = true;
    A.toast('錄影失敗:' + A.errMsg(e), 6000);
  }
};

// App 退到背景時,先把影片收尾
document.addEventListener('visibilitychange', () => { if (document.hidden && S.recording) stop(); });
})();
