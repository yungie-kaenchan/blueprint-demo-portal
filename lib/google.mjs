// Google Sheets for the Netlify house: a service account signs in with a JWT (no Apps Script, no npm SDK).
import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
let tokenCache = { token: '', exp: 0, email: '' };

/** Reads the service-account JSON from the environment (the "master key in the safe"). */
export function loadServiceAccount(env) {
  const raw = (env('GOOGLE_SERVICE_ACCOUNT_JSON') || '').trim();
  if (!raw) throw new Error('NOT_SET_UP');
  let sa;
  try { sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); }
  catch { throw new Error('BAD_SERVICE_ACCOUNT'); }
  if (!sa.client_email || !sa.private_key) throw new Error('BAD_SERVICE_ACCOUNT');
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export async function accessToken(sa, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.email === sa.client_email && tokenCache.exp - 60 > now) return tokenCache.token;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claim);
  const jwt = header + '.' + claim + '.' + b64url(signer.sign(sa.private_key));
  const r = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  if (!r.ok) throw new Error('GOOGLE_AUTH');
  const d = await r.json();
  tokenCache = { token: d.access_token, exp: now + (d.expires_in || 3600), email: sa.client_email };
  return tokenCache.token;
}

/** Minimal Sheets client: batchGet, append, update, meta, batchUpdate. Throws BUSY on quota limits. */
export function sheetsClient({ sheetId, sa, fetchImpl = fetch, retryDelays = [400, 1200] }) {
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(sheetId);
  async function call(path, opts = {}) {
    const token = await accessToken(sa, fetchImpl);
    let r;
    // Google's per-minute write quota answers 429 when a class starts together: wait a moment and try again
    // (a 429 means the request was not applied, so retrying cannot write a row twice)
    for (let i = 0; ; i++) {
      r = await fetchImpl(base + path, { ...opts, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(opts.headers || {}) } });
      if (r.status !== 429 || i >= retryDelays.length) break;
      await new Promise(res => setTimeout(res, retryDelays[i] * (0.75 + Math.random() * 0.5)));
    }
    if (r.status === 429) throw new Error('BUSY');
    if (r.status === 403 || r.status === 404) throw new Error('SHEET_NOT_SHARED');
    if (!r.ok) throw new Error('SHEETS_' + r.status);
    return r.json();
  }
  return {
    async meta() { return call('?fields=properties(title,timeZone),sheets.properties(title,sheetId)'); },
    async batchGet(ranges) {
      const q = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
      const d = await call('/values:batchGet?' + q + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
      return (d.valueRanges || []).map(v => v.values || []);
    },
    async append(range, rows) {
      const d = await call('/values/' + encodeURIComponent(range) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', body: JSON.stringify({ values: rows }) });
      const m = String((d.updates && d.updates.updatedRange) || '').match(/![A-Z]+(\d+)/);
      return m ? Number(m[1]) : 0;
    },
    async update(range, rows, input = 'RAW') {
      return call('/values/' + encodeURIComponent(range) + '?valueInputOption=' + input, { method: 'PUT', body: JSON.stringify({ values: rows }) });
    },
    async batchUpdate(requests) { return call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) }); },
  };
}

/** Sheets date serial → JS Date, in the spreadsheet's time zone. */
export function serialToDate(serial, timeZone = 'Asia/Bangkok') {
  if (typeof serial !== 'number' || !isFinite(serial)) return null;
  const utcGuess = new Date(Math.round((serial - 25569) * 86400000));
  // offset of timeZone at that moment, in minutes
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(utcGuess);
  const get = t => Number(parts.find(p => p.type === t).value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = asIfUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offset);
}
