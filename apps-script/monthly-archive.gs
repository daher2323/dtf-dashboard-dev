// Bound to: Central Orders spreadsheet
// Purpose:   Monthly snapshot of POWDER/CAPSULE OPEN ORDERS tabs — copies
//            each tab in-place, renames it to "<TYPE> ARCHIVE - <MON YY>",
//            and hides it. Run on the 1st of each month via a time-based
//            trigger; label references the PREVIOUS month so a run on
//            May 1 produces "APR 26" archives.
// Trigger:   Time-driven -> Month timer -> 1st of month

function archiveOpenOrders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var now = new Date();
  // Reference previous month since we run on the 1st
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var monthLabel = lastMonth.toLocaleDateString('en-US', {month:'short', year:'2-digit'}).toUpperCase();
  // e.g. "APR 26"

  var tabs = ['POWDER OPEN ORDERS', 'CAPSULE OPEN ORDERS'];
  tabs.forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    var copy = sheet.copyTo(ss);
    copy.setName(name.replace(' OPEN ORDERS', ' ARCHIVE - ' + monthLabel));
    copy.hideSheet();
  });
}
