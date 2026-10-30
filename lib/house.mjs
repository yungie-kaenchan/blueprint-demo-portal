
// WRITING COACH · Netlify house: the portal's rules, in one place.
//   wiring = Netlify Function · filing cabinet = Google Sheet via a service account
//   storeroom = Netlify Blobs · sessions, PINs and daily AI counts = Netlify Blobs (strong consistency)
import crypto from 'node:crypto';
import { serialToDate } from './google.mjs';

export const KIT_VERSION = '1.1.0-netlify-pin-links';

export const HEADERS = {
  Uploads: ['Timestamp', 'Class code', 'Nickname', 'Student no.', 'Task', 'File name', 'Type', 'Size (KB)', 'File (open from /admin)'],
  Writing: ['Timestamp', 'Class code', 'Nickname', 'Attempt', 'Text', 'Feedback', 'Released'],
  Speaking: ['Timestamp', 'Class code', 'Nickname', 'Attempt', 'Transcript', 'Feedback', 'Released', 'File'],
  Avatars: ['Timestamp', 'Class code', 'Nickname', 'Face', 'Hair', 'Hair colour', 'Eyes', 'Mouth', 'Shirt'],
};

export const SETTINGS = [
  ['Quiz title', 'Writing Coach', 'ชื่อพอร์ทัลที่นักเรียนเห็น / Title students see'],
  ['Class code', 'CLASS1', 'รหัสห้องที่นักเรียนต้องพิมพ์ / Code students type to enter'],
  ['Opens', '', 'วันเวลาเปิด (เว้นว่าง = เปิดตลอด) / Start date-time (blank = always open)'],
  ['Closes', '', 'วันเวลาปิด (เว้นว่าง = ไม่ปิด) / End date-time (blank = never closes)'],
  ['Ask for student number', 'No', 'Yes / No'],
  ['Release AI feedback automatically', 'Yes', 'Yes = แสดงคำแนะนำ AI ทันที / Release AI feedback immediately · No = ครูเลือกปล่อยเอง / Teacher releases manually'],
  ['Max upload size (MB)', 4, 'ขนาดไฟล์สูงสุด (ไม่เกิน 4) / Max file size (up to 4; Netlify request limit)'],
  ['Default language', 'th', 'th หรือ en / th or en'],
];

const MAX_UPLOAD_MB = 4;
const MAX_UPLOADS_PER_STUDENT = 5;
const SESSION_MS = 6 * 3600 * 1000;
const LINK_TTL_S = 3600;            // audio links work for 1 hour, then /admin makes a fresh one
const PIN_TRIES = 5;                // wrong PINs before a 15-minute lock
const PIN_LOCK_MS = 15 * 60 * 1000;

const ALLOWED_AVATAR = {
  face: ['round', 'oval', 'square'],
  hair: ['short', 'long', 'curly', 'bald'],
  hairColor: ['black', 'brown', 'blonde', 'red', 'white'],
  eyes: ['normal', 'happy', 'wink'],
  mouth: ['smile', 'grin', 'neutral'],
  shirt: ['red', 'blue', 'green', 'yellow', 'purple', 'orange']
};

export const err = code => Object.assign(new Error(code), { code });
const isYes = v => v === true || /^(yes|y|true|1|ใช่)$/i.test(String(v == null ? '' : v).trim());

const sha256 = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const clean = (v, max = 1200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
// a paragraph keeps its line breaks
const cleanText = (v, max = 1200) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const nickKey = (code, nickname) => sha256(String(code).toUpperCase() + '|' +
  String(nickname).toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 40);

// the Sheet keeps "file:<key>"; links written before v1.1 kept "/api/file?k=<key>&s=…"
export const keyFromLink = v => {
  const m = String(v || '').match(/^file:([\w.-]{10,80})$/) || String(v || '').match(/[?&]k=([\w.-]{10,80})/);
  return m ? m[1] : '';
};

export function createHouse({
  sheets,
  stores,
  secret,
  siteUrl = '',
  now = () => Date.now(),
  timeZone = 'Asia/Bangkok',
  env = () => ''
}) {
  let cache = { at: 0, settings: null };
  const hmac = t => crypto.createHmac('sha256', secret).update(t).digest('hex');

  async function ensureSetup() {
    const done = await stores.meta.get('setup', { type: 'json' });
    if (done && done.version === KIT_VERSION) return done;

    const meta = await sheets.meta();
    const have = new Set((meta.sheets || []).map(s => s.properties.title));
    const add = ['Settings', 'Uploads', 'Writing', 'Speaking', 'Avatars'].filter(t => !have.has(t));

    if (add.length) {
      await sheets.batchUpdate(add.map(title => ({ addSheet: { properties: { title } } })));
    }

    if (add.includes('Settings')) {
      await sheets.update('Settings!A1:C' + (SETTINGS.length + 1),
        [['Setting', 'Value / ค่า', 'Help / คำอธิบาย'], ...SETTINGS]);
    } else {
      // Upgrade an existing Sheet without changing its current settings.
      const [existing] = await sheets.batchGet(['Settings!A2:C100']);
      const settingName = 'Release AI feedback automatically';
      if (!existing.some(r => String(r[0] || '').trim() === settingName)) {
        await sheets.append('Settings!A1', [SETTINGS.find(r => r[0] === settingName)]);
      }
    }

    for (const t of ['Uploads', 'Writing', 'Speaking', 'Avatars']) {
      if (add.includes(t)) {
        await sheets.update(t + '!A1:' + String.fromCharCode(64 + HEADERS[t].length) + '1', [HEADERS[t]]);
      }
    }

    const info = {
      version: KIT_VERSION,
      timeZone: (meta.properties && meta.properties.timeZone) || timeZone,
      at: new Date(now()).toISOString()
    };
    await stores.meta.setJSON('setup', info);
    return info;
  }

  async function readConfig(force) {
    if (!force && cache.settings && now() - cache.at < 20000) return cache;
    const setup = await ensureSetup();
    const [srows] = await sheets.batchGet(['Settings!A2:B100']);
    const settings = {};
    srows.forEach(r => {
      if (r[0] !== undefined && r[0] !== '') settings[String(r[0]).trim()] = r[1] === undefined ? '' : r[1];
    });
    cache = { at: now(), settings, timeZone: setup.timeZone };
    return cache;
  }

  async function getSession(id) {
    const s = id && /^[\w-]{20,60}$/.test(String(id))
      ? await stores.sessions.get(String(id), { type: 'json' })
      : null;
    if (!s || now() - s.started > SESSION_MS) throw err('SESSION_EXPIRED');
    return s;
  }

  const putSession = (id, s) => stores.sessions.setJSON(id, s);

  function status(s, tz) {
    const t = now();
    const asDate = v => typeof v === 'number' ? serialToDate(v, tz) : (v ? new Date(v) : null);
    const o = asDate(s['Opens']), c = asDate(s['Closes']);
    if (o && !isNaN(o) && t < o.getTime()) return { state: 'notyet', opens: o.toISOString() };
    if (c && !isNaN(c) && t > c.getTime()) return { state: 'closed' };
    return { state: 'open', closes: c && !isNaN(c) ? c.toISOString() : null };
  }

  const rulesFor = s => ({ maxMB: Math.max(1, Math.min(Number(s['Max upload size (MB)']) || 4, MAX_UPLOAD_MB)) });

  async function getPublicConfig() {
    const { settings: s, timeZone: tz } = await readConfig();
    return {
      title: s['Quiz title'] || 'Writing Coach',
      lang: String(s['Default language'] || 'th').toLowerCase() === 'en' ? 'en' : 'th',
      askStudentNo: isYes(s['Ask for student number']),
      status: status(s, tz),
      version: KIT_VERSION
    };
  }

  /* ---------- Front-door lock: class code + nickname + the student's own PIN ---------- */
  // The first log-in with a nickname sets its 4-digit PIN; later log-ins must match it.
  // 5 wrong PINs lock that nickname for 15 minutes. The teacher can reset a PIN in /admin.
  async function checkPin(code, nickname, pin) {
    if (!/^\d{4}$/.test(pin)) throw err('NO_PIN');
    const key = 'pin-' + nickKey(code, nickname);
    const want = hmac('pin|' + key + '|' + pin);
    for (let i = 0; i < 6; i++) {
      const cur = await stores.meta.getWithMetadata(key, { type: 'json' });
      if (!cur || !cur.data || !cur.data.h) {
        const w = cur
          ? await stores.meta.setJSON(key, { h: want, fails: 0, until: 0, at: now() }, { onlyIfMatch: cur.etag })
          : await stores.meta.setJSON(key, { h: want, fails: 0, until: 0, at: now() }, { onlyIfNew: true });
        if (w && w.modified) return true;              // a new PIN was set
        continue;
      }
      const d = cur.data;
      if (d.until && now() < d.until) throw err('PIN_LOCKED');
      if (sameHex(d.h, want)) {
        if (d.fails) await stores.meta.setJSON(key, { ...d, fails: 0, until: 0 }, { onlyIfMatch: cur.etag });
        return false;
      }
      const fails = (d.fails || 0) + 1, lock = fails >= PIN_TRIES;
      const w = await stores.meta.setJSON(key, { ...d, fails: lock ? 0 : fails, until: lock ? now() + PIN_LOCK_MS : 0 }, { onlyIfMatch: cur.etag });
      if (w && w.modified) throw err(lock ? 'PIN_LOCKED' : 'WRONG_PIN');
      await sleep(20 * (i + 1));
    }
    throw err('BUSY');
  }

  async function resetPin(nickname) {
    const { settings: s } = await readConfig(true);
    const code = String(s['Class code'] || '').trim().toUpperCase();
    const nick = clean(nickname, 30);
    if (!code || !nick) throw err('NO_NICKNAME');
    const key = 'pin-' + nickKey(code, nick);
    const had = await stores.meta.get(key, { type: 'json' });
    await stores.meta.delete(key);
    return { ok: true, nickname: nick, existed: !!(had && had.h) };
  }

  async function startGame(login = {}) {
    const { settings: s, timeZone: tz } = await readConfig();
    const gate = status(s, tz);
    if (gate.state !== 'open') throw err(gate.state === 'notyet' ? 'NOT_OPEN' : 'CLOSED');
    const code = clean(login.classCode, 20).toUpperCase();
    if (!code || code !== String(s['Class code'] || '').trim().toUpperCase()) throw err('WRONG_CODE');

    const nickname = clean(login.nickname, 30);
    if (!nickname) throw err('NO_NICKNAME');
    const studentNo = clean(login.studentNo, 20);
    if (isYes(s['Ask for student number']) && !studentNo) throw err('NO_STUDENT_NO');
    const newPin = await checkPin(code, nickname, clean(login.pin, 6));

    const sessionId = crypto.randomUUID();
    await putSession(sessionId, { code, nickname, studentNo, attempt: 1, started: now(), uploads: 0 });
    return { sessionId, player: { nickname, newPin }, rules: rulesFor(s) };
  }

  // After a page refresh the page sends its saved session back instead of logging in again.
  async function resumeSession(sessionId) {
    const sess = await getSession(sessionId);
    const { settings: s } = await readConfig();
    return { sessionId, player: { nickname: sess.nickname }, rules: rulesFor(s) };
  }

  /* ---------- Daily AI limit: protects the API key's bill ---------- */
  // Each student gets AI_STUDENT_DAILY_CAP AI replies a day (default 20) and the class AI_DAILY_CAP (default 300).
  // Over the limit, the work is still saved and waits for the teacher.
  async function takeAiTurn(sess) {
    const day = new Date(now() + 7 * 3600 * 1000).toISOString().slice(0, 10);   // Thai calendar day
    const key = 'ai-' + day, who = nickKey(sess.code, sess.nickname).slice(0, 16);
    const cap = Number(env('AI_DAILY_CAP')) || 300, perStudent = Number(env('AI_STUDENT_DAILY_CAP')) || 20;
    for (let i = 0; i < 8; i++) {
      const cur = await stores.meta.getWithMetadata(key, { type: 'json' });
      const d = (cur && cur.data) || { total: 0, per: {} };
      if (d.total >= cap || (d.per[who] || 0) >= perStudent) return false;
      d.total++; d.per[who] = (d.per[who] || 0) + 1;
      const w = cur
        ? await stores.meta.setJSON(key, d, { onlyIfMatch: cur.etag })
        : await stores.meta.setJSON(key, d, { onlyIfNew: true });
      if (w && w.modified) return true;
      await sleep(25 * (i + 1) * (0.5 + Math.random()));
    }
    throw err('BUSY');
  }

  async function askGemini(apiKey, parts) {
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' }, maxOutputTokens: 4096 }
          })
        }
      );
      if (!res.ok) return '';
      const data = await res.json();
      const candidate = data.candidates && data.candidates[0];
      const out = candidate && candidate.content && candidate.content.parts;
      return out && out[0] && out[0].text ? out[0].text.trim() : '';
    } catch (e) {
      console.error('Gemini API error:', e);
      return '';
    }
  }

  async function autoRelease() {
    const { settings: s } = await readConfig(true);
    const v = s['Release AI feedback automatically'];
    return isYes(v === undefined ? 'Yes' : v);
  }

  async function submitWriting(sessionId, text) {
    const sess = await getSession(sessionId);
    const body = cleanText(text, 1200);
    if (!body) throw err('NO_TEXT');

    let feedbackText = 'Feedback temporarily unavailable. Your text has been saved successfully.';
    let limited = false;
    const apiKey = env('GEMINI_API_KEY');
    if (apiKey) {
      if (await takeAiTurn(sess)) {
        const prompt = `1) clear topic sentence and ideas, 2) grammar and vocabulary, 3) organisation and linking words. Give exactly 3 short, kind, specific points for a university EFL learner (CEFR B1). Plain text.\n\nParagraph to evaluate:\n${body}`;
        feedbackText = await askGemini(apiKey, [{ text: prompt }]) || feedbackText;
      } else {
        limited = true; feedbackText = '';
      }
    }

    const released = !limited && await autoRelease();
    await sheets.append('Writing!A1', [[
      new Date(now()).toISOString(), sess.code, sess.nickname, sess.attempt, body, feedbackText, released ? 'Yes' : 'No'
    ]]);

    // Never return hidden feedback to the student.
    if (!released) return { ok: true, released: false, limited };
    return { ok: true, feedback: feedbackText, released: true };
  }

  async function submitSpeaking(sessionId, file) {
    const sess = await getSession(sessionId);
    if (!file || !file.base64) throw err('NO_FILE');

    const upload = await saveUpload(sessionId, file);

    let transcript = 'Transcript unavailable.';
    let feedbackText = 'Feedback temporarily unavailable. Audio saved successfully.';
    let limited = false;
    const apiKey = env('GEMINI_API_KEY');
    if (apiKey) {
      if (await takeAiTurn(sess)) {
        const prompt = 'First write what the learner said (transcript). ' +
          'Then give exactly 3 short, kind, specific points on fluency, pronunciation and vocabulary ' +
          'for a university EFL learner (CEFR B1). Plain text.';
        const out = await askGemini(apiKey, [
          { text: prompt },
          { inline_data: { mime_type: upload.mime || file.type || 'audio/webm', data: file.base64 } }
        ]);
        if (out) {
          feedbackText = out;
          const match = out.match(/transcript[:\s]+([^\n]+)/i);
          if (match) transcript = match[1];
        }
      } else {
        limited = true; feedbackText = '';
      }
    }

    const released = !limited && await autoRelease();
    await sheets.append('Speaking!A1', [[
      new Date(now()).toISOString(), sess.code, sess.nickname, sess.attempt,
      transcript, feedbackText, released ? 'Yes' : 'No', 'file:' + upload.key
    ]]);

    if (!released) return { ok: true, released: false, limited };
    return { ok: true, transcript, feedback: feedbackText, released: true };
  }

  async function saveAvatar(sessionId, choices) {
    const sess = await getSession(sessionId);
    if (!choices || typeof choices !== 'object') throw err('INVALID_CHOICES');

    const avatar = {};
    Object.entries(ALLOWED_AVATAR).forEach(([key, values]) => {
      avatar[key] = values.includes(choices[key]) ? choices[key] : values[0];
    });
    const row = [
      new Date(now()).toISOString(), sess.code, sess.nickname,
      avatar.face, avatar.hair, avatar.hairColor, avatar.eyes, avatar.mouth, avatar.shirt
    ];

    const [rows] = await sheets.batchGet(['Avatars!A2:I5000']);
    const idx = rows.findIndex(r =>
      String(r[1] || '').toUpperCase() === sess.code &&
      String(r[2] || '').toLowerCase() === sess.nickname.toLowerCase());
    if (idx >= 0) await sheets.update(`Avatars!A${idx + 2}:I${idx + 2}`, [row]);
    else await sheets.append('Avatars!A1', [row]);
    return { ok: true, avatar };
  }

  async function getAvatar(sessionId) {
    const sess = await getSession(sessionId);
    const [rows] = await sheets.batchGet(['Avatars!A2:I5000']);
    const found = rows.slice().reverse().find(r =>
      String(r[1] || '').toUpperCase() === sess.code &&
      String(r[2] || '').toLowerCase() === sess.nickname.toLowerCase());
    if (!found) return null;
    return {
      face: found[3] || '', hair: found[4] || '', hairColor: found[5] || '',
      eyes: found[6] || '', mouth: found[7] || '', shirt: found[8] || ''
    };
  }

  /* ---------- Storeroom: private audio in Netlify Blobs ---------- */
  async function saveUpload(sessionId, file) {
    const sess = await getSession(sessionId);
    const { settings: s } = await readConfig();
    if (!file || !file.base64) throw err('NO_FILE');

    const maxMB = rulesFor(s).maxMB;
    const b64 = String(file.base64);
    if (b64.length * 0.75 > maxMB * 1048576 + 4) throw err('TOO_BIG');
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > maxMB * 1048576) throw err('TOO_BIG');

    const kind = sniffType(bytes);
    if (!kind || !/^audio\//.test(kind.mime)) throw err('BAD_TYPE');
    if (sess.uploads >= MAX_UPLOADS_PER_STUDENT) throw err('TOO_MANY');

    const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15);
    const safe = sess.nickname.replace(/[^\w฀-๿-]+/g, '_');
    const name = stamp + '_' + sess.code + '_' + safe + (sess.studentNo ? '_' + sess.studentNo : '') + kind.ext;
    const key = crypto.randomUUID() + kind.ext;

    await stores.uploads.set(key,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { metadata: { mime: kind.mime, name } });

    await sheets.append('Uploads!A1', [[
      new Date(now()).toISOString(), sess.code, sess.nickname, sess.studentNo,
      'Speaking', name, kind.mime, Math.round(bytes.length / 1024), 'file:' + key
    ]]);

    sess.uploads++;
    await putSession(sessionId, sess);
    return { ok: true, name, key, mime: kind.mime };
  }

  // A link is signed with its own expiry time, so a copied link stops working after an hour.
  const fileSig = (key, exp) => hmac('file|' + key + '|' + exp).slice(0, 32);

  function fileLink(key) {
    const exp = Math.floor(now() / 1000) + LINK_TTL_S;
    return siteUrl.replace(/\/$/, '') + '/api/file?k=' + encodeURIComponent(key) + '&e=' + exp + '&s=' + fileSig(key, exp);
  }

  async function getFile(key, exp, sig) {
    if (!key || !/^[\w.-]{10,80}$/.test(key) || !/^\d{9,11}$/.test(String(exp || '')) ||
        !sig || !sameHex(fileSig(key, exp), String(sig))) {
      throw err('NOT_FOUND');
    }
    if (now() / 1000 > Number(exp)) throw err('LINK_EXPIRED');
    const r = await stores.uploads.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!r || !r.data) throw err('NOT_FOUND');
    return {
      bytes: Buffer.from(r.data),
      mime: (r.metadata && r.metadata.mime) || 'application/octet-stream',
      name: (r.metadata && r.metadata.name) || key
    };
  }

  /* ---------- Teacher-controlled feedback ---------- */
  async function setReleased(tab, row, released) {
    if (!['Writing', 'Speaking'].includes(tab)) throw err('INVALID_TAB');
    if (!Number.isSafeInteger(row) || row < 2) throw err('INVALID_ROW');
    if (typeof released !== 'boolean') throw err('INVALID_RELEASED');

    const [rows] = await sheets.batchGet([`${tab}!A2:${tab === 'Writing' ? 'G' : 'H'}50000`]);
    const r = rows[row - 2];
    if (!r || !r[0] || !r[2]) throw err('INVALID_ROW');

    await sheets.update(`${tab}!G${row}`, [[released ? 'Yes' : 'No']]);
    return { ok: true, tab, row, released };
  }

  async function getMyFeedback(sessionId) {
    const sess = await getSession(sessionId);
    const [writing, speaking] = await sheets.batchGet(['Writing!A2:G50000', 'Speaking!A2:H50000']);
    const mine = r =>
      String(r[1] || '').toUpperCase() === sess.code &&
      String(r[2] || '').toLowerCase() === sess.nickname.toLowerCase();

    const result = [];
    writing.forEach(r => {
      if (!mine(r) || !isYes(r[6]) || !r[5]) return;
      result.push({ time: r[0] || '', kind: 'Writing', about: String(r[4] || '').slice(0, 80), feedback: r[5] });
    });
    speaking.forEach(r => {
      if (!mine(r) || !isYes(r[6]) || !r[5]) return;
      result.push({ time: r[0] || '', kind: 'Speaking', about: String(r[4] || '').slice(0, 80), feedback: r[5] });
    });
    return result.sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 20);
  }

  /* ---------- Live teacher back office ---------- */
  async function adminSnapshot() {
    const [writingRows, speakingRows, avatarRows] = await sheets.batchGet([
      'Writing!A2:G50000', 'Speaking!A2:H50000', 'Avatars!A2:I50000'
    ]);

    const writing = writingRows
      .map((r, i) => ({ row: i + 2, time: r[0] || '', nickname: r[2] || '', text: r[4] || '', feedback: r[5] || '', released: isYes(r[6]) }))
      .filter(r => r.time);
    const speaking = speakingRows
      .map((r, i) => {
        const key = keyFromLink(r[7]);
        return { row: i + 2, time: r[0] || '', nickname: r[2] || '', transcript: r[4] || '', feedback: r[5] || '', released: isYes(r[6]), link: key ? fileLink(key) : '' };
      })
      .filter(r => r.time);
    const avatars = avatarRows
      .filter(r => r[0] && r[2])
      .map(r => ({ nickname: r[2], face: r[3] || '', hair: r[4] || '', hairColor: r[5] || '', eyes: r[6] || '', mouth: r[7] || '', shirt: r[8] || '' }))
      .reverse();

    const students = new Set([...writing, ...speaking, ...avatars].map(r => String(r.nickname).toLowerCase()));
    return {
      at: new Date(now()).toISOString(),
      counts: {
        students: students.size,
        writing: writing.length,
        speaking: speaking.length,
        waiting: writing.filter(r => !r.released).length + speaking.filter(r => !r.released).length
      },
      writing: writing.slice(-50).reverse(),
      speaking: speaking.slice(-50).reverse(),
      avatars,
      linkMinutes: LINK_TTL_S / 60
    };
  }

  return {
    ensureSetup,
    getPublicConfig,
    startGame,
    resumeSession,
    resetPin,
    saveUpload,
    getFile,
    fileLink,
    adminSnapshot,
    submitWriting,
    submitSpeaking,
    saveAvatar,
    getAvatar,
    setReleased,
    getMyFeedback
  };
}

/* ---------- File type detection ---------- */
export function sniffType(b) {
  const at = i => i < b.length ? b[i] : -1;
  const str = (f, l) => {
    let s = '';
    for (let i = f; i < f + l; i++) s += String.fromCharCode(at(i) < 0 ? 0 : at(i));
    return s;
  };

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
    // iPhone and Android voice recordings come as an MP4 container
    return { mime: 'audio/mp4', ext: '.m4a' };
  }
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return { mime: 'audio/webm', ext: '.webm' };
  if (str(0, 4) === 'OggS') return { mime: 'audio/ogg', ext: '.ogg' };
  if (str(0, 3) === 'ID3' || (at(0) === 0xff && (at(1) & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: '.mp3' };
  if (str(0, 4) === '%PDF') return { mime: 'application/pdf', ext: '.pdf' };
  return null;
}
