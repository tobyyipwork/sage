# SAGE E-Card 雲端後台 — 部署指南

> 給第一次接觸 Cloudflare 的人。照著做，大約 30–45 分鐘完成第一階段。
>
> 架構說明見 [CLOUD-ARCHITECTURE.md](./CLOUD-ARCHITECTURE.md)。

---

## ⚡ 快速路徑：用部署嚮導

如果你已經有 Cloudflare 帳號並登入過，可以直接用內建的部署嚮導，
它會依序檢查環境 → 設定 secrets → 部署 → 遷移資料 → 驗證線上 API：

```bash
cd cloud/worker && npx wrangler login   # 只需做一次
cd ../..                                 # 回到 ecard/
npm run cloud:deploy                     # 互動式，每步都會問你
```

只想看目前狀態、不做任何變更：

```bash
npm run cloud:setup                      # 等同 --check
```

登入前卡住可以先跑：

```bash
npm run cloud:login                      # 檢查憑證／proxy／port
```

> 嚮導遇到不確定的地方會停下來問你，不會擅自做破壞性操作。
> 想手動一步步來，就繼續讀下面的完整步驟。

---

## ✅ 本專案目前的部署狀態

| 項目 | 狀態 |
| --- | --- |
| Worker 網址 | `https://sage-ecard-api.tobyyip-work.workers.dev` |
| 圖片模式 | **KV**（未使用 R2，不需綁卡） |
| KV namespace | `78100d9be89b4bccbde4b3cbbdd7a777` |
| Secrets | `ADMIN_PASSWORD_HASH`、`TOKEN_SECRET` 已設定 |
| 後台網址 | `https://tobyyipwork.github.io/sage/ecard/admin/public/?api=https://sage-ecard-api.tobyyip-work.workers.dev` |

已驗證可用的功能：登入、讀寫名片、讀寫機構設定、上傳／讀取／刪除圖片、QR 中轉。

---

## 你會得到什麼

完成後，你可以：

- 在任何電腦、任何地方，用瀏覽器打開後台網址
- 輸入一組密碼登入
- 新增／修改／刪除名片、上傳圖片
- 資料存在雲端，不會因為換電腦或重裝而消失

**費用：$0**（在免費額度內，你的用量約佔 0.2%–5%）

---

## 前置需求

| 項目 | 說明 |
| --- | --- |
| Node.js | 已安裝（你已經有了） |
| Cloudflare 帳號 | 免費，見步驟 1 |
| Wrangler CLI | 隨專案提供，用 `npx` 即可 |

---

## 兩種認證方式（先讀這段）

Wrangler 需要知道「你是誰」才能操作你的 Cloudflare 帳號。有兩種方式：

### 方式一：瀏覽器登入（推薦）

```bash
cd cloud/worker && npx wrangler login
```

會開啟瀏覽器請你點授權，憑證存在本機。**權限自動完整**，不用操心要開哪些權限。
有效期較長，過期就再登入一次。

### 方式二：API Token

適合無法開瀏覽器授權的環境（CI、遠端伺服器）。

1. 到 <https://dash.cloudflare.com/profile/api-tokens> 點「Create Token」
2. 選擇 **Edit Cloudflare Workers** 範本，或自訂權限
3. 建立後**複製 token 值** —— 只會顯示一次
4. 設成環境變數：

```powershell
# Windows PowerShell
$env:CLOUDFLARE_API_TOKEN = "你的token"
```

```bash
# Git Bash / macOS / Linux
export CLOUDFLARE_API_TOKEN="你的token"
```

> ⚠️ **權限一定要包含以下三項**，缺一項就會在某個環節失敗：
>
> | 權限 | 用途 |
> | --- | --- |
> | Workers Scripts Write | 部署 Worker |
> | Workers KV Storage **Write** | 寫入名片資料 |
> | Workers KV Storage **Read** | 讀取、列表、備份回本機 |
>
> 常見的坑：只勾了 Write 忘了 Read。這樣部署會成功，但 `kv-to-data.js`
> 和 `wrangler kv key list` 會失敗 —— 而且錯誤訊息不會直接告訴你是權限問題。
>
> **用「Edit Cloudflare Workers」範本建立就不會漏掉。**
>
> 💡 設定好之後可以用 `npm run cloud:token` 先驗證權限是否齊全。

---

## 步驟 1：申請 Cloudflare 帳號

1. 前往 <https://dash.cloudflare.com/sign-up>
2. 輸入 email 和密碼，完成驗證
3. 登入後會看到 Dashboard —— **不需要**買網域、不需要加信用卡

> 💡 Cloudflare 免費方案已包含我們需要的全部功能。

---

## 步驟 2：安裝 Wrangler

專案已把 wrangler 列為開發依賴，用 `npx` 就能執行，不需全域安裝：

```bash
cd cloud/worker
npx wrangler --version
```

如果你想全域安裝（方便在其他目錄使用）：

```bash
npm install -g wrangler
```

然後登入（會開瀏覽器請你授權）：

```bash
wrangler login
```

成功的話會顯示 `Successfully logged in`。

---

## 步驟 3：建立 KV（R2 可略過）### 3.1 建立 KV namespace（存 JSON 資料 + 圖片）

```bash
cd cloud/worker
wrangler kv namespace create SAGE_ECARD_DATA
```

輸出會像這樣：

```
[[kv_namespaces]]
binding = "DATA"
id = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
```

**把那個 `id` 複製起來**，貼到 `cloud/worker/wrangler.toml` 裡取代 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。

> ✅ **已完成**：KV namespace id 已填入 `78100d9be89b4bccbde4b3cbbdd7a777`。
>
> ⚠️ 注意：Cloudflare 儀表板給的範例用 `binding = "KV_BINDING"`，那是**範例名稱**。
> 本專案的程式碼讀取 `env.DATA`，所以 `wrangler.toml` 的 binding 必須維持 `DATA`，
> 只替換 `id` 即可。若把 binding 改成 `KV_BINDING`，Worker 會找不到資料。

### 3.2 R2 bucket（**選填，可完全略過**）

R2 開通時 Cloudflare 會要求綁定信用卡，即使免費額度內也一樣。
**如果你不想綁卡，這一節整段跳過即可** — 本專案會自動改用 KV 存圖片。

本專案支援兩種圖片儲存模式，由「有沒有 R2 綁定」自動判斷：

| | KV 模式（預設） | R2 模式 |
|---|---|---|
| 需要綁卡 | 否 | 是 |
| 額外設定 | 無 | `wrangler r2 bucket create` |
| 圖片存放 | 同一組 KV，key 為 `img:{org}:{slug}:{key}.{ext}` | R2 物件 |
| 單張上限 | 25MB（本專案限制 5MB） | 5TB |
| 儲存成本 | 計入 KV 免費 1GB | 免費 10GB |
| 讀取 | 計入 KV 免費 100,000 次/日 | 不計入、走 CDN |
| 寫入 | **計入 KV 免費 1000 次/日** | 不佔 KV 配額 |
| 前台網址 | 完全相同 | 完全相同 |

> **KV 模式的配額會不會不夠？**
> 300 人 × 3 張圖 = 900 次寫入，首次建檔約用掉一天的 KV 寫入配額。
> 之後**只有換圖才會寫入**，日常編輯姓名職稱完全不碰圖片 → 日常用量約 60%。
> 讀取方面最壞情況 3000 次/日，對比 100,000 次上限，餘裕 33 倍。
> **結論：本專案規模下，KV 模式完全夠用。**

若日後想改用 R2（例如要放大量高解析度圖片），做法是：

```bash
wrangler r2 bucket create sage-ecard-images
```

然後把 `wrangler.toml` 裡 `[[r2_buckets]]` 那三行註解取消，再 `wrangler deploy`。

> ⚠️ **切換模式後，已存在 KV 的圖片不會自動搬到 R2**，需要重新上傳該張圖片。
> 若已有資料，切換前請先用遷移腳本重新匯入圖片。

---

## 步驟 4：設定管理密碼

### 4.1 產生密碼雜湊

```bash
node cloud/scripts/make-password.js --random
```

會輸出像這樣：

```
  隨機產生的密碼（請妥善保存，這個只顯示一次）：

     aB3x-K9m-Pq7w-Zt2f

  雜湊（貼到 wrangler secret put ADMIN_PASSWORD_HASH）：

     3f8a2c1d9e...
```

**⚠️ 先把那組密碼抄下來**（存到密碼管理器），它只會顯示這一次。

### 4.2 設定三個機密

```bash
cd cloud/worker
wrangler secret put ADMIN_PASSWORD_HASH
```
→ 貼上**雜湊值**（不是密碼本身），按 Enter。

```bash
wrangler secret put TOKEN_SECRET
```
→ 隨便輸入一串長一點的隨機字串（例如再跑一次 `--random` 拿到的密碼）。這用來簽發登入通行證。

> 第三個機密 `PAGES_DEPLOY_HOOK` 等第二階段再設，現在可以先跳過。

---

## 步驟 5：部署 Worker

```bash
cd cloud/worker
wrangler deploy
```

成功後會顯示你的 Worker 網址，例如：

```
https://sage-ecard-api.你的帳號.workers.dev
```

**把這個網址記下來。**

測試一下是否活著：

```bash
curl https://sage-ecard-api.你的帳號.workers.dev/api/health
```

應該回傳 `{"ok":true,"org":"sage",...}`。

---

## 步驟 6：遷移現有資料

把你現有的 2 張名片從本機搬上雲端：

```bash
node cloud/seed/migrate-local.js
```

它會依序上傳 `config`、每張名片、名單快取。

> 想先看看會做什麼而不實際寫入：加上 `--dry-run`

驗證資料確實上去了：

```bash
cd cloud/worker
wrangler kv key get config:sage --binding DATA --text
```

應該看到你的 `config.json` 內容。

---

## 步驟 7：打開雲端後台

在瀏覽器打開：

```
https://tobyyipwork.github.io/sage/ecard/admin/public/?api=https://sage-ecard-api.你的帳號.workers.dev
```

（把 `?api=` 後面換成你的 Worker 網址）

第一次會看到**登入畫面**，輸入步驟 4.1 抄下的密碼。

登入後：

- 應該看到現有的 2 張名片
- 試著改一張名片的職稱 → 儲存
- **重新整理頁面** → 確認修改還在（代表真的寫進雲端了）

> 💡 網址加上 `?api=...` 之後會記在瀏覽器裡，之後直接開
> `https://tobyyipwork.github.io/sage/ecard/admin/` 就行了。
>
> 如果你把這個後台網址加到書籤，記得第一次要先帶 `?api=` 參數。

---

## 第一階段完成 ✅

到這裡，你已經有一個**可以用的雲端後台**。

| 已具備 | 尚未做 |
| --- | --- |
| 雲端登入 | 自動重新部署（步驟 8） |
| 雲端 CRUD | 動態 QR 中轉（第三階段） |
| 圖片上傳到 R2 | 部門主管權限（第四階段） |
| 資料存 KV | |

**注意**：現在改了資料之後，前台名片網站不會自動更新 —— 需要手動重建（見下方）。這是第一階段的預期行為。

手動重建很簡單：

```bash
cd /c/GitHub/sage
node cloud/scripts/kv-to-data.js    # 從雲端拉資料下來
node ecard/build/build.js            # 重新生成網站
# 然後把 dist/ 推上 GitHub Pages
```

---

## 步驟 8（第二階段）：自動重新部署

做完這步，後台按「重新生成網站」就會自動更新線上前台。

### 8.1 建立 Cloudflare Pages 專案

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 選擇你的 `sage` repo
3. 建置設定：
   - **Build command**：`node cloud/scripts/kv-to-data.js && node ecard/build/build.js`
   - **Build output directory**：`ecard/dist`
   - **Root directory**：（留空）
4. 在 **Settings → Environment variables** 加入：
   - `ORG_CODE` = `sage`
   - `CLOUDFLARE_API_TOKEN`（讓建置環境能讀 KV）
   - `CLOUDFLARE_ACCOUNT_ID`
5. 儲存並部署

### 8.2 取得 Deploy Hook

Pages 專案 → **Settings** → **Builds & deployments** → **Deploy hooks** → **Add**
命名為 `ecard-rebuild`，複製產生的 URL。

### 8.3 設定到 Worker

```bash
cd cloud/worker
wrangler secret put PAGES_DEPLOY_HOOK
```
→ 貼上 Deploy Hook URL。

重新部署 Worker 讓機密生效：

```bash
wrangler deploy
```

現在回後台按「重新生成網站」，就會自動觸發 Pages 重建了。

---

## 步驟 9（第三階段）：啟用動態 QR 中轉

前置：需要一個網域（或先用 Worker 的 `workers.dev` 網址）。

1. 改 `data/config.json`：

```json
"qr": {
  "enabled": true,
  "mode": "dynamic",
  "base": "https://sage-ecard-api.你的帳號.workers.dev",
  "path": "/r/{org}/{slug}",
  "accordion": 1
}
```

2. 把改好的 config 上傳到 KV：

```bash
node cloud/seed/migrate-local.js    # 會把新 config 蓋上去
```

3. 重新建置前台：

```bash
cd /c/GitHub/sage
node ecard/build/build.js
```

4. 重新生成的 QR 就會編碼中轉網址。測試：

```bash
curl -I https://sage-ecard-api.你的帳號.workers.dev/r/sage/chan-tai-man
```

應該回 `302` 並在 `Location` 指向名片頁。

**從此以後，換網域只要改 config 的 `site.url`，已印出的卡片永遠有效。**

---

## 日常維護

| 情境 | 做法 |
| --- | --- |
| 改名單資料 | 直接用雲端後台，不用碰程式 |
| 改版型／加功能 | 改本機程式碼 → `git push` → Pages 自動重建 |
| 備份資料 | `node cloud/scripts/backup.js`（見下） |
| 換管理密碼 | 重跑 `make-password.js` → 更新 secret → `wrangler deploy` |
| 查看 Worker 日誌 | `cd cloud/worker && wrangler tail` |
| 本機開發測試 | `cd cloud/worker && wrangler dev` |

### 備份資料

雲端資料存在 KV，建議定期匯出。最簡單的方式：

```bash
cd cloud/worker
wrangler kv key get config:sage --binding DATA --text > backup-config.json
wrangler kv key list --binding DATA --prefix "staff:sage:" 
```

或直接用 `kv-to-data.js` 把資料拉回本機 `data/` 目錄（這本身就是一份備份）：

```bash
node cloud/scripts/kv-to-data.js
git add ecard/data && git commit -m "備份雲端名片資料"
```

---

## 疑難排解

| 症狀 | 原因與解法 |
| --- | --- |
| 後台一直顯示登入畫面 | 確認網址有帶 `?api=https://你的worker網址` |
| 「密碼錯誤」 | 確認 secret 貼的是**雜湊**不是密碼；確認沒有多餘空白 |
| 「ADMIN_PASSWORD_HASH 未設定」 | 忘了跑 `wrangler secret put`，或設完沒重新 `wrangler deploy` |
| 資料改了但前台沒變 | 第一階段是預期行為；做完步驟 8 才會自動 |
| `429 Too Many Requests` | 碰到免費額度；檢查用量（正常不會發生） |
| 圖片上傳失敗 | ① 未綁 R2 時走 KV 模式，不該失敗 → 檢查 KV binding 是否為 `DATA`；② 有綁 R2 時檢查 `bucket_name` 正確 |
| 圖片上傳回 401/500 | 檢查 `MAX_IMAGE_BYTES`（預設 5MB）— 圖片過大會回 400 並說明 |
| Worker 部署失敗 | 確認 `wrangler.toml` 的 KV `id` 已填（不能留 `REPLACE_...`） |
| 想看錯誤詳情 | `wrangler tail` 即時顯示 Worker 日誌 |
| 想確認目前圖片模式 | `curl https://<你的-worker>/api/health` → 看 `image_mode` 欄位（`kv` 或 `r2`） |
| 用 token 但說未登入 | 確認 `CLOUDFLARE_API_TOKEN` 已設在**同一個終端機**；用 `npm run cloud:token` 診斷 |
| Token 有效但部署失敗 | 用「Edit Cloudflare Workers」範本重建 token，確保 Write/Read 都齊 |
| `kv key list` 失敗但部署成功 | 典型症狀：token 只有 KV **Write** 沒有 **Read** |
| 想改用登入方式 | `cd cloud/worker && npx wrangler login` — 權限自動完整，最省事 |
| **遷移說成功但後台沒資料** | **少了 `--remote`**！wrangler 4 的 `kv key put/get` 不指定時預設操作**本機模擬 KV**，指令會正常結束但寫錯地方。檢查 `wrangler kv key list --binding DATA --remote` 是否為空 |

---

## 附錄：本機測試

不需要 Cloudflare 帳號、不需要綁卡就能驗證程式邏輯：

```bash
cd cloud/worker

# API 邏輯測試（mock KV + R2，60 項檢查）
node test-local.mjs

# KV 圖片模式測試（完全不提供 R2，32 項檢查）
node test-kv-images.mjs

# 後台介面端到端測試（真實瀏覽器，15 項檢查）
node test-browser.mjs
```

或從專案根目錄：

```bash
npm run cloud:preflight    # 檢查是否具備部署條件
npm run cloud:test
```

---

## 附錄：所有指令速查

```bash
# ── 平時開發 ──
node ecard/build/build.js                 # 本機重建前台
npm run admin                             # 本機後台（localhost:4173）

# ── 部署輔助（推薦用這些）──
npm run cloud:setup                       # 檢查部署條件（只讀，不變更）
npm run cloud:deploy                      # 互動式部署嚮導
npm run cloud:login                       # 登入前環境檢查
npm run cloud:preflight                   # 環境檢查
npm run cloud:token                       # 驗證 API Token 權限（用 token 時）

# ── 雲端後台 ──
cd cloud/worker
npx wrangler login                        # 登入（一次性）
npx wrangler dev                          # 本機跑 Worker
npx wrangler deploy                       # 部署 Worker
npx wrangler tail                         # 看即時日誌

# ── 資料（注意 --remote，否則會操作到本機模擬 KV）──
node cloud/scripts/make-password.js --random   # 產生密碼與雜湊
node cloud/seed/migrate-local.js               # 本機 → 雲端
node cloud/scripts/kv-to-data.js               # 雲端 → 本機
node cloud/scripts/kv-to-data.js --with-images # 連圖片一起還原
npx wrangler kv key list --binding DATA --remote   # 列出雲端所有 key

# ── 設定機密 ──
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put TOKEN_SECRET
npx wrangler secret put PAGES_DEPLOY_HOOK      # 選填

# ── 測試 ──
cd cloud/worker && node test-local.mjs       # API 邏輯（60 項）
cd cloud/worker && node test-kv-images.mjs   # KV 圖片模式（32 項）
cd cloud/worker && node test-browser.mjs     # 瀏覽器端到端（15 項）
```

---

## 附錄：R2 vs KV 圖片儲存 — 決策摘要

**一句話：不想綁卡就別開 R2，本專案用 KV 存圖片完全夠用。**

Cloudflare R2 雖然有 10GB 免費額度，但**開通時強制要求綁定付款方式**。
本專案因此把圖片儲存做成雙模式，由 `env.IMAGES` 是否存在自動判斷：

```
env.IMAGES 存在  → 圖片存 R2（走 CDN，不佔 KV 配額）
env.IMAGES 不存在 → 圖片存 KV（base64，零額外設定）
```

兩種模式下，**API 回應、前台網址、後台介面行為完全一致**。
`src/storage.js` 以外的所有程式碼（路由、驗證、schema、前台）都感知不到差異。

什麼情況才需要真的去開 R2？

- 圖片總量超過 KV 免費 1GB（本專案 300 人 × 3 張 × 200KB ≈ 180MB，還很遠）
- 每天換圖超過數百次（KV 寫入配額會吃緊）
- 需要放高解析度大圖（例如 10MB 以上的橫幅）

以上都不成立的話，KV 模式是更省事的選擇。

