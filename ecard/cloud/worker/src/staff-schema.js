/**
 * SAGE E-Card Cloud — 名片資料正規化
 *
 * 所有名片資料的唯一正規化入口 — 不論從管理介面或 API 進來，
 * 都經過這裡清洗，確保結構一致、欄位受控。
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 香港時間 ISO 8601（+08:00） */
export const hkNow = () => {
  const d = new Date();
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const hk = new Date(utcMs + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${hk.getFullYear()}-${p(hk.getMonth() + 1)}-${p(hk.getDate())}` +
    `T${p(hk.getHours())}:${p(hk.getMinutes())}:${p(hk.getSeconds())}+08:00`
  );
};

const str = (v) => String(v ?? '').trim();

/**
 * @param {object} input    前端送來的資料
 * @param {object} opts     { isNew, existing, nextId }
 * @returns 正規化後的名片物件
 * @throws {Error & {status:number}} 驗證失敗時拋出，帶 HTTP 狀態碼
 */
export const sanitizeStaff = (input, { isNew, existing, nextId }) => {
  const out = existing ? { ...existing } : {};
  out.slug = str(input.slug);
  if (!SLUG_RE.test(out.slug)) {
    throw Object.assign(new Error('slug 格式無效（只能用小寫英數與連字號，例如 chan-tai-man）'), { status: 400 });
  }

  out.name = { zh: str(input.name?.zh), cn: str(input.name?.cn), en: str(input.name?.en) };
  out.title = { zh: str(input.title?.zh), cn: str(input.title?.cn), en: str(input.title?.en) };
  out.n = { family: str(input.n?.family), given: str(input.n?.given) };
  out.email = str(input.email);
  out.phone_work = str(input.phone_work);
  out.phone_mobile = str(input.phone_mobile);
  out.active = input.active === false ? false : true;

  out.social_links = Array.isArray(input.social_links)
    ? input.social_links
        .map((s) => ({
          platform: str(s.platform),
          url: str(s.url),
          icon: str(s.icon) || 'globe',
          color: str(s.color),
        }))
        .filter((s) => s.url)
    : out.social_links || [];

  out.custom_links = Array.isArray(input.custom_links)
    ? input.custom_links
        .map((l) => ({
          title: { zh: str(l.title?.zh), cn: str(l.title?.cn), en: str(l.title?.en) },
          url: str(l.url),
          icon: str(l.icon) || 'globe',
          color: str(l.color),
        }))
        .filter((l) => l.url)
    : out.custom_links || [];

  if (isNew) {
    out.images = { banner: '', avatar: '', wechat_qr: '' };
    out.id = nextId;
    out.created_at = hkNow();
  } else {
    out.images = existing.images || { banner: '', avatar: '', wechat_qr: '' };
  }
  out.updated_at = hkNow();
  return out;
};

export { SLUG_RE };
