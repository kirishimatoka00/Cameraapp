package com.kirishima.cameraapp;

/** NV21 ↔ ARGB 與夜景色調曲線。純陣列運算,可在桌面端測試。 */
final class YuvUtil {
    private YuvUtil() {
    }

    /** NV21(Y 平面 + 交錯 VU,全範圍 BT.601,與 JPEG 相同)→ ARGB。 */
    static int[] nv21ToArgb(byte[] nv21, int w, int h) {
        int[] out = new int[w * h];
        int uvBase = w * h;
        for (int y = 0; y < h; y++) {
            int uvRow = uvBase + (y >> 1) * w;
            int o = y * w;
            for (int x = 0; x < w; x++) {
                int Y = nv21[o + x] & 255;
                int k = uvRow + (x & ~1);
                int V = (nv21[k] & 255) - 128;
                int U = (nv21[k + 1] & 255) - 128;
                int r = Y + ((91881 * V + 32768) >> 16);
                int g = Y - ((22554 * U + 46802 * V - 32768) >> 16);
                int b = Y + ((116130 * U + 32768) >> 16);
                r = r < 0 ? 0 : (r > 255 ? 255 : r);
                g = g < 0 ? 0 : (g > 255 ? 255 : g);
                b = b < 0 ? 0 : (b > 255 ? 255 : b);
                out[o + x] = 0xFF000000 | (r << 16) | (g << 8) | b;
            }
        }
        return out;
    }

    /**
     * 夜景色調:影格是刻意壓暗拍的,合成(雜訊已平均掉)後在線性亮度上補回 gain 倍,
     * 再以 Reinhard 肩部把亮部收回 1.0(避免燈光過曝),最後依亮度比例縮放 RGB(保留色彩)。
     */
    static final class NightTone implements SuperRes.Tone {
        private final float[] lut = new float[1024];   // 輸入亮度(0..255,1/4 級距)→ 增益倍率

        NightTone(float gain) {
            float g = Math.max(1f, gain);
            double W = g;   // 原本的白(1.0)乘上 gain 後要剛好落回 1.0
            for (int i = 0; i < lut.length; i++) {
                double Y = (i + 0.5) / 4.0 / 255.0;
                double lin = toLin(Y);
                double t = lin * g;
                double m = t * (1 + t / (W * W)) / (1 + t);
                double outY = toGamma(Math.min(1, m));
                lut[i] = (float) (outY / Y);
            }
        }

        @Override
        public void map(float[] rgb) {
            float Y = 0.299f * rgb[0] + 0.587f * rgb[1] + 0.114f * rgb[2];
            int i = (int) (Y * 4f);
            float k = lut[i < 0 ? 0 : (i > 1023 ? 1023 : i)];
            float r = rgb[0] * k, gg = rgb[1] * k, b = rgb[2] * k;
            float mx = Math.max(r, Math.max(gg, b));
            if (mx > 255f) {   // 飽和的燈光:降回範圍內並往白色靠,避免色偏
                float s = 255f / mx;
                r *= s; gg *= s; b *= s;
            }
            rgb[0] = r; rgb[1] = gg; rgb[2] = b;
        }

        /** 8-bit 影像直接套用(合成失敗、只剩單張時使用)。 */
        void applyArgb(int[] px) {
            float[] c = new float[3];
            for (int i = 0; i < px.length; i++) {
                int p = px[i];
                c[0] = (p >> 16) & 255; c[1] = (p >> 8) & 255; c[2] = p & 255;
                map(c);
                px[i] = 0xFF000000 | (cl(c[0]) << 16) | (cl(c[1]) << 8) | cl(c[2]);
            }
        }

        private static int cl(float v) {
            int i = Math.round(v);
            return i < 0 ? 0 : (i > 255 ? 255 : i);
        }

        private static double toLin(double v) {
            return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        }

        private static double toGamma(double v) {
            return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        }
    }
}
