/**
 * test-site-prefix.mjs — 存取暗號（site prefix）的行為驗證
 *
 * 為什麼要有一支專門的測試？
 *   這個功能的失敗模式是「靜默的隱私外洩」—— 不會拋錯、不會有紅字，
 *   只是某個舊目錄忘了刪，於是公開網址依然活著，暗號形同虛設。
 *   這種錯誤在人工測試時幾乎不可能發現（誰會去點那個「已經不存在」的舊網址），
 *   所以必須靠測試把「舊網址必須失效」這件事釘死。
 *
 * 為什麼直接 import build() 而不是 spawn 子行程？
 *   ① 這個執行環境下 spawn 的子行程會被 fs shim 干擾（execFileSync 回傳
 *      code=null 且無輸出），根本跑不動。
 *   ② 直接呼叫更快，而且能精準控制每次的 prefix 參數。
 *   為此 build.js 的 build() 接受 { prefix } 參數，介面向後相容。
 *
 * 測什麼：
 *   ① 未設暗號 → 輸出到 dist/，行為與過去完全一致
 *   ② 設暗號   → 輸出到 dist/<暗號>/
 *   ③ 切換暗號 → 舊暗號目錄必須被清掉
 *   ④ 暗號從無到有 → 舊的無前綴目錄（含根目錄 index.html）必須被清掉
 *   ⑤ URL 一致性 → canonical / hreflang / 語言切換 / 列表頁 / sitemap 全含暗號
 *   ⑥ QR code 實際編碼的是含暗號的網址（比對矩陣，不是比對字串）
 *   ⑦ 暗號正規化 → 危險字元被濾除，無法逃逸目錄
 *   ⑧ robots.txt 為 Disallow
 *   ⑨ 後台未被複製進 dist／頁面帶 noindex
 *
 * 執行：node build/test-site-prefix.mjs
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { build, normalizePrefix } = require_(path.join(__dirname, 'build.js'));
const { qrSvg } = require_(path.join(__dirname, 'qr.js'));

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

const rmDist = () => { if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true }); };
const lsDist = () => (existsSync(DIST) ? readdirSync(DIST).sort() : []);
const read = (rel) => readFileSync(path.join(DIST, rel), 'utf8');
const has = (rel) => existsSync(path.join(DIST, rel));

const P1 = 'aaa111bbb222';
const P2 = 'ccc333ddd444';

/* ───────────────────────────────────────────────────────────── */
console.log('\n\x1b[1m存取暗號（site prefix）測試\x1b[0m');

/* ── ① 未設暗號：向後相容 ─────────────────────────────────── */
section('① 未設暗號時，輸出位置與過去相同');
rmDist();
build({ prefix: '' });
ok(has('index.html'), 'dist/index.html 存在（未加前綴）');
ok(has('robots.txt'), 'dist/robots.txt 存在');
ok(has('chan-tai-man/index.html'), 'dist/chan-tai-man/ 存在');
ok(!lsDist().some((e) => /^[a-z0-9]{12}$/.test(e)), '沒有意外的暗號目錄');

/* ── ② 設暗號：輸出搬進暗號目錄 ───────────────────────────── */
section('② 設暗號後，輸出落在 dist/<暗號>/');
build({ prefix: P1 });
ok(has(`${P1}/index.html`), `dist/${P1}/index.html 存在`);
ok(has(`${P1}/chan-tai-man/index.html`), `dist/${P1}/chan-tai-man/ 存在`);
ok(has(`${P1}/assets/logo.png`), `dist/${P1}/assets/logo.png 存在（資源一起搬進去）`);
ok(has(`${P1}/robots.txt`), `dist/${P1}/robots.txt 存在`);

/* ── ③ 關鍵：舊暗號路徑必須失效 ───────────────────────────── */
section('③ 切換暗號後，舊暗號目錄必須被清掉（隱私關鍵）');
build({ prefix: P2 });
ok(has(`${P2}/chan-tai-man/index.html`), `新暗號 ${P2} 的內容存在`);
ok(!has(`${P1}/chan-tai-man/index.html`), `舊暗號 ${P1} 的目錄已被刪除`);
ok(!lsDist().includes(P1), 'dist/ 底下已無舊暗號目錄');

/* ── ④ 關鍵：暗號從無到有，舊的無前綴路徑必須失效 ─────────── */
section('④ 暗號從「無」變「有」時，舊的無前綴路徑必須被清掉（隱私關鍵）');
rmDist();
build({ prefix: '' });        // 先產生無前綴版本
ok(has('chan-tai-man/index.html'), '(前置) 無前綴版本已產生');
ok(has('index.html'), '(前置) 無前綴的列表頁存在');
build({ prefix: P1 });        // 再切到有暗號
ok(!has('chan-tai-man/index.html'), '舊的無前綴名片目錄已刪除 —— 舊公開網址失效');
ok(!has('index.html'), '舊的無前綴列表頁已刪除 —— 不會公開列出所有員工');
ok(!has('sitemap.xml'), '舊的無前綴 sitemap 已刪除');
ok(!has('robots.txt'), '舊的無前綴 robots 已刪除');
ok(has(`${P1}/chan-tai-man/index.html`), '新暗號路徑正常存在');
ok(has('.nojekyll'), '.nojekyll 被保留（GitHub Pages 運作必需）');
ok(has('assets/logo.png'), 'dist/assets 被保留（不影響 Pages 根資源）');

/* ── ⑤ URL 一致性 ─────────────────────────────────────────── */
section('⑤ 頁面內的絕對 URL 全部帶上暗號');
const cardZh = read(`${P1}/chan-tai-man/index.html`);
const cardEn = read(`${P1}/chan-tai-man/en/index.html`);
const indexPage = read(`${P1}/index.html`);
const sitemap = read(`${P1}/sitemap.xml`);
const baseUrl = `https://tobyyipwork.github.io/sage/ecard/dist/${P1}`;

ok(cardZh.includes(`<link rel="canonical" href="${baseUrl}/chan-tai-man/"`), 'canonical 含暗號');
ok(cardZh.includes(`<meta property="og:url" content="${baseUrl}/chan-tai-man/"`), 'og:url 含暗號');
ok(cardZh.includes(`hreflang="zh-Hans" href="${baseUrl}/chan-tai-man/cn/"`), 'hreflang cn 含暗號');
ok(cardZh.includes(`hreflang="en" href="${baseUrl}/chan-tai-man/en/"`), 'hreflang en 含暗號');
ok(cardZh.includes(`href="/sage/ecard/dist/${P1}/chan-tai-man/en/"`), '語言切換連結含暗號');
ok(cardEn.includes('href="../chan-tai-man.vcf"'), 'vcf 連結為相對路徑（不受前綴影響）');
ok(indexPage.includes(`href="/sage/ecard/dist/${P1}/chan-tai-man/"`), '列表頁連結含暗號');
ok(sitemap.includes(`<loc>${baseUrl}/chan-tai-man/</loc>`), 'sitemap 含暗號');

/* 反向檢查：頁面中每一條以 /sage/ecard/dist/ 開頭的絕對路徑，
   後面都必須緊接著暗號。若出現 /sage/ecard/dist/chan-tai-man/
   這種「dist 之後直接接 slug」的寫法，就代表有漏改的絕對路徑。 */
const absPaths = [...cardZh.matchAll(/\/sage\/ecard\/dist\/[^"'\s>]*/g)].map((m) => m[0]);
const badPaths = absPaths.filter((u) => !u.startsWith(`/sage/ecard/dist/${P1}/`));
ok(absPaths.length > 0, `頁面中確實有絕對路徑可供檢查（共 ${absPaths.length} 條）`);
ok(badPaths.length === 0, `所有絕對路徑都含暗號（無殘留：${badPaths.slice(0, 3).join(', ') || '無'}）`);

/* ── ⑥ QR code 實際編碼內容 ───────────────────────────────── */
section('⑥ QR code 編碼的是含暗號的網址（比對矩陣，非字串）');
const dOf = (svg) => (svg.match(/d="([^"]*)"/) || [])[1] || '';
const qrNew = dOf(qrSvg(`${baseUrl}/chan-tai-man/`, { cls: 'qr-svg', title: 'x' }));
const qrOld = dOf(qrSvg('https://tobyyipwork.github.io/sage/ecard/dist/chan-tai-man/', { cls: 'qr-svg', title: 'x' }));
ok(qrNew.length > 0 && cardZh.includes(qrNew), 'QR 編碼的是「含暗號」的網址');
ok(!cardZh.includes(qrOld), 'QR 不是舊的無前綴網址');

/* ── ⑦ 暗號正規化 ─────────────────────────────────────────── */
section('⑦ 暗號正規化：危險字元被濾除，無法逃逸目錄');
ok(normalizePrefix('../../etc') === 'etc', '"../../etc" 正規化為 "etc"（斜線與點被濾除）');
ok(normalizePrefix('/abc/') === 'abc', '前後斜線被去除');
ok(normalizePrefix('a b\\c:d*e?f') === 'abcdef', '空白與 Windows 禁用字元被濾除');
ok(normalizePrefix('e5f8400a9f93') === 'e5f8400a9f93', '正常暗號原樣保留');

rmDist();
build({ prefix: '../../etc' });
ok(!lsDist().includes('..'), '含 ../ 的暗號不會產生向上目錄');
ok(!existsSync(path.join(DIST, '..', 'etc')), '不會在 dist 外建立目錄');
ok(lsDist().includes('etc'), '被正規化為 dist/etc/');

/* ── ⑧ robots.txt ─────────────────────────────────────────── */
section('⑧ robots.txt 為 Disallow（不再邀請搜尋引擎）');
rmDist();
build({ prefix: P1 });
const robots = read(`${P1}/robots.txt`);
ok(/Disallow:\s*\//.test(robots), 'robots.txt 含 Disallow: /');
ok(!/Allow:\s*\//.test(robots), 'robots.txt 不再含 Allow: /');
ok(!/Sitemap:/i.test(robots), 'robots.txt 不再公布 sitemap');

/* ── ⑨ noindex 與後台 ─────────────────────────────────────── */
section('⑨ 頁面帶 noindex；後台不再進 dist');
ok(/<meta name="robots" content="noindex/.test(cardZh), '名片頁含 noindex');
ok(/<meta name="robots" content="noindex/.test(read(`${P1}/lee-siu-wah/index.html`)), '另一張名片也含 noindex');
ok(/<meta name="robots" content="noindex/.test(indexPage), '列表頁含 noindex');
ok(!has(`${P1}/admin/index.html`), '後台未複製進 dist（不公開登入頁）');
ok(!has('admin'), 'dist 根目錄也無 admin');

/* ── 清理，還原成無前綴狀態（本機開發預設）───────────────── */
rmDist();
build({ prefix: '' });

/* ── 結果 ─────────────────────────────────────────────────── */
console.log(`\n\x1b[1m結果：\x1b[32m通過 ${pass}\x1b[0m\x1b[1m，\x1b[31m失敗 ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
