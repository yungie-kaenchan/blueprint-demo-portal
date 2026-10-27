// node test/google.test.mjs : the Sheets client retries Google's per-minute quota (429) before giving up
import assert from 'node:assert';
import { sheetsClient } from '../lib/google.mjs';
import crypto from 'node:crypto';
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'robot@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
let sheetCalls = 0, mode = 'twice';
const fetchImpl = async (url) => {
  url = String(url);
  if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  sheetCalls++;
  if (mode === 'twice' && sheetCalls <= 2) return new Response('{}', { status: 429 });
  if (mode === 'always') return new Response('{}', { status: 429 });
  return new Response(JSON.stringify({ properties: { title: 'T' }, sheets: [] }), { status: 200 });
};
const c = sheetsClient({ sheetId: 'x', sa, fetchImpl, retryDelays: [5, 5] });
const m = await c.meta();
assert.strictEqual(m.properties.title, 'T'); assert.strictEqual(sheetCalls, 3, 'two 429s, then success');
console.log('  ✔ two 429s are retried, the third try succeeds');
mode = 'always'; sheetCalls = 0;
await assert.rejects(() => c.meta(), /BUSY/); assert.strictEqual(sheetCalls, 3);
console.log('  ✔ still busy after the retries → BUSY (the page asks the student to tap again)');
console.log('2 passed');
