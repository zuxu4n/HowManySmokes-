// Berkeley Earth: 22 µg/m³ of PM2.5 sustained for 24h ≈ the mortality risk of one
// cigarette. The relationship is linear, so one hour at 22 µg/m³ is 1/24 of a cigarette.
const PM25_PER_CIGARETTE_DAY = 22;
const CIGARETTE_DOSE = PM25_PER_CIGARETTE_DAY * 24; // µg/m³·hours

const GEOMET = "https://geo.weather.gc.ca/geomet";

// ECCC's RAQDPS wildfire smoke plume, 10 km, hourly to +72h. Ground level is what
// you breathe; the full column is what you see (and what satellites photograph).
// The discrete (_Dis) styles paint every cell, so trace smoke floods the map in
// solid blue. The continuous styles start above zero and stay transparent where
// there's nothing worth seeing.
const SMOKE_LAYERS = {
  sfc: {
    layer: "RAQDPS.Sfc_PM2.5-WildfireSmokePlume",
    style: "PM2.5_1e-9to2.5e-7kgm3_RedGrey",
    hint: "What you'd actually breathe at street level.",
  },
  eatm: {
    layer: "RAQDPS.EAtm_PM2.5-WildfireSmokePlume",
    style: "PM2.5_EAtm_1e-7to2e-4kgm2",
    hint: "Smoke through the whole atmosphere: the haze you see overhead.",
  },
};

// Both numbers come from ECCC at 10 km, sampled out of WCS coverages.
//   past   -> RDAQA: the analysis, i.e. the model with surface observations
//             assimilated. The closest thing to "what was actually breathed".
//   future -> RAQDPS: the forecast that draws the plume above.
// An earlier version used CAMS (via Open-Meteo) for these. CAMS is global at
// ~45 km, which smooths the peaks of a plume badly — it read 3-4x low against
// the analysis during dense smoke. Convenient, but it was corrupting the only
// number the page actually claims.
const WCS_ANALYSIS = "RDAQA-FW_10km_PM2.5";
const WCS_FORECAST = "RAQDPS.SFC_PM2.5";

// Ontario, plus enough margin for every city in the list.
const GRID_BBOX = { latMin: 41.5, latMax: 52, lonMin: -95, lonMax: -74 };

// The server resamples the native grid to whatever size we ask for, and sampling
// a coarse grid puts cities in the wrong cell where the plume is steep. Measured
// against native-resolution GetFeatureInfo across all 28 cities: this size lands
// at ~2.4% mean error, versus ~9% (and 19% on Toronto alone) at the default.
const GRID_SIZE = { x: 240, y: 170 };
const HOUR_MS = 3600_000;

const LOCATIONS = [
  // Northwest — the active fire zone
  { name: "Red Lake", lat: 51.02, lon: -93.83 },
  { name: "Kenora", lat: 49.77, lon: -94.49 },
  { name: "Sioux Lookout", lat: 50.10, lon: -91.92 },
  { name: "Dryden", lat: 49.78, lon: -92.84 },
  { name: "Fort Frances", lat: 48.61, lon: -93.40 },
  { name: "Thunder Bay", lat: 48.38, lon: -89.25 },
  { name: "Marathon", lat: 48.72, lon: -86.38 },
  // North / northeast
  { name: "Moosonee", lat: 51.28, lon: -80.64 },
  { name: "Timmins", lat: 48.48, lon: -81.33 },
  { name: "Kapuskasing", lat: 49.41, lon: -82.43 },
  { name: "Sault Ste. Marie", lat: 46.52, lon: -84.33 },
  { name: "Sudbury", lat: 46.49, lon: -80.99 },
  { name: "North Bay", lat: 46.31, lon: -79.46 },
  // Central
  { name: "Parry Sound", lat: 45.34, lon: -80.04 },
  { name: "Owen Sound", lat: 44.57, lon: -80.94 },
  { name: "Barrie", lat: 44.39, lon: -79.69 },
  { name: "Peterborough", lat: 44.31, lon: -78.32 },
  { name: "Ottawa", lat: 45.42, lon: -75.70 },
  { name: "Kingston", lat: 44.23, lon: -76.49 },
  // South — where the smoke pools
  { name: "Toronto", lat: 43.65, lon: -79.38 },
  { name: "Mississauga", lat: 43.59, lon: -79.64 },
  { name: "Hamilton", lat: 43.26, lon: -79.87 },
  { name: "Kitchener", lat: 43.45, lon: -80.49 },
  { name: "Guelph", lat: 43.55, lon: -80.25 },
  { name: "Niagara Falls", lat: 43.09, lon: -79.08 },
  { name: "London", lat: 42.98, lon: -81.25 },
  { name: "Sarnia", lat: 42.97, lon: -82.40 },
  { name: "Windsor", lat: 42.31, lon: -83.04 },
];

// Colour by cigarettes accumulated. Thresholds are eyeballed for legibility,
// not derived from any health standard.
const SCALE = [
  { max: 0.5, color: "#4ade80" },
  { max: 1, color: "#a3e635" },
  { max: 2, color: "#facc15" },
  { max: 4, color: "#fb923c" },
  { max: 8, color: "#ef4444" },
  { max: 16, color: "#a855f7" },
  { max: Infinity, color: "#7f1d1d" },
];

const colorFor = (cigs) => SCALE.find((s) => cigs < s.max).color;
const format = (cigs) => (cigs >= 10 ? cigs.toFixed(0) : cigs.toFixed(1));

// How long the circles take to ease back to size after a zoom lands. Roughly
// matches Leaflet's own 250ms zoom animation so the two read as one motion.
const SETTLE_MS = 260;

// Web Mercator: metres per screen pixel depends on latitude, so each circle is
// converted using its own.
const metresPerPixel = (lat, zoom) =>
    (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom);

// The size a circle should end up on screen. It grows as you zoom in, but far
// slower than the map does, so it stays readable at street level.
function targetPixels(cigs, zoom) {
  const base = 6 + Math.sqrt(cigs) * 5;
  const growth = Math.min(Math.max(2 ** ((zoom - 5) * 0.3), 1), 2.2);
  return base * growth;
}

const targetRadius = (marker, zoom) =>
    targetPixels(marker.__cigs, zoom) * metresPerPixel(marker.getLatLng().lat, zoom);

const el = (id) => document.getElementById(id);
const statusEl = el("status");
const rankingEl = el("ranking");
const hoursInput = el("hours");
const timeInput = el("time");
const playBtn = el("play");

const mapEl = el("map");
// zoomSnap: 0 lets the zoom floor be fractional. With integer snapping Leaflet
// rounds *down*, which leaves the smoke image too small for the pane and puts its
// edges on screen. It also lets the wheel zoom land on fractions, which is what
// makes a gentler wheel step possible at all.
//
// wheelPxPerZoomLevel is how many scroll pixels make one zoom level; the default
// 60 covers a whole level in a single notch. Raising it to 180 gives roughly a
// third of a level per notch, so the smoke and the fire merges reveal themselves
// gradually rather than jumping past.
const map = L.map(mapEl, {
  zoomControl: true,
  zoomSnap: 0,
  wheelPxPerZoomLevel: 180,
}).setView([48.5, -84.5], 5);

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

// The PM2.5 scale belongs over the thing it explains. L.Control is the same
// mechanism the zoom buttons and attribution use, so it stays pinned to the
// corner while the map moves under it. Added here, before init() calls
// setSmokeLayer(), which fills in the image's src.
const legendControl = L.control({ position: "bottomleft" });
legendControl.onAdd = () => {
  const box = L.DomUtil.create("div", "map-legend");
  box.innerHTML =
    `<span class="map-legend-title">Smoke PM2.5</span>` +
    `<img id="wms-legend" alt="PM2.5 colour scale">`;
  // Without these, dragging or scrolling on the legend pans and zooms the map.
  L.DomEvent.disableClickPropagation(box);
  L.DomEvent.disableScrollPropagation(box);
  return box;
};
legendControl.addTo(map);

// The circles are L.circle (radius in *metres*), not L.circleMarker (pixels).
// Leaflet's zoom animation CSS-scales the renderer, so a geographic circle tracks
// it exactly: it stays on screen and grows with the map instead of ballooning and
// snapping back the way a pixel radius does. The catch is that metres alone would
// leave it enormous at city zoom, so `settleRadii()` eases it back to its
// intended screen size once the zoom lands.
const cigarettePane = map.createPane("cigarettes");
cigarettePane.style.zIndex = 450; // above the smoke overlay (400), below markers (600)
const cigaretteRenderer = L.svg({ pane: "cigarettes" });

// The flex layout settles after Leaflet measures the container, which otherwise
// leaves it stuck at its initial size and drawing a single tile. The zoom floor
// is recomputed here too: it depends on the pane's size, and it's what keeps the
// smoke overlay's edges off screen.
// The pane settles over several frames, and each size implies a different zoom
// floor, so keep re-fitting until the user takes over. Latching on the first
// callback fits a half-laid-out container and strands the view zoomed out.
let userMoved = false;
for (const evt of ["pointerdown", "wheel"]) {
  mapEl.addEventListener(evt, () => (userMoved = true), { passive: true });
}

new ResizeObserver(() => {
  if (!mapEl.clientWidth || !mapEl.clientHeight) return;
  map.invalidateSize();

  // `inside: true` asks for the zoom where the image *covers* the pane rather
  // than merely fits inside it — the difference between "no edges visible" and
  // "edges visible on the narrow axis". Reset the floor first, or the previous
  // one clamps the new measurement.
  map.setMinZoom(0);
  map.setMinZoom(map.getBoundsZoom(OVERLAY_BOUNDS, true));
  map.setMaxBounds(OVERLAY_BOUNDS);
  // Open at the floor set just above — the most zoomed-out the map ever goes —
  // rather than fitting tight to Ontario. Centered a few degrees south of
  // Ontario's true center so the view sits slightly lower in the pane instead
  // of centered on it.
  if (!userMoved) {
    const center = ONTARIO_VIEW.getCenter();
    map.setView([center.lat - 0.5, center.lng], map.getMinZoom());
  }
}).observe(mapEl);

let smokeOverlay = null;
let currentLayerKey = "sfc";
let frames = []; // timestamps (ms) offered by the WMS TIME dimension
let markers = new Map();
let playTimer = null;
let analysisLatest = null; // newest hour the analysis covers; after this, forecast
let gridCache = new Map(); // hour (ms) -> parsed grid, or null if unavailable
let inflight = new Map();
let pending = 0;
let frameUrls = new Map(); // "layerKey:frameIdx" -> Promise<url | null>
let buffered = 0;
let bufferRun = 0;
let fireLayer = null;
let fires = []; // { id, at, area, firstdate, lastdate }

// GeoMet rejects the milliseconds that toISOString() emits: it wants %Y-%m-%dT%H:%M:%SZ.
const wmsTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const labelFor = (ms) =>
    new Date(ms).toLocaleString("en-CA", {
      weekday: "short",
      hour: "numeric",
      hour12: true,
      timeZone: "America/Toronto",
    });

// One image for the whole province rather than a tiled layer. GeoMet's render
// cost is almost flat in image size — 256x256 measured ~430ms against ~370ms for
// 1024x768 — because it's dominated by loading the model slice, not by pixels. So
// a tiled layer pays that fixed cost 20x per frame (~1.6s) where one image pays
// it once (~0.4s), and it makes preloading the whole loop affordable.
const SMOKE_OPACITY = 0.3;

// Much wider than Ontario on purpose: a single image has edges, and a hard
// rectangle of smoke looks broken. The zoom floor keeps the pane inside this box
// so the edges are never reachable, which needs slack on both axes for tall or
// wide windows. At this width the image is ~4 km/px — still finer than the 10 km
// model underneath, so nothing is lost by not tiling.
const OVERLAY_BOUNDS = L.latLngBounds([
  [33, -105],
  [60, -65],
]);
const OVERLAY_WIDTH = 1024;

// What the map actually opens on.
const ONTARIO_VIEW = L.latLngBounds([
  [41.5, -95],
  [52, -74],
]);

// Fire locations from CWFIS (Natural Resources Canada). No API key, and it's the
// same data family that drives the RAQDPS/FireWork smoke above, so the fires line
// up with the plume. NASA FIRMS covers the same ground but needs a MAP_KEY capped
// at 5000 requests/10min — which, in a client-side app, every visitor would share
// out of one publicly visible key.
//
// m3_polygons_current is burned-area perimeters rather than raw satellite pixels:
// ~57 active fires instead of ~31,000 hotspot detections to cluster by hand.
const CWFIS = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wfs";
const FIRE_MIN_AREA_HA = 100; // below this the map is just noise
const FIRE_ACTIVE_HOURS = 24; // "currently burning" = detected again since then

// Two merges on the way out, at two fixed moments.
//
// Clustering by *geographic* distance rather than screen pixels is what makes
// them discrete: membership depends only on the stage, so it holds steady across
// a whole zoom band and changes only when you cross a boundary. Screen-distance
// clustering reshuffles continuously instead, which reads as drift rather than
// deliberate merges.
//
// `aboveFloor` is measured from the zoom floor, so the bands adapt to any window
// size. The first merge is deliberately late: from fully zoomed in you have to
// come a long way out before anything gathers.
//
// Distances tuned against the live fire set (53 fires spanning 1194 km):
// 53 apart -> 28 groups -> 12 groups. The last band runs to the zoom floor, so
// the map never collapses to a single orb.
// 1.45 is picked so the first split lands on the 4th scroll notch from the floor.
// A notch is 0.387 zoom at deltaY 100, or 0.461 at the deltaY 120 some Windows
// setups report — so three notches reach 1.16 or 1.38, and four reach 1.55 or
// 1.84. Anything in (1.383, 1.547] fires on the fourth for both; 1.45 sits in the
// middle of that. It follows wheelPxPerZoomLevel: change one and recheck the other.
const MERGE_STAGES = [
  { aboveFloor: 2.8, km: 0 }, // every fire on its own
  { aboveFloor: 1.45, km: 30 }, // merge 1: first split, 4 notches up from the floor
  { aboveFloor: -Infinity, km: 100 }, // merge 2, and it stays this way down to the floor
];

const FIRE_FLY_MS = 520;

// The map is Web Mercator and so is the image, so Leaflet placing it between two
// lat/lng corners lines up exactly with a 3857 GetMap over the same box.
function overlayUrl(key, ms) {
  const cfg = SMOKE_LAYERS[key];
  const sw = L.CRS.EPSG3857.project(OVERLAY_BOUNDS.getSouthWest());
  const ne = L.CRS.EPSG3857.project(OVERLAY_BOUNDS.getNorthEast());
  const height = Math.round((OVERLAY_WIDTH * (ne.y - sw.y)) / (ne.x - sw.x));
  return (
      `${GEOMET}?service=WMS&version=1.3.0&request=GetMap` +
      `&layers=${encodeURIComponent(cfg.layer)}&styles=${encodeURIComponent(cfg.style)}` +
      `&crs=EPSG:3857&bbox=${sw.x},${sw.y},${ne.x},${ne.y}` +
      `&width=${OVERLAY_WIDTH}&height=${height}` +
      `&format=image/png&transparent=true&time=${wmsTime(ms)}`
  );
}

// Decoding into the browser cache here is what makes the later setUrl() instant.
function preloadFrame(idx, key = currentLayerKey) {
  const cacheKey = `${key}:${idx}`;
  if (frameUrls.has(cacheKey)) return frameUrls.get(cacheKey);

  const url = overlayUrl(key, frames[idx]);
  const job = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  frameUrls.set(cacheKey, job);
  return job;
}

// Walks the whole loop from wherever the user is, so play becomes instant once
// it finishes. Superseded immediately if the layer or run changes.
async function bufferLoop() {
  const run = ++bufferRun;
  const key = currentLayerKey;
  const start = Number(timeInput.value);
  const queue = frames.map((_, k) => (start + k) % frames.length);

  buffered = 0;
  await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (queue.length) {
          if (run !== bufferRun || key !== currentLayerKey) return;
          await preloadFrame(queue.shift(), key);
          buffered++;
          setStatus();
        }
      })
  );
  if (run === bufferRun) setStatus();
}

async function showFrame(idx) {
  const url = await preloadFrame(idx);
  if (url && smokeOverlay) smokeOverlay.setUrl(url);
}

function setSmokeLayer(key) {
  currentLayerKey = key;
  const cfg = SMOKE_LAYERS[key];
  el("layer-hint").textContent = cfg.hint;

  const idx = Number(timeInput.value);
  if (!smokeOverlay) {
    smokeOverlay = L.imageOverlay(overlayUrl(key, frames[idx]), OVERLAY_BOUNDS, {
      opacity: SMOKE_OPACITY,
    }).addTo(map);
  }
  showFrame(idx);
  bufferLoop();

  el("wms-legend").src =
      `${GEOMET}?service=WMS&version=1.3.0&request=GetLegendGraphic` +
      `&layer=${encodeURIComponent(cfg.layer)}&style=${encodeURIComponent(cfg.style)}` +
      `&format=image/png&sld_version=1.1.0`;
}

// The forecast run advances twice a day, so the valid time range has to come from
// the service rather than being assumed.
async function loadFrames() {
  const url =
      `${GEOMET}?lang=en&service=WMS&version=1.3.0&request=GetCapabilities` +
      `&LAYERS=${encodeURIComponent(SMOKE_LAYERS.sfc.layer)}`;
  const xml = new DOMParser().parseFromString(await (await fetch(url)).text(), "text/xml");

  const dim = [...xml.querySelectorAll("Dimension")].find((d) => d.getAttribute("name") === "time");
  if (!dim) throw new Error("no time dimension in WMS capabilities");

  const [start, end, step] = dim.textContent.trim().split("/");
  const stepHours = Number(/PT(\d+)H/.exec(step)?.[1] ?? 1);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);

  frames = [];
  for (let t = startMs; t <= endMs; t += stepHours * 3600_000) frames.push(t);

  timeInput.max = String(frames.length - 1);
  timeInput.disabled = false;

  // Open on the frame closest to now, so the map opens on the present.
  const now = Date.now();
  const nearest = frames.reduce(
      (best, t, i) => (Math.abs(t - now) < Math.abs(frames[best] - now) ? i : best),
      0
  );
  timeInput.value = String(nearest);
}

// A deliberately small GeoTIFF reader. GeoMet's WCS returns exactly one shape —
// uncompressed float32, one band, strip layout, plain WGS84 — so rather than pull
// in a general library, this asserts that shape and refuses anything else.
function parseGeoTiff(buffer) {
  const dv = new DataView(buffer);
  const little = dv.getUint8(0) === 0x49;
  const u16 = (o) => dv.getUint16(o, little);
  const u32 = (o) => dv.getUint32(o, little);

  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };
  const ifd = u32(4);
  const tags = {};
  for (let i = 0; i < u16(ifd); i++) {
    const entry = ifd + 2 + i * 12;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const width = SIZES[type] || 1;
    const at = count * width > 4 ? u32(entry + 8) : entry + 8;
    const values = [];
    for (let k = 0; k < count; k++) {
      const o = at + k * width;
      if (type === 3) values.push(u16(o));
      else if (type === 4) values.push(u32(o));
      else if (type === 12) values.push(dv.getFloat64(o, little));
    }
    tags[tag] = values;
  }

  const [width] = tags[256];
  const [height] = tags[257];
  if (tags[259]?.[0] !== 1 || tags[339]?.[0] !== 3 || tags[258]?.[0] !== 32) {
    throw new Error("unexpected GeoTIFF encoding from GeoMet");
  }

  const pixels = new Float32Array(width * height);
  const offsets = tags[273];
  const counts = tags[279];
  let n = 0;
  for (let s = 0; s < offsets.length; s++) {
    for (let b = 0; b < counts[s] && n < pixels.length; b += 4) {
      pixels[n++] = dv.getFloat32(offsets[s] + b, little);
    }
  }

  const [scaleX, scaleY] = tags[33550];
  const tie = tags[33922];
  return { width, height, lon0: tie[3], lat0: tie[4], scaleX, scaleY, pixels };
}

// Nearest cell. Bilinear was measured worse here — the reference values are
// themselves nearest-cell reads of the native grid, so smoothing moves away.
function sampleGrid(grid, lat, lon) {
  const x = Math.floor((lon - grid.lon0) / grid.scaleX);
  const y = Math.floor((grid.lat0 - lat) / grid.scaleY);
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
  const v = grid.pixels[y * grid.width + x];
  return Number.isFinite(v) && v >= 0 ? v * 1e9 : null; // kg/m³ -> µg/m³
}

function gridUrl(ms) {
  const coverage = analysisLatest !== null && ms <= analysisLatest ? WCS_ANALYSIS : WCS_FORECAST;
  const { latMin, latMax, lonMin, lonMax } = GRID_BBOX;
  return (
      `${GEOMET}?service=WCS&version=2.0.1&request=GetCoverage` +
      `&coverageId=${encodeURIComponent(coverage)}&format=image/tiff` +
      `&subset=lat(${latMin},${latMax})&subset=long(${lonMin},${lonMax})` +
      `&scalesize=long(${GRID_SIZE.x}),lat(${GRID_SIZE.y})` +
      `&time=${wmsTime(ms)}`
  );
}

function fetchGrid(ms) {
  if (gridCache.has(ms)) return Promise.resolve(gridCache.get(ms));
  if (inflight.has(ms)) return inflight.get(ms);

  const job = (async () => {
    let grid = null;
    try {
      const res = await fetch(gridUrl(ms));
      // Outside a model's valid range GeoMet answers with an XML exception.
      if (res.ok && res.headers.get("content-type")?.includes("tiff")) {
        grid = parseGeoTiff(await res.arrayBuffer());
      }
    } catch {
      grid = null; // one missing hour shouldn't sink the whole window
    }
    gridCache.set(ms, grid);
    inflight.delete(ms);
    return grid;
  })();

  inflight.set(ms, job);
  return job;
}

// Fetches only the hours not already cached, so stepping the animation forward
// costs one grid per frame rather than a fresh window.
async function ensureGrids(atMs, hours, onProgress) {
  const queue = [];
  for (let i = 0; i < hours; i++) {
    const t = atMs - i * HOUR_MS;
    if (!gridCache.has(t) && !inflight.has(t)) queue.push(t);
  }
  if (!queue.length) return;

  pending = queue.length;
  onProgress?.(pending, queue.length);
  const total = queue.length;

  await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (queue.length) {
          await fetchGrid(queue.shift());
          pending--;
          onProgress?.(pending, total);
        }
      })
  );
}

// GeoMet has no time-series GetFeatureInfo (range syntax is rejected), so this is
// one request per city. That's why it only samples the newest analysis hour
// rather than backfilling the whole 24h window.
async function fetchMeasured(loc, timeIso) {
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetFeatureInfo",
    layers: RDAQA_LAYER,
    query_layers: RDAQA_LAYER,
    crs: "EPSG:4326", // WMS 1.3.0 + EPSG:4326 means lat,lon axis order
    bbox: `${loc.lat - 0.05},${loc.lon - 0.1},${loc.lat + 0.05},${loc.lon + 0.1}`,
    width: "101",
    height: "101",
    i: "50",
    j: "50",
    info_format: "application/json",
    time: timeIso,
  });
  const res = await fetch(`${GEOMET}?${params}`);
  if (!res.ok) return null;
  const feature = (await res.json()).features?.[0];
  return feature ? feature.properties.value * 1e9 : null; // kg/m³ -> µg/m³
}

async function loadFires() {
  const since = wmsTime(Date.now() - FIRE_ACTIVE_HOURS * HOUR_MS);
  const { latMin, latMax, lonMin, lonMax } = GRID_BBOX;

  // GeoServer rejects `bbox` and `CQL_FILTER` together ("mutually exclusive"), so
  // the extent has to live inside the filter.
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: "public:m3_polygons_current",
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    CQL_FILTER:
        `BBOX(geometry,${lonMin},${latMin},${lonMax},${latMax},'EPSG:4326')` +
        ` AND area > ${FIRE_MIN_AREA_HA} AND lastdate AFTER ${since}`,
  });

  const res = await fetch(`${CWFIS}?${params}`);
  if (!res.ok) throw new Error(`CWFIS returned ${res.status}`);
  const data = await res.json();

  fires = (data.features ?? []).map((feature, i) => ({
    id: `f${i}`,
    // Only the location is needed, so collapse each perimeter to its centre
    // rather than drawing 400-vertex polygons over the plume.
    at: L.geoJSON(feature).getBounds().getCenter(),
    area: feature.properties.area,
    firstdate: feature.properties.firstdate,
    lastdate: feature.properties.lastdate,
  }));

  renderFires();
  return fires.length;
}

const stageFor = (zoom) => MERGE_STAGES.find((s) => zoom - map.getMinZoom() >= s.aboveFloor);

const meanLatLng = (members) =>
    L.latLng(
        members.reduce((sum, f) => sum + f.at.lat, 0) / members.length,
        members.reduce((sum, f) => sum + f.at.lng, 0) / members.length
    );

// Greedy clustering on real ground distance. Stable within a stage, so nothing
// moves until a boundary is crossed.
function clusterFires(zoom) {
  const { km } = stageFor(zoom);
  if (!km) return fires.map((f) => ({ members: [f], at: f.at }));

  const limit = km * 1000;
  const clusters = [];
  for (const fire of fires) {
    let best = null;
    let bestDist = limit;
    for (const c of clusters) {
      const d = map.distance(fire.at, c.at);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    if (best) {
      best.members.push(fire);
      // Drift the centre toward the running mean so a chain of nearby fires
      // settles on their middle rather than on whichever came first.
      best.at = meanLatLng(best.members);
    } else {
      clusters.push({ members: [fire], at: fire.at });
    }
  }
  return clusters;
}

const fireIconHtml = (area) =>
    `<span style="font-size:${Math.round(16 + Math.min(Math.sqrt(area) / 4, 18))}px">🔥</span>`;

function firePopup(fire) {
  return `<div class="popup-title">Active fire</div>
    <div class="popup-cigs" style="color:#fb923c">${Math.round(fire.area).toLocaleString()} ha</div>
    <div class="popup-meta">
      burning since ${labelFor(Date.parse(fire.firstdate))}<br>
      last seen ${labelFor(Date.parse(fire.lastdate))}
    </div>
    <div class="popup-compare">
      <div class="compare-head">CWFIS burned-area perimeter (NRCan)</div>
    </div>`;
}

function addFire(fire, from) {
  const size = Math.round(16 + Math.min(Math.sqrt(fire.area) / 4, 18));
  const marker = L.marker(from ?? fire.at, {
    icon: L.divIcon({
      className: "fire-icon",
      html: fireIconHtml(fire.area),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      // The emoji glyph doesn't fill its span evenly — it renders visually left
      // of the span's true center — so Leaflet's default popup position, which
      // centers on iconAnchor, lands a few px left of the icon itself. Nudge it
      // right to re-center over what's actually drawn on screen.
      popupAnchor: [10, -8],
    }),
    // Keep fires above the cigarette circles; they're the cause, not the effect.
    zIndexOffset: 1000,
  })
      .bindPopup(firePopup(fire))
      // Hover opens/closes it; click still works too, since touch devices have
      // no hover at all and rely on the tap.
      .on("mouseover", function () {
        this.openPopup();
      })
      .on("mouseout", function () {
        this.closePopup();
      })
      .addTo(fireLayer);

  if (!from) return;

  // Leaflet positions markers with a transform, so a CSS transition on that
  // property is all it takes to fly them out of the orb they were hiding in.
  // Forcing a reflow commits the start position; deliberately not waiting on
  // requestAnimationFrame, which never fires in a backgrounded tab and would
  // strand every fire on top of its orb.
  const el = marker.getElement();
  el.style.setProperty("--fire-fly", `${FIRE_FLY_MS}ms`);
  el.classList.add("fire-emerging");
  void el.offsetWidth;
  el.classList.add("fire-flying");
  marker.setLatLng(fire.at);
  setTimeout(() => el.classList.remove("fire-flying", "fire-emerging"), FIRE_FLY_MS + 60);
}

// Where this cluster's members were last drawn, deduplicated: three orbs merging
// should send three things inward, not one per fire.
function previousSpots(cluster, previous) {
  const spots = [];
  for (const fire of cluster.members) {
    const was = previous.get(fire.id);
    if (!was || was.equals(cluster.at)) continue;
    if (!spots.some((s) => s.equals(was))) spots.push(was);
  }
  return spots;
}

function addOrb(cluster, gatherFrom = []) {
  const totalArea = cluster.members.reduce((sum, f) => sum + f.area, 0);
  // Sized to sit just above a lone fire (16-34px). The old range topped out at
  // 68px, which suited a soft blurred orb but is heavy for a solid emoji — and it
  // saturated so often that size stopped telling you anything. The badge carries
  // the count; this only needs to say "bigger than one fire".
  const size = Math.round(28 + Math.min(Math.sqrt(totalArea) / 8, 22));

  const orb = L.marker(cluster.at, {
    icon: L.divIcon({
      className: "fire-orb",
      html:
          `<span class="orb-flame" style="font-size:${size}px">🔥</span>` +
          `<span class="orb-count">${cluster.members.length}</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      // Same emoji-centering nudge as the individual fire icon, see there.
      popupAnchor: [10, -8],
    }),
    zIndexOffset: 900, // just under the individual fires
  })
      .bindPopup(
          `<div class="popup-title">${cluster.members.length} fires burning here</div>
       <div class="popup-cigs" style="color:#fb923c">${Math.round(totalArea).toLocaleString()} ha</div>
       <div class="popup-meta">zoom in to separate them</div>`
      )
      .on("mouseover", function () {
        this.openPopup();
      })
      .on("mouseout", function () {
        this.closePopup();
      })
      .addTo(fireLayer);

  if (!gatherFrom.length) return;

  // Fade the orb up while the fires converge on it. Only opacity is animated:
  // the marker's transform belongs to Leaflet, and touching it fights positioning.
  const orbEl = orb.getElement();
  orbEl.style.setProperty("--fire-fly", `${FIRE_FLY_MS}ms`);
  orbEl.classList.add("orb-gathering");
  setTimeout(() => orbEl.classList.remove("orb-gathering"), FIRE_FLY_MS + 60);

  // Throwaway flames that fly inward and fade, so the merge reads as the fires
  // being pulled in rather than blinking out.
  for (const from of gatherFrom) {
    const ghost = L.marker(from, {
      icon: L.divIcon({ className: "fire-icon", html: "<span>🔥</span>", iconSize: [20, 20], iconAnchor: [10, 10] }),
      interactive: false,
      zIndexOffset: 950,
    }).addTo(fireLayer);

    const el = ghost.getElement();
    el.style.setProperty("--fire-fly", `${FIRE_FLY_MS}ms`);
    void el.offsetWidth; // commit the start position before transitioning off it
    el.classList.add("fire-flying", "fire-merging");
    ghost.setLatLng(cluster.at);
    setTimeout(() => fireLayer && fireLayer.removeLayer(ghost), FIRE_FLY_MS + 40);
  }
}

// Remembers which orb each fire was folded into, so that when a cluster breaks
// apart the fires can start from where the user last saw them.
let fireOrigins = new Map();
let currentStage = null;

function renderFires({ animate = false } = {}) {
  if (!fires.length) return;
  if (fireLayer) map.removeLayer(fireLayer);
  fireLayer = L.layerGroup().addTo(map);

  currentStage = stageFor(map.getZoom());
  const clusters = clusterFires(map.getZoom());
  const previous = fireOrigins;
  fireOrigins = new Map();
  for (const c of clusters) for (const f of c.members) fireOrigins.set(f.id, c.at);

  for (const cluster of clusters) {
    if (cluster.members.length > 1) {
      addOrb(cluster, animate ? previousSpots(cluster, previous) : []);
      continue;
    }
    const fire = cluster.members[0];
    const cameFrom = previous.get(fire.id);
    // Only fly when it actually escaped an orb, not on every re-render.
    const emerged = animate && cameFrom && !cameFrom.equals(cluster.at);
    addFire(fire, emerged ? cameFrom : null);
  }
}

// Clusters are geographic now, so Leaflet repositions them on zoom by itself.
// Only a stage boundary actually changes anything — re-rendering within a band
// would replay the merge animation over and over for no visible reason.
map.on("zoomend", () => {
  if (stageFor(map.getZoom()) === currentStage) return;
  renderFires({ animate: true });
});




// The analysis only reaches the present. Everything past its newest hour has to
// come from the forecast, so the boundary decides which coverage each hour uses.
async function loadAnalysisRange() {
  const url =
      `${GEOMET}?lang=en&service=WMS&version=1.3.0&request=GetCapabilities` +
      `&LAYERS=${encodeURIComponent(WCS_ANALYSIS)}`;
  const xml = new DOMParser().parseFromString(await (await fetch(url)).text(), "text/xml");
  const dim = [...xml.querySelectorAll("Dimension")].find((d) => d.getAttribute("name") === "time");
  const latest = dim?.getAttribute("default");
  if (latest) analysisLatest = Date.parse(latest);
}

// Cigarettes accumulated over the `hours` ending at `atMs` — so scrubbing the
// timeline answers "what would you have breathed by then". Returns null until
// every hour in the window is present, rather than a number that climbs as
// grids trickle in.
function cigarettesAt(loc, atMs, hours) {
  let dose = 0;
  for (let i = 0; i < hours; i++) {
    const grid = gridCache.get(atMs - i * HOUR_MS);
    if (!grid) return null;
    const value = sampleGrid(grid, loc.lat, loc.lon);
    if (value === null) return null;
    dose += value;
  }
  return dose / CIGARETTE_DOSE;
}

// Mid-zoom each circle is carrying the map's full scale change (2x per level).
// That's what keeps it glued to the map, but it's too big to leave there, so ease
// each one to its target rather than snapping — the zoom and the resize then read
// as a single continuous motion.
let settleFrame = null;
function settleRadii() {
  cancelAnimationFrame(settleFrame);
  const zoom = map.getZoom();
  const items = [...markers.values()]
      .filter((m) => m.__cigs !== undefined)
      .map((m) => ({ m, from: m.getRadius(), to: targetRadius(m, zoom) }));
  if (!items.length) return;

  // requestAnimationFrame is dead in a backgrounded tab, which would leave the
  // circles frozen at whatever size the zoom left them.
  if (document.hidden) {
    for (const { m, to } of items) m.setRadius(to);
    return;
  }

  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / SETTLE_MS, 1);
    const eased = 1 - (1 - t) ** 3; // ease-out cubic
    for (const { m, from, to } of items) m.setRadius(from + (to - from) * eased);
    if (t < 1) settleFrame = requestAnimationFrame(step);
  };
  settleFrame = requestAnimationFrame(step);
}

// A settle that outlives its zoom is the reason circles flicker to a wrong spot
// while scrolling. Each tween frame calls setRadius -> redraw -> _project, which
// reprojects the path against the map's *current* zoom — and Leaflet sets that to
// the target the instant a zoom begins, while the renderer's container is still
// CSS-transformed for the old one. The path lands in the wrong coordinate space
// until zoomend resets the renderer.
//
// Scrolling fires zooms faster than the 260ms settle, so the two overlap
// constantly. Stop tweening the moment a new zoom starts; the zoomend that
// follows restarts it from wherever it got to, so nothing is lost.
map.on("zoomstart", () => cancelAnimationFrame(settleFrame));
map.on("zoomend", settleRadii);


const isMeasured = (ms) => analysisLatest !== null && ms <= analysisLatest;

// A 24h window straddles the analysis/forecast boundary, so naming it after its
// last hour alone would be a lie — most of the dose usually comes from the
// measured side.
function windowMix(atMs, hours) {
  let measured = 0;
  for (let i = 0; i < hours; i++) if (isMeasured(atMs - i * HOUR_MS)) measured++;
  return { measured, forecast: hours - measured };
}

function describeWindow(atMs, hours) {
  const { measured, forecast } = windowMix(atMs, hours);
  if (!forecast) return `${measured}h measured`;
  if (!measured) return `${forecast}h forecast`;
  return `${measured}h measured + ${forecast}h forecast`;
}

function render() {
  const hours = Number(hoursInput.value);
  const atMs = frames[Number(timeInput.value)] ?? Date.now();
  el("hours-out").value = hours;
  el("time-label").textContent = labelFor(atMs);

  showFrame(Number(timeInput.value));

  const rows = LOCATIONS.map((loc) => ({ ...loc, cigs: cigarettesAt(loc, atMs, hours) }))
      .filter((r) => r.cigs !== null)
      .sort((a, b) => b.cigs - a.cigs);

  for (const row of rows) {
    const color = colorFor(row.cigs);
    let marker = markers.get(row.name);
    if (!marker) {
      marker = L.circle([row.lat, row.lon], {
        radius: 1, // real value set below, once __cigs exists
        renderer: cigaretteRenderer,
      }).addTo(map);
      // Leaflet anchors a Path's popup at the clicked point, not the shape's
      // centre, and a click on a circle's edge is a geographic offset that grows
      // on screen with every zoom level.
      marker.on("popupopen", (e) => e.popup.setLatLng(marker.getLatLng()));
      markers.set(row.name, marker);
    }
    marker.__cigs = row.cigs;
    // Set outright rather than easing: this fires on every animation frame while
    // the timeline plays, and tweening there would fight the playback.
    marker.setRadius(targetRadius(marker, map.getZoom()));
    marker.setStyle({
      color,
      fillColor: color,
      fillOpacity: 0.45,
      weight: 1.5,
    });
    const now = sampleGrid(gridCache.get(atMs), row.lat, row.lon);
    marker.bindPopup(`
      <div class="popup-title">${row.name}</div>
      <div class="popup-cigs" style="color:${color}">${format(row.cigs)} cigarettes</div>
      <div class="popup-meta">after ${hours}h outside, by ${labelFor(atMs)}</div>
      <div class="popup-compare">
        <div class="compare-row">
          <span>PM2.5 at ${labelFor(atMs)} <em>(${isMeasured(atMs) ? "measured" : "forecast"})</em></span>
          <b>${now === null ? "–" : `${now.toFixed(0)} µg/m³`}</b>
        </div>
        <div class="compare-head">ECCC 10 km · ${describeWindow(atMs, hours)}</div>
      </div>`);
  }

  rankingEl.innerHTML = rows
      .map(
          (row) => `
      <li data-name="${row.name}">
        <span class="dot" style="background:${colorFor(row.cigs)}"></span>
        <span class="name">${row.name}</span>
        <span class="cigs">${format(row.cigs)}</span>
      </li>`
      )
      .join("");
}

function stopPlaying() {
  clearInterval(playTimer);
  playTimer = null;
  playBtn.textContent = "▶";
}

function setStatus() {
  if (pending > 0) {
    statusEl.textContent = `Loading ECCC grids… ${pending} hour${pending === 1 ? "" : "s"} to go`;
    return;
  }
  const atMs = frames[Number(timeInput.value)] ?? Date.now();
  const window = `ECCC 10 km · ${describeWindow(atMs, Number(hoursInput.value))}`;
  statusEl.textContent =
      buffered < frames.length
          ? `${window} · buffering animation ${buffered}/${frames.length}`
          : `${window} · ${frames.length} frames ready`;
}

// Every scrub needs the 24h behind the new frame, so coalesce bursts of slider
// input into a single fetch.
let updateToken = 0;
async function update() {
  const token = ++updateToken;
  const atMs = frames[Number(timeInput.value)] ?? Date.now();
  const hours = Number(hoursInput.value);

  render();
  await ensureGrids(atMs, hours, () => token === updateToken && setStatus());
  if (token !== updateToken) return; // a newer scrub already superseded this one
  render();
  setStatus();

  // Stepping forward only ever needs the newest hour of the next window, so warm
  // those in the background rather than stalling the next frame on them. The
  // look-ahead is deeper than the playback interval strictly needs, to absorb a
  // slow grid without the animation hitching.
  const idx = Number(timeInput.value);
  for (let k = 1; k <= 8; k++) {
    const t = frames[(idx + k) % frames.length];
    if (t !== undefined && !gridCache.has(t) && !inflight.has(t)) fetchGrid(t);
  }
}

playBtn.addEventListener("click", () => {
  if (playTimer) return stopPlaying();
  playBtn.textContent = "❚❚";
  playTimer = setInterval(() => {
    timeInput.value = String((Number(timeInput.value) + 1) % frames.length);
    update();
  }, 900);
});

timeInput.addEventListener("input", () => {
  stopPlaying();
  update();
});

hoursInput.addEventListener("input", update);

el("layer-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  [...e.currentTarget.children].forEach((b) => b.classList.toggle("active", b === btn));
  setSmokeLayer(btn.dataset.layer);
});

rankingEl.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  const marker = li && markers.get(li.dataset.name);
  if (!marker) return;
  map.flyTo(marker.getLatLng(), 8);
  marker.openPopup();
});

async function init() {
  try {
    await Promise.all([loadFrames(), loadAnalysisRange()]);
    setSmokeLayer(currentLayerKey);
    statusEl.classList.remove("error");

    // Additive, and from a different service: a CWFIS outage shouldn't take the
    // smoke map down with it.
    loadFires().catch(() => {});
    await update(); // plume is already drawn; this fills in the numbers
  } catch (err) {
    statusEl.textContent = `Couldn't load data: ${err.message}`;
    statusEl.classList.add("error");
  }
}

init();

// A new analysis hour lands roughly hourly; drop the cache so the newest hour is
// fetched rather than served stale.
setInterval(() => {
  loadAnalysisRange()
      .then(() => {
        gridCache.delete(analysisLatest);
        return update();
      })
      .catch(() => {});
  loadFires().catch(() => {});
}, 30 * 60 * 1000);