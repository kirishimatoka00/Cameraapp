package com.kirishima.cameraapp;

import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;

/** 光學防手震(OIS):鏡頭有回報才設定,避免不支援的值讓請求失敗。 */
final class Ois {
    private Ois() {
    }

    static boolean available(CameraCharacteristics cc) {
        if (cc == null) return false;
        int[] m = cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION);
        if (m == null) return false;
        for (int x : m) if (x == CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON) return true;
        return false;
    }

    /** @return 是否真的開啟了 OIS */
    static boolean apply(CameraCharacteristics cc, CaptureRequest.Builder b, boolean on) {
        if (cc == null || b == null) return false;
        int[] m = cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION);
        if (m == null) return false;
        boolean hasOn = false, hasOff = false;
        for (int x : m) {
            if (x == CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON) hasOn = true;
            if (x == CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF) hasOff = true;
        }
        if (on && hasOn) {
            b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON);
            return true;
        }
        if (!on && hasOff) b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF);
        return false;
    }
}
