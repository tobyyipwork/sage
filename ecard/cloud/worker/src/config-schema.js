/**
 * SAGE E-Card Cloud — 機構設定正規化
 *
 * 所有機構設定（config）的唯一正規化入口。
 * 與 staff-schema.js 同樣的設計原則：不論從哪裡進來都經過這裡清洗，
 * 確保結構一致、欄位受控。
 *
 * ── 為什麼需要這一層（2026-09 新增）──────────────────────────
 *
 * 原本 storage.putConfig 是「原封不動寫入」，這在只有開發者能寫的
 * 情況下沒有問題。但後台開放「機構設定」介面後，任何登入者都能寫，
 * 於是出現兩個風險：
 *
 *   1. 有人不小心把 langs 清空、或把 site.basePath 改錯，
 *      下次建置時 build.js 會整站崩潰，且錯誤訊息難以理解。
 *
 *   2. 前端只要漏送一個欄位（例如舊版快取），該欄位就會被清空 ——
 *      因為原本是「整份取代」語意。
 *
 * 因此改為：
 *   - 白名單欄位：只有明確允許的欄位會被寫入
 *   - 唯讀欄位：一律沿用既有值，忽略輸入（org_code / site.url / basePath …）
 *   - 合併語意：未提供的欄位沿用現值，不再整份取代
 *   - 語言完整性：三語欄位必須齊備，避免前台出現 undefined
 */

/** 單一語言欄位的字數上限（避免塞爆 KV 單值 25MB 限制） */
const MAX_TEXT = 2000;
/** 機構名稱上限（它會進 vCard 與頁面標題，過長會破版） */
const MAX_ORG_NAME = 200;
/** 簡介上限 */
const MAX_ABOUT = 2000;

/** 預設啟用語言（config 損毀時的保底） */
const FALLBACK_LANGS = ['zh', 'cn', 'en'];
const FALLBACK_DEFAULT_LANG = 'zh';

const str = (v, max = MAX_TEXT) => {
  const s = String(v ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
};

/**
 * 檢查是否為合法的 http(s) URL。
 * 刻意不接受其他協定（避免 javascript: 之類的注入）。
 */
const isHttpUrl = (v) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * 正規化「多語言字串物件」。
 *
 * 三種情況必須分清楚：
 *   ① 整個欄位未提供（input 為 undefined）→ 沿用 fallback（合併語意）
 *   ② 該語言鍵未提供（input[lang] === undefined）→ 沿用 fallback
 *   ③ 該語言鍵有提供但為空字串 → 依 allowEmpty 決定「清空」或「沿用」
 *
 * ① ② 是「前端漏送」，不該清空資料；
 * ③ 才是使用者「刻意清空」，應予尊重（除非該欄位不允許留空）。
 */
const normalizeLangs = (input, langs, label, { max = MAX_TEXT, allowEmpty = true, fallback = null } = {}) => {
  // ① 整個欄位未提供 → 全部沿用
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
    const carried = {};
    for (const lang of langs) carried[lang] = str(fallback?.[lang], max);
    if (!allowEmpty) {
      for (const lang of langs) {
        if (!carried[lang]) {
          throw Object.assign(new Error(`${label}（${lang}）不可為空`), { status: 400 });
        }
      }
    }
    return carried;
  }

  const out = {};
  for (const lang of langs) {
    const raw = input[lang];
    // ② 該語言鍵未提供 → 沿用
    if (raw === undefined) {
      out[lang] = str(fallback?.[lang], max);
    } else {
      const val = str(raw, max);
      // ③ 有提供但為空：允許清空就直接清空，不允許則沿用（沿用不到就報錯）
      if (!val && !allowEmpty) {
        const prev = str(fallback?.[lang], max);
        if (!prev) {
          throw Object.assign(new Error(`${label}（${lang}）不可為空`), { status: 400 });
        }
        out[lang] = prev;
      } else {
        out[lang] = val;
      }
    }
  }

  // 不允許留空時，最終結果仍不可有空值（涵蓋「input 有值但 fallback 也空」的情境）
  if (!allowEmpty) {
    for (const lang of langs) {
      if (!out[lang]) {
        throw Object.assign(new Error(`${label}（${lang}）不可為空`), { status: 400 });
      }
    }
  }
  return out;
};

/**
 * 正規化機構設定。
 *
 * @param {object} input     前端送來的設定（可只帶部分欄位）
 * @param {object} existing  目前存在 KV 的設定（作為唯讀欄位與缺漏欄位的來源）
 * @returns 正規化後的完整 config 物件
 * @throws {Error & {status:number}} 驗證失敗時拋出，帶 HTTP 狀態碼
 */
export const sanitizeConfig = (input, existing) => {
  if (!existing || typeof existing !== 'object') {
    throw Object.assign(new Error('找不到現有機構設定，無法更新'), { status: 404 });
  }

  const src = input && typeof input === 'object' ? input : {};

  /* ---------- 語言清單（唯讀，沿用既有） ---------- */
  const langs = Array.isArray(existing.langs) && existing.langs.length
    ? existing.langs.map((l) => str(l)).filter(Boolean)
    : FALLBACK_LANGS;
  const defaultLang = str(existing.default_lang) || langs[0] || FALLBACK_DEFAULT_LANG;

  /* ---------- 可編輯欄位 ---------- */

  // 機構名稱：三語必填（它是標題與 vCard 的主要識別）
  const org = normalizeLangs(src.org, langs, '機構名稱', {
    max: MAX_ORG_NAME,
    allowEmpty: false,
    fallback: existing.org,
  });

  // 簡介：可留空（有些機構不想顯示）
  const about = normalizeLangs(src.about, langs, '機構簡介', {
    max: MAX_ABOUT,
    allowEmpty: true,
    fallback: existing.about,
  });

  // 地址：可留空
  const address = normalizeLangs(src.address, langs, '地址', {
    max: MAX_ORG_NAME,
    allowEmpty: true,
    fallback: existing.address,
  });

  // 官方網站：可留空，但填了就要是合法 URL
  const orgSite = src.org_site === undefined
    ? str(existing.org_site)
    : str(src.org_site);
  if (orgSite && !isHttpUrl(orgSite)) {
    throw Object.assign(new Error('官方網站需為完整的 http(s) 網址，例如 https://www.example.org'), { status: 400 });
  }

  /* ---------- QR 標籤（可編輯） ---------- */
  const existingQr = existing.qr && typeof existing.qr === 'object' ? existing.qr : {};
  const qr = { ...existingQr };
  if (src.qr?.label && typeof src.qr.label === 'object') {
    const label = {};
    for (const lang of langs) {
      const v = src.qr.label[lang];
      label[lang] = v === undefined
        ? str(existingQr.label?.[lang])
        : str(v, MAX_ORG_NAME);
    }
    qr.label = label;
  }

  /* ---------- site：僅 copyright 可編輯，其餘一律沿用 ---------- */
  const existingSite = existing.site && typeof existing.site === 'object' ? existing.site : {};
  const site = {
    // 唯讀：這些屬於部署環境，改了會讓前台連結全部失效
    url: existingSite.url,
    basePath: existingSite.basePath,
    version: existingSite.version,
    // 可編輯
    copyright: src.site?.copyright === undefined
      ? str(existingSite.copyright, MAX_ORG_NAME)
      : str(src.site.copyright, MAX_ORG_NAME),
  };

  /* ---------- 唯讀欄位：一律沿用既有值 ---------- */
  return {
    ...existing,          // 保留任何未知但既有的欄位（向前相容）
    org_code: existing.org_code,          // 改了會讓 KV 資料全部對不上
    langs,
    default_lang: defaultLang,
    org,
    about,
    address,
    org_site: orgSite,
    qr,
    site,
  };
};

/** 供前端顯示用：哪些欄位可以編輯 */
export const EDITABLE_FIELDS = [
  'org', 'about', 'address', 'org_site', 'site.copyright', 'qr.label',
];

/** 供前端顯示用：哪些欄位唯讀 */
export const READONLY_FIELDS = [
  'org_code', 'site.url', 'site.basePath', 'site.version', 'langs', 'default_lang',
];

export { isHttpUrl, MAX_ORG_NAME, MAX_ABOUT, MAX_TEXT };
