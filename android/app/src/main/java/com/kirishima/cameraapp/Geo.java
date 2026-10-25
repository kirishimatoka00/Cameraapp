package com.kirishima.cameraapp;

import android.graphics.Bitmap;
import android.graphics.Matrix;

import java.util.stream.IntStream;

/** 角度(拉直)與透視變形。與前端 www/js/geo.js 的數學一致。 */
final class Geo {
    private Geo() { }

    static boolean neutral(float angle, float pv, float ph, int rot, boolean flip) {
        return Math.abs(angle) < 0.01f && Math.abs(pv) < 0.5f && Math.abs(ph) < 0.5f && (rot & 3) == 0 && !flip;
    }

    /** 反向對應:輸出像素 (x,y) → 來源座標;回傳 false 表示超出來源 */
    private static boolean map(float x, float y, int w, int h, float s, float cos, float sin, float kv, float kh, float[] o) {
        float X = (x - w / 2f + 0.5f) / s, Y = (y - h / 2f + 0.5f) / s;
        float X1 = X * (1f + kv * Y / h), Y1 = Y * (1f + kh * X / w);
        o[0] = X1 * cos - Y1 * sin + w / 2f - 0.5f;
        o[1] = X1 * sin + Y1 * cos + h / 2f - 0.5f;
        return o[0] >= 0 && o[1] >= 0 && o[0] <= w - 1 && o[1] <= h - 1;
    }

    static float coverScale(int w, int h, float cos, float sin, float kv, float kh) {
        float[] o = new float[2];
        for (float s = 1f; s < 3f; s += 0.004f) {
            boolean ok = true;
            for (int i = 0; i <= 8 && ok; i++) {
                float t = i / 8f;
                float[][] pts = {{t * (w - 1), 0}, {t * (w - 1), h - 1}, {0, t * (h - 1)}, {w - 1, t * (h - 1)}};
                for (float[] p : pts) if (!map(p[0], p[1], w, h, s, cos, sin, kv, kh, o)) { ok = false; break; }
            }
            if (ok) return s;
        }
        return 3f;
    }

    static Bitmap apply(Bitmap src, float angleDeg, float pv, float ph, int rot, boolean flip) {
        Bitmap b = src;
        rot &= 3;
        if (rot != 0 || flip) {
            Matrix m = new Matrix();
            if (flip) m.postScale(-1f, 1f);
            m.postRotate(90f * rot);
            b = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), m, true);
            if (b != src) src.recycle();
        }
        if (Math.abs(angleDeg) < 0.01f && Math.abs(pv) < 0.5f && Math.abs(ph) < 0.5f) return b;
        final int w = b.getWidth(), h = b.getHeight();
        final float a = (float) Math.toRadians(angleDeg), cos = (float) Math.cos(a), sin = (float) Math.sin(a);
        final float kv = pv / 100f * 0.35f, kh = ph / 100f * 0.35f;
        final float s = coverScale(w, h, cos, sin, kv, kh);
        final int[] sp = new int[w * h];
        b.getPixels(sp, 0, w, 0, 0, w, h);
        b.recycle();
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        final int strip = 128;
        for (int y0 = 0; y0 < h; y0 += strip) {
            final int rows = Math.min(strip, h - y0), fy0 = y0;
            final int[] buf = new int[w * rows];
            IntStream.range(0, rows).parallel().forEach(r -> {
                float[] o = new float[2];
                for (int x = 0; x < w; x++) {
                    map(x, fy0 + r, w, h, s, cos, sin, kv, kh, o);
                    float fx = Math.max(0f, Math.min(w - 1f, o[0])), fy = Math.max(0f, Math.min(h - 1f, o[1]));
                    int ix = (int) fx, iy = (int) fy, jx = Math.min(w - 1, ix + 1), jy = Math.min(h - 1, iy + 1);
                    float wx = fx - ix, wy = fy - iy;
                    int c00 = sp[iy * w + ix], c10 = sp[iy * w + jx], c01 = sp[jy * w + ix], c11 = sp[jy * w + jx];
                    int res = 0xFF000000;
                    for (int sh = 16; sh >= 0; sh -= 8) {
                        float v = (((c00 >> sh) & 255) * (1 - wx) + ((c10 >> sh) & 255) * wx) * (1 - wy)
                                + (((c01 >> sh) & 255) * (1 - wx) + ((c11 >> sh) & 255) * wx) * wy;
                        res |= (Math.min(255, Math.max(0, Math.round(v)))) << sh;
                    }
                    buf[r * w + x] = res;
                }
            });
            out.setPixels(buf, 0, w, 0, y0, w, rows);
        }
        return out;
    }
}
