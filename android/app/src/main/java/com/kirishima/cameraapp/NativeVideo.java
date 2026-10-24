package com.kirishima.cameraapp;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Range;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import androidx.core.content.ContextCompat;

import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 原生 Camera2 + MediaRecorder 錄影(硬體編碼,AAC 音訊,標準 MP4)。
 * 預覽以 TextureView 放在 WebView 後方(WebView 暫時設為透明)。
 */
final class NativeVideo {
    static final class Cfg {
        String cameraId;
        int width, height, fps, bitrate;
        boolean audio = true, torch, mirror;
        int left, top, w, h;       // 預覽區域(實體像素)
        String album = "AICamera";
    }

    int actualW, actualH, actualFps;
    boolean hasAudio;
    String note = "";

    private final Activity act;
    private final Cfg cfg;
    private final HandlerThread ht = new HandlerThread("nativevideo");
    private Handler h;
    private CameraDevice cam;
    private CameraCaptureSession session;
    private CameraCharacteristics cc;
    private MediaRecorder rec;
    private TextureView tv;
    private Surface previewSurface, recSurface;
    private CaptureRequest.Builder builder;
    private ParcelFileDescriptor pfd;
    private Uri uri;
    private Rect active;
    private float maxZoom = 1f, zoom = 1f;
    private volatile Throwable error;
    private boolean recording;
    private View webView;

    NativeVideo(Activity a, Cfg c) {
        act = a;
        cfg = c;
    }

    private static String stamp() {
        return new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date())
                + "_" + (System.currentTimeMillis() % 1000);
    }

    private void ui(Runnable r) throws InterruptedException {
        final CountDownLatch l = new CountDownLatch(1);
        act.runOnUiThread(() -> {
            try { r.run(); } finally { l.countDown(); }
        });
        l.await(5, TimeUnit.SECONDS);
    }

    void start(View webViewRef) throws IOException {
        webView = webViewRef;
        ht.start();
        h = new Handler(ht.getLooper());
        try {
            CameraManager cm = (CameraManager) act.getSystemService(Context.CAMERA_SERVICE);
            cc = cm.getCameraCharacteristics(cfg.cameraId);
            active = cc.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            Float mz = cc.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM);
            maxZoom = mz == null ? 1f : mz;
            StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) throw new IOException("讀不到鏡頭的串流設定");

            Size vs = pickVideoSize(map);
            actualW = vs.getWidth();
            actualH = vs.getHeight();
            int fps = cfg.fps;
            long minDur = map.getOutputMinFrameDuration(MediaRecorder.class, vs);
            if (minDur > 0) {
                int cap = (int) Math.floor(1e9 / minDur + 0.5);
                if (cap < fps) {
                    note += cfg.fps + "fps 在 " + actualW + "×" + actualH + " 不支援,改為 " + cap + "fps;";
                    fps = cap;
                }
            }
            actualFps = fps;
            Range<Integer> fr = pickFpsRange(fps);

            Size[] ps = map.getOutputSizes(SurfaceTexture.class);
            Size prev = pickPreview(ps, vs);

            // 預覽 View
            final CountDownLatch avail = new CountDownLatch(1);
            ui(() -> {
                tv = new TextureView(act);
                tv.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
                    @Override public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int hh) { avail.countDown(); }
                    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int hh) { }
                    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture s) { return true; }
                    @Override public void onSurfaceTextureUpdated(SurfaceTexture s) { }
                });
                FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.max(2, cfg.w), Math.max(2, cfg.h));
                lp.gravity = Gravity.TOP | Gravity.START;
                lp.leftMargin = cfg.left;
                lp.topMargin = cfg.top;
                ViewGroup content = act.findViewById(android.R.id.content);
                content.addView(tv, 0, lp);
                webView.setBackgroundColor(Color.TRANSPARENT);
            });
            if (!avail.await(4, TimeUnit.SECONDS)) throw new IOException("預覽畫面建立逾時");
            SurfaceTexture st = tv.getSurfaceTexture();
            st.setDefaultBufferSize(prev.getWidth(), prev.getHeight());
            previewSurface = new Surface(st);
            final Size prevF = prev;
            ui(() -> applyTransform(prevF));

            // 輸出檔
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, "VID_" + stamp() + ".mp4");
            v.put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/" + cfg.album);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            ContentResolver cr = act.getContentResolver();
            uri = cr.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("無法建立影片檔案");
            pfd = cr.openFileDescriptor(uri, "rw");
            if (pfd == null) throw new IOException("無法寫入影片檔案");

            hasAudio = cfg.audio && ContextCompat.checkSelfPermission(act, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            if (cfg.audio && !hasAudio) note += "沒有麥克風權限,錄製無聲影片;";
            rec = new MediaRecorder();
            if (hasAudio) rec.setAudioSource(MediaRecorder.AudioSource.CAMCORDER);
            rec.setVideoSource(MediaRecorder.VideoSource.SURFACE);
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            rec.setOutputFile(pfd.getFileDescriptor());
            rec.setVideoEncodingBitRate(cfg.bitrate);
            rec.setVideoFrameRate(fps);
            rec.setVideoSize(actualW, actualH);
            rec.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
            if (hasAudio) {
                rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
                rec.setAudioEncodingBitRate(160_000);
                rec.setAudioSamplingRate(48_000);
            }
            rec.setOrientationHint(orientationHint());
            rec.prepare();
            recSurface = rec.getSurface();

            // 擷取串流
            final CountDownLatch cfgL = new CountDownLatch(1);
            final boolean[] good = {false};
            List<Surface> outs = new ArrayList<>();
            outs.add(previewSurface);
            outs.add(recSurface);
            cam = openCamera(cm);
            cam.createCaptureSession(outs, new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession s) { session = s; good[0] = true; cfgL.countDown(); }
                @Override public void onConfigureFailed(CameraCaptureSession s) { cfgL.countDown(); }
            }, h);
            if (!cfgL.await(8, TimeUnit.SECONDS) || !good[0]) {
                throw new IOException("此鏡頭不支援 " + actualW + "×" + actualH + "@" + fps + "fps 錄影串流");
            }
            builder = cam.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            builder.addTarget(previewSurface);
            builder.addTarget(recSurface);
            builder.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
            builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
            if (fr != null) builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fr);
            int[] stab = cc.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES);
            if (stab != null) for (int m : stab) {
                if (m == CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_ON) {
                    builder.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, m);
                }
            }
            if (cfg.torch) builder.set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_TORCH);
            applyZoomTo(builder);
            session.setRepeatingRequest(builder.build(), null, h);
            rec.start();
            recording = true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            abort();
            throw new IOException("已中斷");
        } catch (CameraAccessException | SecurityException e) {
            abort();
            throw new IOException("無法存取鏡頭:" + e.getMessage());
        } catch (IOException | RuntimeException e) {
            abort();
            throw e instanceof IOException ? (IOException) e : new IOException(String.valueOf(e.getMessage()), e);
        }
    }

    private CameraDevice openCamera(CameraManager cm) throws CameraAccessException, InterruptedException, IOException {
        final CountDownLatch l = new CountDownLatch(1);
        final CameraDevice[] out = new CameraDevice[1];
        cm.openCamera(cfg.cameraId, new CameraDevice.StateCallback() {
            @Override public void onOpened(CameraDevice c) { out[0] = c; l.countDown(); }
            @Override public void onDisconnected(CameraDevice c) { error = new IOException("鏡頭中斷連線"); c.close(); l.countDown(); }
            @Override public void onError(CameraDevice c, int e) { error = new IOException("無法開啟鏡頭(錯誤碼 " + e + ")"); c.close(); l.countDown(); }
        }, h);
        if (!l.await(6, TimeUnit.SECONDS)) throw new IOException("開啟鏡頭逾時");
        if (out[0] == null) throw (error instanceof IOException ? (IOException) error : new IOException("無法開啟鏡頭"));
        return out[0];
    }

    private Size pickVideoSize(StreamConfigurationMap map) throws IOException {
        Size[] all = map.getOutputSizes(MediaRecorder.class);
        if (all == null || all.length == 0) throw new IOException("此鏡頭沒有可用的錄影尺寸");
        // 要求的是橫向尺寸(寬 > 高);先找完全相同的
        for (Size s : all) if (s.getWidth() == cfg.width && s.getHeight() == cfg.height) return s;
        long want = (long) cfg.width * cfg.height;
        Size best = null;
        for (Size s : all) {
            long px = (long) s.getWidth() * s.getHeight();
            boolean ar169 = Math.abs(s.getWidth() / (double) s.getHeight() - 16.0 / 9.0) < 0.03;
            if (ar169 && px <= want && (best == null || px > (long) best.getWidth() * best.getHeight())) best = s;
        }
        if (best == null) {
            for (Size s : all) {
                long px = (long) s.getWidth() * s.getHeight();
                if (px <= want && (best == null || px > (long) best.getWidth() * best.getHeight())) best = s;
            }
        }
        if (best == null) {
            best = all[0];
            for (Size s : all) if ((long) s.getWidth() * s.getHeight() < (long) best.getWidth() * best.getHeight()) best = s;
        }
        note += "此鏡頭沒有 " + cfg.width + "×" + cfg.height + ",改用 " + best.getWidth() + "×" + best.getHeight() + ";";
        return best;
    }

    private Range<Integer> pickFpsRange(int fps) {
        Range<Integer>[] rs = cc.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (rs == null) return null;
        Range<Integer> best = null;
        for (Range<Integer> r : rs) {
            if (r.getUpper() == fps && r.getLower() == fps) return r;
        }
        for (Range<Integer> r : rs) {
            if (r.getUpper() == fps && (best == null || r.getLower() > best.getLower())) best = r;
        }
        if (best == null) {
            for (Range<Integer> r : rs) if (r.getUpper() <= fps && (best == null || r.getUpper() > best.getUpper())) best = r;
        }
        return best;
    }

    private Size pickPreview(Size[] ps, Size vs) {
        if (ps == null || ps.length == 0) return new Size(1280, 720);
        double ar = vs.getWidth() / (double) vs.getHeight();
        Size best = null;
        for (Size s : ps) {
            long px = (long) s.getWidth() * s.getHeight();
            if (px > 1920L * 1080L) continue;
            if (Math.abs(s.getWidth() / (double) s.getHeight() - ar) > 0.03) continue;
            if (best == null || px > (long) best.getWidth() * best.getHeight()) best = s;
        }
        if (best != null) return best;
        for (Size s : ps) {
            long px = (long) s.getWidth() * s.getHeight();
            if (px <= 1920L * 1080L && (best == null || px > (long) best.getWidth() * best.getHeight())) best = s;
        }
        return best != null ? best : ps[ps.length - 1];
    }

    private int displayRotation() {
        try {
            WindowManager wm = (WindowManager) act.getSystemService(Context.WINDOW_SERVICE);
            int r = wm.getDefaultDisplay().getRotation();
            return r == Surface.ROTATION_90 ? 90 : r == Surface.ROTATION_180 ? 180 : r == Surface.ROTATION_270 ? 270 : 0;
        } catch (Throwable t) {
            return 0;
        }
    }

    private int orientationHint() {
        Integer so = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
        int sensor = so == null ? 90 : so;
        Integer lf = cc.get(CameraCharacteristics.LENS_FACING);
        if (lf != null && lf == CameraCharacteristics.LENS_FACING_FRONT) return (sensor + displayRotation()) % 360;
        return (sensor - displayRotation() + 360) % 360;
    }

    /** 讓 TextureView 以「滿版裁切」顯示(縱向手機)。 */
    private void applyTransform(Size prev) {
        if (tv == null) return;
        float viewW = cfg.w, viewH = cfg.h;
        float cw = prev.getHeight(), ch = prev.getWidth();   // 縱向顯示的內容尺寸
        if (displayRotation() % 180 != 0) { cw = prev.getWidth(); ch = prev.getHeight(); }
        float ca = cw / ch, va = viewW / viewH;
        float sx = 1f, sy = 1f;
        if (va > ca) sy = va / ca; else sx = ca / va;
        Matrix m = new Matrix();
        m.postScale(sx, sy, viewW / 2f, viewH / 2f);
        if (cfg.mirror) m.postScale(-1f, 1f, viewW / 2f, viewH / 2f);
        tv.setTransform(m);
    }

    private void applyZoomTo(CaptureRequest.Builder b) {
        float z = Math.max(1f, Math.min(zoom, maxZoom));
        if (Build.VERSION.SDK_INT >= 30) {
            Range<Float> zr = cc.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
            if (zr != null) {
                float zz = Math.max(zr.getLower(), Math.min(zr.getUpper(), z));
                b.set(CaptureRequest.CONTROL_ZOOM_RATIO, zz);
                return;
            }
        }
        if (active != null && z > 1.01f) {
            int cw = Math.round(active.width() / z), ch = Math.round(active.height() / z);
            int cx = active.centerX(), cy = active.centerY();
            b.set(CaptureRequest.SCALER_CROP_REGION, new Rect(cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2));
        }
    }

    void setZoom(float z) {
        zoom = z;
        if (builder == null || session == null) return;
        try {
            applyZoomTo(builder);
            session.setRepeatingRequest(builder.build(), null, h);
        } catch (Throwable ignored) {
        }
    }

    /** 停止錄影並發佈檔案,回傳 uri。 */
    Uri stop() throws IOException {
        IOException fail = null;
        try {
            if (recording) {
                recording = false;
                try { session.stopRepeating(); } catch (Throwable ignored) { }
                try { rec.stop(); } catch (RuntimeException e) { fail = new IOException("錄影太短或編碼器失敗:" + e.getMessage()); }
            }
        } finally {
            release();
        }
        if (fail != null) {
            discard();
            throw fail;
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        act.getContentResolver().update(uri, v, null, null);
        return uri;
    }

    void abort() {
        recording = false;
        release();
        discard();
    }

    private void discard() {
        try {
            if (uri != null) act.getContentResolver().delete(uri, null, null);
        } catch (Throwable ignored) {
        }
        uri = null;
    }

    private void release() {
        try { if (session != null) session.close(); } catch (Throwable ignored) { }
        try { if (cam != null) cam.close(); } catch (Throwable ignored) { }
        try { if (rec != null) rec.release(); } catch (Throwable ignored) { }
        try { if (pfd != null) pfd.close(); } catch (Throwable ignored) { }
        try { if (previewSurface != null) previewSurface.release(); } catch (Throwable ignored) { }
        session = null; cam = null; rec = null; pfd = null; previewSurface = null;
        final TextureView t = tv;
        tv = null;
        if (t != null) {
            act.runOnUiThread(() -> {
                try {
                    ViewGroup p = (ViewGroup) t.getParent();
                    if (p != null) p.removeView(t);
                    if (webView != null) webView.setBackgroundColor(Color.BLACK);
                } catch (Throwable ignored) {
                }
            });
        }
        try { Thread.sleep(150); } catch (InterruptedException ignored) { }
        ht.quitSafely();
    }
}
