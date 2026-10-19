// Minimal zip reader working on File slices, so multi-gigabyte archives
// (WeTransfer CBCT exports) open without loading the whole archive into
// memory. Stored entries become lazy File views of the archive; deflated
// entries are inflated with the browser's DecompressionStream.

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function isZipFile(file){
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed';
}

async function readBytes(blob, start, end){
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function u64(view, off){
  return view.getUint32(off, true) + view.getUint32(off + 4, true) * 0x100000000;
}

async function findCentralDirectory(zip){
  const tailLen = Math.min(zip.size, 65535 + 22 + 20);
  const tailStart = zip.size - tailLen;
  const tail = await readBytes(zip, tailStart, zip.size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  let count = tail.getUint16(eocd + 10, true);
  let size = tail.getUint32(eocd + 12, true);
  let offset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== ZIP64_LOCATOR_SIG) {
      throw new Error('zip: zip64 locator not found');
    }
    const z64Offset = u64(tail, loc + 8);
    const z64 = await readBytes(zip, z64Offset, z64Offset + 56);
    if (z64.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new Error('zip: bad zip64 record');
    count = u64(z64, 32);
    size = u64(z64, 40);
    offset = u64(z64, 48);
  }
  return {count, size, offset};
}

function parseEntries(cd, count){
  const utf8 = new TextDecoder('utf-8');
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== CD_SIG) throw new Error('zip: bad central directory');
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localOffset = cd.getUint32(p + 42, true);
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // zip64 extra field carries the values that overflowed 32 bits
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cd, q); }
      }
      e += 4 + len;
    }
    entries.push({name, flags, method, compSize, size, localOffset});
    p = extraEnd + commentLen;
  }
  return entries;
}

// Returns the archive's files as File objects carrying a `relativePath`
// (archive path), like files coming from a dropped folder.
export async function extractZip(zip, onProgress){
  const {count, size, offset} = await findCentralDirectory(zip);
  const cd = await readBytes(zip, offset, offset + size);
  const entries = parseEntries(cd, count).filter(en =>
    !en.name.endsWith('/') && !/(^|\/)__MACOSX\//.test(en.name));

  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const en = entries[i];
    if (onProgress && (i % 20 === 0 || i === entries.length - 1)) onProgress(i + 1, entries.length);
    if (en.flags & 1) throw new Error('zip: encrypted');
    const local = await readBytes(zip, en.localOffset, en.localOffset + 30);
    if (local.getUint32(0, true) !== LOCAL_SIG) throw new Error('zip: bad local header');
    const dataStart = en.localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const raw = zip.slice(dataStart, dataStart + en.compSize);
    let blob;
    if (en.method === 0) {
      blob = raw;
    } else if (en.method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('zip: no DecompressionStream');
      blob = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    } else {
      // unsupported compression (e.g. deflate64, bzip2): skip the entry
      continue;
    }
    const base = en.name.slice(en.name.lastIndexOf('/') + 1);
    const file = new File([blob], base);
    try { Object.defineProperty(file, 'relativePath', {value: en.name}); } catch (err) { /* read-only */ }
    out.push(file);
  }
  return out;
}
