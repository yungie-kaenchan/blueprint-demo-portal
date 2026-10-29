/* WORD QUEST · Netlify house: the wiring (one Netlify Function, three doors)
 *   POST /api/game   { fn, args }   the game (same calls as the Google kit's google.script.run)
 *   GET  /api/file?k=…&s=…          a student upload (signed link, written into the Sheet's Uploads tab)
 *   GET  /api/admin                 live back office data (header x-admin-passcode)
 *
 * Environment variables (Netlify → Site configuration → Environment variables) = the safe:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the service account key (whole JSON, or base64 of it)
 *   SHEET_ID                     the Google Sheet's ID (from its URL), shared with the service account as Editor
 *   ADMIN_PASSCODE               teacher passcode for /admin
 *   FILE_SECRET                  optional: signs upload links (defaults to a hash of the service account key)
 */
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { loadServiceAccount, sheetsClient } from '../../lib/google.mjs';
import { createHouse } from '../../lib/house.mjs';

const ALLOWED = new Set(['getPublicConfig', 'startGame', 'submitLevel', 'finishGame', 'saveUpload', 'submitWriting']);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const env = k => (Netlify.env.get(k) || '').trim();

let house = null, houseKey = '';
function getHouse(req) {
  const sa = loadServiceAccount(env);
  const sheetId = env('SHEET_ID').replace(/^.*\/d\/([\w-]+).*$/, '$1'); // accepts a full Sheet URL too
  if (!sheetId) throw Object.assign(new Error('NOT_SET_UP'), { code: 'NOT_SET_UP' });
  const key = sheetId + '|' + sa.client_email;
  if (house && houseKey === key) return house;
  const secret = env('FILE_SECRET') || crypto.createHash('sha256').update(sa.private_key).digest('hex');
  const siteUrl = env('URL') || new URL(req.url).origin;
  house = createHouse({
    sheets: sheetsClient({ sheetId, sa }),
    stores: {
      sessions: getStore({ name: 'wq-sessions', consistency: 'strong' }),
      uploads: getStore({ name: 'wq-uploads', consistency: 'strong' }),
      meta: getStore({ name: 'wq-meta', consistency: 'strong' }),
    },
    secret, siteUrl,
    env,
  });
  houseKey = key;
  return house;
}

export default async (req) => {
  const url = new URL(req.url);
  try {
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const f = await getHouse(req).getFile(url.searchParams.get('k'), url.searchParams.get('s'));
      return new Response(f.bytes, { headers: { 'content-type': f.mime, 'content-disposition': 'inline; filename="' + encodeURIComponent(f.name) + '"', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } });
    }
    if (url.pathname === '/api/admin' && req.method === 'GET') {
      const pass = env('ADMIN_PASSCODE');
      if (!pass) return json({ ok: false, error: 'NO_ADMIN_PASSCODE' }, 503);
      const given = req.headers.get('x-admin-passcode') || '';
      if (given.length !== pass.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pass))) return json({ ok: false, error: 'PASSCODE' }, 401);
      return json({ ok: true, value: await getHouse(req).adminSnapshot() });
    }
    if (url.pathname === '/api/game' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 6_000_000) return json({ ok: false, error: 'TOO_BIG' }, 413);
      let body; try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'BAD_JSON' }, 400); }
      if (!ALLOWED.has(body.fn)) return json({ ok: false, error: 'NOT_ALLOWED' }, 400);
      const value = await getHouse(req)[body.fn](...(Array.isArray(body.args) ? body.args : []));
      return json({ ok: true, value });
    }
    return json({ ok: false, error: 'NOT_FOUND' }, 404);
  } catch (e) {
    const code = e.code || e.message || 'ERROR';
    const known = /^[A-Z_0-9]+$/.test(code) ? code : 'ERROR';
    if (known === 'ERROR') console.error(e);
    return json({ ok: false, error: known }, known === 'BUSY' ? 429 : 200);
  }
};

export const config = { path: ['/api/game', '/api/file', '/api/admin'] };
