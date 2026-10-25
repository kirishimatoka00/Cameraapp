package com.kirishima.cameraapp;

import android.graphics.Bitmap;
import android.graphics.Rect;

import java.util.Arrays;
import java.util.concurrent.ThreadLocalRandom;
import java.util.stream.IntStream;

/** 物件橡皮擦:本機補洞(Efros-Leung 式逐層補丁複製)與 AI 結果的羽化合成。 */
final class Eraser {
    private Eraser() { }

    interface Progress { void p(String s); }

    /** 遮罩膨脹 r 像素(方形視窗,分離式) */
    static byte[] dilate(byte[] m, int w, int h, int r) {
        if (r <= 0) return m.clone();
        byte[] t = new byte[w * h], o = new byte[w * h];
        for (int y = 0; y < h; y++) {
            int last = -1000000;
            for (int x = 0; x < w; x++) { if (m[y * w + x] != 0) last = x; if (x - last <= r) t[y * w + x] = 1; }
            last = 1000000;
            for (int x = w - 1; x >= 0; x--) { if (m[y * w + x] != 0) last = x; if (last - x <= r) t[y * w + x] = 1; }
        }
        for (int x = 0; x < w; x++) {
            int last = -1000000;
            for (int y = 0; y < h; y++) { if (t[y * w + x] != 0) last = y; if (y - last <= r) o[y * w + x] = 1; }
            last = 1000000;
            for (int y = h - 1; y >= 0; y--) { if (t[y * w + x] != 0) last = y; if (last - y <= r) o[y * w + x] = 1; }
        }
        return o;
    }

    /** 羽化 alpha(0..1):二元遮罩經兩輪方框模糊 */
    static float[] feather(byte[] m, int w, int h, int r) {
        float[] a = new float[w * h], b = new float[w * h];
        for (int i = 0; i < a.length; i++) a[i] = m[i] != 0 ? 1f : 0f;
        if (r < 1) return a;
        for (int k = 0; k < 2; k++) {
            for (int y = 0; y < h; y++) {
                double s = 0; int lo = 0, hi = -1;
                for (int x = 0; x < w; x++) {
                    int nh = Math.min(w - 1, x + r), nl = Math.max(0, x - r);
                    while (hi < nh) { hi++; s += a[y * w + hi]; }
                    while (lo < nl) { s -= a[y * w + lo]; lo++; }
                    b[y * w + x] = (float) (s / (hi - lo + 1));
                }
            }
            for (int x = 0; x < w; x++) {
                double s = 0; int lo = 0, hi = -1;
                for (int y = 0; y < h; y++) {
                    int nh = Math.min(h - 1, y + r), nl = Math.max(0, y - r);
                    while (hi < nh) { hi++; s += b[hi * w + x]; }
                    while (lo < nl) { s -= b[lo * w + x]; lo++; }
                    a[y * w + x] = (float) (s / (hi - lo + 1));
                }
            }
        }
        return a;
    }

    /** 本機補洞。mask 為原圖尺寸 0/非0;回傳補好的新 Bitmap(來源會被回收)。 */
    static Bitmap inpaintLocal(Bitmap src, byte[] mask, Progress pr) {
        final int W = src.getWidth(), H = src.getHeight();
        int x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (mask[y * W + x] != 0) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (x1 < 0) return src;
        int bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        int margin = Math.max(48, (int) (0.7 * Math.max(bw, bh)));
        Rect cr = new Rect(Math.max(0, x0 - margin), Math.max(0, y0 - margin), Math.min(W, x1 + 1 + margin), Math.min(H, y1 + 1 + margin));
        final int cw = cr.width(), ch = cr.height();
        float sc = Math.min(1f, 480f / Math.max(cw, ch));
        final int ww = Math.max(16, Math.round(cw * sc)), wh = Math.max(16, Math.round(ch * sc));
        Bitmap crop = Bitmap.createBitmap(src, cr.left, cr.top, cw, ch);
        Bitmap work = Bitmap.createScaledBitmap(crop, ww, wh, true);
        int[] px = new int[ww * wh];
        work.getPixels(px, 0, ww, 0, 0, ww, wh);
        boolean[] hole = new boolean[ww * wh];
        for (int y = 0; y < wh; y++) for (int x = 0; x < ww; x++) {
            int sx = Math.min(cw - 1, Math.round((x + 0.5f) / sc - 0.5f)), sy = Math.min(ch - 1, Math.round((y + 0.5f) / sc - 0.5f));
            hole[y * ww + x] = mask[(cr.top + sy) * W + cr.left + sx] != 0;
        }
        pr.p("本機補洞中");
        patchFill(px, ww, wh, hole);
        work.setPixels(px, 0, ww, 0, 0, ww, wh);
        Bitmap up = Bitmap.createScaledBitmap(work, cw, ch, true);
        work.recycle();
        int[] fp = new int[cw * ch], op = new int[cw * ch];
        up.getPixels(fp, 0, cw, 0, 0, cw, ch);
        up.recycle();
        crop.getPixels(op, 0, cw, 0, 0, cw, ch);
        crop.recycle();
        byte[] cm = new byte[cw * ch];
        for (int y = 0; y < ch; y++) System.arraycopy(mask, (cr.top + y) * W + cr.left, cm, y * cw, cw);
        float[] al = feather(cm, cw, ch, Math.max(2, Math.round(3 / Math.max(sc, 0.2f))));
        Bitmap out = src.isMutable() ? src : src.copy(Bitmap.Config.ARGB_8888, true);
        if (out != src) src.recycle();
        for (int i = 0; i < op.length; i++) {
            float a = Math.min(1f, al[i] * 1.6f);
            if (a <= 0f) continue;
            int p = op[i], f = fp[i];
            int r = Math.round(((p >> 16) & 255) * (1 - a) + ((f >> 16) & 255) * a);
            int g = Math.round(((p >> 8) & 255) * (1 - a) + ((f >> 8) & 255) * a);
            int b = Math.round((p & 255) * (1 - a) + (f & 255) * a);
            op[i] = 0xFF000000 | r << 16 | g << 8 | b;
        }
        out.setPixels(op, 0, cw, cr.left, cr.top, cw, ch);
        return out;
    }

    private static void patchFill(int[] px, final int w, final int h, final boolean[] hole) {
        final int P = 3;
        final boolean[] known = new boolean[w * h];
        int holes = 0;
        for (int i = 0; i < known.length; i++) { known[i] = !hole[i]; if (hole[i]) holes++; }
        if (holes == 0) return;
        // 候選補丁:整個視窗都屬於原本已知區域
        int[] pre = new int[(w + 1) * (h + 1)];
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++)
            pre[(y + 1) * (w + 1) + x + 1] = pre[y * (w + 1) + x + 1] + pre[(y + 1) * (w + 1) + x] - pre[y * (w + 1) + x] + (hole[y * w + x] ? 1 : 0);
        int[] solid = new int[w * h];
        int ns = 0;
        for (int y = P; y < h - P; y++) for (int x = P; x < w - P; x++) {
            int c = pre[(y + P + 1) * (w + 1) + x + P + 1] - pre[(y - P) * (w + 1) + x + P + 1] - pre[(y + P + 1) * (w + 1) + x - P] + pre[(y - P) * (w + 1) + x - P];
            if (c == 0) solid[ns++] = y * w + x;
        }
        if (ns == 0) {
            long sr = 0, sg = 0, sb = 0, n = 0;
            for (int i = 0; i < px.length; i++) if (known[i]) { sr += (px[i] >> 16) & 255; sg += (px[i] >> 8) & 255; sb += px[i] & 255; n++; }
            int c = n == 0 ? 0xFF808080 : 0xFF000000 | (int) (sr / n) << 16 | (int) (sg / n) << 8 | (int) (sb / n);
            for (int i = 0; i < px.length; i++) if (hole[i]) px[i] = c;
            return;
        }
        final int nsolid = ns;
        final int[] sol = solid;
        final boolean[] cur = known.clone();
        int remaining = holes;
        while (remaining > 0) {
            int[] bl = new int[remaining];
            int nb = 0;
            for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
                int i = y * w + x;
                if (cur[i]) continue;
                boolean edge = false;
                for (int dy = -1; dy <= 1 && !edge; dy++) for (int dx = -1; dx <= 1; dx++) {
                    int xx = x + dx, yy = y + dy;
                    if (xx >= 0 && yy >= 0 && xx < w && yy < h && cur[yy * w + xx]) { edge = true; break; }
                }
                if (edge) bl[nb++] = i;
            }
            if (nb == 0) break;
            final int[] fb = bl;
            final int[] res = new int[nb];
            IntStream.range(0, nb).parallel().forEach(k -> {
                int i = fb[k], tx = i % w, ty = i / w;
                int best = Integer.MAX_VALUE, bestC = -1;
                ThreadLocalRandom rnd = ThreadLocalRandom.current();
                for (int t = 0; t < 140; t++) {
                    int c = sol[rnd.nextInt(nsolid)];
                    long ssd = 0;
                    boolean cut = false;
                    for (int dy = -P; dy <= P && !cut; dy++) {
                        int yy = ty + dy;
                        if (yy < 0 || yy >= h) continue;
                        for (int dx = -P; dx <= P; dx++) {
                            int xx = tx + dx;
                            if (xx < 0 || xx >= w) continue;
                            int ti = yy * w + xx;
                            if (!cur[ti]) continue;
                            int a = px[ti], b = px[c + dy * w + dx];
                            int dr = ((a >> 16) & 255) - ((b >> 16) & 255), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
                            ssd += dr * dr + dg * dg + db * db;
                            if (ssd >= best) { cut = true; break; }
                        }
                    }
                    if (!cut && ssd < best) { best = (int) ssd; bestC = c; }
                }
                res[k] = bestC >= 0 ? px[bestC] : 0xFF808080;
            });
            for (int k = 0; k < nb; k++) { px[fb[k]] = res[k]; cur[fb[k]] = true; }
            remaining -= nb;
        }
        Arrays.fill(known, true);
    }

    /** 以 AI 結果(已縮放到原圖尺寸的 ai)只在遮罩區合成,並以遮罩外圈做色彩對齊。 */
    static Bitmap compositeAi(Bitmap src, Bitmap ai, byte[] mask, int featherR) {
        final int W = src.getWidth(), H = src.getHeight();
        int[] sp = new int[W * H], ap = new int[W * H];
        src.getPixels(sp, 0, W, 0, 0, W, H);
        ai.getPixels(ap, 0, W, 0, 0, W, H);
        byte[] ring = dilate(mask, W, H, Math.max(8, featherR * 3));
        byte[] inner = dilate(mask, W, H, Math.max(2, featherR));
        double[] ds = new double[3];
        long n = 0;
        for (int i = 0; i < sp.length; i++) if (ring[i] != 0 && inner[i] == 0) {
            for (int c = 0; c < 3; c++) { int sh = 16 - 8 * c; ds[c] += ((sp[i] >> sh) & 255) - ((ap[i] >> sh) & 255); }
            n++;
        }
        float[] shift = new float[3];
        if (n > 50) for (int c = 0; c < 3; c++) shift[c] = (float) Math.max(-25, Math.min(25, ds[c] / n));
        float[] al = feather(dilate(mask, W, H, Math.max(1, featherR / 2)), W, H, featherR);
        for (int i = 0; i < sp.length; i++) {
            float a = Math.min(1f, al[i] * 1.5f);
            if (a <= 0f) continue;
            int p = sp[i], f = ap[i], out = 0xFF000000;
            for (int c = 0; c < 3; c++) {
                int sh = 16 - 8 * c;
                float fv = Math.max(0, Math.min(255, ((f >> sh) & 255) + shift[c]));
                out |= Math.round(((p >> sh) & 255) * (1 - a) + fv * a) << sh;
            }
            sp[i] = out;
        }
        Bitmap o = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        o.setPixels(sp, 0, W, 0, 0, W, H);
        return o;
    }
}
