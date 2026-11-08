package com.kirishima.cameraapp;

/**
 * 高品質縮圖:在線性光(去除 sRGB 伽瑪)中做可分離 Lanczos-3 重取樣。
 * 濾波器寬度隨縮小倍率加寬(抗鋸齒),不會產生摩爾紋與鋸齒,亮暗交界也不會變暗。
 * 純陣列運算,可在桌面端測試。
 */
final class Resample {
    private Resample() {
    }

    private static final float[] TO_LIN = new float[256];
    private static final int ENC_N = 8192;
    private static final byte[] TO_SRGB = new byte[ENC_N + 1];

    static {
        for (int i = 0; i < 256; i++) {
            double v = i / 255.0;
            TO_LIN[i] = (float) (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        }
        for (int i = 0; i <= ENC_N; i++) {
            double v = i / (double) ENC_N;
            double s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
            TO_SRGB[i] = (byte) Math.max(0, Math.min(255, Math.round(s * 255)));
        }
    }

    private static int enc(float lin) {
        if (lin <= 0f) return 0;
        if (lin >= 1f) return 255;
        return TO_SRGB[(int) (lin * ENC_N + 0.5f)] & 255;
    }

    private static double lanczos3(double x) {
        x = Math.abs(x);
        if (x < 1e-8) return 1;
        if (x >= 3) return 0;
        double px = Math.PI * x;
        return 3 * Math.sin(px) * Math.sin(px / 3) / (px * px);
    }

    /** 每個輸出位置的取樣起點與權重 */
    private static final class Taps {
        int[] start;
        float[][] w;
    }

    private static Taps taps(int src, int dst) {
        double scale = src / (double) dst;
        double sup = 3 * Math.max(1, scale);
        double fs = Math.max(1, scale);
        Taps t = new Taps();
        t.start = new int[dst];
        t.w = new float[dst][];
        for (int o = 0; o < dst; o++) {
            double c = (o + 0.5) * scale - 0.5;
            int a = (int) Math.floor(c - sup) + 1, b = (int) Math.floor(c + sup);
            int n = b - a + 1;
            float[] w = new float[n];
            double sum = 0;
            for (int k = 0; k < n; k++) {
                double v = lanczos3((a + k - c) / fs);
                w[k] = (float) v;
                sum += v;
            }
            for (int k = 0; k < n; k++) w[k] /= (float) sum;
            t.start[o] = a;
            t.w[o] = w;
        }
        return t;
    }

    /** ARGB(sw×sh)→ ARGB(dw×dh)。只做縮小或等比;放大請用其他方法。 */
    static int[] downscale(int[] src, int sw, int sh, int dw, int dh) {
        Taps tx = taps(sw, dw), ty = taps(sh, dh);
        // 水平:每列 → 線性 RGB 浮點
        float[] mid = new float[dw * sh * 3];
        float[] row = new float[sw * 3];
        for (int y = 0; y < sh; y++) {
            int so = y * sw;
            for (int x = 0; x < sw; x++) {
                int p = src[so + x];
                row[3 * x] = TO_LIN[(p >> 16) & 255];
                row[3 * x + 1] = TO_LIN[(p >> 8) & 255];
                row[3 * x + 2] = TO_LIN[p & 255];
            }
            int mo = y * dw * 3;
            for (int o = 0; o < dw; o++) {
                float r = 0, g = 0, b = 0;
                float[] w = tx.w[o];
                int a = tx.start[o];
                for (int k = 0; k < w.length; k++) {
                    int x = a + k;
                    x = x < 0 ? 0 : (x >= sw ? sw - 1 : x);   // 邊緣延伸
                    float ww = w[k];
                    r += ww * row[3 * x];
                    g += ww * row[3 * x + 1];
                    b += ww * row[3 * x + 2];
                }
                mid[mo + 3 * o] = r;
                mid[mo + 3 * o + 1] = g;
                mid[mo + 3 * o + 2] = b;
            }
        }
        // 垂直
        int[] out = new int[dw * dh];
        for (int o = 0; o < dh; o++) {
            float[] w = ty.w[o];
            int a = ty.start[o];
            for (int x = 0; x < dw; x++) {
                float r = 0, g = 0, b = 0;
                for (int k = 0; k < w.length; k++) {
                    int y = a + k;
                    y = y < 0 ? 0 : (y >= sh ? sh - 1 : y);
                    int m = (y * dw + x) * 3;
                    float ww = w[k];
                    r += ww * mid[m];
                    g += ww * mid[m + 1];
                    b += ww * mid[m + 2];
                }
                out[o * dw + x] = 0xFF000000 | (enc(r) << 16) | (enc(g) << 8) | enc(b);
            }
        }
        return out;
    }
}
