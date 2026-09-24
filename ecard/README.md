# SAGE E-Card — 電子名片產生器

零依賴的靜態電子名片產生器。把 `data/staff/*.json` 轉成三語（繁／簡／英）電子名片網頁 + vCard 聯絡人檔，
並為每張名片自動產生可掃描的 **QR Code**。

---

## 快速開始

```bash
# 產生網站（輸出到 dist/）
npm run build          # 或：node build/build.js

# 啟動本地後台（可新增／修改／刪除名片）
npm run admin          # 或：node admin/server.js
# 開啟 http://localhost:4173
```

**需求**：Node.js ≥ 18。無任何 npm 依賴套件。

---

## 目錄結構

```
ecard/
├── data/
│   ├── config.json          ← 機構設定（名稱、地址、網域、QR 設定）
│   └── staff/
│       ├── chan-tai-man.json ← 一位員工 = 一份檔案
│       └── lee-siu-wah.json
├── templates/
│   ├── card.html            ← 名片頁面骨架
│   └── style.css            ← 樣式（主題色、版面）
├── assets/
│   └── images/
│       ├── org/logo.png     ← 機構標誌
│       └── {slug}/          ← 各員工圖片（banner / avatar / wechat_qr）
├── build/
│   ├── build.js             ← 產生器主程式
│   └── qr.js                ← 零依賴 QR Code 編碼器（輸出 SVG）
├── admin/
│   ├── server.js            ← 本地後台伺服器
│   └── public/index.html    ← 後台管理介面
└── dist/                    ← 產出（部署這個目錄）
```

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
    "version": "1.1.0"
  },
  "qr": {
    "enabled": true,
    "mode": "static",                  // "static"（預設）或 "dynamic"
    "base": "",                        // dynamic 模式時填中轉服務網域
    "path": "/r/{org}/{slug}",
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

### 方法一：本地後台（推薦，非技術人員）

```bash
npm run admin     # 開啟 http://localhost:4173
```

後台可：新增名片、編輯三語資料、上傳頭像／橫幅／微信 QR、刪除名片、一鍵重新產生網站。

### 方法二：直接編輯 JSON

在 `data/staff/` 新增一份 `{slug}.json`：

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

- 此為機構內部工具。`admin/server.js` 為**本地開發用**，請勿暴露於公開網路。
- 員工個人資料請依相關私隱法規處理。

---

_版本 1.1.0 · 香港耆康老人福利會_
