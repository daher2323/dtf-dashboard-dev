// Live feed endpoint for the dashboard.
//
// WHY THIS EXISTS
// The dashboard reads Google's "Publish to web" CSVs (/pub?output=csv). Those are not the
// sheet — they are a separately cached artifact on Google's own refresh schedule, and that
// cache serves more than one generation of the file at a time. Measured 2026-09-16 on the
// inventory feed: at 14:05, three hours after inventory corrected four lots, six
// cache-busted fetches returned the corrected file three times and a file byte-identical to
// that morning's pre-correction snapshot three times. At 14:16 it was still 2 of 8. A unique
// query parameter does not pin it, so this is the publish pipeline, not a CDN edge and not
// the browser. Consequence: the dashboard rendered three-hour-old stock, at random, with
// nothing on the page able to say so.
//
// This endpoint reads the LIVE spreadsheet with SpreadsheetApp and returns CSV, so there is
// no publish snapshot in the path at all. It also removes the other publish-pipeline defect
// the dashboard works around: the inventory tab intermittently serving its header plus a
// single row of #VALUE!/#N/A (222 bytes against ~370 KB) while the sheet itself reads fine.
//
// DEPLOYMENT
//   1. Open the Materials_Dashboard_View workbook -> Extensions -> Apps Script.
//   2. Add this file. Set SPREADSHEET_ID below if the script is NOT bound to that workbook.
//   3. Deploy -> New deployment -> type "Web app".
//        Execute as:        Me (your account)
//        Who has access:    Anyone
//      "Anyone" means anyone with the /exec URL, and that URL ends up in the dashboard's page
//      source on a public site — so treat it as public. That is why FEEDS below is an
//      ALLOWLIST: the endpoint can only ever return the tabs named here, never an arbitrary
//      gid, so the workbook does NOT need link-sharing and nothing else in it is reachable.
//      The script runs as you, which is what lets the workbook stay restricted.
//   4. Copy the /exec URL into CSV_INVENTORY_LIVE in index.html.
//
// Re-deploy ("Manage deployments" -> edit -> New version) after any edit here, or the old
// version keeps serving.

// Leave '' when the script is container-bound to Materials_Dashboard_View.
var SPREADSHEET_ID = '';

// The only tabs this endpoint will serve, keyed by the `feed` parameter. Tab NAMES, not gids:
// a name is checked against the workbook's own tab list, and a caller cannot reach anything
// that is not spelled out here.
var FEEDS = {
  inventory: 'Inventory',
  archive:   'Inventory Archive'
};

// Absorbs the burst the dashboard makes when it double-checks a finding (up to three reads in
// a few seconds) without returning to the sheet each time. Deliberately tiny: freshness is the
// entire point of this endpoint, and 15 seconds against the three hours it replaces is noise.
// Set to 0 to disable.
var CACHE_SECONDS = 15;

function doGet(e) {
  var p = (e && e.parameter) || {};
  var key = String(p.feed || 'inventory');
  var tabName = FEEDS[key];
  if (!tabName) return _text('ERROR: unknown feed "' + key + '"');

  var cache = CacheService.getScriptCache();
  var cacheKey = 'feed:' + key;
  if (CACHE_SECONDS > 0 && !p.nocache) {
    try {
      var hit = cache.get(cacheKey);
      if (hit) return _csv(hit);
    } catch (err) {}   // a cache miss must never be a failure
  }

  var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                          : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return _text('ERROR: tab "' + tabName + '" not found');

  // getDisplayValues, not getValues: it returns each cell exactly as the sheet renders it,
  // which is what the published CSV did. getValues hands back Date objects and raw floats, so
  // "12/21/2026" would arrive as an ISO timestamp and parseInvDate would reject every expiry
  // date in the feed. Display values keep this a drop-in replacement.
  var rows = sheet.getDataRange().getDisplayValues();
  var csv = _toCsv(rows);

  if (CACHE_SECONDS > 0) {
    // 100 KB per entry is the CacheService limit and this payload is ~370 KB, so the cache
    // simply does not apply at this size. Attempted and ignored rather than special-cased: if
    // a feed is ever small enough to fit, it gets the benefit for free.
    try { cache.put(cacheKey, csv, CACHE_SECONDS); } catch (err) {}
  }
  return _csv(csv);
}

// Standard CSV quoting. Not optional here: Locations holds values like "7L-22-A, 7R-21-B" and
// a bare comma would shift every column after it.
function _toCsv(rows) {
  var out = [], i, j, row, cell, line;
  for (i = 0; i < rows.length; i++) {
    row = rows[i]; line = [];
    for (j = 0; j < row.length; j++) {
      cell = row[j] == null ? '' : String(row[j]);
      if (cell.indexOf('"') !== -1 || cell.indexOf(',') !== -1
          || cell.indexOf('\n') !== -1 || cell.indexOf('\r') !== -1) {
        cell = '"' + cell.replace(/"/g, '""') + '"';
      }
      line.push(cell);
    }
    out.push(line.join(','));
  }
  return out.join('\n');
}

function _csv(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.CSV);
}

function _text(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}
