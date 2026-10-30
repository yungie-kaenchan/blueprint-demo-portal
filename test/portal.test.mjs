// node test/portal.test.mjs : the portal's rules against an in-memory Sheet + Blobs.
// No real AI key: a fake Gemini answers, so the AI daily limit can be tested without cost.
import assert from 'node:assert';
import { createHouse, keyFromLink } from '../lib/house.mjs';
import { fakeSheets, memStore } from './fakes.mjs';

let passed = 0, failed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✔', name); } catch (e) { failed++; console.log('  ✘', name, '\n     ', e.message); } };
const rejects = (p, code) => assert.rejects(p, e => e.code === code || e.message === code, 'expected ' + code);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const HTML = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');

// fake Gemini: counts calls, always answers three points
let aiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('generativelanguage')) {
    aiCalls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Transcript: hello\n1. Good topic.\n2. Check verbs.\n3. Add linking words.' }] } }] }), { status: 200 });
  }
  return realFetch(url, opts);
};

const sheets = fakeSheets();
const stores = { sessions: memStore(), uploads: memStore(), meta: memStore() };
const envVals = { GEMINI_API_KEY: 'fake', AI_STUDENT_DAILY_CAP: '3', AI_DAILY_CAP: '5' };
let clock = Date.parse('2026-10-31T06:00:00Z');
const house = createHouse({ sheets, stores, secret: 's', siteUrl: 'https://demo.example', now: () => clock, env: k => envVals[k] });
const login = (nickname, pin, classCode = 'DEMO31') => house.startGame({ classCode, nickname, pin, studentNo: '' });

console.log('Writing Coach · portal tests');
await ok('setup creates only the portal tabs (no Word Quest game tabs)', async () => {
  await house.getPublicConfig();
  ['Settings', 'Writing', 'Speaking', 'Avatars', 'Uploads'].forEach(t => assert(sheets.tabs[t], 'missing ' + t));
  ['Questions', 'Responses', 'Scores'].forEach(t => assert(!sheets.tabs[t], 'unexpected ' + t));
  assert(sheets.tabs.Settings.map(r => r[0]).includes('Release AI feedback automatically'));
});
const setVal = (name, v) => { const r = sheets.tabs.Settings.find(x => x[0] === name); r[1] = v; clock += 60000; };
setVal('Class code', 'DEMO31');

let sid, sid2;
await ok('wrong class code and a missing or short PIN are refused', async () => {
  await rejects(login('Test-Adult1', '1234', 'WRONG'), 'WRONG_CODE');
  await rejects(login('Test-Adult1', ''), 'NO_PIN');
  await rejects(login('Test-Adult1', '12a4'), 'NO_PIN');
});
await ok('the first log-in sets the PIN; the same PIN logs in again (nickname case and spaces ignored)', async () => {
  const g = await login('Test-Adult1', '1234'); sid = g.sessionId;
  assert.strictEqual(g.player.newPin, true);
  const again = await login('  test-adult1 ', '1234');
  assert.strictEqual(again.player.newPin, false);
  sid2 = (await login('Test-Adult2', '9999')).sessionId;
});
await ok('someone else cannot use that nickname without its PIN', async () => {
  await rejects(login('Test-Adult1', '0000'), 'WRONG_PIN');
});
await ok('5 wrong PINs lock the nickname for 15 minutes, even with the right PIN', async () => {
  for (let i = 0; i < 3; i++) await rejects(login('Test-Adult1', '1111'), 'WRONG_PIN');
  await rejects(login('Test-Adult1', '1111'), 'PIN_LOCKED');
  await rejects(login('Test-Adult1', '1234'), 'PIN_LOCKED');
  clock += 16 * 60000;
  assert(await login('Test-Adult1', '1234'));
});
await ok('the PIN never goes into the Sheet', async () => {
  assert(!JSON.stringify(sheets.tabs).includes('1234'), 'PIN in the Sheet');
});
await ok('the teacher resets a PIN; the student sets a new one at the next log-in', async () => {
  const r = await house.resetPin('test-adult1');
  assert.strictEqual(r.existed, true);
  const g = await login('Test-Adult1', '4321'); assert.strictEqual(g.player.newPin, true);
  await rejects(login('Test-Adult1', '1234'), 'WRONG_PIN');
  assert.strictEqual((await house.resetPin('Nobody')).existed, false);
  sid = g.sessionId;
});
await ok('a refresh resumes the session; a fake or old session is refused', async () => {
  const r = await house.resumeSession(sid); assert.strictEqual(r.player.nickname, 'Test-Adult1');
  await rejects(house.resumeSession('nope'), 'SESSION_EXPIRED');
  await rejects(house.resumeSession('00000000-0000-4000-8000-000000000000'), 'SESSION_EXPIRED');
});
await ok('writing keeps its line breaks and saves a released row with AI feedback', async () => {
  const r = await house.submitWriting(sid, 'Last weekend I went to the market.\nIt was busy.');
  assert.strictEqual(r.released, true); assert(r.feedback.includes('linking'));
  const row = sheets.tabs.Writing[1];
  assert.strictEqual(row[2], 'Test-Adult1'); assert.strictEqual(row[6], 'Yes'); assert(row[4].includes('\n'), 'line break kept');
});
await ok('speaking keeps the audio privately; the Sheet stores a file reference, not a link', async () => {
  const r = await house.submitSpeaking(sid, { name: 'a.webm', type: 'audio/webm', base64: WEBM });
  assert.strictEqual(r.released, true);
  const row = sheets.tabs.Speaking[1];
  assert(/^file:[\w.-]+$/.test(row[7]), 'file reference: ' + row[7]);
  assert(/^file:/.test(sheets.tabs.Uploads[1][8]), 'Uploads reference');
  assert(!JSON.stringify(sheets.tabs).includes('/api/file'), 'no lasting link in the Sheet');
});
await ok('non-audio files (HTML, PNG) and a 5 MB file are refused', async () => {
  await rejects(house.submitSpeaking(sid, { name: 'x.html', type: 'audio/webm', base64: HTML }), 'BAD_TYPE');
  await rejects(house.submitSpeaking(sid, { name: 'x.png', type: 'audio/webm', base64: PNG }), 'BAD_TYPE');
  const big = Buffer.alloc(5 * 1024 * 1024, 1); big[0] = 0x1a; big[1] = 0x45; big[2] = 0xdf; big[3] = 0xa3;
  await rejects(house.submitSpeaking(sid, { name: 'big.webm', type: 'audio/webm', base64: big.toString('base64') }), 'TOO_BIG');
});
await ok('/admin gets a fresh audio link that works now and stops after an hour', async () => {
  const s = await house.adminSnapshot();
  const u = new URL(s.speaking[0].link);
  const [k, e, sig] = ['k', 'e', 's'].map(p => u.searchParams.get(p));
  const f = await house.getFile(k, e, sig); assert.strictEqual(f.mime, 'audio/webm');
  await rejects(house.getFile(k, String(Number(e) + 3600), sig), 'NOT_FOUND');      // a stretched expiry breaks the signature
  await rejects(house.getFile(k, e, sig.replace(/.$/, c => c === '0' ? '1' : '0')), 'NOT_FOUND');
  clock += 61 * 60000;
  await rejects(house.getFile(k, e, sig), 'LINK_EXPIRED');
  await rejects(house.getFile(k, null, sig), 'NOT_FOUND');
});
await ok('old links in the Sheet (written before this version) still map to a fresh link', async () => {
  const key = keyFromLink(sheets.tabs.Speaking[1][7]);
  assert.strictEqual(keyFromLink('https://x.netlify.app/api/file?k=' + key + '&s=abc'), key);
  sheets.tabs.Speaking[1][7] = 'https://demo.example/api/file?k=' + key + '&s=old';
  const s = await house.adminSnapshot(); assert(s.speaking[0].link.includes('&e='), 'fresh link');
});
await ok('the AI daily limit per student holds the work for the teacher instead of calling AI', async () => {
  const before = aiCalls;   // Test-Adult1 has used 2 AI turns today; the cap is 3
  const r1 = await house.submitWriting(sid, 'Third paragraph.'); assert.strictEqual(r1.released, true);
  const r2 = await house.submitWriting(sid, 'Fourth paragraph.');
  assert.strictEqual(r2.released, false); assert.strictEqual(r2.limited, true); assert(!r2.feedback);
  assert.strictEqual(aiCalls - before, 1, 'one AI call only');
  const row = sheets.tabs.Writing[sheets.tabs.Writing.length - 1];
  assert.strictEqual(row[4], 'Fourth paragraph.'); assert.strictEqual(row[6], 'No'); assert.strictEqual(row[5], '');
});
await ok('the class-wide daily limit stops AI for everyone; it resets the next day', async () => {
  await house.submitWriting(sid2, 'A1');               // class total 4
  await house.submitWriting(sid2, 'A2');               // class total 5 = cap
  const r = await house.submitWriting(sid2, 'A3'); assert.strictEqual(r.limited, true);
  clock += 24 * 3600000;
  const g = await login('Test-Adult2', '9999'); sid2 = g.sessionId;
  assert.strictEqual((await house.submitWriting(sid2, 'New day.')).released, true);
});
await ok('avatar: bad values are not saved; one row per student; getAvatar returns it', async () => {
  await house.saveAvatar(sid2, { face: 'oval', hair: 'curly', hairColor: 'red', eyes: 'wink', mouth: 'grin', shirt: 'blue' });
  await house.saveAvatar(sid2, { face: 'oval', hair: 'curly', hairColor: '<script>', eyes: 'wink', mouth: 'grin', shirt: 'blue' });
  const rows = sheets.tabs.Avatars.slice(1).filter(r => r[2] === 'Test-Adult2'); assert.strictEqual(rows.length, 1);
  assert(!JSON.stringify(rows).includes('<script>'));
  assert.strictEqual((await house.getAvatar(sid2)).face, 'oval');
});
await ok('adminSnapshot counts students, submissions and items waiting for release (no game stats)', async () => {
  const s = await house.adminSnapshot();
  assert.deepStrictEqual(Object.keys(s.counts).sort(), ['speaking', 'students', 'waiting', 'writing']);
  assert.strictEqual(s.counts.students, 2);
  assert(s.counts.waiting >= 2, 'held-back items counted');
  assert(!('top' in s) && !('hardest' in s) && !('playing' in s));
});
await ok('hide then release: the student sees only released feedback, never another student’s', async () => {
  const fresh = await login('Test-Adult1', '4321'); sid = fresh.sessionId;
  const before = (await house.getMyFeedback(sid)).length; assert(before >= 2);
  await house.setReleased('Writing', 2, false); assert.strictEqual(sheets.tabs.Writing[1][6], 'No');
  assert.strictEqual((await house.getMyFeedback(sid)).length, before - 1);
  await house.setReleased('Writing', 2, true);
  assert.strictEqual((await house.getMyFeedback(sid)).length, before);
  assert(!JSON.stringify(await house.getMyFeedback(sid2)).includes('Last weekend'));
  const one = (await house.getMyFeedback(sid))[0]; assert('about' in one && one.feedback);
});
await ok('setReleased refuses bad tabs and header / out-of-range rows', async () => {
  await rejects(house.setReleased('Settings', 2, true), 'INVALID_TAB');
  await rejects(house.setReleased('Writing', 1, true), 'INVALID_ROW');
  await rejects(house.setReleased('Writing', 999, true), 'INVALID_ROW');
});
await ok('with automatic release off, new feedback is held back', async () => {
  setVal('Release AI feedback automatically', 'No');
  const r = await house.submitWriting(sid2, 'My paragraph.'); assert.strictEqual(r.released, false); assert(!r.feedback);
  setVal('Release AI feedback automatically', 'Yes');
});
await ok('log-in is refused after Closes and allowed again when it is cleared', async () => {
  setVal('Closes', '2026-10-30T00:00:00Z');
  assert.strictEqual((await house.getPublicConfig()).status.state, 'closed');
  await rejects(login('Late', '1234'), 'CLOSED');
  setVal('Closes', '');
  assert.strictEqual((await house.getPublicConfig()).status.state, 'open');
});
await ok('the public config never shows the class code', async () => {
  assert(!JSON.stringify(await house.getPublicConfig()).includes('DEMO31'));
});

console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
