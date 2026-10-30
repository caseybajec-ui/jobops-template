/**
 * A minimal ZIP writer, and CSV escaping. No dependency.
 *
 * WHY NOT A LIBRARY. CLAUDE.md requires asking before adding one, and the whole
 * of what this needs is a local file header, a central directory and a CRC —
 * about sixty lines against a dependency, its transitive tree and its
 * supply-chain surface, for a footer link. Deflate comes from node:zlib, which
 * is built in.
 *
 * It writes STORED entries when deflate does not help and DEFLATED otherwise,
 * which is what every zip tool does and what makes the archive openable by
 * Explorer, Finder, and Excel's import.
 */
import { deflateRawSync, crc32 } from "node:zlib";

/** node:zlib gained crc32 in Node 20.15. Fall back rather than fail the build. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc(buf) {
  if (typeof crc32 === "function") return crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * One CSV field.
 *
 * Quotes anything containing a comma, a quote, a newline OR A LEADING SPACE,
 * and doubles embedded quotes. The leading-space case is not pedantry: a job
 * description that begins with whitespace loses it otherwise, and these
 * exports are meant to be a faithful copy rather than a tidied one.
 */
export function csvField(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Rows to CSV, with a header line taken from the first row's keys.
 *
 * An empty table still gets its header, from `columns`, because a CSV with no
 * header is a file you cannot tell apart from a corrupt one.
 */
export function toCsv(rows = [], columns = null) {
  const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
  const head = cols.map(csvField).join(",");
  if (!rows.length) return head + "\n";
  const body = rows.map((r) => cols.map((c) => csvField(r[c])).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

/** DOS date and time, which is what a zip entry stores. */
function dosTime(d = new Date()) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/**
 * Build a zip from `[{ name, data }]`.
 *
 * Returns a Buffer. Everything here is small — the whole corpus as CSV is a few
 * megabytes — so it is built in memory rather than streamed, which keeps the
 * route to one line and has no downside at this size.
 */
export function zip(files = [], now = new Date()) {
  const { time, date } = dosTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
    const deflated = deflateRawSync(raw);
    // Only compress when it actually helps. A tiny CSV routinely deflates
    // LARGER than it started, and storing it is both smaller and faster.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, end]);
}
