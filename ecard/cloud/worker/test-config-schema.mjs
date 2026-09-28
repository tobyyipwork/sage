/**
 * config-schema.js 單元測試
 *
 * 驗證機構設定正規化的行為，特別是「不可被前端誤傷」的唯讀欄位，
 * 以及漏送欄位時必須沿用現值（合併語意）。
 *
 * 執行： node test-config-schema.mjs
 */

import { sanitizeConfig, isHttpUrl, EDITABLE_FIELDS, READONLY_FIELDS } from './src/config-schema.js';

let pass = 0;
let fail = 0;

const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
};

const throws = (name, fn, statusWanted) => {
  try {
    fn();
    fail++; console.log(`  ✗ ${name}（應該拋錯但沒有）`);
  } catch (e) {
    if (statusWanted && e.status !== statusWanted) {
      fail++; console.log(`  ✗ ${name}（狀態碼應為 ${statusWanted}，實際 ${e.status}）`);
    } else {
      pass++; console.log(`  ✓ ${name}`);
    }
  }
};

/** 深層相等（不受物件鍵順序影響） */
const deepEq = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && deepEq(a[k], b[k]));
};

/* ---------- 測試用基礎 config ---------- */
const base = () => ({
  org_code: 'sage',
  org: { zh: '香港耆康老人福利會', cn: '香港耆康老人福利会', en: 'The Hong Kong Society for the Aged' },
  org_site: 'https://www.sage.org.hk',
  about: { zh: '簡介', cn: '简介', en: 'About' },
  address: { zh: '香港北角', cn: '香港北角', en: 'North Point, Hong Kong' },
  site: {
    url: 'https://tobyyipwork.github.io',
    basePath: '/sage/ecard/dist',
    copyright: '© 2026 香港耆康老人福利會 版權所有',
    version: '1.2.0',
  },
  qr: {
    enabled: true,
    mode: 'static',
    base: '',
    path: '/r/{org}/{slug}',
    accordion: 1,
    label: { zh: '掃碼開啟名片', cn: '扫码开启名片', en: 'Scan to open card' },
  },
  langs: ['zh', 'cn', 'en'],
  default_lang: 'zh',
});

console.log('\n=== ① 唯讀欄位不可被覆寫 ===');

{
  const out = sanitizeConfig({
    org_code: 'HACKED',
    langs: ['xx'],
    default_lang: 'xx',
    site: { url: 'https://evil.example', basePath: '/evil', version: '9.9.9' },
  }, base());

  ok('org_code 沿用既有值', out.org_code === 'sage');
  ok('langs 沿用既有值', JSON.stringify(out.langs) === JSON.stringify(['zh', 'cn', 'en']));
  ok('default_lang 沿用既有值', out.default_lang === 'zh');
  ok('site.url 沿用既有值', out.site.url === 'https://tobyyipwork.github.io');
  ok('site.basePath 沿用既有值', out.site.basePath === '/sage/ecard/dist');
  ok('site.version 沿用既有值', out.site.version === '1.2.0');
}

console.log('\n=== ② 可編輯欄位正常寫入 ===');

{
  const out = sanitizeConfig({
    org: { zh: '新機構', cn: '新机构', en: 'New Org' },
    org_site: 'https://new.example.org',
    about: { zh: '新簡介', cn: '新简介', en: 'New about' },
    address: { zh: '新地址', cn: '新地址', en: 'New address' },
    site: { copyright: '© 2026 新機構' },
    qr: { label: { zh: '掃我', cn: '扫我', en: 'Scan me' } },
  }, base());

  ok('org.zh 已更新', out.org.zh === '新機構');
  ok('org.en 已更新', out.org.en === 'New Org');
  ok('org_site 已更新', out.org_site === 'https://new.example.org');
  ok('about.zh 已更新', out.about.zh === '新簡介');
  ok('address.en 已更新', out.address.en === 'New address');
  ok('site.copyright 已更新', out.site.copyright === '© 2026 新機構');
  ok('qr.label.zh 已更新', out.qr.label.zh === '掃我');
  ok('qr 其他欄位保留（enabled）', out.qr.enabled === true);
  ok('qr 其他欄位保留（path）', out.qr.path === '/r/{org}/{slug}');
}

console.log('\n=== ③ 合併語意：漏送的欄位沿用現值 ===');

{
  // 只送 org，其他完全不送
  const out = sanitizeConfig({ org: { zh: '只改這個', cn: '只改这个', en: 'Only this' } }, base());

  ok('未送的 about 沿用現值', out.about.zh === '簡介');
  ok('未送的 address 沿用現值', out.address.zh === '香港北角');
  ok('未送的 org_site 沿用現值', out.org_site === 'https://www.sage.org.hk');
  ok('未送的 site.copyright 沿用現值', out.site.copyright.includes('版權所有'));
  ok('未送的 qr.label 沿用現值', out.qr.label.zh === '掃碼開啟名片');
}

console.log('\n=== ④ 空物件不應清空任何既有值 ===');

{
  const before = base();
  const out = sanitizeConfig({}, before);

  ok('org 不變', deepEq(out.org, before.org));
  ok('about 不變', deepEq(out.about, before.about));
  ok('address 不變', deepEq(out.address, before.address));
  ok('site 不變', deepEq(out.site, before.site));
  ok('qr 不變', deepEq(out.qr, before.qr));
}

console.log('\n=== ⑤ 機構名稱不可為空（三語必填）===');

{
  throws('org.zh 空字串且無舊值 → 400', () =>
    sanitizeConfig({ org: { zh: '', cn: 'x', en: 'x' } }, { ...base(), org: {} }), 400);

  throws('org 完全缺該語言且無舊值 → 400', () =>
    sanitizeConfig({ org: { zh: '有值' } }, { ...base(), org: { zh: '舊' } }), 400);
}

{
  // 有舊值時，空字串應沿用舊值（避免編輯時誤清空）
  const out = sanitizeConfig({ org: { zh: '', cn: '', en: '' } }, base());
  ok('org 空字串時沿用舊值', out.org.zh === '香港耆康老人福利會');
}

console.log('\n=== ⑥ 簡介與地址允許留空 ===');

{
  const out = sanitizeConfig({ about: { zh: '', cn: '', en: '' }, address: { zh: '', cn: '', en: '' } }, base());
  ok('about 可清空', out.about.zh === '');
  ok('address 可清空', out.address.zh === '');
}

console.log('\n=== ⑦ URL 驗證 ===');

{
  ok('https 合法', isHttpUrl('https://example.org'));
  ok('http 合法', isHttpUrl('http://example.org'));
  ok('無協定不合法', !isHttpUrl('example.org'));
  ok('javascript: 不合法', !isHttpUrl('javascript:alert(1)'));
  ok('data: 不合法', !isHttpUrl('data:text/html,x'));
  ok('空字串不合法', !isHttpUrl(''));

  throws('org_site 非法 URL → 400', () =>
    sanitizeConfig({ org_site: 'javascript:alert(1)' }, base()), 400);

  // 空字串代表「不要網站」，應被允許
  const out = sanitizeConfig({ org_site: '' }, base());
  ok('org_site 可清空', out.org_site === '');
}

console.log('\n=== ⑧ 長度上限 ===');

{
  const long = 'x'.repeat(5000);
  const out = sanitizeConfig({ about: { zh: long, cn: 'x', en: 'x' } }, base());
  ok('about 被截斷至 2000', out.about.zh.length === 2000);

  const longOrg = 'y'.repeat(500);
  const out2 = sanitizeConfig({ org: { zh: longOrg, cn: 'x', en: 'x' } }, base());
  ok('org 被截斷至 200', out2.org.zh.length === 200);
}

console.log('\n=== ⑨ 邊界與防禦 ===');

{
  const out = sanitizeConfig(null, base());
  ok('input 為 null → 全部沿用現值', out.org.zh === '香港耆康老人福利會');

  const out2 = sanitizeConfig('not an object', base());
  ok('input 為字串 → 全部沿用現值', out2.org.zh === '香港耆康老人福利會');

  throws('existing 缺失 → 404', () => sanitizeConfig({ org: { zh: 'x' } }, null), 404);
  throws('existing 為 null → 404', () => sanitizeConfig({ org: { zh: 'x' } }, null), 404);
}

{
  // 未知欄位不應被寫入
  const out = sanitizeConfig({ evil_field: 'x', org: { zh: 'a', cn: 'b', en: 'c' } }, base());
  ok('未知欄位不寫入', out.evil_field === undefined);
}

{
  // 既有但未知的欄位應被保留（向前相容）
  const withExtra = { ...base(), future_field: 'keep-me' };
  const out = sanitizeConfig({ org: { zh: 'a', cn: 'b', en: 'c' } }, withExtra);
  ok('既有未知欄位保留', out.future_field === 'keep-me');
}

{
  // 型別錯誤：org 傳陣列
  const out = sanitizeConfig({ org: ['x'] }, base());
  ok('org 型別錯誤時沿用現值', out.org.zh === '香港耆康老人福利會');
}

console.log('\n=== ⑩ 欄位清單一致性 ===');

{
  ok('EDITABLE_FIELDS 非空', EDITABLE_FIELDS.length > 0);
  ok('READONLY_FIELDS 非空', READONLY_FIELDS.length > 0);
  ok('兩清單無重疊', !EDITABLE_FIELDS.some((f) => READONLY_FIELDS.includes(f)));
  ok('org_code 在唯讀清單', READONLY_FIELDS.includes('org_code'));
  ok('org 在可編輯清單', EDITABLE_FIELDS.includes('org'));
}

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項\n`);
process.exit(fail === 0 ? 0 : 1);
