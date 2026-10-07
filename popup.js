import { discoverCalendars, addEvent, basicAuth } from './caldav.js';
import * as gcal from './gcal.js';

const API = 'https://www.codechef.com/api/list/contests/all';
// Fixed target: events go to the calendar with this name in each enabled provider.
const TARGET_CALENDAR = 'Contests';

const CREDS_KEY = 'icloudCreds';
const CAL_KEY = 'calendarHref';
const ADDED_KEY = 'addedContests';
const CACHE_KEY = 'contestCache';
const ALARM_KEY = 'alarmMinutes';
const STARTERS_KEY = 'startersOnly';
const TARGETS_KEY = 'targets';      // { apple: bool, google: bool }
const GOOGLE_KEY = 'googleCalendarId';

const LABELS = { apple: 'Apple', google: 'Google' };

const setupEl = document.getElementById('setup');
const mainEl = document.getElementById('main');
const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const signinStatusEl = document.getElementById('signinStatus');
const targetsLabelEl = document.getElementById('targetsLabel');
const useAppleBox = document.getElementById('useApple');
const useGoogleBox = document.getElementById('useGoogle');
const doneBtn = document.getElementById('done');
const addBtn = document.getElementById('add');
const alarmSel = document.getElementById('alarm');
const startersBox = document.getElementById('startersOnly');
const appleIdInput = document.getElementById('appleId');
const passwordInput = document.getElementById('appPassword');

let allContests = [];
// added[code] = { apple?: iso, google?: iso }: which calendars each contest
// was written to, and when. Tracked per calendar so switching calendars never
// carries past contests across: nothing is ever copied between them.
let added = {};
let targets = null;          // null until the user has chosen once
let auth = null;
let appleId = null;
let calendarHref = null;
let googleCalId = null;

const connected = {
  apple: () => !!(auth && calendarHref),
  google: () => !!googleCalId
};

function enabled() {
  return Object.keys(LABELS).filter(t => targets && targets[t]);
}

function setStatus(el, msg, kind) {
  el.textContent = msg || '';
  el.classList.toggle('error', kind === 'error');
  el.classList.toggle('good', kind === 'good');
}

/* ---------- filtering ---------- */

// CodeChef names the weekly rated contests "Starters <n>", sometimes with a
// suffix like "(Rated till 5 star)". Anchored prefix match, so "Restarters 12"
// and "Kickstart Starters" are correctly excluded.
function isStarters(contest) {
  return /^\s*starters/i.test(contest.contest_name);
}

function visible() {
  return startersBox.checked ? allContests.filter(isStarters) : allContests;
}

/* ---------- rendering ---------- */

const fmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', day: 'numeric', month: 'short',
  hour: 'numeric', minute: '2-digit'
});

// CodeChef's contest_duration field is unreliable for multi-day contests,
// so measure the real span between the start and end timestamps.
function durationLabel(c) {
  const total = Math.round((c.end - c.start) / 60000);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(' ');
}

function render() {
  listEl.textContent = '';
  const shown = visible();

  if (!shown.length) {
    setStatus(statusEl, startersBox.checked && allContests.length
      ? `No upcoming Starters contests. CodeChef lists ${allContests.length} other contest${allContests.length > 1 ? 's' : ''} — untick the filter to see them.`
      : 'No upcoming contests listed right now.');
    updateAddButton();
    return;
  }

  for (const c of shown) {
    const li = document.createElement('li');
    const label = document.createElement('label');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = c.contest_code;
    const inCals = Object.keys(added[c.contest_code] || {});
    box.checked = !inCals.length;
    box.addEventListener('change', updateAddButton);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = c.contest_name;
    for (const t of inCals) {
      const tag = document.createElement('span');
      tag.className = 'added';
      tag.textContent = `IN ${LABELS[t].toUpperCase()}`;
      name.append(tag);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${fmt.format(c.start)} · ${durationLabel(c)} · ${c.contest_code}`;

    label.append(box, name, meta);
    li.append(label);
    listEl.append(li);
  }

  updateAddButton();
}

function selected() {
  const codes = new Set([...listEl.querySelectorAll('input:checked')].map(i => i.value));
  return visible().filter(c => codes.has(c.contest_code));
}

function updateAddButton() {
  const n = selected().length;
  addBtn.disabled = n === 0 || !enabled().length;
  addBtn.textContent = n ? `Add ${n} to Contests` : 'Add to Calendar';
}

/* ---------- iCalendar ---------- */

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function esc(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 folds lines at 75 octets; fold on byte boundaries so multi-byte
// characters in contest names are never split down the middle.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(new TextDecoder().decode(bytes.slice(start, end)));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return parts.join('\r\n ');
}

function uidFor(contest) {
  return `codechef-${contest.contest_code}@codechef.com`;
}

/* The resource filename. Kept free of the UID's "@" so no percent-encoding is
 * involved, and stable per contest so re-adding overwrites the same resource
 * rather than creating a second one. */
function resourceFor(contest) {
  return `codechef-${contest.contest_code}`;
}

/* One VCALENDAR holding one VEVENT: CalDAV wants one event per resource. */
function buildIcs(c, alarmMinutes) {
  const url = `https://www.codechef.com/${c.contest_code}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//codechef-calendar-extension//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    fold(`UID:${uidFor(c)}`),
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(c.start)}`,
    `DTEND:${stamp(c.end)}`,
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    fold(`SUMMARY:${esc(c.contest_name)}`),
    fold(`DESCRIPTION:${esc(`CodeChef contest ${c.contest_code}\nDuration: ${durationLabel(c)}\n${url}`)}`),
    fold(`URL:${url}`),
    'LOCATION:codechef.com'
  ];

  if (alarmMinutes) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      fold(`DESCRIPTION:${esc(c.contest_name)}`),
      `TRIGGER:-PT${alarmMinutes}M`,
      'END:VALARM'
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function googleEvent(c, alarmMinutes) {
  const url = `https://www.codechef.com/${c.contest_code}`;
  return {
    summary: c.contest_name,
    description: `CodeChef contest ${c.contest_code}\nDuration: ${durationLabel(c)}\n${url}`,
    location: 'codechef.com',
    start: { dateTime: c.start.toISOString() },
    end: { dateTime: c.end.toISOString() },
    source: { title: 'CodeChef', url },
    reminders: alarmMinutes
      ? { useDefault: false, overrides: [{ method: 'popup', minutes: alarmMinutes }] }
      : { useDefault: false }
  };
}

/* ---------- contests ---------- */

function hydrate(raw) {
  const now = Date.now();
  return raw
    .map(c => ({ ...c,
      start: new Date(c.contest_start_date_iso),
      end: new Date(c.contest_end_date_iso) }))
    .filter(c => !isNaN(c.start) && c.end.getTime() > now)
    .sort((a, b) => a.start - b.start);
}

async function loadContests() {
  const stored = await chrome.storage.local.get([CACHE_KEY]);
  try {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) throw new Error(`CodeChef returned HTTP ${res.status}`);
    const data = await res.json();
    const raw = [...(data.future_contests || []), ...(data.present_contests || [])];
    allContests = hydrate(raw);
    await chrome.storage.local.set({ [CACHE_KEY]: { raw, at: Date.now() } });
    return false;
  } catch (err) {
    const cache = stored[CACHE_KEY];
    if (cache && cache.raw) {
      allContests = hydrate(cache.raw);
      return true;
    }
    throw err;
  }
}

/* ---------- sign in ---------- */

/* Spellings of the username to try, in order.
 *
 * A phone-number Apple ID has no single canonical form: Apple's sign-in accepts
 * it with and without the leading "+", so try both rather than making the user
 * guess. The country code is NOT guessed -- a bare local number is left alone
 * and the user is told to add it, because inventing a country code would send a
 * wrong credential to Apple and burn a failed-login attempt for nothing.
 * Capped at three so a wrong password cannot rack up attempts against the
 * account. */
function usernameCandidates(input) {
  const raw = input.trim();
  if (raw.includes('@')) return [raw];

  // Strip the separators people naturally type in a phone number.
  const tidy = raw.replace(/[\s()\-.]/g, '');
  const digits = tidy.replace(/[^\d]/g, '');
  const out = [tidy];
  if (tidy.startsWith('+')) {
    out.push(digits);                       // same number, no plus
  } else if (digits.length >= 11) {
    out.push('+' + digits);                 // long enough to already carry a country code
  }

  return [...new Set(out.filter(Boolean))].slice(0, 3);
}

/* Extra guidance appended only when iCloud actually rejects the credentials.
 * Hints, never gates. */
function credentialHints(appleId, password) {
  const hints = [];
  const digits = appleId.replace(/[^\d]/g, '');

  if (!appleId.includes('@') && digits.length && digits.length < 11) {
    hints.push('A phone-number Apple ID needs its country code, e.g. +<country code>' + digits + '.');
  }
  if (!appleId.includes('@')) {
    hints.push('Apple may not accept a phone-only Apple ID for third-party CalDAV; ' +
               'adding a free @icloud.com address to the account is the reliable fix (see README).');
  }
  if (!/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/i.test(password)) {
    hints.push('App-specific passwords look like xxxx-xxxx-xxxx-xxxx; a normal Apple ID password will not work.');
  }
  return hints.length ? ' ' + hints.join(' ') : '';
}

async function connect() {
  let login = appleIdInput.value.trim();
  const password = passwordInput.value.trim();

  if (!login || !password) {
    setStatus(signinStatusEl, 'Enter both the Apple ID and the app-specific password.', 'error');
    return;
  }

  const btn = document.getElementById('connect');
  btn.disabled = true;
  setStatus(signinStatusEl, 'Contacting iCloud…');

  try {
    const candidates = usernameCandidates(login);
    let discovered = null;
    let lastAuthError = null;

    for (const candidate of candidates) {
      if (candidates.length > 1) {
        setStatus(signinStatusEl, `Contacting iCloud as ${candidate}…`);
      }
      try {
        discovered = await discoverCalendars(candidate, password);
        login = candidate;          // remember the spelling that worked
        break;
      } catch (err) {
        if (!err.authFailed) throw err;   // network/protocol problems are not retried
        lastAuthError = err;
      }
    }

    if (!discovered) throw lastAuthError;

    const { auth: newAuth, calendars } = discovered;
    const match = calendars.filter(c => c.name === TARGET_CALENDAR);

    if (!match.length) {
      const names = calendars.map(c => c.name).join(', ') || 'none';
      throw new Error(`No iCloud calendar named “${TARGET_CALENDAR}”. Found: ${names}.`);
    }
    if (match.length > 1) {
      throw new Error(`${match.length} iCloud calendars are named “${TARGET_CALENDAR}”. Rename one.`);
    }

    auth = newAuth;
    appleId = login;
    calendarHref = match[0].href;
    await chrome.storage.local.set({
      [CREDS_KEY]: { appleId, password },
      [CAL_KEY]: calendarHref
    });

    passwordInput.value = '';
    setStatus(signinStatusEl, '');
    renderSetup();
  } catch (err) {
    setStatus(signinStatusEl, err.message + credentialHints(login, password), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function signOut() {
  await chrome.storage.local.remove([CREDS_KEY, CAL_KEY]);
  auth = null;
  calendarHref = null;
  renderSetup();
  setStatus(signinStatusEl, 'Password forgotten.', 'good');
}

async function connectGoogle() {
  const btn = document.getElementById('googleConnect');
  const gStatusEl = document.getElementById('googleStatus');
  btn.disabled = true;
  setStatus(gStatusEl, 'Waiting for Google sign-in…');
  try {
    googleCalId = await gcal.connect(TARGET_CALENDAR);
    await chrome.storage.local.set({ [GOOGLE_KEY]: googleCalId });
    setStatus(gStatusEl, '');
    renderSetup();
  } catch (err) {
    setStatus(gStatusEl, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function signOutGoogle() {
  await gcal.disconnect();
  await chrome.storage.local.remove(GOOGLE_KEY);
  googleCalId = null;
  renderSetup();
}

/* ---------- calendar choice ---------- */

/* The checkboxes are only a draft until Done; the saved choice changes only
 * there, so ticking around never changes where contests go. */
function renderSetup() {
  const want = { apple: useAppleBox.checked, google: useGoogleBox.checked };

  document.getElementById('appleConnected').hidden = !(want.apple && connected.apple());
  document.getElementById('appleForm').hidden = !(want.apple && !connected.apple());
  document.getElementById('appleWho').textContent = appleId || '';
  document.getElementById('googleConnected').hidden = !(want.google && connected.google());
  document.getElementById('googleForm').hidden = !(want.google && !connected.google());

  const picked = Object.keys(want).filter(t => want[t]);
  const missing = picked.filter(t => !connected[t]());
  doneBtn.disabled = !picked.length || missing.length > 0;
  setStatus(document.getElementById('setupStatus'),
    !picked.length ? 'Pick at least one calendar.'
      : missing.length ? `Connect ${missing.map(t => LABELS[t]).join(' and ')} to continue.` : '');
}

function showSetup() {
  mainEl.hidden = true;
  setupEl.hidden = false;
  useAppleBox.checked = !!(targets && targets.apple);
  useGoogleBox.checked = !!(targets && targets.google);
  if (appleId) appleIdInput.value = appleId;
  renderSetup();
}

async function finishSetup() {
  targets = { apple: useAppleBox.checked, google: useGoogleBox.checked };
  await chrome.storage.local.set({ [TARGETS_KEY]: targets });
  await showMain();
}

/* ---------- adding ---------- */

/* Each writer returns 'exists' instead of writing a second copy when the
 * calendar already holds this contest's UID. */
const writers = {
  apple: (c, alarm) => addEvent(calendarHref, resourceFor(c), buildIcs(c, alarm), auth),
  google: (c, alarm) => gcal.addEvent(googleCalId, uidFor(c), googleEvent(c, alarm))
};

async function add() {
  const items = selected();
  const cals = enabled();
  if (!items.length || !cals.length) return;

  addBtn.disabled = true;
  const alarm = alarmSel.value ? Number(alarmSel.value) : null;

  let created = 0;
  const already = {};          // { apple: [codes], google: [codes] }
  const failures = [];

  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    setStatus(statusEl, `Checking and adding ${i + 1} of ${items.length}…`);
    for (const t of cals) {
      try {
        const outcome = await writers[t](c, alarm);
        if (outcome === 'created') created++;
        else (already[t] ||= []).push(c.contest_code);
        // Either way it is in that calendar now, so tag it.
        (added[c.contest_code] ||= {})[t] ||= new Date().toISOString();
      } catch (err) {
        failures.push(`${LABELS[t]} ${c.contest_code}: ${err.message}`);
      }
    }
  }

  await chrome.storage.local.set({ [ADDED_KEY]: added });

  const bits = [];
  if (created) bits.push(`${created} added`);
  for (const t of Object.keys(already)) {
    bits.push(`already in ${LABELS[t]}: ${already[t].join(', ')}`);
  }
  if (failures.length) bits.push(`${failures.length} failed`);
  const summary = bits.join(' · ') || 'Nothing to do.';
  setStatus(statusEl,
    failures.length ? `${summary} — ${failures[0]}`
      : created ? `${summary}. Syncing to your devices.` : `${summary}. Nothing new to add.`,
    failures.length ? 'error' : 'good');

  render();
}

/* ---------- startup ---------- */

async function showMain() {
  setupEl.hidden = true;
  mainEl.hidden = false;
  targetsLabelEl.textContent = enabled().map(t => LABELS[t]).join(' and ') + ' · Contests';

  setStatus(statusEl, 'Loading contests…');
  let cached = false;
  try {
    cached = await loadContests();
  } catch (err) {
    setStatus(statusEl, `Could not load contests: ${err.message}`, 'error');
    return;
  }

  setStatus(statusEl, cached
    ? 'Offline — showing the last contest list fetched. Adding needs a connection.'
    : '');
  render();
}

async function init() {
  const stored = await chrome.storage.local.get(
    [CREDS_KEY, CAL_KEY, ADDED_KEY, ALARM_KEY, STARTERS_KEY, TARGETS_KEY, GOOGLE_KEY]);

  // Before Google support, added[code] was a bare timestamp, always for iCloud.
  added = {};
  for (const [code, v] of Object.entries(stored[ADDED_KEY] || {})) {
    added[code] = typeof v === 'string' ? { apple: v } : v;
  }
  if (stored[ALARM_KEY] !== undefined) alarmSel.value = stored[ALARM_KEY];
  if (stored[STARTERS_KEY] !== undefined) startersBox.checked = stored[STARTERS_KEY];

  const creds = stored[CREDS_KEY];
  if (creds && creds.appleId) appleId = creds.appleId;
  if (creds && creds.appleId && creds.password && stored[CAL_KEY]) {
    auth = basicAuth(creds.appleId, creds.password);
    calendarHref = stored[CAL_KEY];
  }
  googleCalId = stored[GOOGLE_KEY] || null;

  // Installs from before the choice existed were iCloud-only; keep them that way.
  targets = stored[TARGETS_KEY] || (connected.apple() ? { apple: true, google: false } : null);

  const ready = enabled().length && enabled().every(t => connected[t]());
  if (ready) await showMain(); else showSetup();
}

document.getElementById('connect').addEventListener('click', connect);
document.getElementById('signout').addEventListener('click', signOut);
document.getElementById('googleConnect').addEventListener('click', connectGoogle);
document.getElementById('googleSignout').addEventListener('click', signOutGoogle);
document.getElementById('change').addEventListener('click', showSetup);
useAppleBox.addEventListener('change', renderSetup);
useGoogleBox.addEventListener('change', renderSetup);
doneBtn.addEventListener('click', finishSetup);
document.getElementById('refresh').addEventListener('click', () => {
  if (!mainEl.hidden) showMain();
});
addBtn.addEventListener('click', add);
alarmSel.addEventListener('change', () => {
  chrome.storage.local.set({ [ALARM_KEY]: alarmSel.value });
});
startersBox.addEventListener('change', () => {
  chrome.storage.local.set({ [STARTERS_KEY]: startersBox.checked });
  render();
});
passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

init();
