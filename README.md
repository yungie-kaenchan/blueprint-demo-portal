# 🏠 Word Quest · Netlify house

The same vocabulary game as the Google-house kit, built a different way:

| House part | Netlify house | (Google house, for comparison) |
|---|---|---|
| Land & address | **Netlify**: `your-name.netlify.app` | `script.google.com/…/exec` |
| Rooms (page) | `shared/Index.html` (the same game page; each deploy builds `public/index.html` from it) | Index.html inside Apps Script |
| Wiring | **Netlify Function** `netlify/functions/game.mjs` | Code.gs (Apps Script) |
| The safe (keys) | **Netlify environment variables** | Script Properties |
| Filing cabinet | **Google Sheet**, written through a *service account* | Google Sheet |
| Storeroom (uploads) | **Netlify Blobs** (private links in the Sheet) | Google Drive |
| Back office | Sheet Dashboard tab + **live `/admin` page** (updates every 8 s) | Sheet Dashboard tab |

No Apps Script at all. **Cost: ฿0** on free plans (Netlify Free has a monthly credit limit, and each production deploy uses credits; your AI builder may be paid). **Setup time: about 45–60 minutes the first time.**

> **Why not Google Drive for uploads?** A service account can't save files into a personal Google Drive; Google refuses with "Service Accounts do not have storage quota". So the Netlify house keeps uploads in Netlify Blobs, and your Sheet's Uploads tab lists a private link to each file.

---

## Accounts you need (all free)
1. A **Google** account for Google Sheets + Google Cloud: a personal Gmail only if your school allows class data in it; otherwise your school account (some block service-account keys or Apps Script)
2. A **Netlify** account
3. A **GitHub** account (only for the one-click Deploy button)

## Step 1 · Make the robot key (Google Cloud service account) · สร้าง "กุญแจหุ่นยนต์"
1. Open **https://console.cloud.google.com** with your Gmail → top bar **Select a project → New project** → name it `word-quest` → **Create**.
2. Menu ☰ → **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. ☰ → **IAM & Admin → Service Accounts → + Create service account** → name `word-quest-robot` → **Create and continue** → skip the roles → **Done**.
4. Click the new account → tab **Keys → Add key → Create new key → JSON → Create**. A `.json` file downloads. **This is the master key: never email it, never put it on GitHub, never paste it into ChatGPT or Gemini.**
5. Copy the account's email (it looks like `word-quest-robot@word-quest-123.iam.gserviceaccount.com`).

> School Google Workspace accounts sometimes block step 4 ("key creation is disabled"). Use a personal Gmail only if your school allows class data in it; otherwise use the Google-house kit on your school account.

## Step 2 · Make the filing cabinet (Google Sheet) · สร้างตู้เอกสาร
1. Open **https://sheets.new**, name it `Word Quest · Netlify house`.
2. **Share** → paste the robot's email → **Editor** → untick "Notify" → **Share**.
3. Copy the Sheet's address. The robot will create every tab (Settings, Questions, Responses, Scores, Uploads, Dashboard) on the first visit.

## Step 3 · Put the house on Netlify · ตั้งบ้านบน Netlify
**Option A, one click:** press the portal's **Deploy to Netlify** button → sign in to GitHub and Netlify → fill the three boxes:

| Box | Paste |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | open the `.json` key file in Notepad → copy **everything** |
| `SHEET_ID` | your Sheet's address (the whole link is fine) |
| `ADMIN_PASSCODE` | your teacher passcode for `/admin` (make one up; never tell students) |

→ **Save & Deploy**. In 1–2 minutes your site is live.

**Option B, facilitator/advanced:** Netlify CLI from this folder: `npm install`, `netlify deploy --prod`, then add the same three variables under **Project configuration → Environment variables** and redeploy.

## Step 4 · Nice address + first test · ตั้งชื่อเว็บ และทดสอบ
1. Netlify → **Project overview → Customize → Manage project name and cover image** → e.g. `foodquest-ploy` → `foodquest-ploy.netlify.app`.
2. Open the site once: the robot fills your Sheet with the tabs and 15 sample questions.
3. Edit **Settings** and **Questions** in the Sheet exactly as in the Google kit (no code). Changes show within about 20 seconds.
4. Open `/admin` on your site and enter your `ADMIN_PASSCODE` to watch students play live.

## Remodel (change the code) · รีโนเวต
Use **ChatGPT Go** (attach `shared/Index.html` or `netlify/functions/game.mjs`; never edit `public/index.html`, which each deploy rebuilds) or **Gemini** with the Engine's Prompt Pack. Then paste the new file in **GitHub's web editor → Commit**, and Netlify redeploys by itself. The game page comes from `shared/Index.html` (`node tools/build-public.mjs`), the same page as the Google kit.

## Smart house (AI inside the app)
Learners 18+ only: the Gemini API terms require users to be 18+, so for school students the teacher runs the AI outside the app on de-identified work. The free Gemini API tier may use your inputs to improve Google's products. Add `OPENAI_API_KEY` or `GEMINI_API_KEY` as another Netlify environment variable, and ask ChatGPT or Gemini to add a function that reads it with `Netlify.env.get(...)`. The key stays in the safe; the page never sees it.

## Troubleshooting
| You see | Fix |
|---|---|
| "Your teacher has not finished setup" | `GOOGLE_SERVICE_ACCOUNT_JSON` or `SHEET_ID` is missing. Add it in Netlify, then **Deploys → Trigger deploy** |
| Nothing saves / SHEET_NOT_SHARED | Share the Sheet with the robot's email as **Editor** |
| BAD_SERVICE_ACCOUNT | Paste the **whole** JSON file, from `{` to `}` |
| "The whole class is sending at once" | Google allows about 60 writes per minute per robot. The page retries by itself; start groups a minute apart for classes over about 40 |
| Uploads too big | The Netlify house accepts files up to 4 MB (photos and short voice clips) |

## Privacy (PDPA)
Same rules as the Google kit: nicknames or student numbers only; no identifiable student data to AI tools (de-identify first: remove names, numbers, personal details); tell students and parents what is saved; delete at term end. The JSON key is the master key to your Sheet. If it leaks, delete it in Google Cloud (Keys tab) and make a new one. Uploads live in your Netlify site's Blobs; delete the site, or its blobs, at term end.

## For developers
- `lib/house.mjs`: game rules (same API as the Google kit's Code.gs). `lib/google.mjs`: service-account JWT plus a small Sheets REST client (no SDK).
- Writes use `valueInputOption=RAW`, so nothing a student types is ever evaluated as a formula.
- Sessions and the answer key for each session live in Netlify Blobs (strong consistency). Upload links are HMAC-signed.
- One student at a time: `startGame`, `submitLevel` and `finishGame` take a short per-student lock in Netlify Blobs (class code + nickname), using conditional writes (`onlyIfNew` / `onlyIfMatch` ETag). The lock waits up to about 5 s and then returns `BUSY` (the page says "wait a moment and tap again"); a lock older than 15 s counts as stale and is taken over. This keeps the attempt limit and attempt numbers right when a student taps Start several times, and stops a double tap from writing answers twice.
- `finishGame` re-reads the reserved Scores row (class code, nickname, student no., attempt, reservation time, status `playing`) before writing. If the teacher sorted the tab, it finds the row again; if the row is gone, it adds a new row. It never overwrites someone else's row.
- `node test/house.test.mjs`: 20 tests with an in-memory Sheet and Blobs (the concurrency tests add network-like latency). `node test/serve.mjs`: local preview on :8767 (admin passcode `demo`).

© 2026 Dr. Payungsak Kaenchan, EdD · Faculty of Liberal Arts, Mahidol University · Blueprint Before You Build (AI & Design Thinking Season 2)
