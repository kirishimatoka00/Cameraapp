package com.kirishima.cameraapp;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapRegionDecoder;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.media.ExifInterface;
import android.content.Intent;
import android.net.Uri;
import android.util.Size;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Range;
import android.util.SizeF;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 原生輔助外掛:
 * - 列出實體鏡頭與等效焦段(用來辨識 Note 10+ 的 2x 望遠)
 * - 存圖到 MediaStore(Pictures/AICamera)
 * - 多張曝光 HDR 合成(分條帶處理,記憶體友善)
 * - 分級放大到 1 億畫素
 * - 區域解碼(給檢視器看 1 億畫素的原生細節)
 * - 呼叫 Gemini 圖像模型做數位變焦回推(最高 4K)
 */
@CapacitorPlugin(name = "CameraTools")
public class CameraToolsPlugin extends Plugin {

    private static final String ALBUM = "AICamera";
    private static final String GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final ExecutorService faceExec = Executors.newSingleThreadExecutor();
    private final ExecutorService vexec = Executors.newSingleThreadExecutor();

    // ------------------------------------------------------------------ 共用工具

    private ContentResolver resolver() {
        return getContext().getContentResolver();
    }

    private static String msg(Throwable t) {
        if (t instanceof OutOfMemoryError) return "記憶體不足,請降低目標畫素後再試";
        String m = t.getMessage();
        return (m == null || m.isEmpty()) ? t.getClass().getSimpleName() : m;
    }

    private void progress(String stage) {
        JSObject o = new JSObject();
        o.put("stage", stage);
        notifyListeners("progress", o);
    }

    private static String stamp() {
        return new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date())
                + "_" + (System.currentTimeMillis() % 1000);
    }

    private Uri createPending(String name) throws IOException {
        return createPending(name, "image/jpeg");
    }

    private Uri createPending(String name, String mime) throws IOException {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + ALBUM);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IOException("無法在相簿建立檔案");
        return uri;
    }

    private void publish(Uri uri) {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver().update(uri, v, null, null);
    }

    private void discard(Uri uri) {
        try {
            resolver().delete(uri, null, null);
        } catch (Exception ignored) {
        }
    }

    private Uri writeBytes(String prefix, byte[] bytes) throws IOException {
        Uri uri = createPending(prefix + "_" + stamp() + ".jpg");
        try (OutputStream os = resolver().openOutputStream(uri)) {
            if (os == null) throw new IOException("無法寫入相簿");
            os.write(bytes);
        } catch (IOException | RuntimeException e) {
            discard(uri);
            throw e;
        }
        publish(uri);
        return uri;
    }

    private Uri writeBitmap(String prefix, Bitmap bmp, int quality) throws IOException {
        Uri uri = createPending(prefix + "_" + stamp() + ".jpg");
        try (OutputStream os = resolver().openOutputStream(uri)) {
            if (os == null) throw new IOException("無法寫入相簿");
            if (!bmp.compress(Bitmap.CompressFormat.JPEG, quality, os)) {
                throw new IOException("JPEG 編碼失敗");
            }
        } catch (IOException | RuntimeException e) {
            discard(uri);
            throw e;
        }
        publish(uri);
        return uri;
    }

    private JSObject describe(Uri uri) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        try (InputStream is = resolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(is, null, o);
        }
        JSObject r = new JSObject();
        r.put("uri", uri.toString());
        r.put("width", o.outWidth);
        r.put("height", o.outHeight);
        r.put("megapixels", o.outWidth * (double) o.outHeight / 1e6);
        return r;
    }

    private static byte[] toJpeg(Bitmap bmp, int quality) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(1 << 20);
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, bos);
        return bos.toByteArray();
    }

    // ------------------------------------------------------------------ EXIF / 幾何

    private static Matrix orientationMatrix(int orientation) {
        Matrix m = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                m.postScale(-1, 1);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                m.postRotate(180);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                m.postScale(1, -1);
                break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                m.postRotate(90);
                m.postScale(-1, 1);
                break;
            case ExifInterface.ORIENTATION_ROTATE_90:
                m.postRotate(90);
                break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                m.postRotate(-90);
                m.postScale(-1, 1);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                m.postRotate(-90);
                break;
            default:
                return null;
        }
        return m;
    }

    private static int orientationOf(InputStream is) {
        try {
            ExifInterface ex = new ExifInterface(is);
            return ex.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Throwable t) {
            return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    private static Bitmap applyOrientation(Bitmap src, int orientation) {
        Matrix m = orientationMatrix(orientation);
        if (m == null) return src;
        Bitmap r = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), m, true);
        if (r != src) src.recycle();
        return r;
    }

    private static Bitmap centerCrop(Bitmap src, double zoom) {
        if (zoom <= 1.01) return src;
        int w = src.getWidth(), h = src.getHeight();
        int cw = Math.max(16, (int) Math.round(w / zoom));
        int ch = Math.max(16, (int) Math.round(h / zoom));
        int x = (w - cw) / 2, y = (h - ch) / 2;
        Bitmap r = Bitmap.createBitmap(src, x, y, cw, ch);
        if (r != src) src.recycle();
        return r;
    }

    /** 載入並轉正;maxDim<=0 代表不限制尺寸。 */
    private Bitmap loadUpright(Uri uri, int maxDim) throws IOException {
        BitmapFactory.Options b = new BitmapFactory.Options();
        b.inJustDecodeBounds = true;
        try (InputStream is = resolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(is, null, b);
        }
        if (b.outWidth <= 0) throw new IOException("無法讀取影像");
        int sample = 1;
        if (maxDim > 0) {
            while (Math.max(b.outWidth, b.outHeight) / (sample * 2) >= maxDim) sample *= 2;
        }
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = sample;
        o.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bmp;
        try (InputStream is = resolver().openInputStream(uri)) {
            bmp = BitmapFactory.decodeStream(is, null, o);
        }
        if (bmp == null) throw new IOException("影像解碼失敗");
        int orientation;
        try (InputStream is = resolver().openInputStream(uri)) {
            orientation = orientationOf(is);
        }
        bmp = applyOrientation(bmp, orientation);
        if (maxDim > 0) {
            int longEdge = Math.max(bmp.getWidth(), bmp.getHeight());
            if (longEdge > maxDim) {
                float s = maxDim / (float) longEdge;
                Bitmap scaled = Bitmap.createScaledBitmap(bmp,
                        Math.max(1, Math.round(bmp.getWidth() * s)),
                        Math.max(1, Math.round(bmp.getHeight() * s)), true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }
        }
        return bmp;
    }

    private static byte[] normalizeJpeg(byte[] bytes, double cropZoom, int quality) {
        int orientation = orientationOf(new ByteArrayInputStream(bytes));
        if (orientation == ExifInterface.ORIENTATION_NORMAL && cropZoom <= 1.01) return bytes;
        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bmp == null) return bytes;
        bmp = applyOrientation(bmp, orientation);
        bmp = centerCrop(bmp, cropZoom);
        byte[] out = toJpeg(bmp, quality);
        bmp.recycle();
        return out;
    }

    // ------------------------------------------------------------------ 鏡頭資訊

    @PluginMethod
    public void getCameras(PluginCall call) {
        try {
            CameraManager cm = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            JSArray arr = new JSArray();
            String[] listedIds = cm.getCameraIdList();
            List<String> allIds = new ArrayList<>();
            for (String id : listedIds) allIds.add(id);
            // 探測系統沒列出、但可能可由原生開啟的隱藏鏡頭 ID(例如 Note 10+ 的望遠鏡頭常是 4)
            for (int i = 0; i < 10; i++) if (!allIds.contains(String.valueOf(i))) allIds.add(String.valueOf(i));
            for (int i = 50; i < 60; i++) allIds.add(String.valueOf(i));
            for (String id : allIds) {
                boolean listedId = false;
                for (String l : listedIds) if (l.equals(id)) listedId = true;
                CameraCharacteristics cc;
                try {
                    cc = cm.getCameraCharacteristics(id);
                } catch (Throwable t) {
                    if (listedId) throw t;
                    continue;
                }
                JSObject o = new JSObject();
                o.put("id", id);
                o.put("hidden", !listedId);

                Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                String f = "unknown";
                if (facing != null) {
                    if (facing == CameraCharacteristics.LENS_FACING_BACK) f = "back";
                    else if (facing == CameraCharacteristics.LENS_FACING_FRONT) f = "front";
                    else f = "external";
                }
                o.put("facing", f);

                float[] fl = cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                SizeF ss = cc.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
                if (fl != null && fl.length > 0 && ss != null) {
                    double diag = Math.hypot(ss.getWidth(), ss.getHeight());
                    o.put("focalMm", fl[0]);
                    o.put("equivMm", fl[0] * 43.2666 / diag);
                }

                float[] aps = cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_APERTURES);
                JSArray apArr = new JSArray();
                if (aps != null) for (float a : aps) apArr.put((double) a);
                o.put("apertures", apArr);

                Rect pa = cc.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
                if (pa != null) o.put("sensorMp", pa.width() * (double) pa.height() / 1e6);

                boolean usable = false;
                int[] caps = cc.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
                if (caps != null) {
                    for (int c : caps) {
                        if (c == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE) {
                            usable = true;
                            break;
                        }
                    }
                }
                o.put("usable", usable);
                boolean rawCap = false;
                if (caps != null) for (int c : caps) if (c == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW) rawCap = true;
                o.put("raw", rawCap);

                JSArray phys = new JSArray();
                if (Build.VERSION.SDK_INT >= 28) {
                    for (String p : cc.getPhysicalCameraIds()) phys.put(p);
                }
                o.put("physicalIds", phys);

                if (Build.VERSION.SDK_INT >= 30) {
                    Range<Float> zr = cc.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
                    if (zr != null) {
                        o.put("zoomMin", zr.getLower());
                        o.put("zoomMax", zr.getUpper());
                    }
                }
                arr.put(o);
            }
            JSObject res = new JSObject();
            res.put("cameras", arr);
            call.resolve(res);
        } catch (Throwable t) {
            call.reject(msg(t));
        }
    }

    // ------------------------------------------------------------------ 存圖 / 讀圖

    // ------------------------------------------------------------------ 色彩/裁切共用

    private static LookMath.Params parseParams(JSObject o) {
        LookMath.Params p = new LookMath.Params();
        if (o == null) return p;
        p.ev = (float) o.optDouble("ev", 0);
        p.contrast = (float) o.optDouble("contrast", 0);
        p.highlights = (float) o.optDouble("highlights", 0);
        p.shadows = (float) o.optDouble("shadows", 0);
        p.saturation = (float) o.optDouble("saturation", 0);
        p.detail = (float) o.optDouble("detail", 0);
        JSONArray g = o.optJSONArray("gains");
        if (g != null && g.length() >= 3) {
            p.gr = (float) g.optDouble(0, 1);
            p.gg = (float) g.optDouble(1, 1);
            p.gb = (float) g.optDouble(2, 1);
        }
        return p;
    }

    private static Bitmap centerCropAspect(Bitmap src, double aspect) {
        if (aspect <= 0) return src;
        int w = src.getWidth(), h = src.getHeight();
        double cur = w / (double) h;
        if (Math.abs(cur - aspect) < 0.004) return src;
        int cw = w, ch = h;
        if (cur > aspect) cw = (int) Math.round(h * aspect);
        else ch = (int) Math.round(w / aspect);
        cw = Math.max(16, Math.min(w, cw));
        ch = Math.max(16, Math.min(h, ch));
        Bitmap r = Bitmap.createBitmap(src, (w - cw) / 2, (h - ch) / 2, cw, ch);
        if (r != src) src.recycle();
        return r;
    }

    private static Bitmap ensureMutable(Bitmap b) {
        if (b.isMutable()) return b;
        Bitmap c = b.copy(Bitmap.Config.ARGB_8888, true);
        if (c == null) throw new OutOfMemoryError();
        b.recycle();
        return c;
    }

    /** 就地套用色彩調整(bmp 必須可變)。 */
    private void applyLook(Bitmap bmp, LookMath.Params p) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        if (!p.pixelNeutral()) {
            final int rowsPer = 64;
            int[] strip = new int[w * rowsPer];
            for (int y0 = 0; y0 < h; y0 += rowsPer) {
                int rows = Math.min(rowsPer, h - y0);
                bmp.getPixels(strip, 0, w, 0, y0, w, rows);
                LookMath.apply(strip, 0, w * rows, p);
                bmp.setPixels(strip, 0, w, 0, y0, w, rows);
            }
        }
        if (p.detail > 0f) {
            if ((long) w * h > 30_000_000L) {
                progress("影像超過 30MP,略過細節增強");
            } else {
                progress("細節增強");
                int[] px = new int[w * h];
                bmp.getPixels(px, 0, w, 0, 0, w, h);
                LookMath.unsharp(px, w, h, LookMath.detailAmount(p.detail), LookMath.detailRadius(w, h));
                bmp.setPixels(px, 0, w, 0, 0, w, h);
            }
        }
    }

    /** 裁切 → 變焦裁切 → (保留原始)→ 色彩調整 → 存檔。回傳含 uri / originalUri。 */
    private volatile boolean mirrorFlag;

    private JSObject finishAndSave(Bitmap bmp, String prefix, int quality, double aspect, double zoom,
                                   LookMath.Params p, boolean keepOriginal) throws IOException {
        bmp = centerCropAspect(bmp, aspect);
        bmp = centerCrop(bmp, zoom);
        if (mirrorFlag) {
            Matrix mm = new Matrix();
            mm.postScale(-1f, 1f);
            Bitmap fl = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), mm, true);
            if (fl != bmp) bmp.recycle();
            bmp = fl;
        }
        Uri original = null;
        try {
            if (!p.neutral() && keepOriginal) {
                original = writeBitmap(prefix + "_ORG", bmp, quality);
            }
            if (!p.neutral()) {
                bmp = ensureMutable(bmp);
                applyLook(bmp, p);
            }
            Uri out = writeBitmap(prefix, bmp, quality);
            JSObject res = describe(out);
            if (original != null) res.put("originalUri", original.toString());
            return res;
        } finally {
            bmp.recycle();
        }
    }

    // ------------------------------------------------------------------ 存圖 / 讀圖

    @PluginMethod
    public void saveImage(PluginCall call) {
        final String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("缺少影像資料");
            return;
        }
        Double cz = call.getDouble("cropZoom", 1.0);
        Double ca = call.getDouble("cropAspect", 0.0);
        Integer q = call.getInt("quality", 95);
        final double cropZoom = cz == null ? 1.0 : cz;
        final double cropAspect = ca == null ? 0.0 : ca;
        final int quality = q == null ? 95 : q;
        final String prefix = call.getString("prefix", "IMG");
        final LookMath.Params params = parseParams(call.getObject("look"));
        final boolean keepOriginal = Boolean.TRUE.equals(call.getBoolean("keepOriginal", true));
        final boolean mirror = Boolean.TRUE.equals(call.getBoolean("mirror", false));
        exec.execute(() -> {
            try {
                mirrorFlag = mirror;
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                int orientation = orientationOf(new ByteArrayInputStream(bytes));
                BitmapFactory.Options b = new BitmapFactory.Options();
                b.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, b);
                boolean swap = orientation >= ExifInterface.ORIENTATION_TRANSPOSE
                        && orientation <= ExifInterface.ORIENTATION_ROTATE_270;
                int uw = swap ? b.outHeight : b.outWidth, uh = swap ? b.outWidth : b.outHeight;
                boolean needAspect = cropAspect > 0 && uh > 0 && Math.abs(uw / (double) uh - cropAspect) >= 0.004;
                if (orientation == ExifInterface.ORIENTATION_NORMAL && cropZoom <= 1.01 && !needAspect
                        && params.neutral() && !mirror) {
                    call.resolve(describe(writeBytes(prefix, bytes)));
                    return;
                }
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) throw new IOException("影像解碼失敗");
                bmp = applyOrientation(bmp, orientation);
                call.resolve(finishAndSave(bmp, prefix, quality, cropAspect, cropZoom, params, keepOriginal));
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }


    // ------------------------------------------------------------------ 原生拍攝(RAW / 隱藏鏡頭)

    private Uri writeDng(String prefix, byte[] dng) throws IOException {
        Uri uri = createPending(prefix + "_" + stamp() + ".dng", "image/x-adobe-dng");
        try (OutputStream os = resolver().openOutputStream(uri)) {
            if (os == null) throw new IOException("無法寫入相簿");
            os.write(dng);
        } catch (IOException | RuntimeException e) {
            discard(uri);
            throw e;
        }
        publish(uri);
        return uri;
    }

    private byte[] readAll(Uri uri) throws IOException {
        try (InputStream is = resolver().openInputStream(uri)) {
            if (is == null) throw new IOException("無法讀取檔案");
            ByteArrayOutputStream bos = new ByteArrayOutputStream(1 << 22);
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private boolean isDng(Uri uri) {
        try {
            String t = resolver().getType(uri);
            if (t != null && (t.contains("dng") || t.contains("adobe"))) return true;
            try (Cursor c = resolver().query(uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    String n = c.getString(0);
                    return n != null && n.toLowerCase(Locale.US).endsWith(".dng");
                }
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    /** 以 Camera2 直接拍照(獨占鏡頭;呼叫前 WebView 預覽必須先停止)。 */
    @PluginMethod
    public void captureNative(PluginCall call) {
        final NativeShot.Req r = new NativeShot.Req();
        r.cameraId = call.getString("cameraId");
        r.raw = Boolean.TRUE.equals(call.getBoolean("raw", false));
        r.jpeg = !Boolean.FALSE.equals(call.getBoolean("jpeg", true));
        Double expMs = call.getDouble("exposureMs", 0.0);
        r.exposureNs = expMs == null ? 0 : Math.round(expMs * 1e6);
        Integer iso = call.getInt("iso", 0);
        r.iso = iso == null ? 0 : iso;
        Double fm = call.getDouble("focusMeters", 0.0);
        r.focusMeters = fm == null ? 0f : fm.floatValue();
        Double ev = call.getDouble("ev", 0.0);
        r.ev = ev == null ? 0f : ev.floatValue();
        Integer q = call.getInt("quality", 95);
        r.jpegQuality = q == null ? 95 : q;
        r.torch = Boolean.TRUE.equals(call.getBoolean("torch", false));
        Double cz = call.getDouble("cropZoom", 1.0);
        Double ca = call.getDouble("cropAspect", 0.0);
        final double cropZoom = cz == null ? 1.0 : cz;
        final double cropAspect = ca == null ? 0.0 : ca;
        final String prefix = call.getString("prefix", "IMG");
        final LookMath.Params params = parseParams(call.getObject("look"));
        final boolean keepOriginal = Boolean.TRUE.equals(call.getBoolean("keepOriginal", true));
        final boolean mirror = Boolean.TRUE.equals(call.getBoolean("mirror", false));
        if (r.cameraId == null) {
            call.reject("缺少 cameraId");
            return;
        }
        exec.execute(() -> {
            try {
                mirrorFlag = mirror;
                progress("以原生相機拍攝");
                NativeShot.Result s = NativeShot.shoot(getContext(), r);
                JSObject res;
                if (s.jpeg != null) {
                    progress("處理 JPEG");
                    int orientation = orientationOf(new ByteArrayInputStream(s.jpeg));
                    Bitmap bmp = BitmapFactory.decodeByteArray(s.jpeg, 0, s.jpeg.length);
                    if (bmp == null) throw new IOException("JPEG 解碼失敗");
                    bmp = applyOrientation(bmp, orientation);
                    res = finishAndSave(bmp, prefix, r.jpegQuality, cropAspect, cropZoom, params, keepOriginal);
                } else {
                    res = new JSObject();
                }
                if (s.dng != null) {
                    progress("寫入 DNG");
                    Uri du = writeDng("RAW", s.dng);
                    res.put("rawUri", du.toString());
                    if (!res.has("uri")) {
                        res.put("uri", du.toString());
                        res.put("width", s.width);
                        res.put("height", s.height);
                        res.put("megapixels", s.width * (double) s.height / 1e6);
                    }
                }
                res.put("hasRaw", s.dng != null);
                res.put("notes", s.notes.toString());
                call.resolve(res);
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    /**
     * DNG 顯影預覽:套用 EV 與線性增益後輸出 JPEG(base64)。
     * 參數:uri, maxDim, ev, gains[3]
     */
    @PluginMethod
    public void developRaw(PluginCall call) {
        final String uriStr = call.getString("uri");
        Integer md = call.getInt("maxDim", 1600);
        final int maxDim = md == null ? 1600 : md;
        Double evD = call.getDouble("ev", 0.0);
        final float ev = evD == null ? 0f : evD.floatValue();
        final float[] gains = {1f, 1f, 1f};
        org.json.JSONArray ga = null;
        try {
            JSObject o = call.getData();
            if (o.has("gains")) ga = o.getJSONArray("gains");
        } catch (Throwable ignored) {
        }
        if (ga != null) {
            try {
                for (int i = 0; i < 3 && i < ga.length(); i++) gains[i] = (float) ga.getDouble(i);
            } catch (Throwable ignored) {
            }
        }
        if (uriStr == null) {
            call.reject("缺少 uri");
            return;
        }
        exec.execute(() -> {
            try {
                Uri uri = Uri.parse(uriStr);
                RawDev.Dng d = RawDev.parse(readAll(uri));
                int[] sz = RawDev.size(d);
                boolean half = maxDim > 0 && Math.max(sz[0], sz[1]) / 2 >= maxDim * 0.75;
                Bitmap bmp = RawDev.develop(d, half, ev, gains);
                int longEdge = Math.max(bmp.getWidth(), bmp.getHeight());
                if (maxDim > 0 && longEdge > maxDim) {
                    float sc = maxDim / (float) longEdge;
                    Bitmap sm = Bitmap.createScaledBitmap(bmp, Math.max(1, Math.round(bmp.getWidth() * sc)),
                            Math.max(1, Math.round(bmp.getHeight() * sc)), true);
                    if (sm != bmp) bmp.recycle();
                    bmp = sm;
                }
                JSObject r = new JSObject();
                r.put("data", Base64.encodeToString(toJpeg(bmp, 90), Base64.NO_WRAP));
                r.put("width", bmp.getWidth());
                r.put("height", bmp.getHeight());
                r.put("fullWidth", sz[0]);
                r.put("fullHeight", sz[1]);
                r.put("megapixels", sz[0] * (double) sz[1] / 1e6);
                bmp.recycle();
                call.resolve(r);
            } catch (RawDev.Unsupported u) {
                call.reject("UNSUPPORTED_RAW:" + u.getMessage());
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    /** 對既有影像套用色彩調整,另存新檔。 */
    @PluginMethod
    public void editImage(PluginCall call) {
        final String uriStr = call.getString("uri");
        Integer q = call.getInt("quality", 95);
        final int quality = q == null ? 95 : q;
        final String prefix = call.getString("prefix", "EDIT");
        final LookMath.Params params = parseParams(call.getObject("look"));
        if (uriStr == null) {
            call.reject("缺少 uri");
            return;
        }
        exec.execute(() -> {
            Bitmap bmp = null;
            try {
                Uri uri = Uri.parse(uriStr);
                if (isDng(uri)) try {
                    progress("RAW 顯影");
                    RawDev.Dng d = RawDev.parse(readAll(uri));
                    // EV 與白平衡增益在線性空間處理;其餘調整在顯影後套用
                    bmp = RawDev.develop(d, false, params.ev, new float[]{params.gr, params.gg, params.gb});
                    LookMath.Params rest = new LookMath.Params();
                    rest.contrast = params.contrast;
                    rest.highlights = params.highlights;
                    rest.shadows = params.shadows;
                    rest.saturation = params.saturation;
                    rest.detail = params.detail;
                    bmp = ensureMutable(bmp);
                    applyLook(bmp, rest);
                    progress("編碼 JPEG");
                    Uri outRaw = writeBitmap(prefix, bmp, quality);
                    call.resolve(describe(outRaw));
                    return;
                } catch (RawDev.Unsupported u) {
                    progress("此 DNG 無法自行顯影,改用系統解碼");
                    if (bmp != null) { bmp.recycle(); bmp = null; }
                }
                JSObject info = describe(uri);
                if (info.getDouble("megapixels") > 36.0) {
                    throw new IOException("影像超過 36MP,無法編輯(請對放大前的原圖編輯)");
                }
                progress("讀取原圖");
                bmp = loadUpright(uri, 0);
                bmp = ensureMutable(bmp);
                applyLook(bmp, params);
                progress("編碼 JPEG");
                Uri out = writeBitmap(prefix, bmp, quality);
                call.resolve(describe(out));
            } catch (Throwable t) {
                call.reject(msg(t));
            } finally {
                if (bmp != null) bmp.recycle();
            }
        });
    }

    @PluginMethod
    public void readImage(PluginCall call) {
        final String uriStr = call.getString("uri");
        Integer md = call.getInt("maxDim", 2048);
        Integer q = call.getInt("quality", 88);
        final int maxDim = md == null ? 2048 : md;
        final int quality = q == null ? 88 : q;
        if (uriStr == null) {
            call.reject("缺少 uri");
            return;
        }
        exec.execute(() -> {
            try {
                Uri uri = Uri.parse(uriStr);
                JSObject info = describe(uri);
                Bitmap bmp = loadUpright(uri, maxDim);
                JSObject r = new JSObject();
                r.put("data", Base64.encodeToString(toJpeg(bmp, quality), Base64.NO_WRAP));
                r.put("width", info.getInteger("width"));
                r.put("height", info.getInteger("height"));
                r.put("megapixels", info.getDouble("megapixels"));
                r.put("outWidth", bmp.getWidth());
                r.put("outHeight", bmp.getHeight());
                bmp.recycle();
                call.resolve(r);
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    /** 以正規化座標(0..1)讀取原圖區域,解析度不超過 outMax。 */
    @PluginMethod
    public void readRegion(PluginCall call) {
        final String uriStr = call.getString("uri");
        final double x0 = call.getDouble("x0", 0.0);
        final double y0 = call.getDouble("y0", 0.0);
        final double x1 = call.getDouble("x1", 1.0);
        final double y1 = call.getDouble("y1", 1.0);
        Integer om = call.getInt("outMax", 1600);
        final int outMax = om == null ? 1600 : om;
        if (uriStr == null) {
            call.reject("缺少 uri");
            return;
        }
        exec.execute(() -> {
            ParcelFileDescriptor pfd = null;
            BitmapRegionDecoder dec = null;
            try {
                Uri uri = Uri.parse(uriStr);
                pfd = resolver().openFileDescriptor(uri, "r");
                if (pfd == null) throw new IOException("無法開啟檔案");
                dec = BitmapRegionDecoder.newInstance(pfd.getFileDescriptor(), false);
                int W = dec.getWidth(), H = dec.getHeight();
                int left = (int) Math.max(0, Math.min(W - 2, Math.floor(x0 * W)));
                int top = (int) Math.max(0, Math.min(H - 2, Math.floor(y0 * H)));
                int right = (int) Math.max(left + 2, Math.min(W, Math.ceil(x1 * W)));
                int bottom = (int) Math.max(top + 2, Math.min(H, Math.ceil(y1 * H)));
                Rect r = new Rect(left, top, right, bottom);
                int sample = 1;
                while (Math.max(r.width(), r.height()) / (sample * 2) >= outMax) sample *= 2;
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inSampleSize = sample;
                o.inPreferredConfig = Bitmap.Config.ARGB_8888;
                Bitmap bmp = dec.decodeRegion(r, o);
                if (bmp == null) throw new IOException("區域解碼失敗");
                JSObject res = new JSObject();
                res.put("data", Base64.encodeToString(toJpeg(bmp, 88), Base64.NO_WRAP));
                res.put("x0", r.left / (double) W);
                res.put("y0", r.top / (double) H);
                res.put("x1", r.right / (double) W);
                res.put("y1", r.bottom / (double) H);
                bmp.recycle();
                call.resolve(res);
            } catch (Throwable t) {
                call.reject(msg(t));
            } finally {
                if (dec != null) dec.recycle();
                try {
                    if (pfd != null) pfd.close();
                } catch (IOException ignored) {
                }
            }
        });
    }

    private void queryMedia(Uri base, boolean video, int limit, List<JSObject> out) {
        Bundle args = new Bundle();
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?");
        args.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[]{
                (video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES) + "/" + ALBUM + "%"});
        args.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER,
                MediaStore.MediaColumns.DATE_ADDED + " DESC, " + MediaStore.MediaColumns._ID + " DESC");
        args.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
        String[] proj = video
                ? new String[]{MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT,
                MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.DURATION}
                : new String[]{MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT,
                MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.MIME_TYPE};
        try (Cursor c = resolver().query(base, proj, args, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                JSObject o = new JSObject();
                o.put("uri", ContentUris.withAppendedId(base, c.getLong(0)).toString());
                o.put("name", c.getString(1));
                o.put("width", c.getInt(2));
                o.put("height", c.getInt(3));
                o.put("date", c.getLong(4));
                o.put("mime", c.getString(5));
                o.put("type", video ? "video" : "image");
                if (video) o.put("duration", c.getLong(6));
                out.add(o);
            }
        }
    }

    @PluginMethod
    public void listRecent(PluginCall call) {
        Integer lim = call.getInt("limit", 60);
        final int limit = lim == null ? 60 : lim;
        exec.execute(() -> {
            try {
                List<JSObject> all = new ArrayList<>();
                queryMedia(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, false, limit, all);
                queryMedia(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true, limit, all);
                Collections.sort(all, (x, y) -> Long.compare(y.optLong("date"), x.optLong("date")));
                JSArray arr = new JSArray();
                for (int i = 0; i < all.size() && i < limit; i++) arr.put(all.get(i));
                JSObject res = new JSObject();
                res.put("items", arr);
                call.resolve(res);
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    @PluginMethod
    public void readThumb(PluginCall call) {
        final String uriStr = call.getString("uri");
        Integer sz = call.getInt("size", 256);
        final int size = sz == null ? 256 : sz;
        if (uriStr == null) {
            call.reject("缺少 uri");
            return;
        }
        exec.execute(() -> {
            try {
                Bitmap bm = resolver().loadThumbnail(Uri.parse(uriStr), new Size(size, size), null);
                JSObject r = new JSObject();
                r.put("data", Base64.encodeToString(toJpeg(bm, 80), Base64.NO_WRAP));
                bm.recycle();
                call.resolve(r);
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    @PluginMethod
    public void deleteImages(PluginCall call) {
        final JSArray arr = call.getArray("uris");
        if (arr == null) {
            call.reject("缺少 uris");
            return;
        }
        exec.execute(() -> {
            int deleted = 0, failed = 0;
            for (int i = 0; i < arr.length(); i++) {
                try {
                    String u = arr.getString(i);
                    if (resolver().delete(Uri.parse(u), null, null) > 0) deleted++;
                    else failed++;
                } catch (Throwable t) {
                    failed++;
                }
            }
            JSObject res = new JSObject();
            res.put("deleted", deleted);
            res.put("failed", failed);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        try {
            String u = call.getString("uri");
            String mime = call.getString("mime", "video/*");
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(u), mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Throwable t) {
            call.reject(msg(t));
        }
    }

    @PluginMethod
    public void exportFile(PluginCall call) {
        final String name = call.getString("name", "AICamera_export.json");
        final String text = call.getString("text", "");
        final String mime = call.getString("mime", "application/json");
        exec.execute(() -> {
            try {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + ALBUM);
                Uri uri = resolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IOException("無法建立檔案");
                try (OutputStream os = resolver().openOutputStream(uri)) {
                    if (os == null) throw new IOException("無法寫入檔案");
                    os.write(text.getBytes(StandardCharsets.UTF_8));
                }
                JSObject r = new JSObject();
                r.put("uri", uri.toString());
                r.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + ALBUM + "/" + name);
                call.resolve(r);
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    // ------------------------------------------------------------------ 人臉偵測(ML Kit)

    private FaceDetector faceDetector;

    private synchronized FaceDetector detector() {
        if (faceDetector == null) {
            FaceDetectorOptions o = new FaceDetectorOptions.Builder()
                    .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                    .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
                    .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
                    .setMinFaceSize(0.04f)
                    .enableTracking()
                    .build();
            faceDetector = FaceDetection.getClient(o);
        }
        return faceDetector;
    }

    /** 傳入縮小後的 JPEG(base64),回傳正規化人臉框,依面積由大到小,最多 max 個。 */
    @PluginMethod
    public void detectFaces(PluginCall call) {
        final String data = call.getString("data");
        Integer mx = call.getInt("max", 10);
        final int max = mx == null ? 10 : mx;
        if (data == null) {
            call.reject("缺少影像");
            return;
        }
        faceExec.execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) throw new IOException("影像解碼失敗");
                final int w = bmp.getWidth(), h = bmp.getHeight();
                List<Face> faces = Tasks.await(detector().process(InputImage.fromBitmap(bmp, 0)), 4, TimeUnit.SECONDS);
                bmp.recycle();
                List<Face> sorted = new ArrayList<>(faces);
                Collections.sort(sorted, (a, b) -> Integer.compare(
                        b.getBoundingBox().width() * b.getBoundingBox().height(),
                        a.getBoundingBox().width() * a.getBoundingBox().height()));
                JSArray arr = new JSArray();
                for (int i = 0; i < sorted.size() && i < max; i++) {
                    Face f = sorted.get(i);
                    Rect bb = f.getBoundingBox();
                    JSObject o = new JSObject();
                    o.put("x", Math.max(0.0, bb.left / (double) w));
                    o.put("y", Math.max(0.0, bb.top / (double) h));
                    o.put("w", Math.min(1.0, bb.width() / (double) w));
                    o.put("h", Math.min(1.0, bb.height() / (double) h));
                    Integer tid = f.getTrackingId();
                    o.put("id", tid == null ? -1 : tid);
                    arr.put(o);
                }
                JSObject res = new JSObject();
                res.put("faces", arr);
                call.resolve(res);
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    // ------------------------------------------------------------------ 影片(分段寫入,避免整支影片進記憶體)

    private OutputStream vOut;
    private Uri vUri;

    @PluginMethod
    public void beginVideo(PluginCall call) {
        final String mime = call.getString("mime", "video/mp4");
        vexec.execute(() -> {
            try {
                closeVideo(true);
                String ext = mime.contains("webm") ? "webm" : "mp4";
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, "VID_" + stamp() + "." + ext);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime.contains("webm") ? "video/webm" : "video/mp4");
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/" + ALBUM);
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                vUri = resolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v);
                if (vUri == null) throw new IOException("無法建立影片檔案");
                vOut = resolver().openOutputStream(vUri);
                if (vOut == null) throw new IOException("無法寫入影片檔案");
                call.resolve();
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    @PluginMethod
    public void appendVideo(PluginCall call) {
        final String data = call.getString("data");
        vexec.execute(() -> {
            try {
                if (vOut == null) throw new IOException("尚未開始錄影");
                vOut.write(Base64.decode(data, Base64.DEFAULT));
                call.resolve();
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    private void closeVideo(boolean discardPending) {
        try {
            if (vOut != null) vOut.close();
        } catch (IOException ignored) {
        }
        vOut = null;
        if (vUri != null && discardPending) discard(vUri);
        vUri = null;
    }

    @PluginMethod
    public void finishVideo(PluginCall call) {
        vexec.execute(() -> {
            try {
                if (vOut == null || vUri == null) throw new IOException("沒有進行中的錄影");
                vOut.close();
                vOut = null;
                publish(vUri);
                JSObject r = new JSObject();
                r.put("uri", vUri.toString());
                vUri = null;
                call.resolve(r);
            } catch (Throwable t) {
                closeVideo(true);
                call.reject(msg(t));
            }
        });
    }

    @PluginMethod
    public void abortVideo(PluginCall call) {
        vexec.execute(() -> {
            closeVideo(true);
            call.resolve();
        });
    }

    // ------------------------------------------------------------------ 放大到 N 百萬畫素

    @PluginMethod
    public void upscale(PluginCall call) {
        final String uriStr = call.getString("uri");
        Double tm = call.getDouble("targetMegapixels", 100.0);
        Integer q = call.getInt("quality", 92);
        final double targetMp = tm == null ? 100.0 : tm;
        final int quality = q == null ? 92 : q;
        if (uriStr == null) {
            call.reject("缺少 uri");
            return;
        }
        exec.execute(() -> {
            Bitmap src = null;
            Bitmap dst = null;
            try {
                Uri uri = Uri.parse(uriStr);
                progress("讀取原圖");
                src = loadUpright(uri, 0);
                double srcMp = src.getWidth() * (double) src.getHeight() / 1e6;
                if (srcMp >= targetMp * 0.98) {
                    throw new IOException("原圖已達 " + String.format(Locale.US, "%.1f", srcMp) + " MP,無需放大");
                }
                double[] tries = {targetMp, 75, 50, 36};
                double usedMp = 0;
                int W = 0, H = 0;
                for (double mp : tries) {
                    if (mp > targetMp) continue;
                    if (mp <= srcMp) break;
                    double s = Math.sqrt(mp * 1e6 / (src.getWidth() * (double) src.getHeight()));
                    W = (int) Math.round(src.getWidth() * s);
                    H = (int) Math.round(src.getHeight() * s);
                    progress("配置 " + String.format(Locale.US, "%.0f", mp) + " MP 畫布");
                    try {
                        dst = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
                        usedMp = mp;
                        break;
                    } catch (OutOfMemoryError oom) {
                        dst = null;
                        System.gc();
                    }
                }
                if (dst == null) throw new IOException("記憶體不足,無法配置放大畫布");

                progress("放大中(" + W + "×" + H + ")");
                Canvas canvas = new Canvas(dst);
                Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.DITHER_FLAG);
                canvas.drawBitmap(src, null, new Rect(0, 0, W, H), paint);
                src.recycle();
                src = null;

                progress("編碼 JPEG(大型影像需要一些時間)");
                Uri out = writeBitmap("UP" + String.format(Locale.US, "%.0f", usedMp) + "MP", dst, quality);
                JSObject res = describe(out);
                res.put("requestedMp", targetMp);
                res.put("actualMp", usedMp);
                call.resolve(res);
            } catch (Throwable t) {
                call.reject(msg(t));
            } finally {
                if (src != null) src.recycle();
                if (dst != null) dst.recycle();
            }
        });
    }

    // ------------------------------------------------------------------ HDR

    @PluginMethod
    public void cacheFrame(PluginCall call) {
        final String data = call.getString("data");
        Integer idx = call.getInt("index", 0);
        final int index = idx == null ? 0 : idx;
        if (data == null) {
            call.reject("缺少影像資料");
            return;
        }
        exec.execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                File f = new File(getContext().getCacheDir(), "hdr_" + index + ".jpg");
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    fos.write(bytes);
                }
                call.resolve();
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    @PluginMethod
    public void clearFrames(PluginCall call) {
        exec.execute(() -> {
            File[] fs = getContext().getCacheDir().listFiles();
            if (fs != null) {
                for (File f : fs) {
                    if (f.getName().startsWith("hdr_")) //noinspection ResultOfMethodCallIgnored
                        f.delete();
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void mergeHdr(PluginCall call) {
        Integer c = call.getInt("count", 3);
        Integer q = call.getInt("quality", 95);
        Double cz = call.getDouble("cropZoom", 1.0);
        Double ca = call.getDouble("cropAspect", 0.0);
        final int count = c == null ? 3 : c;
        final int quality = q == null ? 95 : q;
        final double cropZoom = cz == null ? 1.0 : cz;
        final double cropAspect = ca == null ? 0.0 : ca;
        final LookMath.Params params = parseParams(call.getObject("look"));
        final boolean keepOriginal = Boolean.TRUE.equals(call.getBoolean("keepOriginal", true));
        final boolean mirrorHdr = Boolean.TRUE.equals(call.getBoolean("mirror", false));
        exec.execute(() -> {
            try {
                mirrorFlag = mirrorHdr;
                call.resolve(fuseFrames(count, quality, cropZoom, cropAspect, params, keepOriginal));
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    private static float[] wellTable() {
        float[] t = new float[256];
        for (int i = 0; i < 256; i++) {
            double d = i / 255.0 - 0.5;
            t[i] = (float) Math.exp(-(d * d) / 0.08);
        }
        return t;
    }

    private static void boxBlurH(float[] src, float[] dst, int W, int rows, int R, double[] pre) {
        for (int y = 0; y < rows; y++) {
            int base = y * W;
            pre[0] = 0;
            for (int x = 0; x < W; x++) pre[x + 1] = pre[x] + src[base + x];
            for (int x = 0; x < W; x++) {
                int lo = Math.max(0, x - R);
                int hi = Math.min(W, x + R + 1);
                dst[base + x] = (float) ((pre[hi] - pre[lo]) / (hi - lo));
            }
        }
    }

    private static void boxBlurV(float[] src, float[] dst, int W, int rows, int R, float[] col) {
        java.util.Arrays.fill(col, 0, W, 0f);
        int curLo = 0, curHi = -1;
        for (int y = 0; y < rows; y++) {
            int newHi = Math.min(rows - 1, y + R);
            while (curHi < newHi) {
                curHi++;
                int b = curHi * W;
                for (int x = 0; x < W; x++) col[x] += src[b + x];
            }
            int newLo = Math.max(0, y - R);
            while (curLo < newLo) {
                int b = curLo * W;
                for (int x = 0; x < W; x++) col[x] -= src[b + x];
                curLo++;
            }
            float inv = 1f / (curHi - curLo + 1);
            int b = y * W;
            for (int x = 0; x < W; x++) dst[b + x] = col[x] * inv;
        }
    }

    /** 曝光融合(Mertens 概念:對比 × 飽和度 × 曝光良好度),分條帶處理避免吃光記憶體。 */
    private JSObject fuseFrames(int n, int quality, double cropZoom, double cropAspect,
                                LookMath.Params params, boolean keepOriginal) throws Exception {
        File dir = getContext().getCacheDir();
        File[] files = new File[n];
        BitmapRegionDecoder[] dec = new BitmapRegionDecoder[n];
        Bitmap out = null;
        try {
            int W = -1, H = -1;
            for (int i = 0; i < n; i++) {
                files[i] = new File(dir, "hdr_" + i + ".jpg");
                if (!files[i].exists()) throw new IOException("缺少 HDR 影格 " + i);
                dec[i] = BitmapRegionDecoder.newInstance(files[i].getAbsolutePath(), false);
                if (i == 0) {
                    W = dec[0].getWidth();
                    H = dec[0].getHeight();
                } else if (dec[i].getWidth() != W || dec[i].getHeight() != H) {
                    throw new IOException("HDR 影格尺寸不一致,請重拍");
                }
            }
            int orientation = ExifInterface.ORIENTATION_NORMAL;
            try (InputStream is = new java.io.FileInputStream(files[0])) {
                orientation = orientationOf(is);
            }

            out = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
            final int R = Math.max(3, W / 700);
            final int pad = R + 1;
            final int stripRows = 160;
            final int maxRows = stripRows + 2 * pad;

            int[][] px = new int[n][maxRows * W];
            float[][] lum = new float[n][maxRows * W];
            float[][] wgt = new float[n][maxRows * W];
            float[] tmp = new float[maxRows * W];
            double[] pre = new double[W + 1];
            float[] col = new float[W];
            int[] line = new int[W * stripRows];
            float[] well = wellTable();

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inPreferredConfig = Bitmap.Config.ARGB_8888;

            for (int y0 = 0; y0 < H; y0 += stripRows) {
                int y1 = Math.min(H, y0 + stripRows);
                int py0 = Math.max(0, y0 - pad);
                int py1 = Math.min(H, y1 + pad);
                int rows = py1 - py0;
                int total = rows * W;
                progress("HDR 合成 " + (int) (100.0 * y0 / H) + "%");

                for (int i = 0; i < n; i++) {
                    Bitmap b = dec[i].decodeRegion(new Rect(0, py0, W, py1), opts);
                    if (b == null) throw new IOException("HDR 影格解碼失敗");
                    b.getPixels(px[i], 0, W, 0, 0, W, rows);
                    b.recycle();

                    int[] P = px[i];
                    float[] L = lum[i];
                    float[] Wt = wgt[i];
                    for (int p = 0; p < total; p++) {
                        int cpx = P[p];
                        int r = (cpx >> 16) & 255, g = (cpx >> 8) & 255, bl = cpx & 255;
                        float rf = r / 255f, gf = g / 255f, bf = bl / 255f;
                        L[p] = 0.299f * rf + 0.587f * gf + 0.114f * bf;
                        float mean = (rf + gf + bf) / 3f;
                        float sat = (float) Math.sqrt(((rf - mean) * (rf - mean) + (gf - mean) * (gf - mean)
                                + (bf - mean) * (bf - mean)) / 3f);
                        Wt[p] = (sat + 0.05f) * well[r] * well[g] * well[bl];
                    }
                    for (int y = 0; y < rows; y++) {
                        int rowBase = y * W;
                        int upBase = (y > 0 ? y - 1 : y) * W;
                        int dnBase = (y < rows - 1 ? y + 1 : y) * W;
                        for (int x = 0; x < W; x++) {
                            int p = rowBase + x;
                            float l = L[p];
                            float ctr = Math.abs(L[upBase + x] + L[dnBase + x]
                                    + L[rowBase + (x > 0 ? x - 1 : x)]
                                    + L[rowBase + (x < W - 1 ? x + 1 : x)] - 4f * l);
                            Wt[p] *= (ctr + 0.01f);
                        }
                    }
                    boxBlurH(Wt, tmp, W, rows, R, pre);
                    boxBlurV(tmp, Wt, W, rows, R, col);
                }

                int coreStart = y0 - py0;
                int coreRows = y1 - y0;
                for (int yy = 0; yy < coreRows; yy++) {
                    int rowBase = (coreStart + yy) * W;
                    int lineBase = yy * W;
                    for (int x = 0; x < W; x++) {
                        int p = rowBase + x;
                        float sum = 0, ar = 0, ag = 0, ab = 0;
                        for (int i = 0; i < n; i++) {
                            float w = wgt[i][p] + 1e-12f;
                            int cpx = px[i][p];
                            ar += w * ((cpx >> 16) & 255);
                            ag += w * ((cpx >> 8) & 255);
                            ab += w * (cpx & 255);
                            sum += w;
                        }
                        int r = Math.min(255, Math.round(ar / sum));
                        int g = Math.min(255, Math.round(ag / sum));
                        int b = Math.min(255, Math.round(ab / sum));
                        line[lineBase + x] = 0xFF000000 | (r << 16) | (g << 8) | b;
                    }
                }
                out.setPixels(line, 0, W, 0, y0, W, coreRows);
            }

            progress("套用方向與裁切");
            Bitmap fin = applyOrientation(out, orientation);
            out = null;
            progress("編碼 JPEG");
            return finishAndSave(fin, "HDR", quality, cropAspect, cropZoom, params, keepOriginal);
        } finally {
            for (BitmapRegionDecoder d : dec) if (d != null) d.recycle();
            if (out != null) out.recycle();
        }
    }

    // ------------------------------------------------------------------ Gemini

    private static final String[] RATIOS = {"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"};

    private static String nearestRatio(int w, int h) {
        double target = w / (double) h;
        String best = "1:1";
        double bestDiff = 1e9;
        for (String r : RATIOS) {
            String[] p = r.split(":");
            double v = Double.parseDouble(p[0]) / Double.parseDouble(p[1]);
            double d = Math.abs(Math.log(v / target));
            if (d < bestDiff) {
                bestDiff = d;
                best = r;
            }
        }
        return best;
    }

    private static class Http {
        int code;
        String body;
    }

    private static Http request(String method, String url, String key, String json) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(30000);
        c.setReadTimeout(300000);
        c.setRequestProperty("x-goog-api-key", key);
        if (json != null) {
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            c.setRequestProperty("Content-Type", "application/json");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(bytes);
            }
        }
        Http r = new Http();
        r.code = c.getResponseCode();
        InputStream is = r.code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream(1 << 16);
        if (is != null) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            is.close();
        }
        r.body = new String(bos.toByteArray(), StandardCharsets.UTF_8);
        c.disconnect();
        return r;
    }

    private static String apiError(Http h) {
        try {
            JSONObject j = new JSONObject(h.body);
            JSONObject e = j.optJSONObject("error");
            if (e != null) {
                String m = e.optString("message", "");
                if (!m.isEmpty()) return "HTTP " + h.code + ":" + m;
            }
        } catch (Throwable ignored) {
        }
        String b = h.body == null ? "" : h.body;
        if (b.length() > 300) b = b.substring(0, 300);
        return "HTTP " + h.code + " " + b;
    }

    /** 回傳最後一個含影像資料的區塊 {mime, base64};找不到回傳 null。 */
    private static String[] findImage(Object node) {
        String[] best = null;
        if (node instanceof JSONObject) {
            JSONObject o = (JSONObject) node;
            Object dv = o.opt("data");
            if (dv instanceof String && ((String) dv).length() > 2000) {
                String type = o.optString("type", "");
                String mime = o.optString("mime_type", o.optString("mimeType", "image/jpeg"));
                if ("image".equals(type) || mime.startsWith("image/")) {
                    best = new String[]{mime, (String) dv};
                }
            }
            Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String[] r = findImage(o.opt(it.next()));
                if (r != null) best = r;
            }
        } else if (node instanceof JSONArray) {
            JSONArray a = (JSONArray) node;
            for (int i = 0; i < a.length(); i++) {
                String[] r = findImage(a.opt(i));
                if (r != null) best = r;
            }
        }
        return best;
    }

    @PluginMethod
    public void testGemini(PluginCall call) {
        final String key = call.getString("apiKey", "");
        final String model = call.getString("model", "");
        if (key == null || key.trim().isEmpty()) {
            call.reject("尚未輸入 API key");
            return;
        }
        exec.execute(() -> {
            try {
                Http h = request("GET", GEMINI_BASE + "/models?pageSize=1", key.trim(), null);
                JSObject res = new JSObject();
                if (h.code != 200) {
                    res.put("ok", false);
                    res.put("message", "金鑰驗證失敗 " + apiError(h));
                    call.resolve(res);
                    return;
                }
                String note = "金鑰有效";
                if (model != null && !model.isEmpty()) {
                    Http m = request("GET", GEMINI_BASE + "/models/" + model, key.trim(), null);
                    if (m.code == 200) note += ",模型 " + model + " 可用";
                    else if (m.code == 404)
                        note += ",但模型目錄查無「" + model + "」(若為新模型,仍可能可透過 Interactions API 使用)";
                    else note += ",模型查詢回應 " + m.code;
                }
                res.put("ok", true);
                res.put("message", note);
                call.resolve(res);
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }

    @PluginMethod
    public void geminiRestore(PluginCall call) {
        final String uriStr = call.getString("uri");
        final String key = call.getString("apiKey", "");
        final String model = call.getString("model", "gemini-nano-banana-2.1");
        final String imageSize = call.getString("imageSize", "4K");
        final String prompt = call.getString("prompt", "");
        final String outPrefix = call.getString("prefix", "AI" + imageSize);
        Integer md = call.getInt("maxInputDim", 2048);
        Integer q = call.getInt("quality", 95);
        final int maxInput = md == null ? 2048 : md;
        final int quality = q == null ? 95 : q;
        if (uriStr == null) {
            call.reject("缺少 uri");
            return;
        }
        if (key == null || key.trim().isEmpty()) {
            call.reject("尚未設定 Gemini API key");
            return;
        }
        exec.execute(() -> {
            try {
                Uri uri = Uri.parse(uriStr);
                progress("準備送出影像");
                Bitmap in = loadUpright(uri, maxInput);
                String ratio = nearestRatio(in.getWidth(), in.getHeight());
                String b64 = Base64.encodeToString(toJpeg(in, 92), Base64.NO_WRAP);
                in.recycle();

                // 方案 A:Interactions API
                String errA;
                String[] img = null;
                {
                    JSONObject body = new JSONObject();
                    body.put("model", model);
                    JSONArray input = new JSONArray();
                    input.put(new JSONObject().put("type", "text").put("text", prompt));
                    input.put(new JSONObject().put("type", "image").put("mime_type", "image/jpeg").put("data", b64));
                    body.put("input", input);
                    body.put("response_format", new JSONObject()
                            .put("type", "image")
                            .put("mime_type", "image/jpeg")
                            .put("aspect_ratio", ratio)
                            .put("image_size", imageSize));
                    body.put("store", false);
                    progress("Gemini 回推中(" + model + " / " + imageSize + ")");
                    Http h = request("POST", GEMINI_BASE + "/interactions", key.trim(), body.toString());
                    if (h.code == 200) {
                        img = findImage(new JSONObject(h.body));
                        errA = img == null ? "回應中沒有影像" : null;
                    } else {
                        errA = apiError(h);
                    }
                }

                // 方案 B:generateContent
                String errB = null;
                if (img == null) {
                    JSONObject body = new JSONObject();
                    JSONArray parts = new JSONArray();
                    parts.put(new JSONObject().put("text", prompt));
                    parts.put(new JSONObject().put("inlineData",
                            new JSONObject().put("mimeType", "image/jpeg").put("data", b64)));
                    body.put("contents", new JSONArray().put(new JSONObject().put("role", "user").put("parts", parts)));
                    body.put("generationConfig", new JSONObject()
                            .put("responseModalities", new JSONArray().put("IMAGE"))
                            .put("imageConfig", new JSONObject()
                                    .put("aspectRatio", ratio)
                                    .put("imageSize", imageSize)));
                    progress("改用 generateContent 再試一次");
                    Http h = request("POST", GEMINI_BASE + "/models/" + model + ":generateContent",
                            key.trim(), body.toString());
                    if (h.code == 200) {
                        img = findImage(new JSONObject(h.body));
                        if (img == null) errB = "回應中沒有影像(可能被安全機制擋下)";
                    } else {
                        errB = apiError(h);
                    }
                }
                if (img == null) {
                    throw new IOException("Gemini 回推失敗。Interactions:" + errA + (errB == null ? "" : ";generateContent:" + errB));
                }

                progress("儲存結果");
                byte[] raw = Base64.decode(img[1], Base64.DEFAULT);
                Uri out;
                if (img[0].contains("jpeg") || img[0].contains("jpg")) {
                    out = writeBytes(outPrefix, raw);
                } else {
                    Bitmap bmp = BitmapFactory.decodeByteArray(raw, 0, raw.length);
                    if (bmp == null) throw new IOException("無法解碼 Gemini 回傳影像");
                    out = writeBitmap(outPrefix, bmp, quality);
                    bmp.recycle();
                }
                JSObject res = describe(out);
                res.put("model", model);
                call.resolve(res);
            } catch (Throwable t) {
                call.reject(msg(t));
            }
        });
    }
}
