/**
 * 建置產物（dist/）的隱私輸出驗證。
 *
 * 為什麼需要這個測試？
 *   其餘 11 個測試檔全都在測 Worker 端與 KV 同步流程，
 *   沒有任何一個會去看「build.js 實際吐出來的檔案長什麼樣」。
 *   於是「列表頁不列員工」「sitemap 不產生」這類隱私決定
 *   完全沒有回歸保護 —— 有人改動 build.js 讓它們失效，
 *   測試會全綠，沒人會發現。
 *
 *   這個檔案就是用來補上那個缺口：它對 dist/ 的實體檔案下斷言。
 *
 * 為什麼不是 spawn 子行程？
 *   sandbox 會讓 execFileSync 回傳 code=null 且沒有輸出，
 *   所以這裡直接 import build() 在行程內執行（見 build.js 的 module.exports）。
 *   副作用是會真的寫入 dist/ —— 這是刻意的，因為要驗的就是產物本身。
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');       // worker/ -> cloud/ -> ecard/
const DIST = resolve(ROOT, 'dist');

const { build } = await import('file://' + resolve(ROOT, 'build', 'build.js').replace(/\\/g, '/'));

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg));

const read = (rel) => readFileSync(resolve(DIST, rel), 'utf8');
const exists = (rel) => existsSync(resolve(DIST, rel));

console.log('\n=== 建置產物（dist/）隱私輸出驗證 ===\n');

/* ---- 先埋一個「不該留下的舊檔」，驗證停用機制真的會清掉它 ----
 * 「不產生」不等於「檔案會消失」。若只把 SITEMAP_ENABLED 設 false
 * 而不主動刪除，上一次建置留下的 sitemap.xml 會繼續被公開讀取。
 * 這裡刻意偽造一個假 sitemap，看建置後它有沒有消失。 */
{
  mkdirSync(DIST, { recursive: true });
  writeFileSync(resolve(DIST, 'sitemap.xml'), '<urlset><url><loc>STALE-MARKER</loc></url></urlset>');
  const planted = read('sitemap.xml').includes('STALE-MARKER');
  check(planted, '（前置作業）已植入假的 stale sitemap.xml', '無法植入測試用 sitemap.xml');
}

/* ---- 執行真正的建置 ---- */
let built = false;
try {
  build();
  built = true;
  ok('build() 執行成功');
} catch (e) {
  bad(`build() 拋出例外：${e.message}`);
}

/* ---- 1. sitemap 必須消失（含主動清除舊檔）---- */
{
  check(!exists('sitemap.xml'), 'sitemap.xml 不存在於 dist/', 'sitemap.xml 仍存在');
  const stale = exists('sitemap.xml') ? read('sitemap.xml') : '';
  check(!stale.includes('STALE-MARKER'), '舊的 sitemap.xml 已被主動刪除（不只是不產生）', '舊 sitemap.xml 未被清除 —— 停用只是自欺');
}

/* ---- 2. 列表頁不得洩漏任何員工資訊 ---- */
{
  const f = 'index.html';
  if (!exists(f)) {
    bad(`dist/${f} 不存在`);
  } else {
    const html = read(f);

    /* 2a. 不得出現任何員工姓名（從 data/staff/*.json 動態取得，
     *     避免測試檔寫死姓名，日後換人也不會失效）。
     *     這是本檔案最重要的斷言 —— 它直接對應「遮眼」的目的。 */
    const staffDir = resolve(ROOT, 'data', 'staff');
    const names = [];
    if (existsSync(staffDir)) {
      for (const file of readdirSync(staffDir).filter((x) => x.endsWith('.json'))) {
        const s = JSON.parse(readFileSync(resolve(staffDir, file), 'utf8'));
        if (s.active === false) continue;
        for (const lang of ['zh', 'cn', 'en']) {
          if (s.name?.[lang]) names.push(s.name[lang]);
        }
      }
    }
    const leaked = names.filter((n) => html.includes(n));
    check(names.length > 0, `取得 ${names.length} 個員工姓名作為檢驗基準`, '讀不到任何員工姓名，檢驗失效');
    check(leaked.length === 0, '列表頁不含任何員工姓名', `列表頁洩漏姓名：${leaked.join('、')}`);

    /* 2b. 不得有任何指向個別名片的連結。 */
    const slugDir = resolve(ROOT, 'data', 'staff');
    const slugs = existsSync(slugDir)
      ? readdirSync(slugDir).filter((x) => x.endsWith('.json')).map((x) => x.replace(/\.json$/, ''))
      : [];
    const linked = slugs.filter((s) => new RegExp(`href=["'][^"']*${s}[^"']*["']`).test(html));
    check(linked.length === 0, '列表頁不含任何名片連結', `列表頁仍有名片連結：${linked.join('、')}`);

    /* 2c. 不得被搜尋引擎索引（noindex 是「遮眼」的必要配套）。 */
    check(/name=["']robots["'][^>]*noindex/i.test(html), '列表頁帶 noindex', '列表頁缺少 noindex');
  }
}

/* ---- 3. robots.txt 應全面禁止 ---- */
{
  if (!exists('robots.txt')) {
    bad('dist/robots.txt 不存在');
  } else {
    const txt = read('robots.txt');
    check(/User-agent:\s*\*/i.test(txt), 'robots.txt 有 User-agent 規則', 'robots.txt 格式異常');
    check(/Disallow:\s*\/\s*$/m.test(txt), 'robots.txt 為 Disallow: /（全面禁止）', 'robots.txt 未全面禁止');
    check(!/Allow:\s*\//m.test(txt), 'robots.txt 不含 Allow: /（不再主動邀請索引）', 'robots.txt 仍有 Allow: /');
  }
}

/* ---- 4. 後台不得出現在 dist/ ---- */
{
  check(!exists('admin'), '後台未被複製進 dist/', '後台目錄出現在 dist/ 中（登入頁公開曝光）');
  check(!exists('admin/index.html'), 'dist/admin/index.html 不存在', '後台登入頁可被公開存取');
}

/* ---- 5. 個別名片仍須存在（避免「保護過頭」把功能弄壞）---- */
{
  const staffDir = resolve(ROOT, 'data', 'staff');
  const slugs = existsSync(staffDir)
    ? readdirSync(staffDir).filter((x) => x.endsWith('.json')).map((x) => x.replace(/\.json$/, ''))
    : [];
  const missing = slugs.filter((s) => !exists(`${s}/index.html`));
  check(slugs.length > 0, `取得 ${slugs.length} 位員工 slug`, '讀不到任何員工 slug');
  check(missing.length === 0, '每位員工的名片頁都正常產生（功能未被誤傷）', `以下名片頁消失：${missing.join('、')}`);

  /* 名片的遮眼邊界說明：名片本身仍是公開的，這是已知且刻意的取捨。
   * 這裡驗證它「確實仍可被直連」—— 提醒任何人：這不是存取控制。 */
  const reachable = slugs.filter((s) => exists(`${s}/index.html`));
  check(
    reachable.length === slugs.length && slugs.length > 0,
    '名片頁仍可被直連（已知取捨，非保護）',
    '名片頁無法直連 —— 若這是刻意的存取控制，請更新此測試的預期'
  );
}

console.log(`\n  通過 ${pass} 項，失敗 ${fail} 項\n`);
process.exit(fail ? 1 : 0);
