/**
 * SAGE E-Card — static site builder (zero-dependency, Node >= 18)
 *
 * data/            ← JSON "database" (one file per staff member + config)
 * templates/       ← card.html skeleton + style.css
 * assets/images/   ← source images (org/logo.png, {slug}/banner|avatar|wechat_qr.*)
 * dist/            ← generated site (deploy this / upload as GH Pages artifact)
 *
 * Usage:  node build/build.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STAFF_DIR = path.join(DATA_DIR, 'staff');
const TPL_DIR = path.join(ROOT, 'templates');
const ASSET_SRC = path.join(ROOT, 'assets', 'images');
const OUT = path.join(ROOT, 'dist');

const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (rel, content) => {
  const abs = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const copyFile = (src, rel) => {
  const abs = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(src, abs);
};
const escHtml = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ---------------- config ---------------- */
const config = readJson(path.join(DATA_DIR, 'config.json'));
const LANGS = config.langs || ['zh', 'cn', 'en'];
const DEFAULT_LANG = config.default_lang || 'zh';
const SITE_URL = String(config.site.url).replace(/\/+$/, '');
const BASE_PATH = (config.site.basePath || '').replace(/\/+$/, '');
const HTML_LANG = { zh: 'zh-Hant', cn: 'zh-Hans', en: 'en' };
const LANG_LABEL = { zh: '繁', cn: '简', en: 'EN' };
const TABS_I18N = {
  about: { zh: '關於', cn: '关于', en: 'About' },
  social: { zh: '社群', cn: '社群', en: 'Social' },
  links: { zh: '連結', cn: '链接', en: 'Links' },
};
const SAVE_I18N = { zh: '保存聯絡方式', cn: '保存联络方式', en: 'Save Contact' };
const WECHAT_LABEL = { zh: '微信', cn: '微信', en: 'WeChat' };
const QR_HINT = { zh: '長按或掃描二維碼添加', cn: '长按或扫描二维码添加', en: 'Long-press or scan to add' };
const WHATSAPP_LABEL = { zh: 'WhatsApp', cn: 'WhatsApp', en: 'WhatsApp' };

/* ---------------- icons (inline SVG, stroke = currentColor) ---------------- */
const icon = (name, cls) => {
  const paths = {
    envelope: '<rect x="2" y="4.5" width="20" height="15" rx="2"/><path d="m2.5 6.5 9.5 7 9.5-7"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z"/>',
    mobile: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    building: '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-5h6v5"/><path d="M9 9h.01M15 9h.01M9 12.5h.01M15 12.5h.01"/>',
    'map-pin': '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-5.5 8-5.5s7.2 1.5 8 5.5"/>',
    globe:
      '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19Z"/>',
    facebook:
      '<path d="M14.5 21.5v-7.2h2.4l.4-2.9h-2.8V9.6c0-.85.3-1.5 1.6-1.5h1.3V5.5c-.6-.08-1.6-.2-2.7-.2-2.7 0-4.5 1.6-4.5 4.6v2.5H7.8v2.9h2.4v7.2Z"/>',
    instagram:
      '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="12" cy="12" r="3.8"/><circle cx="17" cy="7" r="1.1" fill="currentColor" stroke="none"/>',
    linkedin:
      '<path d="M5 3.5a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4ZM3.2 9.2H6.8V21H3.2Z"/><path d="M9.3 9.2h3.4v1.6h.05c.47-.9 1.6-1.85 3.35-1.85 3.6 0 4.25 2.35 4.25 5.4V21h-3.55v-5.9c0-1.4-.03-3.2-1.95-3.2-1.95 0-2.25 1.5-2.25 3.1V21H9.3Z"/>',
    youtube:
      '<path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4a2.6 2.6 0 0 0-1.8 1.8C2 8.7 2 12 2 12s0 3.3.4 4.8a2.6 2.6 0 0 0 1.8 1.8c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8C22 15.3 22 12 22 12s0-3.3-.4-4.8Z"/><path d="m10 9.3 5 2.7-5 2.7Z" fill="currentColor" stroke="none"/>',
    whatsapp:
      '<path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.7-1.2A9 9 0 1 0 12 3Zm0 1.8a7.2 7.2 0 1 1-3.7 13.4l-.3-.2-2.4.6.6-2.3-.2-.3A7.2 7.2 0 0 1 12 4.8Zm-3.4 3.4c-.15 0-.4.05-.6.3-.2.25-.8.8-.8 1.95s.8 2.25.95 2.4c.1.2 1.6 2.55 3.95 3.5 1.95.8 2.35.65 2.75.6.4-.05 1.3-.55 1.5-1.05.2-.5.2-.95.15-1.05l-.85-.4s-.85-.4-.95-.45c-.15-.05-.25-.05-.35.15-.1.2-.4.5-.5.6-.1.1-.2.15-.35.05a6.4 6.4 0 0 1-2.5-1.55 6.3 6.3 0 0 1-1.3-1.8c-.1-.2 0-.3.05-.4l.4-.45c.15-.15.2-.3.3-.5.1-.2.05-.35 0-.5l-.7-1.65c-.2-.4-.4-.35-.55-.35Z"/>',
    weixin:
      '<path d="M8.8 3.5A6.3 6.3 0 0 0 2.5 9.8c0 1.9.85 3.6 2.2 4.8l-.7 2.6 2.9-1.3c.6.2 1.25.3 1.9.3.3 0 .6 0 .9-.05a6.3 6.3 0 0 1-.9-3.25 6.35 6.35 0 0 1 8-6.1A6.3 6.3 0 0 0 8.8 3.5Z"/><path d="M15.5 10.3a4.6 4.6 0 0 0-4.6 4.6c0 .5.08 1 .23 1.45l-.55 2 2.25-1a4.6 4.6 0 0 0 6.4-1.2 4.6 4.6 0 0 0-3.7-5.85Zm-.9 2.35c.35 0 .6.3.6.6a.6.6 0 0 1-.6.6.6.6 0 0 1-.6-.6c0-.3.25-.6.6-.6Zm-2.55 0c.35 0 .6.3.6.6a.6.6 0 0 1-.6.6.6.6 0 0 1-.6-.6c0-.3.3-.6.6-.6Z"/>',
  };
  const body = paths[name] || paths.globe;
  return `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
};

/* ---------------- staff loading ---------------- */
const staffs = fs
  .readdirSync(STAFF_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, data: readJson(path.join(STAFF_DIR, f)) }))
  .filter((s) => s.data.active !== false)
  .sort((a, b) => (a.data.slug < b.data.slug ? -1 : 1));

/** resolve source image for staff {slug}/{key} → {rel, abs} | null */
const resolveImage = (slug, key) => {
  const dir = path.join(ASSET_SRC, slug);
  if (!fs.existsSync(dir)) return null;
  for (const ext of IMG_EXTS) {
    const abs = path.join(dir, key + ext);
    if (fs.existsSync(abs)) {
      const rel = `assets/staff/${slug}/${key}${ext}`;
      return { abs, rel };
    }
  }
  return null;
};

/* ---------------- render helpers ---------------- */
const staffPagePath = (slug, lang) =>
  lang === DEFAULT_LANG ? `${BASE_PATH}/${slug}/` : `${BASE_PATH}/${slug}/${lang}/`;

/** relative prefix from a rendered page dir up to site root */
const toRoot = (slug, lang) =>
  lang === DEFAULT_LANG ? '../' : '../../';

const staffUrl = (slug, lang) => `${SITE_URL}${staffPagePath(slug, lang)}`;

const normalizeTel = (t) => {
  const digits = String(t).replace(/[^\d+]/g, '');
  return /^\+/.test(digits) ? digits : `+852${digits}`;
};

/* ---------------- vCard generation ---------------- */
/** fold a vCard line at 75-octet boundaries WITHOUT splitting UTF-8 code points */
const fold75 = (line) => {
  const out = [];
  let cur = '';
  for (const ch of Array.from(line)) {
    if (cur && Buffer.byteLength(cur + ch, 'utf8') > 75) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
};
const escVCard = (s) =>
  String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

const buildVcf = (staff, { config }) => {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  let family, given;
  if (staff.n) {
    family = staff.n.family || '';
    given = staff.n.given || '';
  } else {
    const roman = (staff.name.en || '').trim().split(/\s+/);
    family = roman.slice(1).join(' ') || staff.name.zh;
    given = roman[0] || '';
  }
  lines.push(`N:${escVCard(family)};${escVCard(given)};;;`);
  lines.push(`FN:${escVCard(`${staff.name.zh}${staff.name.en ? ` (${staff.name.en})` : ''}`)}`);
  lines.push(`ORG:${escVCard(`${config.org.zh};${config.org.en}`)}`);
  if (staff.title?.zh) lines.push(`TITLE:${escVCard(`${staff.title.zh}${staff.title.en ? ` (${staff.title.en})` : ''}`)}`);
  lines.push(`ADR;TYPE=WORK:;;${escVCard(config.address.zh)};;;;Hong Kong`);
  if (staff.phone_work) lines.push(`TEL;TYPE=WORK,VOICE:${escVCard(normalizeTel(staff.phone_work))}`);
  if (staff.phone_mobile) lines.push(`TEL;TYPE=CELL,VOICE:${escVCard(normalizeTel(staff.phone_mobile))}`);
  if (staff.email) lines.push(`EMAIL;TYPE=WORK,INTERNET:${escVCard(staff.email)}`);
  lines.push(`URL:${escVCard(config.org_site)}`);
  const img = resolveImage(staff.slug, 'avatar');
  if (img && fs.statSync(img.abs).size <= 200 * 1024) {
    const b64 = fs.readFileSync(img.abs).toString('base64');
    const ext = path.extname(img.abs).slice(1).toUpperCase();
    lines.push(`PHOTO;TYPE=${ext};ENCODING=b:${b64}`);
  }
  lines.push(`REV:${new Date(staff.updated_at || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  lines.push('END:VCARD');
  return lines.map(fold75).join('\r\n') + '\r\n';
};

/* ---------------- page rendering ---------------- */
const tpl = fs.readFileSync(path.join(TPL_DIR, 'card.html'), 'utf8');
const CSS = fs.readFileSync(path.join(TPL_DIR, 'style.css'), 'utf8');

const modalJs = `function toggleWechat(show){var m=document.getElementById('wechatModal');if(!m)return;if(show){m.classList.remove('hidden');document.body.style.overflow='hidden';}else{m.classList.add('hidden');document.body.style.overflow='';}}`;

const renderLangLinks = (slug, lang) =>
  LANGS.map((l) => {
    const active = l === lang;
    const href = l === DEFAULT_LANG ? staffPagePath(slug, l) : `${BASE_PATH}/${slug}/${l}/`;
    return `<a href="${escHtml(href)}" class="lang-btn ${active ? 'active' : 'inactive'}" lang="${HTML_LANG[l]}">${LANG_LABEL[l]}</a>`;
  }).join('\n            ');

const renderBanner = (staff, root) => {
  const img = staff.images?.banner ? resolveImage(staff.slug, 'banner') : null;
  if (img) {
    copyFile(img.abs, path.join('assets', 'staff', staff.slug, path.basename(img.rel)));
    return `<img src="${root}${img.rel}" alt="" class="banner-img" decoding="async">`;
  }
  return `<div class="banner-fallback"><span>${escHtml(config.org.zh)}</span></div>`;
};

const renderAvatar = (staff, root) => {
  const img = staff.images?.avatar ? resolveImage(staff.slug, 'avatar') : null;
  if (img) {
    copyFile(img.abs, path.join('assets', 'staff', staff.slug, path.basename(img.rel)));
    return `<img src="${root}${img.rel}" alt="${escHtml(staff.name.zh)}" class="avatar-img" loading="lazy">`;
  }
  return `<img src="${root}assets/logo.png" alt="${escHtml(config.org.zh)}" class="avatar-img">`;
};

const renderContacts = (staff, lang) => {
  const items = [];
  if (staff.email)
    items.push(
      `<li class="contact-item"><span class="contact-icon">${icon('envelope')}</span><a class="link-email contact-label" href="mailto:${escHtml(staff.email)}">${escHtml(staff.email)}</a></li>`
    );
  if (staff.phone_work)
    items.push(
      `<li class="contact-item"><span class="contact-icon">${icon('phone')}</span><a class="contact-label" href="tel:${escHtml(normalizeTel(staff.phone_work))}" style="text-decoration:none;color:inherit;">${escHtml(staff.phone_work)}</a></li>`
    );
  if (staff.phone_mobile)
    items.push(
      `<li class="contact-item"><span class="contact-icon">${icon('mobile')}</span><a class="contact-label" href="tel:${escHtml(normalizeTel(staff.phone_mobile))}" style="text-decoration:none;color:inherit;">${escHtml(staff.phone_mobile)}</a></li>`
    );
  items.push(
    `<li class="contact-item"><span class="contact-icon">${icon('building')}</span><span class="contact-label" style="font-weight:500;color:#374151;">${escHtml(config.org[lang])}</span></li>`
  );
  items.push(
    `<li class="contact-item" style="align-items:flex-start;"><span class="contact-icon" style="margin-top:0.15rem;">${icon('map-pin')}</span><span class="contact-label">${escHtml(config.address[lang])}</span></li>`
  );
  return items.join('\n                ');
};

const renderChatButtons = (staff, root, lang) => {
  const parts = [];
  const qr = staff.images?.wechat_qr ? resolveImage(staff.slug, 'wechat_qr') : null;
  if (qr) {
    copyFile(qr.abs, path.join('assets', 'staff', staff.slug, path.basename(qr.rel)));
    parts.push(
      `<button type="button" onclick="toggleWechat(true)" title="${escHtml(WECHAT_LABEL[lang])}" class="icon-btn wechat-btn" aria-haspopup="dialog">${icon('weixin')}</button>`,
      `<!--#WECHAT#-->`
    );
  }
  if (staff.phone_mobile) {
    const wa = normalizeTel(staff.phone_mobile).replace(/[^\d]/g, '');
    parts.push(
      `<a href="https://wa.me/${wa}" target="_blank" rel="noopener" title="${escHtml(WHATSAPP_LABEL[lang])}" class="icon-btn whatsapp-btn">${icon('whatsapp')}</a>`
    );
  }
  if (!parts.length) return '';
  const label = qr ? escHtml(WECHAT_LABEL[lang]) : escHtml(WHATSAPP_LABEL[lang]);
  return `<div class="chat-buttons">\n                ${parts.join('\n                ')}\n                <span class="chat-label">${label}</span>\n            </div>`;
};

const renderWechatModal = (staff, root, lang) => {
  const qr = staff.images?.wechat_qr ? resolveImage(staff.slug, 'wechat_qr') : null;
  if (!qr) return '';
  return `
    <div id="wechatModal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-label="${escHtml(WECHAT_LABEL[lang])}" onclick="toggleWechat(false)">
        <div class="modal-card" onclick="event.stopPropagation()">
            <button type="button" onclick="toggleWechat(false)" class="modal-close" aria-label="Close">&times;</button>
            <h3 class="modal-title">${escHtml(WECHAT_LABEL[lang])}</h3>
            <div class="modal-img-box">
                <img src="${root}${qr.rel}" alt="${escHtml(WECHAT_LABEL[lang])} QR" class="modal-img">
            </div>
            <p class="modal-hint">${escHtml(QR_HINT[lang])}</p>
        </div>
    </div>`;
};

const renderTabs = (staff, lang) => {
  const tabs = [
    ['about', true],
    ['social', staff.social_links?.length > 0],
    ['links', staff.custom_links?.length > 0],
  ];
  return tabs
    .filter(([, show]) => show)
    .map(([key], i) => `<a href="#${key}" class="nav-item ${i === 0 ? 'active' : ''}">${escHtml(TABS_I18N[key][lang])}</a>`)
    .join('\n                ');
};

const renderSections = (staff, lang, root) => {
  const parts = [];
  let first = true;
  const sep = () => (first ? ((first = false), '') : '<hr class="hr-line">\n            \n            ');
  parts.push(`${sep()}            <section id="about">
                <h3 class="section-title">${escHtml(TABS_I18N.about[lang])}</h3>
                <p class="about-text">${escHtml(config.about[lang] || '')}</p>
            </section>`);
  if (staff.social_links?.length) {
    const items = staff.social_links
      .map(
        (s) =>
          `<a href="${escHtml(s.url)}" target="_blank" rel="noopener" title="${escHtml(s.platform)}" class="social-item" style="color:${escHtml(s.color || 'inherit')};">${icon(s.icon || 'globe')}</a>`
      )
      .join('\n                                            ');
    parts.push(`${sep()}            <section id="social">
                <h3 class="section-title">${escHtml(TABS_I18N.social[lang])}</h3>
                <div class="social-list">
                                            ${items}
                                    </div>
            </section>`);
  }
  if (staff.custom_links?.length) {
    const items = staff.custom_links
      .map(
        (l) =>
          `<a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="link-item">
                            <div class="link-icon-box" style="color:${escHtml(l.color || 'inherit')};">${icon(l.icon || 'globe')}</div>
                            <span class="link-text" style="color:${escHtml(l.color || 'inherit')};">${escHtml(l.title[lang] || l.title.zh)}</span>
                            <span class="link-chevron">${icon('chevron')}</span>
                        </a>`
      )
      .join('\n                                            ');
    parts.push(`${sep()}            <section id="links">
                <h3 class="section-title">${escHtml(TABS_I18N.links[lang])}</h3>
                <div class="links-list">
                                            ${items}
                                    </div>
            </section>`);
  }
  return parts.join('\n            \n            ');
};

const renderStaffPage = (staff) => {
  for (const lang of LANGS) {
    const root = toRoot(staff.slug, lang);
    const pageRel = staffPagePath(staff.slug, lang);
    const title = `${staff.name[lang]} - SAGE E-Card`;
    const desc = `${staff.title[lang]} · ${config.org[lang]}`;
    const hreflang = LANGS.map((l) => `<link rel="alternate" hreflang="${HTML_LANG[l]}" href="${escHtml(staffUrl(staff.slug, l))}">`)
      .concat(`<link rel="alternate" hreflang="x-default" href="${escHtml(staffUrl(staff.slug, DEFAULT_LANG))}">`)
      .join('\n    ');
    const vcfRel = `${staff.slug}.vcf`;
    const vcfHref = lang === DEFAULT_LANG ? vcfRel : `../${vcfRel}`;
    const html = tpl
      .replaceAll('{{HTML_LANG}}', HTML_LANG[lang])
      .replaceAll('{{TITLE_TAG}}', escHtml(title))
      .replaceAll('{{OG_DESC}}', escHtml(desc))
      .replaceAll('{{CANONICAL}}', escHtml(staffUrl(staff.slug, lang)))
      .replaceAll('{{BASE}}', root)
      .replaceAll('{{OG_TITLE}}', escHtml(title))
      .replaceAll('{{OG_URL}}', escHtml(staffUrl(staff.slug, lang)))
      .replaceAll('{{OG_IMAGE}}', escHtml(`${SITE_URL}${BASE_PATH}/assets/logo.png`))
      .replaceAll('{{ORG_NAME}}', escHtml(config.org[lang]))
      .replaceAll('{{HREFLANG}}', hreflang)
      .replaceAll('{{CSS}}', cssSafe(CSS))
      .replaceAll('{{LANG_LINKS}}', renderLangLinks(staff.slug, lang))
      .replaceAll('{{BANNER}}', renderBanner(staff, root))
      .replaceAll('{{AVATAR}}', renderAvatar(staff, root))
      .replaceAll('{{NAME}}', escHtml(staff.name[lang]))
      .replaceAll('{{TITLE}}', escHtml(staff.title[lang] || ''))
      .replaceAll('{{CONTACTS}}', renderContacts(staff, lang))
      .replaceAll('{{CHAT_BUTTONS}}', renderChatButtons(staff, root, lang))
      .replaceAll('{{TABS}}', renderTabs(staff, lang))
      .replaceAll('{{SECTIONS}}', renderSections(staff, lang, root))
      .replaceAll('{{VERSION}}', escHtml(config.site.version))
      .replaceAll('{{COPYRIGHT}}', escHtml(config.site.copyright))
      .replaceAll('{{VCF_HREF}}', vcfHref)
      .replaceAll('{{SAVE_LABEL}}', escHtml(SAVE_I18N[lang]))
      .replaceAll('{{WECHAT_MODAL}}', renderWechatModal(staff, root, lang))
      .replaceAll('{{JS}}', modalJs);
    const relFile = lang === DEFAULT_LANG ? `${staff.slug}/index.html` : `${staff.slug}/${lang}/index.html`;
    write(relFile, html);
  }
};

/** guard CSS against a stray </style> inside content */
const cssSafe = (css) => css.replace(/<\/style/gi, '<\\/style');

/* ---------------- index page (staff list) ---------------- */
const renderIndex = () => {
  const lang = DEFAULT_LANG;
  const cards = staffs
    .map(({ data: s }) => {
      const avatar = s.images?.avatar ? resolveImage(s.slug, 'avatar') : null;
      if (avatar) copyFile(avatar.abs, avatar.rel);
      const inner = avatar ? `<img src="${avatar.rel}" alt="" loading="lazy">` : icon('user');
      return `<a class="staff-card" href="${escHtml(staffPagePath(s.slug, lang))}">
            <span class="avatar">${inner}</span>
            <span class="n">${escHtml(s.name[lang])}</span>
            <span class="t">${escHtml(s.title[lang] || '')}</span>
        </a>`;
    })
    .join('\n        ');
  return `<!DOCTYPE html>
<html lang="${HTML_LANG[lang]}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(config.org[lang])} - E-Card</title>
<meta name="description" content="${escHtml(config.org[lang])} 電子名片">
<link rel="canonical" href="${escHtml(SITE_URL + BASE_PATH + '/')}">
<meta property="og:title" content="${escHtml(config.org[lang])} - E-Card">
<meta property="og:url" content="${escHtml(SITE_URL + BASE_PATH + '/')}">
<meta property="og:image" content="${escHtml(SITE_URL + BASE_PATH + '/assets/logo.png')}">
<meta name="theme-color" content="#00834d">
<style>${cssSafe(CSS)}</style>
</head>
<body class="index-page">
<header class="site-head">
    <img src="assets/logo.png" alt="${escHtml(config.org[lang])}">
    <h1>${escHtml(config.org[lang])} 電子名片</h1>
    <p>${escHtml(config.site.version)}</p>
</header>
<main class="staff-grid">
        ${cards}
</main>
<footer class="site-foot">
    <p>${escHtml(config.site.copyright)}</p>
</footer>
</body>
</html>`;
};

/* ---------------- sitemap + robots ---------------- */
const renderSitemap = () => {
  const urls = staffs.flatMap(({ data: s }) =>
    LANGS.map((l) => `  <url><loc>${escXml(staffUrl(s.slug, l))}</loc><lastmod>${s.updated_at?.slice(0, 10) || ''}</lastmod></url>`)
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
};
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------------- main ---------------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* assets */
const logo = path.join(ASSET_SRC, 'org', 'logo.png');
if (fs.existsSync(logo)) copyFile(logo, 'assets/logo.png');

/* pages */
for (const { data: s } of staffs) {
  renderStaffPage(s);
  const slugDir = path.join(OUT, s.slug);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, `${s.slug}.vcf`), buildVcf(s, { config }));
}
write('index.html', renderIndex());
write('sitemap.xml', renderSitemap());
write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}${BASE_PATH}/sitemap.xml\n`);
write('.nojekyll', '');

console.log(`✓ built ${staffs.length} staff × ${LANGS.length} langs → dist/`);
console.log(staffs.map((s) => `  /${s.data.slug}/ (${LANGS.map((l) => `${l}:${staffPagePath(s.data.slug, l)}`).join(', ')})`).join('\n'));