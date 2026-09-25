# 前台搬到 Cloudflare Pages — 完整比較分析

> 決策文件 | 2026-09-25
>
> 現況：前台在 GitHub Pages，後台 API 已在 Cloudflare Workers。
> 本文分析「把前台也搬到 Cloudflare Pages」的利弊與做法。

---

## 一、先講結論

**建議搬，但不必急。**

| 面向 | 搬到 Pages | 留在 GitHub Pages |
| --- | --- | --- |
| 網址 | 根目錄，`ecard.sage.org.hk` 直接可用 | 需靠 CNAME 繞子路徑 |
| 自動更新 | **可與後台連動，改完即生效** | 需手動 rebuild + push |
| 建置 | 每次 push 或資料更新時**在雲端**跑 | 在你電腦跑，push 靜態檔 |
| 相依 | 綁定 Cloudflare 生態 | 綁定 GitHub |
| 費用 | $0（500 build/月） | $0 |
| 風險 | 建置失敗需看雲端日誌 | 本機建置，成敗立刻知道 |

**唯一真正值得搬的理由：自動更新 pipeline。** 其他都是次要。

---

## 二、現況架構（搬遷前）

```
                    ┌─────────────────────┐
   你編輯名片  ───►  │  Cloudflare Worker  │
                    │  (已部署，含 KV)     │
                    └──────────┬──────────┘
                               │ 資料存在這裡
                               │
                    ┌──────────▼──────────┐
   訪客瀏覽    ◄───  │  GitHub Pages       │  ◄── 你手動 push 靜態檔
                    │  tobyyipwork.github │
                    │  .io/sage/ecard/    │
                    └─────────────────────┘

   問題：後台改了資料 → 前台不會變，要你手動 build + push
```

### 現況的痛點

1. **資料改了前台不會動** — 這是最麻煩的
2. **網址帶著 `/sage/ecard/dist`** — 不適合對外分享給長者
3. **`ecard.sage.org.hk` 綁不上** — 除非用 CNAME 技巧，但子路徑仍在

---

## 三、搬遷後架構

```
                    ┌─────────────────────┐
   你編輯名片  ───►  │  Cloudflare Worker  │
                    │  (已部署，含 KV)     │
                    └──────────┬──────────┘
                               │ 資料存在這裡
                               │
                               │ 呼叫 Deploy Hook
                    ┌──────────▼──────────┐
                    │  Cloudflare Pages   │
                    │  自動 build + 部署   │  ◄── 從 GitHub 拉原始碼
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
   訪客瀏覽    ◄───  │  ecard.sage.org.hk  │  ◄── 根目錄，乾淨網址
                    └─────────────────────┘

   改完資料 → 自動重建 → 約 30–60 秒後前台更新
```

---

## 四、兩者詳細對比

### 4.1 網址與自訂網域

| | GitHub Pages | Cloudflare Pages |
| --- | --- | --- |
| 預設網址 | `tobyyipwork.github.io/sage/ecard/` | `sage-ecard.pages.dev` |
| 子路徑問題 | **有**（`/sage/ecard/dist`） | 無（根目錄） |
| 綁自訂網域 | 可以，但子路徑仍在 | 可以，根目錄 |
| 免費 SSL | 有 | 有 |
| 自訂網域數 | 每個 repo 1 個 | **每專案 100 個** |

> **這是搬遷最直接的好處。** 現在 `basePath: "/sage/ecard/dist"` 會讓每張名片的
> 網址都帶著這串尾巴。搬到 Pages 後 `basePath` 改成空字串，網址變成
> `ecard.sage.org.hk/chan-tai-man/`，簡潔得多。

### 4.2 自動更新能力

| | GitHub Pages | Cloudflare Pages |
| --- | --- | --- |
| 觸發方式 | git push | git push **或** Deploy Hook |
| 後台改資料後 | ✗ 不會自動 | **✓ 可自動**（呼叫 Deploy Hook） |
| 建置位置 | 你的電腦（或 Actions） | Cloudflare 雲端 |
| 建置時間 | 你等，幾秒 | 雲端跑，30–60 秒 |
| 失敗排查 | 本機立刻看到 | 需看雲端日誌 |

> 現有 Worker 的 `/api/build` 端點早已預留 `PAGES_DEPLOY_HOOK` 支援，
> 只是還沒設。搬到 Pages 後補上這個 secret，功能立刻生效 —— **不用改程式碼**。

### 4.3 費用與配額

| 項目 | GitHub Pages | Cloudflare Pages 免費版 |
| --- | --- | --- |
| 費用 | $0 | $0 |
| 每月建置次數 | 無明確上限（Actions 2000 分鐘） | **500 次** |
| 並行建置 | — | 1（同時只能跑一個） |
| 單檔上限 | 100 MB | **25 MiB** |
| 檔案總數 | 1 GB repo | **20,000 檔** |
| 流量 | 每月 100 GB 軟限制 | **無限制** |
| 建置逾時 | — | 20 分鐘 |

#### 500 次/月夠不夠？

本專案目前 13 個檔案、2 位員工。就算成長到 300 位員工：

```
每位員工 3 語 × 2 檔（html + vcf）= 6 檔
300 人 × 6 = 1,800 檔  ← 遠低於 20,000 上限
```

建置次數方面，若每次編輯都觸發一次：

```
每天改 10 次 × 30 天 = 300 次/月   ← 用掉 60%，安全
每天改 20 次 × 30 天 = 600 次/月   ← 超出！
```

> ⚠️ **這是搬遷最需要注意的限制。** 如果你（或未來的主管）頻繁編輯，
> 500 次可能不夠。緩解方式見第七節。

### 4.4 內容大小

本專案產出 **311 KB / 13 檔**，完全在限制內。即使 300 人規模：

```
300 人 × 6 檔 × 平均 15 KB ≈ 27 MB   ← 毫無壓力
單檔最大是 logo.png（幾十 KB）        ← 遠低於 25 MiB
```

### 4.5 相依性與可攜性

| | GitHub Pages | Cloudflare Pages |
| --- | --- | --- |
| 綁定對象 | GitHub | Cloudflare |
| 移植難度 | 低（純靜態，搬到哪都行） | 低（純靜態，搬到哪都行） |
| 供應商鎖定 | 低 | 低（但與 Worker 同在 Cloudflare 較整合） |
| 私有 repo | 需付費方案 | **免費支援** |

> **兩者鎖定程度都低** — 因為產出是純靜態 HTML，隨時能搬走。
> 但既然後端已經在 Cloudflare，前台也放一起在**管理上更一致**。

### 4.6 建置流程差異（重要）

**GitHub Pages**：你在本機跑 build，把 `dist/` push 上去。
雲端只負責「serving」，不負責「building」。

**Cloudflare Pages**：兩種模式

| 模式 | 建置位置 | 適合 |
| --- | --- | --- |
| Git 整合 | 雲端（推 code 觸發） | 開發者改版型 |
| **Direct Upload** | 你的電腦 | 資料頻繁變動 |

> 本專案的特殊性：**資料在 KV，不在 git**。
> 所以不能用單純的 Git 整合 —— 需要在雲端建置時先從 KV 拉資料。
> 好消息：`cloud/scripts/kv-to-data.js` 就是為此寫的。

---

## 五、遷移的技術細節

### 5.1 唯一需要改的設定

```diff
  // data/config.json
  "site": {
-   "url": "https://tobyyipwork.github.io",
-   "basePath": "/sage/ecard/dist",
+   "url": "https://ecard.sage.org.hk",
+   "basePath": "",
    "copyright": "© 2026 香港耆康老人福利會 版權所有"
  }
```

就這兩個欄位。`build/build.js` 完全不用改（它已經正確讀取這兩個值）。

### 5.2 Pages 建置配置

| 設定項 | 值 |
| --- | --- |
| Framework preset | None |
| Build command | `node cloud/scripts/kv-to-data.js && node build/build.js` |
| Build output directory | `dist` |
| Root directory | `ecard`（因為 repo 根目錄是 `sage/`） |
| Node version | 環境變數 `NODE_VERSION=22` |

> ⚠️ **Root directory 必須設 `ecard`**，否則找不到 `build/build.js`。
> 這是 monorepo（`sage/` 下有 `ecard/`）的常見坑。

### 5.3 環境變數與權限

雲端建置時要讀 KV，需要：

| 變數 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 讀取 KV（需 KV **Read** 權限） |
| `CLOUDFLARE_ACCOUNT_ID` | `30554c7a2f2b71ad4345037a358ebf3b` |
| `NODE_VERSION` | `22` |

> ⚠️ 注意：這個 token 需要 **KV Read**。先前你建立的 token 只有 Write，
> 若要自動化建置，得補上 Read。

### 5.4 自動更新串接

```
你在後台按「儲存」
    │
    ▼
Worker 寫入 KV
    │
    ▼
Worker 呼叫 PAGES_DEPLOY_HOOK
    │       （5 分鐘內重複編輯會合併，保護 500 次配額）
    ▼
Pages 觸發建置：kv-to-data.js → build.js
    │
    ▼
約 30–60 秒後前台更新
```

需要設定的 secret：

```bash
npx wrangler secret put PAGES_DEPLOY_HOOK
# 值從 Pages 專案 → Settings → Builds & deployments → Deploy hooks 取得
```

### 5.5 已完成的預先驗證

搬遷的關鍵前提「雲端建置時能從 KV 取資料」**已在本地實測通過**：

```
$ node cloud/scripts/kv-to-data.js
  ✓ data/config.json
  ✓ 名單 2 筆
  ✓ data/staff/*.json — 2 張
  ✅ 同步完成：2 張名片。

$ node build/build.js
  ✓ built 2 staff × 3 langs → dist/
  產出 13 檔 / 311 KB
```

也就是說，Pages 的建置指令
`node cloud/scripts/kv-to-data.js && node build/build.js`
**已驗證可行**，不需要額外開發。

---

## 六、搬與不搬的判斷

### 值得搬，如果：

- ✅ 你希望**改完資料前台自動更新**（最主要）
- ✅ 想要 `ecard.sage.org.hk/chan-tai-man/` 這種乾淨網址
- ✅ 想把前台後台**統一在 Cloudflare** 管理
- ✅ 未來要給部門主管用，需要順暢的編輯體驗

### 可以緩，如果：

- ⏸️ 目前只有 2 位員工，手動 rebuild 也還好
- ⏸️ 還沒決定要不要用 `ecard.sage.org.hk`
- ⏸️ 想先觀察後台穩定性

---

## 七、500 建置次數的緩解方案

如果搬了之後發現次數不夠，有三個辦法：

### 方案 1：合併編輯（已實作 ✅）

Worker 端已加入**建置節流**：5 分鐘內的重複觸發合併為一次。
狀態存在 KV（不是記憶體），因此多個 isolate 之間也有效。

```toml
# cloud/worker/wrangler.toml
BUILD_THROTTLE_MINUTES = "5"   # 設 0 代表不節流
```

行為：

| 情境 | 結果 |
| --- | --- |
| 連續改 10 張名片 | **只觸發 1 次建置** |
| 5 分鐘後再改 | 觸發新的建置 |
| 需要立即發佈 | `POST /api/build` 帶 `{"force": true}` |
| 查詢狀態 | `GET /api/build` → 回報上次時間與可否建置 |

> 實測驗證：第一次觸發會呼叫 deploy hook；緊接著再次觸發會被略過，
> hook 呼叫次數維持 1 次；帶 `force:true` 才強制執行。

### 方案 2：手動觸發

後台加一個「發佈」按鈕，編輯時只存 KV，要上線時才按。
適合「先改完一批再一起發佈」的工作流。

### 方案 3：改用 Direct Upload

不在雲端建置，改由本機 build 後上傳：

```bash
npx wrangler pages deploy dist --project-name sage-ecard
```

不佔用 500 次建置配額，但失去自動化。

> 💡 **實際建議**：方案 1 已實作，幾乎不會撞到上限。
> 300 人每天各改一次的情境下，合併後約 300 次/月，用掉 60%。

---

## 八、建議的執行順序

若決定搬遷，分三階段降低風險：

### 第一階段：先驗證（不影響現況）

1. 建 Pages 專案，仍指向現有 GitHub repo
2. 暫時用 `*.pages.dev` 網址測試
3. 確認建置流程跑得通（`kv-to-data.js` 能讀到 KV）
4. **此時 GitHub Pages 照常運作**，隨時可回退

### 第二階段：切換

5. 改 `data/config.json` 的 `url` 與 `basePath`
6. 設定 `PAGES_DEPLOY_HOOK` secret
7. 測試「後台儲存 → 前台自動更新」完整鏈路
8. 綁定 `ecard.sage.org.hk`

### 第三階段：收尾

9. 關閉 GitHub Pages（或保留作為備援）
10. 觀察一週建置次數用量

---

## 九、對照表（一頁總結）

| 項目 | GitHub Pages | Cloudflare Pages | 勝 |
| --- | --- | --- | --- |
| 費用 | $0 | $0 | 平 |
| 網址乾淨度 | 有子路徑 | 根目錄 | **Pages** |
| 後台連動自動更新 | ✗ | ✓ | **Pages** |
| 每月建置次數 | 無明確上限 | 500 | GitHub |
| 檔案總數上限 | 1 GB repo | 20,000 | GitHub |
| 單檔上限 | 100 MB | 25 MiB | GitHub |
| 流量限制 | 100 GB/月軟限 | 無限制 | **Pages** |
| 自訂網域數 | 1 | 100 | **Pages** |
| 私有 repo | 付費 | 免費 | **Pages** |
| 與既有後台整合 | 跨平台 | 同生態 | **Pages** |
| 建置失敗排查 | 本機，直覺 | 雲端日誌 | GitHub |
| 遷移成本 | — | 改 2 個設定 + 建專案 | — |

**總結**：Pages 在「網址、自動化、整合度」勝出；
GitHub Pages 在「建置配額、大檔支援、除錯直覺度」勝出。

對本專案（300 人以下、純靜態、需頻繁編輯）而言，**Pages 的優勢更貼近需求**。

---

## 十、風險與注意事項

| 風險 | 嚴重度 | 緩解 |
| --- | --- | --- |
| 500 建置次數不足 | 中 | 合併觸發（方案 1） |
| 雲端建置需 KV Read token | 低 | 補權限即可 |
| Root directory 設錯 | 低 | 設 `ecard` |
| 建置失敗看不到原因 | 低 | Pages 有完整日誌 |
| 綁網域需 DNS 權限 | 低 | `sage.org.hk` 的 DNS 管理權 |
| 新帳號 48 小時內限建專案 | 低 | 你的帳號已存在一段時間 |

---

## 十一、目前狀態

| 項目 | 狀態 |
| --- | --- |
| Worker（後台 API） | ✅ 已部署上線 |
| KV 資料 | ✅ 已遷移（2 筆名片） |
| 圖片儲存 | ✅ KV 模式（不需 R2） |
| 建置節流 | ✅ 已實作（75 項測試通過） |
| 雲端建置鏈路 | ✅ 已本地驗證（kv-to-data → build） |
| 前台 | ⏳ 仍在 GitHub Pages |
| `PAGES_DEPLOY_HOOK` | ⏳ 未設定（第二階段才需要） |
| `ecard.sage.org.hk` | ⏳ 尚未綁定 |

### 搬遷前已就緒的事項

以下都已備妥，實際搬遷時不會卡住：

- ✅ Worker 的 `/api/build` 端點支援 Deploy Hook（含節流與 `force`）
- ✅ 建置指令 `kv-to-data.js && build.js` 實測可行
- ✅ 產出僅 311 KB / 13 檔，遠低於 20,000 檔與 25 MiB 限制
- ✅ `build.js` 只需改 `config.json` 的 `url` 與 `basePath` 兩個值
- ✅ 測試覆蓋：75 項 API + 32 項 KV 圖片模式

### 需要你決定／提供的事項

1. 是否要現在搬？（見第六節判斷）
2. `ecard.sage.org.hk` 的 DNS 管理權限是否在你手上？
3. 用於雲端建置的 token 需要 **KV Read** 權限（先前的只有 Write）
