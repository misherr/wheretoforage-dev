/* The 30 m habitat grid: the projection, the native pixel grid, tiling, and reading what the service
 * returns. Pure — no network, no filesystem — so all of it is testable offline. `fetch-habitat.mjs`
 * does the fetching and owns the checkpoint.
 *
 * FETCH STAGE ONLY. Nothing here emits anything a score can read, nothing touches data/cells.json, and
 * the per-cell-summary versus per-pixel-tiles question is deliberately not answered anywhere in this
 * file. See ROADMAP.md, "the 30 m habitat rebuild".
 *
 * ===================== the native grid, measured =====================
 *
 * LANDFIRE's CONUS rasters are 30 m in EPSG:5070 (NAD83 / Conus Albers). The grid's PHASE matters and
 * is not what you would guess: the service's own extent corner is x -2,362,425, y 3,267,405, and both
 * are **15 mod 30**. So native pixel EDGES sit at 15 mod 30 and native pixel CENTRES at multiples of
 * 30. Snapping a request to multiples of 30 — the obvious rule, and the one ROADMAP.md carried at
 * first — puts the request's pixel centres on native pixel EDGES, half a pixel out.
 *
 * That was measured rather than inferred, because the declaration could have been rounded: oversample
 * a strip at 3 m and the value boundaries are where the native pixel edges are. Over two areas,
 * **615 of 615 boundaries sat at phase 15 and none at phase 0**, and the runs between them were exact
 * multiples of ten 3 m samples. The grid is real, the phase is 15, and `ALIGN` below is the only place
 * that knows it.
 *
 * **The service honours whatever phase you ask for.** It does not snap for you: requests at phase 15,
 * 0 and 7 all came back at exactly the bbox asked for, all at 30.000 m pixels. Alignment is entirely
 * the client's problem, which is why `alignedWindow()` is the only way this code builds a request.
 *
 * ===================== two traps, and what each costs =====================
 *
 * 1. **Wrong resolution.** Ask in degrees, or with a size that does not match the extent, and the
 *    service resamples to whatever pixel size makes the numbers work — 41.7 m in the observed case.
 *    That destroys the one-to-one correspondence with native pixels: values are averaged or
 *    duplicated, and the result is not LANDFIRE data any more. This is the bad one.
 * 2. **Wrong phase.** Ask at 30 m on the wrong phase and every value is still a real LANDFIRE value;
 *    each output pixel's centre lands on a native edge and the tie resolves deterministically, so the
 *    raster comes back DISPLACED by up to 15 m rather than corrupted. Measured: a window moved -15 m
 *    matched the aligned read at the same index 100.0% of the time, and one moved +15 m matched it one
 *    pixel across, also 100.0%. So the cost is a half-pixel geolocation error, not wrong data — worth
 *    getting right, and worth not overstating.
 *
 * **Neither trap is caught by the two checks that look like they would.** A misaligned request still
 * reports 30.000 m pixels, and `identify` at each output pixel's centre still agrees with the raster
 * — nearest-neighbour gives the output pixel the value of the native pixel containing its centre, and
 * `identify` returns the value of the native pixel containing the same point, so the two agree
 * whatever the alignment. An earlier version of this work "verified alignment" that way and got 8/8
 * and then 24/24 on heterogeneous ground, while proving nothing about it. The real test is
 * `phaseOfBoundaries()`: oversample, find where values change, and look at the phase of those
 * boundaries. `identify` still earns its keep, but as a check on projection and pixel indexing, which
 * is a different claim. */

/* ===================== the service ===================== */

export const SERVICE = 'https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2024/';
export const LAYERS = [
  { key: 'evt', id: 'LF2024_EVT_CONUS', what: 'existing vegetation type' },
  { key: 'evc', id: 'LF2024_EVC_CONUS', what: 'existing vegetation cover' },
  { key: 'evh', id: 'LF2024_EVH_CONUS', what: 'existing vegetation height' },
];
export const layerUrl = id => SERVICE + id + '/ImageServer';
export const NODATA = -9999;          // the service's declared noDataValue, all three layers
export const PIXEL_TYPE = 'S16';      // and all three are signed 16-bit thematic

/* ===================== the native pixel grid ===================== */

export const PIXEL = 30;
/* The service's own extent corner. Every native pixel edge is this plus a multiple of PIXEL. */
export const ORIGIN_X = -2362425, ORIGIN_Y = 3267405;
export const PHASE = ((ORIGIN_X % PIXEL) + PIXEL) % PIXEL;      // 15

export const phaseOf = v => ((v % PIXEL) + PIXEL) % PIXEL;
/* Down/up to the nearest native pixel edge. Anchored on ORIGIN so the arithmetic cannot drift. */
export const edgeDown = v => ORIGIN_X + Math.floor((v - ORIGIN_X) / PIXEL) * PIXEL;
export const edgeUp = v => ORIGIN_X + Math.ceil((v - ORIGIN_X) / PIXEL) * PIXEL;
/* ORIGIN_X and ORIGIN_Y share a phase, so one pair of helpers serves both axes. Asserted in the tests
   rather than assumed, because a future LANDFIRE release could publish a different corner. */
export const sameOriginPhase = phaseOf(ORIGIN_X) === phaseOf(ORIGIN_Y);

/* A request window, snapped OUTWARD to native edges: the only way this code builds a bbox. Returns the
   bbox to ask for and the pixel counts that go with it, which are integers by construction. */
export function alignedWindow(x0, y0, x1, y1) {
  const xmin = edgeDown(Math.min(x0, x1)), xmax = edgeUp(Math.max(x0, x1));
  const ymin = edgeDown(Math.min(y0, y1)), ymax = edgeUp(Math.max(y0, y1));
  const w = Math.round((xmax - xmin) / PIXEL), h = Math.round((ymax - ymin) / PIXEL);
  return { bbox: [xmin, ymin, xmax, ymax], w, h };
}
/* Is a window one this code would have produced? The fetch refuses anything else — the wrong rule
   cannot come back by way of a hand-built bbox. */
export function isAligned(bbox, w, h) {
  const [xmin, ymin, xmax, ymax] = bbox;
  return [xmin, ymin, xmax, ymax].every(v => phaseOf(v) === PHASE)
    && Math.abs((xmax - xmin) / PIXEL - w) < 1e-9 && Math.abs((ymax - ymin) / PIXEL - h) < 1e-9
    && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0;
}

/* Which pixel of a window a projected point falls in. Row 0 is the TOP, the way the raster is laid
   out. Returns null outside the window rather than a clamped guess. */
export function pixelAt(bbox, w, h, x, y) {
  const [xmin, ymin, xmax, ymax] = bbox;
  if (x < xmin || x >= xmax || y <= ymin || y > ymax) return null;
  return { col: Math.floor((x - xmin) / PIXEL), row: Math.floor((ymax - y) / PIXEL) };
}
/* The centre of pixel (col, row) — on a native centre, so a multiple of PIXEL. */
export function pixelCentre(bbox, col, row) {
  return [bbox[0] + (col + 0.5) * PIXEL, bbox[3] - (row + 0.5) * PIXEL];
}

/* ===================== tiling ===================== */

/* The window cut into requests. `keep(tile)` may drop a tile nothing needs — over Washington a
   bounding box is mostly not Washington, and skipping the empty tiles is most of the saving. */
export function tiles(win, tilePx = 4096, keep = null) {
  const out = [];
  const cols = Math.ceil(win.w / tilePx), rows = Math.ceil(win.h / tilePx);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = Math.min(tilePx, win.w - c * tilePx), h = Math.min(tilePx, win.h - r * tilePx);
      const xmin = win.bbox[0] + c * tilePx * PIXEL, ymax = win.bbox[3] - r * tilePx * PIXEL;
      const t = { row: r, col: c, w, h, bbox: [xmin, ymax - h * PIXEL, xmin + w * PIXEL, ymax],
                  pixels: w * h, key: r + '_' + c };
      if (!keep || keep(t)) out.push(t);
    }
  }
  return out;
}

/* ===================== EPSG:5070, NAD83 / Conus Albers ===================== */

/* Albers equal-area conic on GRS80, from Snyder. Needed to decide which tiles hold cells and to place
   a lat/lon sample in a pixel; verified against the service's own conversion in the fetch's preflight,
   which is the only oracle available here, and round-tripped in the tests. */
const A = 6378137.0, E2 = 0.00669438002290, E = Math.sqrt(E2);
const LAT0 = 23 * Math.PI / 180, LON0 = -96 * Math.PI / 180;
const LAT1 = 29.5 * Math.PI / 180, LAT2 = 45.5 * Math.PI / 180;

const qOf = p => { const s = Math.sin(p);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s))); };
const mOf = p => { const s = Math.sin(p); return Math.cos(p) / Math.sqrt(1 - E2 * s * s); };

const m1 = mOf(LAT1), m2 = mOf(LAT2), q1 = qOf(LAT1), q2 = qOf(LAT2), q0 = qOf(LAT0);
const N = (m1 * m1 - m2 * m2) / (q2 - q1);
const C = m1 * m1 + N * q1;
const RHO0 = A * Math.sqrt(C - N * q0) / N;

export function project(lat, lon) {
  const p = lat * Math.PI / 180, l = lon * Math.PI / 180;
  const rho = A * Math.sqrt(C - N * qOf(p)) / N;
  const th = N * (l - LON0);
  return [rho * Math.sin(th), RHO0 - rho * Math.cos(th)];
}
export function unproject(x, y) {
  const rho = Math.hypot(x, RHO0 - y);
  const th = Math.atan2(x, RHO0 - y);
  const lon = LON0 + th / N;
  const q = (C - rho * rho * N * N / (A * A)) / N;
  let p = Math.asin(Math.max(-1, Math.min(1, q / 2)));
  for (let i = 0; i < 30; i++) {                       // Snyder's iteration; converges in a handful
    const s = Math.sin(p), c = Math.cos(p), t = 1 - E2 * s * s;
    const d = (t * t / (2 * c)) * (q / (1 - E2) - s / t + (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
    p += d;
    if (Math.abs(d) < 1e-12) break;
  }
  return [p * 180 / Math.PI, lon * 180 / Math.PI];
}

/* ===================== reading what the service returns ===================== */

/* The TIFF the service sends: uncompressed, 16-bit signed, and TILED in 128 x 128 blocks. The tiling
   is the part that bites — a first version read the first tile's offset and then indexed as if rows
   were contiguous, so every column past 128 was garbage, and it looked like real data with plausible
   variation. The `tileOffsets` array has one entry per block and all of them have to be walked. */
export function readTiff(buf, expect = null) {
  if (buf.length < 8) throw new Error('truncated: ' + buf.length + ' bytes');
  const le = buf.toString('ascii', 0, 2) === 'II';
  if (!le && buf.toString('ascii', 0, 2) !== 'MM') throw new Error('not a TIFF');
  const u16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
  const u32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
  const i16 = o => le ? buf.readInt16LE(o) : buf.readInt16BE(o);
  if (u16(2) !== 42) throw new Error('not a TIFF (magic ' + u16(2) + ')');

  const ifd = u32(4), n = u16(ifd), T = new Map();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    T.set(u16(e), { type: u16(e + 2), count: u32(e + 4), value: u32(e + 8) });
  }
  const one = t => { const g = T.get(t); return g ? g.value : undefined; };
  const many = t => {
    const g = T.get(t); if (!g) return [];
    if (g.count === 1) return [g.value];
    const out = [];
    for (let i = 0; i < g.count; i++) out.push(g.type === 3 ? u16(g.value + i * 2) : u32(g.value + i * 4));
    return out;
  };

  const w = one(256), h = one(257);
  if (!w || !h) throw new Error('no image dimensions');
  const bits = one(258) || 1, comp = one(259) || 1, samples = one(277) || 1;
  if (bits !== 16) throw new Error('expected 16-bit samples, got ' + bits);
  if (comp !== 1) throw new Error('expected uncompressed, got compression ' + comp);
  if (samples !== 1) throw new Error('expected one sample per pixel, got ' + samples);
  if (expect && (w !== expect.w || h !== expect.h))
    throw new Error('asked for ' + expect.w + 'x' + expect.h + ', got ' + w + 'x' + h);

  const data = new Int16Array(w * h);
  const need = o => { if (o < 0 || o + 1 >= buf.length) throw new Error('pixel offset past the end of the buffer'); };
  if (T.has(324)) {
    const tw = one(322), tl = one(323), offs = many(324);
    if (!tw || !tl) throw new Error('tiled without tile dimensions');
    const across = Math.ceil(w / tw), down = Math.ceil(h / tl);
    if (offs.length !== across * down)
      throw new Error('expected ' + across * down + ' tiles, the file lists ' + offs.length);
    for (let k = 0; k < offs.length; k++) {
      const tx = (k % across) * tw, ty = Math.floor(k / across) * tl;
      for (let y = 0; y < tl; y++) {
        const gy = ty + y; if (gy >= h) break;
        for (let x = 0; x < tw; x++) {
          const gx = tx + x; if (gx >= w) continue;
          const o = offs[k] + (y * tw + x) * 2; need(o);
          data[gy * w + gx] = i16(o);
        }
      }
    }
  } else {
    const rows = one(278) || h, offs = many(273);
    if (!offs.length) throw new Error('neither tiled nor stripped');
    for (let s = 0; s < offs.length; s++) {
      for (let y = 0; y < rows; y++) {
        const gy = s * rows + y; if (gy >= h) break;
        for (let x = 0; x < w; x++) {
          const o = offs[s] + (y * w + x) * 2; need(o);
          data[gy * w + x] = i16(o);
        }
      }
    }
  }
  return { w, h, data, tiled: T.has(324), at: (c, r) => data[r * w + c] };
}

/* ===================== the alignment test ===================== */

/* Where the value boundaries fall, as a histogram of phase mod PIXEL. Give it an oversampled read —
 * `over` samples across each native pixel — and an aligned grid puts every boundary at PHASE and every
 * run at a multiple of `over`. This is the test that actually distinguishes native pixels from a
 * resampling of them; see the header for the two checks that do not.
 *
 * Pure, so the fetch's live probe and the offline tests run the same code over the same shape. */
export function phaseOfBoundaries(img, extent, over) {
  const px = (extent[2] - extent[0]) / img.w;
  const hist = new Map(), runs = new Map();
  let changes = 0;
  for (let r = 0; r < img.h; r++) {
    let run = 1;
    for (let c = 1; c < img.w; c++) {
      if (img.at(c, r) === img.at(c - 1, r)) { run++; continue; }
      changes++;
      runs.set(run, (runs.get(run) || 0) + 1);
      run = 1;
      const p = Math.round(phaseOf(extent[0] + c * px));
      hist.set(p, (hist.get(p) || 0) + 1);
    }
  }
  const onPhase = [...hist].filter(([p]) => Math.min(Math.abs(p - PHASE), PIXEL - Math.abs(p - PHASE)) <= 1)
    .reduce((s, [, k]) => s + k, 0);
  const cleanRuns = [...runs].every(([len]) => len % over === 0);
  return { changes, onPhase, hist, runs, cleanRuns, pixelSize: px,
           aligned: changes > 0 && onPhase === changes && cleanRuns };
}
