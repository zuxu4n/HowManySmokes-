# How Many Smokes?

Live, animated, interactive map of wildfire smoke over Ontario that answers one question:
if you spent the day outside, how many cigarettes would you have effectively
breathed?

Built during the July 2026 northwestern Ontario wildfires, when smoke pushed
south and Toronto briefly ranked worst in the world for air quality.

## Running it

Must be served over HTTP, since `file://` origins get blocked by CORS.

```sh
python devserver.py 5177
# open http://localhost:5177
```

`devserver.py` is `python -m http.server` plus `Cache-Control: no-store`. The
stdlib server sends `Last-Modified` but no `Cache-Control`, so browsers fall back
to *heuristic* caching (~10% of the file's age) and will happily serve a stale
`app.js` for minutes after an edit — you change something, reload, and see
nothing. It revalidates fine when asked; the browser just doesn't ask.

## Data: all ECCC, 10 km

Everything on the page — the plume and the numbers.
Canada's [GeoMet](https://eccc-msc.github.io/open-data/msc-data/nwp_raqdps-fw/readme_raqdps-fw_en/),
free, no API key, and `Access-Control-Allow-Origin: *` so the browser talks to it
directly with no backend.

| Role | Product | Notes |
| --- | --- | --- |
| Plume raster (ground) | `RAQDPS.Sfc_PM2.5-WildfireSmokePlume` | WMS, smoke you'd breathe |
| Plume raster (column) | `RAQDPS.EAtm_PM2.5-WildfireSmokePlume` | WMS, haze you'd see |
| Numbers, past hours | `RDAQA-FW_10km_PM2.5` | WCS, **analysis** — observations assimilated |
| Numbers, future hours | `RAQDPS.SFC_PM2.5` | WCS, forecast |

Fire locations come from **CWFIS** (Natural Resources Canada), also keyless and
CORS-enabled: `public:m3_polygons_current` over WFS.

### Why CWFIS and not NASA FIRMS

FIRMS is the obvious answer and it does work, its WFS endpoint even sends
`Access-Control-Allow-Origin: *`, so it's callable from the browser. It's still
the wrong choice here:

- **It's the only thing that could actually run out.** FIRMS needs a `MAP_KEY`
  capped at 5000 transactions/10 min. Nothing else in this app has a key, so each
  visitor draws on their own IP. A key in client-side code is shared by every
  visitor *and* publicly visible — a quota you can exhaust, and that someone else
  can exhaust for you.
- **It returns pixels, not fires.** ~31,000 raw hotspot detections over the
  region, needing clustering. CWFIS publishes ready-made perimeters: 229 in the
  box, 57 currently active, with `area` in hectares and first/last detection.
- **Same lineage as the plume.** RAQDPS/FireWork is driven by CWFIS hotspots, so
  the fires agree with the smoke. FIRMS could show hotspots the smoke model
  doesn't know about.

FIRMS would win if this ever went global, CWFIS is Canada only.

The fires are *current* and don't move with the time scrubber, which is a real
inconsistency: scrub to +48h and you're seeing tomorrow's smoke over today's
fires. Labelled in the legend rather than hidden.

Fires that would visually collide are clustered into a single larger, lit flame
carrying a count badge. Both directions are animated off the same mechanism — Leaflet positions markers with a CSS transform,
so transitioning that property is the whole trick:

- **Splitting**: each fire is created at the orb's old position, then transitioned
  out to its real one.
- **Merging**: throwaway flames are spawned at the members' previous positions and
  flown inward while fading, as the new orb fades up (`previousSpots()` dedupes
  them, so three orbs merging sends three flames inward, not thirty-seven).

Animate **opacity only** on a marker's root element. Its transform belongs to
Leaflet, and a keyframe touching it fights positioning. Force a reflow
(`void el.offsetWidth`) between setting the start position and adding the
transition, or the browser coalesces both into one style pass and nothing moves.

Merges are **discrete: two of them**, defined by `MERGE_STAGES`. Clustering by
*geographic* distance rather than screen pixels is what makes them so — membership
depends only on the stage, so it holds steady across a whole zoom band and changes
only when a boundary is crossed. Screen-distance clustering reshuffles at every
zoom, which reads as drift rather than deliberate merges. Bands are measured from
`minZoom`, so they adapt to any window size. Measured:

| | Zoom | Distance | Groups | Orbs | Biggest |
| --- | --- | --- | --- | --- | --- |
| apart | 10.0 | — | 53 | 0 | 1 |
| merge 1 | 8.62 | 30 km | 28 | 17 | 4 |
| merge 2 | 7.02 | 100 km | 12 | 9 | 11 |
| *(floor)* | 5.02 | 100 km | 12 | 9 | 11 |

The last band runs all the way to the floor, so the map never collapses into a
single orb.

Worth knowing if that ever changes: a "everything in one orb" stage needs
`km: Infinity`, not a big number. Greedy clustering can't bridge a gap wider than
its threshold, and these fires span 1194 km — 800 km still left two orbs stranded.

Because clusters are geographic, Leaflet repositions them on zoom for free, so
`zoomend` only re-renders when the stage actually changes. Otherwise the merge
animation replays on every zoom for no visible reason.

`RDAQA` is the Regional Deterministic Air Quality **Analysis**: the model with
surface observations folded in. Its WMS time range ends at "now", which is how
the app knows where measurement stops and forecast begins. A 24h window usually
straddles that boundary, so the UI reports the split honestly
("19h measured + 5h forecast") rather than naming the window after one source.

### Why not CAMS / Open-Meteo (it was, at first)

The first version used Open-Meteo (CAMS) for the per-city numbers because one
request returns 28 cities × 72 hours. Convenient — and wrong enough to matter.
CAMS is global at ~45 km, which smooths the peaks of a smoke plume flat:

| Toronto (UTC) | ECCC RDAQA (10 km) | Open-Meteo (CAMS, ~45 km) |
| --- | --- | --- |
| 2026-07-15 12:00 | 75.1 | 23.5 |
| 2026-07-16 00:00 | **157.1** | 44.1 |
| 2026-07-16 06:00 | **140.7** | 55.2 |

That's a 3-4x understatement of the only number the page actually claims —
Toronto read 1.8 cigarettes when the truer answer was ~5.8. It also wasn't a
constant offset (at Thunder Bay the model read *higher*), so it couldn't be
divided out. The fix was to stop using it, not to correct it.

### Why not the other obvious APIs

- **Google Maps Air Quality** — has `heatmapTiles`, but renders a *current* AQI
  index rather than a smoke forecast, can't animate forward, needs a billing
  account, and would put an API key in client-side code.
- **firesmoke.ca** (BlueSky Canada, UBC) — good model, but publishes KMZ and
  NetCDF rather than a web tile service. GeoMet is the same class of product
  built for web maps.
- **OpenAQ** — real station measurements, but **unusable from a static site**:
  the key goes in an `X-API-Key` header, forcing a CORS preflight, and the
  preflight 401s with no `Access-Control-Allow-Origin`, so browsers block it. It
  would need a backend proxy, and it has no forecast.
- **OpenWeather** — no air-pollution raster exists at all (tile layers are only
  `clouds_new`, `precipitation_new`, `pressure_new`, `wind_new`, `temp_new`).
  Its Air Pollution API is point-JSON only, needs a key, has no multi-coordinate
  support, and is SILAM — still a model, not measurements.

## How the number is calculated

Berkeley Earth's [cigarette equivalence rule](https://berkeleyearth.org/air-pollution-and-cigarette-equivalence/):
breathing **22 µg/m³ of PM2.5 for 24 hours** carries roughly the same mortality
risk as smoking **one cigarette**, derived from 1.37 deaths per million
cigarettes smoked.

The rule is linear, so the app integrates hour by hour rather than averaging —
each hour at 22 µg/m³ is 1/24 of a cigarette:

```
cigarettes = Σ(hourly PM2.5 over the window) / (22 × 24)
```

The window is the *N hours ending at the selected frame*, so scrubbing moves the
plume and the counts together.

### Why the plume is one image, not a tile layer

A tiled WMS layer made the animation unusable: **20 tiles per frame, ~1570 ms**
to change time. The instinct is that tiles are cheaper because they're smaller —
they aren't. GeoMet's render cost is almost flat in image size, because it's
dominated by loading the model slice rather than by pixels:

| Request size | Time |
| --- | --- |
| 256×256 | 431 ms |
| 512×512 | 405 ms |
| 1024×768 | **371 ms** |
| 1280×960 | 636 ms |

So a tile layer pays that fixed cost 20 times per frame; one `imageOverlay` pays
it once. That also makes preloading the whole loop affordable — 73 requests
instead of 1460 — so `bufferLoop()` walks every frame into the browser cache
(GeoMet sends `Cache-Control: max-age=3600`) and playback becomes a `setUrl()`
against a warm cache.

Measured after buffering: **frame swaps of 4–13 ms**, and playback holding
899–901 ms against a 900 ms interval with zero stalls.

The image is ~4 km/px — still finer than the 10 km model under it, so not tiling
costs no real detail.

### Getting hourly values out of a raster service

`GetFeatureInfo` reads one point at one hour, and GeoMet rejects time-range
syntax — so a 24h window across 28 cities would be 672 requests.

Instead the app pulls **one WCS `GetCoverage` GeoTIFF per hour** covering all of
Ontario (24 requests, ~163 KB each) and samples all 28 cities out of the grid
locally. Measured: 24 requests, ~149 ms median, **under a second** total
six-wide.

The GeoTIFF is plain WGS84 with a `ModelTiepoint` + `ModelPixelScale`, so
lat/lon → pixel is arithmetic; no projection library needed. `parseGeoTiff()` is
~40 lines that assert GeoMet's exact shape (uncompressed, float32, one band,
strips) and throw on anything else, rather than pulling in a general library.

**Verified end-to-end**: the browser's sampled value for Toronto matched
`GetFeatureInfo`'s native read exactly (183.0 µg/m³), and Marathon's 24h
integration computed independently in Python came to 20.7 cigarettes against the
page's 21.

## Gotchas worth knowing

- **GeoMet rejects `toISOString()`.** It wants `%Y-%m-%dT%H:%M:%SZ` and errors
  with `NoMatch` on the milliseconds JS emits. Hence `wmsTime()`.
- **WCS wants `time=`, not `subset=time(...)`.** The spec-shaped
  `subset=time("2026-07-16T07:00:00Z")` fails with `InvalidSubsetting`; the plain
  WMS-style `time=` parameter works.
- **Sample nearest, not bilinear.** Measured across 28 cities, bilinear was
  *worse* (8.1% vs 2.4%) — the reference values are themselves nearest-cell reads
  of the native grid, so smoothing moves away from them.
- **Grid resolution matters more than expected.** `scalesize=long(240),lat(170)`
  lands at ~2.4% mean error vs native; the default 97×98 is ~9% mean and 19% low
  on Toronto specifically. Error is non-monotonic with size (alignment luck), so
  measure rather than assume finer is better.
- **Values are kg/m³**, not µg/m³ — multiply by 1e9. The `class` property on
  `GetFeatureInfo` (`">= 100 [ug/m3]"`) is a good sanity check.
- **Layer names are `RAQDPS.*`, not `RAQDPS-FW.*`.** The `RAQDPS-FW.*` layers are
  climatology products. ECCC also ships a `Sfc_PM2.5-WildireSmokePlume-DAvg`
  layer with "Wildire" misspelled.
- **Avoid the discrete `_Dis` styles.** They paint every cell including near-zero,
  flooding the map in solid blue. Continuous styles stay transparent where
  there's no smoke.
- **WMS 1.3.0 + `EPSG:4326` means lat,lon axis order**, not lon,lat.
- **GeoServer rejects `bbox` and `CQL_FILTER` in the same WFS request** ("mutually
  exclusive"). Put the extent inside the filter: `BBOX(geometry,…,'EPSG:4326')
  AND area > 100`.
- **CWFIS geometry comes back projected by default** (coordinates like
  `[205526, 287024]`). Pass `srsName=EPSG:4326` for lon/lat — or use the `lat`
  and `lon` properties it helpfully includes anyway.
- **Leaflet measures the map container before the flex layout settles,** so it
  caches a zero size and draws a single tile. A `ResizeObserver` fixes it — but
  don't latch a "done" flag on its first callback either: the pane settles over
  several callbacks, and fitting against a half-laid-out one strands the view
  zoomed out. Re-fit until the user actually interacts.
- **`getBoundsZoom` snaps *down* to integer zoom** unless `zoomSnap: 0`, which
  can leave a fitted overlay far smaller than its pane (measured: 342px of image
  in a 601px pane) with its edges on screen.
- **Leaflet's default wheel zoom covers a whole level in one notch.**
  `wheelPxPerZoomLevel` (default 60) is scroll-pixels per zoom level; the wheel
  step runs through a sigmoid, so it isn't linear in that number. Per notch
  (`deltaY` 100): 60 → 1.08 levels, 120 → 0.57, **180 → 0.39**, 240 → 0.29. Needs
  `zoomSnap: 0` to land on fractions at all, otherwise it rounds straight back up
  to a full level.
- **`getBoundsZoom(bounds, true)` is "cover", not "fit".** Fitting puts the
  overlay's edges exactly at the viewport edge on the limiting axis and *inside*
  it on the other — visible edges. `inside: true` is what guarantees none.
- **`circleMarker` balloons and snaps back on every zoom.** Its radius is in
  pixels, but the zoom animation CSS-scales the renderer and only redraws paths at
  the end, so circles jump to 2x mid-zoom then pop back (measured: 56 → 112 →
  56px). No pixel radius can avoid this: tracking that transform requires a
  *geographic* radius.

  Two dead ends before the fix. `leaflet-zoom-hide` (what Leaflet does for
  `L.marker`, which is why the fire icons never had this) kills the balloon but
  makes the circles vanish mid-zoom. Plain `L.circle` tracks the zoom perfectly
  but is then enormous at city zoom — metres don't care about readability.

  What works is `L.circle` **plus** `settleRadii()`: the circle rides the zoom
  glued to the map, then eases to its intended screen size over 260ms once the
  zoom lands. Measured zooming in: 60 → 120 → settles at 74, visible throughout.
  Set the radius outright (not eased) in `render()`, though — that runs every
  frame during playback and a tween there fights the animation.
- **Never mutate a path mid-zoom-animation.** `Circle.setRadius()` reprojects
  against `map.getZoom()`, which Leaflet sets to the *target* the instant a zoom
  starts — while the renderer's container is still CSS-transformed for the old
  zoom. The path lands in the wrong coordinate space until zoomend resets the
  renderer, so it visibly flickers to a wrong spot and back. Scrolling fires zooms
  faster than the 260ms settle, so the two overlap constantly; `settleRadii` is
  cancelled on `zoomstart` for exactly this reason.
- **`L.Circle` draws its centre at the Mercator midpoint of its north/south
  extremes**, not at its own latlng — so the drawn centre shifts slightly as the
  radius changes. Real, but small at these sizes: measured 0.08–1.29px across the
  city circles, worst when zoomed out. Not worth compensating for; worth knowing
  before blaming it for a wobble.
- **Leaflet anchors a `Path` popup at the clicked point, not the shape's centre**
  (`CircleMarker` extends `Path`). Because the radius is in *pixels*, a click on
  the edge is a fixed *geographic* offset — invisible at low zoom, but doubling
  every zoom level (77px at z8 → 2476px at z13). The `popupopen` handler
  re-anchors to `getLatLng()`.

## If this goes public

**There's no quota to run out.** GeoMet needs no API key and publishes no rate
limits — access is "anonymous and free of charge". And because the app is pure
client-side, every request comes from the *visitor's* browser and IP, not from a
server of ours, so there's no account to exhaust. A burst test of 30 concurrent
`GetMap` requests returned 30 × HTTP 200 in 2 seconds with no throttling.

**But each visitor is expensive.** Measured:

| | Requests | Bytes |
| --- | --- | --- |
| Animation frames (73 × ~137 KB) | 73 | ~10 MB |
| Grids (24 × 164 KB) | 24 | ~3.9 MB |
| **Page load** | **~97** | **~14 MB** |
| Playing the full loop (+49 grids) | +49 | **~22 MB** |

`bufferLoop()` is eager on purpose — it's what makes playback instant — but it
means a visitor who never presses play still pulls all 73 frames. If per-visitor
weight ever matters, buffering on the play click instead drops a casual visit to
~4 MB. That's a deliberate trade, not an oversight.

**The licensing risk is the basemap, not the weather data.** CARTO's terms say
their basemaps are free for non-commercial use *by CARTO grantees*, with roughly
a 75k mapviews/month free tier and Enterprise licensing for commercial use — 
ambiguous for a public site, and the only component here with real contractual
terms. The federal weather data is more clearly free to use than the map under
it. Swap for a basemap with unambiguous terms (OpenFreeMap, Protomaps, Stadia)
before this is anything but a personal project, and keep the CARTO credit visible
while it is one.

**Scaling, if it ever needs it:** every visitor requests the *same* 73 frames, so
a cache in front (e.g. Cloudflare over a thin proxy) collapses any number of
visitors into ~73 upstream requests per hour — a ~100x reduction in load on a
free public service. That costs the no-backend design, which is the whole reason
this thing is three static files, so it's only worth it under real traffic.

## Caveats worth keeping

This is a **risk analogy, not chemistry**. Berkeley Earth are explicit that it's
a rough rule of thumb:

- Wildfire smoke and tobacco smoke are not the same substance, and the
  comparison is about long-term mortality risk — not acute effects.
- Particulates from coal, diesel, and industry may be *more* toxic than tobacco
  particles, so the comparison can understate pollution's harm.
- Unlike smoking, pollution reaches every age group, including people who would
  never choose the exposure.

The data is now good to a few percent, but that precision is far finer than the
rule of thumb it feeds. Don't read the decimal point as meaningful, and don't use
this to make medical decisions.

## Ideas for later

- NASA FIRMS active-fire hotspots as a third layer (free, needs a `MAP_KEY`).
- Geolocate the user and show their own number.
- Cache grids in IndexedDB so a revisit doesn't refetch the window.
- Preload adjacent frames so the animation doesn't hitch on first play.
