/**
 * The CSV escaping and the zip writer. Run: node test_zip.mjs
 *
 * The zip is hand-rolled rather than a dependency, which means the usual
 * argument — "the library is tested" — does not apply and this has to be. The
 * failure mode is an archive that looks fine and will not open, discovered on
 * the day it is needed, which is the day something else has already gone wrong.
 *
 * So it is unzipped again here with node:zlib and compared byte for byte, and
 * the structural offsets are checked against the spec rather than against
 * themselves.
 */
import { inflateRawSync } from "node:zlib";
import { zip, toCsv, csvField } from "./lib/zip.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ----------------------------------------------------------------- CSV */

eq(csvField("plain"), "plain", "a plain value is bare");
eq(csvField("a,b"), '"a,b"', "a comma forces quotes");
eq(csvField('say "hi"'), '"say ""hi"""', "and an embedded quote is doubled");
eq(csvField("line\nbreak"), '"line\nbreak"', "a newline forces quotes");
eq(csvField(null), "", "null is empty, not the word null");
eq(csvField(undefined), "", "and so is undefined");
eq(csvField(0), "0", "but zero is zero");
eq(csvField(false), "false", "and false is false, not empty");
// NOT PEDANTRY: a job description beginning with whitespace loses it otherwise,
// and this export is meant to be a faithful copy rather than a tidied one.
eq(csvField(" leading"), '" leading"', "a leading space is preserved by quoting");
eq(csvField("trailing "), '"trailing "', "and so is a trailing one");

{
  const csv = toCsv([{ a: 1, b: "x,y" }, { a: 2, b: null }]);
  eq(csv, 'a,b\n1,"x,y"\n2,\n', "rows become a header and two lines");
}
{
  // An empty table STILL GETS ITS HEADER. A CSV with no header cannot be told
  // apart from a corrupt file.
  eq(toCsv([], ["id", "name"]), "id,name\n", "an empty table keeps its header");
  eq(toCsv([]), "\n", "and with no columns known, an empty line rather than nothing");
}

/* ----------------------------------------------------------------- zip */

const files = [
  { name: "small.csv", data: "a,b\n1,2\n" },
  // Long and repetitive, so deflate genuinely helps and the DEFLATED path runs.
  { name: "big.csv", data: "col\n" + "the same line over and over\n".repeat(500) },
  { name: "empty.csv", data: "header\n" },
  { name: "unicode.csv", data: "name\nJordan — Reyes\n" },
];
const buf = zip(files, new Date("2026-09-02T12:00:00Z"));

ok(Buffer.isBuffer(buf), "it returns a Buffer");
eq(buf.readUInt32LE(0), 0x04034b50, "starting with a local file header signature");

// The end-of-central-directory record, read from the END as a reader does.
const eocdAt = buf.length - 22;
eq(buf.readUInt32LE(eocdAt), 0x06054b50, "and ending with the EOCD signature");
eq(buf.readUInt16LE(eocdAt + 10), files.length, "which counts every entry");

/**
 * Unzip it again, the way a real reader does: walk the central directory,
 * follow each offset to its local header, and inflate.
 *
 * This is the assertion that matters. Anything can produce bytes; the question
 * is whether the archive opens.
 */
function unzip(b) {
  const end = b.length - 22;
  const count = b.readUInt16LE(end + 10);
  let p = b.readUInt32LE(end + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    // Central directory entry.
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localAt = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    // Local header, then the body.
    const method = b.readUInt16LE(localAt + 8);
    const compSize = b.readUInt32LE(localAt + 18);
    const lNameLen = b.readUInt16LE(localAt + 26);
    const lExtraLen = b.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const body = b.subarray(start, start + compSize);
    out[name] = method === 8 ? inflateRawSync(body).toString("utf8") : body.toString("utf8");
  }
  return out;
}

const back = unzip(buf);
eq(Object.keys(back).sort(), files.map((f) => f.name).sort(),
   "every file comes back out by name");
for (const f of files) {
  eq(back[f.name], f.data, `${f.name} round-trips byte for byte`);
}

// BOTH PATHS RUN. A tiny CSV routinely deflates LARGER than it started, so the
// writer stores those — and if it always deflated, this test would never
// exercise the stored branch that most of the real tables take.
{
  const methodOf = (name) => {
    const end = buf.length - 22;
    let p = buf.readUInt32LE(end + 16);
    const count = buf.readUInt16LE(end + 10);
    for (let n = 0; n < count; n++) {
      const nameLen = buf.readUInt16LE(p + 28);
      const nm = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      if (nm === name) return buf.readUInt16LE(p + 10);
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return null;
  };
  eq(methodOf("big.csv"), 8, "a compressible file is deflated");
  eq(methodOf("small.csv"), 0, "and a tiny one is stored, because deflating it would grow it");
}

// UTF-8 names and content. The flag bit matters: without it, a name with an
// em dash in it opens as mojibake on Windows.
eq(back["unicode.csv"], "name\nJordan — Reyes\n", "an em dash survives the round trip");
eq(buf.readUInt16LE(6) & 0x0800, 0x0800, "and the UTF-8 flag is set on the entry");

// An empty archive is still a valid archive.
{
  const e = zip([]);
  eq(e.readUInt32LE(e.length - 22), 0x06054b50, "an empty zip is still well-formed");
  eq(Object.keys(unzip(e)).length, 0, "and contains nothing");
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
