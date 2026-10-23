// ============================================================
//  zipwriter.js — เขียนไฟล์ .zip (ชื่อไฟล์ภาษาไทยได้ · เปิดได้ใน Windows / Mac โดยไม่ต้องลงโปรแกรม)
//  ใช้ zlib ที่มากับ Node (ไม่ต้องติดตั้งเพิ่ม) · รองรับไฟล์รวมไม่เกิน 4 GB และไม่เกิน 65,535 ไฟล์
// ============================================================
const fs = require('fs');
const zlib = require('zlib');

const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(b) >>> 0;
  let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0;
}
function dos(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
class ZipWriter {
  constructor(file) { this.fd = fs.openSync(file, 'w'); this.off = 0; this.cd = []; this.names = new Set(); this.bytes = 0; }
  _w(b) { fs.writeSync(this.fd, b); this.off += b.length; }
  // ชื่อซ้ำ → เติม (2), (3) …
  _uniq(name) {
    name = String(name).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.\//g, '');
    if (!this.names.has(name)) { this.names.add(name); return name; }
    const m = name.match(/^(.*?)(\.[^./]+)?$/); let i = 2, n;
    do { n = m[1] + ' (' + i++ + ')' + (m[2] || ''); } while (this.names.has(n));
    this.names.add(n); return n;
  }
  add(name, data, opts) {
    if (this.cd.length >= 65535) throw new Error('ไฟล์ในชุดเกิน 65,535 ไฟล์');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const already = opts && opts.store || /\.(zip|gz|png|jpe?g|webp|gif|pdf)$/i.test(name) && raw.length > 4096;   // ไฟล์ที่บีบอัดอยู่แล้ว เก็บตรง ๆ เร็วกว่า
    const comp = already ? raw : zlib.deflateRawSync(raw, { level: 6 });
    const method = already ? 0 : 8, crc = crc32(raw), nb = Buffer.from(this._uniq(name), 'utf8'), { time, date } = dos(new Date());
    if (this.off + comp.length + 30 + nb.length > 0xFFFFFFFF) throw new Error('ข้อมูลรวมเกิน 4 GB');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
    const off = this.off; this._w(h); this._w(nb); this._w(comp);
    this.cd.push({ nb, crc, cs: comp.length, us: raw.length, method, time, date, off }); this.bytes += raw.length;
  }
  close() {
    const start = this.off;
    for (const e of this.cd) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.cs, 20); c.writeUInt32LE(e.us, 24);
      c.writeUInt16LE(e.nb.length, 28); c.writeUInt32LE(e.off, 42);
      this._w(c); this._w(e.nb);
    }
    const z = Buffer.alloc(22);
    z.writeUInt32LE(0x06054b50, 0); z.writeUInt16LE(this.cd.length, 8); z.writeUInt16LE(this.cd.length, 10);
    z.writeUInt32LE(this.off - start, 12); z.writeUInt32LE(start, 16);
    this._w(z); fs.closeSync(this.fd);
    return { files: this.cd.length, bytes: this.bytes };
  }
  abort() { try { fs.closeSync(this.fd); } catch (e) {} }
}
module.exports = { ZipWriter };
