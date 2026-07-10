# ClickDeck Pro（靜態網頁版）

本機優先的 HTML 簡報編輯器，靜態化改造版本。可直接部署到 GitHub Pages，用網址開啟即用，不需要 Python、不需要啟動任何伺服器。

原始的本機伺服器版本（`editor/start.bat` + `server.py`）仍完整保留，兩者互不影響。

## 使用方式

1. 用 **Chrome 或 Edge** 開啟部署後的網址（Firefox / Safari 不支援瀏覽器檔案存取 API，按鈕會變灰）。
2. 按「選擇資料夾」挑選存放簡報 `.html` 的資料夾，或按「選擇檔案」開單一檔案，並允許寫入權限。
3. 編輯文字、圖片、連結、配色、字體，新增／刪除／排序投影片。
4. 按「儲存」直接寫回你本機硬碟的原檔（資料夾模式會自動產生 `.bak` 備份）。

簡報檔案全程留在你自己的電腦，不會上傳到 GitHub。網站只提供「編輯器工具」本身。

## 與伺服器版的差異

| 項目 | 伺服器版（start.bat） | 靜態版（本專案） |
|------|----------------------|-----------------|
| 啟動 | 雙擊 start.bat 起 Python | 開網址即用 |
| 檔案清單 | 自動列出資料夾內簡報 | 手動「選擇資料夾／檔案」 |
| 樣板庫 | 存在 `clickdeck_templates/` | 存在瀏覽器 localStorage |
| 瀏覽器 | 不限 | 僅 Chrome / Edge |

樣板庫改用瀏覽器 localStorage 保存，換瀏覽器或清除瀏覽資料會消失。內建 5 個預設樣板於首次開啟時自動載入。

## 部署到 GitHub Pages

1. 把這個資料夾的內容推到 GitHub 儲存庫（`index.html` 需在儲存庫根目錄）。
2. 儲存庫 Settings → Pages → Source 選 `Deploy from a branch`，分支選 `main`、資料夾選 `/ (root)`。
3. 等待幾分鐘，即可用 `https://<帳號>.github.io/<儲存庫名>/` 開啟。

## 檔案結構

```
index.html              編輯器主頁
css/editor.css          樣式
js/core.js              狀態、載入、儲存（File System Access API）
js/history.js           Undo / Redo
js/slides.js            投影片管理
js/editable.js          所見即所得文字／圖片／連結編輯
js/templates.js         樣板庫（localStorage）
js/starter-templates.js 內建 5 個預設樣板
js/style-editor.js      配色與字體抽屜
.nojekyll               關閉 GitHub Pages 的 Jekyll 處理
```
