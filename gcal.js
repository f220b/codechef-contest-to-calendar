/* Minimal Google Calendar client.
 *
 * Auth is chrome.identity.getAuthToken, which needs an OAuth client ID of type
 * "Chrome extension" in manifest.json (see README) and only exists in Google
 * Chrome. Chrome caches and refreshes the token itself; we only drop a stale
 * one on 401 and retry once.
 */

const API = 'https://www.googleapis.com/calendar/v3';

function assertConfigured() {
  if (!chrome.identity || !chrome.identity.getAuthToken) {
    throw new Error('Google sign-in needs Google Chrome; this browser does not support it.');
  }
  const id = (chrome.runtime.getManifest().oauth2 || {}).client_id || '';
  if (!id || id.startsWith('YOUR_')) {
    throw new Error('Google sync is not set up in this copy: add an OAuth client ID to manifest.json (see README).');
  }
}

async function token(interactive) {
  assertConfigured();
  const { token } = await chrome.identity.getAuthToken({ interactive });
  if (!token) throw new Error('Google did not return a sign-in token.');
  return token;
}

async function call(path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const t = await token(false);
    let res;
    try {
      res = await fetch(API + path, {
        ...opts,
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      throw new Error(`Could not reach Google (${err.message}).`);
    }
    if (res.status === 401 && attempt === 0) {
      await chrome.identity.removeCachedAuthToken({ token: t });
      continue;
    }
    return res;
  }
}

async function failure(res) {
  let detail = '';
  try { detail = (await res.json()).error.message; } catch {}
  return new Error(`Google returned HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
}

/** Interactive sign-in, then find the one writable calendar called `name`. */
export async function connect(name) {
  await token(true);

  const matches = [];
  const seen = [];
  let page = '';
  do {
    const res = await call(`/users/me/calendarList?minAccessRole=writer${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    if (!res.ok) throw await failure(res);
    const data = await res.json();
    for (const cal of data.items || []) {
      const title = cal.summaryOverride || cal.summary;
      seen.push(title);
      if (title === name) matches.push(cal.id);
    }
    page = data.nextPageToken || '';
  } while (page);

  if (!matches.length) {
    throw new Error(`No Google calendar named “${name}”. Found: ${seen.join(', ') || 'none'}.`);
  }
  if (matches.length > 1) {
    throw new Error(`${matches.length} Google calendars are named “${name}”. Rename one.`);
  }
  return matches[0];
}

/** Revoke the grant and forget cached tokens. Best effort: never throws. */
export async function disconnect() {
  try {
    const t = await token(false);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' });
  } catch {}
  try { await chrome.identity.clearAllCachedAuthTokens(); } catch {}
}

/** Add one event unless the calendar already holds one with this UID.
 * Returns 'created' or 'exists'; an existing event is never overwritten.
 * Uses events.import rather than insert because only import lets us set the
 * iCalUID, which makes the event findable by the same UID as the iCloud copy. */
export async function addEvent(calendarId, uid, event) {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;

  // Deleted events are excluded by default, so a contest the user removed can
  // be added again.
  let res = await call(`${base}?iCalUID=${encodeURIComponent(uid)}`);
  if (!res.ok) throw await failure(res);
  if (((await res.json()).items || []).length) return 'exists';

  res = await call(`${base}/import`, { method: 'POST', body: JSON.stringify({ ...event, iCalUID: uid }) });
  if (res.ok) return 'created';
  throw await failure(res);
}
