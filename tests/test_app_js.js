// Logic checks for app.js — no browser needed.
//   osascript -l JavaScript tests/test_app_js.js      (macOS, no install)
//   node tests/test_app_js.js                          (if node is available)
//
// app.js runs against a stubbed DOM that RECORDS event listeners, so handler
// accumulation is directly observable. fetch never resolves, which parks init()
// at its first await and leaves the tests in full control.
function main(src) {
  var fields = {};

  function makeClassList() {
    var set = {};
    return {
      add(c) { set[c] = true; }, remove(c) { delete set[c]; },
      contains(c) { return !!set[c]; },
      toggle(c, force) {
        var on = force === undefined ? !set[c] : !!force;
        if (on) set[c] = true; else delete set[c];
        return on;
      },
    };
  }

  // Records listeners the way the DOM does: adding the same (type, fn) twice
  // registers once. That is what makes stable named handlers leak-proof.
  function listenerBag() {
    var list = [];
    return {
      list: list,
      add(type, fn) {
        if (!list.some(l => l.type === type && l.fn === fn)) list.push({ type: type, fn: fn });
      },
      remove(type, fn) {
        for (var i = list.length - 1; i >= 0; i--)
          if (list[i].type === type && list[i].fn === fn) list.splice(i, 1);
      },
      count(type) { return list.filter(l => type ? l.type === type : true).length; },
    };
  }

  function el(id) {
    var bag = listenerBag();
    return {
      id: id, _bag: bag, style: {}, dataset: {}, checked: false,
      innerHTML: '', textContent: '', classList: makeClassList(),
      get value() { return fields[id] !== undefined ? fields[id] : ''; },
      set value(v) { fields[id] = String(v); },
      addEventListener(t, f) { bag.add(t, f); },
      removeEventListener(t, f) { bag.remove(t, f); },
      querySelectorAll() { return []; }, querySelector() { return null; },
      appendChild() {}, remove() {}, contains() { return false; },
    };
  }

  var docBag = listenerBag();
  var document = {
    _els: {}, body: { appendChild() {} },
    getElementById(id) { return this._els[id] || (this._els[id] = el(id)); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    createElement() { return el('tmp'); },
    addEventListener(t, f) { docBag.add(t, f); },
    removeEventListener(t, f) { docBag.remove(t, f); },
    get title() { return ''; }, set title(v) {},
  };
  var window = {}, navigator = { clipboard: { writeText() {} } }, console = { log() {}, error() {} };
  var toasts = [];
  var setInterval = function () { return 0; }, clearInterval = function () {};
  var setTimeout = function (fn) { fn(); return 0; };   // run deferred work now
  var confirmAnswer = true, confirmAsked = 0, reloads = 0;
  var confirm  = function () { confirmAsked++; return confirmAnswer; };
  var location = { reload: function () { reloads++; } };
  var fetchCalls = [];
  var fetch = function (url, opts) {           // never settles; records what was asked
    fetchCalls.push({ url: url, method: (opts && opts.method) || 'GET' });
    return new Promise(function () {});
  };

  var api = new Function(
    'document', 'window', 'navigator', 'console', 'fetch',
    'setInterval', 'clearInterval', 'setTimeout', '__toasts', 'confirm', 'location',
    src + `
    showToast = function (m, isErr) { __toasts.push({ msg: m, error: !!isErr }); };
    return {
      set punches(v) { punches = v; }, get punches() { return punches; },
      set newPunchInProgress(v) { newPunchInProgress = v; },
      set editingRow(v) { editingRow = v; }, get editingRow() { return editingRow; },
      set lastModifiedTs(v) { lastModifiedTs = v; },
      set resumeSnapshot(v) { resumeSnapshot = v; },
      set resumeRoList(v) { resumeRoList = v; }, get resumeRoList() { return resumeRoList; },
      set deferredExternalChange(v) { deferredExternalChange = v; },
      get formDirty() { return formDirty; },
      lastPunchIdx, openPunchIdx, activePunchIdx, isOpenStatus,
      currentDayDate, todayISO, readForm, buildCopyText, buildCopyTextFromForm,
      refreshDecision, markFormDirty, clearFormDirty, wireFormListeners,
      setFormValues, clearForm, offerResume, launchPunch, handleGlobalKeydown, reloadApp,
      checkResumeFromPunches, declineResume, startNewPunch, abandonNewPunch,
      togglePunchLauncher, closePunchLauncher,
    };`
  )(document, window, navigator, console, fetch, setInterval, clearInterval, setTimeout, toasts,
    confirm, location);

  var passed = 0, failed = 0, out = [];
  function check(label, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) { passed++; out.push('  PASS  ' + label); }
    else { failed++; out.push('  FAIL  ' + label + '\n          got:  ' + JSON.stringify(got) + '\n          want: ' + JSON.stringify(want)); }
  }

  var W = { time: '08:00', status: 'W', ro: '295204', date: '2026-09-02' };
  var C = { time: '17:00', status: 'C', description: 'Home time', date: '2026-09-02' };
  var B = { time: '12:00', status: 'B', description: 'Lunch time', date: '2026-09-02' };

  out.push('\nPunch state');
  api.newPunchInProgress = false;
  api.punches = [];
  check('empty sheet has no last punch', api.lastPunchIdx(), null);
  check('empty sheet has no active punch', api.activePunchIdx(), null);
  api.punches = [W, B, W];
  check('last open W is the active punch', api.activePunchIdx(), 2);
  check('  ...and the running job', api.openPunchIdx(), 2);
  api.punches = [W, C];
  check('after clocking out nothing is active', api.activePunchIdx(), null);
  check('  ...but the form still edits the last row', api.lastPunchIdx(), 1);
  api.punches = [W, B];
  check('lunch is not an active punch', api.activePunchIdx(), null);

  out.push('\nThe "save twice" bug');
  api.punches = [W, B, W];
  api.newPunchInProgress = true;
  check('while filling a new punch, no card is active', api.activePunchIdx(), null);
  api.newPunchInProgress = false;
  check('once the flag drops, the last card is active on the first save', api.activePunchIdx(), 2);

  out.push('\nDates');
  api.punches = [];
  check('empty sheet falls back to today', api.currentDayDate(), api.todayISO());
  api.punches = [{ time: '08:00', status: 'W', date: '' }];
  check('a blank sheet date falls back to today', api.currentDayDate(), api.todayISO());
  api.punches = [W];
  check('otherwise the sheet date wins', api.currentDayDate(), '2026-09-02');

  out.push('\nreadForm / copy text');
  fields['f-time'] = '09:15'; fields['f-status'] = 'DW';
  fields['f-ro'] = ' 295204 '; fields['f-line'] = ' b ';
  fields['f-desc'] = ' Airbag Light On '; fields['f-opcode'] = ' SA-99 ';
  fields['f-ref'] = '200092889'; fields['f-odo'] = ' 22399 ';
  fields['f-story'] = 'Scanned for faults.';
  var f = api.readForm();
  check('trims the RO', f.ro, '295204');
  check('upper-cases the line', f.line, 'B');
  check('carries line (switchTab used to drop it)', 'line' in f, true);
  check('carries odometer (switchTab used to drop it)', f.odometer, '22399');
  api.punches = [W];
  check('copy text is built from the same reader', api.buildCopyTextFromForm(),
        '2026-09-02, 09:15 - DW, SA-99 - Airbag Light On - Ticket: 200092889\nScanned for faults.');

  // The poll used to compute formDirty as `value !== '' && editingRow === null`.
  // editingRow is non-null whenever a punch is loaded, so that was ALWAYS false
  // and every tick overwrote the form.
  out.push('\nExternal-change poll');
  api.lastModifiedTs = 0;
  check('first tick just adopts the timestamp', api.refreshDecision(1000), 'adopt');
  api.lastModifiedTs = 1000;
  check('same mtime does nothing', api.refreshDecision(1000), 'unchanged');
  check('older mtime does nothing', api.refreshDecision(900), 'unchanged');
  api.clearFormDirty();
  check('newer mtime refreshes when the form is clean', api.refreshDecision(2000), 'refresh');
  api.markFormDirty();
  check('newer mtime DEFERS while the form has unsaved edits', api.refreshDecision(2000), 'defer');
  api.editingRow = 0;   // the state the old condition silently tripped on
  check('  ...still defers with a punch loaded', api.refreshDecision(2000), 'defer');
  api.clearFormDirty();
  check('  ...and refreshes again once saved', api.refreshDecision(2000), 'refresh');

  out.push('\nDirty tracking');
  api.setFormValues(W);
  check('loading a punch into the form clears dirty', api.formDirty, false);
  api.wireFormListeners();
  var storyEl = document._els['f-story'];
  storyEl._bag.list.filter(l => l.type === 'input').forEach(l => l.fn());
  check('typing marks the form dirty', api.formDirty, true);
  api.clearForm();
  check('clearing the form clears dirty', api.formDirty, false);
  var warrantyEl = document._els['f-warranty'];
  check('the warranty checkbox is wired too (the preview used to go stale)',
        warrantyEl._bag.count('change') > 0, true);

  // Handler accumulation: initResumeRoPicker() used to run on every resume.
  out.push('\nListener accumulation');
  var roSpan = document._els['resumeRoNumber'];
  check('resume picker wired once at startup', roSpan._bag.count('wheel'), 1);
  api.resumeSnapshot = { status: 'W', ro: '295204' };
  api.resumeRoList = [{ ro: '295204' }, { ro: '298500' }];
  for (var i = 0; i < 5; i++) api.offerResume('W');
  check('  ...still once after five resumes', roSpan._bag.count('wheel'), 1);
  check('  ...and no stacked hover handlers', roSpan._bag.count('mouseenter'), 1);

  var before = docBag.count('click');
  for (var j = 0; j < 5; j++) { api.togglePunchLauncher(); api.closePunchLauncher(); }
  check('punch launcher leaves nothing behind', docBag.count('click'), before);
  api.togglePunchLauncher();
  check('  ...one handler while open', docBag.count('click'), before + 1);
  api.closePunchLauncher();
  check('  ...removed on close', docBag.count('click'), before);

  // launchPunch() used to call deselectPunch() — which reloads the form from
  // `punches` — BEFORE auto-saving, so every "+ New Punch" click threw away
  // whatever had been typed into the punch in progress.
  // autoSaveActivePunch() does its capture synchronously, before its first
  // await, so the ordering is observable without draining microtasks.
  out.push('\nNew Punch keeps unsaved edits');
  api.punches = [{ row: 2, date: '2026-09-02', time: '08:00', status: 'W', ro: '295204',
                   line: 'A', description: 'Stored desc', opcode: '', refid: '',
                   odometer: '', warranty: '', story: 'Stored story' }];
  api.editingRow = 0;
  api.newPunchInProgress = false;
  api.setFormValues(api.punches[0]);
  fields['f-desc']  = 'EDITED desc';      // typed, not yet saved
  fields['f-story'] = 'EDITED story';
  api.launchPunch('B');                   // fired, deliberately not awaited
  check('the edit is captured before the form reloads', api.punches[0].description, 'EDITED desc');
  check('  ...story too', api.punches[0].story, 'EDITED story');

  out.push('\nResume composes a new punch');
  api.punches = [{ row: 2, date: '2026-09-02', time: '08:00', status: 'W', ro: '295204' }];
  api.resumeSnapshot = { status: 'W', ro: '295204' };
  api.resumeRoList = [{ ro: '295204' }];
  api.editingRow = 0;                     // what deselectPunch() leaves behind
  api.offerResume('W');
  check('editingRow is cleared, so saving appends instead of overwriting',
        api.editingRow, null);

  // Ctrl+S has to work with focus anywhere in the entry tab, so it lives on
  // document rather than on the story textarea (where Ctrl+Enter still sits).
  out.push('\nCtrl+S');
  function key(over) {
    var e = { ctrlKey: false, metaKey: false, shiftKey: false, key: 's',
              prevented: false, preventDefault: function () { this.prevented = true; } };
    for (var k in over) e[k] = over[k];
    api.handleGlobalKeydown(e);
    return e;
  }
  api.punches = [];
  api.clearForm();
  fields['f-time'] = '';               // savePunch bails with a recognisable toast
  toasts.length = 0;
  var ev = key({ ctrlKey: true });
  check('the browser save dialog is suppressed', ev.prevented, true);
  check('  ...and the punch save runs', toasts.pop().msg, 'Time is required');

  toasts.length = 0;
  key({ metaKey: true, key: 'S' });
  check('Cmd+S and capital S work too', toasts.pop().msg, 'Time is required');

  toasts.length = 0;
  document.getElementById('refModal').classList.add('open');
  fields['ref-cat'] = ''; fields['ref-key'] = '';
  key({ ctrlKey: true });
  check('the Ref modal takes the shortcut over while open',
        toasts.pop().msg, 'Category and Key are required');
  document.getElementById('refModal').classList.remove('open');

  toasts.length = 0;
  key({ ctrlKey: true, key: 'x' });
  check('other Ctrl combos are left alone', toasts.length, 0);

  out.push('\nSettings dialog');
  toasts.length = 0;
  fetchCalls.length = 0;
  document.getElementById('settingsModal').classList.add('open');
  key({ ctrlKey: true });
  check('Ctrl+S in the settings dialog saves the settings',
        fetchCalls.some(function (c) { return c.url === '/api/settings' && c.method === 'PUT'; }), true);
  check('  ...and not the punch',
        toasts.some(function (t) { return t.msg === 'Time is required'; }), false);
  key({ key: 'Escape' });
  check('Escape closes the settings dialog',
        document.getElementById('settingsModal').classList.contains('open'), false);
  toasts.length = 0;
  key({ ctrlKey: true });
  check('with it closed, Ctrl+S is back to saving the punch', toasts.pop().msg, 'Time is required');

  // Reloading drops whatever is typed and not saved, and the button now sits
  // right beside the settings gear where a stray click is easy.
  out.push('\nReload');
  api.clearFormDirty(); confirmAsked = 0; reloads = 0;
  api.reloadApp();
  check('a clean form reloads straight away', [reloads, confirmAsked], [1, 0]);
  api.markFormDirty(); confirmAnswer = false; confirmAsked = 0; reloads = 0;
  api.reloadApp();
  check('unsaved edits ask first, and "no" keeps them', [reloads, confirmAsked], [0, 1]);
  confirmAnswer = true; reloads = 0;
  api.reloadApp();
  check('  ..."yes" reloads', reloads, 1);

  // "New Punch > WI", then "Fresh" on the resume offer, used to save a W punch:
  // declineResume() called clearForm(), which resets the status to W.
  out.push('\nNew punch type and resume');
  api.newPunchInProgress = false;
  api.punches = [
    { row: 2, date: '2026-09-21', time: '08:00', status: 'W', ro: '1042', odometer: '18400' },
    { row: 3, date: '2026-09-21', time: '10:30', status: 'W', ro: '1077', odometer: '31220' },
  ];
  api.checkResumeFromPunches();
  check('each resumable job keeps its own odometer',
        api.resumeRoList.map(function (e) { return e.ro + ':' + e.odometer; }),
        ['1077:31220', '1042:18400']);
  api.newPunchInProgress = true;
  api.offerResume('WI');
  check('the resume offer keeps the picked type', fields['f-status'], 'WI');
  check('  ...and prefills that job\'s odometer', fields['f-odo'], '31220');
  var wheel = document._els['resumeRoNumber']._bag.list.filter(function (l) { return l.type === 'wheel'; })[0];
  wheel.fn({ deltaY: 100, preventDefault: function () {} });
  check('scrolling to an older job brings its own odometer, not the last one',
        [fields['f-ro'], fields['f-odo']], ['1042', '18400']);
  api.declineResume();
  check('"Fresh" keeps the type picked in New Punch', fields['f-status'], 'WI');
  check('  ...and the new punch stays in progress', api.activePunchIdx(), null);
  api.abandonNewPunch();
  check('abandoning it puts the running job back as active', api.activePunchIdx(), 1);

  api.startNewPunch('DW');
  check('a new punch without a resume offer keeps its type too', fields['f-status'], 'DW');
  check('  ...and is marked in progress', api.activePunchIdx(), null);
  api.abandonNewPunch();

  out.push('\n' + passed + ' passed, ' + failed + ' failed\n');
  return { text: out.join('\n'), failed: failed };
}

if (typeof require !== 'undefined' && typeof module !== 'undefined') {
  var fs = require('fs'), path = require('path');
  var r = main(fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8'));
  console.log(r.text);
  process.exit(r.failed ? 1 : 0);
} else {
  ObjC.import('Foundation');
  // DAYPUNCH_APP_JS lets the same harness run against another copy of app.js,
  // which is how the fixes are A/B'd against the code they replaced.
  var override = $.NSProcessInfo.processInfo.environment.objectForKey('DAYPUNCH_APP_JS');
  var fm = $.NSFileManager.defaultManager;
  var cwd = fm.currentDirectoryPath.js;
  // Run from the repo root or from tests/ — resolve either way rather than
  // baking in one machine's absolute path.
  var candidates = [cwd + '/src/app.js', cwd + '/../src/app.js'];
  var target = override.js || candidates.filter(function (c) {
    return fm.fileExistsAtPath(c);
  })[0] || candidates[0];
  var p = $.NSString.stringWithContentsOfFileEncodingError(
    target, $.NSUTF8StringEncoding, null).js;
  var r = main(p);
  r.text + (r.failed ? 'FAILURES\n' : '');
}
