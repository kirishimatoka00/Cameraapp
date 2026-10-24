package com.kirishima.cameraapp;

import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.DngCreator;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 以 Camera2 直接拍一張(可同時輸出 RAW/DNG 與 JPEG),支援手動曝光/對焦。
 * 會獨占鏡頭,呼叫前必須先釋放 WebView 的預覽串流。可開啟 WebView 看不到的鏡頭 ID。
 */
final class NativeShot {
    static final class Req {
        String cameraId;
        boolean raw, jpeg = true;
        long exposureNs;          // >0 = 手動曝光
        int iso;                  // 手動曝光時使用
        float focusMeters;        // >0 = 手動對焦(公尺)
        float ev;                 // 自動曝光時的曝光補償
        int jpegQuality = 95;
        boolean torch;
    }

    static final class Result {
        byte[] jpeg, dng;
        int jpegOrientationDeg;
        int width, height;
        StringBuilder notes = new StringBuilder();
    }

    private final Context ctx;
    private final Req req;
    private final Result res = new Result();
    private final HandlerThread ht = new HandlerThread("nativeshot");
    private Handler h;

    private CameraDevice cam;
    private CameraCaptureSession session;
    private CameraCharacteristics cc;
    private ImageReader jpegReader, rawReader;
    private SurfaceTexture st;
    private Surface previewSurface;

    private volatile Throwable error;
    private final CountDownLatch opened = new CountDownLatch(1);
    private final CountDownLatch ready = new CountDownLatch(1);
    private volatile int framesSeen;
    private volatile TotalCaptureResult stillResult;
    private final CountDownLatch gotResult = new CountDownLatch(1);
    private volatile CountDownLatch gotJpeg = new CountDownLatch(1);
    private volatile CountDownLatch gotRaw = new CountDownLatch(1);
    private Image rawImage;

    private NativeShot(Context c, Req r) {
        ctx = c;
        req = r;
    }

    static Result shoot(Context c, Req r) throws IOException {
        return new NativeShot(c, r).run();
    }

    private Result run() throws IOException {
        ht.start();
        h = new Handler(ht.getLooper());
        try {
            CameraManager cm = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
            try {
                cc = cm.getCameraCharacteristics(req.cameraId);
            } catch (Throwable t) {
                cc = null;
                res.notes.append("讀不到鏡頭 ").append(req.cameraId).append(" 的規格,改用預設尺寸;");
            }

            Size jpegSize = new Size(4000, 3000), rawSize = null, prevSize = new Size(640, 480);
            boolean rawOk = false;
            if (cc != null) {
                StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (map != null) {
                    Size[] js = map.getOutputSizes(ImageFormat.JPEG);
                    if (js != null && js.length > 0) jpegSize = largest(js);
                    Size[] ps = map.getOutputSizes(SurfaceTexture.class);
                    if (ps != null && ps.length > 0) prevSize = pickPreview(ps);
                    Size[] rs = map.getOutputSizes(ImageFormat.RAW_SENSOR);
                    if (rs != null && rs.length > 0) {
                        rawSize = largest(rs);
                        rawOk = true;
                    }
                }
            }
            if (req.raw && !rawOk) res.notes.append("此鏡頭沒有 RAW 輸出,只存 JPEG;");
            final boolean wantRaw = req.raw && rawOk;
            final boolean wantJpeg = req.jpeg || !wantRaw;

            // 依序嘗試不同的輸出尺寸組合(隱藏鏡頭常不接受最大尺寸)
            List<Size> jpegCands = new ArrayList<>();
            List<Size> prevCands = new ArrayList<>();
            if (cc != null) {
                StreamConfigurationMap map2 = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (map2 != null) {
                    Size[] js = map2.getOutputSizes(ImageFormat.JPEG);
                    if (js != null) {
                        List<Size> sorted = new ArrayList<>(java.util.Arrays.asList(js));
                        java.util.Collections.sort(sorted, (x, y) -> Long.compare((long) y.getWidth() * y.getHeight(), (long) x.getWidth() * x.getHeight()));
                        jpegCands.add(sorted.get(0));
                        for (Size z : sorted) {
                            long px = (long) z.getWidth() * z.getHeight();
                            if (jpegCands.size() < 4 && px <= 12_500_000L && !jpegCands.contains(z)
                                    && Math.abs(z.getWidth() / (double) z.getHeight() - 4.0 / 3.0) < 0.02) jpegCands.add(z);
                        }
                        for (Size z : sorted) {
                            long px = (long) z.getWidth() * z.getHeight();
                            if (px <= 2_200_000L && !jpegCands.contains(z)) { jpegCands.add(z); break; }
                        }
                    }
                    Size[] ps = map2.getOutputSizes(SurfaceTexture.class);
                    if (ps != null && ps.length > 0) {
                        prevCands.add(pickPreview(ps));
                        Size small = ps[ps.length - 1];
                        for (Size z : ps) if ((long) z.getWidth() * z.getHeight() < (long) small.getWidth() * small.getHeight()) small = z;
                        if (!prevCands.contains(small)) prevCands.add(small);
                    }
                }
            }
            if (jpegCands.isEmpty()) jpegCands.add(jpegSize);
            if (prevCands.isEmpty()) prevCands.add(prevSize);

            cm.openCamera(req.cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice c) { cam = c; opened.countDown(); }
                @Override public void onDisconnected(CameraDevice c) { error = new IOException("鏡頭中斷連線"); c.close(); opened.countDown(); }
                @Override public void onError(CameraDevice c, int e) { error = new IOException("無法開啟鏡頭 " + req.cameraId + "(錯誤碼 " + e + ")"); c.close(); opened.countDown(); }
            }, h);
            if (!opened.await(6, TimeUnit.SECONDS)) throw new IOException("開啟鏡頭逾時");
            check();

            boolean ok = false;
            StringBuilder tried = new StringBuilder();
            outer:
            for (Size js : jpegCands) {
                for (Size ps : prevCands) {
                    for (int rawMode = (wantRaw ? 1 : 0); rawMode >= 0; rawMode--) {
                        tried.append(ps.getWidth()).append('x').append(ps.getHeight()).append('+')
                                .append(js.getWidth()).append('x').append(js.getHeight()).append(rawMode == 1 ? "+RAW " : " ");
                        if (configure(ps, js, rawSize, wantJpeg || rawMode == 0, rawMode == 1)) {
                            ok = true;
                            if (wantRaw && rawMode == 0) res.notes.append("此鏡頭無法同時輸出 RAW,只存 JPEG;");
                            break outer;
                        }
                    }
                }
            }
            if (!ok) {
                Integer lvl = cc == null ? null : cc.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
                throw new IOException("此鏡頭不接受任何輸出組合(硬體等級 " + lvl + ",已試 " + tried.toString().trim() + ")");
            }
            final boolean useRaw = rawActive;
            check();

            // 預覽(讓 AE / AF 收斂)
            final boolean manualExp = req.exposureNs > 0;
            final boolean manualFocus = req.focusMeters > 0 && cc != null;
            CaptureRequest.Builder pb = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            pb.addTarget(previewSurface);
            applyCommon(pb, manualExp, manualFocus);
            pb.set(CaptureRequest.CONTROL_AF_MODE, manualFocus ? CameraMetadata.CONTROL_AF_MODE_OFF
                    : CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            session.setRepeatingRequest(pb.build(), new CameraCaptureSession.CaptureCallback() {
                @Override
                public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest r, TotalCaptureResult tr) {
                    framesSeen++;
                    Integer ae = tr.get(CaptureResult.CONTROL_AE_STATE);
                    Integer af = tr.get(CaptureResult.CONTROL_AF_STATE);
                    boolean aeOk = manualExp || ae == null || ae == CaptureResult.CONTROL_AE_STATE_CONVERGED
                            || ae == CaptureResult.CONTROL_AE_STATE_LOCKED || ae == CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED;
                    boolean afOk = manualFocus || af == null || af == CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED
                            || af == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED || af == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED;
                    if (framesSeen >= 10 && aeOk && afOk) ready.countDown();
                }
            }, h);
            long waitMs = 2500 + (manualExp ? req.exposureNs / 1_000_000L * 3 : 0);
            if (!ready.await(Math.min(waitMs, 20_000L), TimeUnit.MILLISECONDS)) {
                res.notes.append("自動曝光/對焦未完全收斂,仍已拍攝;");
            }
            check();
            try { session.stopRepeating(); } catch (Throwable ignored) { }

            // 靜態拍攝
            CaptureRequest.Builder sb = cam.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            if (jpegReader != null) sb.addTarget(jpegReader.getSurface());
            if (useRaw) sb.addTarget(rawReader.getSurface());
            applyCommon(sb, manualExp, manualFocus);
            sb.set(CaptureRequest.CONTROL_AF_MODE, manualFocus ? CameraMetadata.CONTROL_AF_MODE_OFF
                    : CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            int orient = jpegOrientation();
            res.jpegOrientationDeg = orient;
            sb.set(CaptureRequest.JPEG_ORIENTATION, orient);
            sb.set(CaptureRequest.JPEG_QUALITY, (byte) req.jpegQuality);
            session.capture(sb.build(), new CameraCaptureSession.CaptureCallback() {
                @Override public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest r, TotalCaptureResult tr) {
                    stillResult = tr;
                    gotResult.countDown();
                }
                @Override public void onCaptureFailed(CameraCaptureSession s, CaptureRequest r, android.hardware.camera2.CaptureFailure f) {
                    error = new IOException("拍攝失敗(原因 " + f.getReason() + ")");
                    gotResult.countDown(); gotJpeg.countDown(); gotRaw.countDown();
                }
            }, h);

            long cap = 10_000L + (manualExp ? req.exposureNs / 1_000_000L * 2 : 0);
            if (!gotResult.await(cap, TimeUnit.MILLISECONDS)) throw new IOException("等待拍攝結果逾時");
            check();
            if (!gotJpeg.await(8, TimeUnit.SECONDS)) throw new IOException("等待 JPEG 逾時");
            if (!gotRaw.await(8, TimeUnit.SECONDS)) throw new IOException("等待 RAW 逾時");
            check();

            if (useRaw && rawImage != null && cc != null && stillResult != null) {
                DngCreator dng = new DngCreator(cc, stillResult);
                dng.setOrientation(exifOrientation(orient));
                ByteArrayOutputStream bos = new ByteArrayOutputStream(rawSize.getWidth() * rawSize.getHeight() * 2 + (1 << 20));
                dng.writeImage(bos, rawImage);
                dng.close();
                res.dng = bos.toByteArray();
                if (res.jpeg == null) {
                    res.width = rawSize.getWidth();
                    res.height = rawSize.getHeight();
                }
            }
            return res;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("已中斷");
        } catch (CameraAccessException | SecurityException e) {
            throw new IOException("無法存取鏡頭 " + req.cameraId + ":" + e.getMessage());
        } finally {
            cleanup();
        }
    }


    private volatile boolean rawActive;

    /** 建立 ImageReader + 擷取串流;成功回傳 true。失敗時會清掉這次建立的資源。 */
    private boolean configure(Size prev, Size jpegSz, Size rawSz, boolean wantJpeg, boolean useRaw) throws InterruptedException {
        releaseOutputs();
        gotJpeg = new CountDownLatch(wantJpeg ? 1 : 0);
        gotRaw = new CountDownLatch(useRaw ? 1 : 0);
        rawActive = useRaw;
        List<Surface> outs = new ArrayList<>();
        st = new SurfaceTexture(false);
        st.setDefaultBufferSize(prev.getWidth(), prev.getHeight());
        previewSurface = new Surface(st);
        outs.add(previewSurface);
        if (wantJpeg) {
            jpegReader = ImageReader.newInstance(jpegSz.getWidth(), jpegSz.getHeight(), ImageFormat.JPEG, 2);
            jpegReader.setOnImageAvailableListener(rd -> {
                try (Image im = rd.acquireNextImage()) {
                    if (im != null && res.jpeg == null) {
                        ByteBuffer b = im.getPlanes()[0].getBuffer();
                        byte[] a = new byte[b.remaining()];
                        b.get(a);
                        res.jpeg = a;
                        res.width = im.getWidth();
                        res.height = im.getHeight();
                        gotJpeg.countDown();
                    }
                } catch (Throwable t) {
                    error = t;
                    gotJpeg.countDown();
                }
            }, h);
            outs.add(jpegReader.getSurface());
        }
        if (useRaw) {
            rawReader = ImageReader.newInstance(rawSz.getWidth(), rawSz.getHeight(), ImageFormat.RAW_SENSOR, 2);
            rawReader.setOnImageAvailableListener(rd -> {
                try {
                    Image im = rd.acquireNextImage();
                    if (im != null) {
                        if (rawImage == null) {
                            rawImage = im;
                            gotRaw.countDown();
                        } else {
                            im.close();
                        }
                    }
                } catch (Throwable t) {
                    error = t;
                    gotRaw.countDown();
                }
            }, h);
            outs.add(rawReader.getSurface());
        }
        final CountDownLatch cfg = new CountDownLatch(1);
        final boolean[] good = {false};
        try {
            cam.createCaptureSession(outs, new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession s) { session = s; good[0] = true; cfg.countDown(); }
                @Override public void onConfigureFailed(CameraCaptureSession s) { cfg.countDown(); }
            }, h);
        } catch (CameraAccessException | IllegalArgumentException | IllegalStateException e) {
            return false;
        }
        if (!cfg.await(6, TimeUnit.SECONDS)) return false;
        return good[0];
    }

    private void releaseOutputs() {
        try { if (session != null) session.close(); } catch (Throwable ignored) { }
        session = null;
        try { if (jpegReader != null) jpegReader.close(); } catch (Throwable ignored) { }
        try { if (rawReader != null) rawReader.close(); } catch (Throwable ignored) { }
        try { if (previewSurface != null) previewSurface.release(); } catch (Throwable ignored) { }
        try { if (st != null) st.release(); } catch (Throwable ignored) { }
        jpegReader = null; rawReader = null; previewSurface = null; st = null;
        rawImage = null;
        res.jpeg = null;
    }

    private void check() throws IOException {
        if (error != null) {
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException(String.valueOf(error.getMessage()), error);
        }
    }

    private void applyCommon(CaptureRequest.Builder b, boolean manualExp, boolean manualFocus) {
        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
        b.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_AUTO);
        if (manualExp) {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
            long t = req.exposureNs;
            int iso = req.iso > 0 ? req.iso : 100;
            if (cc != null) {
                Range<Long> er = cc.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
                if (er != null) t = Math.max(er.getLower(), Math.min(er.getUpper(), t));
                Range<Integer> ir = cc.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                if (ir != null) iso = Math.max(ir.getLower(), Math.min(ir.getUpper(), iso));
            }
            b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, t);
            b.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
        } else {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            if (cc != null && req.ev != 0f) {
                android.util.Rational step = cc.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
                Range<Integer> rg = cc.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
                if (step != null && rg != null && step.floatValue() > 0f) {
                    int idx = Math.round(req.ev / step.floatValue());
                    idx = Math.max(rg.getLower(), Math.min(rg.getUpper(), idx));
                    b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, idx);
                }
            }
        }
        if (manualFocus) {
            float diopter = 1f / Math.max(0.05f, req.focusMeters);
            Float min = cc.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
            if (min != null && min > 0f) diopter = Math.min(diopter, min);
            b.set(CaptureRequest.LENS_FOCUS_DISTANCE, diopter);
        }
        if (req.torch) b.set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_TORCH);
    }

    private int jpegOrientation() {
        int sensor = 90;
        boolean front = false;
        if (cc != null) {
            Integer so = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
            if (so != null) sensor = so;
            Integer f = cc.get(CameraCharacteristics.LENS_FACING);
            front = f != null && f == CameraCharacteristics.LENS_FACING_FRONT;
        }
        int rot = 0;
        try {
            WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            int r = wm.getDefaultDisplay().getRotation();
            rot = r == Surface.ROTATION_90 ? 90 : r == Surface.ROTATION_180 ? 180 : r == Surface.ROTATION_270 ? 270 : 0;
        } catch (Throwable ignored) { }
        return front ? (sensor + rot) % 360 : (sensor - rot + 360) % 360;
    }

    private static int exifOrientation(int deg) {
        switch (deg) {
            case 90: return android.media.ExifInterface.ORIENTATION_ROTATE_90;
            case 180: return android.media.ExifInterface.ORIENTATION_ROTATE_180;
            case 270: return android.media.ExifInterface.ORIENTATION_ROTATE_270;
            default: return android.media.ExifInterface.ORIENTATION_NORMAL;
        }
    }

    private static Size largest(Size[] a) {
        Size best = a[0];
        for (Size s : a) if ((long) s.getWidth() * s.getHeight() > (long) best.getWidth() * best.getHeight()) best = s;
        return best;
    }

    private static Size pickPreview(Size[] a) {
        Size best = null;
        for (Size s : a) {
            long px = (long) s.getWidth() * s.getHeight();
            if (px <= 1280L * 960L && (best == null || px > (long) best.getWidth() * best.getHeight())) best = s;
        }
        return best != null ? best : a[a.length - 1];
    }

    private void cleanup() {
        try { if (session != null) session.close(); } catch (Throwable ignored) { }
        try { if (cam != null) cam.close(); } catch (Throwable ignored) { }
        try { if (rawImage != null) rawImage.close(); } catch (Throwable ignored) { }
        try { if (jpegReader != null) jpegReader.close(); } catch (Throwable ignored) { }
        try { if (rawReader != null) rawReader.close(); } catch (Throwable ignored) { }
        try { if (previewSurface != null) previewSurface.release(); } catch (Throwable ignored) { }
        try { if (st != null) st.release(); } catch (Throwable ignored) { }
        try { Thread.sleep(150); } catch (InterruptedException ignored) { }
        ht.quitSafely();
    }
}
