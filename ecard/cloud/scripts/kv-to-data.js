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

import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
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

// 1. config
const config = await kvGet(`config:${ORG}`);
if (!config) {
  console.error(`  ✗ KV 裡找不到 config:${ORG}`);
  console.error('    請先執行遷移：node cloud/seed/migrate-local.js');
  process.exit(1);
}
writeFileSync(join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('  ✓ data/config.json');

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
  writeFileSync(join(STAFF_DIR, `${slug}.json`), JSON.stringify(staff, null, 2) + '\n', 'utf8');
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
