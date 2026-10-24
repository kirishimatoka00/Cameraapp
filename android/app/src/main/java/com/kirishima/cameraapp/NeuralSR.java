package com.kirishima.cameraapp;

import android.content.Context;
import android.graphics.Bitmap;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.Collections;

/**
 * 本機神經網路超解析:Real-ESRGAN「realesr-general-x4v3」(SRVGGNetCompact,約 5MB)經 ONNX Runtime 在手機 CPU 上分塊推論,固定 4×。
 */
final class NeuralSR {
    interface Progress {
        void on(String s);
    }

    private static final int T = 128;      // 輸入分塊邊長(模型固定尺寸)
    private static final int PAD = 10;     // 分塊重疊邊界(丟棄,避免接縫)
    private static final int SCALE = 4;

    private NeuralSR() {
    }

    private static byte[] readModel(Context ctx) throws IOException {
        try (InputStream is = ctx.getAssets().open("sr_x4.onnx")) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(1 << 23);
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    /** 輸入 w×h → 輸出 (4w)×(4h)。呼叫端須保證尺寸合理(輸出像素數 = 16 × 輸入)。 */
    static Bitmap upscale4x(Context ctx, Bitmap src, Progress prog) throws Exception {
        final int w = src.getWidth(), h = src.getHeight();
        int[] px = new int[w * h];
        src.getPixels(px, 0, w, 0, 0, w, h);
        Bitmap out = Bitmap.createBitmap(w * SCALE, h * SCALE, Bitmap.Config.ARGB_8888);
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions so = new OrtSession.SessionOptions();
        so.setIntraOpNumThreads(Math.max(2, Math.min(6, Runtime.getRuntime().availableProcessors())));
        so.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        OrtSession session = env.createSession(readModel(ctx), so);
        try {
            final int core = T - 2 * PAD;
            int tx = (w + core - 1) / core, ty = (h + core - 1) / core;
            int total = tx * ty, done = 0;
            float[] in = new float[3 * T * T];
            int[] line = new int[core * SCALE * core * SCALE];
            for (int j = 0; j < ty; j++) {
                for (int i = 0; i < tx; i++) {
                    int cx = i * core, cy = j * core;
                    int ox = cx - PAD, oy = cy - PAD;
                    // 擷取輸入視窗(邊緣以最近像素補齊)
                    for (int y = 0; y < T; y++) {
                        int sy = Math.max(0, Math.min(h - 1, oy + y));
                        for (int x = 0; x < T; x++) {
                            int sx = Math.max(0, Math.min(w - 1, ox + x));
                            int p = px[sy * w + sx];
                            int k = y * T + x;
                            in[k] = ((p >> 16) & 255) / 255f;
                            in[T * T + k] = ((p >> 8) & 255) / 255f;
                            in[2 * T * T + k] = (p & 255) / 255f;
                        }
                    }
                    OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(in), new long[]{1, 3, T, T});
                    try (OrtSession.Result r = session.run(Collections.singletonMap("x", t))) {
                        FloatBuffer o = ((OnnxTensor) r.get(0)).getFloatBuffer();
                        int OT = T * SCALE;
                        int cw = Math.min(core, w - cx), ch = Math.min(core, h - cy);
                        int ow = cw * SCALE, oh = ch * SCALE;
                        for (int y = 0; y < oh; y++) {
                            int yy = (PAD * SCALE + y) * OT;
                            for (int x = 0; x < ow; x++) {
                                int xx = PAD * SCALE + x;
                                int rr = clamp(o.get(yy + xx));
                                int gg = clamp(o.get(OT * OT + yy + xx));
                                int bb = clamp(o.get(2 * OT * OT + yy + xx));
                                line[y * ow + x] = 0xFF000000 | (rr << 16) | (gg << 8) | bb;
                            }
                        }
                        out.setPixels(line, 0, ow, cx * SCALE, cy * SCALE, ow, oh);
                    } finally {
                        t.close();
                    }
                    done++;
                    if (prog != null && (done % 4 == 0 || done == total)) prog.on("AI 放大 " + (100 * done / total) + "%");
                }
            }
        } finally {
            session.close();
            so.close();
        }
        return out;
    }

    private static int clamp(float v) {
        int i = Math.round(v * 255f);
        return i < 0 ? 0 : (i > 255 ? 255 : i);
    }
}
