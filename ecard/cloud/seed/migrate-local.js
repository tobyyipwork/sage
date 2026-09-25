#!/usr/bin/env node
/**
 * 把現有本地 data/ 的資料灌進 Cloudflare KV。
 *
 * 這是「一次性」的遷移工具 —— 讓你把已經做好的名片搬到雲端。
 *
 * 前置：
 *   npm i -g wrangler          （或 npx wrangler）
 *   wrangler login
 *
 * 用法：
 *   node cloud/seed/migrate-local.js --local         寫入本機模擬 KV（不需雲端帳號）
 *   node cloud/seed/migrate-local.js                 寫入遠端 KV（會先確認）
 *   node cloud/seed/migrate-local.js --dry-run       只顯示會做什麼，不實際寫入
 *
 * 資料對應：
 *   data/config.json           →  config:{org}
 *   data/staff/{slug}.json     →  staff:{org}:{slug}
 *   assets/images/{slug}/*     →  R2: {org}/{slug}/{key}.{ext}
 *                                 或 KV: img:{org}:{slug}:{key}.{ext}
 *   另外建立 index:{org} 名單快取
 *
 * 圖片儲存模式由 wrangler.toml 是否綁定 R2 自動判斷：
 *   有 [[r2_buckets]]  → 上傳到 R2
 *   沒有               → 以 base64 寫進 KV（不需綁卡）
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DATA_DIR = join(ROOT, 'data');
const STAFF_DIR = join(DATA_DIR, 'staff');
const IMG_DIR = join(ROOT, 'assets', 'images');
const TOML_FILE = join(ROOT, 'cloud', 'worker', 'wrangler.toml');

const args = process.argv.slice(2);
const IS_LOCAL = args.includes('--local');
const DRY_RUN = args.includes('--dry-run');

const ORG = readConfig()?.org_code || 'sage';
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const IMG_KEYS = ['banner', 'avatar', 'wechat_qr'];

/** 讀 wrangler.toml 判斷是否綁了 R2 */
const detectR2 = () => {
  try {
    const t = readFileSync(TOML_FILE, 'utf8');
    // 只看未被註解的行
    const active = t
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const has = /^\s*\[\[r2_buckets\]\]/m.test(active);
    const bucket = (active.match(/bucket_name\s*=\s*"([^"]+)"/) || [])[1] || 'sage-ecard-images';
    return has ? { enabled: true, bucket } : { enabled: false, bucket: null };
  } catch {
    return { enabled: false, bucket: null };
  }
};

const R2 = detectR2();

const TMP_FILE = join(ROOT, 'cloud', '.tmp-migrate.json');

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/* ---------- wrangler 包裝 ---------- */
/** 優先用本地 node_modules 的 wrangler，其次全域，最後 npx */
const WRANGLER = (() => {
  const local = join(ROOT, 'cloud', 'worker', 'node_modules', '.bin', 'wrangler');
  if (existsSync(local) || existsSync(local + '.cmd')) return { cmd: local, prefix: [] };
  return { cmd: 'npx', prefix: ['wrangler'] };
})();

const run = (cmdArgs) => {
  const full = [...WRANGLER.prefix, ...cmdArgs];
  if (DRY_RUN) {
    console.log(`    [dry-run] ${WRANGLER.prefix.length ? 'npx wrangler' : 'wrangler'} ${cmdArgs.join(' ')}`);
    return '';
  }
  try {
    return execFileSync(WRANGLER.cmd, full, {
      cwd: join(ROOT, 'cloud', 'worker'),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`    ✗ 執行失敗：wrangler ${cmdArgs.join(' ')}`);
    console.error(`      ${e.stderr || e.message}`);
    throw e;
  }
};

const putKv = (key, value) => {
  if (!DRY_RUN) writeFileSync(TMP_FILE, JSON.stringify(value, null, 2), 'utf8');
  const cmd = ['kv', 'key', 'put', key, '--path', TMP_FILE, '--binding', 'DATA'];
  // wrangler 4：不指定 --local 時預設寫「本機模擬 KV」，必須明確加 --remote
  cmd.push(IS_LOCAL ? '--local' : '--remote');
  run(cmd);
};

const putR2 = (key, absFile) => {
  const cmd = ['r2', 'object', 'put', `${R2.bucket}/${key}`, '--file', absFile];
  cmd.push(IS_LOCAL ? '--local' : '--remote');
  run(cmd);
};

/** KV 圖片模式：把檔案讀成 base64 後寫進 KV */
const putKvImage = (kvKey, absFile, ext) => {
  const bytes = readFileSync(absFile);
  const record = {
    contentType: mimeFor(ext),
    b64: bytes.toString('base64'),
  };
  putKv(kvKey, record);
};

const mimeFor = (ext) => {
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return map[String(ext).toLowerCase()] || 'application/octet-stream';
};

/* ---------- 主流程 ---------- */
console.log('');
console.log('  SAGE E-Card — 資料遷移到 Cloudflare');
console.log(`  模式：${IS_LOCAL ? '本機模擬 KV（--local）' : '遠端 KV'}`);
if (DRY_RUN) console.log('  ⚠️  DRY-RUN：不會實際寫入任何資料');
console.log('');
console.log(`  機構代號：${ORG}`);
console.log(`  來源目錄：${DATA_DIR}`);
console.log(`  圖片模式：${R2.enabled ? `R2（bucket: ${R2.bucket}）` : 'KV（未綁 R2，base64 存入 KV）'}`);
console.log('');

// 1. config
const config = readConfig();
if (!config) {
  console.error('  ✗ 找不到 data/config.json，請先確認路徑。');
  process.exit(1);
}
console.log(`  [1/4] 遷移 config → config:${ORG}`);
putKv(`config:${ORG}`, config);
console.log('        ✓');

// 2. staff
const staffFiles = existsSync(STAFF_DIR)
  ? readdirSync(STAFF_DIR).filter((f) => f.endsWith('.json'))
  : [];
console.log(`  [2/4] 遷移 ${staffFiles.length} 張名片`);
const indexEntries = [];
for (const f of staffFiles) {
  const data = JSON.parse(readFileSync(join(STAFF_DIR, f), 'utf8'));
  if (!data.slug) continue;
  putKv(`staff:${ORG}:${data.slug}`, data);
  indexEntries.push({
    slug: data.slug,
    active: data.active !== false,
    name: data.name || {},
    title: data.title || {},
    has_avatar: !!(data.images && data.images.avatar),
  });
  console.log(`        ✓ ${data.slug}`);
}

// 3. index
indexEntries.sort((a, b) => (a.slug < b.slug ? -1 : 1));
console.log(`  [3/4] 建立名單快取 → index:${ORG}`);
putKv(`index:${ORG}`, indexEntries);
console.log(`        ✓ ${indexEntries.length} 筆`);

// 4. meta + 圖片
console.log(`  [4/4] 遷移圖片與 meta`);
putKv(`meta:${ORG}`, {
  count: staffFiles.length,
  updated_at: new Date().toISOString(),
  version: 1,
});
console.log('        ✓ meta');

let imgCount = 0;
for (const entry of indexEntries) {
  const dir = join(IMG_DIR, entry.slug);
  if (!existsSync(dir)) continue;
  for (const key of IMG_KEYS) {
    for (const ext of IMG_EXTS) {
      const abs = join(dir, `${key}.${ext}`);
      if (existsSync(abs)) {
        const normExt = ext === 'jpeg' ? 'jpg' : ext;
        if (R2.enabled) {
          const r2Key = `${ORG}/${entry.slug}/${key}.${normExt}`;
          putR2(r2Key, abs);
          console.log(`        ✓ R2 ${r2Key}`);
        } else {
          const kvKey = `img:${ORG}:${entry.slug}:${key}.${normExt}`;
          putKvImage(kvKey, abs, normExt);
          console.log(`        ✓ KV ${kvKey}`);
        }
        imgCount++;
      }
    }
  }
}
if (!imgCount) console.log('        （沒有圖片需要遷移）');

// 清理暫存
if (!DRY_RUN && existsSync(TMP_FILE)) unlinkSync(TMP_FILE);

console.log('');
console.log(`  ✅ 完成：${staffFiles.length} 張名片、${imgCount} 張圖片已遷移。`);
console.log('');
if (!IS_LOCAL && !DRY_RUN) {
  console.log('  下一步：');
  console.log('    1. 部署 Worker：  cd cloud/worker && wrangler deploy');
  console.log('    2. 開啟後台並在網址加上 ?api=<你的 Worker 網址>');
  console.log('');
}
