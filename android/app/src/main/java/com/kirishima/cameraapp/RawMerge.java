package com.kirishima.cameraapp;

/**
 * RAW(Bayer)多張合成:在感測器原始資料上對齊、去鬼影、加權平均,雜訊最低。
 * 純陣列運算,可在桌面端測試。
 *
 * 流程:
 * 1. 每張做半解析度亮度(2×2 Bayer 方塊加總,扣黑階),前 3 張中最銳利者當基準。
 * 2. 金字塔全域位移 + 32px(半解析度)分塊位移;位移一律是偶數 RAW 像素,不破壞 Bayer 相位。
 * 3. 去鬼影:對齊後亮度差做 5×5 平均,依雜訊模型(相機回報的 NOISE_PROFILE,沒有就用中位數估計)
 *    差異 < 1.5σ 全權重、> 4σ 捨棄,中間線性 —— 移動物體與對不準處只用基準影格。
 * 4. 各 Bayer 像素加權平均,輸出同尺寸、同黑白階的 RAW16。
 */
final class RawMerge {
    interface Progress {
        void on(String s);
    }

    static final int TILE = 32;     // 半解析度像素
    static volatile int lastRef;    // 測試用:上次選的基準影格
    private static final int SEARCH = 3;

    private RawMerge() {
    }

    /**
     * @param fr       n 張 RAW16(w×h,w、h 為偶數)
     * @param black    2×2 位置的黑階 [ (0,0), (0,1), (1,0), (1,1) ]
     * @param white    白階
     * @param noiseS   相機雜訊模型 var = S·x + O(x 為 0..1 正規化),null = 自行估計
     */
    static short[] merge(short[][] fr, int w, int h, float[] black, int white, double noiseS, double noiseO, Progress prog) {
        final int n = fr.length;
        final int w2 = w / 2, h2 = h / 2;
        final float blackSum = black[0] + black[1] + black[2] + black[3];
        final double range = Math.max(1, white - (blackSum / 4));
        final boolean haveProfile = noiseS > 0 || noiseO > 0;

        // 1. 基準影格
        int ref = 0;
        double best = -1;
        for (int i = 0; i < Math.min(3, n); i++) {
            double s = sharpness(halfLuma(fr[i], w, h, blackSum), w2, h2);
            if (s > best) { best = s; ref = i; }
        }
        lastRef = ref;
        final int[] Lref = halfLuma(fr[ref], w, h, blackSum);
        final int[] Lr1 = down2(Lref, w2, h2), Lr2 = down2(Lr1, w2 / 2, h2 / 2);

        float[] acc = new float[w * h];
        float[] wsum = new float[w2 * h2];
        short[] rf = fr[ref];
        for (int p = 0; p < acc.length; p++) acc[p] = rf[p] & 0xFFFF;
        java.util.Arrays.fill(wsum, 1f);

        final int gx = (w2 + TILE - 1) / TILE, gy = (h2 + TILE - 1) / TILE;
        float[] D = new float[w2 * h2], tmp = new float[w2 * h2];
        int done = 0;
        for (int i = 0; i < n; i++) {
            if (i == ref) continue;
            done++;
            if (prog != null) prog.on("RAW 對齊合成 " + done + "/" + (n - 1));
            int[] L = halfLuma(fr[i], w, h, blackSum);
            // 2. 全域位移(L(x+dx) ≈ Lref(x))
            int[] L1 = down2(L, w2, h2), L2 = down2(L1, w2 / 2, h2 / 2);
            int[] g = {0, 0};
            search(Lr2, L2, w2 / 4, h2 / 4, 0, 0, 0, w2 / 4, h2 / 4, 8, 2, g);
            g[0] *= 2; g[1] *= 2;
            search(Lr1, L1, w2 / 2, h2 / 2, 0, 0, 0, w2 / 2, h2 / 2, 2, 2, g, g[0], g[1]);
            g[0] *= 2; g[1] *= 2;
            search(Lref, L, w2, h2, 0, 0, 0, w2, h2, 2, 2, g, g[0], g[1]);
            // 分塊
            int[] sx = new int[gx * gy], sy = new int[gx * gy];
            int[] t = new int[2];
            for (int ty = 0; ty < gy; ty++) {
                for (int tx = 0; tx < gx; tx++) {
                    int x0 = tx * TILE, y0 = ty * TILE;
                    int x1 = Math.min(w2, x0 + TILE), y1 = Math.min(h2, y0 + TILE);
                    t[0] = g[0]; t[1] = g[1];
                    search(Lref, L, w2, h2, x0, y0, 0, x1, y1, SEARCH, 1, t, g[0], g[1]);
                    sx[ty * gx + tx] = t[0];
                    sy[ty * gx + tx] = t[1];
                }
            }
            // 3. 去鬼影權重
            final int INVALID = Integer.MIN_VALUE;
            for (int y = 0; y < h2; y++) {
                int tyi = Math.min(gy - 1, y / TILE);
                for (int x = 0; x < w2; x++) {
                    int k = tyi * gx + Math.min(gx - 1, x / TILE);
                    int xs = x + sx[k], ys = y + sy[k];
                    int j = y * w2 + x;
                    if (xs < 0 || ys < 0 || xs >= w2 || ys >= h2) { D[j] = Float.NaN; continue; }
                    D[j] = Lref[j] - L[ys * w2 + xs];
                }
            }
            box5(D, tmp, w2, h2);
            double sigGlobal = 0;
            if (!haveProfile) sigGlobal = Math.max(0.5, 1.4826 * medianAbs(D));
            // 4. 累加
            short[] f = fr[i];
            for (int y = 0; y < h2; y++) {
                int tyi = Math.min(gy - 1, y / TILE);
                for (int x = 0; x < w2; x++) {
                    int j = y * w2 + x;
                    float d = D[j];
                    if (Float.isNaN(d)) continue;
                    double sig;
                    if (haveProfile) {
                        double v = Math.max(0, Lref[j] / 4.0) / range;
                        double varDn = Math.max(1e-12, noiseS * v + noiseO) * range * range;
                        sig = Math.sqrt(2 * 4 * varDn / 25.0);
                    } else sig = sigGlobal;
                    float wt = (float) ((4 * sig - Math.abs(d)) / (2.5 * sig));
                    if (wt <= 0f) continue;
                    if (wt > 1f) wt = 1f;
                    int k = tyi * gx + Math.min(gx - 1, x / TILE);
                    int ox = 2 * sx[k], oy = 2 * sy[k];
                    int rx = 2 * x, ry = 2 * y;
                    int s0 = (ry + oy) * w + rx + ox, d0 = ry * w + rx;
                    acc[d0] += wt * (f[s0] & 0xFFFF);
                    acc[d0 + 1] += wt * (f[s0 + 1] & 0xFFFF);
                    acc[d0 + w] += wt * (f[s0 + w] & 0xFFFF);
                    acc[d0 + w + 1] += wt * (f[s0 + w + 1] & 0xFFFF);
                    wsum[j] += wt;
                }
            }
        }
        short[] out = new short[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int p = y * w + x;
                float ws = (x >> 1) < w2 && (y >> 1) < h2 ? wsum[(y >> 1) * w2 + (x >> 1)] : 1f;
                int v = Math.round(acc[p] / ws);
                out[p] = (short) Math.max(0, Math.min(65535, v));
            }
        }
        return out;
    }

    /** 2×2 Bayer 方塊加總(扣黑階)→ 半解析度亮度 */
    static int[] halfLuma(short[] r, int w, int h, float blackSum) {
        int w2 = w / 2, h2 = h / 2;
        int[] o = new int[w2 * h2];
        int bs = Math.round(blackSum);
        for (int y = 0; y < h2; y++) {
            int a = 2 * y * w, b = a + w;
            for (int x = 0; x < w2; x++) {
                int s = (r[a + 2 * x] & 0xFFFF) + (r[a + 2 * x + 1] & 0xFFFF) + (r[b + 2 * x] & 0xFFFF) + (r[b + 2 * x + 1] & 0xFFFF) - bs;
                o[y * w2 + x] = s;
            }
        }
        return o;
    }

    private static int[] down2(int[] s, int w, int h) {
        int nw = w / 2, nh = h / 2;
        int[] d = new int[Math.max(1, nw * nh)];
        for (int y = 0; y < nh; y++) {
            int r0 = 2 * y * w, r1 = r0 + w;
            for (int x = 0; x < nw; x++) d[y * nw + x] = (s[r0 + 2 * x] + s[r0 + 2 * x + 1] + s[r1 + 2 * x] + s[r1 + 2 * x + 1] + 2) >> 2;
        }
        return d;
    }

    private static double sharpness(int[] l, int w, int h) {
        double s = 0;
        for (int y = 1; y < h - 1; y += 2)
            for (int x = 1; x < w - 1; x += 2) {
                int c = l[y * w + x];
                s += Math.abs(4 * c - l[y * w + x - 1] - l[y * w + x + 1] - l[(y - 1) * w + x] - l[(y + 1) * w + x]);
            }
        return s;
    }

    private static void search(int[] ref, int[] fr, int w, int h, int x0, int y0, int unused, int x1, int y1, int R, int stride, int[] g) {
        search(ref, fr, w, h, x0, y0, unused, x1, y1, R, stride, g, g[0], g[1]);
    }

    /** 在 (cx,cy) 周圍 ±R 找整數位移,使 fr(x+dx,y+dy) ≈ ref(x,y)(以平均 SAD 比較,區域為 [x0,x1)×[y0,y1))。 */
    private static void search(int[] ref, int[] fr, int w, int h, int x0, int y0, int unused, int x1, int y1,
                               int R, int stride, int[] g, int cx, int cy) {
        double bestCost = Double.MAX_VALUE;
        int bx = cx, by = cy;
        for (int dy = cy - R; dy <= cy + R; dy++) {
            for (int dx = cx - R; dx <= cx + R; dx++) {
                long sad = 0;
                int cnt = 0;
                int ya = Math.max(y0, -dy), yb = Math.min(y1, h - dy);
                int xa = Math.max(x0, -dx), xb = Math.min(x1, w - dx);
                for (int y = ya; y < yb; y += stride) {
                    int ro = y * w, fo = (y + dy) * w + dx;
                    for (int x = xa; x < xb; x += stride) {
                        sad += Math.abs(ref[ro + x] - fr[fo + x]);
                        cnt++;
                    }
                }
                if (cnt < 16) continue;
                // 輕微偏好較小位移,平坦區不會亂跳
                double cost = sad / (double) cnt * (1 + 0.002 * (Math.abs(dx - cx) + Math.abs(dy - cy)));
                if (cost < bestCost) { bestCost = cost; bx = dx; by = dy; }
            }
        }
        g[0] = bx;
        g[1] = by;
    }

    /** 5×5 平均(NaN 視為缺值) */
    private static void box5(float[] a, float[] tmp, int w, int h) {
        for (int y = 0; y < h; y++) {
            int o = y * w;
            for (int x = 0; x < w; x++) {
                float s = 0; int c = 0;
                for (int k = -2; k <= 2; k++) {
                    int xx = x + k;
                    if (xx < 0 || xx >= w) continue;
                    float v = a[o + xx];
                    if (!Float.isNaN(v)) { s += v; c++; }
                }
                tmp[o + x] = c == 0 ? Float.NaN : s / c;
            }
        }
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (Float.isNaN(a[y * w + x])) continue;
                float s = 0; int c = 0;
                for (int k = -2; k <= 2; k++) {
                    int yy = y + k;
                    if (yy < 0 || yy >= h) continue;
                    float v = tmp[yy * w + x];
                    if (!Float.isNaN(v)) { s += v; c++; }
                }
                a[y * w + x] = c == 0 ? Float.NaN : s / c;
            }
        }
    }

    private static double medianAbs(float[] a) {
        int step = Math.max(1, a.length / 200_000);
        float[] s = new float[a.length / step + 1];
        int n = 0;
        for (int i = 0; i < a.length; i += step) if (!Float.isNaN(a[i])) s[n++] = Math.abs(a[i]);
        if (n == 0) return 1;
        java.util.Arrays.sort(s, 0, n);
        return s[n / 2];
    }
}
