package com.kirishima.cameraapp;

/**
 * HDR 影格對齊:Ward 的中位數閾值點陣圖(MTB)。
 * 只比較「比中位數亮/暗」的二值圖,所以不受曝光差異影響;由粗到細金字塔,每層搜尋 ±1 像素。
 * 純 Java,可在本機驗證。
 */
final class HdrAlign {
    private HdrAlign() {}

    private static byte[] half(byte[] s, int w, int h, int[] outWH) {
        int w2 = Math.max(1, w / 2), h2 = Math.max(1, h / 2);
        byte[] d = new byte[w2 * h2];
        for (int y = 0; y < h2; y++) {
            for (int x = 0; x < w2; x++) {
                int sum = (s[2 * y * w + 2 * x] & 255) + (s[2 * y * w + Math.min(w - 1, 2 * x + 1)] & 255)
                        + (s[Math.min(h - 1, 2 * y + 1) * w + 2 * x] & 255)
                        + (s[Math.min(h - 1, 2 * y + 1) * w + Math.min(w - 1, 2 * x + 1)] & 255);
                d[y * w2 + x] = (byte) ((sum + 2) >> 2);
            }
        }
        outWH[0] = w2;
        outWH[1] = h2;
        return d;
    }

    private static int median(byte[] s) {
        int[] hist = new int[256];
        for (byte b : s) hist[b & 255]++;
        int half = s.length / 2, acc = 0;
        for (int i = 0; i < 256; i++) {
            acc += hist[i];
            if (acc > half) return i;
        }
        return 128;
    }

    /** 回傳 {sx, sy}:使 ref(x,y) ≈ img(x - sx, y - sy)。 */
    static int[] estimate(byte[] ref, byte[] img, int w, int h) {
        int levels = 0;
        int ww = w, hh = h;
        while (Math.min(ww, hh) > 24 && levels < 8) { ww /= 2; hh /= 2; levels++; }
        byte[][] pr = new byte[levels + 1][], pi = new byte[levels + 1][];
        int[][] dims = new int[levels + 1][2];
        pr[0] = ref; pi[0] = img; dims[0][0] = w; dims[0][1] = h;
        int[] wh = new int[2];
        for (int l = 1; l <= levels; l++) {
            pr[l] = half(pr[l - 1], dims[l - 1][0], dims[l - 1][1], wh);
            dims[l][0] = wh[0]; dims[l][1] = wh[1];
            pi[l] = half(pi[l - 1], dims[l - 1][0], dims[l - 1][1], wh);
        }
        int sx = 0, sy = 0;
        for (int l = levels; l >= 0; l--) {
            int lw = dims[l][0], lh = dims[l][1];
            int mr = median(pr[l]), mi = median(pi[l]);
            sx *= 2; sy *= 2;
            int bestX = sx, bestY = sy;
            long best = Long.MAX_VALUE;
            for (int dy = -1; dy <= 1; dy++) {
                for (int dx = -1; dx <= 1; dx++) {
                    int tx = sx + dx, ty = sy + dy;
                    long err = 0;
                    int y0 = Math.max(0, ty), y1 = Math.min(lh, lh + ty);
                    int x0 = Math.max(0, tx), x1 = Math.min(lw, lw + tx);
                    for (int y = y0; y < y1; y++) {
                        int rb = y * lw, ib = (y - ty) * lw - tx;
                        for (int x = x0; x < x1; x++) {
                            int a = pr[l][rb + x] & 255, b = pi[l][ib + x] & 255;
                            // 排除接近中位數的雜訊像素
                            if (Math.abs(a - mr) <= 4 || Math.abs(b - mi) <= 4) continue;
                            if ((a > mr) != (b > mi)) err++;
                        }
                    }
                    if (err < best) { best = err; bestX = tx; bestY = ty; }
                }
            }
            sx = bestX; sy = bestY;
        }
        return new int[]{sx, sy};
    }
}
