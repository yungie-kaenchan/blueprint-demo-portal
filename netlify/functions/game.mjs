
/* WRITING COACH · Netlify house: the wiring (one Netlify Function, three doors)
 *   POST /api/game   { fn, args }   the student page
 *   GET  /api/file?k=…&e=…&s=…      a student recording (signed link that expires after 1 hour; /admin makes fresh ones)
 *   GET  /api/admin                 live back office data (header x-admin-passcode)
 *   POST /api/admin                 teacher controls: Hide / Release feedback, reset a student's PIN (same passcode)
 *
 * Environment variables (Netlify → Site configuration → Environment variables) = the safe:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the service account key (whole JSON, or base64 of it)
 *   SHEET_ID                     the Google Sheet's ID (from its URL), shared with the service account as Editor
 *   ADMIN_PASSCODE               teacher passcode for /admin
 *   GEMINI_API_KEY               optional: AI feedback (adult learners only, Gemini API terms)
 *   AI_DAILY_CAP / AI_STUDENT_DAILY_CAP   optional: AI replies per day for the class (300) and per student (20)
 *   FILE_SECRET                  optional: signs PINs and file links (defaults to a hash of the service account key)
 */
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { loadServiceAccount, sheetsClient } from '../../lib/google.mjs';
import { createHouse } from '../../lib/house.mjs';

const ALLOWED = new Set([
  'getPublicConfig',
  'startGame',
  'resumeSession',
  'submitWriting',
  'submitSpeaking',
  'saveAvatar',
  'getAvatar',
  'getMyFeedback'
]);

const ADMIN_TRIES = 10;                  // wrong passcodes per device in 15 minutes
const ADMIN_WINDOW_MS = 15 * 60 * 1000;

const json = (obj, status = 200) => new Response(
  JSON.stringify(obj),
  {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  }
);

const env = k => (Netlify.env.get(k) || '').trim();

let house = null, houseKey = '';

function getHouse(req) {
  const sa = loadServiceAccount(env);
  const sheetId = env('SHEET_ID').replace(/^.*\/d\/([\w-]+).*$/, '$1');
  if (!sheetId) throw Object.assign(new Error('NOT_SET_UP'), { code: 'NOT_SET_UP' });

  const key = sheetId + '|' + sa.client_email;
  if (house && houseKey === key) return house;

  const secret = env('FILE_SECRET') ||
    crypto.createHash('sha256').update(sa.private_key).digest('hex');
  const siteUrl = env('URL') || new URL(req.url).origin;

  house = createHouse({
    sheets: sheetsClient({ sheetId, sa }),
    stores: {
      sessions: getStore({ name: 'wq-sessions', consistency: 'strong' }),
      uploads: getStore({ name: 'wq-uploads', consistency: 'strong' }),
      meta: getStore({ name: 'wq-meta', consistency: 'strong' }),
    },
    secret,
    siteUrl,
    env,
  });

  houseKey = key;
  return house;
}

/* ---------- /admin passcode, with a lockout so it can't be guessed ---------- */
const guard = () => getStore({ name: 'wq-guard', consistency: 'strong' });
const deviceKey = (req, context) => 'admin-' + crypto.createHash('sha256')
  .update((context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown')
  .digest('hex').slice(0, 32);

async function checkAdminPasscode(req, context) {
  const pass = env('ADMIN_PASSCODE');
  if (!pass) return 'NO_ADMIN_PASSCODE';

  const store = guard(), key = deviceKey(req, context);
  const seen = await store.get(key, { type: 'json' });
  const recent = seen && Date.now() - seen.first < ADMIN_WINDOW_MS ? seen : null;
  if (recent && recent.fails >= ADMIN_TRIES) return 'LOCKED';

  const given = req.headers.get('x-admin-passcode') || '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(pass).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    await store.setJSON(key, { first: recent ? recent.first : Date.now(), fails: (recent ? recent.fails : 0) + 1 });
    return 'PASSCODE';
  }
  if (seen) await store.delete(key);
  return null;
}

export default async (req, context) => {
  const url = new URL(req.url);

  try {
    if (url.pathname === '/api/file' && req.method === 'GET') {
      try {
        const f = await getHouse(req).getFile(
          url.searchParams.get('k'),
          url.searchParams.get('e'),
          url.searchParams.get('s')
        );
        return new Response(f.bytes, {
          headers: {
            'content-type': f.mime,
            'content-disposition': 'inline; filename="' + encodeURIComponent(f.name) + '"',
            'cache-control': 'private, no-store',
            'x-robots-tag': 'noindex'
          }
        });
      } catch (e) {
        const code = e.code === 'LINK_EXPIRED' ? 'LINK_EXPIRED' : 'NOT_FOUND';
        return json({ ok: false, error: code }, code === 'LINK_EXPIRED' ? 410 : 404);
      }
    }

    if (url.pathname === '/api/admin' && (req.method === 'GET' || req.method === 'POST')) {
      const authError = await checkAdminPasscode(req, context);
      if (authError) {
        return json(
          { ok: false, error: authError },
          authError === 'PASSCODE' ? 401 : authError === 'LOCKED' ? 429 : 503
        );
      }

      if (req.method === 'GET') {
        return json({ ok: true, value: await getHouse(req).adminSnapshot() });
      }

      const raw = await req.text();
      if (raw.length > 10000) return json({ ok: false, error: 'TOO_BIG' }, 413);

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: 'BAD_JSON' }, 400);
      }

      if (body && body.action === 'resetPin' && typeof body.nickname === 'string' && body.nickname.trim()) {
        return json({ ok: true, value: await getHouse(req).resetPin(body.nickname) });
      }

      if (!body || typeof body !== 'object' ||
          !['Writing', 'Speaking'].includes(body.tab) ||
          !Number.isSafeInteger(body.row) ||
          body.row < 2 ||
          typeof body.released !== 'boolean') {
        return json({ ok: false, error: 'INVALID_REQUEST' }, 400);
      }

      const value = await getHouse(req).setReleased(body.tab, body.row, body.released);
      return json({ ok: true, value });
    }

    if (url.pathname === '/api/game' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 6_000_000) return json({ ok: false, error: 'TOO_BIG' }, 413);

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: 'BAD_JSON' }, 400);
      }

      if (!body || !ALLOWED.has(body.fn)) return json({ ok: false, error: 'NOT_ALLOWED' }, 400);

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

export const config = {
  path: ['/api/game', '/api/file', '/api/admin']
};
