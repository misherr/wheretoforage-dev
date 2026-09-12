/* The 30 m habitat grid. Run: node --test scripts/habitat-grid.test.mjs   (npm run test:data globs it)
 *
 * The snapping tests come first because the phase is the trap: LANDFIRE's native pixel edges are at
 * 15 mod 30 in EPSG:5070, not at multiples of 30, and a request on the wrong phase comes back looking
 * perfectly healthy — right pixel size, and `identify` agreeing at every pixel centre — while reading
 * ground displaced by half a pixel. ROADMAP.md carried the wrong rule until this was measured.
 *
 * Offline by design: everything here is arithmetic or a synthetic TIFF, so CI runs it. The live checks
 * belong to fetch-habitat.mjs, which probes the real grid before it spends a gigabyte and records what
 * it found in the manifest. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from './habitat-grid.mjs';

test('phase: the native grid sits at 15 mod 30, and that is measured, not assumed', () => {
  assert.equal(G.PIXEL, 30);
  assert.equal(G.PHASE, 15, 'the service extent corner is 15 mod 30 — snapping to multiples of 30 is '
    + 'half a pixel out, and 615 of 615 measured value boundaries agreed');
  assert.equal(G.phaseOf(G.ORIGIN_X), 15);
  assert.equal(G.phaseOf(G.ORIGIN_Y), 15);
  assert.ok(G.sameOriginPhase, 'both axes share the phase, so one pair of edge helpers serves both');
  /* the obvious-but-wrong rule, pinned so nobody reintroduces it as a simplification */
  assert.notEqual(G.PHASE, 0, 'if this ever becomes 0, LANDFIRE republished the grid — re-measure '
    + 'with phaseOfBoundaries() before believing it');
});

test('snapping: a window is always snapped outward onto native edges', () => {
  /* an arbitrary interior box, nowhere near an edge */
  const w = G.alignedWindow(-1930000, 3129000, -1928000, 3131000);
  for (const v of w.bbox) assert.equal(G.phaseOf(v), G.PHASE, 'every side lands on a native edge');
  assert.ok(Number.isInteger(w.w) && Number.isInteger(w.h), 'so the pixel counts are whole');
  assert.equal((w.bbox[2] - w.bbox[0]) / G.PIXEL, w.w);
  assert.equal((w.bbox[3] - w.bbox[1]) / G.PIXEL, w.h);
  /* outward, never inward: the asked-for ground is inside what comes back */
  assert.ok(w.bbox[0] <= -1930000 && w.bbox[2] >= -1928000);
  assert.ok(w.bbox[1] <= 3129000 && w.bbox[3] >= 3131000);
  /* already-aligned input is left alone */
  const exact = G.alignedWindow(G.ORIGIN_X, G.ORIGIN_Y - 300, G.ORIGIN_X + 300, G.ORIGIN_Y);
  assert.deepEqual(exact.bbox, [G.ORIGIN_X, G.ORIGIN_Y - 300, G.ORIGIN_X + 300, G.ORIGIN_Y]);
  assert.equal(exact.w, 10); assert.equal(exact.h, 10);
  /* and the one-metre-out case, which is the realistic mistake */
  const off = G.alignedWindow(-1930000 + 1, 3129000 + 1, -1928000 + 1, 3131000 + 1);
  for (const v of off.bbox) assert.equal(G.phaseOf(v), G.PHASE);
});

test('snapping: a window on the wrong phase is refused, so the wrong rule cannot come back', () => {
  const good = G.alignedWindow(-1930000, 3129000, -1928000, 3131000);
  assert.ok(G.isAligned(good.bbox, good.w, good.h));
  /* the rule ROADMAP.md had at first: multiples of 30 */
  const wrong = [-1930020, 3128970, -1928010, 3130980];
  for (const v of wrong) assert.equal(G.phaseOf(v), 0, 'this is what the wrong rule produces');
  assert.equal(G.isAligned(wrong, (wrong[2] - wrong[0]) / 30, (wrong[3] - wrong[1]) / 30), false,
    'and it is refused — a half-pixel displacement is invisible in the result, so it has to be '
    + 'caught at the request');
  /* a right-phase bbox with a pixel count that does not match it is also refused: that is the
     resolution trap, which resamples and really does destroy the data */
  assert.equal(G.isAligned(good.bbox, good.w + 1, good.h), false);
  assert.equal(G.isAligned(good.bbox, 100.5, good.h), false);
  assert.equal(G.isAligned(good.bbox, 0, good.h), false);
});

test('pixels: a point lands in the pixel that contains it, and outside is null', () => {
  const w = G.alignedWindow(-1930005, 3129015, -1929705, 3129315);   // 10 x 10 pixels
  assert.equal(w.w, 10); assert.equal(w.h, 10);
  const [xmin, ymin, xmax, ymax] = w.bbox;
  assert.deepEqual(G.pixelAt(w.bbox, w.w, w.h, xmin + 1, ymax - 1), { col: 0, row: 0 },
    'row 0 is the top, the way the raster is laid out');
  assert.deepEqual(G.pixelAt(w.bbox, w.w, w.h, xmax - 1, ymin + 1), { col: 9, row: 9 });
  assert.equal(G.pixelAt(w.bbox, w.w, w.h, xmin - 1, ymax - 1), null);
  assert.equal(G.pixelAt(w.bbox, w.w, w.h, xmin + 1, ymax + 1), null);
  /* a pixel centre is on a native centre, so a multiple of 30 */
  const [cx, cy] = G.pixelCentre(w.bbox, 3, 4);
  assert.equal(G.phaseOf(cx), 0); assert.equal(G.phaseOf(cy), 0);
  assert.deepEqual(G.pixelAt(w.bbox, w.w, w.h, cx, cy), { col: 3, row: 4 }, 'and it round-trips');
});

test('tiling: the tiles cover the window exactly, with no gap and no overlap', () => {
  const win = G.alignedWindow(-1930005, 3120015, -1930005 + 250 * 30, 3120015 + 130 * 30);
  assert.equal(win.w, 250); assert.equal(win.h, 130);
  const ts = G.tiles(win, 100);
  assert.equal(ts.length, 3 * 2, 'ceil(250/100) x ceil(130/100)');
  /* every tile is itself an aligned window */
  for (const t of ts) assert.ok(G.isAligned(t.bbox, t.w, t.h), t.key + ' is aligned');
  /* the edge tiles are short rather than overhanging */
  assert.deepEqual(ts.map(t => t.w), [100, 100, 50, 100, 100, 50]);
  assert.deepEqual(ts.map(t => t.h), [100, 100, 100, 30, 30, 30]);
  /* the areas add up to the window exactly */
  assert.equal(ts.reduce((s, t) => s + t.pixels, 0), win.w * win.h);
  /* and the union is the window: no tile strays outside it */
  for (const t of ts) {
    assert.ok(t.bbox[0] >= win.bbox[0] && t.bbox[2] <= win.bbox[2]);
    assert.ok(t.bbox[1] >= win.bbox[1] && t.bbox[3] <= win.bbox[3]);
  }
  /* keep() drops what nothing needs — the saving that makes a bounding box over Washington affordable */
  const some = G.tiles(win, 100, t => t.col === 0);
  assert.equal(some.length, 2);
});

test('projection: EPSG:5070 round-trips, and honours its own origin', () => {
  /* at the central meridian x is 0, and at the latitude of origin on it y is 0 too */
  const [x0, y0] = G.project(23, -96);
  assert.ok(Math.abs(x0) < 1e-6, 'x on the central meridian: ' + x0);
  assert.ok(Math.abs(y0) < 1e-6, 'y at the latitude of origin: ' + y0);
  assert.ok(Math.abs(G.project(47, -96)[0]) < 1e-6, 'still zero further north');
  /* east of the meridian is positive x, west negative; north is larger y */
  assert.ok(G.project(47, -90)[0] > 0);
  assert.ok(G.project(47, -122)[0] < 0);
  assert.ok(G.project(49, -120)[1] > G.project(46, -120)[1]);
  /* round trip over Washington, to a millimetre of latitude */
  for (const [lat, lon] of [[45.6, -124.5], [47.5, -120.5], [49.0, -117.0], [48.8003, -122.0556]]) {
    const [x, y] = G.project(lat, lon);
    const [la, lo] = G.unproject(x, y);
    assert.ok(Math.abs(la - lat) < 1e-9, 'lat ' + lat + ' -> ' + la);
    assert.ok(Math.abs(lo - lon) < 1e-9, 'lon ' + lon + ' -> ' + lo);
  }
  /* Washington lands where the service's own extent says it should */
  const [wx, wy] = G.project(47.5, -120.5);
  assert.ok(wx > -2362425 && wx < 2327655, 'inside the CONUS extent in x');
  assert.ok(wy > 221265 && wy < 3267405, 'and in y');
  /* A degree of latitude here measures 106,967 m, not 111,320: an equal-area conic compresses
     meridians wherever it stretches parallels, and Washington is north of the second standard
     parallel (45.5°). That is the projection working, so it is not a useful guard. */
  const oneDegree = G.project(48, -120)[1] - G.project(47, -120)[1];
  assert.ok(oneDegree > 106000 && oneDegree < 108000, 'compressed, as an equal-area conic must: ' + oneDegree);
});

test('projection: it matches the service, and the residue is the NAD83/WGS84 datum', () => {
  /* The round trip and the origin invariants would pass with a wrong ellipsoid constant, so the
     service's own conversion is the oracle. These five came from identify with returnGeometry on
     2026-09-12 — a WGS84 point in, a 5070 location back:

       lat, lon (WGS84)        service x, y (EPSG:5070)
       48.8003140 -122.0556248  -1912226.16  3130075.19
       47.5       -120.5        -1837219.48  2961116.04
       45.6       -124.0        -2153672.43  2832025.76
       49.0       -117.1        -1550420.66  3061050.00
       46.2       -119.0        -1761508.45  2793259.21

     project() is a pure NAD83 Albers with no datum shift, and the app's coordinates are WGS84, so it
     is expected to sit a CONSTANT ~1.3 m away. A constant offset is a datum; a varying one would be a
     wrong ellipsoid or a wrong standard parallel, which is what this pins down. */
  const REF = [
    [48.8003140, -122.0556248, -1912226.16, 3130075.19],
    [47.5, -120.5, -1837219.48, 2961116.04],
    [45.6, -124.0, -2153672.43, 2832025.76],
    [49.0, -117.1, -1550420.66, 3061050.00],
    [46.2, -119.0, -1761508.45, 2793259.21],
  ];
  const dx = [], dy = [];
  for (const [lat, lon, sx, sy] of REF) {
    const [x, y] = G.project(lat, lon);
    dx.push(sx - x); dy.push(sy - y);
  }
  const spread = a => Math.max(...a) - Math.min(...a);
  assert.ok(spread(dx) < 0.05, 'the x offset is constant to within 5 cm: ' + spread(dx).toFixed(3));
  assert.ok(spread(dy) < 0.05, 'and the y offset too: ' + spread(dy).toFixed(3));
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const off = Math.hypot(mean(dx), mean(dy));
  assert.ok(off > 0.5 && off < 3, 'and it is datum-sized, about 1.3 m: ' + off.toFixed(3));
  /* 1.3 m is 4% of a pixel. It does not matter for a summary over 2,886 pixels and it is not nothing
     for per-pixel tiles, so a later emission step has to decide about it rather than meet it by
     surprise — see ROADMAP.md. A verification that compares against the service must ask in 5070 with
     an already-projected coordinate, or this offset shows up as a 12% disagreement rate that looks
     like a bug. */
});

/* ===================== the TIFF reader ===================== */

/* A tiled, uncompressed, 16-bit TIFF, built here so the reader is tested against the layout the
   service actually sends. MULTI-TILE on purpose: the first version of the reader took the first tile
   offset and indexed as if the rows were contiguous, so everything past column 128 was garbage that
   looked like plausible data. A single-tile fixture would have passed. */
function tiledTiff(w, h, tw, tl, valueAt) {
  const across = Math.ceil(w / tw), down = Math.ceil(h / tl), nTiles = across * down;
  const tileBytes = tw * tl * 2;
  const tags = [[256, 3, w], [257, 3, h], [258, 3, 16], [259, 3, 1], [277, 3, 1],
                [322, 3, tw], [323, 3, tl], [339, 3, 2]];
  const nEntries = tags.length + 2;                       // + tileOffsets, tileByteCounts
  const ifdAt = 8;
  const ifdBytes = 2 + nEntries * 12 + 4;
  const arraysAt = ifdAt + ifdBytes;
  const offsetsAt = arraysAt, countsAt = arraysAt + nTiles * 4;
  const pixelsAt = countsAt + nTiles * 4;
  const buf = Buffer.alloc(pixelsAt + nTiles * tileBytes);
  buf.write('II', 0, 'ascii'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifdAt, 4);
  buf.writeUInt16LE(nEntries, ifdAt);
  const entries = [...tags.map(([t, ty, v]) => [t, ty, 1, v]),
                   [324, 4, nTiles, nTiles === 1 ? pixelsAt : offsetsAt],
                   [325, 4, nTiles, nTiles === 1 ? tileBytes : countsAt]]
                  .sort((a, b) => a[0] - b[0]);
  entries.forEach(([tag, type, count, value], i) => {
    const e = ifdAt + 2 + i * 12;
    buf.writeUInt16LE(tag, e); buf.writeUInt16LE(type, e + 2);
    buf.writeUInt32LE(count, e + 4); buf.writeUInt32LE(value, e + 8);
  });
  for (let k = 0; k < nTiles; k++) {
    buf.writeUInt32LE(pixelsAt + k * tileBytes, offsetsAt + k * 4);
    buf.writeUInt32LE(tileBytes, countsAt + k * 4);
  }
  for (let k = 0; k < nTiles; k++) {
    const tx = (k % across) * tw, ty = Math.floor(k / across) * tl;
    for (let y = 0; y < tl; y++) for (let x = 0; x < tw; x++) {
      const gx = tx + x, gy = ty + y;
      const v = gx < w && gy < h ? valueAt(gx, gy) : 0;
      buf.writeInt16LE(v, pixelsAt + k * tileBytes + (y * tw + x) * 2);
    }
  }
  return buf;
}

test('tiff: a multi-tile image is stitched, not read as one tile', () => {
  /* 300 x 200 in 128 x 128 tiles is 3 across and 2 down — the shape the service returns */
  const value = (x, y) => ((x * 7 + y * 13) % 900) + 11;
  const buf = tiledTiff(300, 200, 128, 128, value);
  const img = G.readTiff(buf, { w: 300, h: 200 });
  assert.equal(img.w, 300); assert.equal(img.h, 200);
  assert.ok(img.tiled);
  let bad = 0;
  for (let r = 0; r < 200; r++) for (let c = 0; c < 300; c++) if (img.at(c, r) !== value(c, r)) bad++;
  assert.equal(bad, 0, 'every pixel, including the ones past the first tile');
  /* the specific failure: column 128 onwards came back as the wrong tile's pixels */
  assert.equal(img.at(200, 5), value(200, 5), 'a pixel in the second tile across');
  assert.equal(img.at(50, 150), value(50, 150), 'and one in the second tile down');
});

test('tiff: negative values survive, because NoData is -9999', () => {
  const img = G.readTiff(tiledTiff(40, 40, 128, 128, (x, y) => (x < 20 ? G.NODATA : 150)));
  assert.equal(img.at(0, 0), -9999, 'read as signed, or NoData reads as 55,537');
  assert.equal(img.at(30, 0), 150);
  assert.equal(G.NODATA, -9999);
});

test('tiff: a file that is not what was asked for throws rather than returning pixels', () => {
  assert.throws(() => G.readTiff(Buffer.alloc(4)), /truncated/);
  assert.throws(() => G.readTiff(Buffer.from('not a tiff at all', 'ascii')), /not a TIFF/);
  /* the size guard: a short tile is the shape a truncated download takes */
  const buf = tiledTiff(300, 200, 128, 128, () => 1);
  assert.throws(() => G.readTiff(buf, { w: 300, h: 300 }), /asked for 300x300, got 300x200/);
  /* Cut into a tile the reader actually walks. Trimming only the tail of the last tile proves
     nothing: the edge tiles are partly outside the image, so their final bytes are never read. */
  assert.throws(() => G.readTiff(buf.subarray(0, Math.floor(buf.length * 0.4))), /past the end of the buffer/);
});

/* ===================== the alignment test itself ===================== */

test('alignment: oversampled boundaries land on one phase, and runs are whole native pixels', () => {
  /* A synthetic aligned read: 10 samples across each native pixel, value changing every native pixel.
     This is the shape the live probe checks, so the same code path is exercised offline. */
  const over = 10, nat = 20, w = nat * over, h = 4;
  const extent = [G.ORIGIN_X, G.ORIGIN_Y - h * 3, G.ORIGIN_X + w * 3, G.ORIGIN_Y];
  const aligned = { w, h, at: (c) => 100 + Math.floor(c / over) };
  const r = G.phaseOfBoundaries(aligned, extent, over);
  assert.equal(r.pixelSize, 3, 'three-metre samples');
  assert.equal(r.changes, (nat - 1) * h);
  assert.equal(r.onPhase, r.changes, 'every boundary at the native phase');
  assert.ok(r.cleanRuns, 'and every run a whole number of native pixels');
  assert.ok(r.aligned);

  /* the same read displaced half a native pixel: boundaries fall off the phase */
  const shifted = { w, h, at: (c) => 100 + Math.floor((c + over / 2) / over) };
  const s = G.phaseOfBoundaries(shifted, extent, over);
  assert.ok(s.changes > 0);
  assert.equal(s.onPhase, 0, 'not one boundary on the native phase');
  assert.equal(s.aligned, false, 'which is the failure the live probe has to catch');

  /* and a read resampled to a different resolution: runs are no longer whole native pixels */
  const resampled = { w, h, at: (c) => 100 + Math.floor(c / 7) };
  assert.equal(G.phaseOfBoundaries(resampled, extent, over).cleanRuns, false);
  assert.equal(G.phaseOfBoundaries(resampled, extent, over).aligned, false);

  /* flat ground proves nothing either way, and must not read as success */
  assert.equal(G.phaseOfBoundaries({ w, h, at: () => 42 }, extent, over).aligned, false,
    'no boundaries means no evidence, not a pass');
});

test('service: the three layers and what they are, so a fetch cannot ask for the wrong thing', () => {
  assert.deepEqual(G.LAYERS.map(l => l.key), ['evt', 'evc', 'evh']);
  assert.deepEqual(G.LAYERS.map(l => l.id),
    ['LF2024_EVT_CONUS', 'LF2024_EVC_CONUS', 'LF2024_EVH_CONUS']);
  assert.equal(G.layerUrl('LF2024_EVT_CONUS'),
    'https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2024/LF2024_EVT_CONUS/ImageServer');
  assert.equal(G.PIXEL_TYPE, 'S16');
  /* the same LF2024 release the current cells.json bake sampled, so a later emission compares like
     with like rather than straddling two LANDFIRE years */
  assert.ok(G.LAYERS.every(l => l.id.startsWith('LF2024_')));
});
