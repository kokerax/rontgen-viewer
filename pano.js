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

// keep the downsampled volume around this many voxels per side
const TARGET_SIDE = 420;

const MIN_VOLUME_SLICES = 40;

export function isIgnoredFile(file){
  return IGNORED_NAME.test(file.name);
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
function downsampleFrame(px, rows, cols, f, slope, intercept){
  const oh = Math.floor(rows / f);
  const ow = Math.floor(cols / f);
  const out = new Int16Array(ow * oh);
  const norm = 1 / (f * f);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
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

// Reads and parses every file once. Returns the DICOM series found, each
// with its files and, for uncompressed single-frame stacks, the
// downsampled pixel slices needed for the panoramic reconstruction.
export async function scanDicomFiles(files, onProgress){
  const seriesMap = new Map();
  let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress && (i % 10 === 0 || i === files.length - 1)) {
      onProgress(i + 1, files.length);
      await new Promise(r => setTimeout(r, 0));
    }
    if (isIgnoredFile(file)) { skipped++; continue; }

    let elements;
    try {
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
        canVolume: true
      };
      seriesMap.set(uid, s);
    }
    s.files.push(file);

    if (!s.canVolume) continue;
    const ts = str(elements, '00020010');
    const rows = Number(first(elements, '00280010'));
    const cols = Number(first(elements, '00280011'));
    const nFrames = Number(str(elements, '00280008') || 1);
    const ipp = nums(elements, '00200032');
    const iop = nums(elements, '00200037');
    const spacing = nums(elements, '00280030');
    const spp = Number(first(elements, '00280002') || 1);
    if (!NATIVE_TS.has(ts) || nFrames !== 1 || spp !== 1 ||
        !ipp || !iop || iop.length !== 6 || !spacing || !rows || !cols) {
      s.canVolume = false;
      s.slices = [];
      continue;
    }
    const pixels = elements['7FE00010'].value[0];
    if (!pixels || pixels.length < rows * cols) { s.canVolume = false; s.slices = []; continue; }

    const f = Math.max(1, Math.ceil(Math.max(rows, cols) / TARGET_SIDE));
    const slope = Number(str(elements, '00281053') || 1) || 1;
    const intercept = Number(str(elements, '00281052') || 0) || 0;
    const ds = downsampleFrame(pixels, rows, cols, f, slope, intercept);
    s.slices.push({
      ipp, iop, f,
      rowSpacing: spacing[0], colSpacing: spacing[1],
      data: ds.data, width: ds.width, height: ds.height
    });
  }

  const series = [];
  for (const s of seriesMap.values()) {
    s.volume = s.canVolume ? buildVolume(s.slices) : null;
    delete s.slices;
    series.push(s);
  }
  series.sort((a, b) => b.files.length - a.files.length);
  return {series, skipped};
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
  const hi = percentileFromHistogram(hist, total, 0.995);

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
  const sortedMip = Int16Array.from(mip).sort();
  const thr = sortedMip[Math.floor(n * 0.97)];

  // least squares for y = a x^2 + b x + c
  let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
  for (let y = 0; y < vol.ny; y++) {
    for (let x = 0; x < vol.nx; x++) {
      if (mip[y * vol.nx + x] <= thr) continue;
      const x2 = x * x;
      S0++; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2;
      T0 += y; T1 += x * y; T2 += x2 * y;
    }
  }
  if (S0 < 50) return null;
  const coef = solve3([[S4, S3, S2], [S3, S2, S1], [S2, S1, S0]], [T2, T1, T0]);
  if (!coef) return null;
  const [a, b, c] = coef;
  // a real arch bends noticeably across the field of view
  const xs = S1 / S0;
  const bend = Math.abs(a) * (vol.nx / 2) * (vol.nx / 2);
  if (bend < vol.ny * 0.08 || !Number.isFinite(xs)) return null;
  return {a, b, c, z0, z1};
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
function archCurve(vol, arch){
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
  const stepMm = Math.min(vol.sx, vol.sz);
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

// Builds the panoramic image: for each point of the arch and each slice,
// the mean value through a slab of `thicknessMm` across the arch,
// optionally shifted buccally (+) or lingually (-) by `shiftMm`.
export function computePanoramic(vol, arch, {thicknessMm = 20, shiftMm = 0} = {}){
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
        const v = (slice[idx] * (1 - fx) + slice[idx + 1] * fx) * (1 - fy) +
                  (slice[idx + nx] * (1 - fx) + slice[idx + nx + 1] * fx) * fy;
        sum += v; cnt++;
      }
      out[row + i] = cnt ? sum / cnt : NaN;
    }
  }

  // default display window from the image's own distribution
  const finite = out.filter(Number.isFinite).sort();
  const lo = finite.length ? finite[Math.floor(finite.length * 0.01)] : 0;
  const hi = finite.length ? finite[Math.floor(finite.length * 0.998)] : 1;
  return {
    width: W, height: H, data: out,
    // physical size of one output pixel (mm): along the arch, vertical
    pixelMm: [curve.stepMm, vol.sz],
    lo, hi
  };
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
