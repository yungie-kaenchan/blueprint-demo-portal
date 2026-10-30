# ✍️ Writing Coach · demo portal (Netlify house)

The demo portal for the workshop *Blueprint Before You Build* (Thailand TESOL, 31 Oct 2026). University EFL learners (18+) log in, then use three tabs: **Writing** (AI feedback on a paragraph), **Speaking** (AI feedback on a recording) and **Avatar**. The teacher watches, hides or releases the AI feedback at `/admin`. It was built from the Engine's prompts with Gemini and ChatGPT, one change at a time, then hardened. **Test data only.**

| House part | Here |
|---|---|
| Land & address | Netlify (`your-name.netlify.app`) |
| Rooms (page) | `shared/Index.html` (each deploy builds `public/index.html` from it) and `public/admin.html` |
| Wiring | Netlify Function `netlify/functions/game.mjs` → rules in `lib/house.mjs` |
| The safe (keys) | Netlify environment variables |
| Filing cabinet | Google Sheet, written by a service account (tabs: Settings, Writing, Speaking, Avatars, Uploads) |
| Storeroom | Netlify Blobs (recordings, sessions, PINs, daily AI counts) |
| Back office | live `/admin` page (updates every 8 s) |
| Smart appliance | Gemini API, called only by the server (adult learners only: Gemini API terms) |

## Front-door lock and other safeguards
- **Class code + nickname + the student's own 4-digit PIN.** The first log-in with a nickname sets its PIN; later log-ins must match it, so nobody else can post under that nickname. Five wrong PINs lock the nickname for 15 minutes. A student who forgets the PIN asks the teacher, who resets it in `/admin`. PINs are kept only as keyed hashes in Netlify Blobs, never in the Sheet.
- **Recordings are private.** The Sheet stores a file reference (`file:…`), not a link. `/admin` makes a signed link that works for 1 hour, so a copied link stops working.
- **Daily AI limit** to protect the API bill: 20 AI replies per student and 300 for the class per day (change with `AI_STUDENT_DAILY_CAP` and `AI_DAILY_CAP`). Over the limit, the work is still saved and waits for the teacher.
- **`/admin` passcode lockout:** 10 wrong passcodes from one device lock it for 15 minutes.
- **Students see feedback the teacher releases** under "Feedback for you", never anyone else's. With `Release AI feedback automatically = No`, nothing reaches students until the teacher releases it.
- **Nothing is lost on refresh:** the log-in lasts for the browser tab, and the writing draft stays on the device until it is sent or the student logs out.
- Only audio files up to 4 MB are accepted (checked by their bytes, not their name). Writes use `valueInputOption=RAW`, so nothing a student types runs as a formula.

## Environment variables (Netlify → Project configuration → Environment variables)
| Name | What |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the robot's whole JSON key |
| `SHEET_ID` | the Sheet's ID or URL (share the Sheet with the robot's email as Editor) |
| `ADMIN_PASSCODE` | the teacher passcode for `/admin` |
| `GEMINI_API_KEY` | optional: AI feedback |
| `AI_DAILY_CAP`, `AI_STUDENT_DAILY_CAP` | optional: daily AI limits |
| `FILE_SECRET` | optional: signs PINs and file links (default: a hash of the robot's key; changing either one resets every PIN) |

After changing a variable, redeploy: functions keep the old values until a new deploy.

## Sheet settings (Settings tab)
`Quiz title` (the portal's name), `Class code`, `Opens` / `Closes`, `Ask for student number`, `Release AI feedback automatically`, `Max upload size (MB)`, `Default language`. Changes show within about 20 seconds.

## Privacy (PDPA)
Nicknames only; no identifiable student data to AI tools; tell students what is saved; delete the Sheet rows and the site's Blobs at term end. If the JSON key leaks, delete it in Google Cloud (Keys tab) and make a new one.

## For developers
- `node test/portal.test.mjs`: 22 tests with an in-memory Sheet and Blobs and a fake Gemini (PINs and lockout, resume, expiring links, AI limits, release flow). `node test/google.test.mjs`: the Sheets client's retry on 429.
- `node test/serve.mjs`: local preview on :8767 (class code `DEMO31`, admin passcode `demo`).
- Remodel with ChatGPT or Gemini: attach `shared/Index.html` or the file you want changed, ask for one change, get the full file back, run the tests, then commit.

© 2026 Dr. Payungsak Kaenchan, EdD · Blueprint Before You Build (AI & Design Thinking Season 2)
