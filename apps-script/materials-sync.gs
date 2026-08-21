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
