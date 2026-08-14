# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Single-file static web app. The entire dashboard — HTML, CSS, and JavaScript — lives in `index.html` (~4700 lines). No build step, no package manager, no tests, no framework. External dependencies are loaded from CDNs at runtime: Chart.js (charts) and SheetJS/xlsx (Excel export).

To run locally, open `index.html` in a browser or serve the directory with any static server (e.g. `python3 -m http.server`). There is nothing to compile, lint, or test.

## Data flow

All data is fetched at runtime from **published Google Sheets CSVs** — URLs live in two maps at the top of the `<script>` block (`CSV_BY_YEAR`, plus `CSV_TARGETS` / `CSV_WEEKLY_TARGETS` / `CSV_MATERIALS` / `CSV_OPEN_ORDERS_*` / `CSV_LOGISTICS`). There is no backend.

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

`applyRole` hides the Sales, Procurement, Logistics, and Quality tabs for viewers and redirects them to Production if they land on a restricted section.

## UI architecture

State is held in module-level `var`s at the top of `<script>` (`mainSection`, `topView`, `subView`, `filterState`, `selectedCustomer`, `selectedDayIdx`, `selectedWeekMon`, `selectedDetailRange`, `selectedPerfRange`, `procView`, `sortCol`/`sortDir`/`page`, etc.). Any navigation action mutates these and calls `render()`.

`render()` is the single dispatcher — it reads `mainSection` + `topView` + `subView` + `procView` and calls one of the section renderers:

| Section                  | Entry point              |
| ------------------------ | ------------------------ |
| Production → Daily       | `renderToday`            |
| Production → Weekly      | `renderWeekly`           |
| Production → Trend       | `renderPerformance`      |
| Production → Detail      | `renderDetail` + `updateOpsTable` |
| Sales → Open Orders      | `renderOrders` (`ordersView`: `summary` / `labels` / `planning`) |
| Sales → Customers        | `renderCustomers` → `renderCustomerOverview` / `computeCustomerData` |
| Procurement              | `renderProcurement` / `renderMaterials` |
| Logistics (throughput)   | `renderLogistics` → `_logiNavHTML` + `_logiTilesHTML` + `_logiTrendHTML` + `_logiLogHTML` (`logiGran`, `logiAnchor`, `logiTrendGran`, `logiTrendMetric`) |
| Quality → Recall / Blend | `renderQuality` (`qualitySubTab`: `recall` / `blend`) |

**The "Sales" top tab is a virtual umbrella, not a stored value.** `mainSection` only ever holds `'orders'` or `'customers'` — the two halves of Sales — so all the logic keyed on those strings (dispatch, refresh timers, the customer concentration bar, viewer redirects) is unchanged. `setMainSection('sales')` resolves to `'orders'` (landing on Open Orders → Summary) unless you're already inside Sales, in which case it keeps the current half. The Sales tab lights up when `mainSection` is either value, and `renderSubBar` prepends a shared `[ Open Orders | Customers ]` toggle (`salesToggle`) to both halves' secondary controls — mirroring the Production sub-bar's toggle-plus-divider pattern.

**Per-customer Open Orders export** (`exportOpenOrdersForCustomer`, reached from the download icon on each Customer Breakdown row, the labelled button inside that row's drilldown, and each Labels-tab brand header via `_ooExportBtn`). Unlike the other exports, this one deliberately does **not** mirror the screen: it rebuilds the brand's full open book from `openOrdersPowder`/`openOrdersCapsule` (`_ooBrandRows`) so an All/Powder/Capsule or Top 10/25 toggle can't silently drop half a customer's orders from a report that goes out to that customer. Consequence to keep in mind: its unit total **exceeds** the Customer Breakdown's figure, because the breakdown counts production units only (`isSamplePackOrBulk` rows excluded — that classifier needs `Order Amount` of exactly 1, or `Bottles/Jars` = `N/A` **plus** a stick/sample/bulk signal in the product name, since `N/A` alone only means "not a bottle or jar" and was demoting gusset-bag production orders to bulk) — the sheet's header line states the basis so the gap doesn't read as a bug. `Labels on Hand` / `Labels Short` come from the sheet's `Labels` column (a count in house) and are filled **only** for `Not Enough Labels` rows, since a bare `0` beside a Scheduled order reads as a problem that isn't one; `_ooLabelsOnHand` only does arithmetic when the cell is numeric, so a text note (`"Unlabeled"`) never becomes a fake shortfall. The second sheet (`Labels Needed`) is omitted entirely when nothing is blocked. Columns are customer-facing and ordered `Invoice / Estimate # · PO # · Product · Order Amount · Weeks on Books · Planning Status · Labels on Hand · Labels Short`; **`Promise Date / Notes` and `Label Status Update` are deliberately excluded** — they're internal hand-written scratch notes and must not go out to a customer. Don't add them back.

Renderers build HTML strings and assign to `#content.innerHTML`, then instantiate Chart.js charts into canvases they just wrote (tracked in the `charts` map so they can be destroyed on re-render). `renderSubBar` rebuilds the sticky secondary nav for the current `mainSection`.

**`render()` is a thin wrapper** around `renderImpl()`. The wrapper captures `window.scrollY`, the focused element's id, and its text-input selection before calling `renderImpl()`, then restores them inside a double `requestAnimationFrame` so Chart.js has time to finish layout. Navigation functions (`navDay`, `navToToday`, `goLive`, `pickDay`) should just call `render()` — they do **not** need to capture or restore scroll themselves.

If you *do* want to override scroll (e.g. reset-to-top), assign to the module-level `_nextRenderScrollY` before triggering render. `resetDashboard` is the only existing user of this hook.

**Quality has two pick-sheet lookups, inverse of each other, both built on `pickRows`.** **Recall Tracking** (`renderRecall`, `qualitySubTab='recall'`) takes a material lot **T#** → every production lot that consumed it (`traceTNumber`/`buildRecallResult`). **Blend Lookup** (`renderBlend`, `qualitySubTab='blend'`) takes a production **Lot #** → every component it consumed — part #, ingredient, material lot T# (`traceLotComponents`/`buildBlendResult`), for QA to trace a blend's inputs without the batch record. Both share the input/summary-card layout (blend is blue, recall amber) and re-run a pending query when the pick sheet finishes loading (`fetchMaterialsIfNeeded` re-renders on any Quality sub-tab). Part #s / T#s are click-to-copy (`_blendCopyCell` → shared `_logiCopy`).

**Recall → Detail cross-contamination jump.** A Run Date in the Recall table (`renderRecallTableHTML`) renders as a link when its day exists in `productionDays`; `recallJumpToRun(lot, runTs)` switches to Production → Detail → Daily for that day, presets the **Line filter** to the lot's line, sorts chronologically (`sortCol='time'`, ascending), and highlights the lot via `_recallJumpHighlight` (cleared on day-nav / `clearFilters`). Supporting pieces: the Detail ops table has a **Start time** column (`l.startTime`, sortable via the `'time'` key → `lotSortKey`), and `filterState.line` is now a full multi-select filter — `getFilteredLots` matches `canonicalLine(l.line)`, options come from `_msOptions.line` (canonical lines present in scope), and it's wired through `buildMultiSelect`/`rebuildMsTrigger`/`clearFilters` like the other filters.

Pop-ups (multi-select filter panels, date/week pickers, export popovers, role menu) are rendered into `document.body` with fixed positioning and managed by paired `open*`/`close*` functions that attach a capture-phase outside-click listener. When adding a new popup, follow the same pattern — existing ones call `closeMsPanel()` defensively on most nav actions to avoid orphaned panels.

## Domain concepts

- **Three production lines**: `Line #1` (Powder), `Line #2` (Capsules), `Line #4` (Powder). Colors/backgrounds/text colors per line are in `LINE_COLOR`, `LINE_TRACK`, `LINE_BG`, `LINE_TXT`, `LINE_TYPE`. `ALL_LINES` is the canonical list — no Line #3.
- **Annual/weekly targets**: `YEAR_TARGET` (2026) and `YEAR_TARGET_2025` drive gauges; `WEEKLY_TARGET` is derived. `TARGET_HIT_THRESHOLD = 0.99` is the "hit" tolerance.
- **Lot deviation** (`lotDev`): `(finalUnits − projected) / projected × 100`. Returns `null` for any lot not marked Complete (in-progress, partial, or blank status) or with no projection — deviation is only meaningful once a lot has produced its full run, so callers must null-check.
- **SKU grouping** (`SKU_GROUPS`): several part numbers roll up under one display name (e.g. multiple `20-xxxx` SKUs all map to "Whey Protein Concentrate (WPC)"). Used by the Procurement/Materials views. `GROUP_PARTS` is the inverse map.
  - **A grouped row has two different part lists, and mixing them up is the standing trap here.** `m.partNums` is only the parts *consumed inside the selected `matWindow`*; `m.stockParts` is the **full group roster** (`partNums` ∪ `GROUP_PARTS[name]`). Every stock figure — On hand, Committed, Available, and the export — is computed over the roster, so anything user-facing that enumerates or searches part #s must use `stockParts`, not `partNums`. Using `partNums` for display made a 6-part group render as "3 parts" while its kg spanned all 6, which reads as missing data.
  - Parts in the group with no consumption in the window are **dormant**: `m.dormantParts`, backfilled into `m.partBreakdown` with `noUsage:true` so the expanded breakdown's On hand / Committed columns sum to the group row. Dormant rows render dimmed with `—` in usage cells (never `0` — that would imply "consumed at zero rate"), and their `lotCount` is 0 because that column counts *usage* lots, not inventory lots. The row badge reads `N of M active` when any part is dormant, plain `M parts` otherwise.
  - A part in `SKU_GROUPS` with no row in the inventory sheet contributes 0 and shows `not in inventory` — that's genuine data state (retired/never-stocked part #), not a failed join. `stockForParts` returns `null` only when *no* part in the list has a record, so "not tracked" (`—`) stays distinguishable from a real 0 on hand.
- **Product field convention**: the `Product` string is `"<Customer> - <Product Name>"`. Customer is extracted as `product.split('-')[0].trim()` throughout the code.
- **Jar size normalization** (`jarSizeKey`): fuzzy-parses strings like "1 gal", "32 oz", "500ml" to a canonical key.
- **Week number** (`getWeekNum`) uses ISO-ish Monday-anchored weeks; `dateKey` is the `M/D/YYYY` string used as a map key everywhere.
- **Logistics sheet** (`CSV_LOGISTICS`, `parseLogistics`): a freight-cost ledger, one row per line item shipped. Parsed **positionally** (`LOGI_COL` index map via `parseCSVGrid`) because row 0 is stray junk and the real header is row 1. Two quirks the parser handles and must keep handling: (1) the `Date` column is sparse and **forward-fills** — a blank date inherits the most recent date above it; (2) the sheet trails ~800 empty rows that still compute `Total Cost = $0.00`, so a row counts only if it has a `Product Name` or `Lot #`. Out-of-range years (2020–2035 guard) are treated as blank so a typo'd date forward-fills instead of creating a bogus bucket. `Product Name` follows the same `"Customer - Product"` convention. Also carries `boxesRaw` (the un-parsed Boxes cell) so a blank Boxes reads as "not recorded" rather than 0. The fetch uses `fetchCSVSimple` with a bounded retry (`_logiFetchAttempt`), NOT `fetchWithRetry` — the latter rejects any CSV whose first line lacks "date"/"lot", which this junk-row-0 sheet always fails.
- **Logistics has two directions** (`logiDir`, toggled in the sub-bar): **Outbound** (`CSV_LOGISTICS`, `parseLogistics`, entity = Customer, line = Lot) and **Inbound** (`CSV_LOGISTICS_INBOUND`, `parseInbound`, entity = Vendor, line = PO#). Both parse to the **same record shape**, so all grouping/tiles/trend/log code is shared and reads `_logiActiveData()`; only labels differ (`_logiLabels`) — e.g. the 4th tile is "Customer pickup" outbound vs "Vendors" (distinct suppliers) inbound. Inbound rows show a **status badge** (Received/In Transit/Pending Pickup/Canceled) and get an above-log **status filter** (`logiStatusFilter`: all / open = in-transit+pending / received); outbound instead shows the "boxes not recorded" note and, since it has a **Units** column (inbound doesn't), Units tiles (total + per-business-day + per-shipment), a Units trend metric, and per-shipment/per-product Units in the log — all gated by `showStatus`/`showBoxesNote`/`showUnits` in `_logiLabels`. (Units are blank pre-Feb 2026, so old-period unit totals under-count.) Two categories are **excluded from the primary `units`** so they don't inflate it, and shown separately in amber (tile subtext, day-header, shipment subline, tags on lot lines): **stick/sample packs** (`stickUnits`, identified only by a 6-digit lot # vs 7-digit standard, `_logiIsStick`) whose per-unit counts are huge, and **bulk-serving brands** (`servingUnits`, brands in `BULK_SERVING_BRANDS` like Twisted Dough whose Units column is really servings, `_logiIsBulkServing`). Tiles/rate/trend use standard `units` only. Bulk figures are inconsistently entered (small = a count of bulk runs, large = servings), so their label follows the value's magnitude via `_logiBulkNoun`/`BULK_RUN_THRESHOLD` (< 10 → "bulk run(s)", else "bulk serving(s)"). Both feeds publish from the same lightweight IMPORTRANGE sheet (shared 2PACX token, different gids).
- **Logistics is a throughput view** (no financials — cost columns are parsed but unreferenced). One view with a `Daily / Weekly / Monthly` granularity toggle (`logiGran`) and a Production-style period navigator (`_logiNavHTML` + `navLogi`/`goLogiLive` + `openLogiPicker`) driven by `logiAnchor` (a Date within the selected period; `null` = current). Past periods are viewable. The trend chart (`charts.logiTrend`) **follows** `logiGran` for its bucket size (daily/weekly/monthly) and shows the history ending at the selected period, which is the last, highlighted bucket — so the whole view speaks one time unit; only its metric (`logiTrendMetric`: shipments/lots/boxes/pallets) has an on-chart toggle, mutated in place. It carries a dashed-orange average line (`_logiTrendAvg`, mean of non-zero buckets). **Shipment identity is direction-dependent** (`groupLotsToShipments`): **outbound** groups by *date + customer* (one truck, many lots; the sheet records carrier/tracking on the first line and leaves the rest blank, so splitting on reference would fragment it), while **inbound** groups by *date + vendor + reference* — each receiving row is its own delivery with its own carrier, tracking/BOL, ETA and status, so two POs from one vendor on one day stay two shipments unless they share a *real* reference (`_logiRefIdentity`: ≥6 alphanumerics with a digit, tracking preferred over BOL — placeholders like `FTL` never merge rows; unidentifiable rows fall back to their own `_idx`). Lots roll up under the shipment, and carrier/reference/ETA are shipment-level (shown on a metadata subline, not per lot); a bucket's remaining distinct references are kept in `references` and surfaced as a `+N more references` hint so a grouped row never hides one. **The line metric (Lots shipped / POs received) counts ids, not rows** — one inbound cell often names several POs (`"8093, 8158"`), so `_logiLineIds` splits on `,`/`&`/`and` and `lineCount` sums them (min 1 per row, never de-duped: one outbound lot legitimately spans several parcel rows). All aggregation reads `_logiLineCount(s)`, which falls back to `lots.length` for shipments cached before `lineCount` existed. Per-business-day rates use `isBusinessDay`/`countBusinessDays` with `DTF_SHIP_DAYS` + `DTF_HOLIDAYS` (empty for now → rates slightly understated); prior-period deltas compare **like-for-like on business days elapsed** (`priorPeriodBounds`). Lot numbers stay strings (`lotKey`, never `Number()`).

## Conventions to preserve when editing

- Stick to **ES5-compatible JS** (`var`, `function` declarations, no arrow functions in existing code, no modules). The file targets broad browser support and has no transpile step.
- Everything is **one file**. Do not split into separate JS/CSS files without a strong reason — the deploy model (open the HTML, or host statically) depends on it.
- Currency/number formatting uses `toLocaleString()`; dates use `toLocaleDateString('en-US', ...)`. Keep formats consistent with neighboring code.
- Colors and spacing are hand-tuned dark-theme values in the `<style>` block. Reuse existing CSS variables-by-convention (`#141618` bg, `#1e2124` card, `#378ADD` primary blue, `#85B7EB` highlight, status greens/reds in badges) rather than introducing new ones.
- When adding a new renderer or view, remember to: (1) destroy any prior Chart.js instances stored in `charts`, (2) call `closeMsPanel()` and close other popovers on navigation, (3) wire into `renderSubBar` and `renderImpl()` dispatch (not `render()` — that's the wrapper).
- **Escape CSV-derived values** before interpolating into `innerHTML`. Use the `esc()` helper for text content and attribute values; use `jsStr()` to embed a value inside a JS string literal within an HTML attribute (e.g. `onclick="foo(" + jsStr(name) + ")"`). Sheet data is trusted but not sanitized — a stray `<`, `&`, or `"` in a product/customer/material name will break layout or attributes if dropped in raw. Existing hot-spot sites (ops table, lot cards, customer/material headers, filter dropdown, synopses) already use `esc()`; follow that pattern for any new interpolation.
