// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { crc32, zipFile } from "../../tools/zip.mjs";

/** Parse a zip's central directory: [{name, crc, size, offset}]. */
function centralDir(buf) {
  // EOCD is the last 22 bytes (we write no comment).
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, "no EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `bad central sig at ${p}`);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({ name, crc, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Read one local entry's (deflated) payload back out. */
function readEntry(buf, { offset, size }) {
  assert.equal(buf.readUInt32LE(offset), 0x04034b50, "bad local sig");
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const packed = buf.subarray(offset + 30 + nameLen + extraLen, offset + 30 + nameLen + extraLen + buf.readUInt32LE(offset + 18));
  return inflateRawSync(packed).subarray(0, size);
}

test("crc32 matches known vectors", () => {
  assert.equal(crc32(Buffer.from("")), 0);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("hello world\n")), 2936552237);
});

test("zipFile round-trips names, CRCs and contents", () => {
  const files = [
    { name: "manifest.json", data: Buffer.from('{"name":"x"}') },
    { name: "src/panel/main.js", data: Buffer.from("console.log(1);".repeat(400)) },
    { name: "icons/icon-128.png", data: Buffer.alloc(4096, 7) },
  ];
  const zip = zipFile(files);
  const dir = centralDir(zip);
  assert.deepEqual(dir.map((d) => d.name), files.map((f) => f.name));
  for (let i = 0; i < files.length; i++) {
    assert.equal(dir[i].crc, crc32(files[i].data), `${dir[i].name} crc`);
    assert.equal(dir[i].size, files[i].data.length, `${dir[i].name} size`);
    assert.deepEqual(readEntry(zip, dir[i]), files[i].data, `${dir[i].name} data`);
  }
});
