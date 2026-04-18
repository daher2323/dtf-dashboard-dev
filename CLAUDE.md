# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Single-file static web app. The entire dashboard — HTML, CSS, and JavaScript — lives in `index.html` (~4700 lines). No build step, no package manager, no tests, no framework. External dependencies are loaded from CDNs at runtime: Chart.js (charts) and SheetJS/xlsx (Excel export).

To run locally, open `index.html` in a browser or serve the directory with any static server (e.g. `python3 -m http.server`). There is nothing to compile, lint, or test.

## Data flow

All data is fetched at runtime from **published Google Sheets CSVs** — URLs live in two maps at the top of the `<script>` block (`CSV_BY_YEAR`, plus `CSV_TARGETS` / `CSV_WEEKLY_TARGETS` / `CSV_MATERIALS`). There is no backend.

### Adding a new year (annual rollover)

Production CSVs and annual unit targets are keyed by year in `CSV_BY_YEAR` and `YEAR_TARGETS`. `CURRENT_YEAR` / `PRIOR_YEAR` are derived at page load from `new Date().getFullYear()`, passed through `resolveConfiguredYear()`.

To add a new year, append one entry to each map:

```js
var CSV_BY_YEAR = {
  2025: '...',
  2026: '...',
  2027: '<published-CSV URL for the 2027 sheet tab>',
};
var YEAR_TARGETS = {
  2025: 3300000,
  2026: 3927000,
  2027: /* TBD — fill in the actual 2027 annual unit target */ 0,
};
```

Until a real target is filled in, leave the entry at `0` (or omit it entirely to trigger the fallback + console.warn). Do not invent a placeholder number — downstream percentages would be misleading.

On Jan 1 of the new year, `CURRENT_YEAR` flips automatically. No other code changes are needed — per-year target pickers read from `YEAR_TARGETS[year]`, and comparison labels are derived from the map.

**Graceful fallback:** if `CSV_BY_YEAR[CURRENT_YEAR]` is missing (new year started and nobody updated the code yet), `resolveConfiguredYear` falls back to the most recent configured year and logs a loud `console.warn`. The dashboard keeps working against last year's data rather than breaking — update the maps whenever you can.

**Historical anchors** (not year-dynamic): `TRACKING_START` (Jan 1, 2025, start of customer/SKU history) and `MATERIALS_TRACKING_START` (Oct 1, 2025, first reliable materials data). These are fixed by when tracking began and should not move. When cloning for iteration (`setMonth` loops), always `new Date(TRACKING_START)` to avoid mutating the global.

Load sequence (`loadDashboard` → `fetchData`):
1. `fetchWithRetry` pulls 2026 and 2025 production CSVs with retry+backoff and rejects responses that look like HTML error pages or are suspiciously short.
2. `parseCSV` → `isValid` filters rows (date parsable, year in 2020–2035, no `#ERROR`/`#REF` sentinels, required Date/Lot/Product fields).
3. `buildLotMap` aggregates rows by `Lot Number` into lot objects (summing `Final Units`, carrying line/status/start time).
4. `parseTargets` / `parseWeeklyTargets` build daily and weekly target maps.
5. `buildProductionDays` builds the ordered list of production day keys used by the date navigator.
6. Materials CSV is fetched in the background (`fetchMaterialsIfNeeded`) and does not block initial render.

**Stale-data guard:** `applyFreshData` and the initial load both refuse datasets that shrink unexpectedly (fewer rows than the current in-memory set, or fewer than ~80% of the previous count on first load). The Google Sheets CDN occasionally serves stale/empty CSVs — do not weaken these guards without a replacement.

**Refresh cadence** (`startRefreshTimers`):
- 60 s while on Daily view (`subView === 'today'`).
- 5 min while on Performance/Detail views.
- On `visibilitychange` (tab becoming visible) if > 45 s since last refresh.
- `checkDateRollover` snaps `selectedDayIdx` to the new latest day when the calendar day changes.

## Auth model

Client-side only. `CORRECT_PW` (viewer) and `ADMIN_PW` (admin) are SHA-256 hashes stored in the script. `checkPw` hashes the input via `crypto.subtle.digest` and compares. Session persists in `sessionStorage` (`dtf_auth`, `dtf_role`). This is obfuscation, not real security — the CSVs are public and the hashes are visible in source. Do not add features that assume this gates anything sensitive.

`applyRole` hides the Customers and Procurement tabs for viewers and redirects them to Production if they land on a restricted section.

## UI architecture

State is held in module-level `var`s at the top of `<script>` (`mainSection`, `topView`, `subView`, `filterState`, `selectedCustomer`, `selectedDayIdx`, `selectedWeekMon`, `selectedDetailRange`, `selectedPerfRange`, `procView`, `sortCol`/`sortDir`/`page`, etc.). Any navigation action mutates these and calls `render()`.

`render()` is the single dispatcher — it reads `mainSection` + `topView` + `subView` + `procView` and calls one of the section renderers:

| Section                  | Entry point              |
| ------------------------ | ------------------------ |
| Production → Daily       | `renderToday`            |
| Production → Weekly      | `renderWeekly`           |
| Production → Trend       | `renderPerformance`      |
| Production → Detail      | `renderDetail` + `updateOpsTable` |
| Customers overview       | `renderCustomers` → `renderCustomerOverview` / `computeCustomerData` |
| Procurement              | `renderProcurement` / `renderMaterials` |

Renderers build HTML strings and assign to `#content.innerHTML`, then instantiate Chart.js charts into canvases they just wrote (tracked in the `charts` map so they can be destroyed on re-render). `renderSubBar` rebuilds the sticky secondary nav for the current `mainSection`.

**`render()` is a thin wrapper** around `renderImpl()`. The wrapper captures `window.scrollY`, the focused element's id, and its text-input selection before calling `renderImpl()`, then restores them inside a double `requestAnimationFrame` so Chart.js has time to finish layout. Navigation functions (`navDay`, `navToToday`, `goLive`, `pickDay`) should just call `render()` — they do **not** need to capture or restore scroll themselves.

If you *do* want to override scroll (e.g. reset-to-top), assign to the module-level `_nextRenderScrollY` before triggering render. `resetDashboard` is the only existing user of this hook.

Pop-ups (multi-select filter panels, date/week pickers, export popovers, role menu) are rendered into `document.body` with fixed positioning and managed by paired `open*`/`close*` functions that attach a capture-phase outside-click listener. When adding a new popup, follow the same pattern — existing ones call `closeMsPanel()` defensively on most nav actions to avoid orphaned panels.

## Domain concepts

- **Three production lines**: `Line #1` (Powder), `Line #2` (Capsules), `Line #4` (Powder). Colors/backgrounds/text colors per line are in `LINE_COLOR`, `LINE_TRACK`, `LINE_BG`, `LINE_TXT`, `LINE_TYPE`. `ALL_LINES` is the canonical list — no Line #3.
- **Annual/weekly targets**: `YEAR_TARGET` (2026) and `YEAR_TARGET_2025` drive gauges; `WEEKLY_TARGET` is derived. `TARGET_HIT_THRESHOLD = 0.99` is the "hit" tolerance.
- **Lot deviation** (`lotDev`): `(finalUnits − projected) / projected × 100`. Returns `null` for partials or lots with no projection — callers must null-check.
- **SKU grouping** (`SKU_GROUPS`): several part numbers roll up under one display name (e.g. multiple `20-xxxx` SKUs all map to "Whey Protein Concentrate (WPC)"). Used by the Procurement/Materials views.
- **Product field convention**: the `Product` string is `"<Customer> - <Product Name>"`. Customer is extracted as `product.split('-')[0].trim()` throughout the code.
- **Jar size normalization** (`jarSizeKey`): fuzzy-parses strings like "1 gal", "32 oz", "500ml" to a canonical key.
- **Week number** (`getWeekNum`) uses ISO-ish Monday-anchored weeks; `dateKey` is the `M/D/YYYY` string used as a map key everywhere.

## Conventions to preserve when editing

- Stick to **ES5-compatible JS** (`var`, `function` declarations, no arrow functions in existing code, no modules). The file targets broad browser support and has no transpile step.
- Everything is **one file**. Do not split into separate JS/CSS files without a strong reason — the deploy model (open the HTML, or host statically) depends on it.
- Currency/number formatting uses `toLocaleString()`; dates use `toLocaleDateString('en-US', ...)`. Keep formats consistent with neighboring code.
- Colors and spacing are hand-tuned dark-theme values in the `<style>` block. Reuse existing CSS variables-by-convention (`#141618` bg, `#1e2124` card, `#378ADD` primary blue, `#85B7EB` highlight, status greens/reds in badges) rather than introducing new ones.
- When adding a new renderer or view, remember to: (1) destroy any prior Chart.js instances stored in `charts`, (2) call `closeMsPanel()` and close other popovers on navigation, (3) wire into `renderSubBar` and `renderImpl()` dispatch (not `render()` — that's the wrapper).
- **Escape CSV-derived values** before interpolating into `innerHTML`. Use the `esc()` helper for text content and attribute values; use `jsStr()` to embed a value inside a JS string literal within an HTML attribute (e.g. `onclick="foo(" + jsStr(name) + ")"`). Sheet data is trusted but not sanitized — a stray `<`, `&`, or `"` in a product/customer/material name will break layout or attributes if dropped in raw. Existing hot-spot sites (ops table, lot cards, customer/material headers, filter dropdown, synopses) already use `esc()`; follow that pattern for any new interpolation.
