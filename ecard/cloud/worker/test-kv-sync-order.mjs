#!/usr/bin/env node
/**
 * SAGE E-Card Cloud — kv-to-data.js 鍵序穩定化測試
 *
 * 背景：KV 回傳的 JSON 鍵序由當初寫入順序決定，跟 repo 裡手寫的資料檔不同。
 * 若照原樣寫檔，每次自動重建都會產生「只有鍵序不同」的假 diff，
 * 讓 commit 充滿雜訊，也讓「資料真的變了嗎」難以判斷。
 *
 * 解法：stableOrder(cur, prev) —— 以既有檔案（prev）的鍵序為準，
 *      舊鍵保留原順序，新鍵排在最後（字母序），巢狀遞迴，陣列保序。
 *      這樣內容不變 → 位元組不變，且不需維護任何欄位清單。
 *
 * 用法： node cloud/worker/test-kv-sync-order.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* kv-to-data.js 是 CLI 腳本（頂層有 await 與 process.exit），不能直接 import，
   所以抽出 stableOrder 的原始碼再 eval —— 測的是「同一份」程式碼。 */
const SRC = resolve(import.meta.dirname, '..', 'scripts', 'kv-to-data.js');
const src = readFileSync(SRC, 'utf8');

const grabFn = (name) => {
  const s = src.indexOf(`const ${name} = `);
  if (s < 0) throw new Error(`找不到 ${name}`);
  const b = s + `const ${name} = `.length;
  const e = src.indexOf('\n};', b);
  return (e < 0 ? src.slice(b) : src.slice(b, e + 3)).replace(/;\s*$/, '');
};
const stableOrder = eval(grabFn('stableOrder'));

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
const keys = (o) => Object.keys(o).join(',');

/* ---------- ① 舊鍵保留原順序 ---------- */
section('① 舊鍵順序保留');
{
  const prev = { id: 1, slug: 's', name: {}, active: true };
  const cur = { active: true, name: {}, slug: 's', id: 1 }; // 亂序
  check('依 prev 的順序重排', keys(stableOrder(cur, prev)) === 'id,slug,name,active', keys(stableOrder(cur, prev)));
}

/* ---------- ② 新鍵排在最後（字母序） ---------- */
section('② 新鍵殿後');
{
  const prev = { b: 1, a: 2 };
  const cur = { a: 2, b: 1, z: 3, m: 4 };
  check('新鍵依字母序排最後', keys(stableOrder(cur, prev)) === 'b,a,m,z', keys(stableOrder(cur, prev)));
}

/* ---------- ③ 舊檔案沒有的鍵不強行保留 ---------- */
section('③ 刪除的鍵不復活');
{
  const prev = { a: 1, b: 2, c: 3 };
  const cur = { a: 1, c: 3 }; // b 被刪了
  check('prev 有但 cur 沒有的鍵不會出現', keys(stableOrder(cur, prev)) === 'a,c', keys(stableOrder(cur, prev)));
}

/* ---------- ④ 巢狀物件遞迴 ---------- */
section('④ 巢狀遞迴');
{
  const prev = { name: { zh: 'Z', cn: 'C', en: 'E' }, site: { url: 'u', version: 'v' } };
  const cur = { site: { version: 'v', url: 'u' }, name: { en: 'E', zh: 'Z', cn: 'C' } };
  const out = stableOrder(cur, prev);
  check('頂層依 prev 順序', keys(out) === 'name,site', keys(out));
  check('name 內部依 prev（zh,cn,en）', keys(out.name) === 'zh,cn,en', keys(out.name));
  check('site 內部依 prev（url,version）', keys(out.site) === 'url,version', keys(out.site));
}

/* ---------- ⑤ 陣列保序 ---------- */
section('⑤ 陣列保序');
{
  const prev = {
    custom_links: [
      { title: {}, url: 'c', icon: 'globe', color: '#1' },
      { title: {}, url: 'a', icon: 'globe', color: '#2' },
    ],
  };
  const cur = {
    custom_links: [
      { color: '#1', icon: 'globe', url: 'c', title: {} },
      { color: '#2', icon: 'globe', url: 'a', title: {} },
    ],
  };
  const out = stableOrder(cur, prev);
  check('陣列元素順序不變', out.custom_links.map((l) => l.url).join(',') === 'c,a', out.custom_links.map((l) => l.url).join(','));
  check('元素內部依 prev（title,url,icon,color）', keys(out.custom_links[0]) === 'title,url,icon,color', keys(out.custom_links[0]));
}
{
  check('空陣列保持空', JSON.stringify(stableOrder([], [])) === '[]');
  check('純量陣列保序', JSON.stringify(stableOrder([3, 1, 2], [1, 2, 3])) === '[3,1,2]');
}

/* ---------- ⑥ prev 缺失／異常時的容錯 ---------- */
section('⑥ 無 prev 的容錯');
{
  const cur = { z: 1, a: 2, m: 3 };
  check('prev 為 null 時新鍵依字母序', keys(stableOrder(cur, null)) === 'a,m,z', keys(stableOrder(cur, null)));
  check('prev 為 undefined 時同樣可用', keys(stableOrder(cur, undefined)) === 'a,m,z');
  check('prev 是陣列（型別不符）時視為無 prev', keys(stableOrder(cur, [1, 2])) === 'a,m,z');
  check('prev 是字串時視為無 prev', keys(stableOrder(cur, 'x')) === 'a,m,z');
}

/* ---------- ⑦ 值完全不被改變 ---------- */
section('⑦ 值不變');
{
  const prev = { slug: 's', active: false, images: { banner: '', avatar: '' } };
  const cur = { images: { avatar: '', banner: '' }, active: false, slug: 's' };
  const out = stableOrder(cur, prev);
  check('false 保持 false', out.active === false);
  check('空字串保持空字串', out.images.banner === '' && out.images.avatar === '');
  check('巢狀物件鍵序依 prev', keys(out.images) === 'banner,avatar', keys(out.images));
}
{
  const prev = { a: 1, b: { x: 1, y: 2 } };
  const cur = { a: 1, b: { x: 1, y: 2 }, c: null };
  const out = stableOrder(cur, prev);
  check('null 值保留', out.c === null);
  check('數字 0 保留', stableOrder({ n: 0 }, { n: 1 }).n === 0);
}

/* ---------- ⑧ 冪等性 ---------- */
section('⑧ 冪等性');
{
  const prev = { id: 1, slug: 's', nested: { zh: 'a', en: 'b', cn: 'c' }, list: [{ u: 1, t: 2 }] };
  const cur = { list: [{ t: 2, u: 1 }], nested: { cn: 'c', en: 'b', zh: 'a' }, slug: 's', id: 1 };
  const once = stableOrder(cur, prev);
  const twice = stableOrder(once, prev);
  check('排序兩次結果相同', JSON.stringify(once) === JSON.stringify(twice));
}
{
  // 真實情境：第一次同步後，之後的同步應完全穩定
  const file = { z: 1, a: 2 };
  const kvData = { a: 2, z: 1 };
  const first = stableOrder(kvData, file);
  const second = stableOrder(kvData, first); // 以第一次結果為 prev
  check('第二次同步不再變動', JSON.stringify(first) === JSON.stringify(second));
}

/* ---------- ⑨ 邊界情況 ---------- */
section('⑨ 邊界情況');
{
  check('null 回傳 null', stableOrder(null, { a: 1 }) === null);
  check('字串原樣回傳', stableOrder('abc', {}) === 'abc');
  check('數字原樣回傳', stableOrder(42, {}) === 42);
  check('空物件回傳空物件', JSON.stringify(stableOrder({}, { a: 1 })) === '{}');
  check('布林原樣回傳', stableOrder(true, {}) === true);
}

/* ---------------- 輸出 ---------------- */
console.log(results.join('\n'));
console.log('\n' + '─'.repeat(60));
console.log(`  通過 \x1b[32m${pass}\x1b[0m 項，失敗 ${fail ? '\x1b[31m' : ''}${fail}\x1b[0m 項`);
console.log('─'.repeat(60) + '\n');
process.exit(fail ? 1 : 0);
