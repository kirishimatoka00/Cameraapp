# AI Camera Pro

Capacitor 打包的 Android 相機 App:多鏡頭切換、可調式 HDR 合成、Gemini 圖像模型回推數位變焦(最高 4K)、拍後放大至 1 億畫素。

## 取得 APK

- 到本儲存庫的 **Releases → Latest debug build** 下載 `AICameraPro-debug.apk`
- 或到 **Actions → Build Android APK** 的最新一次執行下載 artifact
- 也可在 Actions 頁手動按 **Run workflow** 重新打包

需要 Android 10(API 29)以上,安裝時需允許「安裝未知來源 App」。

## 功能

- **鏡頭切換**:0.5×(廣角)/ 1× / 2×(望遠,Galaxy Note 10+)與連續數位變焦(最高 10×);設定頁可手動指定鏡頭對應,並顯示偵測到的鏡頭清單
- **HDR**:可選合成張數(3/5/7/9)與 EV ±範圍(±0.5 ~ ±3),曝光融合在原生端分條帶處理
- **放大檢視器**:雙指縮放,放大後以原生像素分塊載入;可一鍵放大到 1 億畫素(記憶體不足自動降級)
- **Gemini 回推**:數位變焦照片交由 Gemini 圖像模型重建細節,輸出 1K / 2K / 4K
- **設定頁**:Gemini API key、模型、解析度、提示詞、HDR 參數、JPEG 品質、鏡頭對應

照片存放在 `Pictures/AICamera`。

## 本機開發

```bash
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug
```

## 注意事項

- 放大到 1 億畫素是插值,不會增加真實細節;Gemini 回推是模型合成,結果可能偏離實景
- Samsung 可能只開放部分實體鏡頭給第三方 App,實際能否使用 2× 望遠請看設定頁的鏡頭清單
- API key 存在本機 WebView 儲存空間,影像會直接送往 Google 的 Gemini API
