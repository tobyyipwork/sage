#!/usr/bin/env node
/**
 * SAGE E-Card Cloud — 名片地址（分部）測試
 *
 * 機構有多個分部時，同一機構底下不同同事可能在不同地址上班。
 * 因此名片層級允許 address 覆寫機構層級的 config.address。
 *
 * 這裡只驗證 staff-schema.js 的正規化行為（後端唯一入口）。
 * 前台「留空則回落機構地址」的渲染邏輯由 build/build.js 負責，
 * 屬建置層，不在本檔範圍。
 *
 * 用法： node cloud/worker/test-staff-address.mjs
 */

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

/* JSON.stringify 對鍵序敏感，比對物件要用不打亂順序的深比 */
const deepEq = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEq(a[k], b[k]));
};

const base = {
  slug: 'chan-tai-man',
  name: { zh: '陳大文', cn: '陈大文', en: 'Chan Tai Man' },
  title: { zh: '示範用戶', cn: '示范用户', en: 'Demo User' },
};

const fresh = (extra = {}) =>
  sanitizeStaff({ ...base, ...extra }, { isNew: true, existing: null, nextId: 'st_001' });

/* ---------- ① 未提供 address ---------- */
section('① 未提供 address');
{
  const s = fresh();
  check('未提供 address 時不產生該欄位', !('address' in s), JSON.stringify(Object.keys(s)));
  check('不影響其他欄位', s.slug === 'chan-tai-man' && s.name.zh === '陳大文');
}

/* ---------- ② 三語齊全 ---------- */
section('② 三語齊全的 address');
{
  const s = fresh({
    address: {
      zh: '九龍旺角彌敦道700號10樓',
      cn: '九龙旺角弥敦道700号10楼',
      en: '10/F, 700 Nathan Road, Mong Kok',
    },
  });
  check(
    '三語 address 原樣保留',
    deepEq(s.address, {
      zh: '九龍旺角彌敦道700號10樓',
      cn: '九龙旺角弥敦道700号10楼',
      en: '10/F, 700 Nathan Road, Mong Kok',
    }),
    JSON.stringify(s.address)
  );
}

/* ---------- ③ 只有部分語言 ---------- */
section('③ 只有部分語言的 address');
{
  const s = fresh({ address: { zh: '只在繁中填寫的分部地址' } });
  check('只填 zh 仍保留 address', !!s.address && s.address.zh === '只在繁中填寫的分部地址');
  check('未填的 cn 補為空字串（交建置層回落機構地址）', s.address.cn === '');
  check('未填的 en 補為空字串', s.address.en === '');
}

/* ---------- ④ 三語皆空 → 整個欄位移除 ---------- */
section('④ 三語皆空');
{
  const s = fresh({ address: { zh: '', cn: '', en: '' } });
  check('三語皆空時整個 address 欄位被移除', !('address' in s), JSON.stringify(Object.keys(s)));
}
{
  const s = fresh({ address: { zh: '   ', cn: '  ', en: '\t' } });
  check('只有空白字元視同空 → 欄位移除', !('address' in s));
}

/* ---------- ⑤ 型別異常的容錯 ---------- */
section('⑤ 型別異常容錯');
{
  const s = fresh({ address: '這不是物件' });
  check('address 為字串時視為空 → 欄位移除', !('address' in s));
}
{
  const s = fresh({ address: null });
  check('address 為 null 時視為空 → 欄位移除', !('address' in s));
}
{
  const s = fresh({ address: { zh: 12345, cn: true, en: {} } });
  check('非字串值被轉成字串', !!s.address && s.address.zh === '12345', JSON.stringify(s.address));
}

/* ---------- ⑥ 字串前後空白會被修剪 ---------- */
section('⑥ 空白修剪');
{
  const s = fresh({ address: { zh: '  香港北角百福道21號  ', cn: '', en: '' } });
  check('前後空白被修剪', s.address.zh === '香港北角百福道21號', JSON.stringify(s.address.zh));
}

/* ---------- ⑦ 編輯既有名片 ---------- */
section('⑦ 編輯既有名片');
{
  const existing = fresh({ address: { zh: '舊分部地址', cn: '旧分部地址', en: 'Old Branch' } });
  const updated = sanitizeStaff(
    { ...base, address: { zh: '新分部地址', cn: '', en: '' } },
    { isNew: false, existing, nextId: null }
  );
  check('可覆寫既有 address', updated.address.zh === '新分部地址', JSON.stringify(updated.address));
  check('清空的語言真的被清空（不是沿用舊值）', updated.address.cn === '');
  check('existing 的其他欄位仍保留', updated.images && updated.images.avatar === '');
}
{
  const existing = fresh({ address: { zh: '舊分部地址', cn: '', en: '' } });
  const cleared = sanitizeStaff({ ...base }, { isNew: false, existing, nextId: null });
  check('送出時完全不帶 address → 清回機構地址', !('address' in cleared), JSON.stringify(cleared.address));
}

/* ---------- ⑧ 與 images 互不干擾 ---------- */
section('⑧ 與 images 互不干擾');
{
  const s = fresh({ address: { zh: '分部地址', cn: '', en: '' } });
  check('images 仍初始化為三個空旗標', deepEq(s.images, { banner: '', avatar: '', wechat_qr: '' }));
  check('wechat_qr 欄位仍存在（後端未移除支援）', 'wechat_qr' in s.images);
}

/* ---------------- 輸出 ---------------- */
console.log(results.join('\n'));
console.log('\n' + '─'.repeat(60));
console.log(
  `  通過 \x1b[32m${pass}\x1b[0m 項，失敗 ${fail ? '\x1b[31m' : ''}${fail}\x1b[0m 項`
);
console.log('─'.repeat(60) + '\n');

process.exit(fail ? 1 : 0);
