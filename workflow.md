# How it works

Internals of the extension. For installing and using it, see the
[README](README.md).

## Files

- `manifest.json` — MV3 manifest (the `key` pins the extension ID; delete it for Google sync)
- `popup.html` / `popup.css` — calendar choice/sign-in panel and contest list
- `popup.js` — contest fetching, filtering, iCalendar generation, calendar choice
- `caldav.js` — the CalDAV client for iCloud (discovery, create-only PUT)
- `gcal.js` — the Google Calendar client (sign-in, calendar lookup, already-added check, import)
- `icons/`

## Flow

```
popup.js ──GET──────► codechef.com/api/list/contests/all     (contest list)

         ──PROPFIND─► caldav.icloud.com                       (iCloud discovery)
         ──PUT──────► p43-caldav.icloud.com/<home>/<calendar>/codechef-<CODE>.ics   (create-only)

         ──GET──────► googleapis.com/calendar/v3/users/me/calendarList   (find "Contests")
         ──GET──────► …/calendars/<id>/events?iCalUID=…       (already there?)
         ──POST─────► …/calendars/<id>/events/import          (add)
```

## iCloud discovery

The standard three-step CalDAV walk:

1. `PROPFIND /` → `current-user-principal`
2. `PROPFIND <principal>` → `calendar-home-set`
3. `PROPFIND <home>` `Depth: 1` → enumerate collections, keep the ones that are
   calendars, accept `VEVENT`, and aren't read-only

Apple answers step 2 with an absolute URL on a per-account shard host
(e.g. `p43-…`, per the `x-apple-user-partition` header), so every `href` is
resolved against the URL of the response that carried it. That's also why
`host_permissions` covers `https://*.icloud.com/*` and not just the root.

All CalDAV requests use `credentials: 'omit'`. Otherwise, on a 401 Chrome
swallows the challenge and shows its own Basic auth dialog, hiding the real
error from the extension.

## Already-added check

Every event carries the UID `codechef-<CONTEST ID>@codechef.com`
(e.g. `codechef-START259@codechef.com`). A contest whose UID is already in a
calendar is reported as `already in …` and not written again.

- **iCloud:** the check is the write itself. The PUT goes to a fixed resource,
  `codechef-<CODE>.ics`, with `If-None-Match: *`, so it is create-only: `412`
  means the event is already there. CalDAV also forbids two resources with the
  same UID in one calendar, so an event with this UID under another name (e.g.
  imported from an `.ics` file) is refused with `no-uid-conflict`
  (RFC 4791 §5.3.2.1), which is also reported as already added. Asking first
  with a `REPORT` filtered on UID is not an option: iCloud rejects it with
  `412`.
- **Google:** `events.list?iCalUID=…` first; if nothing comes back, add with
  `events.import`. Import is used instead of insert because only import lets
  the extension set the iCalUID. Deleted events are not returned by the
  lookup, so a contest the user deleted can be added again.

Because the check asks the calendar, not the browser, it also catches events
added from another computer. Existing events are never overwritten, so a
contest CodeChef reschedules keeps its old time until the user deletes and
re-adds it.

## Calendar choice

`targets` in `chrome.storage.local` holds `{ apple, google }`. Which calendars
each contest went to is tracked per calendar
(`addedContests[code] = { apple?: time, google?: time }`), so switching
calendars never copies past contests across. Installs from before the choice
existed are migrated to Apple only, keeping their history.

## Google sign-in

`chrome.identity.getAuthToken` with the `oauth2` block in `manifest.json`.
Chrome caches and refreshes the token; on a 401 the extension drops the cached
token and retries once. Sign-out revokes the token at
`oauth2.googleapis.com/revoke` and clears Chrome's cache. `getAuthToken` exists
only in Google Chrome, hence no Edge or Brave support.

Scopes: `calendar.events` (add events) and `calendar.calendarlist.readonly`
(find the `Contests` calendar).

## Event details

- **Starters filter.** Anchored, case-insensitive prefix match on the contest
  name, so `Restarters 12` and `Kickstart Starters` are excluded.
- **Timezones.** Times are written as UTC (`DTSTART:20260923T143000Z`).
  CodeChef publishes IST; each calendar renders it in the device's zone.
- **Event length** is measured from the real start/end timestamps. CodeChef's
  `contest_duration` field is wrong for multi-day contests: it reports 150
  minutes for `PLACEPREP08`, which actually spans 2d 2h 29m.
- **Reminders** become a `VALARM` with `TRIGGER:-PT<n>M` on iCloud, and a
  `popup` reminder override on Google.
- **RFC 5545 conformance.** CRLF line endings, text escaped for `\ ; , newline`,
  and lines folded at 75 *octets* on byte boundaries so multi-byte characters
  in contest names are never split.
- **Offline.** The contest list is cached after each successful fetch.

## Phone-number Apple IDs

The extension tries a phone number with and without the leading `+`, but never
invents a country code, since a wrong guess just burns a failed-login attempt
against the account. At most three spellings are tried.

## Permissions

| Permission | Why |
|---|---|
| `host_permissions: codechef.com` | fetch the contest list |
| `host_permissions: *.icloud.com` | CalDAV discovery and writes, including the shard host |
| `host_permissions: googleapis.com` | Google Calendar API, and revoking the Google grant on sign-out |
| `identity` | Google sign-in through Chrome |
| `storage` | calendar choice, credentials, calendar IDs, filter and reminder settings, contest cache |

## Why CalDAV and not AppleScript

The obvious design, a native messaging host driving Calendar.app with
AppleScript, **cannot work from Chrome**. Since macOS 10.14 a process sending
Apple events must declare `NSAppleEventsUsageDescription`, and no `Info.plist`
in the Google Chrome bundle does. So macOS can never show the Automation
consent prompt for Chrome: every Apple event is denied with `-1743`, and Chrome
never appears under System Settings → Privacy & Security → Automation.

CalDAV sidesteps it entirely: plain HTTPS to Apple's servers, no Apple events,
no TCC involvement. It also guarantees the target really is an iCloud calendar,
which AppleScript could not confirm.

## Possible alternative: a launchd bridge (not built)

A credential-free route for Apple Calendar on macOS:

```
popup.js ──native host──► queue file ──launchd agent (polling)──► osascript ──► Calendar.app
```

The native host only writes a file, which needs no TCC permission; the launchd
agent runs the AppleScript in a login-session context that can hold Automation
permission.
