// Bound to: 0 DTF Logistics spreadsheet
// Purpose:   Mirror new rows from the source Materials tab into the
//            standalone destination sheet that the dashboard reads as CSV.
// Trigger:   Time-driven -> Minutes timer -> Every 15 minutes
//
// Keys off Order Lot # + Part # to detect what's missing in the destination
// and appends those rows. Idempotent — safe to run overlapping, safe to
// fail mid-way (next run reconciles the diff). If headers drift upstream
// the destination is rebuilt once and reflows.

var DEST_SHEET_ID = '1PouHBkH48hJ6XT8mIQ2djixJ8rxBqtdohVJupy3Hp9Q';
var SOURCE_SHEET_NAME = 'Materials';
var KEY_HEADERS = ['Order Lot #', 'Part #'];

function syncMaterials() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var source = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SOURCE_SHEET_NAME);
    if (!source) { console.warn('Source sheet "' + SOURCE_SHEET_NAME + '" not found'); return; }
    var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];

    var srcVals = source.getDataRange().getValues();
    if (srcVals.length < 2) return;
    var srcHeaders = srcVals[0];
    var srcBody = srcVals.slice(1);

    var keyIdx = KEY_HEADERS.map(function(h){
      var i = srcHeaders.indexOf(h);
      if (i === -1) throw new Error('Missing expected header in source: "' + h + '"');
      return i;
    });
    function keyOf(row) { return keyIdx.map(function(i){ return String(row[i]||'').trim(); }).join('||'); }

    var destVals = dest.getDataRange().getValues();
    var destHeaders = destVals.length ? destVals[0] : [];
    var headersMatch = srcHeaders.length === destHeaders.length &&
                       srcHeaders.every(function(h,i){ return h === destHeaders[i]; });
    if (!headersMatch) {
      dest.clear();
      dest.getRange(1, 1, 1, srcHeaders.length).setValues([srcHeaders]);
      destVals = [srcHeaders];
      destHeaders = srcHeaders;
    }
    var destBody = destVals.slice(1);
    var destKeyIdx = KEY_HEADERS.map(function(h){ return destHeaders.indexOf(h); });
    function destKeyOf(row) { return destKeyIdx.map(function(i){ return String(row[i]||'').trim(); }).join('||'); }

    var seen = {};
    destBody.forEach(function(r){ seen[destKeyOf(r)] = true; });

    var blankKey = KEY_HEADERS.map(function(){ return ''; }).join('||');
    var toAppend = srcBody.filter(function(r){
      var k = keyOf(r);
      if (k === blankKey) return false;
      return !seen[k];
    });

    if (!toAppend.length) return;

    dest.getRange(dest.getLastRow()+1, 1, toAppend.length, srcHeaders.length).setValues(toAppend);
    console.log('Synced ' + toAppend.length + ' new row(s) to destination.');
  } catch (err) {
    console.error('syncMaterials failed: ' + (err && err.stack || err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// Manual one-shot — use from the script editor's Run menu for a backfill
// or to sanity-check after editing the source sheet.
function runSyncNow() { syncMaterials(); }
