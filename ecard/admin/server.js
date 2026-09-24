'use strict';

/**
 * SAGE E-Card — local admin server (zero-dependency, Node >= 18)
 *
 * A tiny headless-CMS for the static card generator. Lets non-technical staff
 * create / edit / delete e-cards through a browser, upload images, and rebuild
 * the site — no manual JSON editing required.
 *
 * Run:  npm run admin   (or)   node admin/server.js
 * Open: http://localhost:4173
 *
 * Security note: this is a LOCAL dev tool. Do NOT expose it on a public port.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { build } = require(path.join(ROOT, 'build', 'build.js'));

const DATA_DIR = path.join(ROOT, 'data');
const STAFF_DIR = path.join(DATA_DIR, 'staff');
const ASSET_SRC = path.join(ROOT, 'assets', 'images');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const PORT = Number(process.env.PORT) || 4173;
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const IMG_KEYS = ['banner', 'avatar', 'wechat_qr'];
const MAX_BODY = 12 * 1024 * 1024; // 12 MB (covers base64 image uploads)
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* ---------------- helpers ---------------- */
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
};

/** Hong-Kong local timestamp, ISO 8601 with +08:00 offset */
function hkNow() {
  const d = new Date();
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const hk = new Date(utcMs + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${hk.getFullYear()}-${p(hk.getMonth() + 1)}-${p(hk.getDate())}` +
    `T${p(hk.getHours())}:${p(hk.getMinutes())}:${p(hk.getSeconds())}+08:00`
  );
}

function nextStaffId() {
  const files = fs.existsSync(STAFF_DIR) ? fs.readdirSync(STAFF_DIR) : [];
  let max = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = readJson(path.join(STAFF_DIR, f), {}).id || '';
    const m = /^st_(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `st_${String(max + 1).padStart(3, '0')}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}
const sendJson = (res, status, obj) => send(res, status, obj, { 'Content-Type': 'application/json; charset=utf-8' });
const sendErr = (res, status, msg) => sendJson(res, status, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** safe static file sender with traversal protection */
function sendFile(res, absPath) {
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(ROOT)) return sendErr(res, 403, 'forbidden');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return sendErr(res, 404, 'not found');
  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(resolved), { 'Content-Type': type });
}

/* ---------------- staff persistence ---------------- */
function listStaff() {
  if (!fs.existsSync(STAFF_DIR)) return [];
  return fs
    .readdirSync(STAFF_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(STAFF_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

function staffPath(slug) {
  return path.join(STAFF_DIR, `${slug}.json`);
}

/** find an image file for {slug}/{key} regardless of extension */
function findImage(slug, key) {
  const dir = path.join(ASSET_SRC, slug);
  if (!fs.existsSync(dir)) return null;
  for (const ext of IMG_EXTS) {
    const abs = path.join(dir, `${key}.${ext}`);
    if (fs.existsSync(abs)) return { abs, ext };
  }
  return null;
}

function sanitizeStaff(input, { isNew, existing }) {
  const out = existing ? { ...existing } : {};
  out.slug = String(input.slug || '').trim();
  if (!SLUG_RE.test(out.slug)) throw new Error('slug 格式無效（只能用小寫英數與連字號，例如 chan-tai-man）');

  out.name = {
    zh: String(input.name?.zh || '').trim(),
    cn: String(input.name?.cn || '').trim(),
    en: String(input.name?.en || '').trim(),
  };
  out.title = {
    zh: String(input.title?.zh || '').trim(),
    cn: String(input.title?.cn || '').trim(),
    en: String(input.title?.en || '').trim(),
  };
  out.n = {
    family: String(input.n?.family || '').trim(),
    given: String(input.n?.given || '').trim(),
  };
  out.email = String(input.email || '').trim();
  out.phone_work = String(input.phone_work || '').trim();
  out.phone_mobile = String(input.phone_mobile || '').trim();
  out.active = input.active === false ? false : true;

  out.social_links = Array.isArray(input.social_links)
    ? input.social_links
        .map((s) => ({
          platform: String(s.platform || '').trim(),
          url: String(s.url || '').trim(),
          icon: String(s.icon || 'globe').trim() || 'globe',
          color: String(s.color || '').trim(),
        }))
        .filter((s) => s.url)
    : out.social_links || [];

  out.custom_links = Array.isArray(input.custom_links)
    ? input.custom_links
        .map((l) => ({
          title: {
            zh: String(l.title?.zh || '').trim(),
            cn: String(l.title?.cn || '').trim(),
            en: String(l.title?.en || '').trim(),
          },
          url: String(l.url || '').trim(),
          icon: String(l.icon || 'globe').trim() || 'globe',
          color: String(l.color || '').trim(),
        }))
        .filter((l) => l.url)
    : out.custom_links || [];

  // images flags are kept from existing record; uploads toggle them
  if (isNew) {
    out.images = { banner: '', avatar: '', wechat_qr: '' };
    out.id = nextStaffId();
    out.created_at = hkNow();
  } else {
    out.images = existing.images || { banner: '', avatar: '', wechat_qr: '' };
  }
  out.updated_at = hkNow();
  return out;
}

/* ---------------- API ---------------- */
const api = {
  'GET /api/config': () => readJson(CONFIG_FILE, {}),

  'GET /api/staff': () =>
    listStaff().map((s) => ({
      slug: s.slug,
      active: s.active !== false,
      name: s.name || {},
      title: s.title || {},
      has_avatar: !!findImage(s.slug, 'avatar'),
    })),

  'GET /api/staff/:slug': (m) => {
    const data = readJson(staffPath(m.slug), null);
    if (!data) throw { status: 404, message: '找不到該名片' };
    data._images = {
      banner: !!findImage(m.slug, 'banner'),
      avatar: !!findImage(m.slug, 'avatar'),
      wechat_qr: !!findImage(m.slug, 'wechat_qr'),
    };
    return data;
  },

  'POST /api/staff': async (m, req) => {
    const body = JSON.parse(await readBody(req));
    if (fs.existsSync(staffPath(String(body.slug || '').trim()))) {
      throw { status: 409, message: '該 slug 已存在' };
    }
    const saved = sanitizeStaff(body, { isNew: true, existing: null });
    writeJson(staffPath(saved.slug), saved);
    return { ok: true, staff: saved };
  },

  'PUT /api/staff/:slug': async (m, req) => {
    const existing = readJson(staffPath(m.slug), null);
    if (!existing) throw { status: 404, message: '找不到該名片' };
    const body = JSON.parse(await readBody(req));
    const saved = sanitizeStaff(body, { isNew: false, existing });
    saved.slug = m.slug; // slug is the identity; not renamed via edit
    writeJson(staffPath(m.slug), saved);
    return { ok: true, staff: saved };
  },

  'DELETE /api/staff/:slug': (m) => {
    const p = staffPath(m.slug);
    if (!fs.existsSync(p)) throw { status: 404, message: '找不到該名片' };
    fs.rmSync(p, { force: true });
    fs.rmSync(path.join(ASSET_SRC, m.slug), { recursive: true, force: true });
    return { ok: true, deleted: m.slug };
  },

  'POST /api/staff/:slug/image': async (m, req) => {
    const existing = readJson(staffPath(m.slug), null);
    if (!existing) throw { status: 404, message: '找不到該名片' };
    const body = JSON.parse(await readBody(req));
    const key = String(body.key || '');
    if (!IMG_KEYS.includes(key)) throw { status: 400, message: '無效的圖片類型' };
    const dataUrl = String(body.dataUrl || '');
    const mm = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
    if (!mm) throw { status: 400, message: '需為 data:image/...;base64,... 格式' };
    let ext = mm[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!IMG_EXTS.includes(ext)) throw { status: 400, message: '不支援的圖片格式' };
    const buf = Buffer.from(mm[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) throw { status: 400, message: '圖片過大（上限 5MB）' };

    const dir = path.join(ASSET_SRC, m.slug);
    fs.mkdirSync(dir, { recursive: true });
    // remove any previous extension of this key
    for (const e of IMG_EXTS) fs.rmSync(path.join(dir, `${key}.${e}`), { force: true });
    fs.writeFileSync(path.join(dir, `${key}.${ext}`), buf);
    existing.images = existing.images || {};
    existing.images[key] = key; // truthy flag consumed by build.js
    existing.updated_at = hkNow();
    writeJson(staffPath(m.slug), existing);
    return { ok: true, key, ext };
  },

  'DELETE /api/staff/:slug/image/:key': (m) => {
    const existing = readJson(staffPath(m.slug), null);
    if (!existing) throw { status: 404, message: '找不到該名片' };
    const key = m.key;
    if (!IMG_KEYS.includes(key)) throw { status: 400, message: '無效的圖片類型' };
    for (const e of IMG_EXTS) fs.rmSync(path.join(ASSET_SRC, m.slug, `${key}.${e}`), { force: true });
    existing.images = existing.images || {};
    existing.images[key] = '';
    existing.updated_at = hkNow();
    writeJson(staffPath(m.slug), existing);
    return { ok: true, key };
  },

  'POST /api/build': () => {
    try {
      const n = build();
      return { ok: true, built: n, output: `built ${n} staff` };
    } catch (e) {
      throw { status: 500, message: 'build 失敗', detail: String((e && e.stack) || e) };
    }
  },
};

/* ---------------- router ---------------- */
function matchApi(method, url) {
  const clean = url.split('?')[0];
  for (const route of Object.keys(api)) {
    const [routeMethod, pattern] = route.split(' ');
    if (routeMethod !== method) continue;
    const pparts = pattern.split('/').filter(Boolean);
    const uparts = clean.split('/').filter(Boolean);
    if (uparts.length !== pparts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pparts.length; i++) {
      if (pparts[i].startsWith(':')) params[pparts[i].slice(1)] = decodeURIComponent(uparts[i]);
      else if (pparts[i] !== uparts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { fn: api[route], params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || '/';

    // API
    if (url.startsWith('/api/')) {
      const m = matchApi(req.method, url);
      if (!m) return sendErr(res, 404, 'API 路徑不存在');
      const fn = m.fn;
      const result = await fn(m.params, req, res);
      return sendJson(res, 200, result);
    }

    // image preview proxy (resolves extension automatically)
    let mp = /^\/preview\/([^/]+)\/([^/]+)$/.exec(url.split('?')[0]);
    if (mp) {
      const img = findImage(decodeURIComponent(mp[1]), decodeURIComponent(mp[2]));
      if (!img) return sendErr(res, 404, 'no image');
      return sendFile(res, img.abs);
    }

    // static assets: /assets/* maps to source images (assets/images/*)
    if (url.startsWith('/assets/')) {
      const rel = url.split('?')[0].replace(/^\/assets\//, '');
      return sendFile(res, path.join(ASSET_SRC, rel));
    }

    // admin UI
    if (url === '/' || url.startsWith('/index.html')) {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    return sendErr(res, 404, 'not found');
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    const message = err && err.message ? err.message : 'server error';
    const detail = err && err.detail ? err.detail : undefined;
    return sendErr(res, status, detail ? `${message} — ${detail}` : message);
  }
});

server.listen(PORT, () => {
  console.log(`\n  SAGE E-Card 後台已啟動`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
});
