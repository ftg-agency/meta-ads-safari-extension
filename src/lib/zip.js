/*
 * src/lib/zip.js — минимальный ZIP-энкодер без сжатия (метод STORE).
 *
 * Зачем свой энкодер: рекламные креативы (JPG/MP4) уже сжаты, поэтому STORE
 * близок к оптимуму, а зависимостей не требует — работает офлайн и под строгим
 * CSP (script-src 'self'). Никаких fflate/jszip и сетевых загрузок.
 *
 * Вход:  [{ name: string, bytes: Uint8Array }]
 * Выход: один Uint8Array с готовым .zip
 *
 * Экспортирует self.FBALS_Zip = { createZip, crc32 } и module.exports (для Node-тестов).
 */
(function () {
  'use strict';

  // --- CRC-32 (полином 0xEDB88320), стандартная таблица ---
  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  }
  const CRC_TABLE = makeCrcTable();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = (CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // --- помощники для little-endian записи ---
  function u16(n) {
    const b = new Uint8Array(2);
    b[0] = n & 0xFF;
    b[1] = (n >>> 8) & 0xFF;
    return b;
  }

  function u32(n) {
    n = n >>> 0;
    const b = new Uint8Array(4);
    b[0] = n & 0xFF;
    b[1] = (n >>> 8) & 0xFF;
    b[2] = (n >>> 16) & 0xFF;
    b[3] = (n >>> 24) & 0xFF;
    return b;
  }

  function utf8(str) {
    return new TextEncoder().encode(String(str));
  }

  function concat(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  /**
   * Собирает .zip методом STORE.
   * @param {Array<{name:string, bytes:Uint8Array}>} files
   * @returns {Uint8Array}
   */
  function createZip(files) {
    const FLAG = 0x0800;   // bit 11 — имена файлов в UTF-8
    const TIME = 0x0000;   // фиксированное время (00:00:00)
    const DATE = 0x0021;   // фиксированная дата 1980-01-01

    const localParts = [];   // локальные заголовки + данные
    const centralParts = []; // записи центрального каталога
    let offset = 0;

    for (const f of files) {
      const nameBytes = utf8(f.name);
      const data = (f.bytes instanceof Uint8Array)
        ? f.bytes
        : new Uint8Array(f.bytes || []);
      const crc = crc32(data);
      const size = data.length;

      // Local file header (PK\x03\x04)
      const local = concat([
        u32(0x04034b50), u16(20), u16(FLAG), u16(0), u16(TIME), u16(DATE),
        u32(crc), u32(size), u32(size),
        u16(nameBytes.length), u16(0),
        nameBytes
      ]);
      localParts.push(local, data);

      // Central directory header (PK\x01\x02)
      const central = concat([
        u32(0x02014b50), u16(20), u16(20), u16(FLAG), u16(0), u16(TIME), u16(DATE),
        u32(crc), u32(size), u32(size),
        u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset),
        nameBytes
      ]);
      centralParts.push(central);

      offset += local.length + data.length;
    }

    const centralBytes = concat(centralParts);
    const cdOffset = offset;
    const cdSize = centralBytes.length;

    // End of central directory record (PK\x05\x06)
    const eocd = concat([
      u32(0x06054b50), u16(0), u16(0),
      u16(files.length), u16(files.length),
      u32(cdSize), u32(cdOffset), u16(0)
    ]);

    const all = localParts.slice();
    all.push(centralBytes, eocd);
    return concat(all);
  }

  const API = { createZip, crc32 };
  if (typeof self !== 'undefined') self.FBALS_Zip = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
