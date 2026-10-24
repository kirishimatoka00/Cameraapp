package com.kirishima.cameraapp;

/**
 * 多張合成超解析(手持連拍的亞像素位移 → shift-and-add)。
 * 純陣列運算,不依賴 Android,可在桌面端單元測試。
 *
 * 流程:挑最銳利的一張當基準 → 金字塔全域位移 → 32px 分塊亞像素光流 →
 * 每個來源像素依光流與信心權重 splat 到放大後的輸出格點 → 以基準影格的雙線性放大作為弱先驗補洞。
 */
final class SuperRes {
    interface Progress {
        void on(String s);
    }

    static final int TILE = 32;

    private SuperRes() {
    }

    // ------------------------------------------------------------------ 公開入口

    /** @param fr n 張 ARGB 影格,尺寸皆為 w×h。@return outW×outH 的 ARGB。 */
    static int[] merge(int[][] fr, int w, int h, float U, int outW, int outH, Progress prog) {
        final int n = fr.length;
        byte[][] luma = new byte[n][];
        for (int i = 0; i < n; i++) luma[i] = lumaOf(fr[i], w, h);

        // 1. 基準影格 = 最銳利
        int ref = 0;
        double best = -1;
        for (int i = 0; i < n; i++) {
            double s = sharpness(luma[i], w, h);
            if (s > best) {
                best = s;
                ref = i;
            }
        }
        if (prog != null) prog.on("對齊影格");

        // 2. 對齊
        int gx = (w + TILE - 1) / TILE, gy = (h + TILE - 1) / TILE;
        float[][] flowX = new float[n][], flowY = new float[n][], conf = new float[n][];
        byte[] refPyr1 = down2(luma[ref], w, h);
        int w1 = w / 2, h1 = h / 2;
        byte[] refL2 = down2(refPyr1, w1, h1);
        int w2 = w1 / 2, h2 = h1 / 2;
        int[] maxFy = new int[n];
        for (int i = 0; i < n; i++) {
            flowX[i] = new float[gx * gy];
            flowY[i] = new float[gx * gy];
            conf[i] = new float[gx * gy];
            if (i == ref) {
                java.util.Arrays.fill(conf[i], 1f);
                continue;
            }
            byte[] l1 = down2(luma[i], w, h);
            byte[] l2 = down2(l1, w1, h1);
            int[] g = new int[]{0, 0};
            searchInt(refL2, l2, w2, h2, 0, 0, 8, 2, g);
            g[0] *= 2;
            g[1] *= 2;
            searchInt(refPyr1, l1, w1, h1, g[0], g[1], 2, 2, g);
            g[0] *= 2;
            g[1] *= 2;
            searchInt(luma[ref], luma[i], w, h, g[0], g[1], 2, 2, g);
            tileFlow(luma[ref], luma[i], w, h, gx, gy, g, flowX[i], flowY[i], conf[i]);
            int m = 0;
            for (int k = 0; k < gx * gy; k++) m = Math.max(m, (int) Math.ceil(Math.abs(flowY[i][k])));
            maxFy[i] = m + 2;
        }

        // 3. 分條帶 splat
        int[] out = new int[outW * outH];
        final int stripRows = Math.max(64, Math.min(512, 24_000_000 / Math.max(1, outW * 4)));
        float[] aR = new float[outW * stripRows], aG = new float[outW * stripRows],
                aB = new float[outW * stripRows], aW = new float[outW * stripRows];
        final float prior = 0.05f * n / (U * U);
        for (int oy0 = 0; oy0 < outH; oy0 += stripRows) {
            int oy1 = Math.min(outH, oy0 + stripRows);
            int rows = oy1 - oy0;
            java.util.Arrays.fill(aR, 0, outW * rows, 0f);
            java.util.Arrays.fill(aG, 0, outW * rows, 0f);
            java.util.Arrays.fill(aB, 0, outW * rows, 0f);
            java.util.Arrays.fill(aW, 0, outW * rows, 0f);
            if (prog != null) prog.on("合成 " + (int) (100.0 * oy0 / outH) + "%");
            for (int i = 0; i < n; i++) {
                int srcLo = Math.max(0, (int) Math.floor((oy0 - 2) / U) - maxFy[i] - 2);
                int srcHi = Math.min(h - 1, (int) Math.ceil((oy1 + 2) / U) + maxFy[i] + 2);
                splat(fr[i], i == ref ? null : fr[ref], w, h, srcLo, srcHi, flowX[i], flowY[i], conf[i], gx, gy, U,
                        outW, oy0, rows, aR, aG, aB, aW);
            }
            // 4. 正規化 + 基準影格先驗
            int[] rp = fr[ref];
            for (int oy = 0; oy < rows; oy++) {
                float sy = (oy + oy0 + 0.5f) / U - 0.5f;
                int y0 = clampi((int) Math.floor(sy), 0, h - 1), y1 = clampi(y0 + 1, 0, h - 1);
                float fy = sy - (float) Math.floor(sy);
                for (int ox = 0; ox < outW; ox++) {
                    float sx = (ox + 0.5f) / U - 0.5f;
                    int x0 = clampi((int) Math.floor(sx), 0, w - 1), x1 = clampi(x0 + 1, 0, w - 1);
                    float fx = sx - (float) Math.floor(sx);
                    int p00 = rp[y0 * w + x0], p10 = rp[y0 * w + x1], p01 = rp[y1 * w + x0], p11 = rp[y1 * w + x1];
                    float r = bil((p00 >> 16) & 255, (p10 >> 16) & 255, (p01 >> 16) & 255, (p11 >> 16) & 255, fx, fy);
                    float g = bil((p00 >> 8) & 255, (p10 >> 8) & 255, (p01 >> 8) & 255, (p11 >> 8) & 255, fx, fy);
                    float b = bil(p00 & 255, p10 & 255, p01 & 255, p11 & 255, fx, fy);
                    int k = oy * outW + ox;
                    float wt = aW[k] + prior;
                    int R = clampi(Math.round((aR[k] + prior * r) / wt), 0, 255);
                    int G = clampi(Math.round((aG[k] + prior * g) / wt), 0, 255);
                    int B = clampi(Math.round((aB[k] + prior * b) / wt), 0, 255);
                    out[(oy + oy0) * outW + ox] = 0xFF000000 | (R << 16) | (G << 8) | B;
                }
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ 內部

    private static float bil(int a, int b, int c, int d, float fx, float fy) {
        float top = a + (b - a) * fx, bot = c + (d - c) * fx;
        return top + (bot - top) * fy;
    }

    private static int clampi(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private static byte[] lumaOf(int[] p, int w, int h) {
        byte[] l = new byte[w * h];
        for (int i = 0; i < l.length; i++) {
            int c = p[i];
            l[i] = (byte) (((c >> 16 & 255) * 77 + (c >> 8 & 255) * 150 + (c & 255) * 29) >> 8);
        }
        return l;
    }

    private static byte[] down2(byte[] s, int w, int h) {
        int nw = w / 2, nh = h / 2;
        byte[] d = new byte[nw * nh];
        for (int y = 0; y < nh; y++) {
            int r0 = 2 * y * w, r1 = r0 + w;
            for (int x = 0; x < nw; x++) {
                int a = (s[r0 + 2 * x] & 255) + (s[r0 + 2 * x + 1] & 255) + (s[r1 + 2 * x] & 255) + (s[r1 + 2 * x + 1] & 255);
                d[y * nw + x] = (byte) ((a + 2) >> 2);
            }
        }
        return d;
    }

    private static double sharpness(byte[] l, int w, int h) {
        double s = 0;
        for (int y = 1; y < h - 1; y += 2) {
            for (int x = 1; x < w - 1; x += 2) {
                int c = l[y * w + x] & 255;
                s += Math.abs(4 * c - (l[y * w + x - 1] & 255) - (l[y * w + x + 1] & 255)
                        - (l[(y - 1) * w + x] & 255) - (l[(y + 1) * w + x] & 255));
            }
        }
        return s;
    }

    /** 以整張影像(取樣)的 SAD 在 (cx,cy) 周圍 ±R 搜尋整數位移。frame(x+dx,y+dy) ≈ ref(x,y)。結果寫入 g。 */
    private static void searchInt(byte[] ref, byte[] fr, int w, int h, int cx, int cy, int R, int stride, int[] g) {
        long best = Long.MAX_VALUE;
        int bx = cx, by = cy;
        int margin = Math.max(4, Math.abs(cx) + R + 1);
        for (int dy = cy - R; dy <= cy + R; dy++) {
            for (int dx = cx - R; dx <= cx + R; dx++) {
                int x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
                int y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
                if (x1 - x0 < w / 2 || y1 - y0 < h / 2) continue;
                long sad = 0;
                int cnt = 0;
                for (int y = y0; y < y1; y += stride) {
                    int ro = y * w, fo = (y + dy) * w + dx;
                    for (int x = x0; x < x1; x += stride) {
                        sad += Math.abs((ref[ro + x] & 255) - (fr[fo + x] & 255));
                        cnt++;
                    }
                }
                long norm = sad * 1024L / Math.max(1, cnt);
                if (norm < best) {
                    best = norm;
                    bx = dx;
                    by = dy;
                }
            }
        }
        g[0] = bx;
        g[1] = by;
    }

    private static float samp(byte[] f, int w, int h, float x, float y) {
        int x0 = (int) Math.floor(x), y0 = (int) Math.floor(y);
        float ax = x - x0, ay = y - y0;
        int x1 = x0 + 1, y1 = y0 + 1;
        x0 = clampi(x0, 0, w - 1);
        x1 = clampi(x1, 0, w - 1);
        y0 = clampi(y0, 0, h - 1);
        y1 = clampi(y1, 0, h - 1);
        float a = f[y0 * w + x0] & 255, b = f[y0 * w + x1] & 255, c = f[y1 * w + x0] & 255, d = f[y1 * w + x1] & 255;
        float top = a + (b - a) * ax, bot = c + (d - c) * ax;
        return top + (bot - top) * ay;
    }

    /** Lucas-Kanade 亞像素細化:frame(x+u, y+v) ≈ ref(x, y)。 */
    private static void lkRefine(byte[] ref, byte[] fr, int w, int h, int x0, int y0, int tw, int th, float[] uv) {
        for (int it = 0; it < 4; it++) {
            double A = 0, B = 0, C = 0, bx = 0, by = 0;
            for (int y = y0; y < y0 + th; y++) {
                for (int x = x0; x < x0 + tw; x++) {
                    float fx = x + uv[0], fy = y + uv[1];
                    if (fx < 1 || fy < 1 || fx > w - 2 || fy > h - 2) continue;
                    float ix = 0.5f * (samp(fr, w, h, fx + 1, fy) - samp(fr, w, h, fx - 1, fy));
                    float iy = 0.5f * (samp(fr, w, h, fx, fy + 1) - samp(fr, w, h, fx, fy - 1));
                    float e = (ref[y * w + x] & 255) - samp(fr, w, h, fx, fy);
                    A += ix * ix;
                    B += ix * iy;
                    C += iy * iy;
                    bx += ix * e;
                    by += iy * e;
                }
            }
            double det = A * C - B * B;
            if (det < 1e-3 * (A + C + 1) * (A + C + 1) * 0.01 || det < 1e-6) return;
            double du = (C * bx - B * by) / det, dv = (A * by - B * bx) / det;
            du = Math.max(-1, Math.min(1, du));
            dv = Math.max(-1, Math.min(1, dv));
            uv[0] += (float) du;
            uv[1] += (float) dv;
            if (Math.abs(du) < 0.01 && Math.abs(dv) < 0.01) return;
        }
    }

    private static float tileSsd(byte[] ref, byte[] fr, int w, int h, int tx0, int ty0, int tw, int th, int dx, int dy) {
        float s = 0;
        for (int y = ty0; y < ty0 + th; y++) {
            int ro = y * w, fo = (y + dy) * w + dx;
            for (int x = tx0; x < tx0 + tw; x++) {
                int d = (ref[ro + x] & 255) - (fr[fo + x] & 255);
                s += d * d;
            }
        }
        return s;
    }

    private static int tileSad(byte[] ref, byte[] fr, int w, int h, int tx0, int ty0, int tw, int th, int dx, int dy) {
        int sad = 0;
        for (int y = ty0; y < ty0 + th; y += 2) {
            int ro = y * w, fo = (y + dy) * w + dx;
            for (int x = tx0; x < tx0 + tw; x += 2) {
                sad += Math.abs((ref[ro + x] & 255) - (fr[fo + x] & 255));
            }
        }
        return sad;
    }

    /** 每個 32px 分塊在全域位移附近 ±3 搜尋,再以拋物線求亞像素。 */
    private static void tileFlow(byte[] ref, byte[] fr, int w, int h, int gx, int gy, int[] g,
                                 float[] fx, float[] fy, float[] cf) {
        final int R = 3;
        for (int ty = 0; ty < gy; ty++) {
            for (int tx = 0; tx < gx; tx++) {
                int x0 = tx * TILE, y0 = ty * TILE;
                int tw = Math.min(TILE, w - x0), th = Math.min(TILE, h - y0);
                int k = ty * gx + tx;
                // 邊緣的零碎分塊(太小)沿用全域位移
                if (tw < 16 || th < 16) {
                    fx[k] = g[0];
                    fy[k] = g[1];
                    cf[k] = 0.5f;
                    continue;
                }
                int bestS = Integer.MAX_VALUE, bdx = g[0], bdy = g[1];
                for (int dy = g[1] - R; dy <= g[1] + R; dy++) {
                    if (y0 + dy < 0 || y0 + th + dy > h) continue;
                    for (int dx = g[0] - R; dx <= g[0] + R; dx++) {
                        if (x0 + dx < 0 || x0 + tw + dx > w) continue;
                        int s = tileSad(ref, fr, w, h, x0, y0, tw, th, dx, dy);
                        if (s < bestS) {
                            bestS = s;
                            bdx = dx;
                            bdy = dy;
                        }
                    }
                }
                if (bestS == Integer.MAX_VALUE) {
                    fx[k] = g[0];
                    fy[k] = g[1];
                    cf[k] = 0f;
                    continue;
                }
                float sx = 0, sy = 0;
                boolean inX = x0 + bdx - 1 >= 0 && x0 + tw + bdx + 1 <= w;
                boolean inY = y0 + bdy - 1 >= 0 && y0 + th + bdy + 1 <= h;
                float cS = tileSsd(ref, fr, w, h, x0, y0, tw, th, bdx, bdy);
                if (inX) {
                    float m = tileSsd(ref, fr, w, h, x0, y0, tw, th, bdx - 1, bdy);
                    float p = tileSsd(ref, fr, w, h, x0, y0, tw, th, bdx + 1, bdy);
                    float den = m - 2f * cS + p;
                    if (den > 1e-3f) sx = Math.max(-0.5f, Math.min(0.5f, (m - p) / (2f * den)));
                }
                if (inY) {
                    float m = tileSsd(ref, fr, w, h, x0, y0, tw, th, bdx, bdy - 1);
                    float p = tileSsd(ref, fr, w, h, x0, y0, tw, th, bdx, bdy + 1);
                    float den = m - 2f * cS + p;
                    if (den > 1e-3f) sy = Math.max(-0.5f, Math.min(0.5f, (m - p) / (2f * den)));
                }
                float[] uv = {bdx + sx, bdy + sy};
                lkRefine(ref, fr, w, h, x0, y0, tw, th, uv);
                fx[k] = uv[0];
                fy[k] = uv[1];
                float mad = bestS / (float) (((tw + 1) / 2) * ((th + 1) / 2));
                cf[k] = -1f - mad;   // 暫存 MAD(負值標記),稍後以全影格中位數換成信心
            }
        }
        float[] mads = new float[gx * gy];
        int nm = 0;
        for (int k = 0; k < gx * gy; k++) if (cf[k] < 0f) mads[nm++] = -1f - cf[k];
        float thr = 10f;
        if (nm > 0) {
            java.util.Arrays.sort(mads, 0, nm);
            thr = Math.max(10f, 2.5f * mads[nm / 2]);
        }
        for (int k = 0; k < gx * gy; k++) {
            if (cf[k] < 0f) {
                float mad = -1f - cf[k];
                cf[k] = Math.max(0f, Math.min(1f, (1.6f * thr - mad) / (0.6f * thr)));
            }
        }
    }

    private static void splat(int[] fr, int[] refPx, int w, int h, int srcLo, int srcHi, float[] fx, float[] fy, float[] cf,
                              int gx, int gy, float U, int outW, int oy0, int rows,
                              float[] aR, float[] aG, float[] aB, float[] aW) {
        final float half = TILE / 2f;
        for (int y = srcLo; y <= srcHi; y++) {
            float ty = (y - half + 0.5f) / TILE;
            int ty0 = clampi((int) Math.floor(ty), 0, gy - 1), ty1 = clampi(ty0 + 1, 0, gy - 1);
            float wy = Math.max(0f, Math.min(1f, ty - ty0));
            for (int x = 0; x < w; x++) {
                float tx = (x - half + 0.5f) / TILE;
                int tx0 = clampi((int) Math.floor(tx), 0, gx - 1), tx1 = clampi(tx0 + 1, 0, gx - 1);
                float wx = Math.max(0f, Math.min(1f, tx - tx0));
                int k00 = ty0 * gx + tx0, k10 = ty0 * gx + tx1, k01 = ty1 * gx + tx0, k11 = ty1 * gx + tx1;
                float dxv = lerp2(fx[k00], fx[k10], fx[k01], fx[k11], wx, wy);
                float dyv = lerp2(fy[k00], fy[k10], fy[k01], fy[k11], wx, wy);
                // 信心:取四個分塊最小值,移動物體附近寧可少用
                float c = Math.min(Math.min(cf[k00], cf[k10]), Math.min(cf[k01], cf[k11]));
                if (c <= 0f) continue;
                float rx = x - dxv, ry = y - dyv;
                if (refPx != null) {
                    // 逐像素一致性檢查:與對齊後的基準影格差太多(移動物體/對齊失敗)就捨棄
                    int p0 = fr[y * w + x];
                    int rxi = clampi((int) Math.floor(rx), 0, w - 2), ryi = clampi((int) Math.floor(ry), 0, h - 2);
                    float bx = Math.max(0f, Math.min(1f, rx - rxi)), by = Math.max(0f, Math.min(1f, ry - ryi));
                    int q00 = refPx[ryi * w + rxi], q10 = refPx[ryi * w + rxi + 1];
                    int q01 = refPx[(ryi + 1) * w + rxi], q11 = refPx[(ryi + 1) * w + rxi + 1];
                    float dr = Math.abs(((p0 >> 16) & 255) - bil((q00 >> 16) & 255, (q10 >> 16) & 255, (q01 >> 16) & 255, (q11 >> 16) & 255, bx, by));
                    float dg = Math.abs(((p0 >> 8) & 255) - bil((q00 >> 8) & 255, (q10 >> 8) & 255, (q01 >> 8) & 255, (q11 >> 8) & 255, bx, by));
                    float db = Math.abs((p0 & 255) - bil(q00 & 255, q10 & 255, q01 & 255, q11 & 255, bx, by));
                    float dd = (dr + dg + db) / 3f / 40f;
                    c *= (float) Math.exp(-dd * dd);
                    if (c < 0.02f) continue;
                }
                float ox = (rx + 0.5f) * U - 0.5f, oy = (ry + 0.5f) * U - 0.5f - oy0;
                int ix = (int) Math.floor(ox), iy = (int) Math.floor(oy);
                float ax = ox - ix, ay = oy - iy;
                if (ix < -1 || ix >= outW || iy < -1 || iy >= rows) continue;
                int p = fr[y * w + x];
                float r = (p >> 16) & 255, g = (p >> 8) & 255, b = p & 255;
                for (int j = 0; j < 2; j++) {
                    int yy = iy + j;
                    if (yy < 0 || yy >= rows) continue;
                    float wyj = kern(j == 0 ? 1f - ay : ay);
                    for (int i2 = 0; i2 < 2; i2++) {
                        int xx = ix + i2;
                        if (xx < 0 || xx >= outW) continue;
                        float wt = c * wyj * kern(i2 == 0 ? 1f - ax : ax);
                        int k = yy * outW + xx;
                        aR[k] += wt * r;
                        aG[k] += wt * g;
                        aB[k] += wt * b;
                        aW[k] += wt;
                    }
                }
            }
        }
    }

    private static float kern(float t) {
        return t * t;
    }

    private static float lerp2(float a, float b, float c, float d, float wx, float wy) {
        float top = a + (b - a) * wx, bot = c + (d - c) * wx;
        return top + (bot - top) * wy;
    }
}
