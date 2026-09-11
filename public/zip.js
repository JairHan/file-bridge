/* Minimal ZIP archive builder (store method only, no compression).
   Entries are streamed for CRC and embedded by reference, so file bytes
   never have to be held in memory all at once. */
const ZipArchive = (() => {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      table[n] = value >>> 0;
    }
    return table;
  })();

  const CRC_CHUNK = 8 * 1024 * 1024;
  const MAX_ENTRIES = 65535;
  const MAX_ENTRY_SIZE = 0xFFFFFFFF;

  async function crc32(blob) {
    let crc = -1;
    for (let offset = 0; offset < blob.size; offset += CRC_CHUNK) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CRC_CHUNK).arrayBuffer());
      for (let i = 0; i < bytes.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  function dosDateTime(timestamp) {
    const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
    const year = Math.max(date.getFullYear(), 1980);
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, date: day };
  }

  function validate(entry, index) {
    const file = entry?.file;
    if (!file || typeof file.slice !== 'function' || !Number.isFinite(file.size) || file.size < 0) {
      throw new Error(`第 ${index + 1} 个文件无效，无法打包`);
    }
    if (file.size > MAX_ENTRY_SIZE) throw new Error('单个文件超过 4GiB，无法打包');
    const path = String(entry.path || file.name || 'file').replace(/\\/g, '/');
    if (!path || path.split('/').includes('..')) throw new Error('文件路径无效，无法打包');
    return path;
  }

  async function build(entries, onProgress = () => {}) {
    if (!entries?.length) throw new Error('没有可打包的文件');
    if (entries.length > MAX_ENTRIES) throw new Error('文件数量超过 65535，无法打包');
    for (let i = 0; i < entries.length; i += 1) validate(entries[i], i);

    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const total = entries.reduce((sum, entry) => sum + entry.file.size, 0) || 1;
    let processed = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.path);
      const { time, date } = dosDateTime(entry.file.lastModified);
      const checksum = await crc32(entry.file);
      processed += entry.file.size;
      onProgress(processed, total);

      const local = new ArrayBuffer(30);
      const lv = new DataView(local);
      lv.setUint32(0, 0x04034b50, true);   // local file header signature
      lv.setUint16(4, 20, true);           // version needed to extract
      lv.setUint16(6, 0x0800, true);       // flags: UTF-8 file name
      lv.setUint16(8, 0, true);            // method: store
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, checksum, true);
      lv.setUint32(18, entry.file.size, true);
      lv.setUint32(22, entry.file.size, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);           // extra field length
      parts.push(local, name, entry.file);

      const record = new ArrayBuffer(46);
      const cv = new DataView(record);
      cv.setUint32(0, 0x02014b50, true);   // central directory signature
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed to extract
      cv.setUint16(8, 0x0800, true);       // flags: UTF-8 file name
      cv.setUint16(10, 0, true);           // method: store
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, checksum, true);
      cv.setUint32(20, entry.file.size, true);
      cv.setUint32(24, entry.file.size, true);
      cv.setUint16(28, name.length, true);
      // extra(30) comment(32) disk(34) internal attrs(36) stay zero
      cv.setUint32(38, 0, true);           // external attributes
      cv.setUint32(42, offset, true);      // relative offset of local header
      central.push(record, name);

      offset += 30 + name.length + entry.file.size;
    }

    let centralSize = 0;
    for (const part of central) centralSize += part.byteLength;
    const end = new ArrayBuffer(22);
    const ev = new DataView(end);
    ev.setUint32(0, 0x06054b50, true);     // end of central directory
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  return { build };
})();
window.ZipArchive = ZipArchive;
