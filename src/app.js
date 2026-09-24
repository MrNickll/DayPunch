// DayPunch — Copyright 2026 Nicolas Lapointe Lafortune. Licensed under the Apache License 2.0.
// DayPunch app.js
// ── State ─────────────────────────────────────────────────────────────────────
let punches      = [];
let opcodes      = [];
let templates    = [];
let refNotes     = [];
let selectedRow  = null;
let editingRow   = null;
let currentFile  = null;
let holdUnit     = 'hrs';
let lastModifiedTs = 0;
let pollInterval   = null;
let carryoverData  = null;
let resumeSnapshot = null;
let resumeRoList = [];          // Mixed list of W/DW (by RO) and WI (by opcode) punches
let resumeRoIdx = 0;            // Current index in the list
let newPunchInProgress = false;
let formDirty            = false;   // entry form holds edits not yet in `punches`
let deferredExternalChange = false; // file changed while we were holding off
let settings = { app_name: 'DayPunch', org_name: '', labels: {} };
let resumeStatus = null;
let dbWarningShown = false;         // schema warnings are shown once, not every poll             // the type picked in New Punch while "Resume?" is up

// ── Constants ─────────────────────────────────────────────────────────────────
// Every input in the entry form, in one place: dirty tracking and the live copy
// refresh both need the full list.
const FORM_FIELDS = ['f-time', 'f-status', 'f-ro', 'f-line', 'f-desc',
                     'f-opcode', 'f-ref', 'f-odo', 'f-warranty', 'f-story'];
const TIRE_NEW_MM  = 8.0;
const TIRE_WORN_MM = 3.2;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await applySettings();
  await loadOpcodes();
  await checkDbStatus();
  await loadTemplates();
  console.log('Templates loaded:', templates.length);
  await populateFilePicker();
  await loadPunches();
  await loadRefNotes();
  if (lastPunchIdx() === null) stampTimeNow();
  startPolling();
  wireFormListeners();
  wireGlobalShortcuts();
}

// ── Global shortcuts ──────────────────────────────────────────────────────────
function wireGlobalShortcuts() {
  document.addEventListener('keydown', handleGlobalKeydown);
}

function handleGlobalKeydown(e) {
  // "Resume?" owns the keyboard while it is up. Enter answers with whichever
  // button has focus -- Yes unless the user has tabbed to No.
  if (resumePromptOpen()) {
    const k = e.key;
    if (k === 'y' || k === 'Y') { e.preventDefault(); confirmResume(); }
    else if (k === 'n' || k === 'N' || k === 'Escape') { e.preventDefault(); declineResume(); }
    else if (k === 'Enter') {
      e.preventDefault();
      if (document.activeElement && document.activeElement.id === 'resumeNo') declineResume();
      else confirmResume();
    }
    else if (!document.getElementById('resumeModal').contains(e.target)) e.preventDefault();
    return;
  }

  // Ctrl+S saves the punch from anywhere, whatever holds focus. The whole point
  // is not having to tab out of the story box after a description has pulled in
  // an OP-code and a prebuilt story. The Ref note modal is the one thing that
  // takes the shortcut over while it is open.
  const settingsOpen = document.getElementById('settingsModal').classList.contains('open');
  const opcodeOpen   = document.getElementById('opcodeModal').classList.contains('open');
  const groupOpen    = document.getElementById('groupModal').classList.contains('open');

  if (groupOpen && (e.key === 'Escape' || e.key === 'Enter')) {
    e.preventDefault();
    if (e.key === 'Escape') closeGroupModal(); else saveGroup();
    return;
  }

  if (e.key === 'Escape' && settingsOpen) {
    closeSettings();
    return;
  }
  if (e.key === 'Escape' && opcodeOpen) {
    closeOpcodeModal();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();   // also stops WebView2's own "save page" dialog
    // An open dialog owns the shortcut; otherwise it saves the punch.
    if (settingsOpen) saveSettings();
    else if (groupOpen) saveGroup();
    else if (opcodeOpen) saveOpcode();
    else if (document.getElementById('refModal').classList.contains('open')) saveRefNote();
    else savePunch();
    return;
  }

  if (e.ctrlKey && e.key === 'c') {
    const activePanel = document.querySelector('.sidebar-panel.active');
    if (activePanel && activePanel.id === 'panel-copy') copyExportText();
  }

  if (!e.ctrlKey || e.key !== 'Tab') return;
  e.preventDefault();
  const tabs = ['form', 'copy', 'ref', 'calc'];
  const active = tabs.findIndex(t =>
    document.getElementById('tab-' + t).classList.contains('active')
  );
  const next = e.shiftKey
    ? (active - 1 + tabs.length) % tabs.length
    : (active + 1) % tabs.length;
  switchTab(tabs[next]);
}

// ── File picker ───────────────────────────────────────────────────────────────
async function populateFilePicker() {
  const res   = await fetch('/api/files');
  const files = await res.json();
  const picker = document.getElementById('filePicker');
  picker.innerHTML = files.map(f =>
    `<option value="${f}">${f.replace('.xlsx', '')}</option>`
  ).join('');
}

async function loadFile(filename) {
  currentFile    = filename;
  selectedRow    = null;
  editingRow     = null;
  lastModifiedTs = 0;
  if (window._stopwatchInterval) clearInterval(window._stopwatchInterval);
  clearForm();
  await loadPunches(filename);
  await loadRefNotes();
}

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadPunches(filename) {
  const url = filename
    ? `/api/punches?file=${encodeURIComponent(filename)}`
    : '/api/punches';
  const res  = await fetch(url);
  const data = await res.json();
  if (data.error) { showToast('Error: ' + data.error, true); return; }

  punches     = data.punches;
  currentFile = data.file;

  const picker = document.getElementById('filePicker');
  if (picker) picker.value = data.file;
  document.getElementById('fileBadge').textContent = data.file.replace('.xlsx', '');

  renderPunches();
  updateActivePill();
  checkResumeFromPunches();

  if (selectedRow === null) loadActivePunch();

  if (data.is_today && punches.length === 0) {
    checkCarryover();
  }
}

async function loadOpcodes() {
  const res = await fetch('/api/opcodes');
  opcodes   = await res.json();
}

async function loadTemplates() {
  const res = await fetch('/api/templates');
  templates = await res.json();
}

async function loadRefNotes() {
  const res = await fetch('/api/refnotes');
  refNotes  = await res.json();
  await loadRefGroups();
  populateRefCatList();
  filterRef();
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function jsonOrNull(res) {
  try { return await res.json(); } catch (e) { return null; }
}

async function saveAll({ silent = false } = {}) {
  let res;
  try {
    res = await fetch('/api/punches', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ file: currentFile, punches }),
    });
  } catch (e) {
    showToast('Save failed — server unreachable', true);
    return false;
  }
  const data = await jsonOrNull(res);
  if (!res.ok) {
    showToast((data && data.error) || `Save failed (${res.status})`, true);
    return false;
  }
  lastModifiedTs = await fetchLastModified();
  if (!silent) showToast('Saved');
  return true;
}

async function fetchLastModified() {
  const url = currentFile
    ? `/api/lastmodified?file=${encodeURIComponent(currentFile)}`
    : '/api/lastmodified';
  const res  = await fetch(url);
  const data = await res.json();
  return data.ts;
}

// ── Unsaved-edit tracking ─────────────────────────────────────────────────────
// The 5-second poll reloads the sheet, and reloading replaces what is in the
// entry form. While the form holds unsaved edits, the reload has to wait —
// otherwise a story typed over 30 seconds vanishes mid-sentence the moment
// OneDrive touches the file's mtime.
function markFormDirty()  { formDirty = true; }
function clearFormDirty() { formDirty = false; }

// ── Settings ──────────────────────────────────────────────────────────────────
// Field labels live in settings.json, not in the markup, so the same build suits
// any shop. Elements carrying data-label get their text from there.
async function applySettings() {
  try {
    const res  = await fetch('/api/settings');
    const data = await jsonOrNull(res);
    if (!data) return;
    settings = data;
    document.querySelectorAll('[data-label]').forEach(el => {
      const text = data.labels && data.labels[el.dataset.label];
      if (text) el.textContent = text;
    });
    document.title = appTitle();
  } catch (e) {
    // Keep the markup defaults
  }
}

// ── Settings screen ───────────────────────────────────────────────────────────
// Edits settings.json through the server. Never config.py: that is the program
// itself, read-only once installed.
const LABEL_FIELDS = [
  ['job_number', 'Job number field'],
  ['job_line',   'Line field'],
  ['ref_id',     'Reference field'],
  ['warranty',   'Warranty checkbox'],
  ['copy_tab',   'Copy tab'],
  ['copy_title', 'Copy panel title'],
];
let settingsSnapshot = null;

async function openSettings() {
  let data;
  try {
    data = await jsonOrNull(await fetch('/api/settings'));
  } catch (e) {
    data = null;
  }
  if (!data) { showToast('Could not load the settings', true); return; }
  settingsSnapshot = data;
  const locked = new Set(data.locked || []);

  const org = document.getElementById('set-org');
  org.value    = data.org_name || '';
  org.disabled = locked.has('org_name');

  const folder = document.getElementById('set-folder');
  // A pinned folder shows the one actually in use, not the one in the file.
  folder.value    = (locked.has('data_folder') ? data.active_data_folder : data.data_folder) || '';
  folder.disabled = locked.has('data_folder');
  document.getElementById('set-folder-hint').textContent =
    locked.has('data_folder')
      ? 'Set by the DAYPUNCH_FOLDER environment variable.'
      : (data.active_data_folder && data.active_data_folder !== data.data_folder)
        ? `Still using ${data.active_data_folder} until DayPunch restarts.`
        : 'A change here applies the next time DayPunch starts.';

  // Built node by node: these values come from a file the user can edit, so
  // they never go through innerHTML.
  const grid = document.getElementById('set-labels');
  grid.innerHTML = '';
  LABEL_FIELDS.forEach(([key, name]) => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('div');
    label.className = 'form-label';
    label.textContent = name;
    const input = document.createElement('input');
    input.className   = 'form-input';
    input.maxLength   = 40;
    input.dataset.key = key;
    input.value       = (data.labels && data.labels[key]) || '';
    input.placeholder = (data.defaults && data.defaults[key]) || '';
    group.append(label, input);
    grid.append(group);
  });

  document.getElementById('set-where').textContent = `Stored in ${data.state_folder}`;
  document.getElementById('settingsModal').classList.add('open');
  (org.disabled ? folder : org).focus();
}

// The header's reload button. pywebview has no browser toolbar, so this is the
// only way to reload -- but reloading drops anything typed and not yet saved.
function reloadApp() {
  if (formDirty && !confirm('The entry form has unsaved changes. Reload and lose them?')) return;
  location.reload();
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
}

async function saveSettings() {
  const locked = new Set((settingsSnapshot && settingsSnapshot.locked) || []);
  const body = { labels: {} };
  if (!locked.has('org_name'))    body.org_name    = document.getElementById('set-org').value;
  if (!locked.has('data_folder')) body.data_folder = document.getElementById('set-folder').value;
  document.querySelectorAll('#set-labels input').forEach(input => {
    body.labels[input.dataset.key] = input.value;
  });

  let res;
  try {
    res = await fetch('/api/settings', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    showToast('Settings not saved — server unreachable', true);
    return;
  }
  const data = await jsonOrNull(res);
  if (!res.ok) {
    showToast((data && data.error) || `Settings not saved (${res.status})`, true);
    return;       // leave the dialog open so the edit is not lost
  }
  closeSettings();
  await applySettings();
  updateActivePill();   // the window title carries the organisation name
  showToast(data && data.restart_needed
    ? 'Saved — the new data folder applies when DayPunch restarts'
    : 'Settings saved');
}

function appTitle() {
  return settings.org_name ? `${settings.app_name} — ${settings.org_name}`
                           : settings.app_name;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function nowHHMM() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
}

// The date the open sheet belongs to — not necessarily today.
function currentDayDate() {
  return (punches.length > 0 && punches[0].date) ? punches[0].date : todayISO();
}

// ── Punch state ───────────────────────────────────────────────────────────────
// One definition of "active", shared by the card list, the pill and the stopwatch.
const OPEN_STATUSES = ['W', 'DW', 'WI'];

function isOpenStatus(status) {
  return OPEN_STATUSES.includes(status);
}

// The punch the form edits by default: the last one on the sheet.
function lastPunchIdx() {
  return punches.length ? punches.length - 1 : null;
}

// The job currently running: the last punch, when it is an open work punch.
function openPunchIdx() {
  const i = lastPunchIdx();
  return (i !== null && isOpenStatus(punches[i].status)) ? i : null;
}

// The punch the stopwatch runs on — nothing, while a new punch is being filled in.
function activePunchIdx() {
  return newPunchInProgress ? null : openPunchIdx();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDuration(raw) {
  const h = parseFloat(raw);
  if (isNaN(h) || h <= 0) return '';
  const totalMin = Math.round(h * 60);
  const hrs  = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const tu   = Math.round(h * 100);
  return { hhmm: `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}`, tu: `${tu}TU` };
}

function escAttr(s) {
  return s.replace(/'/g, "\\'");
}

// ── Active punch form ─────────────────────────────────────────────────────────
// Single reader for the entry form — used by save, auto-save and the copy panel
// so they can never disagree about what the form currently holds.
function readForm() {
  return {
    time:        document.getElementById('f-time').value,
    status:      document.getElementById('f-status').value,
    ro:          document.getElementById('f-ro').value.trim(),
    line:        document.getElementById('f-line').value.trim().toUpperCase(),
    description: document.getElementById('f-desc').value.trim(),
    opcode:      document.getElementById('f-opcode').value.trim(),
    refid:        document.getElementById('f-ref').value.trim(),
    odometer:    document.getElementById('f-odo').value.trim(),
    warranty:    document.getElementById('f-warranty').checked ? 'x' : '',
    story:       document.getElementById('f-story').value || '-',
  };
}

function loadActivePunch() {
  const idx = lastPunchIdx();
  if (idx === null) { clearForm(); stampTimeNow(); return; }
  const p = punches[idx];
  setFormValues(p);
  editingRow = idx;
}

function setFormValues(p) {
  document.getElementById('f-time').value       = p.time || '';
  document.getElementById('f-status').value     = p.status || 'W';
  document.getElementById('f-ro').value         = p.ro || '';
  document.getElementById('f-line').value       = p.line || '';
  document.getElementById('f-desc').value       = p.description || '';
  document.getElementById('f-opcode').value     = p.opcode || '';
  document.getElementById('f-ref').value       = p.refid || '';
  document.getElementById('f-odo').value        = p.odometer || '';
  document.getElementById('f-warranty').checked = p.warranty === 'x';
  document.getElementById('f-story').value      = (p.story && p.story !== '-') ? p.story : '';
  clearFormDirty();   // the form now mirrors `punches` again
}

function deselectPunch() {
  abandonNewPunch();
  selectedRow = null;
  document.querySelectorAll('.punch-card').forEach(c => c.classList.remove('selected'));
  loadActivePunch();
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderPunches() {
  const container = document.getElementById('punchCards');
  container.innerHTML = '';
  const activeIdx = activePunchIdx();

  punches.forEach((p, i) => {
    const isActive = i === activeIdx;
    const isBreak  = ['B', 'C', 'A'].includes(p.status);
    const card     = document.createElement('div');

    card.className  = 'punch-card'
      + (isActive ? ' active' : '')
      + (isBreak  ? ' break-card' : '');
    card.dataset.row = p.row;

    // With no job number the description becomes the card title, so it must
    // not be repeated on the line below it.
    const roText       = p.ro ? `#${p.ro}` : p.description || '—';
    const descText     = p.ro ? (p.description || '') : '';
    const lineText     = p.line ? ` <span>/ ${p.line}</span>` : '';
    const storyPreview = p.story && p.story !== '-' ? p.story.split('\n')[0] : '';
    const dur = p.duration ? formatDuration(p.duration) : null;
    const durHTML = isActive
      ? `<div class="punch-duration" id="stopwatch">--:--:--</div>
         <div class="punch-duration" id="stopwatch-tu">-- TU</div>`
      : dur
        ? `<div class="punch-duration">${dur.hhmm}</div><div class="punch-duration">${dur.tu}</div>`
        : '';

    card.innerHTML = `
      <div>
        <div class="punch-time">${p.time || '—'}</div>
        ${durHTML}
      </div>
      <div class="punch-body">
        <div class="punch-ro">${roText}${lineText}</div>
        <div class="punch-desc">${[descText, p.opcode ? '· ' + p.opcode : ''].filter(Boolean).join(' ')}</div>
        ${storyPreview ? `<div class="punch-story-preview">${storyPreview}</div>` : ''}
      </div>
      <div class="punch-actions">
        <span class="status-badge s-${p.status}">${p.status}</span>
        ${p.warranty === 'x' ? '<span class="warranty-flag">WARRANTY</span>' : ''}
        ${isActive ? `<button class="btn-finish" data-finish="${i}">F</button>` : ''}
        <button class="btn-delete" data-delete="${i}" title="Delete punch">🗑</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      const finishBtn = e.target.closest('[data-finish]');
      const deleteBtn = e.target.closest('[data-delete]');
      if (finishBtn) { finishPunch(e, parseInt(finishBtn.dataset.finish)); return; }
      if (deleteBtn) {
        if (selectedRow === i) { deletePunch(e, i); }
        else                   { selectPunch(i); }
        return;
      }
      selectPunch(i);
    });

    container.appendChild(card);
  });
  startStopwatch();
}

function updateActivePill() {
  const pill = document.getElementById('activePill');
  const openIdx = openPunchIdx();
  const last = openIdx === null ? null : punches[openIdx];
  if (last) {
    pill.style.display = 'flex';
    document.getElementById('activePillText').textContent =
      (last.ro ? '#' + last.ro : last.description || '?') +
      (last.line ? ' / ' + last.line : '');
  } else {
    pill.style.display = 'none';
  }
  const winTitle = last && last.ro ? `${last.ro} — ${appTitle()}` : appTitle();
  document.title = winTitle;
  fetch('/api/title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: winTitle }) });
}

function updateEntryTabHighlight() {
  const tab = document.getElementById('tab-form');
  if (newPunchInProgress) {
    tab.style.color       = 'var(--green)';
    tab.style.borderBottomColor = 'var(--green)';
  } else {
    tab.style.color       = '';
    tab.style.borderBottomColor = '';
  }
}

function startStopwatch() {
  if (window._stopwatchInterval) clearInterval(window._stopwatchInterval);
  const el = document.getElementById('stopwatch');
  if (!el) return;

  const activeIdx = activePunchIdx();
  if (activeIdx === null) return;

  const punchTime = punches[activeIdx].time; // "HH:MM"
  const anchorDate = punches[0].date;        // "YYYY-MM-DD"
  if (!punchTime || !anchorDate) return;

  const [h, m]   = punchTime.split(':').map(Number);
  const [y, mo, d] = anchorDate.split('-').map(Number);
  const punchStart = new Date(y, mo - 1, d, h, m, 0);

  window._stopwatchInterval = setInterval(() => {
    const el = document.getElementById('stopwatch');
    if (!el) { clearInterval(window._stopwatchInterval); return; }
    const diff = Math.max(0, Math.floor((Date.now() - punchStart) / 1000));
    const hh = String(Math.floor(diff / 3600)).padStart(2, '0');
    const mm = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const ss = String(diff % 60).padStart(2, '0');
    const tu = Math.floor(diff / 36);
    const tuEl = document.getElementById('stopwatch-tu');
    if (tuEl) tuEl.textContent = `${tu} TU`;
    el.textContent = `${hh}:${mm}:${ss}`;
  }, 1000);
}

// ── Auto-save active punch on navigation ──────────────────────────────────────
async function autoSaveActivePunch() {
  if (editingRow === null || !punches[editingRow]) return;
  if (!document.getElementById('f-time').value) return;

  punches[editingRow] = { ...punches[editingRow], ...readForm() };
  const ok = await saveAll({ silent: true });
  if (ok) clearFormDirty();
}

// ── Punch selection ───────────────────────────────────────────────────────────
async function selectPunch(idx) {
  abandonNewPunch();
  await autoSaveActivePunch();

  document.querySelectorAll('.punch-card').forEach(c => c.classList.remove('selected'));
  const cards = document.querySelectorAll('.punch-card');
  if (cards[idx]) cards[idx].classList.add('selected');

  selectedRow = idx;
  setFormValues(punches[idx]);
  editingRow = idx;
  switchTab('form');
  updateCopyPanel(punches[idx]);
}

// ── Delete punch ──────────────────────────────────────────────────────────────
// One confirmation dialog for punches, notes and OP-codes. Its title used to be
// fixed to "DELETE PUNCH", so deleting a note asked about deleting a punch.
function askDelete(title, text, label, onConfirm) {
  document.getElementById('deleteModalTitle').textContent = title;
  document.getElementById('deleteModalText').textContent  = text;
  document.getElementById('deleteModalLabel').textContent = label;
  document.getElementById('deleteConfirmBtn').onclick = onConfirm;
  document.getElementById('deleteModal').classList.add('open');
}

function deletePunch(e, idx) {
  e.stopPropagation();
  const p     = punches[idx];
  const label = p.ro
    ? `#${p.ro} / ${p.line} — ${p.description || ''} at ${p.time}`
    : `${p.description} at ${p.time}`;
  askDelete('DELETE PUNCH', 'Are you sure you want to delete this punch?', label,
            () => confirmDelete(idx));
}

async function confirmDelete(idx) {
  closeDeleteModal();
  punches.splice(idx, 1);
  selectedRow = null;
  editingRow  = null;
  clearForm();
  renderPunches();
  updateActivePill();
  await saveAll();
  showToast('Punch deleted');
}

function closeDeleteModal() {
  document.getElementById('deleteModal').classList.remove('open');
}

// ── Copy text ───────────────────────────────────────────────────────────────────────
function sanitizeForExport(str) {
  const map = {
    'à':'a','á':'a','â':'a','ã':'a','ä':'a','å':'a','æ':'ae',
    'ç':'c',
    'è':'e','é':'e','ê':'e','ë':'e',
    'ì':'i','í':'i','î':'i','ï':'i',
    'ð':'d','ñ':'n',
    'ò':'o','ó':'o','ô':'o','õ':'o','ö':'o','ø':'o',
    'ù':'u','ú':'u','û':'u','ü':'u',
    'ý':'y','ÿ':'y','þ':'th','ß':'ss',
    'À':'A','Á':'A','Â':'A','Ã':'A','Ä':'A','Å':'A','Æ':'AE',
    'Ç':'C',
    'È':'E','É':'E','Ê':'E','Ë':'E',
    'Ì':'I','Í':'I','Î':'I','Ï':'I',
    'Ð':'D','Ñ':'N',
    'Ò':'O','Ó':'O','Ô':'O','Õ':'O','Ö':'O','Ø':'O',
    'Ù':'U','Ú':'U','Û':'U','Ü':'U',
    'Ý':'Y','Þ':'TH',
    '\u2018':"'",'\u2019':"'",
    '\u201c':'"','\u201d':'"',
    '\u2013':'-','\u2014':'-',
    '\u2026':'...',
    '\u00b0':'deg','\u00b7':'.','\u00d7':'x','\u00f7':'/',
    '\u00e6':'ae','\u0153':'oe','\u0152':'OE',
  };
  return str
    .replace(/[^\x00-\x7F]/g, c => map[c] || '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function buildCopyText(p) {
  let header = `${currentDayDate()}, ${p.time || ''} - ${p.status || ''}`;
  if (p.opcode)          header += `, ${p.opcode}`;
  if (p.description)     header += ` - ${p.description}`;
  if (p.refid)            header += ` - Ticket: ${p.refid}`;
  if (p.warranty === 'x') header += ' [WARRANTY]';
  const story = (p.story && p.story !== '-') ? p.story : '';
  return sanitizeForExport(story ? header + '\n' + story : header);
}

function buildCopyTextFromForm() {
  return buildCopyText(readForm());
}

function refreshCopyFromForm() {
  const content = document.getElementById('copyContent');
  if (content.style.display === 'none') return;
  document.getElementById('copyTextBox').textContent = buildCopyTextFromForm();
}

function updateCopyPanel(p) {
  document.getElementById('copyHint').style.display    = 'none';
  document.getElementById('copyContent').style.display = 'block';
  document.getElementById('copyTextBox').textContent       = buildCopyText(p);
  const btn = document.getElementById('copyBtn');
  btn.textContent = 'Copy to Clipboard';
  btn.classList.remove('copied');
}

function copyExportText() {
  const text = document.getElementById('copyTextBox').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy to Clipboard';
      btn.classList.remove('copied');
    }, 2000);
  });
}

// ── Finish punch ──────────────────────────────────────────────────────────────
function finishPunch(e, idx) {
  e.stopPropagation();
  selectPunch(idx);
  switchTab('copy');
  showToast('Open the Copy tab and copy — then add next punch');
}

// ── Form ──────────────────────────────────────────────────────────────────────
function stampTimeNow() {
  document.getElementById('f-time').value = nowHHMM();
}

function clearForm() {
  ['f-time','f-ro','f-line','f-desc','f-opcode','f-ref','f-odo','f-story'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-status').value    = 'W';
  document.getElementById('f-warranty').checked = false;
  editingRow = null;
  newPunchInProgress = false;
  clearFormDirty();
  updateEntryTabHighlight();
}

function togglePunchLauncher() {
  if (document.getElementById('punchTypePicker').classList.contains('open')) closePunchLauncher();
  else openPunchLauncher();
}

function openPunchLauncher() {
  document.getElementById('punchTypePicker').classList.add('open');
  document.getElementById('btnNewPunch').classList.add('open');
  // Deferred, or the click that opened the picker would close it again.
  // closeLauncherOnOutside is a stable reference, so re-adding it is a no-op
  // and closePunchLauncher() can always take it back off.
  setTimeout(() => document.addEventListener('click', closeLauncherOnOutside), 0);
}

function closeLauncherOnOutside(e) {
  const launcher = document.getElementById('newPunchLauncher');
  if (launcher && !launcher.contains(e.target)) closePunchLauncher();
}

function closePunchLauncher() {
  document.getElementById('punchTypePicker').classList.remove('open');
  document.getElementById('btnNewPunch').classList.remove('open');
  document.removeEventListener('click', closeLauncherOnOutside);
}

async function quickPunch(status, description) {
  const lastRow = punches.length > 0 ? punches[punches.length - 1].row : 1;

  punches.push({
    row:         lastRow + 1,
    date:        currentDayDate(),
    time:        nowHHMM(),
    status,
    description,
    story:       '-',
    ro: '', line: '', opcode: '', refid: '', odometer: '', warranty: '', duration: '',
  });

  renderPunches();
  updateActivePill();
  await saveAll();
  showToast(`${status} — ${description}`);
}

const QUICK_PUNCH_LABELS = { A: 'Looking for next job', B: 'Lunch time', C: 'Home time' };

async function launchPunch(status) {
  closePunchLauncher();

  // Save the punch in progress BEFORE deselectPunch() runs: deselectPunch()
  // reloads the form from `punches`, so auto-saving after it read the stored
  // values back and wrote them over the edits the user had just typed.
  await autoSaveActivePunch();
  deselectPunch();

  if (QUICK_PUNCH_LABELS[status]) {
    if (status === 'C') resumeSnapshot = null;
    await quickPunch(status, QUICK_PUNCH_LABELS[status]);
    return;
  }

  // W, DW, WI
  newPunchInProgress = true;
  updateEntryTabHighlight();
  renderPunches();
  if (!offerResume(status)) startNewPunch(status);
}

// A blank form for a new punch of the given type. clearForm() resets the status
// to W and drops the in-progress flag, so both are put back afterwards. Missing
// the first is what turned "New Punch > WI > Fresh" into a W punch; missing the
// second meant the entry tab never showed a new punch was being filled in.
function startNewPunch(status) {
  clearForm();
  stampTimeNow();
  document.getElementById('f-status').value = status;
  newPunchInProgress = true;
  updateEntryTabHighlight();
  switchTab('form');
  // Time and status are already filled in; the first thing to type is what
  // the job is.
  document.getElementById('f-desc').focus();
}

// Leaving a new punch unsaved -- by picking a card, or clicking the empty list --
// puts the running job back on screen as the active one.
function abandonNewPunch() {
  if (!newPunchInProgress) return;
  newPunchInProgress = false;
  updateEntryTabHighlight();
  renderPunches();
}

async function savePunch() {
  const punch = readForm();
  if (!punch.time) { showToast('Time is required', true); return; }

  if (editingRow !== null) {
    punch.row      = punches[editingRow].row;
    punch.date     = punches[editingRow].date;
    punch.duration = punches[editingRow].duration;
    punches[editingRow] = punch;
  } else {
    const lastRow = punches.length > 0 ? punches[punches.length - 1].row : 1;
    punch.row      = lastRow + 1;
    punch.date     = currentDayDate();
    punch.duration = '';
    punches.push(punch);
  }

  // Drop the in-progress flag BEFORE reloading: loadPunches() re-renders the
  // cards, and a card can only paint as active once this flag is down. Leaving
  // it up until after the render is what forced a second save to "activate"
  // the last card.
  newPunchInProgress = false;
  selectedRow = null;
  editingRow  = null;
  updateEntryTabHighlight();

  await saveAll();
  await loadPunches(currentFile);

  document.querySelectorAll('.punch-card').forEach(c => c.classList.remove('selected'));
  checkResumeFromPunches();
  loadActivePunch();

  // The punch is on disk now; the OP-code is best-effort and must never be able
  // to take the punch down with it.
  maybeSaveOpcode(punch.description, punch.opcode);
}

// ── OP-code autocomplete (bidirectional) ──────────────────────────────────────
// ── OP-codes, variants and parent types ───────────────────────────────────────
// OP-codes are fixed operations -- dealer or manufacturer SROs -- so what varies
// is the job within one: "Winter tires" and "1 tire" are both S-T. A variant is
// a story template tied to an OP-code by its tags. Choosing it fills in the
// description, the code, and that variant's story rather than whichever
// template for the code happened to come first.
const normCode = v => (v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function findOpcode(code) {
  const q = normCode(code);
  return q ? opcodes.find(o => normCode(o.code) === q) : undefined;
}

function opcodeOfVariant(t) {
  for (const tag of (t.tags || '').split(',')) {
    const oc = findOpcode(tag);
    if (oc) return oc;
  }
  return null;
}

// Only templates tied to an OP-code count as variants. A generic snippet --
// "Road tested, no fault found" -- stays a story snippet, not a job description.
function variantsOf(code) {
  const q = normCode(code);
  if (!q) return [];
  return templates.filter(t => t.key && (t.tags || '').split(',').some(tag => normCode(tag) === q));
}

// A parent type only ever sets the status. An OP-code without one leaves the
// status exactly as it was.
function applyParentType(code) {
  const oc = findOpcode(code);
  if (!oc || !oc.type) return;
  const status = document.getElementById('f-status');
  if (status.value === oc.type) return;
  status.value = oc.type;
  markFormDirty();
  showToast(`Status set to ${oc.type} by ${oc.desc}`);
}

function appendStory(text) {
  const ta = document.getElementById('f-story');
  const existing = ta.value.trim();
  ta.value = existing ? existing + '\n' + text : text;
}

function hideOpcodeDropdowns() {
  document.getElementById('opcodeDropdown').style.display     = 'none';
  document.getElementById('opcodeCodeDropdown').style.display = 'none';
}

// Dropdown entries are an OP-code or a variant. Built node by node: codes,
// descriptions and variant names all come from the user's own database.
function renderChoices(ddEl, matches, onPick) {
  ddEl._matches = matches;
  ddEl._onPick  = onPick;
  ddEl._active  = -1;
  ddEl.innerHTML = '';
  matches.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'opcode-item' + (m.kind === 'variant' ? ' is-variant' : '');
    item.dataset.idx = i;
    const code = document.createElement('span');
    code.className = 'oc';
    code.textContent = m.code || '';
    const label = document.createElement('span');
    label.className = 'od';
    label.textContent = m.label;
    item.append(code, label);
    if (m.tag) {
      const tag = document.createElement('span');
      tag.className = 'otag';
      tag.textContent = m.tag;
      item.append(tag);
    }
    item.addEventListener('mousedown', e => { e.preventDefault(); onPick(m); });
    ddEl.append(item);
  });
  ddEl.style.display = matches.length ? 'block' : 'none';
}

function handleChoiceKeys(e, ddEl) {
  if (ddEl.style.display === 'none' || !ddEl._matches || !ddEl._matches.length) return;
  const items = ddEl.querySelectorAll('.opcode-item');
  const move = i => {
    ddEl._active = i;
    items.forEach((el, j) => el.classList.toggle('active', j === i));
  };
  if (e.key === 'ArrowDown') { e.preventDefault(); move(Math.min(ddEl._active + 1, ddEl._matches.length - 1)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(Math.max(ddEl._active - 1, 0)); }
  else if (e.key === 'Enter' && ddEl._active >= 0) { e.preventDefault(); ddEl._onPick(ddEl._matches[ddEl._active]); }
  else if (e.key === 'Escape') { ddEl.style.display = 'none'; ddEl._active = -1; }
}

const asVariantChoice = t => {
  const oc = opcodeOfVariant(t);
  return { kind: 'variant', code: oc ? oc.code : '', label: t.key, tag: 'story', ref: t };
};
const asOpcodeChoice = o => ({ kind: 'opcode', code: o.code, label: o.desc, tag: o.type || '', ref: o });

function descriptionChoices(q) {
  const variants = templates
    .filter(t => t.key && t.key.toLowerCase().includes(q) && opcodeOfVariant(t))
    .map(asVariantChoice);
  const codes = opcodes
    .filter(o => o.desc.toLowerCase().includes(q) || o.code.toLowerCase().includes(q))
    .map(asOpcodeChoice);
  return variants.concat(codes).slice(0, 12);
}

const pickChoice = m => (m.kind === 'variant' ? selectVariant(m.ref) : selectOpcode(m.ref.code, m.ref.desc));

// Several variants under one code: offer them instead of guessing.
function offerVariants(variants) {
  renderChoices(document.getElementById('opcodeDropdown'), variants.map(asVariantChoice), pickChoice);
  document.getElementById('f-desc').focus();
}

function selectOpcode(code, desc) {
  document.getElementById('f-desc').value   = desc;
  document.getElementById('f-opcode').value = code;
  hideOpcodeDropdowns();
  applyParentType(code);
  const variants = variantsOf(code);
  if (variants.length === 1) appendStory(variants[0].value);
  else if (variants.length > 1) offerVariants(variants);
  markFormDirty();
  refreshCopyFromForm();
}

function selectVariant(t) {
  const oc = opcodeOfVariant(t);
  document.getElementById('f-desc').value = t.key;
  if (oc) document.getElementById('f-opcode').value = oc.code;
  hideOpcodeDropdowns();
  if (oc) applyParentType(oc.code);
  appendStory(t.value);
  markFormDirty();
  refreshCopyFromForm();
}

function initOpcodeAutocomplete() {
  const descInput    = document.getElementById('f-desc');
  const opcodeInput  = document.getElementById('f-opcode');
  const dropdown     = document.getElementById('opcodeDropdown');
  const codeDropdown = document.getElementById('opcodeCodeDropdown');

  descInput.addEventListener('input', () => {
    const q = descInput.value.toLowerCase().trim();
    if (!q) { dropdown.style.display = 'none'; return; }
    renderChoices(dropdown, descriptionChoices(q), pickChoice);
  });
  descInput.addEventListener('keydown', e => handleChoiceKeys(e, dropdown));

  opcodeInput.addEventListener('input', () => {
    const q = opcodeInput.value.toLowerCase().trim();
    const exact = opcodes.find(o => o.code.toLowerCase() === q);
    if (exact) {
      // Typed out in full: fill in what follows from it, but never move the
      // cursor -- the code being typed may be a longer one that starts the same.
      descInput.value = exact.desc;
      applyParentType(exact.code);
      const variants = variantsOf(exact.code);
      if (variants.length === 1) appendStory(variants[0].value);
      refreshCopyFromForm();
    }
    if (!q) { codeDropdown.style.display = 'none'; return; }
    const matches = opcodes
      .filter(o => o.code.toLowerCase().includes(q) || o.desc.toLowerCase().includes(q))
      .slice(0, 10).map(asOpcodeChoice);
    renderChoices(codeDropdown, matches, m => selectOpcode(m.ref.code, m.ref.desc));
  });
  opcodeInput.addEventListener('keydown', e => handleChoiceKeys(e, codeDropdown));

  document.addEventListener('click', e => {
    if (!e.target.closest('.opcode-wrap')) hideOpcodeDropdowns();
  });
}

// ── RO + Line combo auto-fill ─────────────────────────────────────────────────
function initLineAutofill() {
  document.getElementById('f-line').addEventListener('input', function () {
    const ro   = document.getElementById('f-ro').value.trim();
    const line = this.value.trim().toUpperCase();
    if (!ro || !line) return;
    if (document.getElementById('f-desc').value.trim()) return;

    const match = punches.find(p =>
      p.ro && p.ro.toString() === ro &&
      p.line && p.line.toUpperCase() === line &&
      p.description
    );
    if (match) {
      document.getElementById('f-desc').value       = match.description || '';
      document.getElementById('f-opcode').value     = match.opcode || '';
      document.getElementById('f-warranty').checked = match.warranty === 'x';
    }
  });
}

// ── Story autocomplete ────────────────────────────────────────────────────────
function initStoryAutocomplete() {
  const storyInput    = document.getElementById('f-story');
  const storyDropdown = document.getElementById('storyDropdown');
  let storyActiveIdx  = -1;

  storyInput.addEventListener('input', () => {
    const text      = storyInput.value;
    const cursorPos = storyInput.selectionStart;
    const textToCursor = text.substring(0, cursorPos);
    const lineStart    = Math.max(textToCursor.lastIndexOf('\n') + 1, 0);
    const currentLine  = textToCursor.substring(lineStart);

    if (!currentLine.trim()) { hideStoryDropdown(); return; }

    const q       = currentLine.toLowerCase();
    const matches = templates.filter(t =>
      t.value.toLowerCase().includes(q) ||
      (t.tags && t.tags.toLowerCase().includes(q))
    ).slice(0, 8);
    if (!matches.length) { hideStoryDropdown(); return; }

    storyActiveIdx = -1;
    storyDropdown.innerHTML = matches.map((t, i) =>
      `<div class="story-item" data-idx="${i}" data-template="${escAttr(t.value)}">${t.value}</div>`
    ).join('');
    storyDropdown.style.display = 'block';

    storyDropdown.querySelectorAll('.story-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertTemplate(el.dataset.template);
      });
    });
  });

  storyInput.addEventListener('keydown', (e) => {
    if (storyDropdown.style.display === 'none') return;
    const items = storyDropdown.querySelectorAll('.story-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      storyActiveIdx = Math.min(storyActiveIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === storyActiveIdx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      storyActiveIdx = Math.max(storyActiveIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === storyActiveIdx));
      } else if (e.key === 'Enter' && storyActiveIdx >= 0) {
        e.preventDefault();
        insertTemplate(items[storyActiveIdx].dataset.template);
        hideStoryDropdown();
    } else if (e.key === 'Escape') {
      hideStoryDropdown();
    }
  });

  storyInput.addEventListener('blur', () => setTimeout(hideStoryDropdown, 150));

  function hideStoryDropdown() {
    storyDropdown.style.display = 'none';
    storyActiveIdx = -1;
  }

  function insertTemplate(template) {
    const ta        = storyInput;
    const cursorPos = ta.selectionStart;
    const text      = ta.value;
    const textToCursor = text.substring(0, cursorPos);
    const lineStart    = Math.max(textToCursor.lastIndexOf('\n') + 1, 0);
    const afterCursor  = text.substring(cursorPos);
    const before       = text.substring(0, lineStart);
    ta.value = before + template + afterCursor;
    const newCursor = lineStart + template.length;
    ta.setSelectionRange(newCursor, newCursor);
    ta.focus();
    hideStoryDropdown();
  }
}

// ── Wire live copy-text refresh to form fields ──────────────────────────────────────
function wireFormListeners() {
  FORM_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // 'change' covers the status select and the warranty checkbox, which used
    // to leave the copy preview stale.
    ['input', 'change'].forEach(evt => el.addEventListener(evt, () => {
      markFormDirty();
      refreshCopyFromForm();
    }));
  });
  document.getElementById('f-story').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); savePunch(); }
  });
  initOpcodeAutocomplete();
  initLineAutofill();
  initStoryAutocomplete();
  initResumeRoPicker();
}

// ── Silent OP-code save ───────────────────────────────────────────────────────
const norm = v => (v || '').trim().toLowerCase();

async function maybeSaveOpcode(desc, code) {
  desc = (desc || '').trim();
  code = (code || '').trim();
  if (!desc) return;

  const byDesc = opcodes.find(o => norm(o.desc) === norm(desc));
  // Nothing to add: either it is already known with this code, or we have no
  // code to contribute. A known description WITHOUT a code and a code in hand
  // must still go through — that is how a code-less row finally gets its code.
  if (byDesc && (!code || norm(byDesc.code) === norm(code))) return;
  if (!byDesc && code && opcodes.some(o => norm(o.code) === norm(code))) return;

  try {
    const res  = await fetch('/api/opcodes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, desc }),
    });
    const data = await jsonOrNull(res);
    if (!res.ok) {
      showToast(`OP-code not saved: ${(data && data.error) || res.status}`, true);
      return;
    }
    if (data && (data.added || data.updated)) {
      await loadOpcodes();   // keep the cache honest instead of guessing
    } else if (data && data.skipped === 'code-used-elsewhere') {
      showToast(`OP-code ${code} already belongs to "${data.existing}"`, true);
    }
  } catch (e) {
    showToast('OP-code not saved — server unreachable', true);
  }
}

// ── Yesterday carryover ───────────────────────────────────────────────────────
async function checkCarryover() {
  const res  = await fetch('/api/carryover');
  const data = await res.json();
  if (!data.carryover) return;
  carryoverData = data.carryover;
  const c = carryoverData;
  document.getElementById('carryoverLabel').textContent =
    `#${c.ro}${c.line ? ' / ' + c.line : ''}${c.description ? ' — ' + c.description : ''} (from ${data.from.replace('.xlsx', '')})`;
  document.getElementById('carryoverModal').classList.add('open');
}

function acceptCarryover() {
  document.getElementById('carryoverModal').classList.remove('open');
  if (!carryoverData) return;
  const c = carryoverData;
  stampTimeNow();
  document.getElementById('f-status').value      = c.status || 'W';
  document.getElementById('f-ro').value          = c.ro || '';
  document.getElementById('f-line').value        = c.line || '';
  document.getElementById('f-desc').value        = c.description || '';
  document.getElementById('f-opcode').value      = c.opcode || '';
  document.getElementById('f-warranty').checked  = c.warranty === 'x';
  document.getElementById('f-ref').value        = '';
  document.getElementById('f-story').value       = '';
  editingRow    = null;
  carryoverData = null;
  switchTab('form');
  markFormDirty();   // a carried-over punch is unsaved work
}

function declineCarryover() {
  document.getElementById('carryoverModal').classList.remove('open');
  carryoverData = null;
}

// ── Resume context ────────────────────────────────────────────────────────────
function checkResumeFromPunches() {
  resumeSnapshot = null;
  resumeRoList = [];
  resumeRoIdx = 0;

  if (!punches.length) return;

  const last = punches[punches.length - 1];

  // Offer resume after W/DW/WI, B (lunch), or A (available)
  if (last.status === 'C') return;
  if (['B', 'A'].includes(last.status)) {
    const hasPrior = punches.some(p => ['W', 'DW', 'WI'].includes(p.status) && p.ro);
    if (!hasPrior) return;
  } else if (!['W', 'DW', 'WI'].includes(last.status)) return;

  // Collect all unique ROs from W/DW/WI punches in reverse chronological order.
  // Each keeps its own most recent odometer reading, so resuming an older job
  // brings back that vehicle's mileage rather than whatever the last punch had.
  const byRo = new Map();
  const roList = [];
  for (let i = punches.length - 1; i >= 0; i--) {
    const p = punches[i];
    if (!['W', 'DW', 'WI'].includes(p.status) || !p.ro) continue;
    let entry = byRo.get(p.ro);
    if (!entry) {
      entry = {
        ro: p.ro,
        line: p.line,
        description: p.description,
        opcode: p.opcode,
        refid: p.refid,
        warranty: p.warranty,
        odometer: '',
      };
      byRo.set(p.ro, entry);
      roList.push(entry);
    }
    if (!entry.odometer && p.odometer) entry.odometer = p.odometer;
  }

  if (!roList.length) return;

  resumeRoList = roList;
  resumeRoIdx = 0;

  // Find the last W/DW/WI punch with an RO (for backwards compat on initial snapshot)
  for (let i = punches.length - 1; i >= 0; i--) {
    const p = punches[i];
    if (['W', 'DW', 'WI'].includes(p.status) && p.ro) {
      resumeSnapshot = {
        status:      p.status,
        ro:          p.ro,
        line:        p.line,
        description: p.description,
        opcode:      p.opcode,
        refid:        p.refid,
        warranty:    p.warranty,
        afterLunch:  false,
      };
      return;
    }
  }
}

function offerResume(status) {
  if (!resumeSnapshot) return false;
  if (!['W', 'DW', 'WI'].includes(status)) return false;

  stampTimeNow();
  document.getElementById('f-status').value = status;
  resumeStatus = status;

  // We are composing a NEW punch. deselectPunch() left editingRow pointing at
  // the last row, and without this a save would overwrite it instead of
  // appending. clearForm() does this on the non-resume branch.
  editingRow = null;

  const selected = resumeRoList[resumeRoIdx];
  document.getElementById('f-ro').value  = selected.ro || '';
  document.getElementById('f-odo').value = selected.odometer || '';

  document.getElementById('f-line').value       = '';
  document.getElementById('f-desc').value       = '';
  document.getElementById('f-opcode').value     = '';
  document.getElementById('f-ref').value       = '';
  document.getElementById('f-warranty').checked = false;
  document.getElementById('f-story').value = '';

  document.getElementById('resumeRoNumber').textContent = selected.ro;

  switchTab('form');
  markFormDirty();   // a prefilled resume is unsaved work
  openResumePrompt();
  return true;
}

// ── Resume prompt ─────────────────────────────────────────────────────────────
// While "Resume?" is up the rest of the app is inert -- no clicks, no focus --
// and only then does the keyboard mean Y / N. A permanent Y/N listener would
// have eaten those letters out of every note typed afterwards.
function resumePromptOpen() {
  return document.getElementById('resumeModal').classList.contains('open');
}

function openResumePrompt() {
  document.getElementById('resumeModal').classList.add('open');
  document.querySelector('.app').inert = true;
  document.getElementById('resumeYes').focus();
}

function closeResumePrompt() {
  document.getElementById('resumeModal').classList.remove('open');
  document.querySelector('.app').inert = false;    // before focusing anything in it
}

// Wired ONCE from wireFormListeners(). It used to be called from offerResume(),
// which stacked a fresh set of handlers on the same element on every resume —
// by the fourth resume of the day one wheel notch jumped four ROs.
function initResumeRoPicker() {
  const roSpan = document.getElementById('resumeRoNumber');

  roSpan.addEventListener('mouseenter', () => roSpan.classList.add('hover'));
  roSpan.addEventListener('mouseleave', () => roSpan.classList.remove('hover'));

  roSpan.addEventListener('wheel', (e) => {
    if (!resumeRoList.length) return;
    e.preventDefault();

    // Scroll up (negative deltaY) = earlier in day = lower index
    // Scroll down (positive deltaY) = later in day = higher index
    const direction = e.deltaY > 0 ? 1 : -1;
    resumeRoIdx = (resumeRoIdx + direction + resumeRoList.length) % resumeRoList.length;

    const selected = resumeRoList[resumeRoIdx];
    roSpan.textContent = selected.ro;
    document.getElementById('f-ro').value  = selected.ro;
    document.getElementById('f-odo').value = selected.odometer || '';
    markFormDirty();
  });
}

function confirmResume() {
  resumeSnapshot = null;
  editingRow     = null;
  closeResumePrompt();
  document.getElementById('f-desc').focus();
}

function declineResume() {
  resumeSnapshot = null;
  closeResumePrompt();
  startNewPunch(resumeStatus || 'W');
}

// ── Reference panel ───────────────────────────────────────────────────────────
function populateRefCatList() {
  const list = document.getElementById('refCatList');
  list.innerHTML = '';
  [...new Set(refNotes.map(n => n.category).filter(Boolean))].forEach(c => {
    const o = document.createElement('option');   // category names are user data
    o.value = c;
    list.append(o);
  });
}

// REF holds notes by category, story templates and OP-codes. A strip of chips
// filters it by GROUP -- a handful of user-named buckets ("Car info", "People")
// that the note categories fold into -- and inside a group the categories show
// as sub-headings. The group belongs to the category, not to each note, so
// re-grouping never means re-categorising. Chips rather than fixed tabs because
// nothing limits how many groups there are.
const UNGROUPED = 'Ungrouped';
const STORIES   = 'Stories';
const OPCODES   = 'OP-Codes';
const FIXED_CHIPS = [UNGROUPED, STORIES, OPCODES];

let refGroup = 'All';                  // the chip being shown
let refCategoryGroups = {};            // lower-cased category -> group name
let newNoteGroup = '';                 // group a note added from inside a chip goes to

const categoryOf = n => (n.category || '').trim() || 'General';
const groupOf = category => refCategoryGroups[(category || '').trim().toLowerCase()] || '';

async function loadRefGroups() {
  try {
    const data = await jsonOrNull(await fetch('/api/refgroups'));
    refCategoryGroups = {};
    Object.entries(data || {}).forEach(([cat, grp]) => {
      refCategoryGroups[cat.trim().toLowerCase()] = grp;
    });
  } catch (e) {
    refCategoryGroups = {};
  }
}

function existingGroups() {
  return [...new Set(Object.values(refCategoryGroups))].sort((a, b) => a.localeCompare(b));
}

// chip -> Map(category -> items). Groups A to Z, then the fixed chips, so the
// strip keeps its order as notes are added.
function refChips() {
  const chips = new Map();
  const put = (chip, category, item) => {
    if (!chips.has(chip)) chips.set(chip, new Map());
    const cats = chips.get(chip);
    if (!cats.has(category)) cats.set(category, []);
    cats.get(category).push(item);
  };
  refNotes.forEach(n => {
    const category = categoryOf(n);
    if (n.sheet === 'Story_Templates') put(STORIES, category, n);
    else put(groupOf(category) || UNGROUPED, category, n);
  });
  opcodes.forEach(o => put(OPCODES, OPCODES, o));

  const byName = m => new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const ordered = new Map();
  [...chips.keys()]
    .filter(k => !FIXED_CHIPS.includes(k))
    .sort((a, b) => a.localeCompare(b))
    .forEach(k => ordered.set(k, byName(chips.get(k))));
  FIXED_CHIPS.forEach(k => { if (chips.has(k)) ordered.set(k, byName(chips.get(k))); });
  return ordered;
}

function refMatches(chip, item, q) {
  if (!q) return true;
  const fields = chip === OPCODES
    ? [item.code, item.desc, item.type]
    : [item.category, item.key, item.value, item.tags];
  return fields.join(' ').toLowerCase().includes(q);
}

// What is on screen: [chip, Map(category -> matching items)] pairs. A search
// always looks everywhere, so a chip is never left contradicting it.
function visibleRef(q) {
  const chips = refChips();
  const names = (q || refGroup === 'All') ? [...chips.keys()] : [refGroup];
  const out = [];
  names.forEach(chip => {
    const cats = chips.get(chip);
    if (!cats) return;
    const kept = new Map();
    cats.forEach((items, cat) => {
      const hits = items.filter(it => refMatches(chip, it, q));
      if (hits.length) kept.set(cat, hits);
    });
    if (kept.size) out.push([chip, kept]);
  });
  return out;
}

function setRefGroup(name) {
  refGroup = name;
  document.getElementById('refSearch').value = '';   // a chip and a query never fight
  renderRef('');
}

function refNoteEl(note) {
  const el = document.createElement('div');
  el.className = 'ref-item';
  const key = document.createElement('span');
  key.className = 'ref-key';
  key.textContent = note.key;
  el.append(key);
  if (note.sheet !== 'Story_Templates' && note.value) {
    el.append(document.createTextNode(' — ' + note.value));
  }
  el.addEventListener('contextmenu', e => showRefContextMenu(e, el, note));
  el.addEventListener('click', () => {
    navigator.clipboard.writeText(note.value || note.key);
    showToast('Copied: ' + note.key);
  });
  return el;
}

function refOpcodeEl(oc) {
  const el = document.createElement('div');
  el.className = 'ref-item';
  const key = document.createElement('span');
  key.className = 'ref-key';
  key.textContent = oc.code || '—';
  el.append(key, document.createTextNode(' — ' + oc.desc));
  if (oc.type) {
    const badge = document.createElement('span');
    badge.className = 'ref-type';
    badge.textContent = oc.type;
    el.append(badge);
  }
  el.addEventListener('contextmenu', e => showRefContextMenu(e, el, { kind: 'opcode', ...oc }));
  el.addEventListener('click', () => {
    if (!oc.code) return;
    navigator.clipboard.writeText(oc.code);
    showToast('Copied: ' + oc.code);
  });
  return el;
}

// A category heading is where its group is chosen: right-click it.
function refCategoryHeading(category, count) {
  const h = document.createElement('div');
  h.className = 'ref-category-title';
  h.textContent = category;
  h.title = 'Right-click to choose this category\'s group';
  h.addEventListener('contextmenu', e => {
    e.preventDefault();
    openGroupModal(category, count);
  });
  return h;
}

function renderRefTabs(chips, q) {
  const strip = document.getElementById('refTabs');
  strip.innerHTML = '';
  const counts = new Map();
  let total = 0;
  chips.forEach((cats, chip) => {
    let n = 0;
    cats.forEach(items => { n += items.filter(it => refMatches(chip, it, q)).length; });
    counts.set(chip, n);
    total += n;
  });
  const chipEl = (name, count) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ref-tab' + (refGroup === name ? ' active' : '') + (count ? '' : ' empty');
    const label = document.createElement('span');
    label.textContent = name;
    const badge = document.createElement('span');
    badge.className = 'n';
    badge.textContent = count;
    b.append(label, badge);
    b.addEventListener('click', () => setRefGroup(name));
    return b;
  };
  strip.append(chipEl('All', total));
  chips.forEach((cats, chip) => strip.append(chipEl(chip, counts.get(chip))));
}

function renderRef(query) {
  const container = document.getElementById('refContent');
  const q = (query || '').toLowerCase().trim();
  const chips = refChips();

  if (refGroup !== 'All' && !chips.has(refGroup)) refGroup = 'All';   // its last note went
  if (q) refGroup = 'All';

  renderRefTabs(chips, q);
  container.innerHTML = '';

  if (!refNotes.length && !opcodes.length) {
    container.innerHTML = '<div class="ref-empty">No reference notes or OP-codes yet.</div>';
    return;
  }
  const shown = visibleRef(q);
  if (!shown.length) {
    container.innerHTML = '<div class="ref-empty">Nothing matches.</div>';
    return;
  }

  // Group headings only when several groups share the screen; category headings
  // wherever there are categories to tell apart -- and to right-click.
  const several = shown.length > 1;
  shown.forEach(([chip, cats]) => {
    const section = document.createElement('div');
    section.className = 'ref-section';
    if (several) {
      const title = document.createElement('div');
      title.className = 'ref-group-title';
      title.textContent = chip;
      section.append(title);
    }
    cats.forEach((items, cat) => {
      const catEl = document.createElement('div');
      catEl.className = 'ref-category';
      const allInCat = (chips.get(chip).get(cat) || items).length;
      if (chip !== OPCODES && chip !== STORIES) catEl.append(refCategoryHeading(cat, allInCat));
      items.forEach(it => catEl.append(chip === OPCODES ? refOpcodeEl(it) : refNoteEl(it)));
      section.append(catEl);
    });
    container.append(section);
  });
}

function filterRef() {
  renderRef(document.getElementById('refSearch').value);
}

// ── Category group dialog ─────────────────────────────────────────────────────
function openGroupModal(category, count) {
  document.getElementById('grp-category').value = category;
  document.getElementById('groupModalFor').textContent =
    `${category} — ${count} note${count === 1 ? '' : 's'}`;
  const list = document.getElementById('refGroupList');
  list.innerHTML = '';
  existingGroups().forEach(g => {
    const o = document.createElement('option');
    o.value = g;
    list.append(o);
  });
  const input = document.getElementById('grp-name');
  input.value = groupOf(category);
  document.getElementById('groupModal').classList.add('open');
  input.focus();
  input.select();
}

function closeGroupModal() {
  document.getElementById('groupModal').classList.remove('open');
}

async function saveGroup() {
  const category = document.getElementById('grp-category').value;
  const group    = document.getElementById('grp-name').value.trim();
  let res;
  try {
    res = await fetch('/api/refgroups', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ category, group }),
    });
  } catch (e) {
    showToast('Group not saved — server unreachable', true);
    return;
  }
  const data = await jsonOrNull(res);
  if (!res.ok) { showToast((data && data.error) || `Group not saved (${res.status})`, true); return; }
  closeGroupModal();
  await loadRefGroups();
  filterRef();              // stay put: sorting "Ungrouped" one category at a time
  showToast(`${category} → ${group || UNGROUPED}`);
}

// ── Ref context menu ──────────────────────────────────────────────────────────
let refContextMenu = null;

function showRefContextMenu(e, item, noteObj) {
  e.preventDefault();
  closeRefContextMenu();

  const menu = document.createElement('div');
  menu.className = 'ref-context-menu';
  menu.innerHTML = `
    <div class="ref-context-item" id="ctxEdit">Edit</div>
    <div class="ref-context-item danger" id="ctxDelete">Delete</div>
  `;
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  document.body.appendChild(menu);
  refContextMenu = menu;

  const isOpcode = noteObj.kind === 'opcode';
  menu.querySelector('#ctxEdit').addEventListener('click', () => {
    closeRefContextMenu();
    if (isOpcode) openOpcodeModal(noteObj); else openRefModal(noteObj, item);
  });
  menu.querySelector('#ctxDelete').addEventListener('click', () => {
    closeRefContextMenu();
    if (isOpcode) deleteOpcode(noteObj); else deleteRefNote(noteObj);
  });

  setTimeout(() => document.addEventListener('click', closeRefContextMenu), 0);
}

function closeRefContextMenu() {
  if (refContextMenu) { refContextMenu.remove(); refContextMenu = null; }
  document.removeEventListener('click', closeRefContextMenu);
}

function openRefModal(noteObj, anchorEl) {
  const modal   = document.getElementById('refModal');
  const modalBox = document.getElementById('refModalBox');

  // Reset fields
  document.getElementById('refModalTitle').textContent = noteObj ? 'EDIT NOTE' : 'ADD NOTE';
  document.getElementById('ref-edit-row').value        = noteObj ? noteObj.row   : '';
  document.getElementById('ref-edit-sheet').value      = noteObj ? (noteObj.sheet || 'Ref_Notes') : '';
  // Adding from inside a group: a story chip means a story, and a new category
  // created from a group chip lands in that group.
  newNoteGroup = (!noteObj && !['All', UNGROUPED, STORIES, OPCODES].includes(refGroup)) ? refGroup : '';
  const preset = (!noteObj && refGroup === STORIES) ? 'Story' : '';
  document.getElementById('ref-cat').value             = noteObj ? noteObj.category : preset;
  document.getElementById('ref-key').value             = noteObj ? noteObj.key      : '';
  document.getElementById('ref-val').value             = noteObj ? noteObj.value    : '';
  document.getElementById('ref-tags').value            = noteObj ? noteObj.tags     : '';

  // Position near anchor if provided
  modalBox.style.position = '';
  modalBox.style.top      = '';
  modalBox.style.left     = '';
  modalBox.style.right    = '';
  modalBox.style.margin   = '';

  modal.classList.add('open');
}

function closeRefModal() {
  document.getElementById('refModal').classList.remove('open');
}

async function saveRefNoteEdit(noteObj) {
  const res = await fetch('/api/refnotes', {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ row: noteObj.row, sheet: noteObj.sheet, key: noteObj.key, value: noteObj.value }),
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.error || 'Save failed', true); return; }
  showToast('Note updated');
  await loadRefNotes();
}

function deleteRefNote(noteObj) {
  askDelete('DELETE NOTE', 'Are you sure you want to delete this note?',
            `${noteObj.category ? noteObj.category + ' — ' : ''}${noteObj.key}`,
            () => confirmDeleteRefNote(noteObj));
}

// ── OP-code editor ────────────────────────────────────────────────────────────
function openOpcodeModal(oc) {
  document.getElementById('oc-id').value   = oc.id == null ? '' : oc.id;
  document.getElementById('oc-code').value = oc.code || '';
  document.getElementById('oc-desc').value = oc.desc || '';
  document.getElementById('oc-type').value = oc.type || '';
  document.getElementById('opcodeModal').classList.add('open');
  document.getElementById('oc-type').focus();       // the usual reason to open it
}

function closeOpcodeModal() {
  document.getElementById('opcodeModal').classList.remove('open');
}

async function saveOpcode() {
  const body = {
    id:   parseInt(document.getElementById('oc-id').value, 10),
    code: document.getElementById('oc-code').value,
    desc: document.getElementById('oc-desc').value,
    type: document.getElementById('oc-type').value,
  };
  let res;
  try {
    res = await fetch('/api/opcodes', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    showToast('OP-code not saved — server unreachable', true);
    return;
  }
  const data = await jsonOrNull(res);
  if (!res.ok) {
    showToast((data && data.error) || `OP-code not saved (${res.status})`, true);
    return;
  }
  closeOpcodeModal();
  await loadOpcodes();
  filterRef();
  showToast('OP-code saved');
}

function deleteOpcode(oc) {
  askDelete('DELETE OP-CODE',
            'Delete this OP-code? Punches already saved keep their description.',
            `${oc.code ? oc.code + ' — ' : ''}${oc.desc}`,
            () => confirmDeleteOpcode(oc));
}

async function confirmDeleteOpcode(oc) {
  closeDeleteModal();
  const res  = await fetch(`/api/opcodes?id=${encodeURIComponent(oc.id)}`, { method: 'DELETE' });
  const data = await jsonOrNull(res);
  if (!res.ok) { showToast((data && data.error) || 'Delete failed', true); return; }
  await loadOpcodes();
  filterRef();
  showToast('OP-code deleted');
}

async function confirmDeleteRefNote(noteObj) {
  closeDeleteModal();
  const res = await fetch(`/api/refnotes?row=${noteObj.row}&sheet=${encodeURIComponent(noteObj.sheet || 'Ref_Notes')}`, { method: 'DELETE' });
  const data = await jsonOrNull(res);
  if (!res.ok) { showToast((data && data.error) || 'Delete failed', true); return; }
  showToast('Note deleted');
  await loadRefNotes();
}

async function saveRefNote() {
  const category = document.getElementById('ref-cat').value.trim();
  const key      = document.getElementById('ref-key').value.trim();
  const value    = document.getElementById('ref-val').value.trim();
  const tags     = document.getElementById('ref-tags').value.trim();
  const editRow  = document.getElementById('ref-edit-row').value;
  const editSheet = document.getElementById('ref-edit-sheet').value;
  if (!category || !key) { showToast('Category and Key are required', true); return; }

  let res;
  if (editRow) {
    // Edit mode
    res = await fetch('/api/refnotes', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ row: parseInt(editRow), sheet: editSheet, key, value, category, tags }),
    });
  } else {
    // Add mode
    res = await fetch('/api/refnotes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ category, key, value, tags }),
    });
  }

  const data = await jsonOrNull(res);
  if (!res.ok) { showToast((data && data.error) || 'Save failed', true); return; }

  // A brand-new category added from inside a group chip joins that group.
  if (!editRow && newNoteGroup && category.toLowerCase() !== 'story' && !groupOf(category)) {
    await fetch('/api/refgroups', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ category, group: newNoteGroup }),
    });
  }
  newNoteGroup = '';

  showToast(editRow ? 'Note updated' : 'Note saved');
  closeRefModal();
  await loadRefNotes();
}

// ── Calculators ───────────────────────────────────────────────────────────────
function calcTireWear() {
  const meas = parseFloat(document.getElementById('c-tire-meas').value);
  const km   = parseFloat(document.getElementById('c-tire-km').value);
  const el   = document.getElementById('c-tire-result');
  if (isNaN(meas)) { el.textContent = ''; return; }
  const pct     = Math.max(0, Math.min(1, (meas - TIRE_WORN_MM) / (TIRE_NEW_MM - TIRE_WORN_MM)));
  const pctDisp = Math.round(pct * 100);
  let out = `${pctDisp}% remaining`;
  if (!isNaN(km) && km > 0 && pct > 0 && pct < 1) {
    const kmAtWornOut = Math.round(km + (km * (1 - pct) / pct));
    out += ` · Est. worn out at ${kmAtWornOut.toLocaleString()} km`;
  }
  el.textContent = out;
}

function calcLabour() {
  const rate = parseFloat(document.getElementById('c-lab-rate').value);
  const hrs  = parseFloat(document.getElementById('c-lab-time').value);
  const el   = document.getElementById('c-lab-result');
  if (isNaN(rate) || isNaN(hrs)) { el.textContent = ''; return; }
  el.textContent = `$${(rate * hrs).toFixed(2)}`;
}

function toggleHoldUnit() {
  holdUnit = holdUnit === 'hrs' ? 'days' : 'hrs';
  document.getElementById('c-hold-toggle').textContent = holdUnit;
  document.getElementById('c-hold-label').textContent  = holdUnit === 'hrs' ? 'Hours flagged' : 'Days flagged';
  const input = document.getElementById('c-hold-val');
  input.step        = holdUnit === 'hrs' ? '0.5' : '1';
  input.placeholder = holdUnit === 'hrs' ? '4' : '3';
  calcHold();
}

function calcHold() {
  const val = parseFloat(document.getElementById('c-hold-val').value);
  const el  = document.getElementById('c-hold-result');
  if (isNaN(val)) { el.textContent = ''; return; }
  const hours = holdUnit === 'days' ? val * 24 : val;
  el.textContent = `Hold value: ${Math.round(hours * 10)}`;
}

function calcOdoFromKm() {
  const km = parseFloat(document.getElementById('c-odo-km').value);
  document.getElementById('c-odo-mi').value = isNaN(km) ? '' : Math.round(km / 1.60934);
}

function calcOdoFromMi() {
  const miles = parseFloat(document.getElementById('c-odo-mi').value);
  document.getElementById('c-odo-km').value = isNaN(miles) ? '' : Math.round(miles * 1.60934);
}

// ── Database status ───────────────────────────────────────────────────────────
async function checkDbStatus() {
  try {
    const res  = await fetch('/api/dbstatus');
    const data = await jsonOrNull(res);
    if (data && data.db_ok === false) {
      showToast('Reference database unavailable: ' + (data.error || 'unknown'), true);
    }
    if (data && data.warnings && data.warnings.length && !dbWarningShown) {
      dbWarningShown = true;
      data.warnings.forEach(w => console.warn('DayPunch database:', w));
      showToast('Database needs attention: ' + data.warnings[0], true);
    }
  } catch (e) {
    // Status polling stays quiet on failure
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(checkForExternalChanges, 5000);
}

// What the poll should do with a freshly read mtime. Split out from the fetching
// so the policy is testable on its own.
//   'adopt'     first tick — record the timestamp, nothing to compare against
//   'unchanged' file is not newer than what we last wrote or read
//   'defer'     newer, but the form holds unsaved edits — refreshing would eat them
//   'refresh'   newer and safe to reload
function refreshDecision(ts) {
  if (lastModifiedTs === 0) return 'adopt';
  if (ts <= lastModifiedTs) return 'unchanged';
  if (formDirty)            return 'defer';
  return 'refresh';
}

async function checkForExternalChanges() {
  try {
    await checkDbStatus();
    const ts = await fetchLastModified();
    const decision = refreshDecision(ts);

    if (decision === 'adopt')     { lastModifiedTs = ts; return; }
    if (decision === 'unchanged') return;
    if (decision === 'defer') {
      // lastModifiedTs is deliberately left alone, so the change is picked up
      // on a later tick once the edit is saved or cleared.
      if (!deferredExternalChange) {
        deferredExternalChange = true;
        showToast('File changed externally — refreshing once you save', true);
      }
      return;
    }

    lastModifiedTs = ts;
    deferredExternalChange = false;
    await loadPunches(currentFile);
    await loadRefNotes();
    await loadOpcodes();
    await loadTemplates();
    showToast('File updated externally — refreshed');
  } catch (e) {
    // Silently ignore poll errors
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('panel-' + name).classList.add('active');

  if (name === 'copy' && editingRow !== null && punches[editingRow]) {
    updateCopyPanel({ ...punches[editingRow], ...readForm() });
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent    = msg;
  t.style.background = isError ? 'var(--red)' : 'var(--green)';
  t.style.color      = isError ? '#fff'        : '#0a1a10';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
