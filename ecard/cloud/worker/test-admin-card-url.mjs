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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg || `未通過：${good}`));

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
  /* 員工清單從 data/staff 動態取得，不寫死 ——
     新增／移除員工時（例如從後台新增）測試會自動涵蓋，
     不需要回來改這個檔案。 */
  const staffDir = resolve(ROOT, 'data', 'staff');
  const slugs = readdirSync(staffDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
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
  check(
    mismatches.length === 0 && slugs.length > 0,
    `${slugs.length} 人 × 4 語言（共 ${slugs.length * 4} 組）與 build.js 規則完全一致`,
    mismatches.length ? `不一致：\n      ${mismatches.join('\n      ')}` : 'data/staff 讀不到任何員工'
  );
}

/* ---------- 2. 與 build.js 實際產出的檔案交叉驗證 ----------
 * 上面第 1 節用的是「按規則重算」的基準，仍有循環論證的風險。
 * 這裡改抓 build.js 真正寫出的 HTML 裡的 canonical，
 * 兩者比對才是獨立證據。 */
{
  const distIdx = resolve(ROOT, 'dist', 'chan-tai-man', 'index.html');
  if (!existsSync(distIdx)) {
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
 *    （這個漏洞是靠突變測試發現的：把 esc(url) 改成 "#" 竟然全綠。）
 *
 * 實作方式：把 renderList 裡【真實的】urlRow、模板，以及 pubState
 * 的原始碼一起抽出來，組成一個可執行的渲染函式。
 * 全部取自檔案，不自己重寫 —— 否則測的是複製品。 */
{
  const listSrc = (js.match(/function renderList\(\)\{[\s\S]*?\n\}/) || [''])[0];
  check(listSrc.includes('cardUrl('), 'renderList 真的有呼叫 cardUrl');
  check(/class="url"/.test(listSrc), '卡片模板含 .url 元素');
  check(/pubState\(/.test(listSrc), 'renderList 真的有呼叫 pubState');

  /* 抽 pubState 與它依賴的 agoText。
     兩者都是 `function name(...){ ... }`，用「行首 } 結尾」界定。
     若日後改成箭頭函式，這裡會抓不到而報錯 —— 那是刻意設計，
     寧可測試自己壞掉，也不要靜默地測一個空字串。 */
  const pubMatch = js.match(/(function pubState\([\s\S]*?\n\})/);
  const agoMatch = js.match(/(function agoText\([\s\S]*?\n\})/);
  if (!pubMatch || !agoMatch) {
    bad(`無法抽出 pubState / agoText（${!!pubMatch} / ${!!agoMatch}）—— 本測試需同步調整`);
    console.log(`\n  通過 ${pass} 項，失敗 ${fail} 項\n`);
    process.exit(1);
  }

  /* 抽 urlRow 與模板。urlRow 現在含巢狀三元（live ? ... : ...），
     用「到下一個 ${ 前的分號」界定，避免被內層分號截斷。 */
  const urlRowSrc = (listSrc.match(/(const urlRow\s*=[\s\S]*?);\s*\n\s*div\.innerHTML/) || [])[1];
  const tplSrc = (listSrc.match(/div\.innerHTML\s*=\s*`([\s\S]*?)`;/) || [])[1];
  if (!urlRowSrc || !tplSrc) {
    bad(`無法抽出卡片模板（urlRow=${!!urlRowSrc} template=${!!tplSrc}）—— 本測試需同步調整`);
  } else {
    const escFn = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    /* 用真實的 pubState / urlRow / 模板渲染一張卡片。
       buildStatus 控制 pubState 的判定；不給就是「狀態未知」。 */
    const renderCard = (s, url, buildStatus) => {
      const ctx = {
        s, url, av: '', esc: escFn, cardUrl: () => url,
        BUILD_STATUS: buildStatus === undefined ? null : buildStatus,
        Date, isFinite, Math,
      };
      vm.createContext(ctx);
      vm.runInContext(
        `${agoMatch[1]}\n${pubMatch[1]}\n; __state = pubState;`,
        ctx, { filename: 'pubState-from-admin.js' }
      );
      ctx.pubState = ctx.__state;
      /* live 必須先定義 —— urlRow 用到它。 */
      vm.runInContext(
        'const ps = pubState(s); const live = ps.cls === "pub-live";',
        ctx, { filename: 'live-flag-from-admin.js' }
      );
      vm.runInContext(`${urlRowSrc};`, ctx, { filename: 'urlRow-from-admin.js' });
      return { html: vm.runInContext('`' + tplSrc + '`', ctx), state: vm.runInContext('ps', ctx) };
    };

    const U = 'https://tobyyipwork.github.io/sage/ecard/dist/chan-tai-man/';
    /* 已上線的情境：名片改動早於上次重建。 */
    const liveStatus = { configured: true, auto: true, last_build_at: '2026-09-28T07:00:00Z' };
    const card = { slug: 'chan-tai-man', active: true, name: { zh: '陳大文' }, title: { zh: '示範' }, updated_at: '2026-09-20T00:00:00Z' };
    const { html: out, state: st } = renderCard(card, U, liveStatus);

    check(new RegExp(`<a\\s+href="${U.replace(/[/.]/g, '\\$&')}"`).test(out), '渲染後 href 真的等於 cardUrl 的結果', `實際 HTML：${(out.match(/<a[^>]*>/) || ['(無 a 標籤)'])[0]}`);
    check(/target="_blank"/.test(out), '渲染後帶 target="_blank"（另開新分頁）');
    check(/rel="noopener"/.test(out), '渲染後帶 rel="noopener"（安全）');
    check(out.includes(`>${U}</a>`), '連結文字就是完整網址（可選取複製）');

    /* 轉義：網址含 & 時必須被 esc 處理（HTML 屬性安全） */
    const { html: outAmp } = renderCard({ slug: 'x', active: true, name: { zh: 'A' }, title: { zh: '' }, updated_at: '2026-01-01T00:00:00Z' }, 'https://a.io/p?a=1&b=2', liveStatus);
    check(outAmp.includes('&amp;') && !/href="[^"]*[^m];?a=1&b=2"/.test(outAmp), 'href 內的 & 經 esc 轉義');

    /* 退路：url 為空時不該產生 <a href="">，而應顯示 /slug/ */
    const { html: outEmpty } = renderCard({ slug: 'foo-bar', active: false, name: { zh: 'X' }, title: { zh: '' }, updated_at: '2026-01-01T00:00:00Z' }, '', liveStatus);
    check(!/class="url"/.test(outEmpty), '網址為空時不渲染 .url 區塊');
    check(outEmpty.includes('/foo-bar/'), '網址為空時退回顯示 /slug/ 片段');

    /* ---------- 7b. 發布狀態徽章（pubState）----------
     * 這是要回答「同事會不會誤以為網址壞掉」的核心邏輯。
     * 判定必須正確，否則會給出錯誤的安心感（或錯誤的警報）。 */
    const cases = [
      /* [名稱, 名片, 建置狀態, 期望 cls] */
      ['改動早於重建 → 已上線', { updated_at: '2026-09-20T00:00:00Z' }, liveStatus, 'pub-live'],
      ['改動晚於重建 → 待重建', { updated_at: '2026-09-28T08:00:00Z' }, liveStatus, 'pub-pending'],
      ['自動重建未設定 → 待發布', { updated_at: '2026-09-20T00:00:00Z' }, { configured: false }, 'pub-pending'],
      ['手動模式 → 待發布', { updated_at: '2026-09-20T00:00:00Z' }, { configured: true, auto: false }, 'pub-pending'],
      ['沒有重建時間 → 保守待發布', { updated_at: '2026-09-20T00:00:00Z' }, { configured: true, auto: true, last_build_at: null }, 'pub-pending'],
      ['名片無 updated_at 但有重建 → 視為已上線', {}, liveStatus, 'pub-live'],
      ['建置狀態未知 → 狀態未知', { updated_at: '2026-09-20T00:00:00Z' }, undefined, 'pub-unknown'],
    ];
    const wrong = cases
      .map(([name, s, b, want]) => ({ name, want, got: renderCard({ slug: 'x', active: true, name: { zh: 'X' }, title: { zh: '' }, ...s }, U, b).state.cls }))
      .filter((r) => r.want !== r.got);
    check(wrong.length === 0,
      `發布狀態判定 ${cases.length} 種情境全部正確`,
      wrong.map((r) => `${r.name}：期望 ${r.want} 得到 ${r.got}`).join('；'));

    /* 尚未上線時不該給可點的連結 —— 否則「可點但壞掉」比不給更糟。 */
    const pendingUrl = 'https://tobyyipwork.github.io/sage/ecard/dist/wong-kam-fai/';
    const { html: pOut } = renderCard(
      { slug: 'wong-kam-fai', active: true, name: { zh: '黃錦輝' }, title: { zh: '' }, updated_at: '2026-09-28T09:00:00Z' },
      pendingUrl, liveStatus
    );
    check(!/<a\s+href/.test(pOut), '待重建時網址不做成連結（避免點到 404）');
    check(pOut.includes(pendingUrl), '待重建時仍顯示網址全文（可自行複製）');

    /* 徽章文字要出現在卡片上，否則等於沒做。 */
    check(/⏳/.test(pOut) && /待重建/.test(pOut), '待重建卡片顯示 ⏳ 待重建 徽章');
    check(/✅/.test(out) && /已上線/.test(out), '已上線卡片顯示 ✅ 已上線 徽章');

    /* 右側的補充說明（when）也必須渲染出來 ——
       它才是告訴同事「大概還要多久」的那句話。
       這項是靠突變測試補上的：把 when 那一行刪掉，原本竟全綠。 */
    check(/1–2 分鐘/.test(pOut), '待重建卡片顯示預計生效時間（約 1–2 分鐘生效）', '卡片缺少預計生效時間說明');
    check(/分鐘前|小時前|剛剛|天前/.test(out), '已上線卡片顯示上次重建時間（相對時間）', '已上線卡片缺少「重建於 …」說明');
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
