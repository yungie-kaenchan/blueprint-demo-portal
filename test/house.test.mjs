// node test/house.test.mjs : Netlify-house logic against an in-memory Sheet + Blobs
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createHouse, normalize, lockKeyFor } from '../lib/house.mjs';
import { accessToken, sheetsClient, serialToDate } from '../lib/google.mjs';

import { fakeSheets, memStore } from './fakes.mjs';

let passed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✔', name); } catch (e) { console.log('  ✘', name, '\n    ', e.message); process.exitCode = 1; } };
const rejects = async (p, code) => { await assert.rejects(p, e => e.code === code || e.message === code, 'expected ' + code); };
const hash = (salt, id, a) => crypto.createHash('sha256').update(salt + '|' + id + '|' + normalize(a)).digest('hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

const sheets = fakeSheets();
const stores = { sessions: memStore(), uploads: memStore(), meta: memStore() };
let clock = Date.parse('2026-10-31T06:00:00Z');
const house = createHouse({ sheets, stores, secret: 'test-secret', siteUrl: 'https://wq.example', now: () => clock });
console.log('Word Quest · Netlify house tests');

await ok('first call sets up every tab with headers, settings, sample questions and dashboard', async () => {
  const c = await house.getPublicConfig();
  ['Settings', 'Questions', 'Responses', 'Scores', 'Uploads', 'Dashboard'].forEach(t => assert(sheets.tabs[t], t));
  assert.strictEqual(sheets.tabs.Questions.length, 16);
  assert.strictEqual(c.status.state, 'open');
  assert(!JSON.stringify(c).includes('FOOD1'), 'class code hidden');
});
await ok('setup runs once (no duplicate rows on the next call)', async () => {
  await house.getPublicConfig(); assert.strictEqual(sheets.tabs.Questions.length, 16);
});
await ok('wrong code / missing nickname / missing number refused', async () => {
  await rejects(house.startGame({ classCode: 'x', nickname: 'a', studentNo: '1' }), 'WRONG_CODE');
  await rejects(house.startGame({ classCode: 'food1', nickname: ' ', studentNo: '1' }), 'NO_NICKNAME');
  await rejects(house.startGame({ classCode: 'food1', nickname: 'Ploy', studentNo: '' }), 'NO_STUDENT_NO');
});
let g;
await ok('startGame reserves a "playing" row and hides typed answers', async () => {
  g = await house.startGame({ classCode: 'food1', nickname: 'Ploy', studentNo: '12' });
  assert.strictEqual(g.levels.length, 3);
  assert.strictEqual(sheets.tabs.Scores[1][10], 'playing');
  const pub = JSON.stringify(g.levels.filter(l => l.level !== 3));
  assert(!pub.includes('"knife"') && !pub.includes('"market"'));
  assert(g.levels[1].questions.find(q => q.id === 'F7').check.includes(hash(g.salt, 'F7', 'Knife.')));
});
await ok('server scoring: streak bonus, canonical order, duplicates ignored', async () => {
  const r = await house.submitLevel(g.sessionId, 1, [{ id: 'F1', answer: 'apple' }, { id: 'F2', answer: 'carrot' }, { id: 'F3', answer: 'bread' }, { id: 'F4', answer: 'beef' }, { id: 'F5', answer: 'MILK' }]);
  assert.strictEqual(r.correct, 4); assert.strictEqual(r.points, 45);
  const spam = Array.from({ length: 50 }, () => ({ id: 'F7', answer: 'knife' }));
  const r2 = await house.submitLevel(g.sessionId, 2, spam);
  assert.strictEqual(r2.total, 5); assert.strictEqual(r2.points, 10);
  assert.strictEqual(sheets.tabs.Responses.length, 11);
  const again = await house.submitLevel(g.sessionId, 1, []); assert.strictEqual(again.points, 45);
  assert.strictEqual(sheets.tabs.Responses.length, 11, 'no double counting');
});
await ok('upload before finishing is refused', async () => {
  await rejects(house.saveUpload(g.sessionId, { base64: JPEG }), 'FINISH_FIRST');
});
await ok('finishGame fills the reserved row and returns the leaderboard', async () => {
  const f = await house.finishGame(g.sessionId);
  assert.strictEqual(f.points, 55); assert.strictEqual(sheets.tabs.Scores.length, 2); assert.strictEqual(sheets.tabs.Scores[1][10], 'finished');
  assert.strictEqual(f.leaderboard[0].nickname, 'Ploy');
  await rejects(house.submitLevel(g.sessionId, 3, []), 'ALREADY_FINISHED');
});
await ok('upload goes to Blobs, the Sheet gets a signed private link, fakes are refused', async () => {
  await house.saveUpload(g.sessionId, { base64: JPEG });
  const row = sheets.tabs.Uploads[1];
  assert(/_FOOD1_Ploy_12\.jpg$/.test(row[5]) && row[6] === 'image/jpeg');
  const link = new URL(row[8]);
  assert.strictEqual(link.origin, 'https://wq.example');
  const f = await house.getFile(link.searchParams.get('k'), link.searchParams.get('s'));
  assert.strictEqual(f.mime, 'image/jpeg');
  await rejects(house.getFile(link.searchParams.get('k'), 'bad'), 'NOT_FOUND');
  await rejects(house.saveUpload(g.sessionId, { base64: Buffer.from('not an image').toString('base64') }), 'BAD_TYPE');
  await rejects(house.saveUpload(g.sessionId, { base64: Buffer.alloc(5 * 1048576).toString('base64') }), 'TOO_BIG');
});
await ok('attempt limit counts unfinished plays', async () => {
  await house.startGame({ classCode: 'FOOD1', nickname: 'ploy', studentNo: '12' });
  await house.startGame({ classCode: 'FOOD1', nickname: 'Ploy', studentNo: '12' });
  await rejects(house.startGame({ classCode: 'FOOD1', nickname: 'Ploy', studentNo: '12' }), 'NO_ATTEMPTS_LEFT');
});
await ok('formula-looking nicknames are stored as plain text (RAW writes)', async () => {
  const s = await house.startGame({ classCode: 'FOOD1', nickname: '=HYPERLINK("x")', studentNo: '1' });
  assert.strictEqual(sheets.tabs.Scores.at(-1)[2], '=HYPERLINK("x")'); // the Sheet receives valueInputOption=RAW, so it is not evaluated
  assert(s.sessionId);
});
await ok('live admin snapshot: playing now, finished, hardest words', async () => {
  const a = await house.adminSnapshot();
  assert.strictEqual(a.counts.finished, 1); assert(a.counts.playing >= 3);
  assert.strictEqual(a.top[0].nickname, 'Ploy');
  assert(a.hardest.length >= 5 && a.hardest[0].rate <= a.hardest.at(-1).rate);
});
await ok('test mode sends no answer hashes; time window enforced (Sheets date serials)', async () => {
  sheets.tabs.Settings.find(r => r[0] === 'Instant feedback')[1] = 'No';
  clock += 30000; // let the 20 s config cache expire
  const s = await house.startGame({ classCode: 'FOOD1', nickname: 'Test', studentNo: '9' });
  assert(s.levels.every(l => l.questions.every(q => q.check.length === 0)));
  // Closes = 31 Oct 2026 12:00 Bangkok = serial 46326.5 (days since 1899-12-30)
  sheets.tabs.Settings.find(r => r[0] === 'Closes')[1] = 46326.5;
  clock += 30000;
  await rejects(house.startGame({ classCode: 'FOOD1', nickname: 'Late', studentNo: '3' }), 'CLOSED');
});
await ok('sessions expire after 6 hours', async () => {
  clock += 7 * 3600 * 1000;
  await rejects(house.submitLevel(g.sessionId, 3, []), 'SESSION_EXPIRED');
  await rejects(house.submitLevel('not-a-session', 1, []), 'SESSION_EXPIRED');
});
await ok('serialToDate respects the Sheet time zone', async () => {
  assert.strictEqual(serialToDate(46326.5, 'Asia/Bangkok').toISOString(), '2026-10-31T05:00:00.000Z');
  assert.strictEqual(serialToDate(46326.5, 'UTC').toISOString(), '2026-10-31T12:00:00.000Z');
});
await ok('service-account JWT is signed RS256 and the Sheets client calls the right URLs', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'robot@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const calls = [];
  const fake = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('oauth2.googleapis.com')) {
      const jwt = decodeURIComponent(opts.body.split('assertion=')[1]); const [h, c, sig] = jwt.split('.');
      const v = crypto.createVerify('RSA-SHA256'); v.update(h + '.' + c);
      assert(v.verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), 'signature verifies');
      assert.strictEqual(JSON.parse(Buffer.from(c, 'base64').toString()).scope, 'https://www.googleapis.com/auth/spreadsheets');
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes(':append')) return new Response(JSON.stringify({ updates: { updatedRange: 'Scores!A7:K7' } }), { status: 200 });
    return new Response(JSON.stringify({ valueRanges: [{ values: [['a']] }] }), { status: 200 });
  };
  assert.strictEqual(await accessToken(sa, fake), 'tok');
  const sc = sheetsClient({ sheetId: 'SHEET123', sa, fetchImpl: fake });
  assert.strictEqual(await sc.append('Scores!A1', [['x']]), 7);
  const ap = calls.find(c => c.url.includes(':append'));
  assert(ap.url.includes('valueInputOption=RAW') && ap.opts.headers.authorization === 'Bearer tok');
  await sc.batchGet(['Settings!A2:B60']);
  assert(calls.at(-1).url.includes('valueRenderOption=UNFORMATTED_VALUE'));
});

/* ---------- concurrency: a second house whose fakes add network-like latency ---------- */
const slowSheets = fakeSheets({ latency: 15 });
const slowStores = { sessions: memStore({ latency: 5 }), uploads: memStore(), meta: memStore({ latency: 5 }) };
const slow = createHouse({ sheets: slowSheets, stores: slowStores, secret: 't', now: () => clock });
clock = Date.parse('2026-10-31T06:00:00Z');
await slow.getPublicConfig(); // first visit sets up the tabs
const rowsOf = nick => slowSheets.tabs.Scores.slice(1).filter(r => r && r[2] === nick);
const fullAnswers = [{ id: 'F1', answer: 'apple' }, { id: 'F2', answer: 'carrot' }, { id: 'F3', answer: 'bread' }, { id: 'F4', answer: 'fish' }, { id: 'F5', answer: 'milk' }];

await ok('6 simultaneous startGame calls: the attempt limit (3) holds and attempts are 1, 2, 3', async () => {
  const res = await Promise.allSettled(Array.from({ length: 6 }, () => slow.startGame({ classCode: 'FOOD1', nickname: 'Nok', studentNo: '7' })));
  const won = res.filter(r => r.status === 'fulfilled').map(r => r.value.attempt).sort();
  assert.deepStrictEqual(won, [1, 2, 3]);
  assert(res.filter(r => r.status === 'rejected').every(r => r.reason.code === 'NO_ATTEMPTS_LEFT'));
  assert.deepStrictEqual(rowsOf('Nok').map(r => r[4]).sort(), [1, 2, 3]);
  assert(rowsOf('Nok').every(r => r[10] === 'playing'));
});
await ok('finishing after the teacher sorts the Scores tab writes the right row', async () => {
  const a = await slow.startGame({ classCode: 'FOOD1', nickname: 'Aom', studentNo: '1' });
  const b = await slow.startGame({ classCode: 'FOOD1', nickname: 'Bee', studentNo: '2' });
  const t = slowSheets.tabs.Scores;
  t.splice(1, t.length - 1, ...t.slice(1).reverse()); // teacher sorts: every reserved row moves
  await slow.submitLevel(a.sessionId, 1, fullAnswers);
  await slow.finishGame(a.sessionId);
  assert.strictEqual(rowsOf('Aom').length, 1); assert.strictEqual(rowsOf('Aom')[0][10], 'finished');
  assert.strictEqual(rowsOf('Aom')[0][5], 55);
  assert.strictEqual(rowsOf('Bee').length, 1); assert.strictEqual(rowsOf('Bee')[0][10], 'playing', "Bee's row untouched");
  assert.strictEqual(rowsOf('Nok').length, 3); assert(rowsOf('Nok').every(r => r[10] === 'playing'), "Nok's rows untouched");
  await slow.finishGame(b.sessionId);
  assert.strictEqual(rowsOf('Bee')[0][10], 'finished'); assert.strictEqual(rowsOf('Aom')[0][5], 55);
});
await ok('reservation row deleted: finishGame appends instead of overwriting', async () => {
  const c = await slow.startGame({ classCode: 'FOOD1', nickname: 'Cat', studentNo: '3' });
  await slow.startGame({ classCode: 'FOOD1', nickname: 'Fon', studentNo: '6' });
  const t = slowSheets.tabs.Scores;
  const before = JSON.stringify(t.filter(r => r && r[2] !== 'Cat'));
  t.splice(t.findIndex(r => r && r[2] === 'Cat'), 1); // teacher deletes the row; the next row slides into its place
  await slow.finishGame(c.sessionId);
  assert.strictEqual(JSON.stringify(t.filter(r => r && r[2] !== 'Cat')), before, 'no other row changed');
  assert.strictEqual(rowsOf('Cat').length, 1); assert.strictEqual(rowsOf('Cat')[0][10], 'finished');
});
await ok('double submit and double finish (sent at once) write each row only once', async () => {
  const d = await slow.startGame({ classCode: 'FOOD1', nickname: 'Dao', studentNo: '4' });
  const before = slowSheets.tabs.Responses.length;
  const [r1, r2] = await Promise.all([slow.submitLevel(d.sessionId, 1, fullAnswers), slow.submitLevel(d.sessionId, 1, fullAnswers)]);
  assert.strictEqual(slowSheets.tabs.Responses.length - before, 5, '5 rows, not 10');
  assert.deepStrictEqual(r1, r2);
  const scores = slowSheets.tabs.Scores.length;
  const [f1, f2] = await Promise.all([slow.finishGame(d.sessionId), slow.finishGame(d.sessionId)]);
  assert.deepStrictEqual(f1, f2);
  assert.strictEqual(slowSheets.tabs.Scores.length, scores, 'no extra Scores row');
  assert.strictEqual(rowsOf('Dao').length, 1); assert.strictEqual(rowsOf('Dao')[0][10], 'finished');
});
await ok('a held lock gives a retryable BUSY; a stale one (>15 s) is taken over', async () => {
  const quick = createHouse({ sheets: slowSheets, stores: slowStores, secret: 't', now: () => clock, lockWaitMs: 300 });
  const key = lockKeyFor('FOOD1', ' EVE ');
  await slowStores.meta.setJSON(key, { token: 'someone-else', at: clock });
  await rejects(quick.startGame({ classCode: 'FOOD1', nickname: 'Eve', studentNo: '5' }), 'BUSY');
  assert.strictEqual(rowsOf('Eve').length, 0);
  await slowStores.meta.setJSON(key, { token: 'someone-else', at: clock - 16000 });
  const e = await quick.startGame({ classCode: 'FOOD1', nickname: 'Eve', studentNo: '5' });
  assert.strictEqual(e.attempt, 1);
  assert.strictEqual((await slowStores.meta.get(key, { type: 'json' })).token, null, 'released after use');
});
console.log(`\n${passed} passed`);
