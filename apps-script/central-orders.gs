// Bound to: Central Orders spreadsheet
// Purpose:   Append an audit entry to the CHANGE LOG sheet whenever a row on
//            POWDER OPEN ORDERS or CAPSULE OPEN ORDERS is edited or added/deleted.
// Triggers:
//   - Installable "on edit"   -> onEdit
//   - Installable "on change" -> onChangeHandler
//
// The onEdit handler uses LockService.tryLock(500) as a fast-path guard so
// burst edits (pastes, array formulas recalculating) don't pile up into the
// "Too many simultaneous invocations: Spreadsheets" error. Under contention
// an edit is dropped from the log rather than queued — intentional trade-off
// for stability. Row add/delete detection lives in onChangeHandler where
// e.changeType is reliable (unlike PropertiesService-based row counts which
// race under concurrency).

var TRACKED_SHEETS = ['POWDER OPEN ORDERS', 'CAPSULE OPEN ORDERS'];
var LOT_COL = 8;
var BRAND_COL = 1;
var PRODUCT_COL = 2;
var ORDER_AMT_COL = 21;

function onEdit(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return;
  try {
    var range = e.range;
    var row = range.getRow();
    if (row <= 1) return;

    var sheet = e.source.getActiveSheet();
    var sheetName = sheet.getName();
    if (TRACKED_SHEETS.indexOf(sheetName) === -1) return;

    var log = e.source.getSheetByName('CHANGE LOG');
    if (!log) return;

    var user = Session.getActiveUser().getEmail() || 'Unknown';
    var timestamp = new Date();
    var newVal = range.getValue();
    var oldVal = (e.oldValue !== undefined && e.oldValue !== null) ? e.oldValue : '(blank)';

    var lot = '', brand = '', product = '', orderAmt = '';
    try {
      var lastCol = Math.max(sheet.getLastColumn(), ORDER_AMT_COL);
      var rowData = sheet.getRange(row, 1, 1, lastCol).getValues()[0];
      lot = rowData[LOT_COL - 1] || '';
      brand = rowData[BRAND_COL - 1] || '';
      product = rowData[PRODUCT_COL - 1] || '';
      orderAmt = rowData[ORDER_AMT_COL - 1] || '';
    } catch (e2) {}

    var colIdx = range.getColumn();
    var colHeader = '';
    try {
      colHeader = sheet.getRange(1, colIdx).getValue() || columnToLetter(colIdx);
    } catch (e3) {
      colHeader = columnToLetter(colIdx);
    }

    var details = colHeader + ': "' + oldVal + '" \u2192 "' + newVal + '"';
    if (range.getNumRows() > 1 || range.getNumColumns() > 1) {
      details += ' [range: ' + range.getA1Notation() + ']';
    }

    log.appendRow([timestamp, user, sheetName, 'Edit', row, lot, brand, product, orderAmt, details]);
  } catch (err) {
    console.error('onEdit failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function onChangeHandler(e) {
  if (!e || !e.source || !e.changeType) return;
  if (e.changeType !== 'INSERT_ROW' && e.changeType !== 'REMOVE_ROW') return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    var sheet = e.source.getActiveSheet();
    var sheetName = sheet.getName();
    if (TRACKED_SHEETS.indexOf(sheetName) === -1) return;

    var log = e.source.getSheetByName('CHANGE LOG');
    if (!log) return;

    var user = Session.getActiveUser().getEmail() || 'Unknown';
    var action = e.changeType === 'INSERT_ROW' ? 'Row Added' : 'Row Deleted';

    log.appendRow([new Date(), user, sheetName, action, '', '', '', '', '', action + ' via structural change']);
  } catch (err) {
    console.error('onChangeHandler failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function columnToLetter(col) {
  var letter = '';
  while (col > 0) {
    var mod = (col - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}
