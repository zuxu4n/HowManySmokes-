# How Many Smokes?

Live map of wildfire smoke over Ontario. If you stood outside all day, how many
cigarettes would you have breathed?

Built during the July 2026 northwestern Ontario fires, when smoke pushed south and
Toronto briefly ranked worst in the world for air quality.

## Run

```sh
python devserver.py 5177   # http://localhost:5177
```

Must be HTTP, since `file://` is blocked by CORS. `devserver.py` is the stdlib
server plus `Cache-Control: no-store`, without which browsers serve a stale
`app.js` for minutes after an edit.

## Data

No API keys, no backend. Every source is keyless and sends
`Access-Control-Allow-Origin: *`.

| | Source | Service |
| --- | --- | --- |
| Plume (ground / column) | ECCC `RAQDPS.Sfc_` / `EAtm_PM2.5-WildfireSmokePlume` | WMS |
| Numbers, past hours | ECCC `RDAQA-FW_10km_PM2.5`, analysis with observations assimilated | WCS |
| Numbers, future hours | ECCC `RAQDPS.SFC_PM2.5`, forecast | WCS |
| Fires | CWFIS `public:m3_polygons_current` | WFS |

All 10 km. `RDAQA`'s time range ends at "now". That's how the app knows where
measurement stops and forecast begins, and why the UI says "19h measured + 5h
forecast" rather than picking one.

Rejected: **CAMS/Open-Meteo** (~45 km, read 3–4× low: Toronto showed 1.8
cigarettes when the truth was ~5.8), **NASA FIRMS** (API key = a shared, publicly
visible quota), **OpenAQ** (CORS-blocked), **Google** (no smoke forecast),
**firesmoke.ca** (no tile service).

## Method

[Berkeley Earth](https://berkeleyearth.org/air-pollution-and-cigarette-equivalence/):
22 µg/m³ of PM2.5 for 24h ≈ one cigarette. It's linear, so integrate hourly rather
than averaging:

```
cigarettes = Σ(hourly PM2.5 over the window) / (22 × 24)
```

The window is the N hours ending at the selected frame, so scrubbing moves the
plume and the counts together.

## Caveats

A **risk analogy, not chemistry**. Wildfire and tobacco smoke aren't the same
substance, and the comparison is long-term mortality risk, not acute effects.
The data is good to a few percent, far finer than the rule of thumb it feeds, so
the decimal point isn't meaningful. Not medical advice.

## Tuning

- `MERGE_STAGES`: fire clustering. `aboveFloor` = *when* a merge fires (measured
  from `minZoom`, so it adapts to window size), `km` = *how hard*. Currently two
  merges; the last band runs to the floor, so it never collapses to one orb.
- `wheelPxPerZoomLevel: 180`: scroll step (~0.39 zoom/notch vs Leaflet's default
  1.08). **`MERGE_STAGES[1].aboveFloor` is tuned against this** so the first split
  lands on the 4th notch. Change one, recheck the other.
- `SMOKE_OPACITY`, `FIRE_FLY_MS`, `SETTLE_MS`: plume opacity, fire flight, circle
  settle.

## Gotchas

**GeoMet**
- Rejects `toISOString()`. Wants `%Y-%m-%dT%H:%M:%SZ`, errors on the ms.
- WCS wants `time=`, not the spec-shaped `subset=time(...)`.
- Values are kg/m³, not µg/m³. Multiply by 1e9.
- Layers are `RAQDPS.*`; `RAQDPS-FW.*` are climatology products.
- Avoid `_Dis` styles: they paint every cell and flood the map.
- WMS 1.3.0 + `EPSG:4326` is lat,lon order.
- Render cost is flat in image size (256² ≈ 431ms, 1024×768 ≈ 371ms), so one
  `imageOverlay` beats 20 tiles per frame, and makes preloading the loop viable.

**GeoServer / CWFIS**
- `bbox` and `CQL_FILTER` are mutually exclusive. Put the extent in the filter.
- Geometry comes back projected; pass `srsName=EPSG:4326`.

**Leaflet**
- It measures the map container before flex layout settles → `ResizeObserver`. Don't
  latch on the first callback; re-fit until the user interacts.
- `zoomSnap: 0` for fractional zoom; `getBoundsZoom` otherwise snaps *down*.
- `getBoundsZoom(bounds, true)` is "cover", not "fit". Fitting leaves edges visible.
- `circleMarker` balloons 2× and snaps back on zoom (pixel radius vs CSS-scaled
  renderer). Fix is `L.circle` + `settleRadii()`: geographic radius rides the zoom,
  then eases to size.
- Never mutate a path mid-zoom. `setRadius()` reprojects against the target zoom
  while the container is still transformed for the old one. Hence cancelling the
  settle on `zoomstart`.
- `Path` popups anchor at the *clicked* point, not the centre → re-anchor on
  `popupopen`.
- Animate opacity only on a marker's root; its transform is Leaflet's.

## If it goes public

Nothing to run out: no keys, and every request comes from the visitor's own
browser and IP. But it's **~14 MB per visitor** (~22 MB if they play the loop),
since `bufferLoop()` eagerly preloads all 73 frames to make playback instant.

The real risk is the **CARTO basemap**, the only component with actual licensing
terms (free for "grantees", non-commercial, ~75k mapviews/month). The federal
weather data is more clearly free than the map under it. Swap it before this is
more than a personal project.

Every visitor fetches the same 73 frames, so a cache in front would cut upstream
load ~100×, at the cost of the no-backend design.

## Later

- Geolocate the user, show their own number.
- Cache grids in IndexedDB.
