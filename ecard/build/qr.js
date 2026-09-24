'use strict';

/**
 * SAGE E-Card — zero-dependency QR Code encoder (byte mode, versions 1–10)
 *
 * Implements the minimum of ISO/IEC 18004 needed to encode short URLs:
 *   - byte (8-bit) mode data encoding
 *   - Reed–Solomon error correction
 *   - block interleaving
 *   - matrix placement (finder / timing / alignment patterns, format + version info)
 *   - 8 mask patterns with penalty-based selection
 *
 * Output is an SVG string via qrSvg(). No npm dependencies, no network.
 *
 * Usage:
 *   const { qrSvg } = require('./qr');
 *   const svg = qrSvg('https://example.com/path');
 */

/* ---------------- GF(256) arithmetic ---------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed–Solomon generator polynomial of given degree */
function rsGenPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** compute `degree` Reed–Solomon codewords for data */
function rsEncode(data, degree) {
  const gen = rsGenPoly(degree);
  const res = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

/* ---------------- version / capacity tables (byte mode, EC level L) ---------------- */
/* For each version: total codewords, EC codewords per block, block counts (group1,group2),
   and data codewords per block. Level L only — sufficient for short URLs. */
const EC_L = {
  1:  { ecPerBlock: 7,  groups: [[1, 19]], align: 0 },
  2:  { ecPerBlock: 10, groups: [[1, 34]], align: 6 },
  3:  { ecPerBlock: 15, groups: [[1, 55]], align: 6 },
  4:  { ecPerBlock: 20, groups: [[1, 80]], align: 6 },
  5:  { ecPerBlock: 26, groups: [[1, 108]], align: 6 },
  6:  { ecPerBlock: 18, groups: [[2, 68]], align: 6 },
  7:  { ecPerBlock: 20, groups: [[2, 78]], align: 6 },
  8:  { ecPerBlock: 24, groups: [[2, 97]], align: 6 },
  9:  { ecPerBlock: 30, groups: [[2, 116]], align: 6 },
  10: { ecPerBlock: 18, groups: [[2, 68], [2, 69]], align: 6 },
};

/** alignment pattern centre coordinates per version */
const ALIGN_POS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const totalDataCodewords = (v) =>
  EC_L[v].groups.reduce((sum, [count, per]) => sum + count * per, 0);

/* ---------------- bit buffer ---------------- */
class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 0x80 >> (i & 7); });
    return bytes;
  }
}

/* ---------------- encode data to final codeword sequence ---------------- */
function utf8Bytes(str) {
  const out = [];
  for (const ch of str) {
    let cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) { out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)); }
    else if (cp < 0x10000) { out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
    else { out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
  }
  return out;
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const capBits = totalDataCodewords(v) * 8;
    const needed = 4 + (v <= 9 ? 8 : 16) + byteLen * 8;
    if (needed <= capBits) return v;
  }
  throw new Error(`data too long for QR version 1–10 (${byteLen} bytes)`);
}

function encodeData(text) {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length);
  const info = EC_L[version];
  const totalData = totalDataCodewords(version);

  const bb = new BitBuffer();
  bb.put(0b0100, 4);                       // byte mode
  bb.put(bytes.length, version <= 9 ? 8 : 16); // char count
  for (const b of bytes) bb.put(b, 8);
  // terminator
  const capBits = totalData * 8;
  for (let i = 0; i < 4 && bb.length < capBits; i++) bb.put(0, 1);
  // pad to byte boundary
  while (bb.length % 8 !== 0) bb.put(0, 1);
  // pad codewords
  const pad = [0xec, 0x11];
  let pi = 0;
  const dataBytes = Array.from(bb.toBytes());
  while (dataBytes.length < totalData) dataBytes.push(pad[pi++ % 2]);

  /* split into blocks and compute EC */
  const blocks = [];
  let offset = 0;
  for (const [count, per] of info.groups) {
    for (let i = 0; i < count; i++) {
      const data = dataBytes.slice(offset, offset + per);
      offset += per;
      blocks.push({ data, ec: rsEncode(data, info.ecPerBlock) });
    }
  }

  /* interleave */
  const result = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) result.push(b.data[i]);
  for (let i = 0; i < info.ecPerBlock; i++) for (const b of blocks) result.push(b.ec[i]);

  return { version, codewords: result };
}

/* ---------------- matrix construction ---------------- */
function newMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null)); // null = unset
}

function placeFinder(m, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[rr][cc] = inRing ? 1 : 0;
    }
  }
}

function placeStaticPatterns(m, version) {
  const size = m.length;
  /* finders + separators */
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  /* timing patterns */
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  /* alignment patterns */
  const pos = ALIGN_POS[version];
  for (const r of pos) {
    for (const c of pos) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = dark ? 1 : 0;
        }
      }
    }
  }
  /* reserve format info areas (filled later) */
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    m[8][size - 1 - i] = 0;
    m[size - 1 - i][8] = 0;
  }
  m[size - 8][8] = 1; // dark module
}

/** is (r,c) a function pattern (already reserved)? */
function reserved(version, size, r, c) {
  if (r < 9 && c < 9) return true;
  if (r < 9 && c >= size - 8) return true;
  if (r >= size - 8 && c < 9) return true;
  if (r === 6 || c === 6) return true;
  const pos = ALIGN_POS[version];
  for (const ar of pos) {
    for (const ac of pos) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
    }
  }
  return false;
}

/** place data bits in zig-zag, applying a mask function */
function placeData(m, version, codewords, maskFn) {
  const size = m.length;
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  let idx = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved(version, size, row, c)) continue;
        let bit = idx < bits.length ? bits[idx++] : 0;
        if (maskFn(row, c)) bit ^= 1;
        m[row][c] = bit;
      }
    }
    up = !up;
  }
}

/* ---------------- mask patterns ---------------- */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/* ---------------- format information ---------------- */
function formatBits(ecLevel, mask) {
  // ecLevel: L=01, M=00, Q=11, H=10. We use L.
  const ecBits = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }[ecLevel];
  let data = (ecBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function placeFormat(m, ecLevel, mask) {
  const size = m.length;
  const bits = formatBits(ecLevel, mask);
  // QR spec numbers format bits 14 (MSB) .. 0 (LSB).
  // Position order below follows that MSB-first convention.
  const b = (i) => (bits >> i) & 1; // i = spec bit number

  /* --- copy 1: around the top-left finder --- */
  for (let i = 0; i <= 5; i++) m[8][i] = b(14 - i);      // (8,0)..(8,5)   = bits 14..9
  m[8][7] = b(8);                                        // (8,7)          = bit 8
  m[8][8] = b(7);                                        // (8,8)          = bit 7
  m[7][8] = b(6);                                        // (7,8)          = bit 6
  for (let i = 0; i <= 5; i++) m[i][8] = b(i);           // (0,8)..(5,8)   = bits 0..5

  /* --- copy 2: split between bottom-left and top-right --- */
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = b(14 - i); // col 8 bottom rows = bits 14..8
  for (let i = 0; i <= 7; i++) m[8][size - 8 + i] = b(7 - i);  // row 8 right cols  = bits 7..0

  m[size - 8][8] = 1; // fixed dark module
}

/* ---------------- penalty scoring ---------------- */
function penalty(m) {
  const size = m.length;
  let score = 0;
  // rule 1: runs of 5+
  const lineRun = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  lineRun((a, b) => m[a][b]); // rows
  lineRun((a, b) => m[b][a]); // cols
  // rule 2: 2x2 same-colour blocks
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
  // rule 3: finder-like patterns (scan each row and each column)
  const patA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const scanLine = (get) => {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b <= size - 11; b++) {
        let okA = true, okB = true;
        for (let k = 0; k < 11; k++) {
          const v = get(a, b + k);
          if (v !== patA[k]) okA = false;
          if (v !== patB[k]) okB = false;
        }
        if (okA) score += 40;
        if (okB) score += 40;
      }
    }
  };
  scanLine((row, col) => m[row][col]); // rows
  scanLine((row, col) => m[col][row]); // columns
  // rule 4: dark/light balance
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/* ---------------- public API ---------------- */
function qrMatrix(text, opts = {}) {
  const { version, codewords } = encodeData(text);
  const size = version * 4 + 17;

  const build = (mask) => {
    const m = newMatrix(size);
    placeStaticPatterns(m, version);
    placeData(m, version, codewords, MASKS[mask]);
    placeFormat(m, 'L', mask);
    return m;
  };

  // allow forcing a specific mask (useful for testing / reproducibility)
  if (typeof opts.mask === 'number' && opts.mask >= 0 && opts.mask <= 7) {
    return build(opts.mask);
  }

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(mask);
    const p = penalty(m);
    if (!best || p < best.penalty) best = { m, penalty: p, mask };
  }
  return best.m;
}

/**
 * Render a QR code as an SVG string.
 * @param {string} text   content to encode
 * @param {object} [opts]
 * @param {number} [opts.quiet=4]    quiet-zone modules (spec recommends 4)
 * @param {string} [opts.dark='#000'] dark module colour
 * @param {string} [opts.light='#fff'] light/background colour
 * @param {string} [opts.cls]        class attribute for the <svg>
 * @param {string} [opts.title]      accessible title (optional)
 */
function qrSvg(text, opts = {}) {
  const quiet = opts.quiet ?? 4;
  const dark = opts.dark || '#000';
  const light = opts.light || '#fff';
  const m = qrMatrix(text);
  const n = m.length;
  const total = n + quiet * 2;

  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const title = opts.title ? `<title>${escapeXml(opts.title)}</title>` : '';
  return (
    `<svg${opts.cls ? ` class="${opts.cls}"` : ''} xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="${escapeXml(opts.title || 'QR Code')}">` +
    `${title}<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = { qrMatrix, qrSvg };
