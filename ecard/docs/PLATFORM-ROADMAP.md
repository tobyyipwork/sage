# 平台化路線圖 — 讓新機構自助管理

> 本文說明如何把目前的「單機構 ＋ 共用密碼」系統，
> 逐步演進為「多機構 ＋ 可自助管理」的平台。
>
> **撰寫時間**：2026-09-28
> **對應程式碼版本**：v1.2.0

> 📌 **要把系統交給同事試用？** 先看 [`PILOT-READINESS.md`](PILOT-READINESS.md) ——
> 那是「現在可不可以給人用」的實測評估；本文是「未來要怎麼演進」的規劃。
> 兩者的交集在第三節（曝光點處理）與第五節（第 3、4 層）。

---

## 一、問題陳述

### 目標

新機構的職員應該能在**網頁上**完成所有管理動作，包括：

- 註冊 / 開通 admin 帳戶
- 忘記密碼時自行重設
- 修改密碼
- 編輯機構資料（名稱、地址、簡介、logo）

### 現況：**做不到**，且差距不小

這不是「加一個設定頁面」就能解決的問題 ——
系統目前**完全沒有「帳號」這個概念**。

---

## 二、現況查核（實地檢視程式碼的結果）

### 2.1 驗證層：只有一組共用密碼

`cloud/worker/src/auth.js` 的全部登入邏輯：

```js
export const verifyLogin = async (password, env) => {
  const stored = String(env.ADMIN_PASSWORD_HASH || '').trim().toLowerCase();
  const input = await sha256Hex(String(password || ''));
  // 時序安全比較
  return diff === 0 ? { ok: true } : { ok: false, reason: 'wrong password' };
};
```

通行證的內容也固定：

```js
const payload = { sub: 'admin', iat, exp };   // 永遠是 "admin"，沒有身分
```

**關鍵事實**：

| 項目 | 現況 |
| --- | --- |
| 帳號儲存位置 | Worker 環境密鑰 `ADMIN_PASSWORD_HASH` |
| 能否透過 API 修改 | ❌ 不能。只能 `wrangler secret put` |
| 有幾組帳號 | 1 組（全機構共用） |
| 密碼能否找回 | ❌ 不能。只存 SHA-256 雜湊，不可逆 |
| 是否有使用者清單 | ❌ 沒有 |

> **設計脈絡**：`auth.js` 檔頭註解自己寫明了：
> 「驗證層（方案 A：共用密碼）…… 將來升級到方案 B（Email 驗證碼）時，
> 只需替換本檔的 `verifyLogin`，其餘程式碼完全不用動。」
>
> 所以這是**刻意的簡化**，不是疏漏。
> 當時的適用場景是「一個機構、少數幾位信任的職員」。
> 你的新需求本質上屬於**方案 B 的範疇**。

### 2.2 儲存層：已為方案 B 預留位置

`cloud/worker/src/storage.js` 的 key 命名規則中已經有：

```
users:sage            （方案 B 預留：授權 email 名單）
```

這是好消息 —— 儲存層的架構不需要大改，只需把預留的位置填上。

### 2.3 機構資料：**後端已就緒，只缺介面**

這是本次查核最重要的發現。

`cloud/worker/src/index.js` 第 286–297 行**已經存在**完整的讀寫端點：

```js
'GET /api/config': async () => {
  const cfg = await storage.getConfig();
  if (!cfg) throw Object.assign(new Error('尚未設定機構資料，請先執行遷移腳本'), { status: 404 });
  return cfg;
},

'PUT /api/config': async ({}, request) => {
  const body = await jsonBody(request);
  const cfg = await storage.putConfig(body);
  const rebuild = await runRebuild(storage, env);   // 寫入後自動觸發前台重建
  return { ok: true, config: cfg, rebuild };
},
```

但後台前端（`admin/public/index.html`）**從來沒有呼叫過 `PUT /api/config`**。
`GET` 只用了一次，且僅用於頁首副標題：

```js
// index.html:280-281
try{CONFIG=await api('GET','/api/config');}catch(e){CONFIG={};}
$('#subline').textContent = (CONFIG.org?.zh || '') + ' · SAGE E-Card Admin · v' + ...;
```

**結論：機構資料編輯功能「只缺一個介面」。**
這是投報率最高的一步 —— 後端、權限、重建觸發全部都已具備。

### 2.4 一個必須先修的風險：`putConfig` 零驗證

```js
const putConfig = async (cfg) => {
  await putJson(kConfig(), cfg);   // 原封不動存進去，沒有任何檢查
  return cfg;
};
```

目前沒有問題，因為**只有開發者能寫**。
但一旦開放給機構自助編輯，這會變成嚴重風險：

假設有人在介面上把 `langs` 清空，或把 `site.basePath` 打錯，
`build/build.js` 會在下次建置時**整站崩潰**，而且錯誤訊息會很難懂：

```js
// build.js:46-47 — 直接存取，沒有防護
const SITE_URL = String(config.site.url).replace(/\/+$/, '');
const BASE_PATH = (config.site.basePath || '').replace(/\/+$/, '');
```

> ⚠️ **因此第 2 層（設定介面）必須同時補上後端驗證**，
> 不能只做前端表單。前端驗證擋不住直接呼叫 API 的情況。

---

## 三、四層架構

由小到大，每層可獨立交付。

### 第 1 層：可重設的密碼 ✅ 已完成（2026-09-28）

**核心動作**：把密碼雜湊從「Worker 密鑰」搬到 KV。

```
原本：  env.ADMIN_PASSWORD_HASH          ← 唯讀，只能 CLI 改
現在：  auth:{org}:password              ← 可透過 API 讀寫
        （讀不到時才回落環境密鑰）
```

**實際實作**：

```js
// storage.js
const kAuthPassword = () => `auth:${ORG}:password`;
const getPasswordRecord = () => getJson(kAuthPassword());
const putPasswordRecord = (hash, { algo='sha256', updatedBy='admin' } = {}) => { ... };
const hasPasswordRecord = async () => { ... };
```

```js
// auth.js — 優先 KV，讀不到才回落環境密鑰
export const verifyLogin = async (password, env, storage = null) => {
  if (storage) {
    const rec = await storage.getPasswordRecord();
    if (rec?.hash) { /* 比對 KV 的雜湊，source: 'kv' */ }
  }
  /* 回落：env.ADMIN_PASSWORD_HASH，source: 'env' */
};
```

**端點**：

| 端點 | 用途 |
| --- | --- |
| `GET /api/password` | 只回報狀態（`configured` / `source` / `migrated`），**絕不回傳雜湊** |
| `POST /api/password` | 修改密碼（需帶舊密碼驗證） |

**密碼政策**：`password-policy.js`，前後端共用。
至少 8 字元、不可為常見密碼、不可為重複單一字元。
強度評分僅供提示，不影響是否通過。

**解鎖**：網頁修改密碼。
**仍缺**：忘記密碼 —— 沒有寄信能力就無法安全地驗證身分。

#### 相容性設計（實作時最容易出錯處）

> **務必保留對 `env.ADMIN_PASSWORD_HASH` 的回落。**
> 否則這次升級會讓現有機構（SAGE）**立刻無法登入** ——
> 因為升級當下 KV 裡還沒有值。
>
> 有了回落，機構可以照自己的步調遷移：
> **第一次在網頁改密碼時**才會寫入 KV，之後就以 KV 為準。

另外補上兩層防護：

| 情境 | 行為 |
| --- | --- |
| KV 讀取拋錯 | 回落環境密鑰（KV 故障不該讓登入整個壞掉） |
| KV 與環境密鑰都沒有 | 回 500 —— 這是「設定問題」，不是「密碼錯」 |

#### 已知限制

改密碼後會簽發新通行證給**當前裝置**，但其他裝置的舊通行證
仍有效直到到期（無狀態 JWT 設計的固有取捨）。
想強制全部登出需輪換 `TOKEN_SECRET`，或改為有狀態的 token 撤銷清單。
以本專案「每機構 1–2 位職員」的規模，目前不需處理。

---

### 第 2 層：設定介面（後台 UI）

在後台加入「⚙ 設定」分頁。

**可編輯欄位**（依 `build/build.js` 實際使用的欄位整理）：

| 欄位 | 型別 | 語言 | 備註 |
| --- | --- | --- | --- |
| `org.zh` / `org.cn` / `org.en` | 單行文字 | 三語 | 機構名稱，出現在標題、vCard |
| `org_site` | URL | — | 官方網站，寫入 vCard 的 `URL` |
| `about.zh` / `.cn` / `.en` | 多行文字 | 三語 | 關於我們 |
| `address.zh` / `.cn` / `.en` | 單行文字 | 三語 | 地址，寫入 vCard 的 `ADR` |
| `site.copyright` | 單行文字 | — | 頁尾版權 |
| `qr.label.zh` / `.cn` / `.en` | 單行文字 | 三語 | QR 區塊標題 |

**唯讀顯示**（不允許編輯，僅供確認）：

| 欄位 | 原因 |
| --- | --- |
| `org_code` | 改了會導致 KV 資料全部對不上 |
| `site.url` | 部署環境的一部分，改了前台連結全斷 |
| `site.basePath` | 同上 |
| `langs` / `default_lang` | 改了會影響已建置的頁面結構 |
| `site.version` | 由程式碼控管 |

**必須同時新增後端驗證**（見 2.4）：

```js
// 新增 config-schema.js
const validateConfig = (input, existing) => {
  // 1. org / about / address 必須包含所有啟用語言，且為非空字串
  // 2. org_site 必須是合法 URL
  // 3. 唯讀欄位一律沿用現值，忽略輸入
  // 4. 長度上限（避免塞爆 KV 的 25MB 單值限制）
  return sanitized;
};
```

> **重要**：`PUT /api/config` 應改為「**合併**」語意而非「覆蓋」。
> 目前是整份取代，前端只要漏送一個欄位就會把它清空。
> 改為只接受白名單欄位，其餘一律沿用現值。

**解鎖**：機構自助編輯資料。
**投報率最高**，因為後端已就緒。

---

### 第 3 層：Email 驗證碼登入（方案 B）

這是**唯一能實現「忘記密碼」的路**。

**為什麼非做不可**：
「忘記密碼」的安全前提是「能證明你是本人」。
沒有寄信能力，就只能用安全性問題（弱）或人工介入（現況）。

**需要新增的相依**：一個寄信服務。
Cloudflare Workers 本身**沒有**寄信能力，必須外接。
常見選擇：

| 服務 | 免費額度 | 備註 |
| --- | --- | --- |
| Resend | 3,000 封/月 | API 最簡潔，對 Workers 友善 |
| SendGrid | 100 封/日 | 老牌，設定較繁 |
| MailChannels | 曾免費，現需付費 | 政策已變，不建議新採用 |

**流程設計**：

```
1. 使用者輸入 email
2. 系統查 users:{org} 名單 → 不在名單就直接拒絕（不洩漏帳號是否存在）
3. 產生 6 位數驗證碼，存 KV：otp:{org}:{email}，TTL 10 分鐘
4. 寄出驗證碼
5. 使用者輸入驗證碼 → 比對成功即發通行證
```

**KV 的 TTL 特性正好合用**：

```js
await KV.put(key, value, { expirationTtl: 600 });   // 10 分鐘後自動消失
```

**安全要點**（必須全部落實）：

| 項目 | 做法 |
| --- | --- |
| 驗證碼長度 | 6 位數，**必須用時序安全比較** |
| 嘗試次數限制 | 同一 email 連續失敗 5 次即鎖定 15 分鐘 |
| 發送頻率限制 | 同一 email 每分鐘最多 1 封、每小時最多 5 封 |
| 回應一致性 | 帳號不存在時也要回「已寄出」，避免列舉攻擊 |
| 驗證碼雜湊 | 存雜湊而非明文（KV 若外洩也無法直接使用） |

**解鎖**：真正的忘記密碼自助流程、免密碼登入。

---

### 第 4 層：多使用者與權限

```
user:{org}:{email}  →  { email, role, added_at, last_login_at, active }
```

**角色設計建議**（保持簡單）：

| 角色 | 權限 |
| --- | --- |
| `owner` | 全部，含帳號管理、機構設定 |
| `editor` | 只能編輯名片，不能改機構設定或帳號 |

**解鎖**：一機構多帳號、離職停權、稽核紀錄（誰改了什麼）。

**建議延後**，直到真的有多人協作需求。
目前每機構 1–2 位職員的話，第 3 層已足夠。

---

## 四、相依關係

```
第 1 層（KV 密碼）
    ↓ 提供可寫入的憑證儲存
第 2 層（設定介面）← 依賴第 1 層的儲存模式，但不嚴格
    ↓
第 3 層（Email 驗證碼）← 需要寄信服務；依賴第 1 層的儲存
    ↓
第 4 層（多使用者）← 依賴第 3 層的身分機制
```

**關鍵路徑**：第 1 層是所有後續的基礎。
但**第 2 層可以先做**，因為它的後端（`PUT /api/config`）已經存在。

---

## 五、建議順序

| 順序 | 項目 | 狀態 |
| --- | --- | --- |
| **1** | 第 2 層：機構設定介面 ＋ 後端驗證 | ✅ 已完成 |
| **2** | 第 1 層：網頁修改密碼 | ✅ 已完成 |
| **3** | 第 3 層：Email 驗證碼 | 待做 —— 唯一能實現「忘記密碼」的路徑 |
| 4 | 第 4 層：多使用者 | 待做 —— 等到真的有多人需求 |

### 為什麼先做第 2 層而不是第 1 層

雖然第 1 層是架構基礎，但第 2 層的**後端已完全就緒**，
只需補前端介面與驗證邏輯即可立即產生價值。
先做出可用的成果，比先打地基更容易驗證方向是否正確。

兩層都完成後，機構目前**已經可以自助**完成：

- ✅ 登入
- ✅ 管理名片（新增／編輯／刪除／上傳圖片）
- ✅ 編輯機構資料（名稱、地址、簡介、版權、QR 標籤）
- ✅ 修改自己的密碼
- ❌ 忘記密碼時自行重設 ← 仍需第 3 層（或人工介入）

---

## 五之二、下一步：第 3 層（Email 驗證碼）

這是目前唯一還缺的自助能力，也是最複雜的一層。

**需要新增的相依**：一個寄信服務（Cloudflare Workers 本身無法寄信）。

| 服務 | 免費額度 | 備註 |
| --- | --- | --- |
| Resend | 3,000 封/月 | API 最簡潔，對 Workers 友善 |
| SendGrid | 100 封/日 | 老牌，設定較繁 |

**流程**：

```
1. 輸入 email
2. 查 users:{org} 名單 → 不在名單就直接拒絕（不洩漏帳號是否存在）
3. 產生驗證碼，存 KV otp:{org}:{email}，TTL 10 分鐘
4. 寄出驗證碼
5. 輸入驗證碼 → 比對成功即發通行證
```

KV 的 TTL 特性正好合用：`KV.put(key, val, { expirationTtl: 600 })`

**安全要點（必須全部落實）**：

| 項目 | 做法 |
| --- | --- |
| 驗證碼長度 | 6 位數，**必須時序安全比較** |
| 嘗試次數 | 同 email 連續失敗 5 次即鎖定 15 分鐘 |
| 發送頻率 | 每分鐘最多 1 封、每小時最多 5 封 |
| 回應一致性 | 帳號不存在也回「已寄出」，避免列舉攻擊 |
| 驗證碼儲存 | 存雜湊而非明文 |

儲存層已預留 `users:{org}` 作為授權 email 名單。

---

## 六、短期方案（在新機構上線前）

在完成第 3 層之前，「忘記密碼」**本質上不可能自助**。
若近期就要給新機構使用，務實做法是：

**人工開通模式**

1. 開發者用 CLI 為新機構設定初始密碼：
   ```bash
   node cloud/scripts/make-password.js --random
   npx wrangler secret put ADMIN_PASSWORD_HASH
   ```
2. 將密碼交付機構負責人（建議當面或加密管道）
3. 之後機構可自行用後台管理名片

**這個模式能運作**，缺點是每個新機構都要開發者出手一次。

---

## 七、附錄：現況功能盤點

### 後台已具備的功能

| 功能 | 狀態 |
| --- | --- |
| 登入 / 登出 | ✅ |
| 名片列表 | ✅ |
| 新增 / 編輯 / 刪除名片 | ✅ |
| 上傳圖片（banner / avatar / wechat_qr） | ✅ |
| 手動觸發重建 | ✅ |
| 重建模式顯示 | ✅ |
| 編輯機構資料（三語名稱／簡介／地址、官網、版權、QR 標籤） | ✅ |
| 檢視密碼設定狀態（來源與是否已遷移） | ✅ |
| 修改密碼（需驗證目前密碼 + 強度檢查） | ✅ |
| 忘記密碼（自助重設） | ❌ 需第 3 層（Email 驗證碼） |

### Worker API 端點清單

| 端點 | 狀態 |
| --- | --- |
| `GET /api/health` | ✅ |
| `POST /api/login` | ✅ |
| `GET /api/config` | ✅ |
| `PUT /api/config` | ✅ 僅更新（無既有值回 404）、白名單欄位、`org_code`／`langs` 唯讀 |
| `GET /api/staff` | ✅ |
| `POST /api/staff` | ✅ |
| `GET /api/staff/:slug` | ✅ |
| `PUT /api/staff/:slug` | ✅ |
| `DELETE /api/staff/:slug` | ✅ |
| `POST /api/staff/:slug/image` | ✅ |
| `DELETE /api/staff/:slug/image/:key` | ✅ |
| `GET /api/build` | ✅ |
| `POST /api/build` | ✅ |
| `GET /api/password` | ✅ 回報 `configured`／`source`／`migrated` |
| `POST /api/password` | ✅ 驗證舊密碼 → 政策檢查 → 寫入 KV `auth:{org}:password` |
| `POST /api/auth/request-code` | ❌ 待新增（第 3 層） |
| `POST /api/auth/verify-code` | ❌ 待新增（第 3 層） |

### 相關檔案

| 檔案 | 職責 |
| --- | --- |
| `cloud/worker/src/auth.js` | 驗證層（登入、通行證簽發與驗證，KV 優先／環境密鑰回落） |
| `cloud/worker/src/password-policy.js` | 密碼政策（長度、常見密碼黑名單、強度評分） |
| `cloud/worker/src/config-schema.js` | 機構設定白名單與合併語意驗證 |
| `cloud/worker/src/storage.js` | KV 存取封裝，含 `auth:{org}:password`、`users:{org}` 預留位 |
| `cloud/worker/src/index.js` | 路由表與 API 實作 |
| `admin/public/index.html` | 後台單頁應用 |
| `data/config.json` | 機構設定（本機版）；雲端版存在 KV `config:{org}` |
| `build/build.js` | 靜態站建置器，消費 `config` |
