package com.kirishima.cameraapp;

import android.graphics.Bitmap;
import android.graphics.Matrix;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 極簡 DNG 顯影:解析未壓縮 16-bit CFA DNG(Android DngCreator 的輸出),
 * 去馬賽克 → 白平衡 → 色彩矩陣 → 線性 sRGB →(EV / 使用者增益)→ 高光肩部 → sRGB 編碼。
 * 不支援壓縮或非 16-bit 的 DNG(呼叫端應改用系統解碼)。
 */
final class RawDev {
    static final class Unsupported extends IOException {
        Unsupported(String m) { super(m); }
    }

    static final class Dng {
        int rawW, rawH;
        short[] raw;
        int[] cfa = new int[4];           // 0=R 1=G 2=B,排列為 row-major 2x2
        float[] black = new float[4];
        float white = 65535f;
        float[] neutral = {1f, 1f, 1f};
        float[] toXyz = new float[9];     // 白平衡後的相機 RGB → XYZ(D50)
        int cropX, cropY, cropW, cropH;   // 輸出範圍(raw 座標)
        int areaTop, areaLeft;            // CFA 相位參考
        int orientation = 1;
    }

    // ---------------------------------------------------------------- TIFF 解析

    private static final class Entry {
        int tag, type, count;
        int valueOff;                     // 值所在位置(絕對位移)
    }

    private static final class Tiff {
        final ByteBuffer b;
        Tiff(byte[] d) {
            b = ByteBuffer.wrap(d);
            if (d.length < 8) throw new IllegalArgumentException("檔案過小");
            if (d[0] == 'I' && d[1] == 'I') b.order(ByteOrder.LITTLE_ENDIAN);
            else if (d[0] == 'M' && d[1] == 'M') b.order(ByteOrder.BIG_ENDIAN);
            else throw new IllegalArgumentException("不是 TIFF/DNG");
        }

        Map<Integer, Entry> ifd(int off) {
            Map<Integer, Entry> m = new HashMap<>();
            int n = b.getShort(off) & 0xFFFF;
            for (int i = 0; i < n; i++) {
                int p = off + 2 + i * 12;
                Entry e = new Entry();
                e.tag = b.getShort(p) & 0xFFFF;
                e.type = b.getShort(p + 2) & 0xFFFF;
                e.count = b.getInt(p + 4);
                int sz = typeSize(e.type) * e.count;
                e.valueOff = sz <= 4 ? p + 8 : b.getInt(p + 8);
                m.put(e.tag, e);
            }
            return m;
        }

        int nextIfd(int off) {
            int n = b.getShort(off) & 0xFFFF;
            return b.getInt(off + 2 + n * 12);
        }

        static int typeSize(int t) {
            switch (t) {
                case 1: case 2: case 6: case 7: return 1;
                case 3: case 8: return 2;
                case 4: case 9: case 11: return 4;
                case 5: case 10: case 12: return 8;
                default: return 1;
            }
        }

        double num(Entry e, int i) {
            int p = e.valueOff + i * typeSize(e.type);
            switch (e.type) {
                case 1: case 7: return b.get(p) & 0xFF;
                case 6: return b.get(p);
                case 3: return b.getShort(p) & 0xFFFF;
                case 8: return b.getShort(p);
                case 4: return b.getInt(p) & 0xFFFFFFFFL;
                case 9: return b.getInt(p);
                case 11: return b.getFloat(p);
                case 12: return b.getDouble(p);
                case 5: {
                    long n = b.getInt(p) & 0xFFFFFFFFL, d = b.getInt(p + 4) & 0xFFFFFFFFL;
                    return d == 0 ? 0 : (double) n / d;
                }
                case 10: {
                    int n = b.getInt(p), d = b.getInt(p + 4);
                    return d == 0 ? 0 : (double) n / d;
                }
                default: return 0;
            }
        }

        double[] nums(Entry e) {
            double[] r = new double[e.count];
            for (int i = 0; i < e.count; i++) r[i] = num(e, i);
            return r;
        }
    }

    private static double one(Tiff t, Map<Integer, Entry> m, int tag, double def) {
        Entry e = m.get(tag);
        return e == null || e.count < 1 ? def : t.num(e, 0);
    }

    static boolean looksLikeDng(byte[] d) {
        return d != null && d.length > 8 && ((d[0] == 'I' && d[1] == 'I' && d[2] == 42) || (d[0] == 'M' && d[1] == 'M' && d[3] == 42));
    }

    static Dng parse(byte[] data) throws IOException {
        Tiff t;
        try {
            t = new Tiff(data);
        } catch (RuntimeException e) {
            throw new Unsupported("不是 DNG:" + e.getMessage());
        }
        try {
            return parse0(t, data);
        } catch (IndexOutOfBoundsException | IllegalArgumentException e) {
            throw new Unsupported("DNG 結構無法解析");
        }
    }

    private static Dng parse0(Tiff t, byte[] data) throws IOException {
        int ifd0Off = t.b.getInt(4);
        Map<Integer, Entry> ifd0 = t.ifd(ifd0Off);

        List<Map<Integer, Entry>> all = new ArrayList<>();
        all.add(ifd0);
        Entry sub = ifd0.get(330);
        if (sub != null) for (int i = 0; i < sub.count; i++) all.add(t.ifd((int) t.num(sub, i)));
        int nx = t.nextIfd(ifd0Off);
        int guard = 0;
        while (nx > 0 && nx < data.length && guard++ < 4) {
            all.add(t.ifd(nx));
            nx = t.nextIfd(nx);
        }

        Map<Integer, Entry> rawIfd = null;
        for (Map<Integer, Entry> m : all) {
            double photo = one(t, m, 262, -1);
            if (photo == 32803 || photo == 34892) {
                if (rawIfd == null || one(t, m, 256, 0) > one(t, rawIfd, 256, 0)) rawIfd = m;
            }
        }
        if (rawIfd == null) throw new Unsupported("找不到 RAW 影像資料");
        if (one(t, rawIfd, 262, 0) != 32803) throw new Unsupported("不是 CFA RAW");
        if (one(t, rawIfd, 259, 1) != 1) throw new Unsupported("壓縮 DNG 不支援");
        if (one(t, rawIfd, 258, 16) != 16) throw new Unsupported("僅支援 16-bit RAW");
        if (rawIfd.get(324) != null || rawIfd.get(325) != null) throw new Unsupported("不支援分塊 DNG");

        Dng d = new Dng();
        d.rawW = (int) one(t, rawIfd, 256, 0);
        d.rawH = (int) one(t, rawIfd, 257, 0);
        if (d.rawW <= 0 || d.rawH <= 0 || (long) d.rawW * d.rawH > 120_000_000L) throw new Unsupported("RAW 尺寸異常");

        // 影像資料
        Entry so = rawIfd.get(273), sc = rawIfd.get(279);
        if (so == null || sc == null) throw new Unsupported("缺少影像位置");
        int rps = (int) one(t, rawIfd, 278, d.rawH);
        d.raw = new short[d.rawW * d.rawH];
        int row = 0;
        for (int s = 0; s < so.count && row < d.rawH; s++) {
            int off = (int) t.num(so, s);
            int rows = Math.min(rps, d.rawH - row);
            int bytes = rows * d.rawW * 2;
            if (off < 0 || off + bytes > data.length) throw new Unsupported("RAW 資料不完整");
            ByteBuffer sb = ByteBuffer.wrap(data, off, bytes).order(t.b.order());
            sb.asShortBuffer().get(d.raw, row * d.rawW, rows * d.rawW);
            row += rows;
        }
        if (row < d.rawH) throw new Unsupported("RAW 資料不完整");

        // CFA
        Entry cp = rawIfd.get(33422);
        if (cp == null || cp.count < 4) throw new Unsupported("缺少 CFA 排列");
        Entry dim = rawIfd.get(33421);
        if (dim != null && dim.count >= 2 && (t.num(dim, 0) != 2 || t.num(dim, 1) != 2)) throw new Unsupported("僅支援 2×2 CFA");
        for (int i = 0; i < 4; i++) {
            int c = (int) t.num(cp, i);
            d.cfa[i] = c == 0 ? 0 : c == 2 ? 2 : 1;   // 1 與 其他(如 G2)都當綠色
        }

        // 黑/白位準
        Entry bl = rawIfd.get(50714);
        if (bl != null && bl.count >= 4) for (int i = 0; i < 4; i++) d.black[i] = (float) t.num(bl, i);
        else if (bl != null && bl.count >= 1) java.util.Arrays.fill(d.black, (float) t.num(bl, 0));
        d.white = (float) one(t, rawIfd, 50717, 65535);
        if (d.white <= 1) d.white = 65535f;

        // 有效區 / 裁切
        int top = 0, left = 0, bottom = d.rawH, right = d.rawW;
        Entry aa = rawIfd.get(50829);
        if (aa != null && aa.count >= 4) {
            top = (int) t.num(aa, 0); left = (int) t.num(aa, 1);
            bottom = (int) t.num(aa, 2); right = (int) t.num(aa, 3);
        }
        d.areaTop = top; d.areaLeft = left;
        int cx = left, cy = top, cw = right - left, ch = bottom - top;
        Entry co = rawIfd.get(50719), cs = rawIfd.get(50720);
        if (co != null && cs != null && co.count >= 2 && cs.count >= 2) {
            cx = left + (int) t.num(co, 0);
            cy = top + (int) t.num(co, 1);
            cw = (int) t.num(cs, 0);
            ch = (int) t.num(cs, 1);
        }
        cx = Math.max(0, cx); cy = Math.max(0, cy);
        cw = Math.min(cw, d.rawW - cx); ch = Math.min(ch, d.rawH - cy);
        if (cw < 8 || ch < 8) throw new Unsupported("輸出範圍異常");
        d.cropX = cx; d.cropY = cy; d.cropW = cw; d.cropH = ch;

        // 色彩資訊(可能在 IFD0 或 RAW IFD)
        Map<Integer, Entry> meta = ifd0.containsKey(50728) || ifd0.containsKey(50964) || ifd0.containsKey(50722) ? ifd0 : rawIfd;
        Entry an = meta.get(50728);
        if (an == null) an = rawIfd.get(50728);
        if (an != null && an.count >= 3) {
            for (int i = 0; i < 3; i++) d.neutral[i] = (float) Math.max(1e-3, t.num(an, i));
        }
        d.orientation = (int) one(t, ifd0, 274, 1);

        double[] fm = matrix(t, meta, 50964, 50965, rawIfd);
        if (fm == null) {
            double[] cm = matrix(t, meta, 50721, 50722, rawIfd);
            if (cm == null) throw new Unsupported("缺少色彩矩陣");
            fm = fromColorMatrix(cm);
        }
        for (int i = 0; i < 9; i++) d.toXyz[i] = (float) fm[i];
        return d;
    }

    /** 取兩組矩陣(若兩組皆有就平均),找不到回傳 null。 */
    private static double[] matrix(Tiff t, Map<Integer, Entry> m, int tag1, int tag2, Map<Integer, Entry> alt) {
        double[] a = mat(t, m.get(tag1) != null ? m.get(tag1) : alt.get(tag1));
        double[] b = mat(t, m.get(tag2) != null ? m.get(tag2) : alt.get(tag2));
        if (a != null && b != null) {
            double[] r = new double[9];
            for (int i = 0; i < 9; i++) r[i] = 0.5 * (a[i] + b[i]);
            return r;
        }
        return a != null ? a : b;
    }

    private static double[] mat(Tiff t, Entry e) {
        if (e == null || e.count < 9) return null;
        double[] r = new double[9];
        for (int i = 0; i < 9; i++) r[i] = t.num(e, i);
        return r;
    }

    private static final double[] D50 = {0.9642, 1.0, 0.8249};

    /** 沒有 ForwardMatrix 時的近似:inv(ColorMatrix),再把白點對齊 D50。 */
    private static double[] fromColorMatrix(double[] cm) {
        double[] inv = inv3(cm);
        if (inv == null) return new double[]{0.4361, 0.3851, 0.1431, 0.2225, 0.7169, 0.0606, 0.0139, 0.0971, 0.7141};
        for (int r = 0; r < 3; r++) {
            double s = inv[r * 3] + inv[r * 3 + 1] + inv[r * 3 + 2];
            if (Math.abs(s) < 1e-9) continue;
            double k = D50[r] / s;
            for (int c = 0; c < 3; c++) inv[r * 3 + c] *= k;
        }
        return inv;
    }

    private static double[] inv3(double[] m) {
        double a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
        double det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
        if (Math.abs(det) < 1e-12) return null;
        double k = 1.0 / det;
        return new double[]{
                (e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k,
                (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k,
                (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k};
    }

    // ---------------------------------------------------------------- 顯影

    private static final float[] XYZ_TO_SRGB = {
            3.1338561f, -1.6168667f, -0.4906146f,
            -0.9787684f, 1.9161415f, 0.0334540f,
            0.0719453f, -0.2289914f, 1.4052427f};

    private static final float[] ENC = new float[4097];
    static {
        for (int i = 0; i <= 4096; i++) {
            double l = i / 4096.0;
            ENC[i] = (float) (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
        }
    }

    private static float shoulder(float x) {
        if (x <= 0f) return 0f;
        if (x < 0.8f) return x;
        return 1f - 0.2f * (float) Math.exp(-(x - 0.8f) / 0.2f);
    }

    private static int enc8(float lin) {
        float v = shoulder(lin);
        int idx = (int) (v * 4096f + 0.5f);
        if (idx > 4096) idx = 4096;
        return (int) (ENC[idx] * 255f + 0.5f);
    }

    /** 影像尺寸(已套用方向),供 describe 使用。 */
    static int[] size(Dng d) {
        boolean swap = d.orientation == 6 || d.orientation == 8 || d.orientation == 5 || d.orientation == 7;
        return swap ? new int[]{d.cropH, d.cropW} : new int[]{d.cropW, d.cropH};
    }

    /**
     * @param half   true:2×2 合併(輸出為一半尺寸,速度快,適合預覽)
     * @param ev     曝光調整(EV)
     * @param gains  線性 sRGB 的使用者增益(R,G,B)
     */
    static Bitmap develop(Dng d, boolean half, float ev, float[] gains) {
        // 白平衡增益(綠色為 1)與 相機→線性 sRGB 矩陣
        float[] wb = {d.neutral[1] / d.neutral[0], 1f, d.neutral[1] / d.neutral[2]};
        float[] m = new float[9];
        for (int r = 0; r < 3; r++) {
            for (int c = 0; c < 3; c++) {
                float s = 0f;
                for (int k = 0; k < 3; k++) s += XYZ_TO_SRGB[r * 3 + k] * d.toXyz[k * 3 + c];
                m[r * 3 + c] = s;
            }
        }
        float ev2 = (float) Math.pow(2.0, ev);
        float uR = gains[0] * ev2, uG = gains[1] * ev2, uB = gains[2] * ev2;
        // 高光裁切位準:白平衡後的飽和值,避免單一通道先爆造成洋紅色
        float clipLevel = Math.min(wb[0], Math.min(wb[1], wb[2]));
        float scale[] = new float[4];
        float[] bl = d.black;

        final int step = half ? 2 : 1;
        final int ow = d.cropW / step, oh = d.cropH / step;
        Bitmap bmp = Bitmap.createBitmap(ow, oh, Bitmap.Config.ARGB_8888);
        final int rowsPer = 32;
        int[] strip = new int[ow * rowsPer];
        for (int i = 0; i < 4; i++) scale[i] = 1f / Math.max(1f, d.white - bl[i]);

        final short[] raw = d.raw;
        final int W = d.rawW, H = d.rawH;
        final int oxPar = d.areaLeft & 1, oyPar = d.areaTop & 1;
        float[] sum = new float[3];
        int[] cnt = new int[3];

        for (int y0 = 0; y0 < oh; y0 += rowsPer) {
            int rows = Math.min(rowsPer, oh - y0);
            for (int yy = 0; yy < rows; yy++) {
                int oy = y0 + yy;
                for (int ox = 0; ox < ow; ox++) {
                    int px = d.cropX + ox * step, py = d.cropY + oy * step;
                    sum[0] = sum[1] = sum[2] = 0f;
                    cnt[0] = cnt[1] = cnt[2] = 0;
                    int ya = half ? 0 : -1, yb = half ? 1 : 1, xa = half ? 0 : -1, xb = half ? 1 : 1;
                    for (int dy = ya; dy <= yb; dy++) {
                        int sy = py + dy;
                        if (sy < 0) sy = -sy; else if (sy >= H) sy = 2 * (H - 1) - sy;
                        for (int dx = xa; dx <= xb; dx++) {
                            int sx = px + dx;
                            if (sx < 0) sx = -sx; else if (sx >= W) sx = 2 * (W - 1) - sx;
                            int ci = (((sy + oyPar) & 1) << 1) | ((sx + oxPar) & 1);
                            float v = ((raw[sy * W + sx] & 0xFFFF) - bl[ci]) * scale[ci];
                            if (v < 0f) v = 0f;
                            int ch = d.cfa[ci];
                            sum[ch] += v;
                            cnt[ch]++;
                        }
                    }
                    float r = cnt[0] > 0 ? sum[0] / cnt[0] : 0f;
                    float g = cnt[1] > 0 ? sum[1] / cnt[1] : 0f;
                    float b = cnt[2] > 0 ? sum[2] / cnt[2] : 0f;
                    // 白平衡 + 高光裁切(避免單一通道先爆造成洋紅色)
                    float cr = Math.min(r * wb[0], clipLevel);
                    float cg = Math.min(g * wb[1], clipLevel);
                    float cb = Math.min(b * wb[2], clipLevel);
                    float lr = (m[0] * cr + m[1] * cg + m[2] * cb) * uR;
                    float lg = (m[3] * cr + m[4] * cg + m[5] * cb) * uG;
                    float lb = (m[6] * cr + m[7] * cg + m[8] * cb) * uB;
                    strip[yy * ow + ox] = 0xFF000000 | (enc8(lr) << 16) | (enc8(lg) << 8) | enc8(lb);
                }
            }
            bmp.setPixels(strip, 0, ow, 0, y0, ow, rows);
        }
        return orient(bmp, d.orientation);
    }

    private static Bitmap orient(Bitmap src, int o) {
        Matrix mx = new Matrix();
        switch (o) {
            case 3: mx.postRotate(180); break;
            case 6: mx.postRotate(90); break;
            case 8: mx.postRotate(270); break;
            case 2: mx.postScale(-1, 1); break;
            case 4: mx.postScale(1, -1); break;
            case 5: mx.postRotate(90); mx.postScale(-1, 1); break;
            case 7: mx.postRotate(270); mx.postScale(-1, 1); break;
            default: return src;
        }
        Bitmap r = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), mx, true);
        if (r != src) src.recycle();
        return r;
    }
}
