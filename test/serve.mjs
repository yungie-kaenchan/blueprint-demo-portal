// Local preview of the portal with a fake Sheet: node test/serve.mjs → http://localhost:8767 (class code DEMO31, admin passcode: demo)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHouse } from '../lib/house.mjs';
import { fakeSheets, memStore } from './fakes.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8767;
const sheets = fakeSheets();
const house = createHouse({ sheets, stores: { sessions: memStore(), uploads: memStore(), meta: memStore() }, secret: 'local', siteUrl: 'http://localhost:' + PORT });
await house.getPublicConfig();
sheets.tabs.Settings.find(r => r[0] === 'Class code')[1] = 'DEMO31';
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/game' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      const b = JSON.parse(raw);
      return send(res, 200, { ok: true, value: await house[b.fn](...(b.args || [])) });
    }
    if (url.pathname === '/api/admin') {
      if (req.headers['x-admin-passcode'] !== 'demo') return send(res, 401, { ok: false, error: 'PASSCODE' });
      if (req.method === 'POST') {
        let raw = ''; for await (const c of req) raw += c;
        const b = JSON.parse(raw);
        const value = b.action === 'resetPin' ? await house.resetPin(b.nickname) : await house.setReleased(b.tab, b.row, b.released);
        return send(res, 200, { ok: true, value });
      }
      return send(res, 200, { ok: true, value: await house.adminSnapshot() });
    }
    if (url.pathname === '/api/file') {
      const f = await house.getFile(url.searchParams.get('k'), url.searchParams.get('e'), url.searchParams.get('s'));
      res.writeHead(200, { 'content-type': f.mime }); return res.end(f.bytes);
    }
    if (url.pathname === '/sheet') return send(res, 200, sheets.tabs);
  } catch (e) { return send(res, 200, { ok: false, error: e.code || e.message }); }
  const p = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : url.pathname;
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('Portal preview on http://localhost:' + PORT));
