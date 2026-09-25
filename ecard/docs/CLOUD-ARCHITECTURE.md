# SAGE E-Card 雲端後台架構設計

> 版本 1.0 · 2026-09-24
> 狀態：**設計提案，待確認後才動工**

---

## 1. 需求回顧

| 項目 | 決定 |
| --- | --- |
| 使用人數 | 機構約 300 人（員工名片數量） |
| 後台使用者 | **現階段只有你（管理員）**；將來交部門主管維護 |
| 資料庫 | **不要**（接受 JSON 檔案 / KV 鍵值儲存） |
| 前台 | 靜態電子名片，公開可瀏覽 |
| 後台 | 雲端，可新增／修改／刪除名片 |
| QR Code | 名片網址轉 QR；**將來支援動態中轉**（換網域不影響已印卡片） |
| 網域 | 暫未定案，先用 `tobyyipwork.github.io/sage/ecard/dist/` 測試 |
| 多機構 | 將來可能供其他機構使用（方案 4） |

---

## 2. 核心設計原則

### 2.1 引擎與資料分離

沿用專案既有的哲學，並延伸到雲端：

```
引擎（程式碼，可共用）          資料（每個機構獨立）
├── build/   靜態站生成器       ├── 你的機構 → KV namespace
├── templates/ 版型             └── 其他機構 → 另一 namespace
└── admin/   後台 UI（同一套）
```

同一套 Worker 程式碼 + 同一套後台 UI，服務 N 個機構；差別只在**資料存放在哪個 namespace**，由 `org` 參數決定。

### 2.2 資料格式不變

雲端化的**最大優勢**：現有的 `data/staff/*.json` 結構完全不動。

```json
{
  "slug": "chan-tai-man",
  "name": { "zh": "陳大文", "cn": "陈大文", "en": "Chan Tai Man" },
  "title": { "zh": "示範用戶", "cn": "示范用户", "en": "Demo User" },
  "email": "taiman.chan@sage.org.hk",
  "phone_work": "2342 1234",
  "phone_mobile": "9123 4567",
  "social_links": [],
  "custom_links": [],
  "images": { "banner": "", "avatar": "", "wechat_qr": "" },
  "active": true
}
```

好處：本機後台與雲端後台**可以並存**，資料可互相匯入匯出，不會被鎖死在雲端。

### 2.3 零依賴延續

- 前端：純 vanilla JS（沿用現有 `admin/public/index.html`）
- 後端：Cloudflare Worker（單一 `.js` 檔，無需 npm 安裝，用 Wrangler 部署即可）

---

## 3. 整體架構圖

```
┌─────────────────────────────────────────────────────────────────┐
│                     公開前台（靜態）                              │
│                                                                  │
│   GitHub Pages / Cloudflare Pages                                │
│   ├── /chan-tai-man/            名片頁（含動態 QR）               │
│   ├── /chan-tai-man/cn/         簡體版                           │
│   ├── /chan-tai-man/en/         英文版                           │
│   └── /chan-tai-man.vcf         vCard                            │
│                                                                  │
│   訪客 → 只能讀，不能寫                                            │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ 自動 rebuild 後部署
                              │
┌─────────────────────────────────────────────────────────────────┐
│                  後台前台（靜態，放同一站台）                      │
│                                                                  │
│   /admin/     ← 沿用現有 admin/public/index.html                 │
│                 唯一改動：API_BASE 指向 Worker 網址               │
│                                                                  │
│   管理員 → 瀏覽器 → fetch(API_BASE + '/api/...')                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS + 登入憑證
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│           Cloudflare Worker（你的私有後端，約 200 行）             │
│                                                                  │
│   ┌───────────────────────────────────────────────────────┐     │
│   │ 1. 驗證層  Auth                                        │     │
│   │    共用密碼 / Email 驗證碼 / Cloudflare Access          │     │
│   └───────────────────────────────────────────────────────┘     │
│   ┌───────────────────────────────────────────────────────┐     │
│   │ 2. 路由層  Router                                      │     │
│   │    /api/config      GET / PUT                          │     │
│   │    /api/staff       GET / POST                         │     │
│   │    /api/staff/:slug GET / PUT / DELETE                 │     │
│   │    /api/staff/:slug/image  POST / DELETE               │     │
│   │    /api/build       POST   ← 觸發重新生成               │     │
│   └───────────────────────────────────────────────────────┘     │
│   ┌───────────────────────────────────────────────────────┐     │
│   │ 3. 儲存層  Storage                                     │     │
│   │    KV   → JSON 資料（staff/*.json, config.json）        │     │
│   │    R2   → 圖片（banner / avatar / wechat_qr）           │     │
│   └───────────────────────────────────────────────────────┘     │
│   ┌───────────────────────────────────────────────────────┐     │
│   │ 4. 觸發層  Rebuild                                     │     │
│   │    Pages Deploy Hook → 重 build + 部署                  │     │
│   └───────────────────────────────────────────────────────┘     │
│                                                                  │
│   【第五階段預留】                                                │
│   ┌───────────────────────────────────────────────────────┐     │
│   │ 5. 動態 QR 中轉  /r/:org/:slug                          │     │
│   │    301/302 → 目前的正式名片網址                          │     │
│   └───────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  Cloudflare KV / R2           │
              │  ─ 免費額度對 300 人 ≡ 用不到 1% │
              └───────────────────────────────┘
```

---

## 4. 技術選型與理由

| 層 | 選擇 | 為什麼不用其他方案 |
| --- | --- | --- |
| 運算 | **Cloudflare Workers** | 免費 10 萬次/日、CPU 30ms/請求；冷啟動 <5ms；與動態 QR 中轉共用一套。不用 Vercel/Netlify Functions 是因為想跟 QR 中轉統一，少一個供應商 |
| 資料 | **Cloudflare KV** | 就是 key-value 儲存，**不是資料庫**，符合你的要求。讀 10 萬/日、寫 1,000/日、1GB 儲存 —— 300 張名片約 5MB，綽綽有餘 |
| 圖片 | **Cloudflare R2** | 物件儲存，免費 10GB + **零出口流量費**（S3 每 GB 收 $0.09）。不用 KV 存圖片是因為 KV 儲存僅 1GB 且讀取計費不划算 |
| 前台部署 | **Cloudflare Pages**（§9 選項 Z） | 免費 500 次建置/月、無限頻寬。與 Workers/KV 同一平台，整條鏈路單一供應商 |
| Build 觸發 | **Cloudflare Pages Deploy Hook** | 一個 HTTP POST 就能觸發重建，不用自己管 build server |
| 前台資料流 | **Build 時從 KV 拉資料** | 保持「純靜態、極快、可 CDN」的優勢。*替代方案見 §9* |

### 成本估算（300 人規模）

以下免費額度已於 2026-09-24 核對 Cloudflare 官方文件與社群實測。

| 項目 | 免費額度 | 你的實際用量 | 佔比 |
| --- | --- | --- | --- |
| Workers 請求 | 100,000 / 日 | 約 50–200 / 日 | **< 0.2%** |
| Workers CPU | 30 ms / 請求 | 約 1–5 ms | **< 17%** |
| KV 讀取 | 100,000 / 日 | 約 50–300 / 日 | **< 0.3%** |
| **KV 寫入** | **1,000 / 日** | **約 5–30 / 日** | **< 3%** ⚠️ 最緊的配額 |
| KV 儲存 | 1 GB | 約 5 MB | **0.5%** |
| R2 儲存 | 10 GB | 約 0.5 GB | **5%** |
| R2 寫入（Class A） | 1,000,000 / 月 | 約 50 / 月 | **< 0.01%** |
| R2 讀取（Class B） | 10,000,000 / 月 | 約 3,000 / 月 | **< 0.03%** |
| R2 出口流量 | **免費（零 egress 費）** | — | **0%** |
| Pages 建置 | 500 次 / 月（並發 1） | 約 30–60 次 / 月 | **< 12%** |
| Pages 檔案數 | 20,000 / 站 | 2 人 × 3 語 ≈ 20 個 | **0.1%** |

> **結論：月費 $0。** 就算 300 人全部每天改一次名片，KV 寫入也只到 300 次/日（30%）。

#### ⚠️ 唯一需要留意的配額：KV 寫入 1,000 / 日

這是整份設計中最緊的資源。以你的規模**完全安全**，但要知道它的邊界：

| 情境 | 每日寫入次數 | 狀態 |
| --- | --- | --- |
| 你一人維護，一天改 20 張卡 | 20 | ✅ 安全 |
| 300 人全部一天改一次自己的名片 | 300 | ✅ 安全（30%） |
| 300 人一天改 3 次 | 900 | ⚠️ 接近上限（90%） |
| 加上 `index:sage` 名單快取的連帶寫入 | ×2 | ⚠️ 需注意 |

**對策**（寫進 Worker 設計）：
1. 每次修改**只寫 1 個 key**（`staff:sage:{slug}`），不要每次重寫整份名單
2. `index:sage` 名單快取改用**惰性更新**（僅在新增／刪除時才改，改內容時不動）
3. Worker 內加**寫入節流**：同一 slug 在 5 秒內的重複寫入合併為一次

這樣即使 300 人每天各改一次，實際寫入約 300–400 次/日，仍在安全範圍內。

---

## 5. 資料模型（KV 配置）

### 5.1 KV Namespace 規劃

```
Namespace: SAGE_ECARD_DATA
  ├── config:sage                      → 機構設定 JSON（= 現有 config.json）
  ├── staff:sage:chan-tai-man          → 名片 JSON
  ├── staff:sage:lee-siu-wah           → 名片 JSON
  ├── index:sage                       → ["chan-tai-man","lee-siu-wah"] 名單快取
  └── meta:sage                        → { count, updated_at, version }

Namespace: SAGE_ECARD_IMAGES （或改用 R2 bucket）
  ├── sage/chan-tai-man/avatar.png
  ├── sage/chan-tai-man/banner.jpg
  └── sage/chan-tai-man/wechat_qr.png
```

**Key 命名規則**：`{類型}:{機構}:{識別碼}`

這個設計讓「多機構」變成天然支援 —— 加一個機構只是多一組 `*:org2:*` 的 key，**程式碼完全不用改**。

### 5.2 為什麼要 `index:sage`？

KV 沒有「列出所有 key」的高效方法（`list()` 有 1,000 key 上限且較慢）。所以維護一份名單快取：

```
讀取流程： GET /api/staff
  → 讀 index:sage 取得 slug 陣列
  → 平行讀取各 staff:sage:{slug}
  → 回傳陣列
```

因為只有 300 筆，也可以在 `index:sage` 內直接內嵌精簡的名單（slug + 姓名 + 職稱），讓列表頁**一次讀取**就完成，不必再打 300 次 KV 讀取。

### 5.3 KV 寫入配額的三項設計對策

KV 免費版每日只有 **1,000 次寫入**，是整份設計最緊的資源。Worker 必須遵守：

| 對策 | 做法 | 效果 |
| --- | --- | --- |
| **只寫單一 key** | 改一張名片只寫 `staff:sage:{slug}`，不重寫整份名單 | 1 次寫入 vs 301 次 |
| **名單惰性更新** | `index:sage` 只在**新增/刪除**時才更新；修改既有名片內容時不動 | 修改操作從 2 次寫入降為 1 次 |
| **寫入節流** | 同一 slug 在 5 秒內的重複 PUT 合併，只寫最後一次 | 防止連點造成爆量 |

這三項落實後，300 人每天各改一次名片的實際寫入約 300–400 次/日，安全餘裕 2.5 倍。

---

## 6. API 規格

完全**沿用現有本地後台的 API 設計**，前台 UI 幾乎不用改。

| Method | Path | 說明 | 驗證 |
| --- | --- | --- | --- |
| `POST` | `/api/login` | 登入，回傳 token | 公開 |
| `GET` | `/api/config` | 讀機構設定 | ✔ |
| `PUT` | `/api/config` | 改機構設定 | ✔ |
| `GET` | `/api/staff` | 名片列表（精簡欄位） | ✔ |
| `POST` | `/api/staff` | 新增名片 | ✔ |
| `GET` | `/api/staff/:slug` | 讀單張名片（完整） | ✔ |
| `PUT` | `/api/staff/:slug` | 修改名片 | ✔ |
| `DELETE` | `/api/staff/:slug` | 刪除名片 | ✔ |
| `POST` | `/api/staff/:slug/image` | 上傳圖片 | ✔ |
| `DELETE` | `/api/staff/:slug/image/:key` | 刪除圖片 | ✔ |
| `POST` | `/api/build` | 觸發重新生成 + 部署 | ✔ |
| `GET` | `/api/build/:id` | 查 build 狀態 | ✔ |
| `GET` | `/r/:org/:slug` | **【預留】動態 QR 中轉** | 公開 |

### 與現有本地 API 的差異

只有 3 處：

1. **新增 `/api/login`** — 本地版不需要驗證，雲端版需要
2. **所有 `/api/*` 帶 `Authorization: Bearer <token>`**
3. **新增 `/r/:org/:slug`** — 動態 QR 中轉（第二階段啟用）

---

## 7. 驗證機制設計

### 現階段（只有你）— 方案 A：共用密碼

```
你輸入密碼 → Worker 比對環境變數 ADMIN_PASSWORD（用 SHA-256 雜湊比對）
           → 回傳一組簽章 token（HMAC，有效期 7 天）
           → 前端存 localStorage，每次請求帶上
```

- **優點**：實作最簡單（約 30 行）、零額外服務、夠安全（HTTPS + 雜湊）
- **缺點**：無法區分「誰」做的修改

### 將來（部門主管）— 方案 B：Email 驗證碼

```
輸入 email → Worker 檢查是否在授權名單（KV: users:sage）
          → 寄 6 位數驗證碼（用 Resend / MailChannels，免費額度夠）
          → 驗證通過 → 回傳 token，內含 { email, dept }
          → 寫入時檢查：此 dept 只能改自己部門的員工
```

- **優點**：無需密碼管理、可做部門權限、可稽核誰改了什麼
- **缺點**：需要一個寄信服務（免費額度對 300 人足夠）

### 進階（不想寫驗證時）— 方案 C：Cloudflare Access

Cloudflare 的 Zero Trust 服務，用 Google / Microsoft 帳號登入，Workers 前面掛一層。

- **優點**：不用寫任何驗證程式碼、支援 SSO、免費 50 人
- **缺點**：後台使用者必須有 Google/Microsoft 帳號；50 人上限（但你只要給主管用，足夠）

> **建議路徑**：現階段用 **方案 A**（30 分鐘完成），將來要給主管用時再升級到 **方案 B**。架構上兩者相容，只是換掉 Worker 裡的驗證函式。

---

## 8. 資料流：修改一張名片

以下為**建議方案（選項 Z）**的流程：

```
① 管理員在後台改「陳大文」的電話
                    ↓
② 前端 PUT /api/staff/chan-tai-man
   Header: Authorization: Bearer <token>
   Body:   { ...完整名片 JSON... }
                    ↓
③ Worker 驗證 token → 通過
                    ↓
④ Worker 寫入 KV: staff:sage:chan-tai-man        （1 次寫入）
                    ↓
⑤ Worker 觸發 Cloudflare Pages Deploy Hook
   （附 5 秒節流：連續修改合併為一次建置）
                    ↓
⑥ Pages 建置流程執行：
      node cloud/scripts/kv-to-data.js   ← 從 KV 拉全部資料寫入 data/
      node build/build.js                ← 沿用現有生成器，完全不改
      （產物即為部署內容）
                    ↓
⑦ Cloudflare Pages 部署完成（約 30–60 秒）
                    ↓
⑧ 線上官網名片已更新 ✓
```

**關鍵**：第 ⑥ 步完全沿用現有 `build/build.js`，只是資料來源從「本地 `data/`」變成「先從 KV 同步到 `data/`」。

如果選項 X（雙寫 Git）則第 ④–⑦ 改為：

```
④' Worker 同時寫 KV 與 commit 到 Git repo
⑤' GitHub Actions 被觸發 → node build/build.js → commit dist/
⑥' GitHub Pages 部署（約 30–60 秒）
```

---

## 9. 關鍵設計決策：Build 時如何取得資料？

這是整份設計中**最需要你拍板**的地方。有三條路：

### 選項 X：資料雙寫（KV + Git）

```
Worker 寫入時 → 同時寫 KV 和 commit 到 Git repo
              → Git 觸發 Actions build
```

| | |
| --- | --- |
| 優點 | 資料有 Git 版本歷史；build 流程完全不用改（現有 build.js 讀本地 `data/`） |
| 缺點 | 兩處寫入需保持一致；Git commit API 較慢（每次改一張卡約 2–3 秒） |

### 選項 Y：單一真相來源在 KV

```
Worker 寫入 → 只寫 KV
GitHub Actions build 時 → 用 API 從 KV 拉全部資料到 data/ → 再 build
```

| | |
| --- | --- |
| 優點 | 單一真相來源，不會不一致；寫入快 |
| 缺點 | build 需要一支「從 KV 同步下來」的腳本；Git repo 裡沒有資料（少了 diff 歷史） |

### 選項 Z：B 計畫 —— 不要 Git，改用 Cloudflare Pages

```
Worker 寫入 KV → 呼叫 Cloudflare Pages Deploy Hook → Pages 即時 build
```

| | |
| --- | --- |
| 優點 | **最單純**！不用處理「Worker 怎麼 commit 到 Git」；Pages 直接讀 KV；建置自動化 |
| 缺點 | 要離開 GitHub Pages，改用 Cloudflare Pages（其實是升級）；需在 Pages 設定建置指令 |
| 備註 | 這樣整條鏈路就只有 Cloudflare 一家供應商，維護最簡單；GitHub repo 仍保留作程式碼版控 |

> **我的建議是選項 Z**。理由：
> 1. 你已經要為了後端和動態 QR 用 Cloudflare，前台也放 Cloudflare 讓整條鏈路只有一家供應商
> 2. 不用處理「Worker 怎麼 commit 到 Git」這個麻煩事
> 3. Cloudflare Pages 免費額度：**500 次 build/月、並發 1 個、單站 20,000 檔案、無限頻寬**。你 2 張名片 × 3 語言 ≈ 20 個檔案，一個月改不到 60 次，完全夠
> 4. 網域統一在 Cloudflare 管理，將來 `ecard.sage.org.hk` 直接在 Cloudflare 設 DNS
> 5. 資料留在 KV，本機仍可用 `wrangler kv key get` 匯出成 JSON，不會被鎖死

但仍保留 GitHub repo 作為**程式碼版本控制**（不是資料儲存），這樣兩邊的好處都有。

> ⚠️ **Pages 建置次數是選項 Z 的主要限制**：500 次/月 ≈ 16 次/日。
> 若日後 300 人各自頻繁修改，需要靠 Worker 的**節流機制**（合併 5 秒內連續修改 → 一次建置）控制。
> 以現階段「只有你一人維護」而言，遠遠用不完。

---

## 10. 目錄結構（新增部分）

```
ecard/
├── build/                          # 不變
├── templates/                      # 不變
├── admin/
│   ├── server.js                   # 保留（本機開發用）
│   └── public/index.html           # 微調：API_BASE 可設定
│
├── cloud/                          # 【新增】雲端相關
│   ├── worker/
│   │   ├── src/index.js            # Worker 主程式（驗證+路由+儲存）
│   │   ├── src/auth.js             # 驗證邏輯（可換方案 A/B/C）
│   │   ├── src/storage.js          # KV / R2 存取封裝
│   │   ├── src/redirect.js         # 【預留】動態 QR 中轉
│   │   └── wrangler.toml           # 部署設定（含 KV/R2 binding）
│   │
│   ├── scripts/
│   │   └── kv-to-data.js           # build 前把 KV 資料同步到 data/
│   │
│   └── seed/
│       └── migrate-local.js        # 把現有 data/*.json 灌進 KV（一次性）
│
└── docs/
    └── CLOUD-ARCHITECTURE.md       # 本文件
```

---

## 11. 部署與遷移步驟

### 第一階段：雲端後台上線（目標：可以雲端改名片）

1. 申請 Cloudflare 帳號（免費）
2. 安裝 Wrangler CLI（`npm i -g wrangler`）
3. 建立 KV namespace（`wrangler kv namespace create`）與 R2 bucket
4. 部署 Worker 骨架（登入 + 讀取 API）
5. 跑 `migrate-local.js`：把現有 2 張名片 JSON 灌進 KV
6. 改 `admin/public/index.html`：`API_BASE` 指向 Worker，加登入畫面
7. 測試 CRUD 全流程（本機先跑 `wrangler dev`）

### 第二階段：自動部署生效

8. 建立 Cloudflare Pages 專案，連接 GitHub repo（只當程式碼來源）
9. 設定建置指令：`node cloud/scripts/kv-to-data.js && node build/build.js`
10. 設定輸出目錄：`dist`
11. 在 Worker 設定 Pages Deploy Hook URL
12. 後台按「重新生成」→ 線上官網更新

### 第三階段（將來）：動態 QR 中轉

13. 啟用 `redirect.js`：`/r/sage/:slug` → 讀 KV 取當前的正式網址 → 302
14. 改 `config.qr.mode` 為 `dynamic`、設定 `base`
15. 重新 build → 所有 QR 改編碼中轉網址 → **此後換網域不用重印卡片**

### 第四階段（將來）：部門主管權限

16. 升級驗證方案 A → B（Email 驗證碼 + 部門權限）
17. 在 KV 加 `users:sage` 授權名單

### 第五階段（將來）：多機構

18. 加 `org` 路由參數，KV key 已是 `{type}:{org}:{id}` 格式，**程式碼無需改動**
19. 新機構只需：建立其 config、匯入其名片、指向同一 Worker

---

## 12. 安全考量

| 風險 | 對策 |
| --- | --- |
| Token 外洩 | HMAC 簽章 + 有效期；只存 localStorage；不用永久 token |
| 暴力破解密碼 | Cloudflare 內建速率限制 + 登入失敗延遲 |
| 未授權寫入 | 所有寫入端點強制驗證；KV key 由 Worker 生成，不接受前端傳入任意 key |
| Slug 注入 | 沿用現有 `SLUG_RE` 驗證（`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`） |
| 路徑遍歷 | Worker 端不接觸檔案系統，天然免疫 |
| 圖片濫用 | 限制 MIME 類型與大小（沿用現有 12MB 上限） |
| XSS | 前台沿用現有 `escHtml()`；後台輸入一律當純文字 |
| 資料遺失 | KV 定期匯出成 JSON 備份；或開啟 R2 版本控制 |

---

## 13. 與現有系統的關係

| 現有元件 | 雲端化後 |
| --- | --- |
| `build/build.js` | **不變**，只是資料來源可能是同步下來的 JSON |
| `build/qr.js` | **不變** |
| `templates/` | **不變** |
| `data/*.json` | 成為「本機開發用資料」；雲端以 KV 為準 |
| `admin/server.js` | 保留作本機開發／離線使用 |
| `admin/public/index.html` | 微調（API_BASE + 登入畫面），其餘沿用 |
| QR Accordion 功能 | **不受影響** |

> 雲端化是**疊加**，不是替換。本機流程仍然可以完整跑，方便開發與緊急搶修。

---

## 14. 待你確認的問題

在動工之前，以下 5 點需要你決定（已回覆者標註）：

| # | 問題 | 選項 | 狀態 |
| --- | --- | --- | --- |
| 1 | **是否有 Cloudflare 帳號？** | 有 / 沒有（我帶你申請） | ⬜ 待確認（免費申請約 5 分鐘） |
| 2 | **前台要不要搬去 Cloudflare Pages？**（§9 選項 Z） | 搬 / 留在 GitHub Pages | ⬜ 待確認（**建議搬**，整條鏈路單一供應商） |
| 3 | **登入方式？** | 共用密碼 / Email 驗證碼 / Cloudflare Access | ⬜ 待確認（建議先「共用密碼」，將來升級） |
| 4 | **動態 QR 中轉要做嗎？** | 現在做 / 第二階段做 | ⬜ 待確認（骨架先預留，網域定案再啟用） |
| 5 | **資料雙寫還是單一真相？**（§9） | 選項 X / Y / Z | ⬜ 待確認（**建議選項 Z**） |

**已確認的前提**（來自你的回覆）：
- ✅ 後台使用者：現階段只有你；將來交部門主管
- ✅ 資料儲存：JSON 檔案 / KV 鍵值儲存（不要資料庫）
- ✅ 功能範圍：需要自動部署（選項 2 或 3）

### 建議的啟動順序

若你同意上述建議，最小可行的第一步是：

> **只做「第一階段」**：Cloudflare 帳號 + KV + Worker 骨架 + 後台接上 Worker。
> 前台**暫時留在 GitHub Pages**（不搬），先驗證雲端 CRUD 能跑通。
> 等確認可行、網域也定案後，再做第二階段（自動部署）與第三階段（動態 QR）。

這樣可以在**最低風險**下先看到成果，不必一次改動太多。

---

## 15. 風險與限制

- **Cloudflare 依賴**：整條鏈路集中在單一供應商。緩解：資料可隨時匯出成 JSON；程式碼在 Git。
- **KV 寫入配額（1,000/日）**：最緊的資源。對你目前規模安全（300 人全改也只有 300 次/日），但需在設計上落實「只寫單一 key + 名單惰性更新 + 寫入節流」三項對策。
- **Pages 建置次數（500/月）**：約 16 次/日。你一人維護時充裕；將來多人維護需靠節流合併建置。
- **KV 最終一致性**：KV 的寫入在全球邊緣節點約需 60 秒同步。對「一個人改名片」的場景**無影響**；若將來多人同時編輯同一張卡，需加鎖或改用 Durable Objects。
- **Workers CPU 30ms/請求**：足夠處理 JSON 讀寫與 token 驗證（約 1–5ms）。若未來要在此做圖像處理則不適合，應改由前端或 R2 處理。
- **免費額度變動**：Cloudflare 免費方案條款可能調整（KV 額度就曾在 2026-02 提升）。目前額度對 300 人而言有 30–100 倍以上餘裕。

---

## 附錄 A：技術棧總表

| 層 | 技術 | 版本 / 規模 |
| --- | --- | --- |
| 前台 | 靜態 HTML + CSS + 極少 JS | 沿用現有 |
| 後台 UI | Vanilla JS 單頁 | 沿用現有，微調 |
| 後端 | Cloudflare Workers | 1 個 Worker，約 200 行 |
| 資料 | Cloudflare KV | 1–2 個 namespace |
| 圖片 | Cloudflare R2 | 1 個 bucket |
| 部署 | Cloudflare Pages + Git | — |
| 開發工具 | Wrangler CLI | 需安裝（npm 或 standalone） |

## 附錄 B：為什麼不用其他方案

| 方案 | 為什麼不選 |
| --- | --- |
| Supabase / Firebase | 對 300 張名片而言過重；引入關聯式資料庫是殺雞用牛刀；免費方案有閒置暫停問題 |
| Vercel + Postgres | 同上，且多一個供應商 |
| Netlify Functions | 功能類似 Workers 但免費額度較小，且無法統一處理 QR 中轉 |
| 直接用 GitHub API | 無法支援將來的部門主管權限；Token 管理風險高；圖片處理麻煩 |
| 自架 VPS | 要維護伺服器、處理 HTTPS、備份 —— 對這個規模完全不值得 |
