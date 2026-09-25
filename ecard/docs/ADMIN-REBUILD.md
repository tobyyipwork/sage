# 後台「一鍵重建」設定指南

> 建立日期：2026-09-25
>
> 目標：在雲端後台改完名片後，**按一下（或直接儲存）就讓前台更新**，
> 不必等排程、也不需手動跑指令。

---

## 一、為什麼需要這個

前台是**預先建置的靜態檔**（GitHub Pages），資料存在 **Cloudflare KV**。
兩者之間原本靠「每 15 分鐘輪詢」連接，但這有兩個問題：

1. **延遲** —— 改完最多要等 15 分鐘才生效
2. **不可靠** —— 本 repo 的 GitHub 排程實際上**從未成功觸發過**
   （詳見 [`AUTO-REBUILD.md`](AUTO-REBUILD.md) 的已知問題章節）

所以改成**由後台主動觸發**：

```
   你按「儲存」或「立即重建前台」
          │
          ▼
   Worker 呼叫 GitHub Actions 的 workflow_dispatch API
          │
          ▼
   GitHub Actions 執行 auto-rebuild.yml
          │  比對指紋 → 有變才同步 KV、建置、提交
          ▼
   GitHub Pages 自動部署（約 1–2 分鐘）
```

**這條路不依賴 GitHub 排程**，所以完全避開了排程失效的問題。

---

## 二、設定步驟

### 步驟 1：建立 fine-grained PAT

到 <https://github.com/settings/personal-access-tokens/new>

| 欄位 | 設定值 |
| --- | --- |
| Token name | `sage-ecard-rebuild`（或任何你認得的名稱） |
| Expiration | 建議 90 天或更長（到期需重新產生） |
| **Repository access** | **Only select repositories** → 只勾 `sage` |
| **Permissions → Repository permissions** | 展開，找到 **Actions**，設為 **Read and write** |

> **其他權限全部不用給。** 特別是**不要**給 Contents 權限 ——
> 這個 token 只需要「觸發 workflow」的能力。
>
> 這是**最小權限原則**：即使 token 外洩，攻擊者也只能觸發你的重建 workflow，
> 無法讀取或修改程式碼。

建立後**立刻複製** token（`github_pat_...`），離開頁面就看不到了。

### 步驟 2：存進 Cloudflare Worker

```bash
cd ecard/cloud/worker
wrangler secret put GITHUB_REPO
#   貼上：tobyyipwork/sage

wrangler secret put GITHUB_DISPATCH_TOKEN
#   貼上：github_pat_...
```

> `GITHUB_REPO` 本身不是機密，但放進 secret 可以跟 token 一起管理，
> 避免日後只設了一個而漏了另一個。

### 步驟 3：重新部署

改動了程式碼，所以要重新部署：

```bash
npm run cloud:push
```

### 步驟 4：驗證

```bash
curl https://sage-ecard-api.tobyyip-work.workers.dev/api/health
```

然後開後台，按「⟳ 立即重建前台」。若看到：

> ✓ 已通知 GitHub 開始重建，約 1–2 分鐘後前台更新。

就成功了。也可以到 GitHub 的 Actions 頁面確認有新的執行。

---

## 三、設定前的行為（未設定時）

**不會壞掉，只是不會自動。** 後台會明白告訴你：

> ℹ 資料已儲存，但後台尚未設定自動重建（需 GITHUB_REPO 與 GITHUB_DISPATCH_TOKEN）。
> 目前可等待排程，或手動執行：gh workflow run auto-rebuild.yml

這是刻意設計的 —— **半套設定比沒設定更危險**，
所以我們把「兩個都缺」和「只設一個」明確區分開來，後者會直接報錯。

---

## 四、觸發時機

設定完成後，以下操作都會自動觸發重建：

| 操作 | 是否觸發 |
| --- | --- |
| 新增名片 | ✅ |
| 修改名片 | ✅ |
| 刪除名片 | ✅ |
| 修改機構設定 | ✅ |
| 上傳／刪除圖片 | ✅ |
| 按「⟳ 立即重建前台」 | ✅（強制，略過節流） |

---

## 五、節流機制

**為什麼要節流**：使用者常常連續編輯多張名片才離開。
若每次儲存都立刻觸發，短時間內會產生大量重複建置（結果還都一樣）。

**預設 5 分鐘視窗**：視窗內的重複觸發會合併，只回報「前台將稍後合併更新」。

調整方式 —— 在 `wrangler.toml` 的 `[vars]` 改：

```toml
BUILD_THROTTLE_MINUTES = "5"   # 改 0 代表不節流
```

改完需重新部署。

> 節流狀態記在 **KV** 而非記憶體。記憶體版在多個 isolate 之間不共用，
> 會各自計時而失效 —— 這是實作上的關鍵細節。

---

## 六、疑難排解

| 症狀 | 原因 | 解法 |
| --- | --- | --- |
| 顯示「尚未設定自動重建」 | 兩個 secret 沒設 | 回到步驟 2 |
| 顯示「缺少 GITHUB_DISPATCH_TOKEN」 | 只設了 repo | 補上 token |
| 「token 無效或已過期」（401） | PAT 過期或被撤銷 | 重新產生，更新 secret |
| 「token 權限不足」（403） | 沒給 Actions: Read and write | 編輯 PAT 權限 |
| 「找不到 repo 或 workflow 檔案」（404） | `GITHUB_REPO` 打錯，或分支不對 | 檢查格式必須是 `擁有者/倉庫` |
| 「該 workflow 已被停用」（410） | repo 的 Actions 被關 | 到 Actions 頁面重新啟用 |
| 觸發成功但前台沒變 | 重建失敗或 Pages 還在部署 | 看 Actions 的執行結果，等 1–2 分鐘 |
| 一直顯示「稍後合併更新」 | 節流生效中 | 正常現象，等 5 分鐘或按「立即重建」（會強制） |

### 查看實際的執行結果

後台按鈕只回報「有沒有成功送出通知」，**實際建置成功與否要看 Actions**：

```bash
gh run list --limit 5
gh run view <run-id> --log
```

或直接開 <https://github.com/tobyyipwork/sage/actions>

---

## 七、安全性說明

**這個 token 能做什麼？**

僅限：觸發 `sage` 這一個 repo 的 Actions workflow。

**不能做什麼？**

- ❌ 讀取或修改程式碼（未給 Contents 權限）
- ❌ 存取其他任何 repo
- ❌ 讀取你的 KV 資料（那是 Cloudflare 的另一組憑證）

**在哪裡？**

存在 Cloudflare Worker 的加密 secret 中，不會出現在程式碼、
不會寫進 git、也不會回傳給前端。

**如何撤銷？**

隨時到 <https://github.com/settings/personal-access-tokens>
把該 token 刪除（Revoke）即可立即失效。

**到期後怎麼辦？**

token 過期時，後台按鈕會回報 401 並提示「token 無效或已過期」。
重新產生一個、`wrangler secret put GITHUB_DISPATCH_TOKEN` 更新即可。

> 💡 建議在行事曆設個提醒，到期前一週換新，避免突然失效。

---

## 八、相關檔案

| 檔案 | 作用 |
| --- | --- |
| `cloud/worker/src/github.js` | 呼叫 GitHub API 的邏輯（設定檢查、觸發、查詢狀態） |
| `cloud/worker/src/index.js` | 各端點寫入後呼叫 `runRebuild()`，含節流 |
| `admin/public/index.html` | 按鈕與提示訊息 |
| `.github/workflows/auto-rebuild.yml` | 被觸發的 workflow |
| `cloud/worker/test-rebuild-trigger.mjs` | 29 項測試（設定檢查、觸發、錯誤處理） |
| `cloud/worker/wrangler.toml` | secret 設定說明 |

---

## 九、與排程的關係

**兩者並存，互不衝突。**

- 後台觸發 → 即時，主要途徑
- 排程 → 備援（萬一沒人開後台也能自動更新）

若日後 GitHub 排程恢復正常，兩者會一起運作，指紋比對機制確保
資料沒變時不會產生多餘的 commit。
