# CodeChef → Calendar (Chrome extension)

Lists upcoming CodeChef **Starters** contests and writes the ones you pick
straight to a calendar named **`Contests`** in **Apple iCloud**, **Google
Calendar**, or both. No `.ics` download, no import dialog, no native helper.

## Install

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** →
   this folder (the cloned repo)
2. Create an app-specific password at **account.apple.com** → Sign-In and
   Security → App-Specific Passwords. Your normal Apple ID password will not
   work; Apple requires an app-specific one for third-party CalDAV clients.
3. Click the toolbar icon. Tick **Apple iCloud Calendar**, **Google Calendar**,
   or both, connect each one, and press **Done**. For iCloud, enter your Apple
   ID and that password; for Google, see the next section first.

Each provider needs a calendar named exactly `Contests` (create it yourself).
After setup the popup opens straight to the contest list.

## Google Calendar setup

Google sign-in uses `chrome.identity`, so it **only works in Google Chrome**
(not Edge or Brave). It also needs a Google OAuth client ID. None is shipped in
this repo: everyone creates their own, in their own Google Cloud project. It
takes about five minutes and costs nothing.

1. **Give your copy its own extension ID.** Open `manifest.json` and delete
   the `"key": "…"` line. That key pins the extension ID, so leaving it in
   would give your copy the same ID as everyone else's. Then load (or reload)
   the extension and note the ID shown on `chrome://extensions`. It stays the
   same as long as you don't move the folder; if you do move it, the ID
   changes and you need a new client ID (step 4).
2. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Calendar API**.
3. Set up the **OAuth consent screen**: choose **External**, fill in the app
   name and your email, then **Publish app** so its status reads
   **In production**. You do not need to submit it for verification; it is
   your own project and you are its only user.
4. **Credentials → Create credentials → OAuth client ID → Chrome extension**,
   and paste the extension ID from step 1.
5. Put the client ID in `manifest.json` → `oauth2.client_id`, then reload the
   extension.

The first time you connect Google, you'll see **"Google hasn't verified this
app"**. That's expected for an app you built yourself: click **Advanced → Go
to (your app name)** and allow access.

*Prefer to leave the project in Testing?* Add your own Google account under
**Test users** instead of publishing. It works, but Google expires sign-ins
for projects in Testing after 7 days, so you'll have to sign in again weekly.

The extension asks for two scopes: `calendar.events` (write the events) and
`calendar.calendarlist.readonly` (find the `Contests` calendar). It cannot read
or change anything else in your Google account.

## Changing calendars

Click **Change calendars** in the popup footer at any time to switch between
Apple, Google, or both. The new choice applies only to contests you add from
then on: **nothing is ever copied between calendars.** If you switch from
Apple to Google, contests already in Apple stay in Apple only and are not
added to Google.

Each contest shows which calendar it is already in (`IN APPLE`, `IN GOOGLE`),
and those are left unticked by default. Turning a calendar off does not delete
anything from it.

## Phone-number Apple IDs

The sign-in field accepts either an email address or a phone-number Apple ID.
A phone number must include its country code (`+<country code><number>`); the extension
tries it with and without the leading `+`, but never invents a country code,
since a wrong guess just burns a failed-login attempt against the account.

**This may not work regardless.** Apple's third-party CalDAV access
authenticates against the Apple ID, and accounts with no email address attached
are frequently rejected. If sign-in fails with a correct app-specific password,
the reliable fix is to give the account an email address: on an Apple device,
**Settings → your name → iCloud → iCloud Mail → Create an @icloud.com address**.
That address becomes a valid Apple ID username and CalDAV then works normally.

If you would rather not add an email address at all, see
**Alternative: the launchd bridge** below — it needs no Apple credentials.

## Alternative: the launchd bridge (no Apple ID needed)

Chrome cannot send Apple events (see below), but a launchd agent running in your
own login session can. That makes a credential-free route possible:

```
popup.js ──native host──► queue file ──launchd agent (polling)──► osascript ──► Calendar.app
```

The native host only writes a file, which needs no TCC permission at all; the
launchd agent does the AppleScript, in a context that already holds Automation
permission on this Mac. Not built — ask if you want it.

## Why CalDAV and not AppleScript

The obvious design — a native messaging host driving Calendar.app with
AppleScript — **cannot work from Chrome**. Since macOS 10.14 a process sending
Apple events must declare `NSAppleEventsUsageDescription`, and no `Info.plist`
in the Google Chrome bundle does. So macOS can never show the Automation consent
prompt for Chrome: every Apple event is denied with `-1743`, and Chrome never
appears under System Settings → Privacy & Security → Automation. No setting
fixes this, and it affects any Chrome extension that tries the same trick.

CalDAV sidesteps it entirely — plain HTTPS to Apple's servers, no Apple events,
no TCC involvement. It also guarantees the target really is an iCloud calendar,
which AppleScript could not confirm (Calendar.app exposes no `account` or `uid`
property for a calendar).

## How it works

```
popup.js ──PROPFIND──► caldav.icloud.com   (discovery)
         ──REPORT────► …/<calendar>/   (is this contest already there?)
         ──PUT───────► p43-caldav.icloud.com/<home>/<calendar>/codechef-<CODE>.ics
```

Discovery is the standard three-step CalDAV walk:

1. `PROPFIND /` → `current-user-principal`
2. `PROPFIND <principal>` → `calendar-home-set`
3. `PROPFIND <home>` `Depth: 1` → enumerate collections, keep the ones that are
   calendars, accept `VEVENT`, and aren't read-only

Apple answers step 2 with an absolute URL on a per-account shard host
(e.g. `p43-…`, per the `x-apple-user-partition` header), so every
`href` is resolved against the URL of the response that carried it. That's also
why `host_permissions` covers `https://*.icloud.com/*` and not just the root.

## Details worth knowing

- **Starters filter.** Only contests whose name starts with "Starters" are
  listed. Anchored, case-insensitive prefix match, so `Restarters 12` and
  `Kickstart Starters` are excluded. Untick **Starters contests only** to see
  everything; the choice is remembered.
- **Already added? It says so.** Every event carries the UID
  `codechef-<CONTEST ID>@codechef.com` (e.g. `codechef-START259@codechef.com`).
  Before adding, the extension asks each selected calendar whether an event
  with that UID exists: a CalDAV `REPORT` on iCloud, an `iCalUID` lookup on
  Google. If it does, nothing is written and the popup reports it, e.g.
  `already in Apple: START259`. This catches copies made on another computer
  or imported from an `.ics` file with the same UID, not just ones this
  browser remembers. The iCloud write is also sent with `If-None-Match: *`, so
  it can never overwrite an event even if one appears between the check and
  the write. A contest you deleted from the calendar can be added again.
  Because existing events are left alone, a contest that CodeChef reschedules
  after you added it keeps its old time: delete it from the calendar and add
  it again.
- **Timezones.** Times are written as UTC (`DTSTART:20260923T143000Z`).
  CodeChef publishes IST; Apple renders it in whatever zone each device uses.
- **Event length** is measured from the real start/end timestamps. CodeChef's
  `contest_duration` field is wrong for multi-day contests — it reports 150
  minutes for `PLACEPREP08`, which actually spans 2d 2h 29m.
- **Reminders** become a `VALARM` with a `TRIGGER:-PT<n>M` offset.
- **RFC 5545 conformance.** CRLF line endings, text escaped for `\ ; , newline`,
  and lines folded at 75 *octets* on byte boundaries so multi-byte characters in
  contest names are never split.
- **Offline.** The contest list is cached after each successful fetch, so the
  popup still opens and lists contests with no connection. Writing needs the
  network, since it goes to Apple's servers.

## Security

Google sign-in is handled by Chrome; the extension never sees your Google
password. **Sign out of Google** in the setup screen revokes the grant.

The app-specific password is stored in `chrome.storage.local`, which is
**plaintext on disk** in your Chrome profile. Anything that can read that
directory can read the password. It grants CalDAV access to your iCloud
calendars — not your full Apple account, and not your Apple ID password.

Revoke it any time at account.apple.com (the same page that created it), or
click **Sign out and forget password** in the popup to erase the local copy.

## Permissions

| Permission | Why |
|---|---|
| `host_permissions: codechef.com` | fetch the contest list |
| `host_permissions: *.icloud.com` | CalDAV discovery and writes, including the shard host |
| `host_permissions: googleapis.com` | Google Calendar API, and revoking the Google grant on sign-out |
| `identity` | Google sign-in through Chrome |
| `storage` | calendar choice, credentials, calendar IDs, filter and reminder settings, contest cache |

No analytics, no remote code, no third-party servers.

## Files

- `manifest.json` — MV3 manifest (the `key` pins the extension ID; delete it for Google sync, see above)
- `popup.html` / `popup.css` — calendar choice/sign-in panel and contest list
- `popup.js` — contest fetching, filtering, iCalendar generation
- `caldav.js` — the CalDAV client (discovery, already-added check, create-only PUT)
- `gcal.js` — the Google Calendar client (sign-in, calendar lookup, already-added check, import)
- `icons/`

## Troubleshooting

| Symptom | Cause |
|---|---|
| A browser login box appears for `caldav.icloud.com` | Chrome's own Basic auth dialog, shown when iCloud answers 401. Dismiss it — typing there cannot help. Both requests use `credentials: 'omit'` so Chrome hands the 401 back to the extension instead of prompting; if the box still appears, the request is reaching iCloud but the credentials are being rejected. |
| "iCloud rejected the Apple ID or app-specific password" | Wrong password, the Apple ID given as a phone number rather than an email, or a normal Apple ID password used instead of an app-specific one. |
| "No iCloud calendar named Contests" | The calendar doesn't exist in iCloud, or is local-only. The message lists the calendar names iCloud did return. Create one in Calendar.app via File → New Calendar → iCloud. |
| "N iCloud calendars are named Contests" | Two iCloud calendars share the name. Rename one. |
| "Google sync is not set up in this copy" | `manifest.json` still has the placeholder `oauth2.client_id`. See **Google Calendar setup**. |
| "No Google calendar named Contests" | Create a calendar called `Contests` in Google Calendar (Settings → Add calendar → Create new calendar). |
| Google sign-in says "Google hasn't verified this app" | Expected for your own project. Click **Advanced → Go to (your app name)**. |
| Google sign-in says "access blocked" | The consent screen is still in Testing and your account isn't a test user. Publish it (step 3) or add yourself under **Test users**. |
| Google sign-in fails with "bad client id" or a redirect error | The client ID was made for a different extension ID. This happens if the `key` line was still in `manifest.json` or the folder was moved. Recreate the client ID with the ID now shown on `chrome://extensions`. |
| Contest list looks short | The Starters filter is on. Untick it in the footer. |
| Events don't appear on your iPhone | iCloud sync lag, or Settings → Apple ID → iCloud → Calendars is off on that device. |
