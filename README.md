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


## RAW 與隱藏望遠鏡頭(v3.1)

- **RAW(DNG)**:只在「手動」模式提供。按下快門時 App 會短暫釋放 WebView 預覽,改用 Camera2 直接輸出 `RAW_SENSOR` 並以 `DngCreator` 寫成 DNG(可選同時存 JPEG)。DNG 為完整感光範圍,不含裁切/調色/變焦。
- **RAW 編輯**:編輯器內建簡易 DNG 顯影(去馬賽克 → 白平衡 → 色彩矩陣 → 線性 sRGB),EV 與白平衡/色溫/色調在線性空間處理,其餘調整在顯影後套用,存成 JPEG。僅支援未壓縮 16-bit 的 DNG(本 App 拍出的 DNG),其他 DNG 會退回系統解碼。
- **隱藏望遠鏡頭**:Galaxy Note 10+ 的望遠鏡頭(通常為相機 ID 4)不在系統相機清單內,WebView 看不到。App 會探測隱藏 ID,把它當作 2× 望遠:預覽使用主鏡頭放大 2×,按下快門時才以原生 Camera2 開啟望遠鏡頭拍攝。可在設定頁手動指定 ID。

## Note 10+ 望遠鏡頭(套件名稱偽裝)

Samsung 相機服務只對白名單套件開放隱藏鏡頭。本 App 的套件名稱為 `com.samsung.android.ruler`(參考 mattpilz.com 的作法),此時邏輯鏡頭 **ID 21** 即 2× 望遠。
安裝前必須先在手機上**解除安裝系統的「快速測量(Quick Measure / Ruler)」**,否則簽章衝突無法安裝;舊版 AI Camera Pro(com.kirishima.cameraapp)是另一個 App,可自行移除。
