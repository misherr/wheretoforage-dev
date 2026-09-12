/* The habitat fetch, end to end against a fake service.
   Run: node --test scripts/fetch-habitat.test.mjs   (npm run test:data globs it)
 *
 * Two things this has to prove, and the first is a promise made to the user rather than a nicety:
 *
 *   1. **The fetch stage emits nothing.** It must not write data/cells.json, and it must not write
 *      anywhere outside its own checkpoint directory. The sequencing decision is that no score moves
 *      until after the October band reading, and a fetch that quietly rewrote a baked file would
 *      break that silently. Asserted by hashing cells.json before and after, and by listing every
 *      file the run touched.
 *   2. **The pixels end up where they claim to be.** The fake service computes each pixel from its
 *      absolute projected coordinate, and the fake point-lookup answers the same function for a
 *      queried coordinate. They agree only if the window bookkeeping, the tile indexing, the TIFF
 *      decode and the gzip round trip are all right — so an off-by-one in any of them fails here
 *      rather than in a report six weeks from now. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as G from './habitat-grid.mjs';
import * as F from './fetch-habitat.mjs';

/* ===================== a fake service ===================== */

/* The value of a pixel, from where it is on the ground. Both halves of the fake use this, which is
   what makes the cross-check meaningful. */
const groundValue = (x, y) => {
  const col = Math.floor((x - G.ORIGIN_X) / G.PIXEL), row = Math.floor((G.ORIGIN_Y - y) / G.PIXEL);
  return ((col * 31 + row * 17) % 880) + 11;
};

/* A tiled, uncompressed, 16-bit TIFF in the layout the real service returns. */
function tiff(w, h, valueAt, tw = 128, tl = 128) {
  const across = Math.ceil(w / tw), down = Math.ceil(h / tl), n = across * down, tb = tw * tl * 2;
  const tags = [[256, 3, w], [257, 3, h], [258, 3, 16], [259, 3, 1], [277, 3, 1],
                [322, 3, tw], [323, 3, tl], [339, 3, 2]];
  const entries = tags.length + 2, ifd = 8, ifdBytes = 2 + entries * 12 + 4;
  const offsAt = ifd + ifdBytes, cntAt = offsAt + n * 4, pixAt = cntAt + n * 4;
  const buf = Buffer.alloc(pixAt + n * tb);
  buf.write('II', 0, 'ascii'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifd, 4);
  buf.writeUInt16LE(entries, ifd);
  [...tags.map(([t, ty, v]) => [t, ty, 1, v]),
   [324, 4, n, n === 1 ? pixAt : offsAt], [325, 4, n, n === 1 ? tb : cntAt]]
    .sort((a, b) => a[0] - b[0])
    .forEach(([tag, ty, count, value], i) => {
      const e = ifd + 2 + i * 12;
      buf.writeUInt16LE(tag, e); buf.writeUInt16LE(ty, e + 2);
      buf.writeUInt32LE(count, e + 4); buf.writeUInt32LE(value, e + 8);
    });
  for (let k = 0; k < n; k++) { buf.writeUInt32LE(pixAt + k * tb, offsAt + k * 4); buf.writeUInt32LE(tb, cntAt + k * 4); }
  for (let k = 0; k < n; k++) {
    const tx = (k % across) * tw, ty = Math.floor(k / across) * tl;
    for (let y = 0; y < tl; y++) for (let x = 0; x < tw; x++) {
      const gx = tx + x, gy = ty + y;
      buf.writeInt16LE(gx < w && gy < h ? valueAt(gx, gy) : 0, pixAt + k * tb + (y * tw + x) * 2);
    }
  }
  return buf;
}

function fakeService() {
  const pending = new Map();
  let exports_ = 0, identifies = 0, infos = 0;
  const deps = {
    async getJson(url) {
      if (/ImageServer\?f=json$/.test(url)) {
        infos++;
        return { pixelSizeX: 30, pixelSizeY: 30, pixelType: 'S16', bandCount: 1, noDataValue: -9999,
                 spatialReference: { wkid: 5070, latestWkid: 5070 },
                 extent: { xmin: G.ORIGIN_X, ymin: 221265, xmax: 2327655, ymax: G.ORIGIN_Y } };
      }
      if (url.includes('/exportImage')) {
        exports_++;
        const u = new URL(url);
        const bbox = u.searchParams.get('bbox').split(',').map(Number);
        const [w, h] = u.searchParams.get('size').split(',').map(Number);
        const href = 'https://fake/img' + exports_ + '.tif';
        const px = (bbox[2] - bbox[0]) / w, py = (bbox[3] - bbox[1]) / h;
        pending.set(href, tiff(w, h, (c, r) => groundValue(bbox[0] + (c + 0.5) * px, bbox[3] - (r + 0.5) * py)));
        return { href, width: w, height: h,
                 extent: { xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3],
                           spatialReference: { wkid: 5070 } } };
      }
      if (url.includes('/identify')) {
        identifies++;
        const g = JSON.parse(decodeURIComponent(/geometry=([^&]*)/.exec(url)[1]));
        if (g.spatialReference.wkid === 4326) {
          /* the projection check: answer with our own projection plus a constant datum-sized offset */
          const [x, y] = G.project(g.y, g.x);
          return { value: String(groundValue(x, y)), location: { x: x + 0.904, y: y - 0.902,
                   spatialReference: { wkid: 5070, latestWkid: 5070 } } };
        }
        return { value: String(groundValue(g.x, g.y)) };
      }
      throw new Error('the fake service was asked something unexpected: ' + url);
    },
    async getBytes(href) {
      if (!pending.has(href)) throw new Error('no such image: ' + href);
      return pending.get(href);
    },
  };
  return { deps, counts: () => ({ exports: exports_, identifies, infos }) };
}

/* ===================== a throwaway checkpoint, and a watched tree ===================== */

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'habitat-fetch-'));
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
/* every file under a directory, with its hash, so "nothing else changed" is checkable */
function snapshot(dir, out = new Map(), root = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.endsWith('.checkpoint')) snapshot(p, out, root); }
    else out.set(path.relative(root, p).replace(/\\/g, '/'), hash(p));
  }
  return out;
}

/* A small cells.json: four cells in one corner of the state, enough for two tiles at a tiny tile size. */
function tinyCells(file) {
  const rows = [[48.80325, -122.0555, 700, 2, 180, [1, 76, 30, 0.8, [[34, 1]], [34, 34, 34, 34], 15]],
                [48.81775, -122.0555, 720, 3, 170, [1, 76, 31, 0.8, [[34, 1]], [34, 34, 34, 34], 15]],
                [48.80325, -122.0341, 690, 2, 190, [1, 76, 29, 0.8, [[34, 1]], [34, 34, 34, 34], 15]],
                [48.83225, -122.0127, 760, 4, 160, [1, 76, 33, 0.8, [[34, 1]], [34, 34, 34, 34], 15]]];
  fs.writeFileSync(file, JSON.stringify({ version: 2, generated: '2026-09-10T00:00:00.000Z', rows }));
  return rows;
}

/* ===================== the tests ===================== */

test('plan: the window covers every cell, and only tiles holding cells are fetched', () => {
  const dir = tmpDir(), cells = path.join(dir, 'cells.json');
  const rows = tinyCells(cells);
  const p = F.plan(rows, 64);
  assert.equal(p.cells, 4);
  assert.ok(G.isAligned(p.win.bbox, p.win.w, p.win.h), 'the window is on the native grid');
  /* every cell centre is inside the window */
  for (const r of rows) {
    const [x, y] = G.project(r[0], r[1]);
    assert.ok(G.pixelAt(p.win.bbox, p.win.w, p.win.h, x, y), 'cell at ' + r[0] + ',' + r[1] + ' is inside');
  }
  assert.ok(p.tiles.length >= 1 && p.tiles.length <= p.allTiles);
  assert.ok(p.pixels <= p.windowPixels);
  for (const t of p.tiles) assert.ok(G.isAligned(t.bbox, t.w, t.h), t.key + ' is aligned');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fetch: the stored pixels are the ones the service holds at that ground', async () => {
  const dir = tmpDir(), cells = path.join(dir, 'cells.json');
  tinyCells(cells);
  const svc = fakeService();
  const out = path.join(dir, 'h.checkpoint');
  const r = await F.fetchHabitat({ out, cells, tile: 64, verify: 4, layers: ['evt', 'evc'] }, svc.deps);
  const man = r.manifest;
  /* the cross-check is the point: the fake computes pixels from absolute ground coordinates and
     answers point queries with the same function, so agreement means the indexing is right */
  for (const layer of ['evt', 'evc']) {
    assert.equal(man.verification[layer].differ, 0,
      layer + ' disagreed on ' + man.verification[layer].differ + ' of ' + man.verification[layer].sampled);
    assert.equal(man.verification[layer].rate, 100);
    assert.ok(man.verification[layer].agree > 0, 'and it actually checked something');
  }
  /* the tiles are on disk, gzipped, and decode to the size they claim */
  for (const [key, rec] of Object.entries(man.layers.evt.tiles)) {
    const f = path.join(out, 'evt', key + '.bin.gz');
    assert.ok(fs.existsSync(f), key + ' was written');
    assert.equal(fs.statSync(f).size, rec.stored);
    const img = F.decodeTile(fs.readFileSync(f), rec.w, rec.h);
    assert.equal(img.data.length, rec.w * rec.h);
    /* and the decoded pixel matches what the ground function says it should be */
    const mid = G.pixelCentre(rec.bbox, Math.floor(rec.w / 2), Math.floor(rec.h / 2));
    assert.equal(img.at(Math.floor(rec.w / 2), Math.floor(rec.h / 2)), groundValue(mid[0], mid[1]));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fetch: it writes nothing outside its own checkpoint, and never touches cells.json', async () => {
  const dir = tmpDir(), cells = path.join(dir, 'cells.json');
  tinyCells(cells);
  /* a few other files that stand in for the baked data a habitat fetch must not disturb */
  fs.writeFileSync(path.join(dir, 'access.json'), '{"version":10}');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'weather.json'), '{"grids":1}');
  const before = snapshot(dir);
  const cellsHash = hash(cells);

  const svc = fakeService();
  await F.fetchHabitat({ out: path.join(dir, 'h.checkpoint'), cells, tile: 64, verify: 2,
                         layers: ['evt'] }, svc.deps);

  assert.equal(hash(cells), cellsHash, 'cells.json is byte-identical — the sequencing decision '
    + 'depends on no score moving, and a fetch that rewrote it would break that silently');
  const after = snapshot(dir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(),
    'no file appeared or vanished outside the checkpoint directory');
  for (const [f, h] of before) assert.equal(after.get(f), h, f + ' is unchanged');
  /* and the checkpoint itself did get written */
  assert.ok(fs.existsSync(path.join(dir, 'h.checkpoint', 'manifest.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fetch: a second run resumes instead of re-fetching, and refuses to mix two grids', async () => {
  const dir = tmpDir(), cells = path.join(dir, 'cells.json');
  tinyCells(cells);
  const out = path.join(dir, 'h.checkpoint');
  const first = fakeService();
  const a = await F.fetchHabitat({ out, cells, tile: 64, verify: 0, layers: ['evt'] }, first.deps);
  const exportsFirst = first.counts().exports;
  assert.ok(exportsFirst > 0);

  /* without --resume it refuses, because the checkpoint is kept on purpose */
  const second = fakeService();
  await assert.rejects(
    () => F.fetchHabitat({ out, cells, tile: 64, verify: 0, layers: ['evt'] }, second.deps),
    /already holds a checkpoint/);

  /* with --resume it re-fetches nothing: every tile is already recorded and on disk */
  const third = fakeService();
  await F.fetchHabitat({ out, cells, tile: 64, verify: 0, layers: ['evt'], resume: true }, third.deps);
  const tileExports = Object.keys(a.manifest.layers.evt.tiles).length;
  assert.ok(third.counts().exports < tileExports,
    'a resume asked for ' + third.counts().exports + ' exports against ' + tileExports + ' tiles');

  /* a different tile size is a different grid, and resuming into it would interleave two rasters */
  const fourth = fakeService();
  await assert.rejects(
    () => F.fetchHabitat({ out, cells, tile: 32, verify: 0, layers: ['evt'], resume: true }, fourth.deps),
    /different window or tile size/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preflight: it refuses to fetch when the grid is not where the code thinks it is', async () => {
  const svc = fakeService();
  /* a service that has moved to a different phase: every stored pixel would be half a pixel out */
  const moved = { ...svc.deps, async getJson(url) {
    const j = await svc.deps.getJson(url);
    if (/ImageServer\?f=json$/.test(url)) return { ...j, extent: { ...j.extent, xmin: j.extent.xmin + 15 } };
    return j;
  } };
  await assert.rejects(() => F.preflight(['evt'], moved), /extent corner phase/);

  /* a service that has changed resolution */
  const coarser = { ...svc.deps, async getJson(url) {
    const j = await svc.deps.getJson(url);
    if (/ImageServer\?f=json$/.test(url)) return { ...j, pixelSizeX: 10, pixelSizeY: 10 };
    return j;
  } };
  await assert.rejects(() => F.preflight(['evt'], coarser), /pixel size is 10x10/);

  /* and one whose rasters are no longer aligned to the phase it declares: the probe catches it even
     though the declaration looks right, which is the whole reason the probe exists */
  const shifted = { ...svc.deps, async getJson(url) {
    const j = await svc.deps.getJson(url);
    if (url.includes('/exportImage')) {
      const u = new URL(url);
      const bbox = u.searchParams.get('bbox').split(',').map(Number);
      /* answer for ground half a native pixel away, while claiming the asked-for extent */
      const [w, h] = u.searchParams.get('size').split(',').map(Number);
      const px = (bbox[2] - bbox[0]) / w;
      const href = 'https://fake/shifted.tif';
      shiftedImg = tiff(w, h, c => 100 + Math.floor((c + 5) / 10));
      return { href, width: w, height: h,
               extent: { xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3] } };
    }
    return j;
  }, async getBytes() { return shiftedImg; } };
  let shiftedImg = null;
  await assert.rejects(() => F.preflight(['evt'], shifted), /not where this code thinks it is/);
});

test('preflight: a varying projection disagreement is a projection error, not a datum offset', async () => {
  const svc = fakeService();
  const wobbly = { ...svc.deps, async getJson(url) {
    const j = await svc.deps.getJson(url);
    if (url.includes('/identify') && j.location)
      return { ...j, location: { ...j.location, x: j.location.x + Math.random() * 50 } };
    return j;
  } };
  await assert.rejects(() => F.preflight(['evt'], wobbly), /VARYING amount/);
});

test('args: the options this is driven by, including the ones that protect the checkpoint', () => {
  const d = F.parseArgs([]);
  assert.equal(d.out, 'data/habitat-30m.checkpoint');
  assert.equal(d.cells, 'data/cells.json');
  assert.equal(d.tile, 1024, 'measured, not picked — see the table in the script');
  assert.equal(d.resume, false); assert.equal(d.fresh, false);
  assert.deepEqual(d.layers, ['evt', 'evc', 'evh']);
  assert.equal(F.parseArgs(['--resume']).resume, true);
  assert.equal(F.parseArgs(['--tile=512']).tile, 512);
  assert.equal(F.parseArgs(['--verify=50']).verify, 50);
  assert.deepEqual(F.parseArgs(['--layers=evc']).layers, ['evc']);
  assert.throws(() => F.parseArgs(['--layers=ndvi']), /unknown layer ndvi/);
  assert.throws(() => F.parseArgs(['--tile=4']), /--tile out of range/);
  assert.throws(() => F.parseArgs(['--bbox=1,2,3']), /--bbox needs/);
  assert.throws(() => F.parseArgs(['--emit']), /unknown option/);
  /* there is deliberately no option that emits anything: this stage has no output but the checkpoint */
  const src = fs.readFileSync(new URL('./fetch-habitat.mjs', import.meta.url), 'utf8');
  assert.ok(!/--emit|emitCells|writeCells/.test(src), 'no emission path exists yet, by instruction');
});
