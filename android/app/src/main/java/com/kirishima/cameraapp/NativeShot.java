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
import android.graphics.Rect;
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
        float zoom = 1f;          // 數位變焦倍率:以感測器裁切區域(ISP 放大)實現
        int burst = 1;            // >1 = 連拍多張供合成降噪(僅 JPEG)
        float focusU = -1f, focusV = -1f;   // 對焦點(直立畫面 0..1),<0 = 畫面中央
    }

    static final class Result {
        byte[] jpeg, dng;
        int jpegOrientationDeg;
        boolean yuv;                // 靜態影像來自 YUV 轉成的 JPEG(沒有 EXIF 方向)
        int width, height;
        java.util.List<byte[]> frames = new java.util.ArrayList<>();   // 連拍的所有 JPEG(含第一張)
        float appliedZoom = 1f;     // 已在感測器端套用的變焦倍率
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
    private volatile CountDownLatch gotResult = new CountDownLatch(1);
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
            if (cc != null) {
                float[] fl = cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                res.notes.append("使用原生#").append(req.cameraId);
                if (fl != null && fl.length > 0) res.notes.append(" 焦距").append(String.format(java.util.Locale.US, "%.1f", fl[0])).append("mm");
                if (android.os.Build.VERSION.SDK_INT >= 28) {
                    java.util.Set<String> ph = cc.getPhysicalCameraIds();
                    if (ph != null && !ph.isEmpty()) res.notes.append(" 實體").append(ph);
                }
                res.notes.append(";");
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
            final boolean mapKnown = !jpegCands.isEmpty() && !prevCands.isEmpty();
            if (!mapKnown) {
                // 隱藏鏡頭讀不到尺寸清單:改試常見尺寸
                res.notes.append("讀不到此鏡頭的支援尺寸,改試常見尺寸;");
                jpegCands.clear(); prevCands.clear();
                int[][] jg = {{4000, 3000}, {4032, 3024}, {3840, 2880}, {3648, 2736}, {3456, 2592}, {3264, 2448}, {3000, 2250}, {2592, 1944}, {2048, 1536}, {1920, 1080}, {1280, 960}, {640, 480}};
                int[][] pg = {{1280, 960}, {640, 480}, {320, 240}};
                for (int[] z : jg) jpegCands.add(new Size(z[0], z[1]));
                for (int[] z : pg) prevCands.add(new Size(z[0], z[1]));
            }

            cm.openCamera(req.cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice c) { cam = c; opened.countDown(); }
                @Override public void onDisconnected(CameraDevice c) { error = new IOException("鏡頭中斷連線"); c.close(); opened.countDown(); }
                @Override public void onError(CameraDevice c, int e) { error = new IOException("無法開啟鏡頭 " + req.cameraId + "(錯誤碼 " + e + ")"); c.close(); opened.countDown(); }
            }, h);
            if (!opened.await(6, TimeUnit.SECONDS)) throw new IOException("開啟鏡頭逾時");
            check();

            boolean ok = false;
            StringBuilder tried = new StringBuilder();
            int attempts = 0;
            final long t0 = System.currentTimeMillis();
            outer:
            for (int fmtPass = 0; fmtPass < 2; fmtPass++) {
                boolean yuv = fmtPass == 1;
                int passTries = 0;
                for (Size js : jpegCands) {
                    for (Size ps : prevCands) {
                        for (int rawMode = (wantRaw && !yuv ? 1 : 0); rawMode >= 0; rawMode--) {
                            if (System.currentTimeMillis() - t0 > 40_000L) break outer;
                            if (passTries >= 16) continue;
                            passTries++;
                            attempts++;
                            tried.append(yuv ? "Y:" : "").append(ps.getWidth()).append('x').append(ps.getHeight()).append('+')
                                    .append(js.getWidth()).append('x').append(js.getHeight()).append(rawMode == 1 ? "+RAW " : " ");
                            if (configure(ps, js, rawSize, wantJpeg || rawMode == 0, rawMode == 1, yuv)) {
                                ok = true;
                                if (wantRaw && rawMode == 0) res.notes.append("此鏡頭無法同時輸出 RAW,只存 JPEG;");
                                if (yuv) res.notes.append("此鏡頭不支援直接輸出 JPEG,改由 YUV 轉成 JPEG;");
                                break outer;
                            }
                        }
                    }
                }
            }
            if (!ok) {
                Integer lvl = cc == null ? null : cc.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
                throw new IOException("此鏡頭不接受任何輸出組合(硬體等級 " + lvl + ",尺寸表" + (mapKnown ? "已知" : "讀不到") + ",試了 " + attempts + " 組:" + tried.toString().trim() + ")");
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
            // 真正的對焦掃描(連續對焦的「已對焦」常常只是被動狀態,拍出來會偏軟)
            boolean afLocked = false;
            if (!manualFocus && cc != null) {
                Integer maxAf = cc.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
                final CountDownLatch afDone = new CountDownLatch(1);
                final boolean[] triggered = {false};
                CaptureRequest.Builder ab = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                ab.addTarget(previewSurface);
                applyCommon(ab, manualExp, false);
                ab.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
                if (maxAf != null && maxAf > 0) {
                    android.hardware.camera2.params.MeteringRectangle mr = focusRegion();
                    if (mr != null) ab.set(CaptureRequest.CONTROL_AF_REGIONS, new android.hardware.camera2.params.MeteringRectangle[]{mr});
                }
                CaptureRequest.Builder at = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                at.addTarget(previewSurface);
                applyCommon(at, manualExp, false);
                at.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
                if (maxAf != null && maxAf > 0 && ab.get(CaptureRequest.CONTROL_AF_REGIONS) != null)
                    at.set(CaptureRequest.CONTROL_AF_REGIONS, ab.get(CaptureRequest.CONTROL_AF_REGIONS));
                at.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START);
                session.stopRepeating();
                session.setRepeatingRequest(ab.build(), new CameraCaptureSession.CaptureCallback() {
                    @Override public void onCaptureCompleted(CameraCaptureSession s2, CaptureRequest r2, TotalCaptureResult tr) {
                        if (!triggered[0]) return;
                        Integer af = tr.get(CaptureResult.CONTROL_AF_STATE);
                        if (af != null && (af == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED
                                || af == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED)) afDone.countDown();
                    }
                }, h);
                Thread.sleep(150);
                triggered[0] = true;
                session.capture(at.build(), null, h);
                afLocked = afDone.await(3, TimeUnit.SECONDS);
                if (!afLocked) res.notes.append("對焦掃描逾時,以目前焦點拍攝;");
            }
            check();
            try { session.stopRepeating(); } catch (Throwable ignored) { }

            // 靜態拍攝
            CaptureRequest.Builder sb = cam.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            if (jpegReader != null) sb.addTarget(jpegReader.getSurface());
            if (useRaw) sb.addTarget(rawReader.getSurface());
            applyCommon(sb, manualExp, manualFocus);
            applyQuality(sb);
            sb.set(CaptureRequest.CONTROL_AF_MODE, manualFocus ? CameraMetadata.CONTROL_AF_MODE_OFF
                    : (afLocked || cc != null ? CameraMetadata.CONTROL_AF_MODE_AUTO : CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE));
            int orient = jpegOrientation();
            res.jpegOrientationDeg = orient;
            sb.set(CaptureRequest.JPEG_ORIENTATION, orient);
            sb.set(CaptureRequest.JPEG_QUALITY, (byte) Math.max(95, req.jpegQuality));
            final CaptureRequest stillReq = sb.build();
            final CameraCaptureSession.CaptureCallback stillCb = new CameraCaptureSession.CaptureCallback() {
                @Override public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest r, TotalCaptureResult tr) {
                    stillResult = tr;
                    gotResult.countDown();
                }
                @Override public void onCaptureFailed(CameraCaptureSession s, CaptureRequest r, android.hardware.camera2.CaptureFailure f) {
                    error = new IOException("拍攝失敗(原因 " + f.getReason() + ")");
                    gotResult.countDown(); gotJpeg.countDown(); gotRaw.countDown();
                }
            };
            final int shots = (jpegReader != null && !useRaw) ? Math.max(1, Math.min(8, req.burst)) : 1;
            for (int k = 0; k < shots; k++) {
                if (k > 0) {
                    res.jpeg = null;
                    gotJpeg = new CountDownLatch(1);
                    gotResult = new CountDownLatch(1);
                }
                session.capture(stillReq, stillCb, h);
                long cap = 10_000L + (manualExp ? req.exposureNs / 1_000_000L * 2 : 0);
                if (!gotResult.await(cap, TimeUnit.MILLISECONDS)) throw new IOException("等待拍攝結果逾時");
                check();
                if (!gotJpeg.await(8, TimeUnit.SECONDS)) throw new IOException("等待 JPEG 逾時");
                if (k == 0 && !gotRaw.await(8, TimeUnit.SECONDS)) throw new IOException("等待 RAW 逾時");
                check();
                if (res.jpeg != null) res.frames.add(res.jpeg);
            }
            if (!res.frames.isEmpty()) res.jpeg = res.frames.get(0);
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
    private boolean configure(Size prev, Size jpegSz, Size rawSz, boolean wantJpeg, boolean useRaw, boolean yuv) throws InterruptedException {
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
            jpegReader = ImageReader.newInstance(jpegSz.getWidth(), jpegSz.getHeight(),
                    yuv ? ImageFormat.YUV_420_888 : ImageFormat.JPEG, 2);
            res.yuv = yuv;
            jpegReader.setOnImageAvailableListener(rd -> {
                try (Image im = rd.acquireNextImage()) {
                    if (im != null && res.jpeg == null) {
                        byte[] a;
                        if (yuv) {
                            a = yuvToJpeg(im, req.jpegQuality);
                        } else {
                            ByteBuffer b = im.getPlanes()[0].getBuffer();
                            a = new byte[b.remaining()];
                            b.get(a);
                        }
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

    private static byte[] yuvToJpeg(Image im, int quality) {
        int w = im.getWidth(), h = im.getHeight();
        Image.Plane[] pl = im.getPlanes();
        byte[] nv21 = new byte[w * h * 3 / 2];
        ByteBuffer yb = pl[0].getBuffer();
        int ys = pl[0].getRowStride();
        for (int r = 0; r < h; r++) { yb.position(r * ys); yb.get(nv21, r * w, w); }
        ByteBuffer ub = pl[1].getBuffer(), vb = pl[2].getBuffer();
        int rs = pl[1].getRowStride(), ps = pl[1].getPixelStride();
        int o = w * h;
        for (int r = 0; r < h / 2; r++) {
            for (int c = 0; c < w / 2; c++) {
                int idx = r * rs + c * ps;
                nv21[o++] = vb.get(idx);
                nv21[o++] = ub.get(idx);
            }
        }
        android.graphics.YuvImage yi = new android.graphics.YuvImage(nv21, ImageFormat.NV21, w, h, null);
        ByteArrayOutputStream bos = new ByteArrayOutputStream(w * h / 2);
        yi.compressToJpeg(new android.graphics.Rect(0, 0, w, h), quality, bos);
        return bos.toByteArray();
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
        applyZoomCrop(b);
    }

    private void applyZoomCrop(CaptureRequest.Builder b) {
        if (cc == null || req.zoom <= 1.01f) return;
        Rect active = cc.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        if (active == null) return;
        Float mz = cc.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM);
        float z = Math.min(req.zoom, mz == null ? 1f : mz);
        if (z <= 1.01f) return;
        int cw = Math.round(active.width() / z), ch = Math.round(active.height() / z);
        int cx = active.centerX(), cy = active.centerY();
        b.set(CaptureRequest.SCALER_CROP_REGION, new Rect(cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2));
        res.appliedZoom = z;
    }

    private static boolean has(int[] arr, int v) {
        if (arr == null) return false;
        for (int x : arr) if (x == v) return true;
        return false;
    }

    /** 靜態拍攝的畫質模式:高品質降噪/銳化/去壞點/色差,並開啟光學防震。 */
    private void applyQuality(CaptureRequest.Builder b) {
        if (cc == null) return;
        if (has(cc.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES), CameraMetadata.EDGE_MODE_HIGH_QUALITY))
            b.set(CaptureRequest.EDGE_MODE, CameraMetadata.EDGE_MODE_HIGH_QUALITY);
        if (has(cc.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES), CameraMetadata.NOISE_REDUCTION_MODE_FAST))
            b.set(CaptureRequest.NOISE_REDUCTION_MODE, CameraMetadata.NOISE_REDUCTION_MODE_FAST);
        if (has(cc.get(CameraCharacteristics.HOT_PIXEL_AVAILABLE_HOT_PIXEL_MODES), CameraMetadata.HOT_PIXEL_MODE_HIGH_QUALITY))
            b.set(CaptureRequest.HOT_PIXEL_MODE, CameraMetadata.HOT_PIXEL_MODE_HIGH_QUALITY);
        if (has(cc.get(CameraCharacteristics.COLOR_CORRECTION_AVAILABLE_ABERRATION_MODES), CameraMetadata.COLOR_CORRECTION_ABERRATION_MODE_HIGH_QUALITY))
            b.set(CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE, CameraMetadata.COLOR_CORRECTION_ABERRATION_MODE_HIGH_QUALITY);
        if (has(cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION), CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON))
            b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON);
        b.set(CaptureRequest.CONTROL_CAPTURE_INTENT, CameraMetadata.CONTROL_CAPTURE_INTENT_STILL_CAPTURE);
    }

    /** 直立畫面座標 → 目前裁切區域內的感測器像素 */
    private android.hardware.camera2.params.MeteringRectangle focusRegion() {
        Rect active = cc == null ? null : cc.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        if (active == null) return null;
        float u = req.focusU >= 0 ? req.focusU : 0.5f, v = req.focusV >= 0 ? req.focusV : 0.5f;
        Integer so = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
        Integer lf = cc.get(CameraCharacteristics.LENS_FACING);
        int sensor = so == null ? 90 : so;
        boolean front = lf != null && lf == CameraCharacteristics.LENS_FACING_FRONT;
        int disp = 0;
        try {
            WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            int r = wm.getDefaultDisplay().getRotation();
            disp = r == Surface.ROTATION_90 ? 90 : r == Surface.ROTATION_180 ? 180 : r == Surface.ROTATION_270 ? 270 : 0;
        } catch (Throwable ignored) {
        }
        int rot = front ? (sensor + disp) % 360 : (sensor - disp + 360) % 360;
        float sx, sy;
        if (rot == 90) { sx = v; sy = 1f - u; }
        else if (rot == 180) { sx = 1f - u; sy = 1f - v; }
        else if (rot == 270) { sx = 1f - v; sy = u; }
        else { sx = u; sy = v; }
        float z = Math.max(1f, res.appliedZoom);
        float cw = active.width() / z, ch = active.height() / z;
        int px = Math.round(active.centerX() - cw / 2f + sx * cw), py = Math.round(active.centerY() - ch / 2f + sy * ch);
        int half = Math.max(16, active.width() / 14);
        Rect r = new Rect(Math.max(active.left, px - half), Math.max(active.top, py - half),
                Math.min(active.right - 1, px + half), Math.min(active.bottom - 1, py + half));
        return new android.hardware.camera2.params.MeteringRectangle(r, 1000);
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
