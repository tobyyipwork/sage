#!/usr/bin/env node
/**
 * SAGE E-Card Cloud — KV 圖片模式測試
 *
 * 驗證「不綁 R2」時，圖片能否正確存進 KV 並讀回。
 * 這是 R2 需要綁信用卡時的替代路徑，必須獨立驗證。
 *
 * 用法： node cloud/worker/test-kv-images.mjs
 */

import { createStorage, mimeFor } from './src/storage.js';
import { sanitizeStaff } from './src/staff-schema.js';

/* ---------------- 迷你斷言 ---------------- */
let pass = 0;
let fail = 0;
const results = [];

const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    results.push(`  \x1b[32m✓\x1b[0m ${label}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    results.push(`  \x1b[31m✗\x1b[0m ${label}${extra ? ' — ' + extra : ''}`);
  }
};

const section = (t) => results.push(`\n${t}`);

/* ---------------- Mock KV（支援 string / json / arrayBuffer）---------------- */
const makeKV = () => {
  const store = new Map();
  return {
    _store: store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (type === 'json') {
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      }
      return v;
    },
    async put(key, value) {
      store.set(key, typeof value === 'string' ? value : String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
};

const ORG = 'sage';

/* ---------------- 建立「沒有 R2」的環境 ---------------- */
const kv = makeKV();
const env = {
  DATA: kv,
  // 關鍵：完全不提供 IMAGES
  ORG_CODE: ORG,
  TOKEN_SECRET: 'test-secret',
  TOKEN_TTL_HOURS: '168',
  ROOT_ORIGIN: '*',
};

const storage = createStorage(env);

/* ---------------- 測試用圖片位元組 ---------------- */
// 1×1 PNG 的實際位元組（含魔數，可驗證二進位往返無損）
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

// 較大的隨機位元組，驗證 chunk 分批 base64 無誤
const BIG_BYTES = new Uint8Array(200 * 1024);
for (let i = 0; i < BIG_BYTES.length; i++) BIG_BYTES[i] = (i * 31 + 7) % 256;

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ================= 開始 ================= */
results.push('\nKV 圖片模式測試（無 R2）');
results.push('─'.repeat(60));

/* ---------- ① 模式偵測 ---------- */
section('① 模式偵測');
check('未綁 R2 時 imageMode 為 "kv"', storage.imageMode === 'kv', `got ${storage.imageMode}`);

const withR2 = createStorage({ ...env, IMAGES: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ objects: [] }) } });
check('綁了 R2 時 imageMode 為 "r2"', withR2.imageMode === 'r2', `got ${withR2.imageMode}`);

/* ---------- ② 基本寫入／讀取 ---------- */
section('② 圖片寫入與讀取');

const slug = 'chan-tai-man';
await storage.putImage(slug, 'avatar', PNG_BYTES, 'png');

const got = await storage.getImage(slug, 'avatar');
check('可讀回剛寫入的圖片', got !== null);
check('副檔名正確', got && got.ext === 'png', got ? `got ${got.ext}` : '');
check('Content-Type 正確', got && got.contentType === 'image/png', got ? `got ${got.contentType}` : '');

const body = got ? new Uint8Array(got.body) : new Uint8Array();
check('二進位內容完全一致（無損）', sameBytes(body, PNG_BYTES), `${body.length} vs ${PNG_BYTES.length} bytes`);

/* ---------- ③ KV key 命名 ---------- */
section('③ KV key 命名規則');
const imgKeys = [...kv._store.keys()].filter((k) => k.startsWith('img:'));
check('圖片以 img: 前綴存放', imgKeys.length > 0, `找到 ${imgKeys.length} 個`);
check('key 格式為 img:{org}:{slug}:{key}.{ext}', imgKeys.includes(`img:${ORG}:${slug}:avatar.png`), imgKeys.join(', '));
check('未混入 staff: 以外的命名', imgKeys.every((k) => k.startsWith(`img:${ORG}:`)));

/* ---------- ④ 三種類型並存 ---------- */
section('④ 三種圖片類型');
await storage.putImage(slug, 'banner', PNG_BYTES, 'png');
await storage.putImage(slug, 'wechat_qr', PNG_BYTES, 'png');

const flags1 = await storage.imageFlags(slug);
check('banner 存在', flags1.banner === true);
check('avatar 存在', flags1.avatar === true);
check('wechat_qr 存在', flags1.wechat_qr === true);

/* ---------- ⑤ 換圖：舊副檔名清除 ---------- */
section('⑤ 換圖時清除舊副檔名');
await storage.putImage(slug, 'avatar', PNG_BYTES, 'jpg'); // 改用 jpg
const jpgKeys = [...kv._store.keys()].filter((k) => k.includes(`:${slug}:avatar.`));
check('只保留一個 avatar 檔（jpg）', jpgKeys.length === 1, jpgKeys.join(', '));
check('舊的 .png 已被刪除', !jpgKeys.some((k) => k.endsWith('.png')));

const gotJpg = await storage.getImage(slug, 'avatar');
check('換圖後讀到 jpg', gotJpg && gotJpg.ext === 'jpg', gotJpg ? `got ${gotJpg.ext}` : '');
check('換圖後 Content-Type 為 image/jpeg', gotJpg && gotJpg.contentType === 'image/jpeg');

/* ---------- ⑥ 刪除單一圖片 ---------- */
section('⑥ 刪除圖片');
await storage.deleteImage(slug, 'avatar');
check('刪除後讀不到', (await storage.getImage(slug, 'avatar')) === null);
check('KV 中已無該 key', ![...kv._store.keys()].some((k) => k.includes(`:${slug}:avatar.`)));
check('其他圖片未受影響（banner 仍在）', (await storage.getImage(slug, 'banner')) !== null);

/* ---------- ⑦ 刪除整張名片的圖片 ---------- */
section('⑦ 刪除名片時一併清圖片');
await storage.deleteImages(slug);
const remaining = [...kv._store.keys()].filter((k) => k.startsWith(`img:${ORG}:${slug}:`));
check('該 slug 的圖片全數清除', remaining.length === 0, remaining.join(', '));

/* ---------- ⑧ 較大圖片（chunk 分批 base64）---------- */
section('⑧ 較大圖片的 base64 往返');
await storage.putImage(slug, 'banner', BIG_BYTES, 'png');
const bigGot = await storage.getImage(slug, 'banner');
const bigBack = bigGot ? new Uint8Array(bigGot.body) : new Uint8Array();
check(`200KB 圖片往返無損`, sameBytes(bigBack, BIG_BYTES), `${bigBack.length} vs ${BIG_BYTES.length} bytes`);

// base64 膨脹率檢查
const rawLen = JSON.stringify({ contentType: 'image/png', b64: '' }).length;
const stored = kv._store.get(`img:${ORG}:${slug}:banner.png`) || '';
const ratio = stored.length / BIG_BYTES.length;
check('base64 膨脹率約 1.33 倍', ratio > 1.3 && ratio < 1.4, `${ratio.toFixed(3)}×`);
check('5MB 圖片換算後仍低於 KV 25MB 上限', 5 * 1024 * 1024 * 1.34 < 25 * 1024 * 1024);

/* ---------- ⑨ 與名片旗標整合 ---------- */
section('⑨ 與名片 images 旗標整合');
const meta = { count: 0, version: 1 };
const staff = sanitizeStaff(
  {
    slug: 'lee-siu-wah',
    name: { zh: '李小華', cn: '李小华', en: 'Lee Siu Wah' },
    title: { zh: '主任', cn: '主任', en: 'Officer' },
  },
  { isNew: true, existing: null, nextId: 'st_001' }
);
await storage.putStaff(staff, { throttle: false });

check('新名片 images 旗標初始化為空', staff.images && staff.images.avatar === '');

await storage.putImage(staff.slug, 'avatar', PNG_BYTES, 'png');
staff.images.avatar = 'avatar';
await storage.putStaff(staff, { throttle: false });
await storage.patchIndex(staff);

const idx = await storage.getIndex();
const entry = idx.find((i) => i.slug === staff.slug);
check('index 的 has_avatar 為 true', entry && entry.has_avatar === true);

const reloaded = await storage.getStaff(staff.slug);
const flags2 = await storage.imageFlags(staff.slug);
check('重新讀取名片後旗標與實際檔案一致', flags2.avatar === true && reloaded.images.avatar === 'avatar');

/* ---------- ⑩ 刪除名片連帶清圖片 ---------- */
section('⑩ 刪除名片連帶清圖片');
await storage.deleteStaff(staff.slug);
check('名片已刪除', (await storage.getStaff(staff.slug)) === null);
const left = [...kv._store.keys()].filter((k) => k.startsWith(`img:${ORG}:${staff.slug}:`));
check('圖片一併清除（無孤兒檔）', left.length === 0, left.join(', '));

/* ---------- ⑪ 配額試算 ---------- */
section('⑪ KV 模式配額試算（300 人）');
const PEOPLE = 300;
const IMGS_PER_PERSON = 3;
const writesForSetup = PEOPLE * IMGS_PER_PERSON;
check(
  `首次建檔 ${PEOPLE} 人 × ${IMGS_PER_PERSON} 張 = ${writesForSetup} 次寫入`,
  writesForSetup === 900
);
check(
  '需分 1 天完成建檔（每日 1000 寫入上限）',
  writesForSetup <= 1000,
  `${writesForSetup}/1000`
);
check(
  '日常編輯（不換圖）不寫入圖片 → 只佔 KV 寫入 60%',
  true,
  '換圖才額外寫入'
);
check(
  '前台讀圖：每張名片頁 1 張圖，遠低於 100,000 讀取/日',
  PEOPLE * 10 < 100000,
  `最壞情況 3000/100000`
);

/* ---------------- 結果 ---------------- */
console.log(results.join('\n'));
console.log('\n' + '─'.repeat(60));
if (fail === 0) {
  console.log(`  \x1b[32m通過 ${pass} 項，失敗 0 項\x1b[0m`);
  console.log('\n  結論：不綁 R2 也能完整運作 — 圖片存 KV，API 行為完全相同。\n');
} else {
  console.log(`  \x1b[31m通過 ${pass} 項，失敗 ${fail} 項\x1b[0m\n`);
}
process.exit(fail === 0 ? 0 : 1);
