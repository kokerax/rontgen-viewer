// Dental CBCT support: scans a set of files into DICOM series, builds a
// downsampled in-memory volume for axial CT stacks and reconstructs a
// panoramic image along the automatically detected dental arch.
// Everything runs locally in the browser tab.

import {DicomParser} from "dwv";

// files that are never DICOM and are shipped next to CBCT exports
// (Windows viewer, XML context files, macOS metadata)
const IGNORED_NAME = /(^\.|\.(exe|dll|xml|txt|ini|htm|html|js|css|pdf|jpg|jpeg|png|bmp|inf|ico|json|log|db|zip)$)/i;

// transfer syntaxes whose pixel data we can read directly
const NATIVE_TS = new Set([
  '1.2.840.10008.1.2',     // implicit little endian
  '1.2.840.10008.1.2.1',   // explicit little endian
  '1.2.840.10008.1.2.1.99' // deflated explicit little endian (inflated by parser)
]);
const JPEG_LOSSLESS_TS = '1.2.840.10008.1.2.4.70';

// keep the downsampled volume around this many voxels per side
const TARGET_SIDE = 420;

const MIN_VOLUME_SLICES = 40;

// Verified NewTom NNTViewer axial frame: CNNTImg, a 32-bit byte count,
// little-endian unsigned 16-bit pixels, then a footer with voxel spacing.
const NNT_HEADER_SIZE = 21;
const NNT_FOOTER_SPACING = 40;
const NNT_MAGIC = 'CNNTImg';

export function sniffNntImg(head){
  if (head.length < NNT_HEADER_SIZE || head[0] !== 0xff || head[1] !== 0xff) return false;
  for (let i = 0; i < NNT_MAGIC.length; i++) {
    if (head[6 + i] !== NNT_MAGIC.charCodeAt(i)) return false;
  }
  const bytes = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(17, true);
  const side = Math.sqrt(bytes / 2);
  return Number.isInteger(side) && side >= 128 && side <= 2048;
}

export async function readNntFrame(file){
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, NNT_HEADER_SIZE));
  if (!sniffNntImg(head)) throw new Error('unsupported NNT frame');
  const view = new DataView(buffer);
  const bytes = view.getUint32(17, true);
  const side = Math.sqrt(bytes / 2);
  const footer = NNT_HEADER_SIZE + bytes;
  if (buffer.byteLength > footer + 4 * 1024 * 1024) throw new Error('unsupported NNT frame size');
  if (footer + NNT_FOOTER_SPACING + 12 > buffer.byteLength) throw new Error('truncated NNT frame');
  const spacing = [0, 1, 2].map(i => view.getFloat32(footer + NNT_FOOTER_SPACING + i * 4, true));
  if (!spacing.every(v => Number.isFinite(v) && v > 0.01 && v < 5)) throw new Error('invalid NNT spacing');
  const pixels = new Uint16Array(side * side);
  for (let i = 0; i < pixels.length; i++) pixels[i] = view.getUint16(NNT_HEADER_SIZE + i * 2, true);
  return {pixels, rows: side, cols: side, spacing};
}

export async function scanNntFiles(files, onProgress, options = {}){
  const numbered = files.map(file => ({file, match: /\.a(\d{3,4})$/i.exec(file.name)}))
    .filter(entry => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (numbered.length < MIN_VOLUME_SLICES ||
      numbered.some((entry, i) => i && Number(entry.match[1]) !== Number(numbered[i - 1].match[1]) + 1)) {
    return {series: [], skipped: files.length};
  }
  const slices = [];
  const series = {uid: 'nnt', description: 'NewTom NNTViewer', modality: 'CBCT', folder: '',
    format: 'nnt', files: numbered.map(entry => entry.file), overview: null, overviewCount: 0};
  let first = null;
  for (let i = 0; i < numbered.length; i++) {
    const file = numbered[i].file;
    const frame = await readNntFrame(file);
    if (first && (frame.rows !== first.rows || frame.cols !== first.cols ||
        frame.spacing.some((v, j) => Math.abs(v - first.spacing[j]) > 0.001))) {
      throw new Error('inconsistent NNT frames');
    }
    first ||= frame;
    const f = Math.max(1, Math.ceil(frame.rows / (options.mobile ? 160 : 256)));
    const ds = downsampleFrame(frame.pixels, frame.rows, frame.cols, f, 1, 0, !!options.mobile);
    updateOverview(series, ds, [1, 0, 0, 0, 1, 0], frame.spacing, f);
    const z = i * frame.spacing[2];
    slices.push({ipp: [0, 0, z], iop: [1, 0, 0, 0, 1, 0], f,
      rowSpacing: frame.spacing[1], colSpacing: frame.spacing[0],
      data: ds.data, width: ds.width, height: ds.height,
      source: {kind: 'nnt', file, rows: frame.rows, cols: frame.cols, f,
        rowSpacing: frame.spacing[1], colSpacing: frame.spacing[0], slope: 1, intercept: 0,
        positionZ: z, transferSyntax: 'nnt'}});
    if (i % (options.mobile ? 4 : 12) === 0 || i === numbered.length - 1) {
      onProgress?.(i + 1, numbered.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  series.overview = finishOverview(series.overview, series.overviewCount);
  series.volume = buildVolume(slices);
  delete series.overviewCount;
  if (!series.volume) throw new Error('invalid NNT volume');
  return {series: [series], skipped: files.length - numbered.length};
}

export function isIgnoredFile(file){
  return IGNORED_NAME.test(file.name);
}

const VRS = new Set(['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FD', 'FL', 'IS', 'LO', 'LT',
  'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'SV', 'TM',
  'UC', 'UI', 'UL', 'UN', 'UR', 'US', 'UT', 'UV']);

const IMPLICIT_LE = '1.2.840.10008.1.2';

// Part 10 file meta header (preamble, DICM, group 0002) declaring the
// given transfer syntax, in explicit VR little endian.
function buildFileMeta(transferSyntax){
  const enc = new TextEncoder();
  const uid = transferSyntax.length % 2 ? transferSyntax + '\0' : transferSyntax;
  // (0002,0001) OB, 2 reserved bytes, 4-byte length = 2, value 00 01
  const version = new Uint8Array([0x02, 0x00, 0x01, 0x00, 'O'.charCodeAt(0), 'B'.charCodeAt(0),
    0, 0, 2, 0, 0, 0, 0, 1]);
  const tsHead = new Uint8Array([0x02, 0x00, 0x10, 0x00, 'U'.charCodeAt(0), 'I'.charCodeAt(0), uid.length, 0]);
  const tsVal = enc.encode(uid);
  const groupLen = version.length + tsHead.length + tsVal.length;
  const lenEl = new Uint8Array([0x02, 0x00, 0x00, 0x00, 'U'.charCodeAt(0), 'L'.charCodeAt(0), 4, 0,
    groupLen & 0xff, (groupLen >> 8) & 0xff, 0, 0]);
  const pre = new Uint8Array(132);
  pre.set(enc.encode('DICM'), 128);
  return [pre, lenEl, version, tsHead, tsVal];
}

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const ENCAPSULATED_PIXEL = new Uint8Array([224,127,16,0,79,66,0,0,255,255,255,255]);
const EMPTY_ITEM = new Uint8Array([254,255,0,224,0,0,0,0]);
const SEQUENCE_END = new Uint8Array([254,255,221,224,0,0,0,0]);

function joinBytes(parts){
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

// Walk the explicit-VR header, including undefined-length functional groups.
// A nested icon's Pixel Data must not be mistaken for the volume's data.
function pixelHeaderOffset(bytes){
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (sniffDicom(bytes) !== 'part10') return null;
  let offset = 132, depth = 0;
  while (offset + 8 <= bytes.length) {
    const group = view.getUint16(offset, true), element = view.getUint16(offset + 2, true);
    if (group === 0xfffe) {
      const size = view.getUint32(offset + 4, true);
      if (element === 0xe000 && size === 0xffffffff) { depth++; offset += 8; }
      else if (element === 0xe00d || element === 0xe0dd) { depth--; offset += 8; }
      else offset += 8 + size;
      if (depth < 0) return null;
      continue;
    }
    const vr = String.fromCharCode(bytes[offset + 4], bytes[offset + 5]);
    if (!VRS.has(vr)) return null;
    const head = LONG_VR.has(vr) ? 12 : 8;
    if (offset + head > bytes.length) return null;
    const size = head === 12 ? view.getUint32(offset + 8, true) : view.getUint16(offset + 6, true);
    if (!depth && group === 0x7fe0 && element === 0x0010) return {offset, head, size};
    if (size === 0xffffffff) {
      if (vr !== 'SQ') return null;
      depth++; offset += head;
    } else offset += head + size;
  }
  return null;
}

function dicomElement(tag, vr, value){
  const bytes = vr === 'US' ? new Uint8Array(2) : new TextEncoder().encode(String(value));
  if (vr === 'US') new DataView(bytes.buffer).setUint16(0, Number(value), true);
  const length = bytes.length + bytes.length % 2;
  const out = new Uint8Array(8 + length);
  const view = new DataView(out.buffer);
  view.setUint16(0, parseInt(tag.slice(0, 4), 16), true);
  view.setUint16(2, parseInt(tag.slice(4), 16), true);
  out[4] = vr.charCodeAt(0); out[5] = vr.charCodeAt(1);
  view.setUint16(6, length, true);
  out.set(bytes, 8);
  if (length > bytes.length) out[out.length - 1] = vr === 'UI' ? 0 : 32;
  return out;
}

// Large Enhanced CT exports can hold hundreds of JPEG Lossless frames in
// one file. Expose standard single-frame DICOM views without holding the
// complete compressed file or all decoded frames in RAM.
async function splitMultiframeDicom(file){
  let prefix, pixel;
  for (let limit = 65536; limit <= 4 * 1024 * 1024; limit *= 2) {
    prefix = new Uint8Array(await file.slice(0, Math.min(limit, file.size)).arrayBuffer());
    pixel = pixelHeaderOffset(prefix);
    if (pixel || prefix.length === file.size) break;
  }
  if (!pixel || pixel.size !== 0xffffffff) return null;
  const parser = new DicomParser();
  parser.parse(joinBytes([prefix.subarray(0, pixel.offset), ENCAPSULATED_PIXEL, EMPTY_ITEM, SEQUENCE_END]).buffer);
  const elements = parser.getDicomElements();
  const frames = Number(first(elements, '00280008') || 1);
  if (str(elements, '00020010') !== JPEG_LOSSLESS_TS || frames < 2 || frames > 5000) return null;
  const rows = Number(first(elements, '00280010')), cols = Number(first(elements, '00280011'));
  if (!rows || !cols || rows * cols > 4096 * 4096 || Number(first(elements, '00280002')) !== 1) return null;
  const perFrame = elements['52009230']?.value;
  const shared = elements['52009229']?.value?.[0];
  const nested = (frame, sequence, tag) => frame?.[sequence]?.value?.[0]?.[tag]?.value ||
    shared?.[sequence]?.value?.[0]?.[tag]?.value || elements[tag]?.value;
  const dataStart = pixel.offset + pixel.head;
  const tableHead = new DataView(await file.slice(dataStart, dataStart + 8).arrayBuffer());
  if (tableHead.getUint32(0, true) !== 0xe000fffe || tableHead.getUint32(4, true) !== frames * 4) return null;
  const table = new DataView(await file.slice(dataStart + 8, dataStart + 8 + frames * 4).arrayBuffer());
  const fragmentsStart = dataStart + 8 + frames * 4;
  const offsets = Array.from({length: frames}, (_, i) => table.getUint32(i * 4, true));
  if (offsets[0] !== 0 || offsets.some((offset, i) => fragmentsStart + offset + 8 > file.size ||
      (i && offset <= offsets[i - 1]))) return null;
  const seriesUid = str(elements, '0020000E') || '2.25.' + BigInt('0x' + crypto.randomUUID().replaceAll('-', '')).toString();
  const instanceBase = '2.25.' + BigInt('0x' + crypto.randomUUID().replaceAll('-', '')).toString();
  const out = [];
  for (let i = 0; i < frames; i++) {
    const frame = perFrame?.[i];
    const position = nested(frame, '00209113', '00200032');
    const orientation = nested(frame, '00209116', '00200037');
    const spacing = nested(frame, '00289110', '00280030');
    // Do not invent anatomical ordering when the export omits per-frame geometry.
    if (!position || position.length !== 3 || !orientation || orientation.length !== 6 || !spacing || spacing.length !== 2 ||
        ![...position, ...orientation, ...spacing].every(v => Number.isFinite(Number(v)))) return null;
    const tags = [
      ['00080016','UI','1.2.840.10008.5.1.4.1.1.2'], ['00080018','UI',instanceBase + '.' + (i + 1)],
      ['00080060','CS','CT'], ['0008103E','LO','CBCT'],
      ['0020000D','UI',str(elements, '0020000D') || seriesUid], ['0020000E','UI',seriesUid],
      ['00200013','IS',i + 1], ['00200032','DS',position.join('\\')], ['00200037','DS',orientation.join('\\')],
      ['00280002','US',1], ['00280004','CS',str(elements, '00280004') || 'MONOCHROME2'],
      ['00280010','US',rows], ['00280011','US',cols], ['00280030','DS',spacing.join('\\')],
      ['00280100','US',first(elements, '00280100')], ['00280101','US',first(elements, '00280101')],
      ['00280102','US',first(elements, '00280102')], ['00280103','US',first(elements, '00280103') || 0],
      ['00281052','DS',nested(frame, '00289145', '00281052')?.[0] || 0],
      ['00281053','DS',nested(frame, '00289145', '00281053')?.[0] || 1]
    ];
    const header = joinBytes([...buildFileMeta(JPEG_LOSSLESS_TS), ...tags.map(tag => dicomElement(...tag)), ENCAPSULATED_PIXEL, EMPTY_ITEM]);
    const start = fragmentsStart + offsets[i];
    const boundary = i + 1 < frames ? fragmentsStart + offsets[i + 1] : file.size - 8;
    const arrayBuffer = async () => {
      const item = new Uint8Array(await file.slice(start, start + 8).arrayBuffer());
      const view = new DataView(item.buffer);
      const length = view.getUint32(4, true);
      if (view.getUint32(0, true) !== 0xe000fffe || length < 2 || length > 32 * 1024 * 1024 || start + 8 + length !== boundary) {
        throw new Error('unsupported multiframe fragment layout');
      }
      const image = new Uint8Array(await file.slice(start + 8, boundary).arrayBuffer());
      if (image[0] !== 0xff || image[1] !== 0xd8) throw new Error('invalid multiframe JPEG');
      return joinBytes([header, item, image, SEQUENCE_END]).buffer;
    };
    out.push({name: `frame-${String(i + 1).padStart(5, '0')}.dcm`, relativePath: file.relativePath || file.name,
      streamSource: file, streamIndex: i,
      size: header.length + boundary - start + SEQUENCE_END.length, arrayBuffer,
      slice(start = 0, end = this.size) {
        if (end <= header.length) return new Blob([header.subarray(start, end)]);
        return {arrayBuffer: async () => (await arrayBuffer()).slice(start, end)};
      }});
  }
  return out;
}

// Some vendors (e.g. J. Morita OneVolumeViewer exports) write bare
// datasets: no preamble, no file meta, implicit VR. dwv then guesses
// explicit VR and misreads every tag. Detect that and prepend a proper
// meta header. Returns null for files that do not look like DICOM, so
// large vendor blobs (.vol, .pak) are never read whole.
// Classifies the first 132 bytes of a file: 'part10' (preamble + DICM),
// 'explicit' / 'implicit' (bare dataset) or null (not DICOM).
export function sniffDicom(head){
  if (head.length < 132) return null;
  if (head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d) return 'part10';
  const group = head[0] | (head[1] << 8);
  const element = head[2] | (head[3] << 8);
  // a dataset starts with a low even group (0002, 0008, ...) and small element
  if (group % 2 !== 0 || group === 0 || group > 0x0028 || element > 0x00ff) return null;
  if (VRS.has(String.fromCharCode(head[4], head[5]))) return 'explicit';
  return group === 0x0002 ? null : 'implicit'; // meta group is always explicit
}

export async function normalizeDicomFile(file){
  if (file.size < 132) return null;
  const kind = sniffDicom(new Uint8Array(await file.slice(0, 132).arrayBuffer()));
  if (!kind) return null;
  // explicit VR: dwv's default guess for bare datasets is right
  if (kind !== 'implicit') return file;
  const meta = new Blob(buildFileMeta(IMPLICIT_LE));
  // Large deflated ZIPs expose file-like lazy entries rather than Blobs.
  // Keep their prefixed form lazy too, or a bare-DICOM archive fills RAM.
  const fixed = file instanceof Blob
    ? new File([meta, file], file.name)
    : {
        name: file.name,
        size: meta.size + file.size,
        async arrayBuffer() { return new Blob([meta, await file.arrayBuffer()]).arrayBuffer(); },
        slice(start = 0, end = meta.size + file.size) {
          if (start === 0 && end <= meta.size) return meta.slice(0, end);
          const source = this;
          return {arrayBuffer: async () => (await source.arrayBuffer()).slice(start, end)};
        }
      };
  const rel = file.webkitRelativePath || file.relativePath;
  if (rel) {
    try { Object.defineProperty(fixed, 'relativePath', {value: rel}); } catch (err) { /* read-only */ }
  }
  return fixed;
}

function first(elements, key){
  const el = elements[key];
  if (!el || !el.value || el.value.length === 0) return undefined;
  return el.value[0];
}

function values(elements, key){
  const el = elements[key];
  return el && el.value ? el.value : undefined;
}

function str(elements, key){
  const v = first(elements, key);
  return typeof v === 'undefined' ? '' : String(v).trim();
}

function nums(elements, key){
  const v = values(elements, key);
  if (!v) return undefined;
  const out = Array.from(v).map(Number);
  return out.every(Number.isFinite) ? out : undefined;
}

function dirName(file){
  const p = file.webkitRelativePath || file.relativePath || '';
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

// box-average downsample of one frame, applying rescale slope/intercept
function downsampleFrame(px, rows, cols, f, slope, intercept, fast = false){
  const oh = Math.floor(rows / f);
  const ow = Math.floor(cols / f);
  const out = new Int16Array(ow * oh);
  const norm = 1 / (f * f);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      if (fast) {
        const cy = y * f + Math.floor(f / 2);
        const cx = x * f + Math.floor(f / 2);
        const v = px[cy * cols + cx] * slope + intercept;
        out[y * ow + x] = Math.max(-32768, Math.min(32767, v));
        continue;
      }
      let sum = 0;
      for (let dy = 0; dy < f; dy++) {
        let idx = (y * f + dy) * cols + x * f;
        for (let dx = 0; dx < f; dx++) sum += px[idx++];
      }
      let v = sum * norm * slope + intercept;
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out[y * ow + x] = v;
    }
  }
  return {data: out, width: ow, height: oh};
}

// DWV already ships this decoder for its slice viewer. Reuse its worker so
// compressed frames are decoded one at a time, outside the UI thread.
function createJpegLosslessDecoder(){
  const worker = new Worker(new URL('./assets/workers/jpegloss.worker.min.js', import.meta.url));
  return {
    decode(bytes, bitsAllocated, isSigned){
      if (!(bytes instanceof Uint8Array) || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
          ![8, 16].includes(bitsAllocated)) return Promise.reject(new Error('unsupported JPEG Lossless frame'));
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('JPEG Lossless decode timeout')); }, 30000);
        const cleanup = () => {
          clearTimeout(timeout);
          worker.onmessage = null;
          worker.onerror = null;
        };
        worker.onmessage = event => { cleanup(); resolve(event.data?.[0]); };
        worker.onerror = () => { cleanup(); reject(new Error('JPEG Lossless decode failed')); };
        worker.postMessage({buffer, meta: {bitsAllocated, isSigned}}, [buffer]);
      });
    },
    terminate(){ worker.terminate(); }
  };
}

// Reads and parses every file once. Returns the DICOM series found, each
// with its files and, for supported single-frame axial stacks, the
// downsampled pixel slices needed for the panoramic reconstruction.
export async function scanDicomFiles(files, onProgress, options = {}){
  const expanded = [];
  for (const file of files) {
    const largeDicom = !isIgnoredFile(file) && file.size > 32 * 1024 * 1024 &&
      sniffDicom(new Uint8Array(await file.slice(0, 132).arrayBuffer())) !== null;
    const frames = largeDicom ? await splitMultiframeDicom(file) : null;
    if (!frames && largeDicom && options.mobile && file.size > 180 * 1024 * 1024) throw new Error('dicom: mobile memory limit');
    expanded.push(...(frames || [file]));
  }
  files = expanded;
  const seriesMap = new Map();
  let skipped = 0;
  let jpegDecoder = null;
  try {
  for (let i = 0; i < files.length; i++) {
    let file = files[i];
    if (i % (options.mobile ? 2 : 10) === 0 || i === files.length - 1) {
      if (onProgress) onProgress(i + 1, files.length);
      await new Promise(r => setTimeout(r, 0));
    }
    if (isIgnoredFile(file)) { skipped++; continue; }

    let elements;
    try {
      const dicomFile = await normalizeDicomFile(file);
      if (!dicomFile) { skipped++; continue; }
      file = dicomFile;
      const buffer = await file.arrayBuffer();
      const parser = new DicomParser();
      parser.parse(buffer);
      elements = parser.getDicomElements();
    } catch (err) {
      skipped++;
      continue;
    }
    if (!elements || !elements['7FE00010']) { skipped++; continue; }

    const uid = str(elements, '0020000E') || ('dir:' + dirName(file));
    let s = seriesMap.get(uid);
    if (!s) {
      s = {
        uid,
        description: str(elements, '0008103E'),
        modality: str(elements, '00080060'),
        folder: dirName(file),
        files: [],
        slices: [],
        canVolume: true,
        canOverview: true,
        overview: null,
        overviewCount: 0,
        deferVolume: !!(options.mobile && options.firstVolumeOnly && seriesMap.size > 0)
      };
      seriesMap.set(uid, s);
    }
    s.files.push(file);

    if (s.deferVolume) continue;
    if (!s.canOverview && !s.canVolume) continue;
    const ts = str(elements, '00020010');
    const rows = Number(first(elements, '00280010'));
    const cols = Number(first(elements, '00280011'));
    const nFrames = Number(str(elements, '00280008') || 1);
    const ipp = nums(elements, '00200032');
    const iop = nums(elements, '00200037');
    const spacing = nums(elements, '00280030');
    const spp = Number(first(elements, '00280002') || 1);
    const compressed = ts === JPEG_LOSSLESS_TS;
    if ((!NATIVE_TS.has(ts) && !compressed) || nFrames !== 1 || spp !== 1 || !rows || !cols) {
      s.canVolume = false;
      s.canOverview = false;
      s.overview = null;
      s.slices = [];
      continue;
    }
    const bitsAllocated = Number(first(elements, '00280100'));
    const isSigned = Number(first(elements, '00280103')) === 1;
    let pixels = elements['7FE00010'].value[0];
    if (compressed) {
      try {
        jpegDecoder ||= createJpegLosslessDecoder();
        pixels = await jpegDecoder.decode(pixels, bitsAllocated, isSigned);
      } catch (err) { pixels = null; }
    }
    if (!pixels || pixels.length < rows * cols) {
      s.canVolume = false;
      s.canOverview = false;
      s.overview = null;
      s.slices = [];
      continue;
    }

    const f = Math.max(1, Math.ceil(Math.max(rows, cols) / (options.mobile ? 160 : TARGET_SIDE)));
    const slope = Number(str(elements, '00281053') || 1) || 1;
    const intercept = Number(str(elements, '00281052') || 0) || 0;
    const ds = downsampleFrame(pixels, rows, cols, f, slope, intercept, !!options.mobile);
    if (s.canOverview) updateOverview(s, ds, iop, spacing, f);
    if (s.canVolume && ipp && iop && iop.length === 6 && spacing) {
      s.slices.push({
        ipp, iop, f,
        rowSpacing: spacing[0], colSpacing: spacing[1],
        data: ds.data, width: ds.width, height: ds.height,
        source: {file, rows, cols, f, rowSpacing: spacing[0], colSpacing: spacing[1], slope, intercept,
          positionZ: ipp[2], transferSyntax: ts, bitsAllocated, isSigned}
      });
    } else {
      s.canVolume = false;
      s.slices = [];
    }
  }
  } finally {
    jpegDecoder?.terminate();
  }

  const series = [];
  for (const s of seriesMap.values()) {
    s.overview = s.canOverview ? finishOverview(s.overview, s.overviewCount) : null;
    s.volume = s.canVolume ? buildVolume(s.slices) : null;
    delete s.slices;
    delete s.canOverview;
    delete s.overviewCount;
    series.push(s);
  }
  series.sort((a, b) => b.files.length - a.files.length);
  return {series, skipped};
}

// Accumulate a small maximum-intensity projection without retaining all
// slices. This needs pixel frames, but not the position/orientation tags
// required by the dental panorama.
function updateOverview(series, frame, iop, spacing, f){
  const current = series.overview;
  if (!current) {
    series.overview = {
      data: new Int16Array(frame.data), width: frame.width, height: frame.height,
      pixelMm: [spacing?.[1] * f || 1, spacing?.[0] * f || 1],
      iop: iop?.length === 6 ? iop : null
    };
  } else {
    if (current.width !== frame.width || current.height !== frame.height ||
        (current.iop && iop?.length === 6 &&
          iop.some((v, i) => Math.abs(v - current.iop[i]) > 1e-3))) {
      series.canOverview = false;
      series.overview = null;
      return;
    }
    for (let i = 0; i < current.data.length; i++) {
      current.data[i] = Math.max(current.data[i], frame.data[i]);
    }
  }
  series.overviewCount++;
}

function finishOverview(overview, count){
  if (!overview || count < 2) return null;
  const sorted = Array.from(overview.data).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.01)];
  const hi = sorted[Math.floor(sorted.length * 0.995)];
  const {iop, ...image} = overview;
  return {...image, lo, hi: Math.max(lo + 1, hi)};
}

// Stacks axial slices into a volume. Slices are kept at their native
// spacing (it sets the panoramic's vertical resolution); only very thin
// slicing is decimated to stay near the in-plane spacing.
function buildVolume(slices){
  if (slices.length < MIN_VOLUME_SLICES) return null;
  const s0 = slices[0];
  const [r0, r1, r2, c0, c1, c2] = s0.iop;
  const normal = [r1 * c2 - r2 * c1, r2 * c0 - r0 * c2, r0 * c1 - r1 * c0];
  // only axial stacks: the arch is searched in the slice plane
  if (Math.abs(normal[2]) < 0.9) return null;
  const same = slices.every(s => s.width === s0.width && s.height === s0.height &&
    s.iop.every((v, i) => Math.abs(v - s0.iop[i]) < 1e-3));
  if (!same) return null;

  const sorted = slices.slice().sort((a, b) => a.ipp[2] - b.ipp[2]);
  const dz = Math.abs(sorted[sorted.length - 1].ipp[2] - sorted[0].ipp[2]) / (sorted.length - 1);
  if (!(dz > 0)) return null;
  const sx = s0.colSpacing * s0.f; // mm between columns
  const sy = s0.rowSpacing * s0.f; // mm between rows
  const step = Math.max(1, Math.floor(sx / dz / 2));
  const kept = sorted.filter((_, i) => i % step === 0);
  return {
    nx: s0.width, ny: s0.height, nz: kept.length,
    sx, sy, sz: dz * step,
    // data[z] ordered inferior -> superior
    data: kept.map(s => s.data),
    sources: sorted.map(s => s.source),
    // +1 when increasing column index goes towards the patient's left
    rowDirX: Math.sign(r0) || 1
  };
}

function percentileFromHistogram(hist, total, p){
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i - 32768;
  }
  return hist.length - 1 - 32768;
}

function volumeHistogram(vol, stride){
  const hist = new Uint32Array(65536);
  let total = 0;
  for (const slice of vol.data) {
    for (let i = 0; i < slice.length; i += stride) { hist[slice[i] + 32768]++; total++; }
  }
  return {hist, total};
}

// Finds the dental arch as a parabola y = a*x^2 + b*x + c (in voxels of
// the slice plane) fitted through the densest structures (enamel, crowns,
// implants) inside the slices that contain teeth.
export function detectArch(vol){
  const {hist, total} = volumeHistogram(vol, 7);
  // only enamel and metal are this dense; a looser cut also takes in the
  // skull and spine of large field-of-view scans and the band covers
  // the whole head
  // Saturated enamel/metal may occupy more than the selected percentile.
  // Keep those voxels eligible for the strictly-greater threshold below.
  const hi = Math.min(percentileFromHistogram(hist, total, 0.9997),
    percentileFromHistogram(hist, total, 1) - 1);

  const prof = vol.data.map(slice => {
    let n = 0;
    for (let i = 0; i < slice.length; i++) if (slice[i] > hi) n++;
    return n;
  });
  const maxProf = Math.max(...prof);
  if (maxProf === 0) return null;
  let z0 = -1, z1 = -1;
  prof.forEach((n, z) => {
    if (n > maxProf * 0.15) { if (z0 < 0) z0 = z; z1 = z; }
  });

  const n = vol.nx * vol.ny;
  const mip = new Int16Array(n).fill(-32768);
  for (let z = z0; z <= z1; z++) {
    const slice = vol.data[z];
    for (let i = 0; i < n; i++) if (slice[i] > mip[i]) mip[i] = slice[i];
  }
  let thr = hi;
  let count = 0;
  for (let i = 0; i < n; i++) if (mip[i] > thr) count++;
  if (count < 50) {
    thr = Int16Array.from(mip).sort()[Math.floor(n * 0.97)];
  }
  const xs = [], ys = [];
  for (let y = 0; y < vol.ny; y++) {
    for (let x = 0; x < vol.nx; x++) {
      if (mip[y * vol.nx + x] > thr) { xs.push(x); ys.push(y); }
    }
  }
  if (xs.length < 50) return null;

  let coef = fitParabola(xs, ys, null);
  // refit without outliers (spine, stray metal) a few times
  for (let it = 0; it < 3 && coef; it++) {
    const res = xs.map((x, i) => Math.abs(coef[0] * x * x + coef[1] * x + coef[2] - ys[i]));
    const cut = Math.max(Float64Array.from(res).sort()[Math.floor(res.length * 0.8)], 3);
    const next = fitParabola(xs, ys, res.map(r => r < cut));
    if (!next) break;
    coef = next;
  }
  if (!coef) return null;
  const [a, b, c] = coef;
  // a real arch bends noticeably across the field of view
  const bend = Math.abs(a) * (vol.nx / 2) * (vol.nx / 2);
  if (bend < vol.ny * 0.08) return null;
  return {a, b, c, z0, z1};
}

// least squares for y = a x^2 + b x + c over the points where keep[i]
function fitParabola(xs, ys, keep){
  let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
  for (let i = 0; i < xs.length; i++) {
    if (keep && !keep[i]) continue;
    const x = xs[i], y = ys[i], x2 = x * x;
    S0++; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2;
    T0 += y; T1 += x * y; T2 += x2 * y;
  }
  if (S0 < 20) return null;
  return solve3([[S4, S3, S2], [S3, S2, S1], [S2, S1, S0]], [T2, T1, T0]);
}

function solve3(M, v){
  const m = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const k = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= k * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// Samples the arch curve at even arc-length steps (one in-plane voxel).
// Returns points ordered from the patient's right to the patient's left,
// with unit normals pointing to the outer (buccal) side of the arch.
function archCurve(vol, arch, outputStepMm){
  const dense = [];
  const N = 4000;
  for (let i = 0; i <= N; i++) {
    const x = (vol.nx - 1) * i / N;
    const y = arch.a * x * x + arch.b * x + arch.c;
    if (y >= 0 && y <= vol.ny - 1) dense.push([x, y]);
  }
  if (dense.length < 10) return null;
  // work in mm so anisotropic pixels are handled
  const pts = dense.map(([x, y]) => [x * vol.sx, y * vol.sy]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const L = cum[cum.length - 1];
  const stepMm = outputStepMm || Math.min(vol.sx, vol.sz);
  const n = Math.max(2, Math.floor(L / stepMm));
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = L * k / (n - 1);
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const t = (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1);
    out.push([
      pts[j][0] + t * (pts[j + 1][0] - pts[j][0]),
      pts[j][1] + t * (pts[j + 1][1] - pts[j][1])
    ]);
  }
  // the arch apex (incisors) is the extreme of the parabola; the buccal
  // side is away from the parabola's opening
  const outward = arch.a > 0 ? -1 : 1;
  const curve = out.map((p, i) => {
    const pa = out[Math.max(0, i - 1)];
    const pb = out[Math.min(out.length - 1, i + 1)];
    let tx = pb[0] - pa[0], ty = pb[1] - pa[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    // perpendicular whose y component has the outward sign
    let nx = -ty, ny = tx;
    if (Math.sign(ny || 1e-9) !== outward) { nx = -nx; ny = -ny; }
    return {x: p[0], y: p[1], nx, ny};
  });
  // x index increasing = patient's left when rowDirX > 0; a panoramic
  // shows the patient's right on the viewer's left
  if (vol.rowDirX < 0) curve.reverse();
  return {points: curve, lengthMm: L, stepMm};
}

// CBCT volumes fill the corners outside the round field of view with one
// constant (often the type minimum). Returns it when it covers a large
// part of the volume, else null.
function paddingValue(vol){
  if (vol.pad !== undefined) return vol.pad;
  let min = 32767;
  for (const slice of vol.data) for (let i = 0; i < slice.length; i += 5) if (slice[i] < min) min = slice[i];
  let cnt = 0, tot = 0;
  for (const slice of vol.data) {
    for (let i = 0; i < slice.length; i += 5) { tot++; if (slice[i] === min) cnt++; }
  }
  // and it must be what fills the corners, not just dense air
  const mid = vol.data[vol.data.length >> 1];
  vol.pad = cnt > tot * 0.02 && mid[0] === min ? min : null;
  return vol.pad;
}

// Builds the panoramic image: for each point of the arch and each slice,
// the mean value through a slab of `thicknessMm` across the arch,
// optionally shifted buccally (+) or lingually (-) by `shiftMm`.
export function computePanoramic(vol, arch, {thicknessMm = 12, shiftMm = 0} = {}){
  const curve = archCurve(vol, arch);
  if (!curve) return null;
  const pts = curve.points;
  const W = pts.length;
  const H = vol.nz;
  // slab sampled at the in-plane spacing; finer gains nothing
  const slabStep = vol.sx;
  const K = Math.max(1, Math.round(thicknessMm / slabStep) + 1);
  const half = (K - 1) / 2;

  // sample coordinates (in voxels) for every (column, slab offset)
  const px = new Float32Array(W * K);
  const py = new Float32Array(W * K);
  for (let i = 0; i < W; i++) {
    const p = pts[i];
    for (let k = 0; k < K; k++) {
      const o = shiftMm + (k - half) * slabStep;
      px[i * K + k] = (p.x + p.nx * o) / vol.sx;
      py[i * K + k] = (p.y + p.ny * o) / vol.sy;
    }
  }

  const out = new Float32Array(W * H);
  const {nx, ny} = vol;
  const pad = paddingValue(vol);
  for (let z = 0; z < H; z++) {
    const slice = vol.data[z];
    const row = (H - 1 - z) * W; // superior at the top
    for (let i = 0; i < W; i++) {
      let sum = 0, cnt = 0;
      for (let k = 0; k < K; k++) {
        const x = px[i * K + k], y = py[i * K + k];
        if (x < 0 || y < 0 || x >= nx - 1 || y >= ny - 1) continue;
        const x0 = x | 0, y0 = y | 0;
        const fx = x - x0, fy = y - y0;
        const idx = y0 * nx + x0;
        // skip samples touching the area outside the scanned cylinder
        if (pad !== null && (slice[idx] === pad || slice[idx + 1] === pad ||
            slice[idx + nx] === pad || slice[idx + nx + 1] === pad)) continue;
        const v = (slice[idx] * (1 - fx) + slice[idx + 1] * fx) * (1 - fy) +
                  (slice[idx + nx] * (1 - fx) + slice[idx + nx + 1] * fx) * fy;
        sum += v; cnt++;
      }
      out[row + i] = cnt ? sum / cnt : NaN;
    }
  }

  // default display window from the image's own distribution
  const finite = out.filter(Number.isFinite).sort();
  // a darker floor than the minimum keeps soft tissue from washing out
  // the bone, close to how a panoramic radiograph looks
  const lo = finite.length ? finite[Math.floor(finite.length * 0.10)] : 0;
  const hi = finite.length ? finite[Math.floor(finite.length * 0.998)] : 1;
  return {
    width: W, height: H, data: out,
    // physical size of one output pixel (mm): along the arch, vertical
    pixelMm: [curve.stepMm, vol.sz],
    lo, hi
  };
}

// Re-read each native DICOM slice only after the low-memory panorama is
// visible. Sampling the arch at source pixel spacing raises detail without
// keeping the full CBCT volume in mobile Safari memory.
export async function computeDetailedPanoramic(vol, arch,
  {thicknessMm = 12, shiftMm = 0, onProgress, cancelled} = {}){
  const sources = vol.sources;
  if (!sources || sources.length < MIN_VOLUME_SLICES) return null;
  const first = sources[0];
  if (!(first.rows > 1 && first.cols > 1 && first.rowSpacing > 0 && first.colSpacing > 0)) return null;
  if (!sources.every(s => s.rows === first.rows && s.cols === first.cols &&
      s.rowSpacing === first.rowSpacing && s.colSpacing === first.colSpacing &&
      s.transferSyntax === first.transferSyntax)) return null;
  const curve = archCurve(vol, arch, first.colSpacing);
  if (!curve || curve.points.length > 2500) return null;
  const width = curve.points.length, height = sources.length;
  const samples = Math.max(2, Math.min(32, Math.ceil(thicknessMm / first.colSpacing) + 1));
  const px = new Float32Array(width * samples);
  const py = new Float32Array(width * samples);
  const xOffset = Math.floor(first.f / 2) * first.colSpacing;
  const yOffset = Math.floor(first.f / 2) * first.rowSpacing;
  for (let x = 0; x < width; x++) {
    const p = curve.points[x];
    for (let k = 0; k < samples; k++) {
      const distance = shiftMm + (k / (samples - 1) - 0.5) * thicknessMm;
      px[x * samples + k] = (p.x + xOffset + p.nx * distance) / first.colSpacing;
      py[x * samples + k] = (p.y + yOffset + p.ny * distance) / first.rowSpacing;
    }
  }
  const out = new Float32Array(width * height);
  const histogram = new Uint32Array(65536);
  const pad = paddingValue(vol);
  let finite = 0;
  const jpegDecoder = first.transferSyntax === JPEG_LOSSLESS_TS ? createJpegLosslessDecoder() : null;
  const order = Array.from({length: height}, (_, i) => i);
  if (first.file.streamSource && sources.every(source => source.file.streamSource === first.file.streamSource)) {
    // Anatomical Z order may be the reverse of ZIP stream order. Decode in
    // physical file order and place each result at its anatomical output row.
    order.sort((a, b) => sources[a].file.streamIndex - sources[b].file.streamIndex);
  }
  try {
  for (let work = 0; work < height; work++) {
    const z = order[work];
    if (cancelled?.()) return null;
    const source = sources[z];
    let pixels;
    if (source.kind === 'nnt') {
      pixels = (await readNntFrame(source.file)).pixels;
    } else {
      const parser = new DicomParser();
      parser.parse(await source.file.arrayBuffer());
      pixels = parser.getDicomElements()['7FE00010']?.value?.[0];
    }
    if (source.transferSyntax === JPEG_LOSSLESS_TS) {
      if (!jpegDecoder) return null;
      pixels = await jpegDecoder.decode(pixels, source.bitsAllocated, source.isSigned);
    }
    if (!pixels || pixels.length < source.rows * source.cols) return null;
    const rawPad = pad === null ? null : (pad - source.intercept) / source.slope;
    const row = (height - 1 - z) * width;
    for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let k = 0; k < samples; k++) {
        const sx = px[x * samples + k], sy = py[x * samples + k];
        if (sx < 0 || sy < 0 || sx >= source.cols - 1 || sy >= source.rows - 1) continue;
        const x0 = sx | 0, y0 = sy | 0;
        const i = y0 * source.cols + x0;
        if (rawPad !== null && (Math.abs(pixels[i] - rawPad) < 0.5 ||
            Math.abs(pixels[i + 1] - rawPad) < 0.5 ||
            Math.abs(pixels[i + source.cols] - rawPad) < 0.5 ||
            Math.abs(pixels[i + source.cols + 1] - rawPad) < 0.5)) continue;
        const fx = sx - x0, fy = sy - y0;
        const value = (pixels[i] * (1 - fx) + pixels[i + 1] * fx) * (1 - fy) +
          (pixels[i + source.cols] * (1 - fx) + pixels[i + source.cols + 1] * fx) * fy;
        sum += value; count++;
      }
      const value = count ? sum / count * source.slope + source.intercept : NaN;
      out[row + x] = value;
      if (Number.isFinite(value)) {
        histogram[Math.max(0, Math.min(65535, Math.round(value) + 32768))]++;
        finite++;
      }
    }
    if (work % 8 === 0 || work === height - 1) {
      onProgress?.(work + 1, height);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  } finally {
    jpegDecoder?.terminate();
  }
  if (finite < width * height * 0.1) return null;
  const lo = percentileFromHistogram(histogram, finite, 0.10);
  const hi = Math.max(lo + 1, percentileFromHistogram(histogram, finite, 0.998));
  const verticalMm = Math.abs(sources[height - 1].positionZ - first.positionZ) / (height - 1);
  return {width, height, data: out, pixelMm: [curve.stepMm, verticalMm], lo, hi,
    detailed: true};
}

// Renders panoramic values into RGBA with a linear window.
export function renderPanoramic(pano, lo, hi, imageData){
  const d = imageData.data;
  const scale = 255 / ((hi - lo) || 1);
  for (let i = 0; i < pano.data.length; i++) {
    const v = pano.data[i];
    let g = Number.isFinite(v) ? (v - lo) * scale : 0;
    if (g < 0) g = 0; else if (g > 255) g = 255;
    const o = i * 4;
    d[o] = d[o + 1] = d[o + 2] = g;
    d[o + 3] = 255;
  }
  return imageData;
}
