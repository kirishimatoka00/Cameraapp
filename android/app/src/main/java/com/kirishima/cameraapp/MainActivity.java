package com.kirishima.cameraapp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必須在 super.onCreate 之前註冊自訂外掛
        registerPlugin(CameraToolsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
