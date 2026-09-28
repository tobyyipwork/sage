/**
 * 後台登入畫面顯示機構名稱（fillLoginOrg）驗證。
 *
 * 為什麼要測？
 *   同事拿到的是一條網址，打開只看到「電子名片後台」——
 *   無從確認自己進的是哪個機構的後台。
 *   將來多機構共用同一套部署時，這會直接造成「輸入了密碼才發現進錯」。
 *
 * 測法上的關鍵（與 test-admin-card-url.mjs 同一套方法）：
 *   後台是單一 HTML 檔、script 內嵌，無法 import。
 *   所以【從檔案抽出 fillLoginOrg 的真實原始碼】，在 vm 裡配上假的
 *   api / CONFIG / document 執行。測的是檔案裡那一份真實程式碼，
 *   不是複製品 —— 抄過來測的話，程式改壞了測試還是綠的。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ADMIN = resolve(ROOT, 'admin', 'public', 'index.html');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg || `未通過：${good}`));

const html = readFileSync(ADMIN, 'utf8');
const js = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];

console.log('\n=== 登入畫面機構名稱（fillLoginOrg）驗證 ===\n');

/* ---------- 抽出真實原始碼 ---------- */
const fnMatch = js.match(/(async function fillLoginOrg\([\s\S]*?\n\})/);
if (!fnMatch) {
  console.error('  ✗ 找不到 fillLoginOrg 定義（改名了？本測試需同步調整）');
  process.exit(1);
}
const fnSrc = fnMatch[1];
ok('成功抽出 fillLoginOrg 真實原始碼');

/* ---------- 1. HTML 有對應的容器 ---------- */
{
  check(/id="loginOrg"/.test(html), '登入畫面有 id="loginOrg" 容器（主標）');
  check(/id="loginOrgSub"/.test(html), '登入畫面有 id="loginOrgSub" 容器（副標）');
  /* 預設文字必須保留 —— JS 尚未執行或失敗時，畫面不能空白。 */
  const wrap = (html.match(/id="loginOrg"[^>]*>([^<]*)</) || [])[1] || '';
  check(wrap.trim().length > 0, `容器有預設文字（「${wrap.trim()}」）—— JS 失敗時不會空白`);
}

/* ---------- 建立可控的執行環境 ---------- */
/* 用假的 document 記錄寫入的文字，這樣能驗證「寫了什麼」而不只是「有沒有呼叫」。 */
const makeEnv = ({ config, apiImpl }) => {
  const els = {};
  const doc = {
    getElementById: (id) => {
      if (!els[id]) els[id] = { textContent: '' };
      return els[id];
    },
    title: '',
  };
  const ctx = {
    document: doc,
    CONFIG: config === undefined ? {} : config,
    api: apiImpl || (async () => { throw new Error('不該呼叫 api'); }),
    els,
  };
  vm.createContext(ctx);
  /* 需要 top-level await 執行 async 函式 —— 用表達式包起來再取回 promise。 */
  vm.runInContext(`${fnSrc}\n; __fn = fillLoginOrg;`, ctx, { filename: 'fillLoginOrg-from-admin.js' });
  return { ctx, call: () => ctx.__fn() };
};

/* ---------- 2. CONFIG 已有機構名 → 直接寫入，不呼叫 API ---------- */
{
  let apiCalled = false;
  const env = makeEnv({
    config: { org: { zh: '香港耆康老人福利會', en: 'The Hong Kong Society for the Aged' } },
    apiImpl: async () => { apiCalled = true; return {}; },
  });
  await env.call();

  const main = env.ctx.els.loginOrg ? env.ctx.els.loginOrg.textContent : '';
  check(!apiCalled, 'CONFIG 已有機構名時不重複呼叫 API（省一次請求）');
  check(main.includes('香港耆康老人福利會'), `主標含機構名（「${main}」）`);
  check(main.includes('電子名片後台'), '主標保留「電子名片後台」字樣');
  check(env.ctx.document.title.includes('香港耆康老人福利會'), '網頁標題也帶上機構名（分頁好辨認）');
  check(env.ctx.els.loginOrgSub.textContent === 'The Hong Kong Society for the Aged', '副標顯示英文名');
}

/* ---------- 3. CONFIG 尚未載入 → 向 health 取得（不可用 config）----------
 * ⚠️ 這是最容易寫錯的一項：
 *    所有 /api/* 除了 login 與 health 都需要驗證。
 *    登入前打 /api/config 會拿到 401，而 401 攔截器會把畫面切回登入頁，
 *    變成「想顯示機構名反而把自己踢出去」。
 *    下面的測試會直接檢查【沒有】去打 /api/config。 */
{
  let fetched = '';
  const env = makeEnv({
    config: {},                                  // 空 → 需自行取得
    apiImpl: async (m, url) => { fetched = url; return { ok: true, org: 'sage', org_name: { zh: '測試機構', en: 'Test Org' } }; },
  });
  await env.call();
  check(fetched === '/api/health', `CONFIG 為空時改抓 /api/health（實際：${fetched}）`);
  check(fetched !== '/api/config', '不會去打需要驗證的 /api/config（否則 401 會被踢出登入頁）');
  check(env.ctx.els.loginOrg.textContent.includes('測試機構'), '抓到後寫入機構名');
}

/* ---------- 3b. health 沒有 org_name 時不可亂寫 ---------- */
{
  const env = makeEnv({ config: {}, apiImpl: async () => ({ ok: true, org: 'sage' }) });
  await env.call();
  check(env.ctx.els.loginOrg === undefined || env.ctx.els.loginOrg.textContent === '',
    'health 未提供機構名時不寫入（保持預設標題）');
}

/* ---------- 4. 只有英文名時仍要顯示（不能空白）---------- */
{
  const env = makeEnv({ config: {}, apiImpl: async () => ({ org_name: { en: 'SAGE Only' } }) });
  await env.call();
  check(env.ctx.els.loginOrg.textContent.includes('SAGE Only'), '只有英文名時退回顯示英文（不空白）');
}

/* ---------- 5. 副標不重複 ---------- */
{
  /* 中英文相同時，副標應留空，不要出現「XX / XX」 */
  const env = makeEnv({ config: { org: { zh: '同名機構', en: '同名機構' } } });
  await env.call();
  check(env.ctx.els.loginOrgSub.textContent === '', '中英文相同時副標留空（不重複顯示）');

  const env2 = makeEnv({ config: { org: { zh: '中文名' } } });
  await env2.call();
  check(env2.ctx.els.loginOrgSub.textContent === '', '沒有英文名時副標留空');
}

/* ---------- 6. 失敗時必須靜默（不能擋住登入）----------
 * 這是本功能最重要的一項：顯示機構名是加分項，
 * 拿不到時仍要讓同事能正常輸入密碼登入。 */
{
  const env = makeEnv({
    config: {},
    apiImpl: async () => { throw new Error('網路錯誤'); },
  });
  let threw = false;
  try { await env.call(); } catch (e) { threw = true; }
  check(!threw, '取得機構名失敗時不拋出例外（登入流程不受影響）', '失敗時往外拋例外，會擋住登入！');
  /* 失敗時根本不該去碰 DOM —— 元素沒被建立也是可以接受的結果。 */
  const el = env.ctx.els.loginOrg;
  check(el === undefined || el.textContent === '', '失敗時不寫入任何文字（保持原狀）');
}

/* ---------- 7. api 回傳不完整時不當掉 ---------- */
{
  const cases = [
    ['回傳 null', async () => null],
    ['回傳空物件', async () => ({})],
    ['org 存在但全空', async () => ({ org: {} })],
    ['回傳字串', async () => 'oops'],
  ];
  const bads = [];
  for (const [name, impl] of cases) {
    const env = makeEnv({ config: {}, apiImpl: impl });
    try { await env.call(); } catch (e) { bads.push(`${name} → 拋出 ${e.message}`); }
  }
  check(bads.length === 0, `${cases.length} 種異常回應都不會當掉`, bads.join('；'));
}

/* ---------- 8. 啟動路徑真的有呼叫它 ----------
 * 函式寫得再好，沒接上等於沒做。檢查三條路徑。 */
{
  const startup = js.slice(js.lastIndexOf("if(IS_CLOUD){"));
  check(/showLogin\(''\)\s*;?\s*fillLoginOrg\(\)/.test(startup) || /showLogin\(''\);fillLoginOrg\(\)/.test(startup),
    '未登入時（無 token）會呼叫 fillLoginOrg');
  check(/catch\(\(\)=>\{showLogin\(''\);fillLoginOrg\(\);\}\)/.test(startup),
    'token 失效退回登入畫面時也會呼叫 fillLoginOrg');
  const logoutSrc = js.match(/function doLogout\(\)\{[\s\S]*?\n\}/);
  check(logoutSrc && /fillLoginOrg\(\)/.test(logoutSrc[0]), '登出後仍會呼叫 fillLoginOrg（畫面不會退回無機構名）');
}

console.log(`\n  通過 ${pass} 項，失敗 ${fail} 項\n`);
process.exit(fail ? 1 : 0);
