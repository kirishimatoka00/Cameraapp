package com.kirishima.cameraapp;

import android.app.Activity;
import android.content.Context;
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
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** 原生 Camera2 即時預覽(用於 WebView 看不到的隱藏鏡頭,例如 Note 10+ 的望遠 ID 52)。 */
final class NativePreview {
    private final Activity act;
    private final String cameraId;
    private final int left, top, vw, vh;
    private final boolean mirror;
    private final HandlerThread ht = new HandlerThread("nativepreview");
    private Handler h;
    private CameraDevice cam;
    private CameraCaptureSession session;
    private CameraCharacteristics cc;
    private CaptureRequest.Builder builder;
    private TextureView tv;
    private Surface surface;
    private View webView;
    private Rect active;
    private float zoom = 1f;
    private boolean torch;
    private Rect cropRect;
    private float coverSx = 1f, coverSy = 1f;
    private volatile float cAspect = 4f / 3f;   // 直立內容的 高/寬
    private volatile Throwable error;
    private long expNs = 0;
    private int isoVal = 0;
    private float focusMeters = 0f;
    private float evVal = 0f;
    String info = "";

    NativePreview(Activity a, String id, int left, int top, int w, int h, boolean mirror) {
        act = a;
        cameraId = id;
        this.left = left;
        this.top = top;
        this.vw = w;
        this.vh = h;
        this.mirror = mirror;
    }

    void setInitialZoom(float z, boolean torch) {
        zoom = z;
        this.torch = torch;
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

    void start(View webViewRef) throws IOException {
        webView = webViewRef;
        ht.start();
        h = new Handler(ht.getLooper());
        try {
            CameraManager cm = (CameraManager) act.getSystemService(Context.CAMERA_SERVICE);
            try {
                cc = cm.getCameraCharacteristics(cameraId);
                active = cc.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            } catch (Throwable t) {
                cc = null;
            }
            List<Size> sizes = new ArrayList<>();
            if (cc != null) {
                StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (map != null) {
                    Size[] ps = map.getOutputSizes(SurfaceTexture.class);
                    if (ps != null) {
                        Size best = null;
                        for (Size s : ps) {
                            long px = (long) s.getWidth() * s.getHeight();
                            if (px > 1920L * 1080L) continue;
                            if (Math.abs(s.getWidth() / (double) s.getHeight() - 4.0 / 3.0) > 0.03) continue;
                            if (best == null || px > (long) best.getWidth() * best.getHeight()) best = s;
                        }
                        if (best != null) sizes.add(best);
                    }
                }
            }
            for (int[] g : new int[][]{{1440, 1080}, {1280, 960}, {1024, 768}, {800, 600}, {640, 480}, {320, 240}}) {
                Size s = new Size(g[0], g[1]);
                if (!sizes.contains(s)) sizes.add(s);
            }

            final CountDownLatch avail = new CountDownLatch(1);
            act.runOnUiThread(() -> {
                tv = new TextureView(act);
                tv.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
                    @Override public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int hh) { avail.countDown(); }
                    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int hh) { }
                    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture s) { return true; }
                    @Override public void onSurfaceTextureUpdated(SurfaceTexture s) { }
                });
                FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.max(2, vw), Math.max(2, vh));
                lp.gravity = Gravity.TOP | Gravity.START;
                lp.leftMargin = left;
                lp.topMargin = top;
                ((ViewGroup) act.findViewById(android.R.id.content)).addView(tv, 0, lp);
                webView.setBackgroundColor(Color.TRANSPARENT);
            });
            if (!avail.await(4, TimeUnit.SECONDS)) throw new IOException("預覽畫面建立逾時");

            cam = open(cm);
            StringBuilder tried = new StringBuilder();
            boolean ok = false;
            SurfaceTexture st = tv.getSurfaceTexture();
            for (Size s : sizes) {
                st.setDefaultBufferSize(s.getWidth(), s.getHeight());
                surface = new Surface(st);
                final CountDownLatch l = new CountDownLatch(1);
                final boolean[] good = {false};
                tried.append(s.getWidth()).append('x').append(s.getHeight()).append(' ');
                try {
                    cam.createCaptureSession(java.util.Collections.singletonList(surface), new CameraCaptureSession.StateCallback() {
                        @Override public void onConfigured(CameraCaptureSession c) { session = c; good[0] = true; l.countDown(); }
                        @Override public void onConfigureFailed(CameraCaptureSession c) { l.countDown(); }
                    }, h);
                } catch (Throwable t) {
                    l.countDown();
                }
                l.await(6, TimeUnit.SECONDS);
                if (good[0]) {
                    ok = true;
                    info = s.getWidth() + "x" + s.getHeight();
                    final Size sz = s;
                    final CountDownLatch t2 = new CountDownLatch(1);
                    act.runOnUiThread(() -> { applyTransform(sz); t2.countDown(); });
                    t2.await(2, TimeUnit.SECONDS);
                    break;
                }
                try { surface.release(); } catch (Throwable ignored) { }
                surface = null;
            }
            if (!ok) throw new IOException("此鏡頭無法建立預覽(試了 " + tried.toString().trim() + ")");

            builder = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(surface);
            builder.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
            builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            builder.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            if (torch) builder.set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_TORCH);
            applyZoom();
            applyControls();
            session.setRepeatingRequest(builder.build(), null, h);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            stop();
            throw new IOException("已中斷");
        } catch (CameraAccessException | SecurityException e) {
            stop();
            throw new IOException("無法存取鏡頭:" + e.getMessage());
        } catch (IOException | RuntimeException e) {
            stop();
            throw e instanceof IOException ? (IOException) e : new IOException(String.valueOf(e.getMessage()), e);
        }
    }

    private CameraDevice open(CameraManager cm) throws CameraAccessException, InterruptedException, IOException {
        final CountDownLatch l = new CountDownLatch(1);
        final CameraDevice[] out = new CameraDevice[1];
        cm.openCamera(cameraId, new CameraDevice.StateCallback() {
            @Override public void onOpened(CameraDevice c) { out[0] = c; l.countDown(); }
            @Override public void onDisconnected(CameraDevice c) { error = new IOException("鏡頭中斷連線"); c.close(); l.countDown(); }
            @Override public void onError(CameraDevice c, int e) { error = new IOException("無法開啟鏡頭 " + cameraId + "(錯誤碼 " + e + ")"); c.close(); l.countDown(); }
        }, h);
        if (!l.await(6, TimeUnit.SECONDS)) throw new IOException("開啟鏡頭逾時");
        if (out[0] == null) throw (error instanceof IOException ? (IOException) error : new IOException("無法開啟鏡頭"));
        return out[0];
    }

    /** 讓 TextureView 以滿版裁切顯示(縱向手機)。 */
    private void applyTransform(Size prev) {
        if (tv == null) return;
        float viewW = vw, viewH = vh;
        float cw = prev.getHeight(), ch = prev.getWidth();
        if (displayRotation() % 180 != 0) { cw = prev.getWidth(); ch = prev.getHeight(); }
        float ca = cw / ch, va = viewW / viewH;
        cAspect = ch / cw;
        float sx = 1f, sy = 1f;
        if (va > ca) sy = va / ca; else sx = ca / va;
        Matrix m = new Matrix();
        coverSx = sx;
        coverSy = sy;
        m.postScale(sx, sy, viewW / 2f, viewH / 2f);
        if (mirror) m.postScale(-1f, 1f, viewW / 2f, viewH / 2f);
        tv.setTransform(m);
    }

    private void applyZoom() {
        if (builder == null || active == null) return;
        float z = Math.max(1f, zoom);
        if (z > 1.01f) {
            int cw = Math.round(active.width() / z), ch = Math.round(active.height() / z);
            int cx = active.centerX(), cy = active.centerY();
            cropRect = new Rect(cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2);
        } else {
            cropRect = new Rect(active);
        }
        builder.set(CaptureRequest.SCALER_CROP_REGION, cropRect);
    }

    /** 手動控制能力(單位與 WebView 版一致:快門 100µs、對焦距離公尺)。 */
    org.json.JSONObject caps() {
        org.json.JSONObject o = new org.json.JSONObject();
        if (cc == null) return o;
        try {
            android.util.Range<Long> et = cc.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
            if (et != null) o.put("exposureTime", new org.json.JSONObject().put("min", et.getLower() / 1e5).put("max", Math.min(et.getUpper(), 1_000_000_000L) / 1e5));
            android.util.Range<Integer> is = cc.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
            if (is != null) o.put("iso", new org.json.JSONObject().put("min", is.getLower()).put("max", is.getUpper()));
            android.util.Range<Integer> ec = cc.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
            android.util.Rational step = cc.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
            if (ec != null && step != null && ec.getUpper() > 0) {
                double st = step.doubleValue();
                o.put("exposureCompensation", new org.json.JSONObject().put("min", ec.getLower() * st).put("max", ec.getUpper() * st).put("step", st));
            }
            Float minD = cc.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
            if (minD != null && minD > 0f) o.put("focusDistance", new org.json.JSONObject().put("min", 1.0 / minD).put("max", 10.0));
            Boolean fl = cc.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            o.put("torch", fl != null && fl);
        } catch (Throwable ignored) {
        }
        return o;
    }

    /** exposureMs/iso/focusMeters 為 0 代表自動;ev 只在自動曝光時有效。 */
    void setManual(double exposureMs, int iso, float focusM, float ev) {
        expNs = exposureMs > 0 ? Math.round(exposureMs * 1e6) : 0;
        isoVal = iso;
        focusMeters = focusM;
        evVal = ev;
        if (builder == null || session == null) return;
        try {
            applyControls();
            session.setRepeatingRequest(builder.build(), null, h);
        } catch (Throwable ignored) {
        }
    }

    private void applyControls() {
        if (builder == null || cc == null) return;
        if (expNs > 0) {
            android.util.Range<Long> et = cc.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
            android.util.Range<Integer> is = cc.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
            long t = et == null ? expNs : Math.max(et.getLower(), Math.min(et.getUpper(), expNs));
            int iso = isoVal > 0 ? isoVal : 100;
            if (is != null) iso = Math.max(is.getLower(), Math.min(is.getUpper(), iso));
            builder.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
            builder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, t);
            builder.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
        } else {
            builder.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            android.util.Rational step = cc.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
            if (step != null && step.doubleValue() > 0)
                builder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, (int) Math.round(evVal / step.doubleValue()));
        }
        if (focusMeters > 0f) {
            Float minD = cc.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
            float dio = 1f / focusMeters;
            if (minD != null) dio = Math.max(0f, Math.min(minD, dio));
            builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF);
            builder.set(CaptureRequest.LENS_FOCUS_DISTANCE, dio);
        } else {
            builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
        }
    }

    void setZoom(float z) {
        zoom = z;
        if (builder == null || session == null) return;
        try {
            applyZoom();
            session.setRepeatingRequest(builder.build(), null, h);
        } catch (Throwable ignored) {
        }
    }


    /** 以預覽內容(直立、0..1)座標對焦並測光。 */
    void focusAt(float u, float v) {
        if (focusMeters > 0f) return;   // 手動對焦時不做點擊對焦
        if (builder == null || session == null || cc == null || active == null) return;
        try {
            Integer so = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
            Integer lf = cc.get(CameraCharacteristics.LENS_FACING);
            int sensor = so == null ? 90 : so;
            boolean front = lf != null && lf == CameraCharacteristics.LENS_FACING_FRONT;
            int rot = front ? (sensor + displayRotation()) % 360 : (sensor - displayRotation() + 360) % 360;
            float sx, sy;
            if (rot == 90) { sx = v; sy = 1f - u; }
            else if (rot == 180) { sx = 1f - u; sy = 1f - v; }
            else if (rot == 270) { sx = 1f - v; sy = u; }
            else { sx = u; sy = v; }
            Rect c = cropRect != null ? cropRect : active;
            int px = c.left + Math.round(sx * c.width()), py = c.top + Math.round(sy * c.height());
            int half = Math.max(16, active.width() / 14);
            Rect r = new Rect(Math.max(active.left, px - half), Math.max(active.top, py - half),
                    Math.min(active.right - 1, px + half), Math.min(active.bottom - 1, py + half));
            android.hardware.camera2.params.MeteringRectangle[] regs = {
                    new android.hardware.camera2.params.MeteringRectangle(r, 1000)};
            Integer maxAf = cc.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
            Integer maxAe = cc.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
            if (maxAf != null && maxAf > 0) builder.set(CaptureRequest.CONTROL_AF_REGIONS, regs);
            if (maxAe != null && maxAe > 0) builder.set(CaptureRequest.CONTROL_AE_REGIONS, regs);
            // 連續對焦模式下 TRIGGER_START 只會「鎖定現況」,不會重新掃描;改用 AUTO 才會真的對焦
            builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
            builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_CANCEL);
            session.capture(builder.build(), null, h);
            builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START);
            session.capture(builder.build(), null, h);
            builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_IDLE);
            session.setRepeatingRequest(builder.build(), null, h);
            h.removeCallbacksAndMessages("release");
            h.postAtTime(() -> {
                try {
                    if (builder == null || session == null) return;
                    builder.set(CaptureRequest.CONTROL_AF_REGIONS, null);
                    builder.set(CaptureRequest.CONTROL_AE_REGIONS, null);
                    builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                    builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_CANCEL);
                    session.capture(builder.build(), null, h);
                    builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_IDLE);
                    session.setRepeatingRequest(builder.build(), null, h);
                } catch (Throwable ignored) {
                }
            }, "release", android.os.SystemClock.uptimeMillis() + 5000);
        } catch (Throwable ignored) {
        }
    }

    /** 擷取目前預覽畫面(直立,寬度縮到 width),回傳 JPEG;失敗回傳 null。 */
    android.graphics.Bitmap grab(int width) {
        final TextureView t = tv;
        if (t == null) return null;
        final android.graphics.Bitmap[] out = new android.graphics.Bitmap[1];
        final CountDownLatch l = new CountDownLatch(1);
        act.runOnUiThread(() -> {
            try {
                out[0] = t.getBitmap(width, Math.round(width * cAspect));
            } catch (Throwable ignored) {
            }
            l.countDown();
        });
        try { l.await(1, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        return out[0];
    }

    void stop() {
        try { if (session != null) session.close(); } catch (Throwable ignored) { }
        try { if (cam != null) cam.close(); } catch (Throwable ignored) { }
        try { if (surface != null) surface.release(); } catch (Throwable ignored) { }
        session = null;
        cam = null;
        surface = null;
        final TextureView t = tv;
        tv = null;
        if (t != null) {
            final CountDownLatch l = new CountDownLatch(1);
            act.runOnUiThread(() -> {
                try {
                    ViewGroup p = (ViewGroup) t.getParent();
                    if (p != null) p.removeView(t);
                    if (webView != null) webView.setBackgroundColor(Color.BLACK);
                } catch (Throwable ignored) {
                }
                l.countDown();
            });
            try { l.await(2, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        }
        try { Thread.sleep(200); } catch (InterruptedException ignored) { }
        ht.quitSafely();
    }
}
