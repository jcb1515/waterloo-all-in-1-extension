// @ts-check
/*
  Minimal ZIP reader for the Google Calendar export: EOCD + central
  directory, methods 0 (stored) and 8 (deflate-raw, via DecompressionStream
  — works in the service worker and Node 18+). The central directory is
  authoritative for names, sizes and data offsets; entries with other
  methods are skipped. Safety caps bound decompression bombs.
*/

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export const ZIP_MAX_ENTRIES = 50;
export const ZIP_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/** @param {Uint8Array} raw @returns {Promise<Uint8Array>} */
async function inflateRaw(raw) {
  // Blob wants an ArrayBuffer-backed view; subarrays share the source's.
  const copy = new Uint8Array(raw.length);
  copy.set(raw);
  const buf = await new Response(
    new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * @param {Uint8Array|ArrayBuffer} buf
 * @returns {Promise<{name: string, bytes: Uint8Array}[]>}
 */
export async function readZip(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @param {number} o */
  const u16 = (o) => dv.getUint16(o, true);
  /** @param {number} o */
  const u32 = (o) => dv.getUint32(o, true);
  const dec = new TextDecoder();

  // EOCD sits within the last 22 + 65535 bytes (comment allowed).
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 0xffff); p--) {
    if (u32(p) === EOCD_SIG && p + 22 + u16(p + 20) <= bytes.length) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: no end record");
  if (u16(eocd + 4) || u16(eocd + 6)) throw new Error("zip: multi-disk");

  /** @type {{name: string, bytes: Uint8Array}[]} */
  const out = [];
  let entries = 0;
  let total = 0;
  for (let p = u32(eocd + 16); p + 46 <= bytes.length && u32(p) === CDIR_SIG; ) {
    entries++;
    if (entries > ZIP_MAX_ENTRIES) throw new Error("zip: too many entries");
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const uncompSize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOff = u32(p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (uncompSize > ZIP_MAX_ENTRY_BYTES) throw new Error("zip: entry too large");
    if (method !== 0 && method !== 8) continue;
    if (localOff + 30 > bytes.length || u32(localOff) !== LOCAL_SIG) continue;
    const start = localOff + 30 + u16(localOff + 26) + u16(localOff + 28);
    if (start + compSize > bytes.length) continue;
    const raw = bytes.subarray(start, start + compSize);

    const data = method === 0 ? new Uint8Array(raw) : await inflateRaw(raw);
    if (data.length > ZIP_MAX_ENTRY_BYTES) throw new Error("zip: entry too large");
    total += data.length;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new Error("zip: too large");
    out.push({ name, bytes: data });
  }
  if (!entries) throw new Error("zip: empty");
  return out;
}
