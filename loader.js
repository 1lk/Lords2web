// Data loading for the web port.
//
// The page ships only the recompiled game logic (lords2.wasm).  Everything that belongs to the original
// game - the executable image's data section, graphics, sounds, maps - is taken from the player's own copy of
// the "Lords of the Realm II" demo installer (lorddemo.exe), unpacked in the browser and cached locally.

export const EXPECTED_EXE = { size: 718848, crc32: 0x490e9d4f, imageBase: 0x400000, imageSize: 0x15c000, entryRva: 0x86700 };

// ---------------------------------------------------------------- zip (PKZIP self-extractors included)
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

export function listZip(d) {
  let e = -1;
  for (let i = d.length - 22; i >= Math.max(0, d.length - 22 - 65536); i--) {
    if (d[i] === 0x50 && d[i + 1] === 0x4b && d[i + 2] === 5 && d[i + 3] === 6) { e = i; break; }
  }
  if (e < 0) throw new Error('not a zip / self-extractor');
  const count = u16(d, e + 10), cdSize = u32(d, e + 12), cdOff = u32(d, e + 16);
  const cdStart = e - cdSize;
  const delta = cdStart - cdOff;                      // size of a prepended self-extractor stub, if offsets are relative
  const out = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (u32(d, p) !== 0x02014b50) throw new Error('bad central directory');
    const method = u16(d, p + 10), csize = u32(d, p + 20), usize = u32(d, p + 24);
    const nl = u16(d, p + 28), xl = u16(d, p + 30), cl = u16(d, p + 32), lho = u32(d, p + 42) + delta;
    const name = new TextDecoder('latin1').decode(d.subarray(p + 46, p + 46 + nl));
    out.push({ name, method, csize, usize, lho });
    p += 46 + nl + xl + cl;
  }
  return out;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function zipEntry(d, ent) {
  const p = ent.lho;
  if (u32(d, p) !== 0x04034b50) throw new Error('bad local header for ' + ent.name);
  const start = p + 30 + u16(d, p + 26) + u16(d, p + 28);
  const raw = d.subarray(start, start + ent.csize);
  if (ent.method === 0) return raw.slice();
  if (ent.method === 8) return inflateRaw(raw);
  throw new Error('unsupported zip method ' + ent.method + ' for ' + ent.name);
}

// ---------------------------------------------------------------- crc32
let crcTable = null;
export function crc32(d) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- locate the game files inside whatever the player gave us
// Accepts: the original installer (zip inside a self-extractor inside another one), the inner installer,
// or a plain zip of the game folder.  Returns Map(UPPERCASE BASENAME -> Uint8Array) of everything in FILES/.
export async function extractGameFiles(bytes, progress = () => {}) {
  let level = 0;
  let cur = bytes;
  for (;;) {
    const ents = listZip(cur);
    const files = ents.filter((e) => /(^|[\\/])files[\\/][^\\/]+$/i.test(e.name));
    if (files.some((e) => /lords2\.exe$/i.test(e.name))) {
      const out = new Map();
      let n = 0;
      for (const e of files) {
        const base = e.name.split(/[\\/]/).pop().toUpperCase();
        out.set(base, await zipEntry(cur, e));
        progress(++n / files.length);
      }
      return out;
    }
    const nested = ents.find((e) => /\.exe$/i.test(e.name) && e.usize > 1000000);
    if (!nested || ++level > 3) throw new Error('This does not look like the Lords of the Realm II demo installer.');
    progress(0);
    cur = await zipEntry(cur, nested);
  }
}

export function checkExe(exe) {
  if (exe.length !== EXPECTED_EXE.size || crc32(exe) !== EXPECTED_EXE.crc32)
    throw new Error('LORDS2.EXE is not the build this port was made from (expected the Lords of the Realm II demo, 718,848 bytes).');
}

// ---------------------------------------------------------------- PE image (what the Windows loader would produce)
export function buildImage(exe) {
  const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const pe = dv.getUint32(0x3c, true);
  const nsec = dv.getUint16(pe + 6, true), optSize = dv.getUint16(pe + 20, true), opt = pe + 24;
  const sizeOfImage = dv.getUint32(opt + 56, true), sizeOfHeaders = dv.getUint32(opt + 60, true);
  const img = new Uint8Array(sizeOfImage);
  img.set(exe.subarray(0, sizeOfHeaders), 0);
  let sec = opt + optSize;
  const sections = [];
  for (let i = 0; i < nsec; i++, sec += 40) {
    const vsize = dv.getUint32(sec + 8, true), rva = dv.getUint32(sec + 12, true);
    const rawsize = dv.getUint32(sec + 16, true), rawptr = dv.getUint32(sec + 20, true);
    const n = vsize ? Math.min(rawsize, vsize) : rawsize;
    img.set(exe.subarray(rawptr, rawptr + n), rva);
    sections.push({ name: new TextDecoder().decode(exe.subarray(sec, sec + 8)).replace(/\0.*$/, ''), rva, vsize });
  }
  const rsrc = sections.find((s) => s.name === '.rsrc');
  return { image: img, rsrcRva: rsrc ? rsrc.rva : 0 };
}

// ---------------------------------------------------------------- cursors from the PE resources
// Returns { id: { url, hx, hy } } where id is the resource id the game passes to LoadCursor (102..113).
export function extractCursors(image) {
  const dv = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const peOff = dv.getUint32(0x3c, true);
  const resRva = dv.getUint32(peOff + 24 + 96 + 16, true);
  if (!resRva) return {};
  const entries = (dirOff) => {
    const n = dv.getUint16(resRva + dirOff + 12, true) + dv.getUint16(resRva + dirOff + 14, true);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ id: dv.getUint32(resRva + dirOff + 16 + 8 * i, true), off: dv.getUint32(resRva + dirOff + 20 + 8 * i, true) });
    return out;
  };
  const leaf = (off) => {                       // follow name/language levels down to the data entry
    let o = off;
    while (o & 0x80000000) o = entries(o & 0x7fffffff)[0].off;
    const rva = dv.getUint32(resRva + o, true), size = dv.getUint32(resRva + o + 4, true);
    return image.subarray(rva, rva + size);
  };
  const byType = {};
  for (const t of entries(0)) {
    if (!(t.off & 0x80000000)) continue;
    byType[t.id] = {};
    for (const n of entries(t.off & 0x7fffffff)) byType[t.id][n.id] = n.off;
  }
  const out = {};
  const groups = byType[12] || {}, curs = byType[1] || {};
  for (const gid of Object.keys(groups)) {
    const g = leaf(groups[gid]);
    const gd = new DataView(g.buffer, g.byteOffset, g.byteLength);
    const cid = gd.getUint16(6 + 12, true);
    if (!(cid in curs)) continue;
    const c = leaf(curs[cid]);
    const cd = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const hx = cd.getUint16(0, true), hy = cd.getUint16(2, true);
    const hdr = 4, w = cd.getInt32(hdr + 4, true), h2 = cd.getInt32(hdr + 8, true), h = h2 / 2, bpp = cd.getUint16(hdr + 14, true);
    if (bpp !== 1) continue;
    const pal = hdr + 40;
    const col = (i) => [c[pal + 4 * i + 2], c[pal + 4 * i + 1], c[pal + 4 * i]];
    const rowBytes = (((w + 31) >> 5) << 2);
    const xor = pal + 8, and = xor + rowBytes * h;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const im = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const sy = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const xb = (c[xor + sy * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const ab = (c[and + sy * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const o = (y * w + x) * 4;
        if (ab && !xb) { im.data[o + 3] = 0; continue; }          // transparent
        const [r, g2, b] = ab && xb ? [255, 255, 255] : col(xb);  // (and=1,xor=1 is "invert": drawn white)
        im.data[o] = r; im.data[o + 1] = g2; im.data[o + 2] = b; im.data[o + 3] = 255;
      }
    }
    ctx.putImageData(im, 0, 0);
    out[gid] = { url: cv.toDataURL('image/png'), hx, hy };
  }
  return out;
}

// ---------------------------------------------------------------- IndexedDB cache (game files + saved games)
const DB_NAME = 'lords2-web', DB_VER = 1;
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('game')) db.createObjectStore('game');
      if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = (db, store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode);
  const out = fn(t.objectStore(store));
  t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error);
});

export const store = {
  async hasGame() { try { const db = await openDb(); return (await tx(db, 'game', 'readonly', (s) => s.count())) > 0; } catch { return false; } },
  async putGame(map) {
    const db = await openDb();
    await tx(db, 'game', 'readwrite', (s) => { s.clear(); for (const [k, v] of map) s.put(v, k); });
  },
  async getGame() {
    const db = await openDb();
    const keys = await tx(db, 'game', 'readonly', (s) => s.getAllKeys());
    const vals = await tx(db, 'game', 'readonly', (s) => s.getAll());
    return new Map(keys.map((k, i) => [k, vals[i]]));
  },
  async clearGame() { const db = await openDb(); await tx(db, 'game', 'readwrite', (s) => s.clear()); },
  async putSave(name, bytes) { try { const db = await openDb(); await tx(db, 'saves', 'readwrite', (s) => s.put(bytes, name)); } catch (e) { console.warn('save failed', e); } },
  async getSaves() {
    try {
      const db = await openDb();
      const keys = await tx(db, 'saves', 'readonly', (s) => s.getAllKeys());
      const vals = await tx(db, 'saves', 'readonly', (s) => s.getAll());
      return new Map(keys.map((k, i) => [k, vals[i]]));
    } catch { return new Map(); }
  },
  async clearSaves() { const db = await openDb(); await tx(db, 'saves', 'readwrite', (s) => s.clear()); },
};
