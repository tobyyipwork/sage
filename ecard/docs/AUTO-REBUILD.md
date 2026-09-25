# 自動重建機制

> 建立日期：2026-09-25
>
> 目標：在雲端後台改完名片後，前台自動更新，**不需手動執行任何指令**。

---

## 一、為什麼需要這個

名片資料存在 **Cloudflare KV**，但前台是**預先建置好的靜態檔**（GitHub Pages）。
兩者之間原本沒有連接 —— 改了資料，前台不會自己變。

這個機制就是補上那條連接線：

```
   你存檔          KV 有新資料        偵測到變更        重建靜態檔        前台更新
   ────────  ────►  ──────────  ────►  ──────────  ────►  ──────────  ────►  ────────
   後台介面         Worker 寫入        GitHub Actions      node build.js     GitHub Pages
```

---

## 二、運作方式

### 觸發：GitHub Actions 定時輪詢（每 15 分鐘）

排程定義在 [`.github/workflows/auto-rebuild.yml`](../../.github/workflows/auto-rebuild.yml)：

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:      # 也可手動觸發
```

選這個方案的原因：**感應器在雲端，你的電腦完全不需要開著**。
失敗時有完整日誌可查，不會像本機常駐程式那樣靜默停擺而你不知道。

### 關鍵設計：先比對「資料指紋」，有變才重建

如果每 15 分鐘都無條件重建並提交，一個月會產生約 **2,880 次 commit** ——
不但污染版控歷史，每次也會觸發 GitHub Pages 重新部署。

所以流程是：

| 步驟 | 動作 | 沒變時 |
| --- | --- | --- |
| 1 | 算出現有 KV 資料的雜湊（指紋） | |
| 2 | 與 `.kv-fingerprint` 檔案比對 | **不同→繼續；相同→結束** |
| 3 | 從 KV 拉資料到 `data/` | 跳過 |
| 4 | 執行 `build.js` 產生 `dist/` | 跳過 |
| 5 | 提交並推送 | 跳過 |

**實際上，大多數排程執行會在第 2 步就結束**，耗時數秒、不產生任何 commit。

### 指紋怎麼算

由 [`cloud/scripts/kv-fingerprint.js`](../../cloud/scripts/kv-fingerprint.js) 負責：

- 涵蓋範圍：`config:{org}`、`index:{org}`、各 `staff:{org}:{slug}`
- **不含圖片** —— 前台直接引用 Worker 的 `/img/` 路徑，圖片不進建置產出
- 用穩定序列化（物件鍵排序）後取 SHA-256，避免鍵序不同造成「假變更」
- 結果存於 repo 根目錄的 `.kv-fingerprint`

### 三種結束碼（重要）

`--check` 用結束碼表達結果，**這三個必須分清楚**：

| 結束碼 | 意義 | workflow 的反應 |
| --- | --- | --- |
| `0` | 資料未變更 | 跳過重建 |
| `1` | 資料有變更 | 開始重建 |
| **`2`** | **環境／憑證問題** | **讓 workflow 失敗並提示檢查 Secrets** |

> ⚠️ `2` 這個區分是必要的。若把憑證設定錯誤誤判成「資料有變更」，
> 症狀會是「一直說有變更、一直重建，但前台內容根本沒動」，
> 非常難聯想到是 token 問題。所以憑證不全時直接擋下、明確報錯。

### 避免衝突

```yaml
concurrency:
  group: auto-rebuild
  cancel-in-progress: false
```

同一時間只跑一個。若上一輪還沒結束，新的排程直接跳過，
避免兩輪同時 push 造成 git 衝突。

---

## 三、安裝步驟（一次性）

### 步驟 1：取得 Cloudflare API Token

到 Cloudflare 儀表板 → **My Profile → API Tokens → Create Token**。

**最簡單的做法**：用 **「Edit Cloudflare Workers」** 範本，
它會自動包含所需的 Read 與 Write 權限。

若手動設定，必須包含：

| 權限 | 用途 | 容易漏掉？ |
| --- | --- | --- |
| **Workers KV Storage — Read** | 讀取名片資料 | ⚠️ **最常被漏** |
| Workers KV Storage — Edit | （保險起見一併給） | |

> ⚠️ **只給 Write 不給 Read 是最陰險的坑**：
> 部署會成功，但讀取資料時失敗，而且錯誤訊息不會明說是權限問題。
> 建議直接用範本，不要手動勾。

記下 **Account ID**：在儀表板右側欄，或執行 `npx wrangler whoami` 可看到。

### 步驟 2：設為 GitHub Secrets

到 repo → **Settings → Secrets and variables → Actions → New repository secret**，
新增兩個：

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 步驟 1 建立的 token |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare 帳號 ID |

> `GITHUB_TOKEN` 不需要手動設定 —— Actions 會自動提供，
> workflow 已用它來提交變更（見 `permissions: contents: write`）。

### 步驟 3：確認 Actions 已啟用

到 repo → **Actions** 分頁 → 應該會看到「自動重建名片前台」。
點進去 → **Run workflow** 可手動觸發一次測試。

勾選 `force` 會略過指紋比對強制重建，適合用來驗證整條鏈路。

### 步驟 4：驗證

手動觸發一次後，檢查：

1. Actions 執行結果為綠燈
2. 日誌中出現「資料有變動，開始重建」或「資料未變動，跳過本次重建」
3. `dist/` 有新的 commit（若資料確實有變）

---

## 四、日常使用

**你不需要做任何事。** 存檔後最慢 15 分鐘生效。

想確認狀態時：

```bash
# 查看目前的資料指紋
npm run fp

# 比對雲端資料與上次建置是否不同（有變回傳 exit 1）
npm run fp:check

# 本地跑一次完整流程（等於 Actions 做的事）
npm run sync
```

---

## 五、排程頻率與用量

| 頻率 | 每日執行 | 每月執行 | 說明 |
| --- | --- | --- | --- |
| 每 5 分鐘 | 288 | ~8,640 | 較即時，但用量高 |
| **每 15 分鐘** | **96** | **~2,880** | **目前設定** |
| 每 30 分鐘 | 48 | ~1,440 | 用量低 |
| 每小時 | 24 | ~720 | 最省 |

**費用**：本 repo 是 **public**，GitHub Actions 對公開 repo **完全免費、無分鐘數上限**。
（若是 private repo，免費額度為 2,000 分鐘/月，每 15 分鐘一次會超出。）

每次執行多數在數秒內結束（指紋相同），實際跑完整建置約 1 分鐘。

### 修改頻率

編輯 `.github/workflows/auto-rebuild.yml` 的 cron 即可：

```yaml
- cron: '*/30 * * * *'     # 改成每 30 分鐘
```

---

## 六、疑難排解

| 症狀 | 原因 | 解法 |
| --- | --- | --- |
| Actions 紅燈，訊息含 **403** | token 缺 KV Read | 重建 token，補上 Read 權限 |
| Actions 紅燈，訊息含 **401** | token 無效或過期 | 檢查 secret 是否正確、是否已過期 |
| 一直顯示「資料未變動」但明明改了 | `.kv-fingerprint` 沒更新 | 手動觸發時勾選 `force` |
| 建置成功但前台沒變 | GitHub Pages 尚未部署完 | 等 1–2 分鐘；檢查 Pages 是否正常 |
| `git push` 失敗 | 分支保護規則 | 確認 `main` 允許 Actions 推送 |
| 排程沒在準點執行 | GitHub 排程本就有數分鐘延遲 | 正常現象，非故障 |

### 手動救援

若自動流程卡住，本地這樣做即可：

```bash
npm run sync                                  # 拉資料 + 重建
git add -A ecard/dist ecard/data && git commit -m "手動重建"
git push
```

---

## 七、相關檔案

| 檔案 | 作用 |
| --- | --- |
| `.github/workflows/auto-rebuild.yml` | 排程與流程定義 |
| `cloud/scripts/kv-fingerprint.js` | 計算／比對資料指紋 |
| `cloud/scripts/kv-to-data.js` | 從 KV 拉資料（支援 REST API 與 wrangler 兩種模式） |
| `cloud/scripts/env-utils.mjs` | 共用：憑證檢查、尋找可用的 wrangler |
| `build/build.js` | 產生靜態檔 |
| `.kv-fingerprint` | 指紋儲存（自動維護，勿手動編輯） |

### 關於 wrangler 的尋找邏輯

本機執行時，`env-utils.mjs` 會依序嘗試：

1. `WRANGLER_BIN` 環境變數指定的路徑
2. `cloud/worker/node_modules/.bin/wrangler`（若已安裝）
3. **npx 快取中「已具備原生模組」的 wrangler**（優先於重新下載）
4. 最後才用 `npx wrangler@4` 現場下載

第 3 點的用意：npx 快取若缺 `@cloudflare/workerd-*` 原生模組，
執行時會噴出一大串 Node 堆疊訊息，難以判斷原因。
先探測哪一份是完整的，就能避開這個坑。

> 若遇到難以理解的 wrangler 錯誤，可先清快取重試：
> `npx --yes wrangler@4 --version`（重新下載一份完整的）。

---

## 八、後續可選加強

目前**未**實作，有需要再說：

1. **改為即時觸發** — Worker 存檔後直接呼叫 GitHub API，延遲降到數秒。
   代價是要把 GitHub 憑證存進 Worker，且逾時處理較複雜。
2. **失敗時寄信通知** — 目前失敗只在 Actions 頁面顯示紅燈。
3. **改用 Cloudflare Pages** — 見 [`PAGES-MIGRATION.md`](PAGES-MIGRATION.md)，
   可省去輪詢、即時生效，代價是每月 500 次建置上限。
