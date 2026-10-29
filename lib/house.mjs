// WORD QUEST · Netlify house: the game's rules, in one place.
// Same tabs, settings and scoring as the Google-house kit (Code.gs), but:
//   wiring = Netlify Function · filing cabinet = Google Sheet via a service account
//   storeroom = Netlify Blobs · sessions = Netlify Blobs (strong consistency)
// Keep isCorrect/normalize identical to Index.html.
import crypto from 'node:crypto';
import { serialToDate } from './google.mjs';

export const KIT_VERSION = '1.0.0-netlify-writing1';
export const HEADERS = {
  Questions: ['ID', 'Level', 'Type', 'Question / Prompt', 'Answer', 'Choice 2', 'Choice 3', 'Choice 4', 'Hint', 'Image URL', 'Active'],
  Responses: ['Timestamp', 'Class code', 'Nickname', 'Student no.', 'Attempt', 'Level', 'Question ID', 'Word', 'Student answer', 'Correct (1/0)', 'Points'],
  Scores: ['Timestamp', 'Class code', 'Nickname', 'Student no.', 'Attempt', 'Total points', 'Correct', 'Questions', 'Levels completed', 'Minutes', 'Status'],
  Uploads: ['Timestamp', 'Class code', 'Nickname', 'Student no.', 'Task', 'File name', 'Type', 'Size (KB)', 'Link (private)'],
  Writing: ['Timestamp', 'Class code', 'Nickname', 'Attempt', 'Text', 'Feedback', 'Released'],
};
export const SETTINGS = [
  ['Quiz title', 'Word Quest: Food & Market', 'ชื่อเกมที่นักเรียนเห็น / Title students see'],
  ['Class code', 'FOOD1', 'รหัสห้องที่นักเรียนต้องพิมพ์ / Code students type to enter'],
  ['Opens', '', 'วันเวลาเปิด (เว้นว่าง = เปิดตลอด) / Start date-time (blank = always open)'],
  ['Closes', '', 'วันเวลาปิด (เว้นว่าง = ไม่ปิด) / End date-time (blank = never closes)'],
  ['Ask for student number', 'Yes', 'Yes / No'],
  ['Attempts allowed', 3, 'จำนวนครั้งที่เล่นได้ (0 = ไม่จำกัด) / Plays per student (0 = unlimited)'],
  ['Points per correct answer', 10, 'คะแนนต่อข้อ / Points per correct answer'],
  ['Streak bonus', 5, 'โบนัสเมื่อตอบถูกติดกัน 3 ข้อ / Bonus for 3 correct in a row'],
  ['Show leaderboard', 'Yes', 'แสดงตารางคะแนน (ชื่อเล่นเท่านั้น) / Show top 10 (nicknames only)'],
  ['Instant feedback', 'Yes', 'Yes = ฝึก (บอกถูกผิดทันที) · No = สอบ / Yes = practice · No = test'],
  ['Upload task', 'Yes', 'ให้นักเรียนส่งรูป/เสียงหลังเล่นจบ / Photo or voice task at the end'],
  ['Upload task instructions', 'Take a photo of one food word you can find at home (no faces, please), or record yourself saying 3 words from the game.', 'คำสั่งงาน / Task instructions'],
  ['Max upload size (MB)', 4, 'ขนาดไฟล์สูงสุด (ไม่เกิน 4) / Max file size (up to 4; Netlify request limit)'],
  ['Default language', 'th', 'th หรือ en / th or en'],
];
export const SAMPLE_QUESTIONS = [
  ['F1', 1, 'choice', '🍎 Which word matches the picture?', 'apple', 'banana', 'orange', 'grape', 'ผลไม้สีแดง', '', 'Yes'],
  ['F2', 1, 'choice', '🥕 Which word matches the picture?', 'carrot', 'cabbage', 'potato', 'onion', 'ผักสีส้ม', '', 'Yes'],
  ['F3', 1, 'choice', '🍞 Which word matches the picture?', 'bread', 'rice', 'cake', 'egg', 'ทำจากแป้ง', '', 'Yes'],
  ['F4', 1, 'choice', '🐟 Which word matches the picture?', 'fish', 'chicken', 'beef', 'pork', 'อยู่ในน้ำ', '', 'Yes'],
  ['F5', 1, 'choice', '🥛 Which word matches the picture?', 'milk', 'water', 'juice', 'tea', 'ได้มาจากวัว', '', 'Yes'],
  ['F6', 2, 'gap', 'Monkeys love yellow ___.', 'bananas|banana', '', '', '', 'กล้วย', '', 'Yes'],
  ['F7', 2, 'gap', 'We cut the cake with a ___.', 'knife', '', '', '', 'มีด', '', 'Yes'],
  ['F8', 2, 'gap', 'My mum buys vegetables at the ___ every Sunday.', 'market', '', '', '', 'ตลาด', '', 'Yes'],
  ['F9', 2, 'gap', 'A lemon tastes very ___.', 'sour', 'sweet', 'salty', 'bitter', 'เปรี้ยว', '', 'Yes'],
  ['F10', 2, 'gap', 'Can I have the ___, please? I want to pay.', 'bill|check', '', '', '', 'ใบเสร็จ / ใบแจ้งค่าอาหาร', '', 'Yes'],
  ['F11', 3, 'listen', '🔊 Listen and type the word.', 'vegetable', '', '', '', 'ผัก', '', 'Yes'],
  ['F12', 3, 'listen', '🔊 Listen and type the word.', 'delicious', '', '', '', 'อร่อย', '', 'Yes'],
  ['F13', 3, 'listen', '🔊 Listen and type the word.', 'breakfast', '', '', '', 'อาหารเช้า', '', 'Yes'],
  ['F14', 3, 'listen', '🔊 Listen and type the word.', 'strawberry', '', '', '', 'สตรอว์เบอร์รี', '', 'Yes'],
  ['F15', 3, 'listen', '🔊 Listen and type the word.', 'sandwich', '', '', '', 'แซนด์วิช', '', 'Yes'],
];
const MAX_UPLOAD_MB = 4;
const MAX_UPLOADS_PER_STUDENT = 5;
const SESSION_MS = 6 * 3600 * 1000;

export const err = code => Object.assign(new Error(code), { code });
const isYes = v => v === true || /^(yes|y|true|1|ใช่)$/i.test(String(v == null ? '' : v).trim());
export function normalize(s) {
  return String(s || '').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[.!?,;:"]+$/g, '').replace(/\s+/g, ' ').trim();
}
const sha256 = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const clean = (v, max = 1200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const lockKeyFor = (code, nickname) => 'lock-' + sha256(String(code).toUpperCase() + '|' + String(nickname).toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 40);

export function createHouse({ sheets, stores, secret, siteUrl = '', now = () => Date.now(), timeZone = 'Asia/Bangkok', lockWaitMs = 5000, lockStaleMs = 15000, env = () => '' }) {
  let cache = { at: 0, settings: null, questions: null };

  const lockStore = stores.locks || stores.meta;
  async function acquireLock(key, token) {
    const until = Date.now() + lockWaitMs;
    for (let i = 0; ; i++) {
      const mine = { token, at: now() };
      let w = await lockStore.setJSON(key, mine, { onlyIfNew: true });
      if (w && w.modified) return w.etag || '';
      const cur = await lockStore.getWithMetadata(key, { type: 'json' });
      const held = cur && cur.data;
      if (cur && cur.etag && (!held || !held.token || now() - Number(held.at || 0) > lockStaleMs)) {
        w = await lockStore.setJSON(key, mine, { onlyIfMatch: cur.etag });
        if (w && w.modified) return w.etag || '';
      }
      if (Date.now() >= until) throw err('BUSY');
      await sleep(Math.min(400, 25 * 2 ** Math.min(i, 4)) * (0.5 + Math.random()));
    }
  }
  async function releaseLock(key, token, etag) {
    if (etag) { await lockStore.setJSON(key, { token: null, at: now() }, { onlyIfMatch: etag }); return; }
    const cur = await lockStore.get(key, { type: 'json' });
    if (cur && cur.token === token) await lockStore.delete(key);
  }
  async function withLock(key, fn) {
    const token = crypto.randomUUID();
    const etag = await acquireLock(key, token);
    try { return await fn(); }
    finally { await releaseLock(key, token, etag).catch(() => {}); }
  }

  async function ensureSetup() {
    const done = await stores.meta.get('setup', { type: 'json' });
    if (done && done.version === KIT_VERSION) return done;
    const meta = await sheets.meta();
    const have = new Set((meta.sheets || []).map(s => s.properties.title));
    const add = ['Settings', 'Questions', 'Responses', 'Scores', 'Uploads', 'Dashboard', 'Writing'].filter(t => !have.has(t));
    if (add.length) await sheets.batchUpdate(add.map(title => ({ addSheet: { properties: { title } } })));
    if (add.includes('Settings')) await sheets.update('Settings!A1:C' + (SETTINGS.length + 1), [['Setting', 'Value / ค่า', 'Help / คำอธิบาย'], ...SETTINGS]);
    if (add.includes('Questions')) await sheets.update('Questions!A1:K' + (SAMPLE_QUESTIONS.length + 1), [HEADERS.Questions, ...SAMPLE_QUESTIONS]);
    for (const t of ['Responses', 'Scores', 'Uploads', 'Writing']) if (add.includes(t)) await sheets.update(t + '!A1:' + String.fromCharCode(64 + HEADERS[t].length) + '1', [HEADERS[t]]);
    if (add.includes('Dashboard')) await sheets.update('Dashboard!A1:D12', dashboardCells(), 'USER_ENTERED');
    const info = { version: KIT_VERSION, timeZone: (meta.properties && meta.properties.timeZone) || timeZone, at: new Date(now()).toISOString() };
    await stores.meta.setJSON('setup', info);
    return info;
  }

  async function readConfig(force) {
    if (!force && cache.settings && now() - cache.at < 20000) return cache;
    const setup = await ensureSetup();
    const [srows, qrows] = await sheets.batchGet(['Settings!A2:B60', 'Questions!A2:K500']);
    const settings = {};
    srows.forEach(r => { if (r[0] !== undefined && r[0] !== '') settings[String(r[0]).trim()] = r[1] === undefined ? '' : r[1]; });
    const questions = qrows.map((r, i) => {
      const answers = String(r[4] == null ? '' : r[4]).split('|').map(x => x.trim()).filter(Boolean);
      const type = String(r[2] || '').trim().toLowerCase();
      return {
        id: String(r[0] || 'Q' + (i + 1)).trim(), level: Number(r[1]) || 1,
        type: ['choice', 'gap', 'listen'].includes(type) ? type : 'choice',
        prompt: String(r[3] == null ? '' : r[3]).trim(), answers,
        others: [r[5], r[6], r[7]].map(x => String(x == null ? '' : x).trim()).filter(Boolean),
        hint: String(r[8] == null ? '' : r[8]).trim(),
        image: /^https:\/\//.test(String(r[9] || '').trim()) ? String(r[9]).trim() : '',
        active: String(r[10] == null ? '' : r[10]).trim().toLowerCase() !== 'no',
      };
    }).filter(q => q.active && q.answers.length && (q.prompt || q.type === 'listen'));
    cache = { at: now(), settings, questions, timeZone: setup.timeZone };
    return cache;
  }

  async function getSession(id) {
    const s = id && /^[\w-]{20,60}$/.test(String(id)) ? await stores.sessions.get(String(id), { type: 'json' }) : null;
    if (!s || now() - s.started > SESSION_MS) throw err('SESSION_EXPIRED');
    return s;
  }
  const putSession = (id, s) => stores.sessions.setJSON(id, s);

  async function getPublicConfig() {
    const { settings: s, timeZone: tz } = await readConfig();
    return { title: s['Quiz title'] || 'Word Quest', lang: String(s['Default language'] || 'th').toLowerCase() === 'en' ? 'en' : 'th', askStudentNo: isYes(s['Ask for student number']), version: KIT_VERSION };
  }

  async function startGame(login = {}) {
    const { settings: s, questions, timeZone: tz } = await readConfig();
    const code = clean(login.classCode, 20).toUpperCase();
    if (!code || code !== String(s['Class code'] || '').trim().toUpperCase()) throw err('WRONG_CODE');
    const nickname = clean(login.nickname, 30);
    if (!nickname) throw err('NO_NICKNAME');
    const sessionId = crypto.randomUUID();
    await putSession(sessionId, { code, nickname, studentNo: clean(login.studentNo, 20), attempt: 1, started: now(), levels: {}, uploads: 0 });
    return { sessionId, player: { nickname }, rules: { upload: isYes(s['Upload task']), uploadText: String(s['Upload task instructions'] || ''), maxMB: 4 }, levels: [] };
  }

  async function submitWriting(sessionId, text) {
    const sess = await getSession(sessionId);
    const cleanText = clean(text, 1200);
    if (!cleanText) throw err('NO_TEXT');
    if (cleanText.length > 1200) throw err('TOO_BIG');

    let feedbackText = 'Feedback temporarily unavailable. Your text has been saved successfully.';
    const apiKey = env('GEMINI_API_KEY');
    if (apiKey) {
      try {
        const prompt = `1) clear topic sentence and ideas, 2) grammar and vocabulary, 3) organisation and linking words. Give exactly 3 short, kind, specific points for a university EFL learner (CEFR B1). Plain text.\n\nParagraph to evaluate:\n${cleanText}`;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              thinkingConfig: { thinkingLevel: 'LOW' },
              maxOutputTokens: 4096,
            }
          })
        });
        if (res.ok) {
          const data = await res.json();
          const candidate = data.candidates && data.candidates[0];
          const parts = candidate && candidate.content && candidate.content.parts;
          if (parts && parts[0] && parts[0].text) {
            feedbackText = parts[0].text.trim();
          }
        }
      } catch (e) {
        console.error('Gemini API error:', e);
      }
    }

    const timestamp = new Date(now()).toISOString();
    const released = 'Yes';
    await sheets.append('Writing!A1', [[timestamp, sess.code, sess.nickname, sess.attempt, cleanText, feedbackText, released]]);

    return { ok: true, feedback: feedbackText, released: isYes(released) };
  }
async function submitLevel() { return { correct: 0, total: 0, points: 0, details: [] }; }
  async function finishGame() { return { points: 0, correct: 0, total: 0, levels: 0, leaderboard: null }; }

  async function saveUpload(sessionId, file) {
    const sess = await getSession(sessionId);
    const { settings: s } = await readConfig();
    if (!isYes(s['Upload task'])) throw err('UPLOAD_OFF');
    if (!file || !file.base64) throw err('NO_FILE');
    const maxMB = Math.max(1, Math.min(Number(s['Max upload size (MB)']) || 4, MAX_UPLOAD_MB));
    const b64 = String(file.base64);
    if (b64.length * 0.75 > maxMB * 1048576 + 4) throw err('TOO_BIG');
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > maxMB * 1048576) throw err('TOO_BIG');
    const kind = sniffType(bytes);
    if (!kind) throw err('BAD_TYPE');
    if (sess.uploads >= MAX_UPLOADS_PER_STUDENT) throw err('TOO_MANY');
    const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15);
    const safe = sess.nickname.replace(/[^\w฀-๿-]+/g, '_');
    const name = stamp + '_' + sess.code + '_' + safe + (sess.studentNo ? '_' + sess.studentNo : '') + kind.ext;
    const key = crypto.randomUUID() + kind.ext;
    await stores.uploads.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { metadata: { mime: kind.mime, name } });
    const link = siteUrl.replace(/\/$/, '') + '/api/file?k=' + encodeURIComponent(key) + '&s=' + fileSig(key);
    await sheets.append('Uploads!A1', [[new Date(now()).toISOString(), sess.code, sess.nickname, sess.studentNo, String(s['Upload task instructions'] || '').slice(0, 80), name, kind.mime, Math.round(bytes.length / 1024), link]]);
    sess.uploads++;
    await putSession(sessionId, sess);
    return { ok: true, name };
  }

  const fileSig = key => crypto.createHmac('sha256', secret).update('file|' + key).digest('hex').slice(0, 32);
  async function getFile(key, sig) {
    if (!key || !/^[\w.-]{10,80}$/.test(key) || !sig || fileSig(key) !== sig) throw err('NOT_FOUND');
    const r = await stores.uploads.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!r || !r.data) throw err('NOT_FOUND');
    return { bytes: Buffer.from(r.data), mime: (r.metadata && r.metadata.mime) || 'application/octet-stream', name: (r.metadata && r.metadata.name) || key };
  }

  async function adminSnapshot() {
    const [scores, responses] = await sheets.batchGet(['Scores!A2:K5000', 'Responses!H2:J20000']);
    const playing = scores.filter(r => r[10] === 'playing').map(r => ({ nickname: r[2], studentNo: r[3], started: r[0], attempt: r[4] }));
    const finished = scores.filter(r => r[10] === 'finished').map(r => ({ nickname: r[2], studentNo: r[3], points: Number(r[5]) || 0, correct: Number(r[6]) || 0, total: Number(r[7]) || 0, at: r[0] }));
    const words = {};
    responses.forEach(r => { if (!r[0]) return; const w = (words[r[0]] = words[r[0]] || { word: r[0], tries: 0, correct: 0 }); w.tries++; w.correct += Number(r[2]) || 0; });
    const hardest = Object.values(words).map(w => ({ ...w, rate: w.tries ? w.correct / w.tries : 0 })).sort((a, b) => a.rate - b.rate).slice(0, 10);
    const cr = finished.reduce((a, f) => [a[0] + f.correct, a[1] + f.total], [0, 0]);
    return {
      at: new Date(now()).toISOString(),
      counts: { playing: playing.length, finished: finished.length, players: new Set(finished.map(f => f.nickname + '|' + f.studentNo)).size, avgPoints: finished.length ? Math.round(finished.reduce((a, f) => a + f.points, 0) / finished.length * 10) / 10 : 0, correctRate: cr[1] ? cr[0] / cr[1] : 0 },
      playing: playing.slice(-50).reverse(),
      recent: finished.slice(-15).reverse(),
      top: Object.values(finished.reduce((m, f) => { const k = f.nickname + '|' + f.studentNo; if (!m[k] || f.points > m[k].points) m[k] = f; return m; }, {})).sort((a, b) => b.points - a.points).slice(0, 10),
      hardest,
    };
  }

  return { ensureSetup, getPublicConfig, startGame, submitLevel, finishGame, saveUpload, getFile, adminSnapshot, fileSig, submitWriting };
}

function dashboardCells() {
  const fin = 'Scores!K2:K,"finished"';
  return [
    ['🏠 Word Quest · Back office (Netlify house)', '', '', ''],
    ['Live view for the teacher: open /admin on your Netlify site. This tab updates as rows arrive.', '', '', ''],
    ['Plays (finished)', '=COUNTIF(' + fin + ')', '', ''],
    ['Players', '=IFERROR(COUNTUNIQUE(FILTER(Scores!C2:C&"|"&Scores!D2:D,Scores!K2:K="finished")),0)', '', ''],
    ['Average points', '=IFERROR(ROUND(AVERAGEIF(' + fin + ',Scores!F2:F),1),0)', '', ''],
    ['Correct rate', '=IFERROR(TEXT(SUMIF(' + fin + ',Scores!G2:G)/SUMIF(' + fin + ',Scores!H2:H),"0%"),"0%")', '', ''],
    ['Uploads', '=COUNTA(Uploads!A2:A)', '', ''],
    ['', '', '', ''],
    ['Top 10', '', 'Hardest words', ''],
    ['=IFERROR(QUERY(Scores!C2:K,"select C, max(F) where K = \'finished\' group by C order by max(F) desc limit 10 label C \'Player\', max(F) \'Best\'",0),"No plays yet")', '', '=IFERROR(QUERY(Responses!H2:J,"select H, avg(J) where H is not null group by H order by avg(J) asc limit 10 label H \'Word\', avg(J) \'Correct rate\'",0),"No answers yet")', ''],
    ['', '', '', ''],
    ['', '', '', ''],
  ];
}

export function sniffType(b) {
  const at = i => (i < b.length ? b[i] : -1);
  const str = (f, l) => { let s = ''; for (let i = f; i < f + l; i++) s += String.fromCharCode(at(i) < 0 ? 0 : at(i)); return s; };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (at(0) === 0x89 && str(1, 3) === 'PNG') return { mime: 'image/png', ext: '.png' };
  if (str(0, 4) === 'GIF8') return { mime: 'image/gif', ext: '.gif' };
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') return { mime: 'audio/wav', ext: '.wav' };
  if (str(4, 4) === 'ftyp') {
    const brand = str(8, 4);
    if (/^(heic|heix|mif1|msf1|hevc)/.test(brand)) return { mime: 'image/heic', ext: '.heic' };
    if (/^M4A/.test(brand)) return { mime: 'audio/mp4', ext: '.m4a' };
    if (/^qt/.test(brand)) return { mime: 'video/quicktime', ext: '.mov' };
    return { mime: 'video/mp4', ext: '.mp4' };
  }
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return { mime: 'audio/webm', ext: '.webm' };
  if (str(0, 4) === 'OggS') return { mime: 'audio/ogg', ext: '.ogg' };
  if (str(0, 3) === 'ID3' || (at(0) === 0xff && (at(1) & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: '.mp3' };
  if (str(0, 4) === '%PDF') return { mime: 'application/pdf', ext: '.pdf' };
  return null;
}
