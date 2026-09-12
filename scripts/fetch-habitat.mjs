/* Pull LANDFIRE's 30 m EVT, EVC and EVH over Washington into a checkpoint. FETCH ONLY.
 *
 *   node scripts/fetch-habitat.mjs --probe-only      # the preflight, no download
 *   node scripts/fetch-habitat.mjs --dry-run         # what it would fetch, and how much
 *   node scripts/fetch-habitat.mjs                   # fetch (refuses to clobber a checkpoint)
 *   node scripts/fetch-habitat.mjs --resume          # carry on where it stopped
 *   node scripts/fetch-habitat.mjs --verify=400      # re-run the cross-check on what is stored
 *
 * **This script emits nothing.** It does not write data/cells.json, it does not compute a habitat
 * figure, and it takes no view on the per-cell-summary versus per-pixel-tiles question. That decision
 * waits on the October band reading and on the sub-mile refine question — ROADMAP.md, "the 30 m
 * habitat rebuild". The whole point of the split is that this expensive step serves either answer.
 *
 * Log it to a file you can read while it runs:
 *
 *   node scripts/fetch-habitat.mjs > habitat.log 2>&1
 *
 * The checkpoint is kept on success and re-reading it is free, which is the same bargain
 * build-access.mjs makes and for the same reason: everything after the fetch is assembly. Do not
 * "tidy up" by deleting it.
 *
 * ===================== the preflight, and why it aborts ===================== *
 *
 * Three things are checked before a byte of raster is downloaded, because each of them silently
 * invalidates the whole run and none of them is visible in the result:
 *
 *   1. the service still reports 30 m, S16, and an extent corner at phase 15;
 *   2. an oversampled strip really does show native pixel boundaries on that phase — the only test
 *      that distinguishes native pixels from a resampling, see habitat-grid.mjs;
 *   3. project() still agrees with the service's own conversion, up to the constant datum offset.
 *
 * Any of them failing stops the run. A gigabyte fetched on a moved grid is worse than no fetch, since
 * it looks exactly like a good one. */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cellCenter, cellIndex } from '../src/grid.mjs';
import * as G from './habitat-grid.mjs';

export const FETCHER_VERSION = '1.0.0';
const OUT = 'data/habitat-30m.checkpoint';
const CELLS = 'data/cells.json';
/* 1,024 pixels is 31 km a side. Measured over the real cell lattice, because the trade is between
   request count and wasted download — a bounding box over Washington is mostly not Washington, and
   only tiles holding cells are fetched, so smaller tiles waste less and cost more requests:

     tile   km   tiles held / in window   pixels/layer   3 layers   requests
     4096  123          20 / 20                286 M      1.72 GB         60
     2048   61          59 / 80                237 M      1.42 GB        177
     1024   31         197 / 300               204 M      1.22 GB        591
      512   15         683 / 1131              178 M      1.07 GB       2049
      256    8        2512 / 4446              165 M      0.99 GB       7536

   591 requests is the same order as the 579 the current cells.json bake already makes of this service,
   which is a rate this host is known to tolerate, and it takes 29% off the volume. Going to 512 more
   than triples the requests for another 12%. A 1,024-square tile is also 2 MB decoded rather than
   33 MB, so a retry is cheap and a resume is fine-grained. */
const TILE_PX = 1024;
const OVERSAMPLE = 10;                 // for the alignment probe: 3 m samples across a 30 m pixel
const RETRIES = 4;
const PAUSE_MS = 250;                  // between tiles: the service answered 400 twice in a 3-tile
                                       // probe and succeeded on retry with identical parameters, so it
                                       // is server-side flakiness rather than a bad request. Across
                                       // 591 tiles a quarter-second pause costs 2.5 minutes.
const TIMEOUT_MS = 240000;             // the server has to cut the tile before it sends anything

/* Requests go through node:https, not fetch().
 *
 * A run died at tile 375 of 591, and a second during the preflight, inside Node's own HTTP client:
 * `AssertionError: assert(!this.paused)` at `Parser.finish`, from undici tearing down a keep-alive
 * socket the server had closed mid-response. It is thrown from an internal event handler, so no
 * try/catch around fetch() can see it and the process simply dies. Passing `connection: close` does
 * nothing — fetch forbids that header — and `setGlobalDispatcher` needs the undici package, which
 * this repo has no dependencies to spend.
 *
 * node:https takes an agent, so keep-alive can actually be turned off. A handshake per request costs
 * about a minute across the state, against losing the process. */
const AGENT = new https.Agent({ keepAlive: false, maxSockets: 1 });

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: AGENT, timeout: timeoutMs }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, url).href, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's')));
    req.on('error', reject);
  });
}

const log = (...a) => console.log(...a);
const mb = b => (b / 1e6).toFixed(2) + ' MB';
const gb = b => (b / 1e9).toFixed(2) + ' GB';
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1) + '%';

export function parseArgs(argv) {
  const o = { out: OUT, cells: CELLS, tile: TILE_PX, resume: false, fresh: false, dryRun: false,
              probeOnly: false, verify: 300, layers: G.LAYERS.map(l => l.key), bbox: null };
  for (const a of argv) {
    if (a === '--resume') o.resume = true;
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--probe-only') o.probeOnly = true;
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--cells=')) o.cells = a.slice(8);
    else if (a.startsWith('--tile=')) o.tile = Number(a.slice(7));
    else if (a.startsWith('--verify=')) o.verify = Number(a.slice(9));
    else if (a.startsWith('--layers=')) o.layers = a.slice(9).split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--bbox=')) {
      const v = a.slice(7).split(',').map(Number);
      if (v.length !== 4 || v.some(Number.isNaN)) throw new Error('--bbox needs lat0,lon0,lat1,lon1');
      o.bbox = { lat0: Math.min(v[0], v[2]), lat1: Math.max(v[0], v[2]),
                 lon0: Math.min(v[1], v[3]), lon1: Math.max(v[1], v[3]) };
    } else if (a.startsWith('--')) throw new Error('unknown option ' + a);
  }
  if (!Number.isInteger(o.tile) || o.tile < 16 || o.tile > 20000) throw new Error('--tile out of range');
  for (const k of o.layers) if (!G.LAYERS.some(l => l.key === k)) throw new Error('unknown layer ' + k);
  return o;
}

/* ===================== the network ===================== */

async function getJson(url, tries = RETRIES) {
  for (let i = 0; ; i++) {
    try {
      const j = JSON.parse((await httpGet(url, TIMEOUT_MS)).toString('utf8'));
      if (j.error) throw new Error('service error: ' + JSON.stringify(j.error).slice(0, 200));
      return j;
    } catch (e) {
      if (i >= tries) throw e;
      const wait = 2000 * Math.pow(2, i);
      log('  retry ' + (i + 1) + '/' + tries + ' in ' + (wait / 1000) + 's — ' + e.message);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
async function getBytes(url, tries = RETRIES) {
  for (let i = 0; ; i++) {
    try {
      return await httpGet(url, TIMEOUT_MS);
    } catch (e) {
      if (i >= tries) throw e;
      const wait = 2000 * Math.pow(2, i);
      log('  retry ' + (i + 1) + '/' + tries + ' in ' + (wait / 1000) + 's — ' + e.message);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

/* One aligned read. `bbox` must have come from habitat-grid, and is checked again here — the request
   is the only place a phase mistake can be caught. */
async function exportWindow(layerId, bbox, w, h, deps = {}) {
  if (!G.isAligned(bbox, w, h))
    throw new Error('refusing an unaligned request: ' + JSON.stringify(bbox) + ' at ' + w + 'x' + h);
  const url = G.layerUrl(layerId) + '/exportImage?bbox=' + bbox.join(',')
    + '&bboxSR=5070&imageSR=5070&size=' + w + ',' + h
    + '&format=tiff&pixelType=' + G.PIXEL_TYPE + '&interpolation=RSP_NearestNeighbor&f=json';
  const j = await (deps.getJson || getJson)(url);
  if (!j.href) throw new Error('no href in the export answer: ' + JSON.stringify(j).slice(0, 200));
  /* the service is allowed to disagree about the extent; if it does, the pixels are not the ones asked
     for and nothing downstream would know */
  const e = j.extent;
  const off = [e.xmin - bbox[0], e.ymin - bbox[1], e.xmax - bbox[2], e.ymax - bbox[3]];
  if (off.some(v => Math.abs(v) > 1e-6))
    throw new Error('the service returned a different extent: off by ' + off.join(', ') + ' m');
  if (j.width !== w || j.height !== h)
    throw new Error('asked for ' + w + 'x' + h + ', service says ' + j.width + 'x' + j.height);
  const buf = await (deps.getBytes || getBytes)(j.href);
  const img = G.readTiff(buf, { w, h });
  return { img, downloaded: buf.length };
}

/* A point's value straight from the service, asked in 5070 so no datum transformation happens on
   either side. Asking in 4326 would fold the ~1.3 m NAD83/WGS84 offset into the comparison and show
   up as a 12% disagreement rate that looks like a bug. */
async function identifyAt(layerId, x, y, deps = {}) {
  const g = encodeURIComponent(JSON.stringify({ x, y, spatialReference: { wkid: 5070 } }));
  const j = await (deps.getJson || getJson)(G.layerUrl(layerId) + '/identify?geometry=' + g
    + '&geometryType=esriGeometryPoint&returnGeometry=false&f=json');
  return j.value === 'NoData' ? G.NODATA : Number(j.value);
}

/* ===================== preflight ===================== */

export async function preflight(layers, deps = {}) {
  const out = { service: {}, alignment: null, projection: null, ok: false };
  for (const key of layers) {
    const L = G.LAYERS.find(l => l.key === key);
    const d = await (deps.getJson || getJson)(G.layerUrl(L.id) + '?f=json');
    const e = d.extent || {};
    const rec = { pixel: [d.pixelSizeX, d.pixelSizeY], type: d.pixelType, bands: d.bandCount,
                  nodata: d.noDataValue, wkid: d.spatialReference && d.spatialReference.latestWkid,
                  extent: [e.xmin, e.ymin, e.xmax, e.ymax],
                  phase: [G.phaseOf(e.xmin), G.phaseOf(e.ymax)] };
    out.service[key] = rec;
    const say = m => { throw new Error(L.id + ': ' + m + ' — the grid this code is built on has moved, '
      + 'so re-measure with the probe before fetching anything'); };
    if (rec.pixel[0] !== G.PIXEL || rec.pixel[1] !== G.PIXEL) say('pixel size is ' + rec.pixel.join('x'));
    if (rec.type !== G.PIXEL_TYPE) say('pixel type is ' + rec.type);
    if (rec.bands !== 1) say('band count is ' + rec.bands);
    if (rec.nodata !== G.NODATA) say('NoData is ' + rec.nodata + ', not ' + G.NODATA);
    if (rec.wkid !== 5070) say('spatial reference is ' + rec.wkid);
    if (rec.phase[0] !== G.PHASE || rec.phase[1] !== G.PHASE)
      say('extent corner phase is ' + rec.phase.join(',') + ', not ' + G.PHASE);
    log('  ' + key + ': ' + rec.pixel.join('x') + ' m, ' + rec.type + ', wkid ' + rec.wkid
      + ', NoData ' + rec.nodata + ', extent phase ' + rec.phase.join(','));
  }

  /* the test that actually distinguishes native pixels from a resampling of them */
  const probeKey = layers.includes('evc') ? 'evc' : layers[0];
  const probeId = G.LAYERS.find(l => l.key === probeKey).id;
  const spans = [['Bellingham edge', -1930005, 3130005], ['Cascade foothills', -1900005, 3090005]];
  const results = [];
  for (const [where, x, y] of spans) {
    const nat = 60, w = nat * OVERSAMPLE, h = 6;
    const bbox = [x, y, x + nat * G.PIXEL, y + Math.ceil(h * G.PIXEL / OVERSAMPLE / G.PIXEL) * G.PIXEL];
    /* oversampling asks for more pixels than the window has native ones, which is deliberate and is
       the one place an unaligned-looking request is correct — so it goes straight to the service */
    const url = G.layerUrl(probeId) + '/exportImage?bbox=' + [x, y, x + nat * G.PIXEL, y + h * (G.PIXEL / OVERSAMPLE)].join(',')
      + '&bboxSR=5070&imageSR=5070&size=' + w + ',' + h
      + '&format=tiff&pixelType=' + G.PIXEL_TYPE + '&interpolation=RSP_NearestNeighbor&f=json';
    const j = await (deps.getJson || getJson)(url);
    const buf = await (deps.getBytes || getBytes)(j.href);
    const img = G.readTiff(buf, { w: j.width, h: j.height });
    const e = j.extent;
    const r = G.phaseOfBoundaries(img, [e.xmin, e.ymin, e.xmax, e.ymax], OVERSAMPLE);
    results.push({ where, changes: r.changes, onPhase: r.onPhase, cleanRuns: r.cleanRuns,
                   pixelSize: +r.pixelSize.toFixed(3), aligned: r.aligned });
    log('  probe at ' + where + ': ' + r.changes + ' boundaries, ' + r.onPhase + ' on phase '
      + G.PHASE + ', runs whole: ' + r.cleanRuns + ', samples ' + r.pixelSize.toFixed(2) + ' m'
      + (r.aligned ? '  ✓' : '  ** NOT ALIGNED **'));
  }
  out.alignment = results;
  if (!results.every(r => r.aligned))
    throw new Error('the native grid is not where this code thinks it is — every value boundary should '
      + 'sit at phase ' + G.PHASE + ' mod ' + G.PIXEL + '. Re-measure before fetching.');

  /* and the projection, against the service's own conversion */
  const PTS = [[48.8003140, -122.0556248], [47.5, -120.5], [45.6, -124.0], [49.0, -117.1], [46.2, -119.0]];
  const dx = [], dy = [];
  for (const [lat, lon] of PTS) {
    const g = encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
    const j = await (deps.getJson || getJson)(G.layerUrl(probeId) + '/identify?geometry=' + g
      + '&geometryType=esriGeometryPoint&returnGeometry=true&f=json');
    if (!j.location) throw new Error('identify returned no location, so the projection cannot be checked');
    const [x, y] = G.project(lat, lon);
    dx.push(j.location.x - x); dy.push(j.location.y - y);
  }
  const spread = a => Math.max(...a) - Math.min(...a);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  out.projection = { points: PTS.length, mean_dx: +mean(dx).toFixed(3), mean_dy: +mean(dy).toFixed(3),
                     spread_dx: +spread(dx).toFixed(3), spread_dy: +spread(dy).toFixed(3),
                     datum_offset_m: +Math.hypot(mean(dx), mean(dy)).toFixed(3) };
  log('  projection: constant to ' + Math.max(spread(dx), spread(dy)).toFixed(3) + ' m over '
    + PTS.length + ' points, offset ' + out.projection.datum_offset_m + ' m (NAD83 against WGS84)');
  if (spread(dx) > 0.5 || spread(dy) > 0.5)
    throw new Error('project() disagrees with the service by a VARYING amount (' + spread(dx).toFixed(2)
      + ', ' + spread(dy).toFixed(2) + ' m), which is a projection error rather than a datum offset');
  out.ok = true;
  return out;
}

/* ===================== what to fetch ===================== */

/* The window the cells occupy, and which tiles hold any of them. A bounding box over Washington is
   mostly not Washington: dropping the empty tiles is most of the saving, and the cells are the only
   thing a later emission step could summarise anyway. */
export function plan(cellRows, tilePx) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const pts = [];
  for (const r of cellRows) {
    const [i, j] = cellIndex(r[0], r[1]);
    const [lat, lon] = cellCenter(i, j);
    /* a cell is DLAT x DLON of ground, so its corners matter, not just its centre */
    for (const [dy, dx] of [[-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5], [0.5, 0.5]]) {
      const [x, y] = G.project(lat + dy * 0.0145, lon + dx * 0.0214);
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
    pts.push(G.project(lat, lon));
  }
  const win = G.alignedWindow(xmin, ymin, xmax, ymax);
  /* mark the tiles that contain at least one cell centre */
  const need = new Set();
  for (const [x, y] of pts) {
    const p = G.pixelAt(win.bbox, win.w, win.h, x, y);
    if (!p) continue;
    need.add(Math.floor(p.row / tilePx) + '_' + Math.floor(p.col / tilePx));
  }
  const all = G.tiles(win, tilePx);
  const keep = all.filter(t => need.has(t.key));
  return { win, tiles: keep, allTiles: all.length, cells: pts.length,
           pixels: keep.reduce((s, t) => s + t.pixels, 0),
           windowPixels: win.w * win.h };
}

/* ===================== the checkpoint ===================== */

const manifestPath = out => path.join(out, 'manifest.json');
const tilePath = (out, layer, key) => path.join(out, layer, key + '.bin.gz');

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/* The pixels as they are stored: row-major Int16LE, gzipped. Decoded rather than the original TIFF,
   so an emission step needs no TIFF reader and so a short download is caught here instead of there. */
export function encodeTile(img) {
  const raw = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return { raw, gz: zlib.gzipSync(raw, { level: 6 }) };
}
export function decodeTile(gz, w, h) {
  const raw = zlib.gunzipSync(gz);
  if (raw.length !== w * h * 2) throw new Error('tile is ' + raw.length + ' bytes, expected ' + w * h * 2);
  const data = new Int16Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = raw.readInt16LE(i * 2);
  return { w, h, data, at: (c, r) => data[r * w + c] };
}

/* ===================== the run ===================== */

export async function fetchHabitat(opts = {}, deps = {}) {
  const o = { ...parseArgs([]), ...opts };
  const t0 = Date.now();
  log('fetch-habitat ' + FETCHER_VERSION + ' — LANDFIRE ' + G.LAYERS.map(l => l.key).join('/')
    + ' at ' + G.PIXEL + ' m, EPSG:5070, native phase ' + G.PHASE);
  log('  FETCH ONLY: nothing here emits a habitat figure or touches ' + CELLS);

  log('preflight   the grid, the alignment and the projection');
  const pre = await preflight(o.layers, deps);
  if (o.probeOnly) { log('probe only — stopping here'); return { preflight: pre }; }

  const cellsFile = JSON.parse(fs.readFileSync(o.cells, 'utf8'));
  let rows = cellsFile.rows;
  if (o.bbox) rows = rows.filter(r => r[0] >= o.bbox.lat0 && r[0] <= o.bbox.lat1
                                   && r[1] >= o.bbox.lon0 && r[1] <= o.bbox.lon1);
  const p = plan(rows, o.tile);
  log('plan        ' + p.cells.toLocaleString() + ' cells over a window of ' + p.win.w + ' x ' + p.win.h
    + ' pixels (' + (p.windowPixels / 1e6).toFixed(1) + ' M)');
  log('            ' + p.tiles.length + ' tiles of ' + o.tile + '² hold cells, of ' + p.allTiles
    + ' in the window — ' + (p.pixels / 1e6).toFixed(1) + ' M pixels, '
    + pct(p.pixels, p.windowPixels) + ' of it');
  log('            per layer ' + gb(p.pixels * 2) + ' decoded, ' + o.layers.length + ' layers: '
    + gb(p.pixels * 2 * o.layers.length) + ' before compression');
  if (o.dryRun) { log('dry run — not fetching'); return { plan: p, preflight: pre }; }

  /* the manifest, and what a resume already has */
  const mp = manifestPath(o.out);
  let man = null;
  if (fs.existsSync(mp)) {
    man = JSON.parse(fs.readFileSync(mp, 'utf8'));
    if (!o.resume && !o.fresh)
      throw new Error(o.out + ' already holds a checkpoint. Pass --resume to carry on with it, or '
        + '--fresh to start over. It is kept on purpose: re-reading it is free.');
    if (o.fresh) man = null;
    else if (man.grid && (man.grid.w !== p.win.w || man.grid.h !== p.win.h
                          || man.grid.bbox.join() !== p.win.bbox.join() || man.grid.tile !== o.tile))
      throw new Error('the checkpoint was fetched over a different window or tile size — resume would '
        + 'mix two grids. Use --fresh, or a matching --tile/--bbox.');
  }
  if (!man) {
    man = { fetcher: 'scripts/fetch-habitat.mjs', fetcher_version: FETCHER_VERSION,
            started: new Date().toISOString(), finished: null,
            what: 'LANDFIRE 30 m rasters, fetch stage only — no emission, see ROADMAP.md',
            release: 'LF2024', service: G.SERVICE,
            grid: { pixel: G.PIXEL, phase: G.PHASE, origin: [G.ORIGIN_X, G.ORIGIN_Y], wkid: 5070,
                    bbox: p.win.bbox, w: p.win.w, h: p.win.h, tile: o.tile, nodata: G.NODATA,
                    storage: 'row-major Int16LE, gzip level 6, one file per layer per tile' },
            cells: { file: o.cells, generated: cellsFile.generated, count: p.cells,
                     lattice: 'src/grid.mjs DLAT/DLON — cells are NOT re-derived here' },
            preflight: pre, layers: {}, verification: null,
            totals: { tiles_planned: p.tiles.length * o.layers.length, pixels_per_layer: p.pixels } };
  }
  man.preflight = pre;
  for (const k of o.layers) if (!man.layers[k]) man.layers[k] = { id: G.LAYERS.find(l => l.key === k).id, tiles: {} };
  const save = () => writeAtomic(mp, Buffer.from(JSON.stringify(man, null, 1)));
  save();

  let done = 0, fetched = 0, skipped = 0, downloaded = 0, stored = 0, nodata = 0;
  const total = p.tiles.length * o.layers.length;
  for (const key of o.layers) {
    const L = G.LAYERS.find(l => l.key === key);
    for (const t of p.tiles) {
      done++;
      const rec = man.layers[key].tiles[t.key];
      const file = tilePath(o.out, key, t.key);
      if (rec && rec.stored && fs.existsSync(file) && fs.statSync(file).size === rec.stored) {
        skipped++; stored += rec.stored; nodata += rec.nodata || 0;
        continue;
      }
      const ts = Date.now();
      const { img, downloaded: got } = await exportWindow(L.id, t.bbox, t.w, t.h, deps);
      const { raw, gz } = encodeTile(img);
      writeAtomic(file, gz);
      let nd = 0, min = Infinity, max = -Infinity;
      for (let i = 0; i < img.data.length; i++) {
        const v = img.data[i];
        if (v === G.NODATA) nd++; else { if (v < min) min = v; if (v > max) max = v; }
      }
      man.layers[key].tiles[t.key] = { bbox: t.bbox, w: t.w, h: t.h, raw: raw.length, stored: gz.length,
        sha: sha(raw), nodata: nd, min: min === Infinity ? null : min, max: max === -Infinity ? null : max,
        downloaded: got, seconds: +((Date.now() - ts) / 1000).toFixed(1) };
      fetched++; downloaded += got; stored += gz.length; nodata += nd;
      await new Promise(r => setTimeout(r, PAUSE_MS));
      save();
      const per = (Date.now() - t0) / 1000 / Math.max(1, fetched);
      log('  ' + key + ' ' + t.key + '  ' + t.w + 'x' + t.h + '  ' + mb(got) + ' → ' + mb(gz.length)
        + ' stored (' + pct(gz.length, raw.length) + ')  NoData ' + pct(nd, t.pixels)
        + '  ' + ((Date.now() - ts) / 1000).toFixed(1) + 's'
        + '   [' + done + '/' + total + ', ~' + Math.round(per * (total - done) / 60) + ' min left]');
    }
  }
  log('fetched     ' + fetched + ' tiles (' + skipped + ' already had), ' + gb(downloaded)
    + ' downloaded, ' + gb(stored) + ' on disk, NoData ' + pct(nodata, p.pixels * o.layers.length));

  if (o.verify > 0) {
    man.verification = await verifyStored(o, man, rows, deps);
    save();
  }
  man.finished = new Date().toISOString();
  /* Summed over the tile RECORDS, not over this process's counters: a resumed run would otherwise
     report only what it happened to fetch itself, and the first statewide run died at tile 375 of 591
     — the totals would have described the tail of the job rather than the checkpoint. */
  man.totals = { ...man.totals, ...totalsOf(man), runs: (man.totals.runs || 0) + 1,
                 seconds_last_run: Math.round((Date.now() - t0) / 1000),
                 seconds: (man.totals.seconds || 0) + Math.round((Date.now() - t0) / 1000) };
  save();
  log('done in ' + Math.round((Date.now() - t0) / 1000) + 's — checkpoint at ' + o.out
    + ', kept on purpose. Nothing was emitted.');
  return { manifest: man, plan: p };
}

/* Everything in the checkpoint, from the tile records. The one true summary of what is on disk. */
export function totalsOf(man) {
  let tiles = 0, raw = 0, stored = 0, downloaded = 0, nodata = 0, pixels = 0, fetchSeconds = 0;
  for (const L of Object.values(man.layers || {})) {
    for (const r of Object.values(L.tiles || {})) {
      tiles++; raw += r.raw || 0; stored += r.stored || 0; downloaded += r.downloaded || 0;
      nodata += r.nodata || 0; pixels += (r.w || 0) * (r.h || 0); fetchSeconds += r.seconds || 0;
    }
  }
  return { tiles_stored: tiles, raw_bytes: raw, stored_bytes: stored, downloaded_bytes: downloaded,
           nodata_pixels: nodata, pixels_stored: pixels,
           compression: raw ? +(stored / raw).toFixed(4) : null,
           tile_fetch_seconds: Math.round(fetchSeconds) };
}

/* ===================== the cross-check ===================== */

/* Read a sample of cell centres out of the stored tiles and ask the point service the same question.
   This is the check that the stored pixels are the ones they claim to be: it exercises the projection,
   the window bookkeeping, the tile indexing, the TIFF decode and the gzip round trip in one go.
   Asked in 5070 with an already-projected coordinate — see identifyAt. */
export async function verifyStored(o, man, rows, deps = {}) {
  const n = Math.min(o.verify, rows.length);
  const step = Math.max(1, Math.floor(rows.length / n));
  const picks = [];
  for (let i = 0; i < rows.length && picks.length < n; i += step) picks.push(rows[i]);
  log('verify      ' + picks.length + ' cell centres against the point service, in EPSG:5070');

  const cache = new Map();
  const tileFor = (layer, row, col) => {
    const key = Math.floor(row / man.grid.tile) + '_' + Math.floor(col / man.grid.tile);
    const ck = layer + '/' + key;
    if (!cache.has(ck)) {
      const rec = man.layers[layer] && man.layers[layer].tiles[key];
      if (!rec) return null;
      const gz = fs.readFileSync(tilePath(o.out, layer, key));
      cache.set(ck, { rec, img: decodeTile(gz, rec.w, rec.h), key });
      if (cache.size > 6) { const first = cache.keys().next().value; if (first !== ck) cache.delete(first); }
    }
    return cache.get(ck);
  };

  const out = {};
  for (const layer of o.layers) {
    const L = G.LAYERS.find(l => l.key === layer);
    let agree = 0, differ = 0, missing = 0, nodataBoth = 0;
    const bad = [];
    for (const r of picks) {
      const [i, j] = cellIndex(r[0], r[1]);
      const [lat, lon] = cellCenter(i, j);
      const [x, y] = G.project(lat, lon);
      const p = G.pixelAt(man.grid.bbox, man.grid.w, man.grid.h, x, y);
      if (!p) { missing++; continue; }
      const t = tileFor(layer, p.row, p.col);
      if (!t) { missing++; continue; }
      const col = p.col - Number(t.key.split('_')[1]) * man.grid.tile;
      const row = p.row - Number(t.key.split('_')[0]) * man.grid.tile;
      const mine = t.img.at(col, row);
      const theirs = await identifyAt(L.id, x, y, deps);
      if (mine === theirs) { agree++; if (mine === G.NODATA) nodataBoth++; }
      else { differ++; if (bad.length < 8) bad.push({ lat, lon, x: +x.toFixed(1), y: +y.toFixed(1), mine, theirs }); }
    }
    out[layer] = { sampled: picks.length, agree, differ, missing, nodata_both: nodataBoth,
                   rate: +(100 * agree / Math.max(1, agree + differ)).toFixed(2), examples: bad };
    log('  ' + layer + ': ' + agree + '/' + (agree + differ) + ' agree (' + out[layer].rate + '%)'
      + (missing ? ', ' + missing + ' outside the fetched window' : '')
      + (differ ? '  ** ' + differ + ' DISAGREE **' : '  ✓'));
    if (bad.length) for (const b of bad.slice(0, 4))
      log('      ' + b.lat.toFixed(4) + ',' + b.lon.toFixed(4) + ' stored ' + b.mine + ' service ' + b.theirs);
  }
  return out;
}

/* ===================== cli ===================== */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  /* The manifest is written after every tile, so an abrupt death costs at most one tile. Say so
     rather than leaving an internal stack trace as the last word — the answer is always --resume. */
  process.on('uncaughtException', e => {
    console.error('\nCRASHED: ' + e.message);
    if (/this\.paused|ECONNRESET|socket hang up/.test(String(e.message)))
      console.error('That is the HTTP client giving up on a socket, not a problem with the data.');
    console.error('The checkpoint is intact — every tile is recorded as it lands. Carry on with:\n'
      + '  node scripts/fetch-habitat.mjs --resume --out=' + o.out + ' >> habitat.log 2>&1');
    process.exit(2);
  });
  fetchHabitat(o).catch(e => {
    console.error('FAILED: ' + e.message);
    console.error('Re-run with --resume to carry on from the last tile.');
    process.exitCode = 1;
  });
}
