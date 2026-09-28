/**
 * SAGE E-Card Cloud — 密碼政策
 *
 * 集中管理密碼規則，讓前端提示與後端驗證使用同一套標準。
 * 前端（admin/index.html）與後端（index.js）都應引用這裡的規則，
 * 避免出現「前端說可以、後端卻拒絕」的不一致。
 *
 * 這是安全邊界的一部分 —— 後端**一定**要驗證，
 * 前端驗證只是為了即時回饋。
 */

/** 最短長度。低於此值直接拒絕。 */
export const MIN_LENGTH = 8;

/** 最長長度。避免有人用超長字串做雜湊耗費攻擊。 */
export const MAX_LENGTH = 256;

/**
 * 常見弱密碼黑名單（小寫比對）。
 * 刻意只列最常見的幾組 —— 完整黑名單會讓程式碼膨脹，
 * 且真正有效的是長度與複雜度要求。
 */
const WEAK_PASSWORDS = new Set([
  'password', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwertyui', 'qwerty123', 'abcdefgh', 'iloveyou', 'admin123',
  'sage1234', 'ecard123', 'letmein1', 'welcome1', 'changeme',
  '88888888', '00000000', '11111111', 'abcd1234', 'a1234567',
]);

/**
 * 檢查密碼強度。
 *
 * @param {string} password
 * @returns {{ ok: boolean, reason?: string, strength: 'weak'|'fair'|'good'|'strong', score: number }}
 */
export const checkPassword = (password) => {
  const pw = String(password ?? '');

  if (pw.length < MIN_LENGTH) {
    return { ok: false, reason: `密碼至少需要 ${MIN_LENGTH} 個字元`, strength: 'weak', score: 0 };
  }
  if (pw.length > MAX_LENGTH) {
    return { ok: false, reason: `密碼不可超過 ${MAX_LENGTH} 個字元`, strength: 'weak', score: 0 };
  }
  if (WEAK_PASSWORDS.has(pw.toLowerCase())) {
    return { ok: false, reason: '這個密碼太常見，請改用其他密碼', strength: 'weak', score: 0 };
  }
  // 全部同一字元（例如 aaaaaaaa）
  if (/^(.)\1+$/.test(pw)) {
    return { ok: false, reason: '密碼不可為重複的單一字元', strength: 'weak', score: 0 };
  }

  /* ---------- 強度評分（僅供提示，不影響是否通過） ---------- */
  let score = 0;
  if (pw.length >= MIN_LENGTH) score++;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  /* ---------- 強度評分（僅供提示，不影響是否通過） ----------
   *
   * 六項各一分，滿分 6：
   *   長度 >= 8 / >= 12 / >= 16
   *   有大寫+小寫 / 有數字 / 有符號
   *
   * 門檻對齊直覺：
   *   0–1 → weak    純小寫短字（且未觸發黑名單）
   *   2–3 → fair    小寫+數字，或大小寫混合
   *   4–5 → good    長度夠且有兩類以上字元
   *   6   → strong  長且大小寫+數字+符號俱全
   */
  const strength = score >= 6 ? 'strong'
                 : score >= 4 ? 'good'
                 : score >= 2 ? 'fair'
                 : 'weak';
  return { ok: true, strength, score };
};

/** 供前端顯示的規則說明 */
export const PASSWORD_RULES = [
  `至少 ${MIN_LENGTH} 個字元`,
  '不可使用常見密碼（如 password、12345678）',
  '不可為重複的單一字元',
  '建議混合大小寫字母、數字與符號',
];

export { WEAK_PASSWORDS };
