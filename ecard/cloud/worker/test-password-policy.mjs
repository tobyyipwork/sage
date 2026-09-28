/**
 * 密碼政策單元測試
 *
 * 執行： node test-password-policy.mjs
 */

import { checkPassword, PASSWORD_RULES, MIN_LENGTH, MAX_LENGTH, WEAK_PASSWORDS } from './src/password-policy.js';

let pass = 0;
let fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

console.log('\n=== ① 長度規則 ===');

ok('最短長度為 8', MIN_LENGTH === 8);
ok('空字串 → 拒絕', checkPassword('').ok === false);
ok('7 字元 → 拒絕', checkPassword('abcdefg').ok === false);
ok('8 字元 → 接受', checkPassword('abcdefgh1').ok === true);
ok('超長字串（257）→ 拒絕', checkPassword('a1'.repeat(129)).ok === false);
ok('256 字元 → 接受', checkPassword('a1'.repeat(128)).ok === true);
ok('null → 拒絕', checkPassword(null).ok === false);
ok('undefined → 拒絕', checkPassword(undefined).ok === false);
ok('數字型別 → 拒絕（長度不足）', checkPassword(12345).ok === false);

console.log('\n=== ② 常見密碼黑名單 ===');

ok('password → 拒絕', checkPassword('password').ok === false);
ok('PASSWORD（大寫）→ 拒絕', checkPassword('PASSWORD').ok === false);
ok('Password（混合）→ 拒絕', checkPassword('Password').ok === false);
ok('12345678 → 拒絕', checkPassword('12345678').ok === false);
ok('qwerty123 → 拒絕', checkPassword('qwerty123').ok === false);
ok('sage1234 → 拒絕', checkPassword('sage1234').ok === false);
ok('welcome1 → 拒絕', checkPassword('welcome1').ok === false);
ok('不在黑名單 → 接受', checkPassword('Xk9-mQ2p-Lz').ok === true);
ok('黑名單非空', WEAK_PASSWORDS.size > 0);

console.log('\n=== ③ 重複字元 ===');

ok('aaaaaaaa → 拒絕', checkPassword('aaaaaaaa').ok === false);
ok('11111111 → 拒絕', checkPassword('11111111').ok === false);
ok('-------- → 拒絕', checkPassword('--------').ok === false);
ok('aabbaabb → 接受（非單一字元重複）', checkPassword('aabbaabb').ok === true);

console.log('\n=== ④ 強度評分 ===');

{
  const weak = checkPassword('xkzjqmnb');        // 8 位、純小寫、不在黑名單
  ok('純小寫 8 位 → weak', weak.strength === 'weak', weak.strength);

  const fair = checkPassword('xkzjqmnb12');      // 10 位、小寫+數字 → 3 分
  ok('小寫+數字 10 位 → fair', fair.strength === 'fair', fair.strength);

  const good = checkPassword('Xkzjqmnb12cd');    // 12 位（2分）+大小寫+數字（2分）= 4 分
  ok('12 位大小寫+數字 → good', good.strength === 'good', good.strength);

  const strong = checkPassword('eiKd-5Uuo-5EOL-nerl');  // 長且混合 → 6 分
  ok('長且混合 → strong', strong.strength === 'strong', strong.strength);

  ok('通過的密碼 strength 必為合法值',
    ['weak','fair','good','strong'].includes(strong.strength));
  ok('被拒絕的密碼 strength 為 weak', checkPassword('123').strength === 'weak');
  ok('通過的密碼分數 >= 1', fair.score >= 1);
  ok('被拒的密碼分數為 0', checkPassword('123').score === 0);
}

console.log('\n=== ⑤ 邊界：不應因強度低而拒絕 ===');

{
  // 強度只是提示，不是拒絕條件 —— 只要符合最低規則就該通過
  const r = checkPassword('xkzjqmnb');
  ok('低強度但合規 → ok=true', r.ok === true);
  ok('低強度 → strength=weak（僅提示）', r.strength === 'weak');
}

console.log('\n=== ⑥ Unicode 與特殊字元 ===');

{
  ok('中文密碼（8 字元）→ 接受', checkPassword('密碼測試八個字元').ok === true);
  ok('emoji 混合 → 接受', checkPassword('abc123🔒🔑x').ok === true);
  ok('全符號（8 位不重複）→ 接受', checkPassword('!@#$%^&*').ok === true);
  ok('含空白 → 接受（長度足夠）', checkPassword('a b c d e f').ok === true);
}

console.log('\n=== ⑦ 規則說明 ===');

ok('PASSWORD_RULES 非空', PASSWORD_RULES.length > 0);
ok('規則中有提到最短長度', PASSWORD_RULES.some((r) => r.includes(String(MIN_LENGTH))));

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項\n`);
process.exit(fail === 0 ? 0 : 1);
