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
// Signature over every column, so ANY edited cell registers as a difference.
function _msSig(row, width) {
  var p = [], i;
  for (i = 0; i < width; i++) p.push(_msNorm(row[i]));
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

// Shared by the audit and the repair. Returns what differs; writes nothing.
function _msDiff(days) {
  var source = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SOURCE_SHEET_NAME);
  if (!source) throw new Error('Source sheet "' + SOURCE_SHEET_NAME + '" not found');
  var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];
  var width = source.getLastColumn();
  var srcHeaders = source.getRange(1, 1, 1, width).getValues()[0];
  if (!_msHeadersMatch(dest, srcHeaders)) throw new Error('Headers differ; run syncMaterials first');
  var keyIdx = _msKeyIdx(srcHeaders);

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

  // One block read per contiguous run beats one per row; the window is usually contiguous.
  function loadFast(sheet, rows) {
    if (!rows.length) return [];
    var out = [], i = 0, start, end, block, b;
    while (i < rows.length) {
      start = rows[i];
      while (i + 1 < rows.length && rows[i + 1] === rows[i] + 1) i++;
      end = rows[i];
      block = sheet.getRange(start, 1, end - start + 1, width).getValues();
      for (b = 0; b < block.length; b++) {
        if (_msIsBlankKey(block[b], keyIdx)) continue;
        out.push({ row: start + b, values: block[b], sig: _msSig(block[b], width) });
      }
      i++;
    }
    return out;
  }

  var t1 = Date.now();
  var src = loadFast(source, srcRows), dst = loadFast(dest, destRows);
  console.log('Row load: ' + (Date.now() - t1) + ' ms.');

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
  return { dest: dest, width: width, cutoff: cutoff, keyIdx: keyIdx, src: src, dst: dst,
           missing: missing, stale: stale };
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
  console.log(d.missing.length + ' row(s) in the source that the destination is missing:');
  for (i = 0; i < d.missing.length; i++) console.log('  + src row ' + d.missing[i].row + ': ' + _msDescribe(d.missing[i], d.keyIdx));
  console.log(d.stale.length + ' row(s) in the destination that no longer match the source:');
  for (i = 0; i < d.stale.length; i++) {
    var row = null, j;
    for (j = 0; j < d.dst.length; j++) if (d.dst[j].row === d.stale[i]) row = d.dst[j];
    console.log('  - dest row ' + d.stale[i] + ': ' + (row ? _msDescribe(row, d.keyIdx) : ''));
  }
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
      var vals = [];
      for (i = 0; i < d.missing.length; i++) vals.push(d.missing[i].values);
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
