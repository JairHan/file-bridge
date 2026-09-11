const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const sandbox = { window: {}, Blob, TextEncoder };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/zip.js'), 'utf8'), sandbox);
const { build } = sandbox.window.ZipArchive;

const decoder = new TextDecoder();

function fakeFile(content, lastModified = 1700000000000) {
  const blob = new Blob([content]);
  blob.lastModified = lastModified;
  return blob;
}

// Independent ZIP parser used to verify the archive byte layout.
function parseZip(buffer) {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const locals = [];
  let offset = 0;
  while (dv.getUint32(offset, true) === 0x04034b50) {
    const nameLength = dv.getUint16(offset + 26, true);
    const extraLength = dv.getUint16(offset + 28, true);
    const size = dv.getUint32(offset + 18, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    locals.push({
      name: decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)),
      method: dv.getUint16(offset + 8, true),
      flags: dv.getUint16(offset + 6, true),
      crc: dv.getUint32(offset + 14, true),
      size,
      data: bytes.slice(dataStart, dataStart + size),
      headerOffset: offset
    });
    offset = dataStart + size;
  }
  const centralStart = offset;
  const central = [];
  while (dv.getUint32(offset, true) === 0x02014b50) {
    const nameLength = dv.getUint16(offset + 28, true);
    central.push({
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      size: dv.getUint32(offset + 24, true),
      localOffset: dv.getUint32(offset + 42, true)
    });
    offset += 46 + nameLength;
  }
  assert.equal(dv.getUint32(offset, true), 0x06054b50, 'end of central directory expected');
  return {
    locals,
    central,
    centralStart,
    entriesCount: dv.getUint16(offset + 10, true),
    centralSize: dv.getUint32(offset + 12, true),
    centralOffset: dv.getUint32(offset + 16, true)
  };
}

test('builds a store-only archive with correct names, sizes, contents and known CRC', async () => {
  const blob = await build([
    { path: 'hello.txt', file: fakeFile('123456789') },
    { path: '文件夹/内/数据.bin', file: fakeFile(new Uint8Array([1, 2, 3, 4, 5])) },
    { path: 'empty.txt', file: fakeFile('') }
  ]);
  const parsed = parseZip(await blob.arrayBuffer());

  assert.equal(parsed.entriesCount, 3);
  assert.equal(parsed.central.length, 3);
  assert.equal(parsed.centralOffset, parsed.centralStart);

  const [text, binary, empty] = parsed.locals;
  assert.equal(text.name, 'hello.txt');
  assert.equal(text.method, 0);
  assert.equal(text.flags, 0x0800);
  assert.equal(text.size, 9);
  assert.equal(text.crc, 0xCBF43926); // standard CRC-32 check value for "123456789"
  assert.equal(decoder.decode(text.data), '123456789');

  assert.equal(binary.name, '文件夹/内/数据.bin');
  assert.deepEqual([...binary.data], [1, 2, 3, 4, 5]);
  assert.equal(binary.crc, 0x470B99F4); // CRC-32 of bytes 01..05

  assert.equal(empty.name, 'empty.txt');
  assert.equal(empty.size, 0);
  assert.equal(empty.crc, 0);

  for (let i = 0; i < parsed.central.length; i += 1) {
    const local = parsed.locals[i];
    assert.equal(parsed.central[i].name, local.name);
    assert.equal(parsed.central[i].size, local.size);
    assert.equal(parsed.central[i].localOffset, local.headerOffset);
  }
});

test('reports monotonic progress ending at the total byte count', async () => {
  const entries = [
    { path: 'a.bin', file: fakeFile(new Uint8Array(1024)) },
    { path: 'b.bin', file: fakeFile(new Uint8Array(2048)) }
  ];
  const seen = [];
  await build(entries, (done, total) => seen.push([done, total]));
  assert.deepEqual(seen, [[1024, 3072], [3072, 3072]]);
});

test('rejects invalid input instead of producing a broken archive', async () => {
  await assert.rejects(() => build([]), /没有可打包的文件/);
  await assert.rejects(() => build([{ path: 'x', file: {} }]), /无效/);
  await assert.rejects(() => build([{ path: '../escape.txt', file: fakeFile('x') }]), /路径无效/);
  await assert.rejects(
    () => build([{ path: 'big.bin', file: { size: 0x100000000, slice: () => {}, lastModified: 0 } }]),
    /超过 4GiB/
  );
  await assert.rejects(
    () => build(Array.from({ length: 65536 }, (_, i) => ({ path: `f${i}`, file: fakeFile('') }))),
    /65535/
  );
});
