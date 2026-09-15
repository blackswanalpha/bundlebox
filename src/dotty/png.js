// png.js — is this frame a picture of anything.
//
// The rule this file exists to hold, carried over from the prototype dotty:
// **a frame that came back single-coloured is marked BLANK.** `screencap` on at
// least one device returns a black image, and headless Chrome returns a white
// one for a page that has not painted; both are the same failure, and both look
// exactly like a successful capture from the outside. A run that files a black
// rectangle as evidence is worse than one that files nothing, because a later
// session opens it, sees nothing wrong with the file, and concludes the screen
// was blank.
//
// Same family as `unknown` in a recom verdict and `unproven` on a unit with no
// acceptance: the answer that says the instrument could not see.
//
// PNG is DEFLATE, and Node has zlib, so this needs no dependency. The scanline
// filters have to be reversed before the pixels mean anything — an unfiltered
// comparison would call almost every screenshot uniform, because the Sub and Up
// filters turn a flat region into a run of zero bytes.
import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** IHDR plus the concatenated IDAT payload. Null when this is not a PNG. */
export function chunks(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr || ihdr.length < 13) return null;
  return {
    width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4),
    depth: ihdr[8], colorType: ihdr[9], interlace: ihdr[12],
    idat: Buffer.concat(idat),
  };
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Reverse the per-scanline filters, in place, one row at a time. */
function unfilter(raw, rowBytes, height, bpp) {
  const out = Buffer.alloc(rowBytes * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      row[x] = filter === 0 ? v
        : filter === 1 ? (v + a) & 0xff
          : filter === 2 ? (v + b) & 0xff
            : filter === 3 ? (v + ((a + b) >> 1)) & 0xff
              : (v + paeth(a, b, c)) & 0xff;
    }
    src += rowBytes;
  }
  return out;
}

/** How many distinct pixels this frame has, capped, and whether that makes it
 *  blank.
 *
 *  `blank: null` means the question could not be answered — an interlaced PNG,
 *  a bit depth this does not decode, a corrupt stream. Null is not false: a
 *  frame nobody could check must not be reported as a frame that was fine. */
export function inspect(buf, { sample = 4096 } = {}) {
  const c = chunks(buf);
  if (!c) return { blank: null, why: "not a PNG", bytes: buf?.length || 0 };
  const base = { width: c.width, height: c.height, bytes: buf.length };
  if (c.interlace !== 0) return { ...base, blank: null, why: "interlaced PNG is not decoded here" };
  if (c.depth !== 8) return { ...base, blank: null, why: `bit depth ${c.depth} is not decoded here` };
  const ch = CHANNELS[c.colorType];
  if (!ch) return { ...base, blank: null, why: `colour type ${c.colorType} is not decoded here` };

  let raw;
  try { raw = zlib.inflateSync(c.idat); }
  catch (e) { return { ...base, blank: null, why: `inflate failed: ${e.message}` }; }

  const rowBytes = c.width * ch;
  if (raw.length < (rowBytes + 1) * c.height) return { ...base, blank: null, why: "truncated image data" };
  const px = unfilter(raw, rowBytes, c.height, ch);

  // A grid rather than every pixel: a 1440p screenshot is eight million of
  // them, and a page with any content at all differs within the first few
  // hundred samples. The grid is deterministic, so two runs on one frame agree.
  const stepY = Math.max(1, Math.floor(c.height / Math.sqrt(sample)));
  const stepX = Math.max(1, Math.floor(c.width / Math.sqrt(sample)));
  const first = px.subarray(0, ch);
  let distinct = 1;
  let seen = 0;
  for (let y = 0; y < c.height; y += stepY) {
    for (let x = 0; x < c.width; x += stepX) {
      seen++;
      const i = y * rowBytes + x * ch;
      for (let k = 0; k < ch; k++) {
        if (px[i + k] !== first[k]) { distinct = 2; break; }
      }
      if (distinct > 1) break;
    }
    if (distinct > 1) break;
  }
  const colour = [...first].join(",");
  return {
    ...base, blank: distinct === 1, sampled: seen,
    colour: distinct === 1 ? colour : null,
    why: distinct === 1 ? `every one of ${seen} sampled pixels is ${colour}` : "",
  };
}
