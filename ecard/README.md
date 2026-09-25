# SAGE E-Card — 電子名片產生器

零依賴的靜態電子名片產生器。把 `data/staff/*.json` 轉成三語（繁／簡／英）電子名片網頁 + vCard 聯絡人檔，
並為每張名片自動產生可掃描的 **QR Code**。

名片資料存在 **Cloudflare KV**，透過**雲端後台**編輯；
編輯後由 **GitHub Actions 自動重建**並更新前台，不需手動執行任何指令。

---

## 運作方式

```
   你（或同事）                      Cloudflare                   GitHub
   ─────────────                    ────────────                 ────────
   開啟後台網址
   輸入密碼登入          ────►    Worker /api/*
                                  資料存入 KV
                                      │
                                      │ 每 15 分鐘檢查一次
                                      ▼
                                                          Actions 比對資料指紋
                                                            有變 → 重建 → 提交
                                                            沒變 → 直接結束
                                                                   │
                                                                   ▼
                                                           GitHub Pages 更新
                                                          （約 1 分鐘內生效）
```

**你唯一要做的事**：開後台、改名片、存檔。其餘全自動，最慢 15 分鐘後生效。

| 位置 | 網址 |
| --- | --- |
| 前台（名片網頁） | `https://tobyyipwork.github.io/sage/ecard/dist/` |
| 後台（管理介面） | `https://tobyyipwork.github.io/sage/ecard/dist/admin/?api=https://sage-ecard-api.tobyyip-work.workers.dev` |
| API（Worker） | `https://sage-ecard-api.tobyyip-work.workers.dev` |

> 後台網址很長，建議存成瀏覽器書籤，之後直接點開即可。
> `?api=` 後面的參數只需帶一次 —— 會存在瀏覽器裡，之後不用再輸入。

---

## 本地開發

只有在需要改**版型或程式**時才需要本地操作。日常編輯名片不需要。

```bash
# 從雲端 KV 拉最新資料，並產生網站到 dist/
npm run sync          # = kv-to-data.js + build.js

# 只產生網站（用本地現有資料）
npm run build

# 只想看資料有沒有變（不建置）
npm run fp:check
```

**需求**：Node.js ≥ 18。無任何 npm 依賴套件。

> 本地要讀雲端 KV，需先 `npx wrangler login`。
> 若設了 `CLOUDFLARE_API_TOKEN` 環境變數，則會改用 REST API。

📖 **完整說明**：
- **後台一鍵重建（推薦）** → [`docs/ADMIN-REBUILD.md`](docs/ADMIN-REBUILD.md)
- 自動重建機制 → [`docs/AUTO-REBUILD.md`](docs/AUTO-REBUILD.md)
- 雲端架構設計 → [`docs/CLOUD-ARCHITECTURE.md`](docs/CLOUD-ARCHITECTURE.md)
- 部署步驟 → [`docs/CLOUD-DEPLOY.md`](docs/CLOUD-DEPLOY.md)
- 搬到 Cloudflare Pages 的評估 → [`docs/PAGES-MIGRATION.md`](docs/PAGES-MIGRATION.md)

---

## 目錄結構

```
ecard/
├── data/                    ← 從 KV 同步下來的資料（勿手動編輯，會被覆蓋）
│   ├── config.json          ← 機構設定（名稱、地址、網域、QR 設定）
│   └── staff/
│       ├── chan-tai-man.json
│       └── lee-siu-wah.json
├── templates/
│   ├── card.html            ← 名片頁面骨架
│   └── style.css            ← 樣式（主題色、版面）
├── assets/
│   └── images/
│       ├── org/logo.png     ← 機構標誌
│       └── {slug}/          ← 各員工圖片（banner / avatar / wechat_qr）
├── build/
│   ├── build.js             ← 產生器主程式（同時輸出後台介面）
│   └── qr.js                ← 零依賴 QR Code 編碼器（輸出 SVG）
├── admin/
│   └── public/index.html    ← 後台管理介面（建置時複製到 dist/admin/）
├── cloud/                   ← 雲端後台（Cloudflare Workers）
│   ├── worker/src/          ← Worker 程式（驗證／路由／儲存／QR 中轉）
│   ├── worker/test-*.mjs    ← 測試（API 75 項 + KV 圖片 32 項 + 介面 15 項）
│   ├── scripts/             ← 密碼雜湊、環境檢查、KV 同步、指紋比對
│   ├── seed/                ← 資料遷移腳本（自動判斷 R2 或 KV）
│   └── worker/wrangler.toml ← 部署設定（R2 為選填，預設註解）
├── docs/                    ← 架構、部署、自動重建文件
├── dist/                    ← 產出（部署這個目錄）
└── .kv-fingerprint          ← 資料指紋（由 Actions 自動更新）
```

> **`.kv-fingerprint`**：記錄上次建置時的資料內容雜湊。
> Actions 靠它判斷「資料是否真的變了」，避免每 15 分鐘產生無意義的 commit。
> 這個檔案由自動化維護，**不要手動編輯**。

---

## 雲端後台快速上手

> ✅ **已部署完成**：Worker `https://sage-ecard-api.tobyyip-work.workers.dev`
> ，圖片走 KV 模式（未使用 R2、不需綁卡）。
>
> 以下步驟僅供重新部署或搬到新帳號時參考。

```bash
# 1. 登入 Cloudflare（wrangler 用 npx 即可，不需事先安裝）
cd cloud/worker && npx wrangler login

# 2. 建立 KV（R2 選填，不需綁卡也能跑）
npx wrangler kv namespace create SAGE_ECARD_DATA   # 把回傳的 id 填進 wrangler.toml

# 3. 設定管理密碼
node ../scripts/make-password.js --random      # 抄下密碼與雜湊
npx wrangler secret put ADMIN_PASSWORD_HASH    # 貼上雜湊
npx wrangler secret put TOKEN_SECRET           # 隨機字串

# 4. 部署
npx wrangler deploy

# 5. 把本機資料搬上去（會自動判斷圖存 R2 或 KV）
node ../seed/migrate-local.js
```

或者用互動式嚮導一次做完（推薦）：

```bash
npm run cloud:deploy     # 檢查 → 設 secrets → 部署 → 遷移 → 驗證
npm run cloud:setup      # 只看狀態，不做變更
```

不需要 Cloudflare 帳號、也不需要綁卡就能先驗證程式邏輯：

```bash
npm run cloud:test         # 75 項 API 檢查 + 32 項 KV 圖片模式檢查
node cloud/worker/test-browser.mjs   # 15 項介面端對端檢查（真實瀏覽器）
```

> **圖片儲存有兩種模式，自動切換**：綁了 R2 就存 R2，沒綁就存 KV。
> R2 開通時 Cloudflare 會要求綁信用卡，**不想綁卡就整段略過** ——
> 本專案在純 KV 模式下功能完全一樣。

---

## 機構設定（data/config.json）

```jsonc
{
  "org_code": "sage",                    // 機構代號（用於動態 QR 網址分段）
  "org": { "zh": "…", "cn": "…", "en": "…" },
  "org_site": "https://www.sage.org.hk",
  "about": { "zh": "…", "cn": "…", "en": "…" },
  "address": { "zh": "…", "cn": "…", "en": "…" },
  "site": {
    "url": "https://tobyyipwork.github.io",   // 網站網域（不含路徑）
    "basePath": "/sage/ecard/dist",           // 子路徑；根目錄部署時填 ""
    "copyright": "…",
    "version": "1.2.0"
  },
  "qr": {
    "enabled": true,
    "mode": "static",                  // "static"（預設）或 "dynamic"
    "base": "",                        // dynamic 模式時填中轉服務網域
    "path": "/r/{org}/{slug}",
    "accordion": 1,                    // 0 預設展開 | 1 預設收起（預設）| 2 完全不顯示
    "label": { "zh": "掃碼開啟名片", "cn": "…", "en": "…" }
  },
  "langs": ["zh", "cn", "en"],
  "default_lang": "zh"
}
```

> ⚠️ **網域一致性**：`site.url` + `site.basePath` 必須與實際部署位置一致，
> 否則產生的網址、canonical、vCard、QR 全部會指向錯誤位置。
> 使用自訂網域根目錄時，設 `site.url` = 網域、`basePath` = `""`。

---

## 新增 / 編輯員工

### 方法一：雲端後台（推薦，非技術人員）

開啟後台網址 → 輸入密碼 → 新增／編輯名片。
存檔後資料即存入 Cloudflare KV，**約 15 分鐘內前台自動更新**。

後台可：新增名片、編輯三語資料、上傳頭像／橫幅／微信 QR、刪除名片。

### 方法二：直接編輯 JSON（僅限開發）

改 `data/staff/{slug}.json`，執行 `npm run build` 後提交。
⚠️ 注意：`npm run sync` 會用雲端 KV 資料**覆蓋**本地 `data/`，
手動改的內容若未先推上 KV 會遺失。

```json
{
  "id": "st_003",
  "slug": "chan-tai-man",
  "active": true,
  "name": { "zh": "陳大文", "cn": "陈大文", "en": "Chan Tai Man" },
  "n": { "family": "Chan", "given": "Tai Man" },
  "title": { "zh": "職銜", "cn": "职衔", "en": "Job Title" },
  "email": "user@sage.org.hk",
  "phone_work": "2511 2235",
  "phone_mobile": "9123 4567",
  "images": { "banner": "", "avatar": "", "wechat_qr": "" },
  "social_links": [
    { "platform": "Facebook", "url": "https://…", "icon": "facebook", "color": "#1877f2" }
  ],
  "custom_links": [
    { "title": { "zh": "官網", "cn": "官网", "en": "Site" }, "url": "https://…", "icon": "globe", "color": "#9b4c8b" }
  ],
  "created_at": "2026-09-24T00:00:00+08:00",
  "updated_at": "2026-09-24T00:00:00+08:00"
}
```

- `slug`：只能小寫英數與連字號（會成為網址的一部分）
- `active: false`：暫時隱藏該名片
- `images.*`：填 truthy 值即代表啟用該圖；實際圖檔放 `assets/images/{slug}/`
  - `banner`（橫幅）、`avatar`（頭像）、`wechat_qr`（微信 QR）
- `icon` 可用值：`globe` `envelope` `phone` `mobile` `building` `map-pin` `user`
  `facebook` `instagram` `linkedin` `youtube` `whatsapp` `weixin`

---

## QR Code

每張名片頁面底部會自動產生一組 **QR Code**（內嵌 SVG，向量、可縮放、可列印）。

- **static 模式**（預設）：QR 直接編碼該名片的公開網址。
- **dynamic 模式**：QR 編碼一組中轉網址（如 `https://qr.example.com/r/sage/chan-tai-man`），
  日後改網域時只需更新中轉層設定，**已印出的 QR 仍然有效**。

### 顯示方式（Accordion）

QR 區塊以原生 `<details>` 手風琴呈現（**零 JavaScript**），預設收起，
點標題列展開；展開時箭頭旋轉、內容淡入。

三種模式由 `config.qr.accordion` 控制：

| 值 | 行為 |
| --- | --- |
| `0` | 預設展開 |
| `1` | 預設收起（預設值） |
| `2` | 完全不顯示（連區塊都不輸出） |

個別員工可用資料檔中的 `qr_accordion` 欄位覆寫機構預設，例如：

```json
{ "slug": "chan-tai-man", "qr_accordion": 0 }
```

`build/qr.js` 是零依賴的 QR 編碼器（byte 模式、版本 1–10、糾錯等級 L），
輸出 SVG 字串，不引入任何 npm 套件。已通過與成熟 `qrcode` 函式庫逐格比對及 OpenCV 解碼驗證。

---

## 部署

### GitHub Pages（子路徑）

```bash
npm run build
git add dist && git commit -m "Update cards" && git push
```

`site.url` = `https://<user>.github.io`，`basePath` = `/<repo>/ecard/dist`。

### 自訂網域（根目錄）

1. 在 `dist/` 放入 `CNAME` 檔（內容為網域，例如 `ecard.sage.org.hk`）
2. 設 `site.url` = `https://ecard.sage.org.hk`、`basePath` = `""`
3. `npm run build` 後部署

---

## 給其他機構使用（多租戶）

本專案設計為「**引擎與資料分離**」，適合複製給其他機構：

1. **Fork 此 repo** 作為新機構的副本
2. 改 `data/config.json`：`org_code`、機構名稱、地址、`site.url`、`basePath`
3. 清空 `data/staff/` 並放入該機構的員工資料
4. 部署到自己的網域

若搭配 **Git-based CMS**（如 Sveltia CMS）掛在 repo 上，機構即可在網頁上編輯名片，
改動會 commit 回自己的 repo——無需資料庫。

---

## 授權與注意

- 此為機構內部工具。後台受共用密碼保護，**請勿將密碼公開或寫入 repo**。
- 後台介面本身是靜態檔案（`admin/public/index.html`），可公開存取；
  真正的資料保護在 Worker 的驗證層 —— 沒有密碼拿不到任何資料。
- 員工個人資料請依相關私隱法規處理。

---

_版本 1.1.0 · 香港耆康老人福利會_
