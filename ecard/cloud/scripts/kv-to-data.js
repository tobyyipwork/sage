#!/usr/bin/env node
/**
 * 從 Cloudflare KV 把資料同步回本地 data/ 目錄，供 build/build.js 使用。
 *
 * 這是自動重建流程的第一步：
 *     node cloud/scripts/kv-to-data.js  &&  node build/build.js
 *
 * 兩種讀取模式（自動判斷）：
 *   1. REST API  — 偵測到 CLOUDFLARE_API_TOKEN 時使用。
 *                  適合 GitHub Actions 等 CI 環境，不依賴本機登入憑證。
 *   2. wrangler  — 本機開發時使用（需先 wrangler login）。
 *
 * 用法：
 *   node cloud/scripts/kv-to-data.js             自動選模式（有 token 走 REST，否則走 wrangler）
 *   node cloud/scripts/kv-to-data.js --rest      強制用 REST API
 *   node cloud/scripts/kv-to-data.js --wr   　   強制用 wrangler
 *   node cloud/scripts/kv-to-data.js --local     用 wrangler 讀本機模擬 KV
 *   node cloud/scripts/kv-to-data.js --keep      不清理 data/（保留手動新增的檔案）
 *   node cloud/scripts/kv-to-data.js --with-images  連圖片一起還原成本地檔案
 *
 * 環境變數：
 *   CLOUDFLARE_API_TOKEN   API Token（需 Workers KV Storage Read）
 *   CLOUDFLARE_ACCOUNT_ID  帳號 ID
 *   CF_KV_NAMESPACE_ID     KV namespace ID（未給時自動從 wrangler.toml 讀）
 *   ORG_CODE               機構代碼，預設 sage
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertRemoteKvReady, findWorkingWrangler, EnvError } from './env-utils.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DATA_DIR = join(ROOT, 'data');
const STAFF_DIR = join(DATA_DIR, 'staff');
const TOML = join(ROOT, 'cloud', 'worker', 'wrangler.toml');

const args = process.argv.slice(2);
const IS_LOCAL = args.includes('--local');
const KEEP = args.includes('--keep');
const FORCE_REST = args.includes('--rest');
const FORCE_WRANGLER = args.includes('--wr');

const ORG = process.env.ORG_CODE || 'sage';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';

/* ---------- 從 wrangler.toml 讀 KV namespace id ---------- */
const namespaceIdFromToml = () => {
  if (process.env.CF_KV_NAMESPACE_ID) return process.env.CF_KV_NAMESPACE_ID;
  if (!existsSync(TOML)) return '';
  const lines = readFileSync(TOML, 'utf8').split(/\r?\n/);
  let inKvBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim(); // 去掉註解，避免讀到被註解掉的 binding
    if (!line) continue;
    if (/^\[\[kv_namespaces\]\]/.test(line)) { inKvBlock = true; continue; }
    if (/^\[/.test(line)) { inKvBlock = false; continue; }
    if (inKvBlock && /^id\s*=\s*"([^"]+)"/.test(line)) {
      return line.match(/^id\s*=\s*"([^"]+)"/)[1];
    }
  }
  return '';
};

/* ---------- 模式一：REST API ---------- */
const makeKvGetRest = () => {
  const nsId = namespaceIdFromToml();
  if (!TOKEN) throw new Error('缺少 CLOUDFLARE_API_TOKEN');
  if (!ACCOUNT_ID) throw new Error('缺少 CLOUDFLARE_ACCOUNT_ID');
  if (!nsId) throw new Error('找不到 KV namespace id（請設 CF_KV_NAMESPACE_ID 或確認 wrangler.toml）');

  return async (key) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
      + `/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });

    if (res.status === 404) return null;   // key 不存在，正常情況
    if (res.status === 403) {
      throw new Error(
        'KV 讀取被拒（HTTP 403）— API Token 缺少「Workers KV Storage Read」權限。\n'
        + '    建議用 Cloudflare 的「Edit Cloudflare Workers」範本重建 token，'
        + '該範本會同時包含 Read 與 Write。',
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`KV 讀取失敗（HTTP ${res.status}）：${body.slice(0, 200)}`);
    }
    return res.json();
  };
};

/* ---------- 模式二：wrangler CLI ---------- */
const makeKvGetWrangler = () => {
  const candidates = findWorkingWrangler(ROOT);
  return async (key) => {
    let lastErr;
    for (const WR of candidates) {
      const cmd = [...WR.prefix, 'kv', 'key', 'get', key, '--binding', 'DATA', '--text'];
      // wrangler 4：不指定 --local 時預設讀「本機模擬 KV」，必須明確加 --remote
      cmd.push(IS_LOCAL ? '--local' : '--remote');
      try {
        const out = execFileSync(WR.cmd, cmd, {
          cwd: join(ROOT, 'cloud', 'worker'),
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          shell: process.platform === 'win32',
          maxBuffer: 32 * 1024 * 1024,
        });
        // wrangler 有時會在輸出前後加提示行，取第一個看起來像 JSON 的區塊
        const trimmed = out.trim();
        const start = trimmed.search(/[[{]/);
        if (start === -1) return null;
        return JSON.parse(trimmed.slice(start));
      } catch (e) {
        const msg = String(e.stderr || e.message);
        if (/not found|404|does not exist/i.test(msg)) return null;
        lastErr = e;
        continue;   // 這個 wrangler 壞了，試下一個
      }
    }
    throw lastErr || new Error('找不到可用的 wrangler');
  };
};

/* ---------- 選模式（並檢查前置條件） ---------- */
const useRest = FORCE_REST || (!FORCE_WRANGLER && !IS_LOCAL && !!TOKEN);

try {
  assertRemoteKvReady({ token: TOKEN, accountId: ACCOUNT_ID, local: IS_LOCAL });
} catch (e) {
  if (e instanceof EnvError) {
    console.error('');
    e.lines.forEach((l) => console.error(l));
    console.error('');
    // exit 2 = 環境／憑證問題，與其他失敗區分
    process.exit(2);
  }
  throw e;
}

const kvGet = useRest ? makeKvGetRest() : makeKvGetWrangler();

const MODE_LABEL = useRest
  ? 'REST API（API Token）'
  : `wrangler CLI（${IS_LOCAL ? '本機模擬 KV' : '遠端 KV'}）`;

/** 取出原始 bytes（供圖片還原用）— REST 走 arrayBuffer，wrangler 走 base64 欄位 */
const makeKvGetBytes = () => {
  if (!useRest) return null;
  const nsId = namespaceIdFromToml();
  return async (key) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
      + `/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV 讀取失敗（HTTP ${res.status}）`);
    return Buffer.from(await res.arrayBuffer());
  };
};
const kvGetBytes = makeKvGetBytes();

/* ---------- 主流程 ---------- */
console.log('');
console.log('  SAGE E-Card — 從 KV 同步資料到 data/');
console.log(`  來源：${MODE_LABEL}　機構：${ORG}`);
console.log('');

mkdirSync(STAFF_DIR, { recursive: true });

/* ── 穩定序列化：沿用既有檔案鍵序 ─────────────────────────────
 *
 * 問題：KV 存的是 JSON 字串，回來時鍵序由當初寫入的順序決定，
 *      跟 repo 裡手寫的資料檔往往不同。若照原樣寫檔，
 *       每次自動重建都會產生「只有鍵序不同」的假變更 —— commit 充滿雜訊，
 *       「資料真的變了嗎」也難以判斷。
 *
 * 為什麼不用「固定順序表」硬編每個欄位？
 *       一開始試過，但欄位太多（site、images、custom_links 元素、
 *       qr 的子物件…），漏一個就又是一種假 diff，邊修邊漏，很脆弱。
 *
 * 現在的解法：**以既有檔案的鍵序為準**（stableOrder）。
 *       1. 舊檔有的鍵 → 依舊檔順序排前面
 *       2. 新出現的鍵   → 排在後面，依字母序（穩定、可預期）
 *       3. 舊檔消失的鍵 → 自然不出現
 *       巢狀物件遞迴處理；陣列保持原順序（順序本身有意義）。
 *
 * 這樣「內容不變 → 位元組不變」，且完全不需要維護欄位清單。
 * 唯一影響：首次寫入的新鍵會落在最後，但那只發生一次。           */

const readExistingOrder = (file) => {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // 壞檔就當作沒有，走自然序
  }
};

/** 依 prev 的鍵序重排 cur 的鍵；prev 沒有的鍵排在最後（字母序） */
const stableOrder = (cur, prev) => {
  if (Array.isArray(cur)) {
    /* 陣列保序；但元素是物件的話，用同樣位置的舊元素當鍵序參考 */
    const prevArr = Array.isArray(prev) ? prev : [];
    return cur.map((v, i) => stableOrder(v, prevArr[i]));
  }
  if (cur === null || typeof cur !== 'object') return cur;

  const prevObj = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  const curKeys = Object.keys(cur);
  const prevKeys = Object.keys(prevObj);

  const known = prevKeys.filter((k) => curKeys.includes(k));
  const fresh = curKeys.filter((k) => !prevKeys.includes(k)).sort();

  const out = {};
  for (const k of [...known, ...fresh]) out[k] = stableOrder(cur[k], prevObj[k]);
  return out;
};

/** 寫入 JSON，鍵序盡量沿用既有檔案 */
const writeJsonStable = (file, obj) => {
  const ordered = stableOrder(obj, readExistingOrder(file));
  writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
};

// 1. config
const config = await kvGet(`config:${ORG}`);
if (!config) {
  console.error(`  ✗ KV 裡找不到 config:${ORG}`);
  console.error('    請先執行遷移：node cloud/seed/migrate-local.js');
  process.exit(1);
}
writeJsonStable(join(DATA_DIR, 'config.json'), config);
console.log('  ✓ data/config.json');

/* 1b. 存取暗號（site prefix）
 *
 * 暗號刻意「不存在 repo 裡」—— 它若進了版控，公開 repo 一看就穿，
 * 整層防護白做。所以它只住在 KV，由這裡讀出來交給建置步驟使用。
 *
 * 怎麼交給建置步驟？兩種管道，哪個可用就用哪個：
 *   1. GITHUB_ENV    → GitHub Actions 會把它變成後續步驟的環境變數
 *                      並自動在日誌中遮罩（若已設為 secret）
 *   2. SITE_PREFIX   → 直接匯出（本機執行時沒有 GITHUB_ENV）
 *
 * 寫入哪個 key？優先用獨立的 prefix:{ORG}，
 * 沒有才回頭看 config.site.prefix（相容早期只設在 config 的情況）。
 *
 * 讀不到暗號時「不視為錯誤」—— 本機開發、或機構還沒啟用隱私模式時
 * 本來就沒有暗號。但會印出明顯警語，避免在 CI 靜默產出公開版本。 */
const prefixFromKv =
  (await kvGet(`prefix:${ORG}`)) ||
  (config.site && config.site.prefix) ||
  '';

const prefixValue = typeof prefixFromKv === 'string' ? prefixFromKv.trim() : '';

if (prefixValue) {
  process.env.SITE_PREFIX = prefixValue;
  if (process.env.GITHUB_ENV) {
    /* GitHub Actions：寫進 GITHUB_ENV，後續步驟即可讀到 SITE_PREFIX */
    appendFileSync(process.env.GITHUB_ENV, `SITE_PREFIX=${prefixValue}\n`, 'utf8');
    console.log(`  ✓ 存取暗號已載入（${prefixValue.length} 字元，值不在日誌顯示）`);
  } else {
    console.log(`  ✓ 存取暗號已載入：${prefixValue}`);
  }
} else {
  console.log('  ⚠ KV 沒有設定存取暗號（prefix:' + ORG + '）');
  console.log('    → 建置結果將為「未加密」版本，所有人皆可瀏覽。');
  console.log('    → 正式環境請設定：npx wrangler kv key put --binding=DATA --remote \\');
  console.log('        "prefix:' + ORG + '" "<暗號>"    （在 ecard/cloud/worker 目錄執行）');
}

// 2. 名單
const index = (await kvGet(`index:${ORG}`)) || [];
if (!Array.isArray(index) || !index.length) {
  console.error(`  ✗ KV 裡找不到名片名單（index:${ORG}）`);
  process.exit(1);
}
console.log(`  ✓ 名單 ${index.length} 筆`);

// 3. 清理舊的 staff 檔案（除非 --keep）
if (!KEEP && existsSync(STAFF_DIR)) {
  for (const f of readdirSync(STAFF_DIR)) {
    if (f.endsWith('.json')) unlinkSync(join(STAFF_DIR, f));
  }
}

// 4. 逐張名片
let ok = 0;
const failed = [];
for (const entry of index) {
  const slug = entry.slug;
  const staff = await kvGet(`staff:${ORG}:${slug}`);
  if (!staff) {
    failed.push(slug);
    continue;
  }
  writeJsonStable(join(STAFF_DIR, `${slug}.json`), staff);
  ok++;
}
console.log(`  ✓ data/staff/*.json — ${ok} 張`);

if (failed.length) {
  console.warn('');
  console.warn(`  ⚠️  以下 ${failed.length} 張名片在 KV 中找不到，已略過：`);
  console.warn(`     ${failed.join(', ')}`);
}

// 5. 圖片
//    前台名片頁直接引用 Worker 的 /img/{slug}/{key} 路徑，所以建置時不需要圖片檔。
//    但若 KV 是以 KV 模式存圖（未綁 R2），本腳本可以順便把圖片還原成本地檔案，
//    方便離線檢視或備份。
const IMG_KEYS = ['banner', 'avatar', 'wechat_qr'];
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

if (args.includes('--with-images')) {
  const IMG_DIR = join(ROOT, 'assets', 'images');
  let imgOk = 0;
  for (const entry of index) {
    const dir = join(IMG_DIR, entry.slug);
    for (const key of IMG_KEYS) {
      for (const ext of IMG_EXTS) {
        const normExt = ext === 'jpeg' ? 'jpg' : ext;
        const kvKey = `img:${ORG}:${entry.slug}:${key}.${normExt}`;

        // REST 模式直接取原始 bytes（KV 圖片是以位元組存的原圖）
        if (kvGetBytes) {
          const bytes = await kvGetBytes(kvKey);
          if (bytes && bytes.length) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${key}.${normExt}`), bytes);
            imgOk++;
          }
          continue;
        }

        // wrangler 模式：圖片在 KV 中是 { contentType, b64 } JSON，不能用 --text 之外的解析
        const rec = await kvGet(kvKey);
        if (rec && rec.b64) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${key}.${normExt}`), Buffer.from(rec.b64, 'base64'));
          imgOk++;
        }
      }
    }
  }
  console.log(`  ✓ assets/images/ — ${imgOk} 張圖片已還原`);
} else {
  console.log('');
  console.log('  圖片不需同步：前台名片頁直接引用 Worker 的 /img/{slug}/{key} 路徑。');
  console.log('  若要把 KV 中的圖片還原成本地檔案，加上 --with-images。');
}

console.log('');
console.log(`  ✅ 同步完成：${ok} 張名片。`);
console.log('');
