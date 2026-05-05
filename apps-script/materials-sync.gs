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

    var keyIdx = KEY_HEADERS.map(function(h) {
      var i = srcHeaders.indexOf(h);
      if (i === -1) throw new Error('Missing expected header in source: "' + h + '"');
      return i;
    });
    function keyOf(row) {
      return keyIdx.map(function(i) { return String(row[i] || '').trim(); }).join('||');
    }

    // Read dest headers only first — one row, fast
    var destLastRow = dest.getLastRow();
    var destLastCol = dest.getLastColumn();
    var destHeaders = destLastRow > 0
      ? dest.getRange(1, 1, 1, destLastCol).getValues()[0]
      : [];

    var headersMatch = srcHeaders.length === destHeaders.length &&
                       srcHeaders.every(function(h, i) { return h === destHeaders[i]; });

    if (!headersMatch) {
      dest.clear();
      dest.getRange(1, 1, 1, srcHeaders.length).setValues([srcHeaders]);
      destHeaders = srcHeaders;
      destLastRow = 1;
    }

    // Read ONLY the two key columns from dest — not the whole sheet
    var seen = {};
    if (destLastRow > 1) {
      var destKeyIdx = KEY_HEADERS.map(function(h) { return destHeaders.indexOf(h); });
      // Read each key column separately and zip them
      var col1 = destKeyIdx[0] + 1;
      var col2 = destKeyIdx[1] + 1;
      var keys1 = dest.getRange(2, col1, destLastRow - 1, 1).getValues();
      var keys2 = dest.getRange(2, col2, destLastRow - 1, 1).getValues();
      for (var i = 0; i < keys1.length; i++) {
        var k = String(keys1[i][0] || '').trim() + '||' + String(keys2[i][0] || '').trim();
        seen[k] = true;
      }
    }

    var blankKey = '||';
    var toAppend = srcBody.filter(function(r) {
      var k = keyOf(r);
      if (k === blankKey) return false;
      return !seen[k];
    });

    if (!toAppend.length) return;

    dest.getRange(dest.getLastRow() + 1, 1, toAppend.length, srcHeaders.length).setValues(toAppend);
    console.log('Synced ' + toAppend.length + ' new row(s) to destination.');
  } catch (err) {
    console.error('syncMaterials failed: ' + (err && err.stack || err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function runSyncNow() { syncMaterials(); }
