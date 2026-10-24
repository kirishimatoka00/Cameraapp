package com.kirishima.cameraapp;

/**
 * 色彩調整演算(純 Java,無 Android 依賴,可在本機用 javac 驗證)。
 * 必須與前端 www/js/look.js 的 processPixels 保持同一套公式。
 *
 * 流程:sRGB→線性 → 乘上白平衡增益與 2^EV → 回 sRGB →
 *       亮部/陰影(以亮度加權的增益)→ 對比 → 飽和度 → 細節增強(unsharp,只作用於亮度)。
 */
final class LookMath {
    private LookMath() {}

    static final float K_SHADOW = 1.0f;
    static final float K_HIGHLIGHT = 0.4f;
    static final float K_CONTRAST = 0.8f;

    static final class Params {
        float ev;          // 曝光補償(檔)
        float contrast;    // -100..100
        float highlights;  // -100..100(負值壓亮部)
        float shadows;     // -100..100(正值提暗部)
        float saturation;  // -100..100
        float detail;      // 0..100
        float gr = 1f, gg = 1f, gb = 1f; // 白平衡增益

        boolean pixelNeutral() {
            return ev == 0f && contrast == 0f && highlights == 0f && shadows == 0f && saturation == 0f
                    && gr == 1f && gg == 1f && gb == 1f;
        }

        boolean neutral() {
            return pixelNeutral() && detail <= 0f;
        }
    }

    private static final float[] S2L = new float[256];
    private static final float[] L2S = new float[4097];

    static {
        for (int i = 0; i < 256; i++) {
            double c = i / 255.0;
            S2L[i] = (float) (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        }
        for (int i = 0; i <= 4096; i++) {
            double l = i / 4096.0;
            L2S[i] = (float) (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
        }
    }

    private static float enc(float x) {
        if (x <= 0f) return 0f;
        if (x >= 1f) return 1f;
        return L2S[(int) (x * 4096f + 0.5f)];
    }

    private static float clamp01(float v) {
        return v < 0f ? 0f : (v > 1f ? 1f : v);
    }

    /** 處理 px[off .. off+n) */
    static void apply(int[] px, int off, int n, Params p) {
        if (p.pixelNeutral()) return;
        final float ev2 = (float) Math.pow(2.0, p.ev);
        final float gainR = p.gr * ev2, gainG = p.gg * ev2, gainB = p.gb * ev2;
        final float cf = 1f + p.contrast / 100f * K_CONTRAST;
        final float sat = 1f + p.saturation / 100f;
        final float sh = p.shadows / 100f, hi = p.highlights / 100f;
        final boolean doTone = sh != 0f || hi != 0f;
        final boolean doContrast = p.contrast != 0f;
        final boolean doSat = p.saturation != 0f;
        for (int i = off; i < off + n; i++) {
            int c = px[i];
            float r = enc(S2L[(c >> 16) & 255] * gainR);
            float g = enc(S2L[(c >> 8) & 255] * gainG);
            float b = enc(S2L[c & 255] * gainB);
            if (doTone) {
                float l = 0.2126f * r + 0.7152f * g + 0.0722f * b;
                float f = 1f + K_SHADOW * sh * (1f - l) * (1f - l) + K_HIGHLIGHT * hi * l * l;
                r *= f; g *= f; b *= f;
            }
            if (doContrast) {
                r = (r - 0.5f) * cf + 0.5f;
                g = (g - 0.5f) * cf + 0.5f;
                b = (b - 0.5f) * cf + 0.5f;
            }
            if (doSat) {
                float l2 = 0.2126f * r + 0.7152f * g + 0.0722f * b;
                r = l2 + (r - l2) * sat;
                g = l2 + (g - l2) * sat;
                b = l2 + (b - l2) * sat;
            }
            int ri = (int) (clamp01(r) * 255f + 0.5f);
            int gi = (int) (clamp01(g) * 255f + 0.5f);
            int bi = (int) (clamp01(b) * 255f + 0.5f);
            px[i] = (c & 0xFF000000) | (ri << 16) | (gi << 8) | bi;
        }
    }

    private static void boxH(float[] src, float[] dst, int w, int h, int r, double[] pre) {
        for (int y = 0; y < h; y++) {
            int base = y * w;
            pre[0] = 0;
            for (int x = 0; x < w; x++) pre[x + 1] = pre[x] + src[base + x];
            for (int x = 0; x < w; x++) {
                int lo = Math.max(0, x - r), hi = Math.min(w, x + r + 1);
                dst[base + x] = (float) ((pre[hi] - pre[lo]) / (hi - lo));
            }
        }
    }

    private static void boxV(float[] src, float[] dst, int w, int h, int r, float[] col) {
        java.util.Arrays.fill(col, 0, w, 0f);
        int curLo = 0, curHi = -1;
        for (int y = 0; y < h; y++) {
            int newHi = Math.min(h - 1, y + r);
            while (curHi < newHi) {
                curHi++;
                int b = curHi * w;
                for (int x = 0; x < w; x++) col[x] += src[b + x];
            }
            int newLo = Math.max(0, y - r);
            while (curLo < newLo) {
                int b = curLo * w;
                for (int x = 0; x < w; x++) col[x] -= src[b + x];
                curLo++;
            }
            float inv = 1f / (curHi - curLo + 1);
            int b = y * w;
            for (int x = 0; x < w; x++) dst[b + x] = col[x] * inv;
        }
    }

    /** 以亮度做 unsharp mask;amount 約 0..1.5,radius 為模糊半徑(像素)。 */
    static void unsharp(int[] px, int w, int h, float amount, int radius) {
        if (amount <= 0f || radius < 1) return;
        float[] y = new float[w * h];
        float[] t = new float[w * h];
        for (int i = 0; i < y.length; i++) {
            int c = px[i];
            y[i] = 0.299f * ((c >> 16) & 255) + 0.587f * ((c >> 8) & 255) + 0.114f * (c & 255);
        }
        double[] pre = new double[w + 1];
        float[] col = new float[w];
        for (int k = 0; k < 2; k++) {
            boxH(y, t, w, h, radius, pre);
            boxV(t, y, w, h, radius, col);
        }
        for (int i = 0; i < y.length; i++) {
            int c = px[i];
            float orig = 0.299f * ((c >> 16) & 255) + 0.587f * ((c >> 8) & 255) + 0.114f * (c & 255);
            float d = amount * (orig - y[i]);
            int r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) + d)));
            int g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) + d)));
            int b = Math.min(255, Math.max(0, Math.round((c & 255) + d)));
            px[i] = (c & 0xFF000000) | (r << 16) | (g << 8) | b;
        }
    }

    static int detailRadius(int w, int h) {
        return Math.max(1, Math.round(Math.max(w, h) / 1500f));
    }

    static float detailAmount(float detail) {
        return detail / 100f * 1.5f;
    }
}
