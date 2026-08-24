// Materials pick sheet -> central dashboard sheet.
//
// The dashboard reads the DESTINATION sheet's published CSV, so nothing reaches Pick
// opportunities, Recall Tracking or Blend Lookup until this has run. That makes its latency the
// floor on the whole same-day correction loop: pull, spot the miss, re-log, watch it go green.
//
// Two paths, deliberately:
//   onMaterialsFormSubmit  installable trigger, one row, ~1s. This is the live path — a
//                          correction logged at 2pm is on the dashboard within its next 5-minute
//                          poll rather than at the top of the next quarter hour.
//   syncMaterials          time-based sweep, every 15-30 min. A safety net for rows the submit
//                          trigger missed (it does not fire on edits, imports, or while the
//                          quota is exhausted), NOT the primary path.
//
// Why the sweep used to fail with "Exceeded maximum execution time": it read the ENTIRE source
// sheet with getDataRange().getValues() on every run, so the cost grew with the log rather than
// with the day's new rows, and every append happened in a single call at the very end. A run
// killed at 6 minutes therefore synced NOTHING — no partial progress, the whole run wasted.
// Raising the trigger frequency would have made that worse, not better: overlapping runs hit the
// lock and no-op, and 6 minutes every 15 already burns ~576 min/day against a 360 min/day quota.
//
// So the sweep now: reads only rows after a stored pointer, appends in chunks, saves the pointer
// after each chunk, and stops itself at 4.5 minutes. It can no longer time out, and an
// interrupted run resumes where it left off instead of starting over.

var DEST_SHEET_ID = '1PouHBkH48hJ6XT8mIQ2djixJ8rxBqtdohVJupy3Hp9Q';
var SOURCE_SHEET_NAME = 'Materials';
var KEY_HEADERS = ['Order Lot #', 'Part #'];

// ── The dedupe key, and why it is not just lot + part ─────────────────────
// It used to be exactly ['Order Lot #', 'Part #'], which meant a row whose lot+part already
// existed in the destination was dropped as a duplicate. That is fine while every pick is a
// single submission, and silently fatal the moment one is not:
//
//   * A CORRECTION is by definition a second entry for the SAME production lot and part — that
//     pairing is what byLotPart keys on in the dashboard. Under the old key the re-log would
//     never have left this script, the row would never have gone green, and it would have looked
//     like the operator did not do it.
//   * A run drawing the same material on two slips (a second draw, a top-up) lost the second one
//     the same way.
//
// The Form timestamp makes each submission distinct while keeping the sync idempotent: re-running
// over rows already copied still appends nothing. Column 0 positionally, not by name, because
// Google Forms owns that header and renames it with the form's locale.
var PROP_LAST_ROW = 'materialsSync.lastSourceRow';  // last source row known to be synced
var MAX_RUNTIME_MS = 4.5 * 60 * 1000;               // hard ceiling is 6 min; stop well short
var APPEND_CHUNK = 2000;                            // rows per write, so progress survives a stop

function _msProps() { return PropertiesService.getScriptProperties(); }
function _msGetPointer() {
  var v = parseInt(_msProps().getProperty(PROP_LAST_ROW), 10);
  return isNaN(v) || v < 1 ? 0 : v;
}
function _msSetPointer(row) { _msProps().setProperty(PROP_LAST_ROW, String(row)); }

function _msStamp(v) {
  // Dates arrive as Date objects from getValues(); normalise so source and destination agree.
  return (v instanceof Date) ? String(v.getTime()) : String(v || '').trim();
}
function _msKeyOf(row, keyIdx) {
  var parts = [_msStamp(row[0])], i;
  for (i = 0; i < keyIdx.length; i++) parts.push(String(row[keyIdx[i]] || '').trim());
  return parts.join('||');
}
// A row with no lot AND no part is a spacer, whatever its timestamp says.
function _msIsBlankKey(row, keyIdx) {
  for (var i = 0; i < keyIdx.length; i++) if (String(row[keyIdx[i]] || '').trim()) return false;
  return true;
}

// Header positions in the source, and the guarantee that the two key columns exist.
function _msKeyIdx(headers) {
  return KEY_HEADERS.map(function(h) {
    var i = headers.indexOf(h);
    if (i === -1) throw new Error('Missing expected header in source: "' + h + '"');
    return i;
  });
}

// ── The live path ─────────────────────────────────────────────────────────
// Installable trigger: Edit > Current project's triggers > Add trigger >
//   function: onMaterialsFormSubmit, event source: From spreadsheet, type: On form submit.
// Wrapped so a failure here can never block the form submission itself; the sweep will pick the
// row up regardless, which is the entire reason the sweep still exists.
function onMaterialsFormSubmit(e) {
  try {
    if (!e || !e.range) return;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return;          // sweep is mid-write; let it carry the row
    try {
      var source = e.range.getSheet();
      if (source.getName() !== SOURCE_SHEET_NAME) return;
      var row = e.range.getRow();
      if (row < 2) return;
      var lastCol = source.getLastColumn();
      var headers = source.getRange(1, 1, 1, lastCol).getValues()[0];
      var values = source.getRange(row, 1, 1, lastCol).getValues();
      var keyIdx = _msKeyIdx(headers);
      if (_msIsBlankKey(values[0], keyIdx)) return;       // no lot and no part = nothing to sync

      var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];
      if (!_msHeadersMatch(dest, headers)) { _msSetPointer(0); return; }  // let the sweep rebuild
      dest.getRange(dest.getLastRow() + 1, 1, 1, headers.length).setValues(values);
      // Keep the pointer level with what has been written so the sweep does not re-append it.
      if (row > _msGetPointer()) _msSetPointer(row);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error('onMaterialsFormSubmit failed: ' + (err && err.stack || err));
  }
}

function _msHeadersMatch(dest, srcHeaders) {
  if (dest.getLastRow() < 1) return false;
  var destHeaders = dest.getRange(1, 1, 1, dest.getLastColumn()).getValues()[0];
  if (destHeaders.length !== srcHeaders.length) return false;
  for (var i = 0; i < srcHeaders.length; i++) if (destHeaders[i] !== srcHeaders[i]) return false;
  return true;
}

// ── The sweep ─────────────────────────────────────────────────────────────
function syncMaterials() {
  var started = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;            // another run holds it; next trigger will do
  try {
    var source = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SOURCE_SHEET_NAME);
    if (!source) { console.warn('Source sheet "' + SOURCE_SHEET_NAME + '" not found'); return; }
    var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];

    var srcLastRow = source.getLastRow(), srcLastCol = source.getLastColumn();
    if (srcLastRow < 2) return;
    var srcHeaders = source.getRange(1, 1, 1, srcLastCol).getValues()[0];
    var keyIdx = _msKeyIdx(srcHeaders);

    // Headers changed (a column added to the form) — the only case that justifies rewriting
    // everything, because every existing row is now shaped wrong.
    var rebuilt = false;
    if (!_msHeadersMatch(dest, srcHeaders)) {
      dest.clear();
      dest.getRange(1, 1, 1, srcHeaders.length).setValues([srcHeaders]);
      _msSetPointer(0);
      rebuilt = true;
    }

    var pointer = _msGetPointer();
    // A pointer past the end means the source shrank (rows deleted, or a different sheet):
    // start over rather than silently syncing nothing for ever.
    if (pointer > srcLastRow) { pointer = 0; }
    var startRow = Math.max(2, pointer + 1);
    if (startRow > srcLastRow) return;          // nothing new

    // Key set from the destination, so a stale pointer cannot double-append. Two column reads
    // rather than the whole sheet. Skipped right after a rebuild, when the sheet is empty.
    var seen = {};
    if (!rebuilt) {
      var destLastRow = dest.getLastRow();
      if (destLastRow > 1) {
        var destHeaders = dest.getRange(1, 1, 1, dest.getLastColumn()).getValues()[0];
        var d1 = destHeaders.indexOf(KEY_HEADERS[0]) + 1;
        var d2 = destHeaders.indexOf(KEY_HEADERS[1]) + 1;
        var ks = dest.getRange(2, 1, destLastRow - 1, 1).getValues();     // timestamp column
        var k1 = dest.getRange(2, d1, destLastRow - 1, 1).getValues();
        var k2 = dest.getRange(2, d2, destLastRow - 1, 1).getValues();
        for (var i = 0; i < k1.length; i++) {
          seen[_msStamp(ks[i][0]) + '||' + String(k1[i][0] || '').trim()
               + '||' + String(k2[i][0] || '').trim()] = true;
        }
      }
    }

    var totalAppended = 0, row = startRow, stoppedEarly = false;
    while (row <= srcLastRow) {
      if (Date.now() - started > MAX_RUNTIME_MS) { stoppedEarly = true; break; }
      var count = Math.min(APPEND_CHUNK, srcLastRow - row + 1);
      var block = source.getRange(row, 1, count, srcLastCol).getValues();
      var toAppend = [];
      for (var b = 0; b < block.length; b++) {
        if (_msIsBlankKey(block[b], keyIdx)) continue;    // spacer row, not a pick
        var k = _msKeyOf(block[b], keyIdx);
        if (seen[k]) continue;
        seen[k] = true;
        toAppend.push(block[b]);
      }
      if (toAppend.length) {
        dest.getRange(dest.getLastRow() + 1, 1, toAppend.length, srcHeaders.length).setValues(toAppend);
        totalAppended += toAppend.length;
      }
      row += count;
      // After the write, never before: the pointer must only ever claim rows that landed.
      _msSetPointer(row - 1);
    }

    if (totalAppended) console.log('Synced ' + totalAppended + ' new row(s); pointer at ' + (row - 1) + '.');
    if (stoppedEarly) {
      console.log('Stopped at the 4.5 min mark with ' + (srcLastRow - row + 1)
        + ' source row(s) still to read — the next trigger resumes from row ' + row + '.');
    }
  } catch (err) {
    console.error('syncMaterials failed: ' + (err && err.stack || err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function runSyncNow() { syncMaterials(); }

// One-off: forget the pointer and re-check every source row against the destination on the next
// sweep. Use after deleting rows from either sheet, or if the two ever look out of step. Safe —
// the key-set dedupe means a full re-check appends only what is genuinely missing.
function resetMaterialsSyncPointer() {
  _msProps().deleteProperty(PROP_LAST_ROW);
  console.log('Pointer cleared; the next syncMaterials run will re-check the whole source sheet.');
}

// ── Reconciliation: the mirror only ever grew ─────────────────────────────
// Both paths above APPEND. Neither ever looks at a row it has already copied, so the two
// sheets can only diverge, silently and permanently:
//
//   * A cell EDITED in the source after submission never reaches the destination. On 8/24/26 a
//     pick submitted at 8:20:04 carried production lot 2608118 — the lot that operator had been
//     picking an hour earlier — and was corrected in the source to 2608120 afterwards. The
//     destination still says 2608118, so the dashboard put an L-Leucine pull on a run that never
//     consumed it, and FEFO review flagged it there.
//   * A row DELETED from the source stays in the destination for ever, so a retracted pick keeps
//     being counted.
//
// Editing the source is not supposed to happen — a correction is meant to be a NEW form entry,
// which is why the dedupe key carries the timestamp. But a wrong PRODUCTION LOT cannot be fixed
// that way: byLotPart keys the supersede on lot + part, so a re-log under the right lot does not
// retract the entry filed under the wrong one. There is no in-form route, so people edit the
// sheet, and they will keep doing it. The mirror has to follow them.
//
// So: compare a trailing window of both sheets by full-row signature and repair the difference.
// An edited row appears as one stale destination row plus one missing source row, and is fixed
// by deleting the former and appending the latter. Order does not matter — the dashboard sorts
// pick rows by timestamp, never by sheet position.
//
// The window bounds the blast radius. Rows older than it are never touched, which matters
// because the destination carries a few hundred rows of pre-existing surplus from earlier key
// schemes; a whole-sheet reconcile would delete them, and that is not a decision this function
// should be making on its own.
var MS_RECONCILE_DAYS = 21;      // how far back to compare
var MS_MAX_DELETE = 50;          // refuse to delete more than this in one run; something is wrong

function _msNorm(v) {
  if (v instanceof Date) return String(v.getTime());
  if (typeof v === 'number') return String(v);          // 350 and 350.00 are the same value
  return String(v == null ? '' : v).trim();
}
// ── What counts as "the same row" ─────────────────────────────────────────
// NOT every column. The five (Check) columns are formulas that resolve the T# beside them
// against the inventory sheet — T#1 (Check) returns the material name for T #. The destination
// holds whatever they evaluated to at copy time, and the source re-evaluates them whenever
// inventory changes, so comparing them would report drift on rows nobody touched and the
// reconciler would delete and re-append them on every run, for ever.
//
// So the signature covers the columns a person actually enters. A derived column changing is
// not an edit; a derived column is not evidence of one either.
function _msIsDerivedHeader(h) {
  h = String(h || '').trim();
  return h === 'Check' || h.indexOf('(Check)') !== -1;
}
function _msSigCols(headers, width) {
  var cols = [], i;
  for (i = 0; i < width; i++) if (!_msIsDerivedHeader(headers[i])) cols.push(i);
  return cols;
}
function _msSig(row, cols) {
  var p = [], i;
  for (i = 0; i < cols.length; i++) p.push(_msNorm(row[cols[i]]));
  return p.join('␟');
}
function _msTs(v) {
  if (v instanceof Date) return v.getTime();
  var d = new Date(String(v || '').trim());
  return isNaN(d.getTime()) ? null : d.getTime();
}
// Row indices (1-based sheet rows) whose timestamp is at or after the cutoff.
//
// This used to read the whole timestamp column of both sheets — 23k cells each — and that read
// alone put the audit into "Exceeded maximum execution time". It is the same lesson the sweep
// already learned above: cost must scale with the window, not with the log. So walk BACKWARDS
// from the last row in blocks and stop once an entire block sits before the cutoff.
//
// Stopping on an entire block rather than on the first old row is deliberate. The destination is
// in append order, not date order — a pointer reset re-appended a run of older rows near the
// bottom — so a single pre-cutoff row is not the edge of the window. A whole block of them is.
var MS_TAIL_BLOCK = 2000;      // rows per backwards read
var MS_TAIL_SCAN_MAX = 12000;  // never look further back than this, whatever the dates say

function _msWindowRows(sheet, cutoffMs) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var floorRow = Math.max(2, last - MS_TAIL_SCAN_MAX + 1);
  var out = [], row = last, start, vals, hit, i, t;
  while (row >= floorRow) {
    start = Math.max(floorRow, row - MS_TAIL_BLOCK + 1);
    vals = sheet.getRange(start, 1, row - start + 1, 1).getValues();
    hit = 0;
    for (i = 0; i < vals.length; i++) {
      t = _msTs(vals[i][0]);
      if (t !== null && t >= cutoffMs) { out.push(start + i); hit++; }
    }
    row = start - 1;
    if (!hit) break;
  }
  out.sort(function(a, b) { return a - b; });
  return out;
}
// Runs of row numbers to read as one block. A gap smaller than maxGap is cheaper to read
// through than to issue a second call for; anything larger gets its own block, so one outlier
// row cannot drag a block across the whole sheet.
var MS_RUN_GAP = 100;
function _msMergeRuns(rows, maxGap) {
  if (!rows.length) return [];
  var out = [], start = rows[0], prev = rows[0], i;
  for (i = 1; i < rows.length; i++) {
    if (rows[i] - prev > maxGap) { out.push({ start: start, count: prev - start + 1 }); start = rows[i]; }
    prev = rows[i];
  }
  out.push({ start: start, count: prev - start + 1 });
  return out;
}
// Runs of adjacent column indices, so the entered columns are fetched in two calls rather than
// fourteen — and the formula columns between them are never touched.
function _msColRuns(cols) {
  var out = [], i = 0, start;
  while (i < cols.length) {
    start = cols[i];
    while (i + 1 < cols.length && cols[i + 1] === cols[i] + 1) i++;
    out.push({ start: start, len: cols[i] - start + 1 });
    i++;
  }
  return out;
}

// Contiguous runs of row numbers, descending, so deletions are a handful of calls and never
// shift a row this loop has yet to touch.
function _msDeleteRanges(rows) {
  var s = rows.slice().sort(function(a, b) { return b - a; }), out = [], i, end;
  for (i = 0; i < s.length; ) {
    end = s[i];
    while (i + 1 < s.length && s[i + 1] === s[i] - 1) i++;
    out.push({ start: s[i], count: end - s[i] + 1 });
    i++;
  }
  return out;
}

// Full-width values for a small set of rows, in source order, read per contiguous run.
function _msFullRows(sheet, items, width) {
  var rows = [], i;
  for (i = 0; i < items.length; i++) rows.push(items[i].row);
  rows.sort(function(a, b) { return a - b; });
  var runs = _msMergeRuns(rows, MS_RUN_GAP), byRow = {}, r, block;
  for (r = 0; r < runs.length; r++) {
    block = sheet.getRange(runs[r].start, 1, runs[r].count, width).getValues();
    for (i = 0; i < block.length; i++) byRow[runs[r].start + i] = block[i];
  }
  var out = [];
  for (i = 0; i < items.length; i++) out.push(byRow[items[i].row] || items[i].values);
  return out;
}

// Shared by the audit and the repair. Returns what differs; writes nothing.
function _msDiff(days) {
  var source = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SOURCE_SHEET_NAME);
  if (!source) throw new Error('Source sheet "' + SOURCE_SHEET_NAME + '" not found');
  var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];
  var width = source.getLastColumn();
  var srcHeaders = source.getRange(1, 1, 1, width).getValues()[0];
  if (!_msHeadersMatch(dest, srcHeaders)) throw new Error('Headers differ; run syncMaterials first');
  var keyIdx = _msKeyIdx(srcHeaders);
  var sigCols = _msSigCols(srcHeaders, width);
  var colRuns = _msColRuns(sigCols);

  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days || MS_RECONCILE_DAYS));
  cutoff.setHours(0, 0, 0, 0);
  var cutoffMs = cutoff.getTime();

  var t0 = Date.now();
  var srcRows = _msWindowRows(source, cutoffMs);
  var destRows = _msWindowRows(dest, cutoffMs);
  console.log('Window scan: ' + srcRows.length + ' source / ' + destRows.length
    + ' destination row(s) in ' + (Date.now() - t0) + ' ms.');

  // A source window that came back empty against a populated destination window means a bad
  // read, not a mass deletion. Never act on it.
  if (!srcRows.length && destRows.length) throw new Error('Source window empty, destination has '
    + destRows.length + ' row(s) — refusing to reconcile against what looks like a failed read');

  // Read the window in as few cells as possible, and never a formula cell.
  //
  // Two separate things made this the slow step, and both are addressed here.
  //
  // ROWS. Reading one block per contiguous run assumed the window is contiguous; spacers and
  // out-of-order re-appends break it into runs and each run is a round-trip. Reading first-to-
  // last in one call fixed that and introduced the opposite failure: one stray recent-looking
  // timestamp high up in the sheet stretches that single block over thousands of rows. So runs
  // separated by less than MS_RUN_GAP are merged and everything else is read as its own block —
  // bounded read count AND bounded over-read.
  //
  // COLUMNS. The (Check) formulas resolve their T# against the inventory sheet, and reading
  // them makes Sheets bring them up to date first. They are not compared (see _msSigCols) and
  // the dashboard never parses them, so they are not read either: only the runs of columns a
  // person enters. That is the same reason the sweep above is written in chunks — full-width
  // reads of this source are what put it over six minutes in the first place.
  function loadWindow(sheet, rows, label) {
    if (!rows.length) return [];
    var runs = _msMergeRuns(rows, MS_RUN_GAP), want = {}, out = [], i, r, c, block, colRun, rowsRead = 0;
    for (i = 0; i < rows.length; i++) want[rows[i]] = 1;
    for (r = 0; r < runs.length; r++) rowsRead += runs[r].count;
    console.log(label + ' window: rows ' + rows[0] + '-' + rows[rows.length - 1] + ', '
      + rows.length + ' wanted, ' + runs.length + ' block(s), ' + rowsRead + ' row(s) read x '
      + colRuns.length + ' column run(s).');
    for (r = 0; r < runs.length; r++) {
      var acc = [];
      for (i = 0; i < runs[r].count; i++) acc.push([]);
      for (c = 0; c < colRuns.length; c++) {
        colRun = colRuns[c];
        block = sheet.getRange(runs[r].start, colRun.start + 1, runs[r].count, colRun.len).getValues();
        for (i = 0; i < block.length; i++) {
          for (var j = 0; j < colRun.len; j++) acc[i][colRun.start + j] = block[i][j];
        }
      }
      for (i = 0; i < acc.length; i++) {
        var rowNum = runs[r].start + i;
        if (!want[rowNum]) continue;
        if (_msIsBlankKey(acc[i], keyIdx)) continue;
        out.push({ row: rowNum, values: acc[i], sig: _msSig(acc[i], sigCols) });
      }
    }
    return out;
  }

  var t1 = Date.now();
  var src = loadWindow(source, srcRows, 'Source');
  console.log('Source load: ' + (Date.now() - t1) + ' ms.');
  var t2 = Date.now();
  var dst = loadWindow(dest, destRows, 'Destination');
  console.log('Destination load: ' + (Date.now() - t2) + ' ms.');

  // Multiset compare: a duplicate submission is legitimate (two draws on one slip), so counts
  // matter, not mere presence.
  var have = {}, i, k;
  for (i = 0; i < dst.length; i++) {
    k = dst[i].sig;
    if (!have[k]) have[k] = [];
    have[k].push(dst[i].row);
  }
  var missing = [], want = {};
  for (i = 0; i < src.length; i++) {
    k = src[i].sig;
    want[k] = (want[k] || 0) + 1;
    if (!have[k] || have[k].length < want[k]) missing.push(src[i]);
  }
  var stale = [];
  for (k in have) {
    if (!have.hasOwnProperty(k)) continue;
    var extra = have[k].length - (want[k] || 0);
    // Drop the LAST copies: the earliest occurrence is the one the sweep wrote in order.
    for (i = 0; i < extra; i++) stale.push(have[k][have[k].length - 1 - i]);
  }
  return { source: source, dest: dest, width: width, cutoff: cutoff, keyIdx: keyIdx,
           src: src, dst: dst, missing: missing, stale: stale };
}

function _msDescribe(r, keyIdx) {
  return _msNorm(r.values[0]) + ' \u00b7 lot ' + _msNorm(r.values[keyIdx[0]])
    + ' \u00b7 part ' + _msNorm(r.values[keyIdx[1]]);
}

// Read-only. Run this first, and after any change to the source, to see what has drifted.
function auditMaterialsSync(days) {
  var d = _msDiff(days), i;
  console.log('Window from ' + d.cutoff.toDateString() + ': source ' + d.src.length
    + ' row(s), destination ' + d.dst.length + ' row(s).');
  if (!d.missing.length && !d.stale.length) { console.log('In step — nothing to repair.'); return; }
  // Capped: Apps Script throttles logging, and a few hundred console.log calls take longer than
  // the comparison that produced them. The counts are the finding; the list is the evidence.
  var CAP = 40, byRow = {}, j;
  for (j = 0; j < d.dst.length; j++) byRow[d.dst[j].row] = d.dst[j];

  console.log(d.missing.length + ' row(s) in the source that the destination is missing:');
  for (i = 0; i < Math.min(d.missing.length, CAP); i++) {
    console.log('  + src row ' + d.missing[i].row + ': ' + _msDescribe(d.missing[i], d.keyIdx));
  }
  if (d.missing.length > CAP) console.log('  ... and ' + (d.missing.length - CAP) + ' more.');

  console.log(d.stale.length + ' row(s) in the destination that no longer match the source:');
  for (i = 0; i < Math.min(d.stale.length, CAP); i++) {
    console.log('  - dest row ' + d.stale[i] + ': '
      + (byRow[d.stale[i]] ? _msDescribe(byRow[d.stale[i]], d.keyIdx) : ''));
  }
  if (d.stale.length > CAP) console.log('  ... and ' + (d.stale.length - CAP) + ' more.');
}

// Applies the repair: append what is missing, delete what the source no longer says.
// `force` lifts the MS_MAX_DELETE ceiling — only after auditMaterialsSync has shown you why.
function reconcileMaterials(days, force) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { console.log('Sync is mid-write; skipping this reconcile.'); return; }
  try {
    var d = _msDiff(days), i, n = 0;
    if (!d.missing.length && !d.stale.length) return;
    if (d.stale.length > MS_MAX_DELETE && !force) {
      console.error('Reconcile stopped: ' + d.stale.length + ' destination row(s) would be deleted, '
        + 'over the ' + MS_MAX_DELETE + ' ceiling. Run auditMaterialsSync() and, if it is genuinely '
        + 'right, reconcileMaterials(days, true).');
      return;
    }
    var ranges = _msDeleteRanges(d.stale);
    for (i = 0; i < ranges.length; i++) { d.dest.deleteRows(ranges[i].start, ranges[i].count); n += ranges[i].count; }
    if (d.missing.length) {
      // The compare skipped the formula columns, so those cells are holes in what it read.
      // Fetch the rows about to be appended at full width — a handful of rows, unlike the
      // window — so the mirror carries the same values a human sees in the source rather than
      // blanks in the middle of every repaired row.
      var vals = _msFullRows(d.source, d.missing, d.width);
      d.dest.getRange(d.dest.getLastRow() + 1, 1, vals.length, d.width).setValues(vals);
    }
    // Rows were removed from the middle of the destination, but the pointer counts SOURCE rows,
    // so it stays valid. Left alone deliberately.
    console.log('Reconciled: deleted ' + n + ', appended ' + d.missing.length + '.');
  } catch (err) {
    console.error('reconcileMaterials failed: ' + (err && err.stack || err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// ── Where does the time actually go ───────────────────────────────────────
// Run this when a sync or audit hangs. Every line prints the moment it is measured, so the log
// says which operation is slow instead of leaving a spinner and no evidence. Reads nothing but
// tails and single cells, so it cannot itself be the slow thing.
function msProbe() {
  var t, ss, src, dest, lr, lc;
  t = Date.now(); ss = SpreadsheetApp.getActiveSpreadsheet();
  console.log('open active spreadsheet: ' + (Date.now() - t) + ' ms  (' + ss.getName() + ')');
  t = Date.now(); src = ss.getSheetByName(SOURCE_SHEET_NAME);
  console.log('getSheetByName: ' + (Date.now() - t) + ' ms');
  if (!src) { console.error('Source sheet "' + SOURCE_SHEET_NAME + '" not found. Sheets here: '
    + ss.getSheets().map(function(s) { return s.getName(); }).join(', ')); return; }
  t = Date.now(); lr = src.getLastRow(); console.log('source getLastRow = ' + lr + ': ' + (Date.now() - t) + ' ms');
  t = Date.now(); lc = src.getLastColumn(); console.log('source getLastColumn = ' + lc + ': ' + (Date.now() - t) + ' ms');

  function timeRead(sheet, label, row, col, nr, nc) {
    var t0 = Date.now(), v;
    try { v = sheet.getRange(row, col, nr, nc).getValues(); }
    catch (err) { console.error(label + ': FAILED after ' + (Date.now() - t0) + ' ms — ' + err); return; }
    console.log(label + ' (' + nr + ' x ' + nc + '): ' + (Date.now() - t0) + ' ms');
  }
  // Entered columns only, then the same rows including a formula column, so the difference
  // between the two lines is the cost of the (Check) lookups and nothing else.
  timeRead(src, 'source 1 cell', lr, 1, 1, 1);
  timeRead(src, 'source tail col A', Math.max(2, lr - 999), 1, Math.min(1000, lr - 1), 1);
  timeRead(src, 'source tail entered cols', Math.max(2, lr - 999), 1, Math.min(1000, lr - 1), 6);
  timeRead(src, 'source tail WITH formula col', Math.max(2, lr - 999), 1, Math.min(1000, lr - 1), 7);
  timeRead(src, 'source tail full width', Math.max(2, lr - 999), 1, Math.min(1000, lr - 1), lc);

  t = Date.now(); dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];
  console.log('open destination by id: ' + (Date.now() - t) + ' ms');
  t = Date.now(); lr = dest.getLastRow(); console.log('destination getLastRow = ' + lr + ': ' + (Date.now() - t) + ' ms');
  timeRead(dest, 'destination tail col A', Math.max(2, lr - 999), 1, Math.min(1000, lr - 1), 1);
  timeRead(dest, 'destination tail full width', Math.max(2, lr - 999), 1, Math.min(1000, lr - 1), dest.getLastColumn());
  console.log('Probe complete.');
}

// The editor's Run button cannot pass arguments, so the two you click from the dropdown
// take none and use the default window.
function auditMaterialsNow() { auditMaterialsSync(MS_RECONCILE_DAYS); }
function reconcileMaterialsNow() { reconcileMaterials(MS_RECONCILE_DAYS); }

// Point the time-based trigger at this instead of syncMaterials: copy new rows, then repair the
// last few days. The short window keeps it to two narrow reads when nothing has drifted, which
// is almost always.
function syncMaterialsAndReconcile() {
  var t0 = Date.now();
  syncMaterials();
  // The sweep is allowed to run to 4.5 minutes. Starting a reconcile after one of those walks
  // straight into the 6-minute wall and loses both. A backlog run gets the sweep to itself; the
  // next trigger, with nothing left to copy, does the reconcile.
  if (Date.now() - t0 > 60000) {
    console.log('Sweep took ' + Math.round((Date.now() - t0) / 1000) + 's; reconcile deferred to the next trigger.');
    return;
  }
  try { reconcileMaterials(3); } catch (err) { console.error('reconcile step: ' + err); }
}
