/* Minimal CalDAV client for iCloud.
 *
 * Discovery is the three-step dance every CalDAV client has to do:
 *   1. PROPFIND / for current-user-principal
 *   2. PROPFIND <principal> for calendar-home-set
 *   3. PROPFIND <home> Depth:1 to enumerate the calendar collections
 * Apple answers step 2 with an absolute URL on a per-account shard host
 * (e.g. p43-caldav.icloud.com), which is why every href is
 * resolved against the URL of the response that carried it.
 */

const DAV_NS = 'DAV:';
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';
const ROOT = 'https://caldav.icloud.com/';

/* Basic auth, UTF-8 safe. Apple IDs and app-specific passwords are ASCII in
 * practice, but btoa() throws on anything above U+00FF so encode properly. */
function basicAuth(user, password) {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return 'Basic ' + btoa(binary);
}

function propfindBody(props) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>${props}</d:prop>
</d:propfind>`;
}

async function propfind(url, depth, props, auth) {
  return davRequest('PROPFIND', url, depth, propfindBody(props), auth);
}

/* PROPFIND or REPORT: send XML, get a parsed 207 multistatus back. */
async function davRequest(method, url, depth, body, auth) {
  let res;
  try {
    res = await fetch(url, {
      method,
      // credentials:'omit' is load-bearing. On a 401 with WWW-Authenticate,
      // Chrome otherwise swallows the challenge and shows its own Basic auth
      // dialog for caldav.icloud.com, which hides the real error from us and
      // cannot succeed anyway. Omitting credentials hands the 401 back here.
      credentials: 'omit',
      headers: {
        Authorization: auth,
        Depth: String(depth),
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body
    });
  } catch (err) {
    throw new Error(`Could not reach iCloud (${err.message}).`);
  }

  if (res.status === 401) {
    // Tagged so the caller can tell a rejected credential apart from a network
    // or protocol failure, and retry with a different username spelling.
    const err = new Error('iCloud rejected the Apple ID or app-specific password.');
    err.authFailed = true;
    throw err;
  }
  if (res.status !== 207 && !res.ok) {
    throw new Error(`iCloud returned HTTP ${res.status} for ${method} ${url}`);
  }

  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('iCloud returned a response that could not be parsed.');
  }
  // res.url is the post-redirect URL, so relative hrefs resolve correctly.
  return { doc, baseUrl: res.url || url };
}

/* Every <d:response> in a multistatus, with only the props that came back 200. */
function parseResponses(doc, baseUrl) {
  const out = [];
  for (const node of doc.getElementsByTagNameNS(DAV_NS, 'response')) {
    const hrefNode = node.getElementsByTagNameNS(DAV_NS, 'href')[0];
    if (!hrefNode) continue;

    const props = [];
    for (const propstat of node.getElementsByTagNameNS(DAV_NS, 'propstat')) {
      const status = propstat.getElementsByTagNameNS(DAV_NS, 'status')[0];
      if (status && !/\s200\s/.test(status.textContent)) continue;
      const prop = propstat.getElementsByTagNameNS(DAV_NS, 'prop')[0];
      if (prop) props.push(prop);
    }

    out.push({ href: new URL(hrefNode.textContent.trim(), baseUrl).href, props });
  }
  return out;
}

function firstHref(props, ns, localName, baseUrl) {
  for (const prop of props) {
    const holder = prop.getElementsByTagNameNS(ns, localName)[0];
    if (!holder) continue;
    const href = holder.getElementsByTagNameNS(DAV_NS, 'href')[0];
    if (href) return new URL(href.textContent.trim(), baseUrl).href;
  }
  return null;
}

/** Walk discovery and return every writable calendar collection. */
export async function discoverCalendars(appleId, password) {
  const auth = basicAuth(appleId, password);

  const step1 = await propfind(ROOT, 0, '<d:current-user-principal/>', auth);
  const principal = firstHref(
    parseResponses(step1.doc, step1.baseUrl).flatMap(r => r.props),
    DAV_NS, 'current-user-principal', step1.baseUrl
  );
  if (!principal) throw new Error('iCloud did not return a principal URL.');

  const step2 = await propfind(principal, 0, '<c:calendar-home-set/>', auth);
  const home = firstHref(
    parseResponses(step2.doc, step2.baseUrl).flatMap(r => r.props),
    CALDAV_NS, 'calendar-home-set', step2.baseUrl
  );
  if (!home) throw new Error('iCloud did not return a calendar home.');

  const step3 = await propfind(
    home, 1,
    '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:current-user-privilege-set/>',
    auth
  );

  const calendars = [];
  for (const entry of parseResponses(step3.doc, step3.baseUrl)) {
    let name = null;
    let isCalendar = false;
    let takesEvents = false;
    let canWrite = null; // null = server did not say

    for (const prop of entry.props) {
      const dn = prop.getElementsByTagNameNS(DAV_NS, 'displayname')[0];
      if (dn && dn.textContent.trim()) name = dn.textContent.trim();

      const rt = prop.getElementsByTagNameNS(DAV_NS, 'resourcetype')[0];
      if (rt && rt.getElementsByTagNameNS(CALDAV_NS, 'calendar').length) isCalendar = true;

      const comps = prop.getElementsByTagNameNS(CALDAV_NS, 'comp');
      for (const comp of comps) {
        if ((comp.getAttribute('name') || '').toUpperCase() === 'VEVENT') takesEvents = true;
      }

      const privs = prop.getElementsByTagNameNS(DAV_NS, 'current-user-privilege-set')[0];
      if (privs) {
        canWrite = privs.getElementsByTagNameNS(DAV_NS, 'write').length > 0
          || privs.getElementsByTagNameNS(DAV_NS, 'write-content').length > 0
          || privs.getElementsByTagNameNS(DAV_NS, 'all').length > 0;
      }
    }

    // A collection that advertises no component set still accepts events;
    // only exclude one that explicitly supports other components instead.
    const hasCompSet = entry.props.some(
      p => p.getElementsByTagNameNS(CALDAV_NS, 'supported-calendar-component-set').length
    );
    if (isCalendar && name && (takesEvents || !hasCompSet) && canWrite !== false) {
      calendars.push({ name, href: entry.href.endsWith('/') ? entry.href : entry.href + '/' });
    }
  }

  return { auth, home, calendars };
}

/** True if the calendar already holds an event with this UID, under any
 * resource name (e.g. one imported from an .ics file rather than written here). */
async function hasEvent(calendarHref, uid, auth) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:prop-filter name="UID">
          <c:text-match collation="i;octet">${uid.replace(/[<>&]/g, '')}</c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  const { doc, baseUrl } = await davRequest('REPORT', calendarHref, 1, body, auth);
  return parseResponses(doc, baseUrl).some(r => r.props.length);
}

/** Add one event unless it is already there. Returns 'created' or 'exists';
 * an existing event is never overwritten. */
export async function addEvent(calendarHref, resourceName, uid, ics, auth) {
  if (await hasEvent(calendarHref, uid, auth)) return 'exists';

  const url = new URL(encodeURIComponent(resourceName) + '.ics', calendarHref).href;

  let res;
  try {
    res = await fetch(url, {
      method: 'PUT',
      credentials: 'omit', // keep Chrome's Basic auth dialog out of the way
      headers: {
        Authorization: auth,
        'Content-Type': 'text/calendar; charset=utf-8',
        // Create-only: if the resource appeared since the check, fail with 412
        // rather than overwrite it.
        'If-None-Match': '*'
      },
      body: ics
    });
  } catch (err) {
    throw new Error(`Network error while writing to iCloud (${err.message}).`);
  }

  if (res.status === 201 || res.status === 204 || res.status === 200) return 'created';
  if (res.status === 412) return 'exists';
  if (res.status === 401) throw new Error('iCloud rejected the credentials.');
  if (res.status === 403) throw new Error('iCloud refused the write (403). The calendar may be read-only.');
  if (res.status === 507) throw new Error('iCloud storage is full (507).');

  const detail = (await res.text().catch(() => '')).slice(0, 200);
  throw new Error(`iCloud returned HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
}

export { basicAuth };
