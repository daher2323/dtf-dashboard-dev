// Materials pick sheet -> central dashboard sheet.
//
// The dashboard reads the DESTINATION sheet's published CSV, so nothing reaches Pick
// opportunities, Recall Tracking or Blend Lookup until this has run. That makes its latency the
// floor on the whole same-day correction loop: pull, spot the miss, re-log, watch it go green.
//
// Two paths, deliberately:
//   onMaterialsFormSubmit  installable trigger, one row, ~1s. This is the live path — a
//                          correction logged at 2pm is on the dashboard within its next 5-minute
//                          poll rather than at the top of the next quarter hour. It builds the
//                          row from the form event and never opens the source workbook, which
//                          is what makes it ~1s again rather than ~130s (see below).
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
// The source workbook's own id. Only the REST read path below uses it — everything else reaches
// the source through getActiveSpreadsheet(), which is the call that costs 149s. Paste it from the
// workbook's URL: /spreadsheets/d/<THIS>/edit. See msProbeSheetsApi().
var SOURCE_SS_ID = '';
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
// Apps Script kills an execution at 6 minutes. Every one of the 11 failures logged 9/1-9/2
// ran 6 min 1 s, i.e. straight into the wall, so the budget has to leave real room.
var MS_WALL_MS = 6 * 60 * 1000;                     // the hard kill, for reference
var MS_SAFETY_MS = 45 * 1000;                       // never plan work inside this of the wall
var MAX_RUNTIME_MS = 3.5 * 60 * 1000;               // was 4.5, which left only 90s of slack
// Was 2000. The sweep only checks the clock BETWEEN chunks, so the chunk size sets how far it
// can overshoot its budget: at 2000 rows off this source one chunk is tens of seconds, and two
// of those after a 130s bind is how a 4.5-minute ceiling became a 6-minute kill. Writes to the
// destination are ~200 ms, so smaller chunks cost almost nothing and check the clock 4x as often.
var APPEND_CHUNK = 500;

function _msProps() { return PropertiesService.getScriptProperties(); }
function _msGetPointer() {
  var v = parseInt(_msProps().getProperty(PROP_LAST_ROW), 10);
  return isNaN(v) || v < 1 ? 0 : v;
}
function _msSetPointer(row) { _msProps().setProperty(PROP_LAST_ROW, String(row)); }

// Dates arrive as Date objects from getValues(); normalise so source and destination agree.
//
// To the SECOND, not the millisecond, and that is not a concession to any particular way of
// reading the sheet — the key was wrong at millisecond precision. The form's own timestamp
// string carries whole seconds, so _msEventStamp builds a .000 Date while the source cell holds
// .807; a row written by the fast submit path therefore did not match the source row the sweep
// later read, and the sweep appended it a second time. Sub-second precision buys the key nothing
// either way: two submissions of the same lot and part inside one second is not something a
// person at a form can do.
//
// Rounding, not truncation, and that is measured rather than assumed: across the 500-row window
// msProbeSheetsApi compared, .807 rendered up and .147 rendered down, every time. Flooring would
// put the two sides a second apart on roughly half the rows. Both the REST read and the form
// event carry that same rendering, which is why one rule settles both.
function _msStamp(v) {
  return (v instanceof Date) ? String(Math.round(v.getTime() / 1000)) : String(v || '').trim();
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
//
// Two properties of this function are load-bearing, and both come from failures in the log
// rather than from anything visible in the code that used to be here.
//
// IT DOES NOT OPEN THE SOURCE WORKBOOK. The event already carries every answer the operator
// typed — e.namedValues, keyed by the form question title, which is the sheet header — so the
// row can be assembled without binding the source spreadsheet at all. The first touch of that
// workbook measures ~130 s before a single row is read, so reading the submitted row back out
// of the sheet spent over two minutes learning what the event had already said. That read is
// what put this trigger over the six-minute wall ~9 times a day ("Exceeded maximum execution
// time"), and every one of those was a row the live path did not deliver.
//
// IT NEVER HOLDS THE LOCK ACROSS A SOURCE READ. It used to take the script lock as its first
// act, so each of those six-minute hangs sat on the lock for its entire life — and syncMaterials
// opens with tryLock(10000) and returns quietly when it loses, so every sweep that overlapped a
// hung submit silently no-opped. The safety net was down precisely when the live path was
// failing, which is how rows went missing for weeks with neither function logging an error. The
// lock now covers destination work only — one header read and one append, ~400 ms — and the
// fallback below takes it after its slow reads, never before them.
//
// The event path is SELF-CHECKING and hands the row to the old source read whenever the mapping
// is not provably right (see _msSubmitFromEvent). A wrong row is worse than a slow one.
function onMaterialsFormSubmit(e) {
  try {
    if (!e) return;
    if (_msSubmitFromEvent(e)) return;
    _msSubmitFromSource(e);
  } catch (err) {
    console.error('onMaterialsFormSubmit failed: ' + (err && err.stack || err));
  }
}

// ── Why neither path advances the pointer ─────────────────────────────────
// This trigger used to move the sweep's pointer up to the row it had just copied, so the sweep
// would not re-read it, and that quietly punched permanent holes in the mirror:
//
//   row 100 submits, succeeds, pointer = 100
//   row 101 submits, THROWS  (this trigger fails ~7% of the time)
//   row 102 submits, succeeds, pointer = 102
//
// The sweep then starts at 103, and row 101 is never looked at again by anything. The pointer is
// a high-water mark, so a failure between two successes is skipped for ever. That is exactly the
// shape of the rows found missing: a steady ~1.5 a day, spread evenly, no clustering and nothing
// wrong with the rows themselves.
//
// Leaving the pointer alone costs the sweep a re-read of the rows since its last run, and it
// appends none of them — the key-set dedupe built from the destination already stops a
// re-append. That check was always doing this job; the advance was an optimisation that traded
// correctness for a read the sweep performs anyway.

function _msTrim(v) { return String(v == null ? '' : v).trim(); }

// The submitted timestamp, as a Date, out of the string the event carries.
//
// It has to be a Date and it has to be the same instant the source cell holds, because the
// sweep's dedupe key is that value (_msStamp -> getTime()). A timestamp landing as text, or
// shifted by a timezone, is not recognised as already-synced, so the sweep appends the row a
// second time and the dashboard counts the pick twice. So the parse is round-tripped through the
// script timezone and has to come back with the same fields; anything else returns null and
// takes the source path, where the cell is read as a Date directly.
//
// This catches text, a shift, and an unexpected rendering (2-digit year, AM/PM). It cannot catch
// a sheet whose locale swaps day and month — 8/9 parsed as Aug 9 round-trips as 8/9 either way.
// This workbook is US-formatted throughout (the dashboard's dateKey is M/D/YYYY); if that ever
// changes, this is the function to change with it.
function _msEventStamp(raw) {
  var s = _msTrim(raw);
  if (!s) return null;
  var d = new Date(s);
  if (isNaN(d.getTime())) return null;
  var want = _msDateFields(s);
  if (!want) return null;
  var back = Utilities.formatDate(d, Session.getScriptTimeZone(), 'M/d/yyyy H:mm:ss');
  return want === _msDateFields(back) ? d : null;
}
function _msDateFields(s) {
  var m = String(s || '').match(/(\d{1,4})\D+(\d{1,4})\D+(\d{1,4})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?/);
  if (!m) return null;
  var y = +m[3]; if (y < 100) y += 2000;
  var h = +m[4], ap = m[7] ? m[7].toLowerCase() : '';
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return [+m[1], +m[2], y, h, +m[5], +(m[6] || 0)].join('/');
}

// One value per destination column, from the event's answers. Returns null when the header row
// asks for something this mapping cannot answer honestly.
//
// Derived columns are left BLANK on purpose. The (Check) columns are formulas resolving a T#
// against inventory; the event has no answer for them, the dashboard never parses them
// (PICK_SLOT_IDX skips them), and the reconcile's signature excludes them (_msSigCols) — so a
// blank there is inert, and it cannot read as drift. Inventing a value is the only way to make
// that column matter.
function _msEventRowFrom(named, names, stamp) {
  var lookup = {}, seenName = {}, row = [], unmapped = [], k, i, h, v;
  for (k in named) if (named.hasOwnProperty(k)) lookup[_msTrim(k)] = named[k];
  // Two columns carrying the same header would both claim the same answer, and there is no way
  // to tell from here which one the form wrote. Let the source read settle it.
  for (i = 1; i < names.length; i++) {
    h = names[i];
    if (!h || _msIsDerivedHeader(h)) continue;
    if (seenName[h]) return null;
    seenName[h] = 1;
  }
  for (i = 0; i < names.length; i++) {
    h = names[i];
    if (i === 0) { row.push(stamp); continue; }             // Forms owns this header's name
    if (_msIsDerivedHeader(h)) { row.push(''); continue; }
    if (h && lookup.hasOwnProperty(h)) {
      v = lookup[h];
      row.push(v && v.join ? v.join(', ') : _msTrim(v));    // checkbox answers land comma-joined
    } else {
      row.push('');
      if (h) unmapped.push(h);
    }
  }
  return { values: row, unmapped: unmapped };
}

// Builds and appends the submitted row from the event alone. Returns true when the submission
// has been dealt with — appended, or deliberately left to the sweep — and false when the caller
// should fall back to reading the row out of the source sheet.
function _msSubmitFromEvent(e) {
  var named = e.namedValues;
  if (!named) return false;
  var stamp = _msEventStamp((e.values && e.values.length) ? e.values[0] : null);
  if (!stamp) return false;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return true;        // sweep is mid-write; let it carry the row
  try {
    // The destination's own header row is the write template: it is ~200 ms away, and it is the
    // shape the destination actually has, which is the shape this append has to match. Reading
    // it under the lock also means getLastRow() below cannot be a value the sweep has already
    // moved past. If the form has since gained a column, the sweep sees the header mismatch and
    // rebuilds the sheet from the source, so a row written to the older shape is not a dead end.
    var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];
    if (dest.getLastRow() < 1) return false;    // no header row yet; let the sweep build it
    var width = dest.getLastColumn();
    var headers = dest.getRange(1, 1, 1, width).getValues()[0], names = [], i;
    for (i = 0; i < width; i++) names.push(_msTrim(headers[i]));
    var keyAt = [names.indexOf(KEY_HEADERS[0]), names.indexOf(KEY_HEADERS[1])];
    if (keyAt[0] === -1 || keyAt[1] === -1) return false;

    var built = _msEventRowFrom(named, names, stamp);
    if (!built) return false;
    // The self-check. A renamed form question, a header edited in the sheet, or a submission
    // from some other tab's form all arrive here as a key column with no answer behind it — and
    // a row with no lot and no part is indistinguishable from a spacer (_msIsBlankKey), so it
    // must never be appended on a guess. Those go to the source path, which can see the sheet.
    if (built.unmapped.indexOf(KEY_HEADERS[0]) !== -1) return false;
    if (built.unmapped.indexOf(KEY_HEADERS[1]) !== -1) return false;
    // Both key columns mapped and both came back empty: a genuine spacer, nothing to sync, and
    // re-reading it from the source would reach the same conclusion 130 s later.
    if (!_msTrim(built.values[keyAt[0]]) && !_msTrim(built.values[keyAt[1]])) return true;

    dest.getRange(dest.getLastRow() + 1, 1, 1, width).setValues([built.values]);
    if (built.unmapped.length) {
      console.log('onMaterialsFormSubmit: no form answer for column(s) "'
        + built.unmapped.join('", "') + '" — appended blank. Expected for columns filled in by '
        + 'hand after submission; the reconcile carries whatever the source ends up holding.');
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}

// The old path, kept as the fallback: read the submitted row back out of the source sheet. It
// pays the ~130 s bind, which is why it is no longer what runs first — but it sees the sheet as
// it is, so it is the right answer whenever the event mapping cannot be trusted.
function _msSubmitFromSource(e) {
  if (!e.range) return;
  var source = e.range.getSheet();
  if (source.getName() !== SOURCE_SHEET_NAME) return;
  var row = e.range.getRow();
  if (row < 2) return;
  var lastCol = source.getLastColumn();
  var headers = source.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = source.getRange(row, 1, 1, lastCol).getValues();
  var keyIdx = _msKeyIdx(headers);
  if (_msIsBlankKey(values[0], keyIdx)) return;        // no lot and no part = nothing to sync

  // Only now. Everything above is the slow part and none of it touches the destination, so
  // there is nothing for the lock to protect until here.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;                    // sweep is mid-write; let it carry the row
  try {
    var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];
    if (!_msHeadersMatch(dest, headers)) { _msSetPointer(0); return; }   // let the sweep rebuild
    dest.getRange(dest.getLastRow() + 1, 1, 1, headers.length).setValues(values);
  } finally {
    lock.releaseLock();
  }
}

function _msHeadersMatch(dest, srcHeaders) {
  if (dest.getLastRow() < 1) return false;
  var destHeaders = dest.getRange(1, 1, 1, dest.getLastColumn()).getValues()[0];
  if (destHeaders.length !== srcHeaders.length) return false;
  for (var i = 0; i < srcHeaders.length; i++) if (destHeaders[i] !== srcHeaders[i]) return false;
  return true;
}


// ── Reading the source without materialising the workbook ─────────────────
// Established 2026-09-11 by msProbeSheetsApi, over the 500 most recent rows: the REST read agrees
// with getValues() on every key and every signature cell, and costs 1.6s against a bind measured
// at 0s, 1s, 149s, and — on the five executions killed on 9/10 — more than 361s. The bind is the
// only thing in this script that can pass the six-minute wall, because it is a blocking call with
// no clock inside it; every budget guard here sits after it and was never reached.
//
// The SOURCE moves to REST and the destination does not. The destination opens by id in ~200 ms
// and is the side that gets written, which none of this writes.
//
// Falls back to the old SpreadsheetApp read when SOURCE_SS_ID is unset or the advanced service is
// missing, so pasting this file without doing the two setup steps changes nothing.
function _msRestAvailable() { return !!SOURCE_SS_ID && typeof Sheets !== 'undefined'; }

function _msColLetter(n) {
  var s = '', r;
  while (n > 0) { r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
  return s;
}
function _msSheetA1(sheet) { return "'" + String(sheet).replace(/'/g, "''") + "'!"; }
function _msRangeA1(sheet, r1, c1, nr, nc) {
  return _msSheetA1(sheet) + _msColLetter(c1) + r1 + ':' + _msColLetter(c1 + nc - 1) + (r1 + nr - 1);
}
function _msColRangeA1(sheet, c) {
  return _msSheetA1(sheet) + _msColLetter(c) + ':' + _msColLetter(c);
}

// UNFORMATTED_VALUE keeps numbers as numbers — getValues() gives 350, and FORMATTED_VALUE would
// give "350.00", which _msNorm cannot reconcile with it. FORMATTED_STRING is then the only date
// rendering that does not require rebuilding the spreadsheet's timezone and DST by hand:
// SERIAL_NUMBER cannot be told apart from a quantity, and an offset wrong by an hour breaks the
// dedupe key, which IS the timestamp.
var MS_RENDER = { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' };
function _msApiGet(a1) {
  return Sheets.Spreadsheets.Values.get(SOURCE_SS_ID, a1, MS_RENDER).values || [];
}

// The string back to the Date that getValues() would have handed us. _msEventStamp is reused
// rather than copied: it is the submit path's parser and it validates by round-tripping through
// the script timezone, so a cell the sheet renders unexpectedly returns null instead of a
// confidently wrong instant.
function _msApiDate(v) {
  var d = _msEventStamp(v);
  if (d) return d;
  // A date-only column carries no time for that regex to find. Same round-trip, fewer fields.
  var s = _msTrim(v), m = s && s.match(/^(\d{1,2})\D+(\d{1,2})\D+(\d{2,4})$/);
  if (!m) return null;
  var y = +m[3]; if (y < 100) y += 2000;
  var dd = new Date(y, +m[1] - 1, +m[2]);
  if (isNaN(dd.getTime())) return null;
  return Utilities.formatDate(dd, Session.getScriptTimeZone(), 'M/d/yyyy')
    === (+m[1]) + '/' + (+m[2]) + '/' + y ? dd : null;
}

// The API omits trailing empty cells and trailing empty rows; getValues() pads them. Every caller
// here indexes by column, so that padding is not cosmetic. colOffset is the 0-based sheet column
// the rectangle starts at, because dateCols is keyed on the sheet's columns, not the read's.
function _msApiShape(rows, nr, nc, dateCols, colOffset) {
  var out = [], i, j, r, v, d;
  colOffset = colOffset || 0;
  for (i = 0; i < nr; i++) {
    r = [];
    for (j = 0; j < nc; j++) {
      v = (rows[i] && rows[i][j] !== undefined && rows[i][j] !== null) ? rows[i][j] : '';
      if (dateCols[colOffset + j] && v !== '') { d = _msApiDate(v); if (d) v = d; }
      r.push(v);
    }
    out.push(r);
  }
  return out;
}

// Which columns hold dates is asked of the DESTINATION: it is the side the comparison has to agree
// with, and it is already open. Sampled over many rows, because a blank date cell in whichever row
// you happened to pick would retire the whole column.
function _msDateCols(dest, sample) {
  var last = dest.getLastRow();
  // An empty destination has nothing to teach. Column 0 is the Form timestamp positionally, which
  // is the one thing about this sheet's shape that Forms guarantees.
  if (last < 2) return { 0: true };
  var w = dest.getLastColumn(), n = Math.min(sample || 200, last - 1);
  var vals = dest.getRange(last - n + 1, 1, n, w).getValues(), out = {}, i, j;
  for (i = 0; i < vals.length; i++)
    for (j = 0; j < w; j++) if (vals[i][j] instanceof Date) out[j] = true;
  return out;
}

// A stand-in for a Sheet offering only what this file asks of the source: where the data ends, how
// wide it is, its headers, and a rectangle of values. The window and diff helpers below take one
// of these rather than a Sheet, so one body of code serves the REST source and the SpreadsheetApp
// destination without knowing which it holds.
function _msSheetReader(sheet) {
  return {
    lastRow: function() { return sheet.getLastRow(); },
    width: function() { return sheet.getLastColumn(); },
    headers: function() { return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]; },
    values: function(row, col, nr, nc) { return sheet.getRange(row, col, nr, nc).getValues(); }
  };
}

function _msRestReader(dateCols) {
  var headers = null, last = null;
  function hdrs() {
    if (headers === null) headers = _msApiGet(_msSheetA1(SOURCE_SHEET_NAME) + '1:1')[0] || [];
    return headers;
  }
  return {
    headers: hdrs,
    width: function() { return hdrs().length; },
    // NOT what getLastRow() answers, and the gap is not a rounding error. getLastRow() counts a
    // cell with any content at all, and the five (Check) formulas are filled down ~700 rows past
    // the last submission. Measured 2026-09-11: columns A, C and D all end at 24,613 while
    // getLastRow() says 25,313. Values.get trims trailing empties, so a column's length IS its
    // last populated row — which makes those three lengths proof that no row past 24,613 carries
    // a timestamp, a lot or a part, not merely a sample that found none. The furthest of the
    // three, not column A alone: a row with a blank timestamp but a lot and a part is still a pick.
    lastRow: function() {
      if (last !== null) return last;
      var idx = _msKeyIdx(hdrs()), ranges = [_msColRangeA1(SOURCE_SHEET_NAME, 1)], i, n;
      for (i = 0; i < idx.length; i++) ranges.push(_msColRangeA1(SOURCE_SHEET_NAME, idx[i] + 1));
      var res = Sheets.Spreadsheets.Values.batchGet(SOURCE_SS_ID, {
        ranges: ranges,
        valueRenderOption: MS_RENDER.valueRenderOption,
        dateTimeRenderOption: MS_RENDER.dateTimeRenderOption
      });
      var vr = res.valueRanges || [];
      last = 0;
      for (i = 0; i < vr.length; i++) { n = (vr[i].values || []).length; if (n > last) last = n; }
      return last;
    },
    values: function(row, col, nr, nc) {
      return _msApiShape(_msApiGet(_msRangeA1(SOURCE_SHEET_NAME, row, col, nr, nc)),
                         nr, nc, dateCols, col - 1);
    }
  };
}

// The source, read the fast way where it is configured and the old way where it is not.
function _msSourceReader(dest) {
  if (_msRestAvailable()) return _msRestReader(_msDateCols(dest, 200));
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SOURCE_SHEET_NAME);
  return sheet ? _msSheetReader(sheet) : null;
}

// ── The sweep ─────────────────────────────────────────────────────────────
function syncMaterials() {
  var started = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;            // another run holds it; next trigger will do
  try {
    // Destination first, and not only because it is the cheap one: the source reader asks it
    // which columns hold dates.
    var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];
    var source = _msSourceReader(dest);
    if (!source) { console.warn('Source sheet "' + SOURCE_SHEET_NAME + '" not found'); return; }

    var srcLastCol = source.width(), srcLastRow = source.lastRow();
    // Always logged, because it is the number that decides whether a run lives or dies and it
    // was previously invisible — a sweep with nothing to copy printed NOTHING, so the only clue
    // was a gap before the reconcile's first line. It also names which path ran, which is the
    // one thing duration cannot tell you: 1.6s over REST and 149s through the bind both look
    // like "fast" next to a 361s kill.
    var openMs = Date.now() - started;
    console.log('Source ready: ' + openMs + ' ms via ' + (_msRestAvailable() ? 'REST' : 'bind')
      + ' (' + srcLastRow + ' rows).');
    // Kept for the fallback path, where opening the source can still eat the budget on its own.
    // Returning now leaves the pointer untouched, so the next trigger resumes exactly where this
    // one would have.
    if (openMs > MAX_RUNTIME_MS) {
      console.log('Opening the source alone exceeded the ' + (MAX_RUNTIME_MS / 60000)
        + ' min budget; skipping this sweep. Nothing lost — the pointer is unchanged.');
      return;
    }
    if (srcLastRow < 2) return;
    var srcHeaders = source.headers();
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
    //
    // The move to REST trips this once, by design. The old read walked to getLastRow(), which
    // counts the filled-down (Check) formulas, so the pointer has been parked ~700 rows past the
    // last submission; the reader's end is the real one, so the first run after the switch
    // re-sweeps from the top. It appends nothing — `seen` is built from the whole destination —
    // and costs one pass of 500-row reads, resumable like any other. After that the pointer sits
    // on a real row and stays there.
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
      var block = source.values(row, 1, count, srcLastCol);
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
      console.log('Stopped at the ' + (MAX_RUNTIME_MS / 60000) + ' min mark with ' + (srcLastRow - row + 1)
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
  if (v instanceof Date) return String(Math.round(v.getTime() / 1000));   // seconds: see _msStamp
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

function _msWindowRows(reader, cutoffMs) {
  var last = reader.lastRow();
  if (last < 2) return [];
  var floorRow = Math.max(2, last - MS_TAIL_SCAN_MAX + 1);
  var out = [], row = last, start, vals, hit, i, t;
  while (row >= floorRow) {
    start = Math.max(floorRow, row - MS_TAIL_BLOCK + 1);
    vals = reader.values(start, 1, row - start + 1, 1);
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
function _msFullRows(reader, items, width) {
  var rows = [], i;
  for (i = 0; i < items.length; i++) rows.push(items[i].row);
  rows.sort(function(a, b) { return a - b; });
  var runs = _msMergeRuns(rows, MS_RUN_GAP), byRow = {}, r, block;
  for (r = 0; r < runs.length; r++) {
    block = reader.values(runs[r].start, 1, runs[r].count, width);
    for (i = 0; i < block.length; i++) byRow[runs[r].start + i] = block[i];
  }
  var out = [];
  for (i = 0; i < items.length; i++) out.push(byRow[items[i].row] || items[i].values);
  return out;
}

// Shared by the audit and the repair. Returns what differs; writes nothing.
function _msDiff(days) {
  var dest = SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0];
  var source = _msSourceReader(dest);
  if (!source) throw new Error('Source sheet "' + SOURCE_SHEET_NAME + '" not found');
  var destR = _msSheetReader(dest);
  var width = source.width();
  var srcHeaders = source.headers();
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
  var destRows = _msWindowRows(destR, cutoffMs);
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
  function loadWindow(reader, rows, label) {
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
        block = reader.values(runs[r].start, colRun.start + 1, runs[r].count, colRun.len);
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
  var dst = loadWindow(destR, destRows, 'Destination');
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
           headers: srcHeaders, sigCols: sigCols, src: src, dst: dst,
           missing: missing, stale: stale };
}

function _msWhen(v) {
  // Dates normalise to epoch ms for comparison; a log line wants the date back.
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'M/d/yy HH:mm:ss');
  return _msNorm(v);
}
function _msDescribe(r, keyIdx) {
  return _msWhen(r.values[0]) + ' \u00b7 lot ' + _msNorm(r.values[keyIdx[0]])
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
// deadline: absolute ms timestamp this must not work past. Optional — a manual
// reconcileMaterialsNow() gets its own full 6-minute execution and passes nothing.
//
// It needed one because it had none: syncMaterialsAndReconcile could start it with two minutes
// left and _msDiff plus a deleteRows loop would run straight through the wall, losing the whole
// execution. Safe to stop midway — appends land past the last row and the delete ranges are
// descending, so nothing shifts under the loop, and the next trigger recomputes the diff and
// finishes the job.
function reconcileMaterials(days, force, deadline) {
  if (!deadline) deadline = Date.now() + MS_WALL_MS - MS_SAFETY_MS;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { console.log('Sync is mid-write; skipping this reconcile.'); return; }
  try {
    var d = _msDiff(days), i, n = 0;
    if (Date.now() > deadline) {
      console.log('Reconcile: the diff alone used the budget; repairs deferred to the next trigger.');
      return;
    }
    if (!d.missing.length && !d.stale.length) return;
    if (d.stale.length > MS_MAX_DELETE && !force) {
      console.error('Reconcile stopped: ' + d.stale.length + ' destination row(s) would be deleted, '
        + 'over the ' + MS_MAX_DELETE + ' ceiling. Run auditMaterialsSync() and, if it is genuinely '
        + 'right, reconcileMaterials(days, true).');
      return;
    }
    // APPEND FIRST, then delete. Both orders can be interrupted — by the six-minute wall, by a
    // failed write — and they fail differently. Deleting first and dying loses 73 rows outright.
    // Appending first and dying leaves duplicates, which the next audit sees as stale and
    // clears. One failure mode needs a restore from a backup; the other repairs itself.
    // Appends land past the last row, so they never shift the row numbers queued for deletion.
    if (d.missing.length) {
      // The compare skipped the formula columns, so those cells are holes in what it read.
      // Fetch the rows about to be appended at full width — a handful of rows, unlike the
      // window — so the mirror carries the same values a human sees in the source rather than
      // blanks in the middle of every repaired row.
      var vals = _msFullRows(d.source, d.missing, d.width);
      d.dest.getRange(d.dest.getLastRow() + 1, 1, vals.length, d.width).setValues(vals);
    }
    var ranges = _msDeleteRanges(d.stale), deferred = 0;
    for (i = 0; i < ranges.length; i++) {
      // deleteRows is the slowest call here and the count is unbounded, so the clock is checked
      // every range rather than once at the top.
      if (Date.now() > deadline) { deferred = ranges.length - i; break; }
      d.dest.deleteRows(ranges[i].start, ranges[i].count); n += ranges[i].count;
    }
    if (deferred) console.log('Reconcile stopped ' + deferred + ' delete range(s) short of the budget; the next trigger finishes them.');
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

// ── Which column drifted, and does it matter ──────────────────────────────
// The audit reports that a row differs. It cannot report WHY without printing every column of
// every row, which is unreadable at 73 rows. This pairs each stale destination row with the
// source row carrying the same timestamp + lot + part and names only the columns that differ,
// with both values.
//
// Run it before ever forcing a reconcile past the deletion ceiling. A column that differs on
// every row is a normalisation artefact in this script and must be fixed here; a column that
// differs on a scattered few is people correcting the sheet, and those are the repairs the
// reconcile exists to carry.
function explainMaterialsDrift(days, cap) {
  var d = _msDiff(days || MS_RECONCILE_DAYS), i, j, c;
  cap = cap || 15;
  var bySig = {}, srcIx = {};
  for (i = 0; i < d.src.length; i++) {
    var sk = _msNorm(d.src[i].values[0]) + '||' + _msNorm(d.src[i].values[d.keyIdx[0]])
           + '||' + _msNorm(d.src[i].values[d.keyIdx[1]]);
    if (!srcIx[sk]) srcIx[sk] = [];
    srcIx[sk].push(d.src[i]);
  }
  var byRow = {};
  for (i = 0; i < d.dst.length; i++) byRow[d.dst[i].row] = d.dst[i];

  var tally = {}, unmatched = 0, shown = 0;
  for (i = 0; i < d.stale.length; i++) {
    var dr = byRow[d.stale[i]];
    if (!dr) continue;
    var k = _msNorm(dr.values[0]) + '||' + _msNorm(dr.values[d.keyIdx[0]])
          + '||' + _msNorm(dr.values[d.keyIdx[1]]);
    var cands = srcIx[k];
    if (!cands || !cands.length) {
      unmatched++;
      if (shown < cap) { console.log('dest row ' + dr.row + ': ' + _msDescribe(dr, d.keyIdx)
        + ' — NO source row with this timestamp + lot + part (deleted or re-keyed at source)'); shown++; }
      continue;
    }
    var sr = cands[0], diffs = [];
    for (j = 0; j < d.sigCols.length; j++) {
      c = d.sigCols[j];
      if (_msNorm(dr.values[c]) !== _msNorm(sr.values[c])) {
        diffs.push({ col: c, dest: _msNorm(dr.values[c]), src: _msNorm(sr.values[c]) });
        tally[d.headers[c]] = (tally[d.headers[c]] || 0) + 1;
      }
    }
    if (shown < cap) {
      var parts = [];
      for (j = 0; j < diffs.length; j++) {
        parts.push('"' + d.headers[diffs[j].col] + '" dest=[' + diffs[j].dest + '] src=[' + diffs[j].src + ']');
      }
      console.log('dest row ' + dr.row + ' vs src row ' + sr.row + ': ' + parts.join('  |  '));
      shown++;
    }
  }
  console.log('--- columns that differ, across all ' + d.stale.length + ' stale row(s) ---');
  var names = [];
  for (var h in tally) if (tally.hasOwnProperty(h)) names.push(h);
  names.sort(function(a, b) { return tally[b] - tally[a]; });
  for (i = 0; i < names.length; i++) console.log('  ' + tally[names[i]] + ' x  "' + names[i] + '"');
  if (unmatched) console.log('  ' + unmatched + ' stale row(s) have no source row at all.');
}

// What is actually installed. The two paths need two triggers with different event sources,
// and the difference between "the sweep is scheduled" and "the sweep exists in this file" is
// invisible from the editor until you look.
function msListTriggers() {
  var t = ScriptApp.getProjectTriggers(), i, hasSweep = false, hasSubmit = false;
  if (!t.length) { console.warn('No triggers installed at all.'); }
  for (i = 0; i < t.length; i++) {
    var fn = t[i].getHandlerFunction(), src = String(t[i].getEventType());
    console.log(fn + '  —  ' + src + ' / ' + String(t[i].getTriggerSource()));
    if (fn === 'syncMaterials' || fn === 'syncMaterialsAndReconcile') hasSweep = true;
    if (fn === 'onMaterialsFormSubmit') hasSubmit = true;
  }
  if (!hasSubmit) console.warn('No onMaterialsFormSubmit trigger — nothing syncs at submit time.');
  if (!hasSweep) {
    console.warn('No time-based sweep trigger. The submit trigger is the ONLY path, and it does '
      + 'not fire on edits, on imports, or once the quota is spent — every row it misses is lost '
      + 'until something reconciles. This is the likeliest reason rows are absent from the mirror.');
  }
  console.log('Sync pointer (last source row known synced): ' + (_msGetPointer() || 'unset'));
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

// ── Can the source be read without materialising the workbook? ────────────
// The bind is the whole problem. A run that SUCCEEDED on 9/10 logged "Source bind: 149s (25231
// rows)" and finished in 176s — 85% of the execution spent before a single row was read. The five
// that died the same morning logged NOTHING AT ALL, not even that line, which is the first
// statement after getSheetByName returns: they were killed inside the bind. No budget check can
// help there, because the clock cannot be read inside a blocking call. The guards above are
// correct and they were never reached.
//
// Sheets.Spreadsheets.Values.get reads the same cells over REST. It returns what the sheet last
// computed and never asks SpreadsheetApp to materialise the workbook, so it does not pay for the
// ~126,000 (Check) formulas (25,231 rows x 5) resolving T#s against inventory, which is the most
// likely thing the 149s is buying.
//
// SPEED IS THE EASY HALF. The values have to match cell for cell first. The reconcile compares a
// source signature against a destination signature; if the API renders one cell differently from
// getValues() — a timestamp as text, a quantity as "350.00" — every row in the window reads as
// drift. Deletes are capped at MS_MAX_DELETE, but APPENDS ARE NOT, so a shape mismatch would
// re-append the entire window as duplicates and the next run would refuse to clean them up.
// This probe measures the speed AND the agreement, writes nothing, and is what has to pass
// before any read path changes.
//
// Setup, both one-time: Editor -> Services -> add "Google Sheets API" (identifier `Sheets`), and
// paste the source workbook id into SOURCE_SS_ID at the top of this file.
var MS_PROBE_ROWS = 500;

function msProbeSheetsApi() {
  if (typeof Sheets === 'undefined') {
    console.error('The Sheets advanced service is not enabled: Editor -> Services -> '
      + 'Google Sheets API. Nothing here can run without it.');
    return;
  }
  if (!SOURCE_SS_ID) {
    console.error('SOURCE_SS_ID is empty. Paste the source workbook id from its URL '
      + '(/spreadsheets/d/<id>/edit) into the constant at the top of this file.');
    return;
  }
  // Everything that does not need the workbook materialised runs FIRST and logs as it goes, so
  // that if the bind further down eats the execution, the numbers we came for are already in the
  // log. That is the failure mode this whole exercise is about.
  var t, headers, width, colA, lastRow, raw, tHdr, tCol, tTail, i, j, c;

  t = Date.now();
  headers = _msApiGet("'" + SOURCE_SHEET_NAME + "'!1:1")[0] || [];
  tHdr = Date.now() - t;
  width = headers.length;
  console.log('API headers: ' + width + ' column(s) in ' + tHdr + ' ms.');
  if (!width) { console.error('No header row came back — check the sheet name and the id.'); return; }

  t = Date.now();
  colA = _msApiGet("'" + SOURCE_SHEET_NAME + "'!A:A");
  tCol = Date.now() - t;
  lastRow = colA.length;
  console.log('API column A: last row ' + lastRow + ' in ' + tCol + ' ms.');

  // The sweep's pointer is a SOURCE ROW NUMBER, so "where does the data end" has to mean the same
  // thing however the sheet is read, or the sweep silently stops short. Column A alone is not
  // that number — a row with a blank timestamp but a lot and a part is still a pick — so ask the
  // two key columns as well and take the furthest.
  var keyIdx = _msKeyIdx(headers), restLast = lastRow, kcol, kvals, k;
  for (k = 0; k < keyIdx.length; k++) {
    kcol = _msColLetter(keyIdx[k] + 1);
    t = Date.now();
    kvals = _msApiGet("'" + SOURCE_SHEET_NAME + "'!" + kcol + ':' + kcol);
    console.log('API column ' + kcol + ' "' + headers[keyIdx[k]] + '": last row ' + kvals.length
      + ' in ' + (Date.now() - t) + ' ms.');
    if (kvals.length > restLast) restLast = kvals.length;
  }
  console.log('REST says the data ends at row ' + restLast + '.');

  var start = Math.max(2, lastRow - MS_PROBE_ROWS + 1), n = lastRow - start + 1;
  t = Date.now();
  raw = _msApiGet(_msRangeA1(SOURCE_SHEET_NAME, start, 1, n, width));
  tTail = Date.now() - t;
  console.log('API tail (' + n + ' x ' + width + ' from row ' + start + '): ' + tTail + ' ms.');
  console.log('API total: ' + (tHdr + tCol + tTail) + ' ms — against the 149s bind a successful '
    + 'run pays before it reads anything.');

  var dateCols = _msDateCols(SpreadsheetApp.openById(DEST_SHEET_ID).getSheets()[0], 200), dcList = [];
  for (c = 0; c < width; c++) if (dateCols[c]) dcList.push(c + ' "' + headers[c] + '"');
  console.log('Date columns, per the destination: ' + (dcList.join(', ') || 'none'));

  var api = _msApiShape(raw, n, width, dateCols, 0);

  // ── The half that actually decides it ──
  // Pay the bind once and read the same rectangle the slow way. A single normalised cell that
  // differs is a row the reconcile would read as drift.
  t = Date.now();
  var src = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SOURCE_SHEET_NAME);
  console.log('SpreadsheetApp bind: ' + Math.round((Date.now() - t) / 1000) + 's.');
  if (!src) { console.error('Source sheet "' + SOURCE_SHEET_NAME + '" not found.'); return; }
  t = Date.now();
  var live = src.getRange(start, 1, n, Math.min(width, src.getLastColumn())).getValues();
  console.log('getValues() on the same rectangle: ' + (Date.now() - t) + ' ms.');

  // getLastRow() counts a cell with ANY content, and the five (Check) columns are formulas that
  // may be filled down well past the last submission — the same shape the production sheet has,
  // where ~1,340 trailing rows compute #REF! off a blank lot. If the gap rows carry a lot or a
  // part they are real picks and a REST row count would skip them; if they carry neither, then
  // getLastRow() is the inflated number and the sweep has been paying for rows that are not there.
  var liveLast = src.getLastRow();
  console.log('getLastRow(): ' + liveLast + '  vs REST: ' + restLast + '.');
  if (liveLast > restLast) {
    var gapN = Math.min(liveLast - restLast, 50);
    var gap = _msApiShape(_msApiGet(_msRangeA1(SOURCE_SHEET_NAME, restLast + 1, 1, gapN, width)),
                          gapN, width, {}, 0);
    var withKey = 0, g;
    for (g = 0; g < gapN; g++) {
      if (_msIsBlankKey(gap[g], keyIdx)) continue;
      withKey++;
      if (withKey <= 5) console.warn('gap row ' + (restLast + 1 + g) + ' HAS a key: '
        + _msDescribe({ values: gap[g] }, keyIdx));
    }
    console.log('Gap rows ' + (restLast + 1) + '-' + liveLast + ': checked ' + gapN + ', '
      + withKey + ' carry a lot or a part. ' + (withKey
        ? 'A REST row count would skip real picks — it cannot be the end of the sweep.'
        : 'Neither, so these are filled-down formulas and not submissions.'));
  }

  var sigCols = _msSigCols(headers, width);
  var keyBad = 0, rowBad = 0, cellBad = 0, a, b;
  for (i = 0; i < n; i++) {
    if (_msKeyOf(api[i], keyIdx) !== _msKeyOf(live[i], keyIdx)) {
      keyBad++;
      if (keyBad <= 5) console.warn('row ' + (start + i) + ' KEY differs\n  api  '
        + _msKeyOf(api[i], keyIdx) + '\n  live ' + _msKeyOf(live[i], keyIdx));
    }
    if (_msSig(api[i], sigCols) === _msSig(live[i], sigCols)) continue;
    rowBad++;
    for (j = 0; j < sigCols.length; j++) {
      a = _msNorm(api[i][sigCols[j]]); b = _msNorm(live[i][sigCols[j]]);
      if (a === b) continue;
      cellBad++;
      if (cellBad <= 15) console.warn('row ' + (start + i) + ' col ' + sigCols[j] + ' "'
        + headers[sigCols[j]] + '": api ' + JSON.stringify(a) + '  vs live ' + JSON.stringify(b));
    }
  }
  console.log(n + ' row(s) compared: ' + (n - keyBad) + ' key(s) agree, ' + rowBad
    + ' row(s) differ on ' + cellBad + ' cell(s).');
  console.log((keyBad || cellBad)
    ? 'DO NOT change the read path until both are nil. A signature mismatch re-appends the whole '
      + 'window as duplicates, and appends have no ceiling the way deletes have MS_MAX_DELETE.'
    : 'Shapes agree. The REST read is a drop-in for the source side.');
}

// The editor's Run button cannot pass arguments, so the two you click from the dropdown
// take none and use the default window.
function auditMaterialsNow() { auditMaterialsSync(MS_RECONCILE_DAYS); }
function reconcileMaterialsNow() { reconcileMaterials(MS_RECONCILE_DAYS); }
function explainMaterialsDriftNow() { explainMaterialsDrift(MS_RECONCILE_DAYS, 15); }
// Lifts the deletion ceiling. Only after explainMaterialsDrift has shown what those rows are,
// and only with a copy of the destination sheet saved.
function reconcileMaterialsForceNow() { reconcileMaterials(MS_RECONCILE_DAYS, true); }

// Point the time-based trigger at this instead of syncMaterials: copy new rows, then repair the
// last few days. The short window keeps it to two narrow reads when nothing has drifted, which
// is almost always.
function syncMaterialsAndReconcile() {
  var t0 = Date.now();
  syncMaterials();
  // The sweep is allowed to run to 4.5 minutes. Starting a reconcile after one of those walks
  // straight into the 6-minute wall and loses both. A backlog run gets the sweep to itself; the
  // next trigger, with nothing left to copy, does the reconcile.
  //
  // The threshold is 4 minutes, not the 1 it was, because on this source the first touch of the
  // spreadsheet — getSheetByName, before a single row is read — measures ~130s while every read
  // after it is ~2s. Both functions in this run share that one bind, so the reconcile costs
  // seconds when it follows the sweep. At 1 minute the guard fired on the bind alone and the
  // reconcile would never once have run.
  // Deferral threshold derived from the wall rather than hand-picked: only start a reconcile if
  // there is more than the safety margin left to do it in. At the old flat 240000 a sweep could
  // finish at 239s and hand the reconcile 76s of real headroom, which is not enough for a diff
  // plus a delete loop — that is the 6 min 1 s kill.
  var elapsed = Date.now() - t0;
  var deadline = t0 + MS_WALL_MS - MS_SAFETY_MS;
  if (Date.now() > deadline - 60000) {
    console.log('Sweep took ' + Math.round(elapsed / 1000) + 's; reconcile deferred to the next trigger.');
    return;
  }
  // Same deadline, so both steps answer to one clock started at the top of this execution.
  try { reconcileMaterials(3, false, deadline); } catch (err) { console.error('reconcile step: ' + err); }
}
