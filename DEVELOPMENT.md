# AI Camera Pro 開發紀錄

本文件記錄專案從初版到目前的完整開發過程:架構、時間線、各功能設計、遇到的問題與修正、測試方式與已知限制。

- 目標裝置:Samsung Galaxy Note 10+(SM-N9750)
- 儲存庫:`kirishimatoka00/Cameraapp`(直接推送 `main`,CI 自動打包 APK 至 prerelease `latest`)
- 開發期間:2026-02-07(初始檔)、2026-10-24 ~ 2026-10-26(主要開發,共 47 次提交)

---

## 1. 專案概述

「AI Camera Pro」是以 Capacitor 打包的 Android 相機 App,核心目標是在 Note 10+ 上突破第三方 App 的限制並提升畫質:

- 多鏡頭(0.5× / 1× / 2× 望遠 / 前鏡頭兩顆)與連續數位變焦
- 取得被系統隱藏的原生望遠鏡頭
- DSLR 風格 UI、手動模式(快門 / ISO / 對焦 / EV)、RAW(DNG)、HDR、錄影
- 整合式「畫質提升」系統:多張合成、AI 放大(Real-ESRGAN)、降噪、銳利度、機身降噪,可存成設定檔
- 後期編輯器、相簿 / 檢視器、Gemini 回推放大

## 2. 技術架構

| 層級 | 內容 |
|---|---|
| 外殼 | Capacitor 8.5.3,minSdk 29 |
| 前端 | 純 JS 模組,掛在 `window.A`(`core.js`、`camera.js`、`capture.js`、`editor.js`、`gallery.js`、`enhance.js`、`settingsui.js`、`main.js` 等) |
| 原生外掛 | `CameraToolsPlugin`(前端以 `A.needNative()` 判斷)、`NativeShot`(Camera2 拍攝)、`NativePreview`(原生預覽)、`LookMath`(影像演算法)、`HdrAlign`(HDR 對齊) |
| CI | `.github/workflows/build-apk.yml`,每次推送自動打包並更新 prerelease「latest」,固定 keystore 簽署、每次遞增 versionCode 以便覆蓋安裝 |

### 關鍵設計

- **Camera2 與 WebView 相機互斥**:原生拍攝 / 錄影 / 預覽前必須先停止 WebView 串流。
- **原生預覽**:TextureView 置於透明 WebView 後方(`html.native-rec` 讓 html / body / `#viewfinder` 背景透明)。
- **執行緒**:`exec`(序列化處理佇列)、`capExec`(序列化拍攝)、`vexec`(錄影 / 預覽)、`faceExec`(人臉偵測)。處理參數(nnFlag、nnMix、dnLuma、dnChroma、dnShadow、sharpAmt、mirrorFlag、targetMpFlag)為實例欄位,於每個處理工作開始時在 `exec` 上設定,因此序列化安全。
- **背景處理**:`captureNative` 立即回傳 `{queued:true, job}`,處理完成發出 `jobDone` 事件;前端 `A.bg / bgAdd / bgDone` 與 `#bgBadge` 顯示進度,拍完即可再拍。

## 3. 隱藏望遠鏡頭與套件名稱偽裝

參考 [mattpilz.com 的 Note 10 望遠教學](https://mattpilz.com/clean-hdmi-note-10-telephoto-camera-lens/):

- 系統只對特定套件開放隱藏實體鏡頭。將 `applicationId` 設為 `com.samsung.android.ruler`(Samsung 測距 App)。
- 實測原生望遠為**相機 ID 52**,先前推測的 ID 21 保留為備用。
- 前鏡頭也有兩顆(原生 #1、#3),以縮放按鈕切換。
- 數位變焦以「所選鏡頭」為基準裁切,而非固定 1×。
- 以手遮擋實測確認望遠鏡頭確實作動後,新增「原生拍攝回報實際鏡頭 ID / 焦距 / 實體鏡頭」。
- 串流尺寸表讀不到時,優先嘗試 900–1200 萬畫素的尺寸,每種格式最多 16 組(JPEG / YUV)。
- **鏡頭鎖定**:鏡頭列新增自動 / 鎖定切換,鎖定後變焦只做數位放大,不再自動跳到望遠(chip 顯示如 🔒2×鏡)。

## 4. 開發時間線

### 2026-02-07
- `Update index.html`:最初的網頁版。

### 2026-10-24(從網頁改寫為 Android App 到原生管線)
1. 重新設計為 Capacitor App:多鏡頭、HDR、Gemini 回推、1 億畫素放大。
2. 修正預覽全黑(取景框寬度為 0)。
3. **v3.0**:DSLR 風 UI、長寬比、人臉 / 追焦、手動模式、色彩設定檔、編輯器、相簿、錄影、設定匯出。
4. **v3.1**:手動模式 RAW(DNG)、編輯器 RAW 顯影、原生隱藏望遠。
5. **v3.2**:前鏡頭與翻轉鈕、鏡像預覽 / 儲存。
6. 修正錄影儲存(data URL 的 codecs 逗號破壞 base64);隱藏望遠視為 2×。
7. 原生拍攝嘗試多組串流尺寸組合並回報診斷。
8. 以固定 keystore 簽署 debug APK、每次 CI 遞增 versionCode。
9. 錄影改為標準 MP4 remux、AAC 音訊、降低位元率。
10. **錄影改為原生 Camera2 + 硬體編碼**。
11. 套件名稱偽裝為 `com.samsung.android.ruler`;原生望遠改用 ID 52。
12. 前鏡頭支援兩顆;數位變焦預設點與標籤以基準鏡頭顯示。
13. 修正原生錄影預覽全黑。
14. 手動對焦刻度改為屈光度、步進更細。
15. 新增**多張合成超解析**(連拍對齊、LK 亞像素光流、去鬼影 shift-and-add)。
16. 隱藏右上角鏡頭資訊(避免遮擋介面)。
17. 數位變焦可放大回原尺寸 → 改為「目標畫素」(預設約 9MP,可選 12 / 24MP 或不放大)。
18. 新圖示;狀態列 / 導覽列 / 啟動畫面改純黑。
19. **望遠改用原生 Camera2 即時預覽**(可關閉、失敗退回),支援縮放。
20. 原生預覽支援點擊對焦 / 測光、人臉偵測對焦、物體追焦;真正的 AUTO 點擊對焦、拍前對焦掃描、感測器端變焦。
21. 原生拍攝新增連拍合成降噪(預設 3 張:對齊、去鬼影、平均)。

### 2026-10-25(畫質提升系統成形)
22. 本機 **Real-ESRGAN general-x4v3**(ONNX Runtime)用於數位變焦自動放大與相簿手動放大。
23. AI 放大改與一般放大混合(預設 40%)以保留細節。
24. **整合畫質提升**:多張合成 / AI 放大 / 亮度與色彩降噪 / 銳利度,設定頁 + 拍攝選單 + 修圖頁,可存設定檔。
25. 畫質處理全交給畫質提升設定(全關即為真正未處理拍攝);原生預覽支援直方圖與手動快門 / ISO / 對焦 / EV。
26. 加強亮度降噪;編輯頁畫質提升區塊移至最上方。
27. 編輯器雙指縮放 / 拖曳 / 雙擊放大;編輯器改版(底部工具列、角度 / 透視、AI 與本機物件橡皮擦)。
28. 銳利度加強;原生預覽手動對焦以 AF 位置為起點並回報機身實際焦距。
29. **背景處理佇列**、檢視 / 編輯時關閉鏡頭、`setRect` 取代重啟預覽、AI 放大改邊緣感知混合並限制差異。
30. 望遠原生預覽改**穩定對焦**;提示最近對焦距離。
31. 鏡頭鎖定與顯示;設定頁開啟時也關閉鏡頭。
32. **暗部降噪**;機身降噪(硬體)選項、粗尺度保邊降噪。
33. 機身降噪新增「最小」;移除高品質、新增「微弱」;銳利度改為不放大雜訊版本。

### 2026-10-26
34. **HDR 合成前先對齊影格**(MTB 平移對齊)。

## 5. 功能設計細節

### 5.1 畫質提升資料模型(`www/js/enhance.js`)

`enh = {burst, nn, nnMix, dnL, dnC, dnS, sharp, hal}`,存放於:

- `settings.enhCap`:拍攝選單
- `settings.enhSet`:設定頁 / 編輯器 / 檢視器預設
- `settings.enhProfiles`:自訂設定檔

遷移旗標 `settings.enhV` 目前為 4(v2:NN 預設關;v4:移除 HQ 機身降噪並改 FAST)。拍攝與設定兩處的啟用狀態互不綁定。`A.buildEnhPanel` 為共用 UI(開關、設定檔 chip、機身降噪、連拍、NN 開關與強度、四個滑桿、存 / 更新設定檔),傳給原生的參數:`nn, nnMix(0–1), dnLuma, dnChroma, dnShadow, sharpen, halNr`。

### 5.2 處理管線(`finishAndSave`)

```
centerCropAspect → centerCrop(zoom) → enhDenoise(放大前)
→ NN 4× → 縮回 → 邊緣感知 blendWithBase   (或 resizeSmooth 至目標 MP)
→ 鏡像 → enhSharpen → 儲存 / 套用 look
```

降噪放在放大之前,避免把雜訊一起放大。

### 5.3 降噪(`LookMath.denoise`)

- **色彩**:在 ¼ 解析度模糊。
- **亮度**:雙邊濾波,依暗度 LUT 調整強度,R=2 或 3,強度高時 2 輪。
- **暗部**:`darkness(y) = (1 − y/96)^1.5`,只在暗部加強。
- **粗尺度**(`coarseDenoise`):半解析度雙邊,只在平坦區混入,以濾除斑塊狀雜訊。
- 編輯器預覽用 `A.denoiseRGBA`(無粗尺度階段)。

### 5.4 銳利度(`LookMath.sharpen`)

舊版 unsharp 在 100% 時雜訊放大約 3 倍,被使用者回報「沒有明顯差異」。改為僅作用於亮度、**門檻(coring)+ 邊緣遮罩**,並限制差異量:`amount = sharp/100·3`、`core = 2 + 2·sharp/100`、遮罩 `(g−3)/20`、差異夾限 ±50。預覽端以 `A.sharpenRGBA` 同步移植。

### 5.5 機身(HAL)降噪

| 值 | 模式 |
|---|---|
| 0 | 關 |
| 4 | 微弱(連拍中 OFF / MINIMAL 交替影格) |
| 3 | 最小(MINIMAL) |
| 1 | 快速(最強) |

高品質(HQ)因抹除過度被移除並遷移為 FAST。EDGE_MODE 一律關閉。裝置不支援 MINIMAL 時退回 FAST 並提示。

### 5.6 AI 放大(Real-ESRGAN)

直接輸出出現「怪細節」與過度平滑。做法:NN 4× 輸出縮回後,以**邊緣感知混合**(`blendWithBase`)疊回一般放大結果,亮度與色彩差異皆夾限 ±40;預設改為關閉。

### 5.7 原生預覽的穩定對焦與手動控制

- 自動:`AF_MODE_AUTO` + 單次掃描,時機為啟動、變焦後、點擊後、加速度計偵測手持晃動停止後。
- 手動:`AE_MODE_OFF`(曝光時間 / ISO)、`AF_MODE_OFF` + `LENS_FOCUS_DISTANCE`(屈光度 = 1/m);`caps()` 回報曝光範圍、ISO、EV、對焦距離與最近對焦距離。
- 對焦滑桿以 AF 實際位置為起點;`nativeFocusReadback` 顯示機身回報距離(如 `0.45m✓`)。
- 直方圖(`histSource`)與 EV / 手動控制在 2× 以上與 1× 行為一致。
- `layoutFrame` 改呼叫 `setPreviewRect` 調整 TextureView,不再重啟相機。

### 5.8 HDR 影格對齊(`HdrAlign`)

使用 MTB(median threshold bitmap)平移對齊,對曝光差異不敏感。約定 `ref(x,y) ≈ img(x−sx, y−sy)`,參考影格取 `n/2`;對齊後再進行 `fuseFrames`(以飽和度 × 對比 × 曝光良好度為權重的曝光融合,分條帶處理)。

### 5.9 多張合成超解析與連拍降噪

連拍後以 LK 亞像素光流對齊,去鬼影 shift-and-add;降噪連拍(預設 3 張)為對齊後平均。連拍張數由畫質提升設定的 `burst` 決定。

### 5.10 相機生命週期

進入相簿、檢視器、編輯器、設定頁時,`camPause / camResume`(`anyViewOpen`)關閉相機,避免與其他畫面搶佔並節電。

## 6. 問題與修正紀錄

| 問題 | 原因 | 處理 |
|---|---|---|
| 預覽全黑 | 取景框寬度為 0 | 修正佈局 |
| 錄影儲存壞檔 | data URL codecs 逗號破壞 base64 | 改解析方式,之後改原生錄影 |
| 原生錄影時預覽全黑 | WebView 不透明背景遮住 TextureView | `html.native-rec` 使 html / body / `#viewfinder` 透明 |
| 望遠串流設定被拒 | 隱藏鏡頭尺寸表讀不到 | 多組尺寸 / 格式嘗試並回報診斷 |
| 更新無法覆蓋安裝 | 簽章 / versionCode 不一致 | 固定 keystore,CI 遞增 versionCode |
| 2×+ 手動對焦鏡頭一直切換 | 讀回文字使佈局變動,`layoutFrame` 重啟預覽 | `setRect` + 短文字 nowrap |
| 2×+ 近距離對焦跳動 | 連續 AF 在望遠最近距離外狂掃 | 穩定單次 AF + 提示最近對焦距離 |
| 1× 數位放大到 2× 自動換鏡 | 縮放邏輯固定切換 | 鏡頭鎖定 |
| HQ 機身降噪抹除過多 | 硬體過度平滑 | 移除 HQ;新增最小、微弱 |
| 銳化沒效果 / 放大雜訊 | 舊 unsharp 無門檻 | 門檻 + 邊緣遮罩 + 夾限 |
| AI 放大怪細節 | NN 產生幻覺紋理 | 邊緣感知混合 + 差異夾限,預設關 |
| 暗部雜訊輸原廠 | 缺少暗部與粗尺度處理 | 暗部降噪、粗尺度降噪、HAL NR |
| 補丁腳本造成 `CameraToolsPlugin` 重複方法 | 切片索引錯誤 | `git checkout` 還原後重新套用 |
| 已知小瑕疵 | `ensureEnhState` 的 v3 區塊在 v4 遷移後實質不會執行 | 無害,保留 |

## 7. 測試方式

僅能於桌面驗證演算法與前端,實機由使用者回報(螢幕截圖與樣張):

- `LookMath` / `HdrAlign` 以 `javac` 測試台(T、D、S、H)在桌面執行。
- 前端以 Playwright 冒煙測試(`NODE_PATH=$(npm root -g) node smoke.js`)。
- CI:`gh run list / watch --repo kirishimatoka00/Cameraapp`,每次推送皆需綠燈。

## 8. 已知限制與待實機驗證

- 原廠 App 的夜景畫質含多張夜間合成,第三方 App 無法取得相同 ISP 管線。
- 以下尚未在實機驗證:望遠手動對焦行為、ID 52 是否支援 MINIMAL / 微弱降噪、連拍耗時、HDR 對齊實際效果、新版銳利度觀感。
- 2× 以上手動對焦「變模糊」的根因仍未完全確認,目前以機身回報的對焦讀值(✓)輔助診斷。
- 放大至 1 億畫素屬插值,不增加真實細節;Gemini 回推為模型合成,可能偏離實景。
