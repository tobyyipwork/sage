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
    # 每 15 分鐘，但刻意錯開整點（見下方說明）
    - cron: '4,19,34,49 * * * *'
  workflow_dispatch:      # 也可手動觸發
```

選這個方案的原因：**感應器在雲端，你的電腦完全不需要開著**。
失敗時有完整日誌可查，不會像本機常駐程式那樣靜默停擺而你不知道。

#### 為什麼不寫 `*/15 * * * *`

GitHub 官方文件明講：

> "The `schedule` event can be delayed during periods of high loads of GitHub
> Actions workflow runs. **High load times include the start of every hour.**
> If the load is sufficiently high enough, some queued jobs may be dropped."

`*/15` 會落在 `:00 / :15 / :30 / :45` —— 其中 `:00` 正好是官方點名的整點高負載時段，
排程可能延遲甚至被**直接丟棄**。因此偏移 4 分鐘，改為 `:04 / :19 / :34 / :49`。

> 註：GitHub 排程**無法回溯**。改動 cron 後不會補跑過去漏掉的時段，
> 只從推送時間點之後的下一個時點開始生效。改完請耐心等下一個觸發點。

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

## 五之二、排程保活（重要，否則 60 天後會靜默失效）

### 問題

GitHub 官方規定：

> "In a public repository, scheduled workflows are automatically disabled
> when no repository activity has occurred in 60 days."

**這個 repo 是公開的**，所以這條規則適用。而問題在於：

1. **名片是低頻變更的資料** —— 兩個月沒改名片非常正常。
2. 沒有 commit 就沒有「倉庫活動」。
3. 60 天後，GitHub **靜默停用**排程 —— **不會發任何通知**。
4. 等到某天你真的改了名片，會發現前台一直沒更新，
   卻完全不知道是排程早就被關掉了。

> 注意官方用詞是 "repository activity"，**不是** "workflow execution"。
> 也就是說「排程有在跑」本身不算活動；要有 push／commit／PR 之類的倉庫異動才算。
> 而資料沒變時，本機制刻意不產生 commit —— 這正好會累積成 60 天空窗。

### 解法：`.github/workflows/keepalive.yml`

一支獨立的保活 workflow，**每月 1 號自動更新一個時間戳檔案並提交**：

```
.github/workflows/keepalive.yml   →   每 1 號 03:17 UTC
  └─ 更新 ecard/.keepalive（寫入當下時間）
       └─ git commit + push       →   倉庫保持「有活動」→ 排程永不被停用
```

**它不碰任何名片資料**，只動 `ecard/.keepalive` 這一個檔案。

| 項目 | 設定 |
| --- | --- |
| 頻率 | 每月 1 次（`17 3 1 * *`） |
| 動到的檔案 | 只有 `ecard/.keepalive` |
| 影響名片 | 無 |
| 費用 | 公開 repo，免費 |

一個月一次已經綽綽有餘 —— 只要間隔遠小於 60 天即可。
選在 03:17 也是刻意避開整點高負載時段。

### 為什麼不用外部 cron 服務

另一條路是用 cron-job.org 之類的免費服務定期打 `workflow_dispatch` API，
完全繞過 GitHub 的 60 天規則。但代價是：

- 多一個外部依賴，多一個會壞的環節
- 要額外保管一組 GitHub PAT，並且定期輪替
- 設定散在兩個平台，日後維護要記兩件事

保活 workflow 的優點是**把問題消滅而不是管理它**，
而且所有設定都留在同一個 repo 裡。

### 如果哪天真的被停用了

不用慌，手動啟用即可：

```bash
gh workflow enable auto-rebuild.yml     # 或到 Actions 頁面點「Enable workflow」
```

啟用後排程會恢復，但**不會補跑**停用期間的時段 ——
若剛好有資料變更，手動觸發一次即可補上：

```bash
gh workflow run auto-rebuild.yml
```

### 怎麼確認保活有在運作

```bash
# 看保活 workflow 的執行紀錄
gh run list --workflow=keepalive.yml

# 看 .keepalive 最後更新時間
gh api repos/tobyyipwork/sage/contents/ecard/.keepalive \
  --jq '.content' | base64 -d | tail -2
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
| **排程完全沒動靜（run 數為 0）** | 可能是被 60 天規則停用 | `gh workflow enable auto-rebuild.yml` |
| **改了 cron 但一直沒觸發** | 排程註冊有延遲，且不回溯 | 見下方「排程註冊延遲」說明 |

### 排程註冊延遲（本專案實際踩過的坑）

**症狀**：workflow 檔案正確、`state: active`、檔案在 `main`、`workflow_dispatch` 手動執行正常，
但 `event=schedule` 的執行次數**始終為 0**，等了一兩個小時也沒動靜。

**原因**：GitHub 的排程註冊器不是即時生效的。實測與社群回報一致：

- 新增或**修改** cron 後，GitHub 需要 **15 分鐘到 1 小時以上**才會識別
- 識別後，**第一次執行只會發生在「識別完成後的下一個排程時點」**
- 在第一次成功執行之前，**Actions 頁面只會顯示 `workflow_dispatch`，完全看不到 schedule**
  —— 這會讓人誤以為排程沒設定成功

**一個容易誤判的線索**：用 API 看 workflow 的 `updated_at`：

```bash
gh api repos/tobyyipwork/sage/actions/workflows/auto-rebuild.yml \
  --jq '{state, created_at, updated_at}'
```

若 `updated_at` 停在「檔案首次建立」的時間、沒有跟著 cron 修改而變動，
代表排程器還停留在舊版本。**注意：這是觀察用的線索，不是可靠的判斷依據** ——
實測發現純 cron 修改不一定會更新這個時間戳，所以不能只看它下結論。

**解法**：對 default branch 做一次無害的 commit（俗稱 trivial commit），
可以催促 GitHub 重新評估並同步排程：

```bash
git commit --allow-empty -m "chore: 重新同步排程" && git push
```

或直接跑一次保活 workflow（它本來就會 commit）：

```bash
gh workflow run keepalive.yml
```

**驗證方式**：等跨越至少一個排程時點後，確認 schedule 執行出現：

```bash
gh api "repos/tobyyipwork/sage/actions/runs?per_page=100" \
  --jq '[.workflow_runs[] | select(.event=="schedule")] | length'
```

> ⚠️ 這個延遲是 GitHub 平台行為，**不是設定錯誤**。
> 若已等待超過數小時仍完全沒有 schedule 執行，才需要進一步排查
> （檢查是否被 60 天規則停用、或 repo 是否為 public）。

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
| `.github/workflows/keepalive.yml` | 每月保活，避免 60 天無活動被停用 |
| `cloud/scripts/kv-fingerprint.js` | 計算／比對資料指紋 |
| `cloud/scripts/kv-to-data.js` | 從 KV 拉資料（支援 REST API 與 wrangler 兩種模式） |
| `cloud/scripts/env-utils.mjs` | 共用：憑證檢查、尋找可用的 wrangler |
| `build/build.js` | 產生靜態檔 |
| `.kv-fingerprint` | 指紋儲存（自動維護，勿手動編輯） |
| `ecard/.keepalive` | 保活時間戳（自動維護，勿刪除） |

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