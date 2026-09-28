/**
 * 後台卡片「完整前台網址」（cardUrl）驗證。
 *
 * 為什麼要測？
 *   後台卡片原本只顯示 /slug/ 相對片段，無法直接點開或複製 ——
 *   要預覽得自己拼上網域與 basePath，很容易拼錯。
 *   現在顯示完整網址，而這個網址【必須與前台實際路徑一字不差】，
 *   否則點了會 404。這種「看起來對但差一個斜線」的錯最難察覺。
 *
 * 測法上的關鍵：
 *   後台是單一 HTML 檔、script 內嵌，無法 import。
 *   所以這裡【從檔案抽出 cardUrl 的原始碼片段】，在 vm 裡配上假的
 *   CONFIG 執行。測的是檔案裡那一份真實的程式碼，不是複製品 ——
 *   若只把邏輯抄過來測，程式改壞了測試還是綠的，等於沒測。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');           // worker/ -> cloud/ -> ecard/
const ADMIN = resolve(ROOT, 'admin', 'public', 'index.html');
const BUILD = resolve(ROOT, 'build', 'build.js');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg));

/* ---------- 從後台 HTML 抽出 cardUrl 的真實原始碼 ---------- */
const html = readFileSync(ADMIN, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('  ✗ 找不到後台 <script>');
  process.exit(1);
}
const js = scriptMatch[1];

/* 抓 `const cardUrl = (...) => { ... };` 這段（含多行註解）。
   用「到下一個行首 const/function 為止」界定，避免誤截。 */
const fnMatch = js.match(/(const cardUrl\s*=[\s\S]*?)\n(?=(?:const|function|let)\s)/);
if (!fnMatch) {
  console.error('  ✗ 找不到 cardUrl 定義（改名了？本測試需同步調整）');
  process.exit(1);
}
const cardUrlSrc = fnMatch[1].trim();

console.log('\n=== 後台卡片完整網址（cardUrl）驗證 ===\n');
check(cardUrlSrc.includes('CONFIG'), '成功抽出 cardUrl 真實原始碼（含 CONFIG 依賴）');

/* 在 vm 裡建立可調控的 CONFIG，載入真實的 cardUrl */
const makeCardUrl = (config) => {
  const ctx = { CONFIG: config, String, RegExp };
  vm.createContext(ctx);
  vm.runInContext(`${cardUrlSrc}\n; __result = cardUrl;`, ctx, { filename: 'cardUrl-from-admin.js' });
  return ctx.__result;
};

const realConfig = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'));

/* ---------- 1. 與 build.js 的 staffUrl 逐字比對 ----------
 * 這是本測試最重要的一項：兩邊用同一組 config、同樣的規則，
 * 產出的網址必須【一字不差】。 */
{
  /* 從 build.js 取真實的 staffUrl 結果：它匯出 build，但 staffUrl 未匯出，
     所以這裡按 build.js 的規則獨立算出「基準」，
     並用 build.js 實際產出的檔案來交叉驗證（見第 2 節）。 */
  const BASE_PATH = (realConfig.site.basePath || '').replace(/\/+$/, '');
  const SITE_URL = String(realConfig.site.url).replace(/\/+$/, '');
  const DEF = realConfig.default_lang || 'zh';
  const refStaffUrl = (slug, lang) =>
    `${SITE_URL}${lang === DEF ? `${BASE_PATH}/${slug}/` : `${BASE_PATH}/${slug}/${lang}/`}`;

  const cf = makeCardUrl(realConfig);
  const slugs = ['chan-tai-man', 'lee-siu-wah', 'wong-kam-fai', 'cheung-mei-ling'];
  const langs = [undefined, 'zh', 'cn', 'en'];

  let mismatches = [];
  for (const s of slugs) {
    for (const l of langs) {
      const a = cf(s, l);
      /* 未指定語言 = 預設語言 */
      const expect = refStaffUrl(s, l || DEF);
      if (a !== expect) mismatches.push(`${s}/${l || '(預設)'}\n        得 ${a}\n        期 ${expect}`);
    }
  }
  check(mismatches.length === 0, `16 組（4 人 × 4 語言）與 build.js 規則完全一致`, `不一致：\n      ${mismatches.join('\n      ')}`);
}

/* ---------- 2. 與 build.js 實際產出的檔案交叉驗證 ----------
 * 上面第 1 節用的是「按規則重算」的基準，仍有循環論證的風險。
 * 這裡改抓 build.js 真正寫出的 HTML 裡的 canonical，
 * 兩者比對才是獨立證據。 */
{
  const fs = await import('node:fs');
  const distIdx = resolve(ROOT, 'dist', 'chan-tai-man', 'index.html');
  if (!fs.existsSync(distIdx)) {
    bad('找不到 dist/chan-tai-man/index.html（請先跑 build）');
  } else {
    const canonical = (readFileSync(distIdx, 'utf8').match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    const cf = makeCardUrl(realConfig);
    check(
      canonical === cf('chan-tai-man'),
      '與前台實際產出的 canonical 完全一致（獨立證據）',
      `前台 canonical=${canonical}，後台卡片=${cf('chan-tai-man')}`
    );
  }
}

/* ---------- 3. 網址形態 ---------- */
{
  const cf = makeCardUrl(realConfig);
  const u = cf('chan-tai-man');
  check(/^https:\/\/tobyyipwork\.github\.io\/sage\/ecard\/dist\/chan-tai-man\/$/.test(u), '產出完整絕對網址（含網域 + basePath + slug + 尾斜線）', `實際：${u}`);
  check(!u.includes('//', u.indexOf('://') + 3), '不含多餘的雙斜線', `實際：${u}`);
  check(u.endsWith('/'), '以斜線結尾（GitHub Pages 目錄索引需要）', `實際：${u}`);
}

/* ---------- 4. 尾斜線收斂（設定常有尾斜線） ---------- */
{
  const variants = [
    ['url 無尾斜線 / basePath 無尾斜線', { url: 'https://a.github.io', basePath: '/sage/ecard/dist' }],
    ['url 有尾斜線', { url: 'https://a.github.io/', basePath: '/sage/ecard/dist' }],
    ['basePath 有尾斜線', { url: 'https://a.github.io', basePath: '/sage/ecard/dist/' }],
    ['兩者皆有尾斜線', { url: 'https://a.github.io/', basePath: '/sage/ecard/dist/' }],
  ];
  const outs = variants.map(([name, site]) => {
    const cf = makeCardUrl({ ...realConfig, site: { ...realConfig.site, ...site } });
    const u = cf('chan-tai-man');
    const good = u === 'https://a.github.io/sage/ecard/dist/chan-tai-man/';
    return { name, u, good };
  });
  const bads = outs.filter((o) => !o.good);
  check(bads.length === 0, '4 種尾斜線組合都收斂成同一結果', bads.map((o) => `${o.name} → ${o.u}`).join('；'));
}

/* ---------- 5. 設定缺少時退化得當 ----------
 * 寧可回空字串（呼叫端就不顯示），也不要顯示半截的錯誤網址。 */
{
  const cases = [
    ['site.url 缺失', { ...realConfig, site: { basePath: '/x' } }],
    ['site 整個缺失', { ...realConfig, site: undefined }],
    ['CONFIG 為空', {}],
  ];
  const bads = cases.filter(([, cfg]) => makeCardUrl(cfg)('chan-tai-man') !== '');
  check(bads.length === 0, '設定不完整時回空字串（不顯示半截網址）', bads.map(([n]) => n).join('；'));
}

/* ---------- 6. 只接受 http(s) ----------
 * 網址會被放進 href。若 site.url 是 javascript: 之類的偽協議，
 * 點擊就會執行 —— 這裡確認有做白名單。 */
{
  const bads = ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'ftp://x.com', '//evil.com']
    .map((url) => ({ url, out: makeCardUrl({ ...realConfig, site: { ...realConfig.site, url } })('chan-tai-man') }))
    .filter((r) => r.out !== '');
  check(bads.length === 0, '非 http(s) 協議一律回空字串（不進 href）', bads.map((r) => `${r.url} → ${r.out}`).join('；'));
  check(
    makeCardUrl({ ...realConfig, site: { ...realConfig.site, url: 'http://localhost:8080' } })('chan-tai-man').startsWith('http://'),
    '接受 http://（本機測試用）'
  );
}

/* ---------- 7. 卡片渲染真的有把網址放上去 ----------
 * 純函式對不代表卡片有用它。檢查 renderList 的實際輸出模板。
 *
 * ⚠️ 這裡不能只檢查「出現了 target= / rel= 這些字樣」——
 *    那些字串就算 href 寫死 "#" 也還在。
 *    必須實際把模板渲染一次，驗證 href 真的指向 cardUrl 的結果。
 *    （這個漏洞是靠突變測試發現的：把 esc(url) 改成 "#" 竟然全綠。） */
{
  const listSrc = (js.match(/function renderList\(\)\{[\s\S]*?\n\}/) || [''])[0];
  check(listSrc.includes('cardUrl('), 'renderList 真的有呼叫 cardUrl');
  check(/class="url"/.test(listSrc), '卡片模板含 .url 元素');
  check(/url\s*\?[\s\S]*?:/.test(listSrc), '有完整網址與退路的二分支處理');

  /* 實際渲染模板：抽出 renderList 裡【真實的】urlRow 定義與 HTML 模板，
     餵入假的 s / url，看產出的 href 是不是真的等於那個 url。
     重點：urlRow 也從檔案抽，不自己重寫 —— 否則測的是複製品。 */
  const urlRowSrc = (listSrc.match(/(const urlRow\s*=[\s\S]*?);\s*\n/) || [])[1];
  const tplSrc = (listSrc.match(/div\.innerHTML\s*=\s*`([\s\S]*?)`;/) || [])[1];
  if (!urlRowSrc || !tplSrc) {
    bad(`無法抽出卡片模板（urlRow=${!!urlRowSrc} template=${!!tplSrc}）—— 本測試需同步調整`);
  } else {
    const renderCard = (s, url) => {
      const ctx = {
        s, url, av: '',
        esc: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        cardUrl: () => url,
      };
      vm.createContext(ctx);
      vm.runInContext(`${urlRowSrc}\n; __row = urlRow;`, ctx, { filename: 'urlRow-from-admin.js' });
      ctx.urlRow = ctx.__row;
      return vm.runInContext('`' + tplSrc + '`', ctx);
    };

    const U = 'https://tobyyipwork.github.io/sage/ecard/dist/chan-tai-man/';
    const out = renderCard({ slug: 'chan-tai-man', active: true, name: { zh: '陳大文' }, title: { zh: '示範' } }, U);

    check(new RegExp(`<a\\s+href="${U.replace(/[/.]/g, '\\$&')}"`).test(out), '渲染後 href 真的等於 cardUrl 的結果', `實際 HTML：${(out.match(/<a[^>]*>/) || ['(無 a 標籤)'])[0]}`);
    check(/target="_blank"/.test(out), '渲染後帶 target="_blank"（另開新分頁）');
    check(/rel="noopener"/.test(out), '渲染後帶 rel="noopener"（安全）');
    check(out.includes(`>${U}</a>`), '連結文字就是完整網址（可選取複製）');

    /* 轉義：網址含 & 時必須被 esc 處理（HTML 屬性安全） */
    const outAmp = renderCard({ slug: 'x', active: true, name: { zh: 'A' }, title: { zh: '' } }, 'https://a.io/p?a=1&b=2');
    check(outAmp.includes('&amp;') && !/href="[^"]*[^m];?a=1&b=2"/.test(outAmp), 'href 內的 & 經 esc 轉義');

    /* 退路：url 為空時不該產生 <a href="">，而應顯示 /slug/ */
    const outEmpty = renderCard({ slug: 'foo-bar', active: false, name: { zh: 'X' }, title: { zh: '' } }, '');
    check(!/class="url"/.test(outEmpty), '網址為空時不渲染 .url 區塊');
    check(outEmpty.includes('/foo-bar/'), '網址為空時退回顯示 /slug/ 片段');
  }
}

/* ---------- 8. CSS 有對應樣式（否則長網址會撐破卡片） ---------- */
{
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  check(/\.ecard\s+\.url\s*\{/.test(css), 'CSS 有 .ecard .url 樣式');
  check(/word-break\s*:\s*break-all/.test(css), 'CSS 允許長網址換行（word-break: break-all）');
}

console.log(`\n  通過 ${pass} 項，失敗 ${fail} 項\n`);
process.exit(fail ? 1 : 0);
