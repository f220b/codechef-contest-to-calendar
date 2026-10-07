# CodeChef → Calendar (Chrome extension)

Lists upcoming CodeChef **Starters** contests and adds the ones you pick to a
calendar named **`Contests`** in **Apple iCloud**, **Google Calendar**, or both.

How it works under the hood is in [workflow.md](workflow.md).

## Install

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** →
   this folder (the cloned repo)
2. Create a calendar named exactly `Contests` in each calendar you want to use
   (Apple, Google, or both).
3. Click the toolbar icon. Tick **Apple iCloud Calendar**, **Google Calendar**,
   or both, connect each one, and press **Done**. Apple needs an app-specific
   password (next section); Google needs a one-time setup (section after).

After setup the popup opens straight to the contest list.

## Apple iCloud setup

Create an app-specific password at **account.apple.com** → Sign-In and
Security → App-Specific Passwords. Your normal Apple ID password will not work.
Enter your Apple ID and that password in the popup and press **Connect iCloud**.

**Phone-number Apple IDs** must include the country code
(`+<country code><number>`). Apple may still reject an Apple ID that has no
email address attached. If sign-in fails with a correct app-specific password,
add an email address to the account: on an Apple device, **Settings → your
name → iCloud → iCloud Mail → Create an @icloud.com address**, then sign in
with that address.

## Google Calendar setup

Google sync **only works in Google Chrome** (not Edge or Brave), and needs a
Google OAuth client ID of your own. It takes about five minutes and costs
nothing.

1. **Give your copy its own extension ID.** Open `manifest.json` and delete
   the `"key": "…"` line. Then load (or reload) the extension and note the ID
   shown on `chrome://extensions`. It stays the same as long as you don't move
   the folder; if you do move it, you need a new client ID (step 4).
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
**Test users** instead of publishing. It works, but you'll have to sign in
again every 7 days.

## Using it

- **Pick and add.** Tick the contests you want and press **Add**. Choose a
  reminder (none, 10 min, 30 min, 1 hour or 1 day before) in the footer.
- **Starters only.** By default only Starters contests are listed. Untick
  **Starters contests only** to see every upcoming contest.
- **Already added.** A contest that is already in a calendar is not added
  again; the popup tells you, e.g. `already in Apple: START259`. Contests
  added earlier are tagged `IN APPLE` / `IN GOOGLE` and start unticked.
- **Rescheduled contest?** An existing event is never changed. If CodeChef
  moves a contest you already added, delete it from your calendar and add it
  again.
- **Changing calendars.** Click **Change calendars** in the footer at any time
  to switch between Apple, Google, or both. The new choice applies only to
  contests you add from then on: nothing is copied between calendars, and
  turning a calendar off does not delete anything from it.
- **Offline.** The last contest list is shown when you have no connection;
  adding needs the network.

## Privacy and security

- The Apple app-specific password is stored **unencrypted** in your Chrome
  profile. It gives access to your iCloud calendars only, not your Apple
  account. Revoke it any time at account.apple.com, or click **Sign out and
  forget password** in the setup screen.
- Google sign-in is handled by Chrome; the extension never sees your Google
  password. It can only add events and see your list of calendars. **Sign out
  of Google** in the setup screen revokes its access.
- No analytics, no remote code, no third-party servers: the extension talks
  only to CodeChef, Apple and Google.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A browser login box appears for `caldav.icloud.com` | Dismiss it; typing there cannot help. It means iCloud rejected the credentials. |
| "iCloud rejected the Apple ID or app-specific password" | Check you used an app-specific password, not your normal one. For phone-number Apple IDs see **Apple iCloud setup**. |
| "No iCloud calendar named Contests" | Create one in Calendar.app via File → New Calendar → iCloud (not "On My Mac"). |
| "N iCloud calendars are named Contests" | Rename all but one. |
| "Google sync is not set up in this copy" | Follow **Google Calendar setup**. |
| "No Google calendar named Contests" | In Google Calendar: Settings → Add calendar → Create new calendar. |
| "Google hasn't verified this app" | Expected. Click **Advanced → Go to (your app name)**. |
| Google sign-in says "access blocked" | Publish the consent screen (setup step 3) or add yourself under **Test users**. |
| Google sign-in fails with "bad client id" | The client ID doesn't match the extension ID: the `key` line is still in `manifest.json`, or the folder moved. Create a new client ID for the ID now on `chrome://extensions`. |
| Contest list looks short | Untick **Starters contests only**. |
| Events don't appear on your iPhone | Wait for iCloud to sync, and check Settings → your name → iCloud → Calendars is on. |
