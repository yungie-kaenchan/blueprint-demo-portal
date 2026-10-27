// Builds public/index.html from the Google kit's Index.html, so both houses share ONE game page.
// The only difference: a tiny adapter that sends google.script.run calls to /api/game on Netlify.
// Run: node tools/build-public.mjs   (also runs as the Netlify build command)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const srcCandidates = [path.join(root, 'shared', 'Index.html'), path.join(root, '..', 'word-quest', 'Index.html')];
const src = srcCandidates.find(p => fs.existsSync(p));
if (!src) throw new Error('Index.html not found (shared/Index.html or ../word-quest/Index.html)');

const adapter = `<script>
/* Netlify house adapter: same google.script.run API as Apps Script, but over fetch to /api/game */
window.google = { script: { get run() {
  let ok = () => {}, fail = () => {};
  const p = new Proxy({}, { get(_, k) {
    if (k === 'withSuccessHandler') return f => { ok = f; return p; };
    if (k === 'withFailureHandler') return f => { fail = f; return p; };
    return (...args) => fetch('/api/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: k, args }) })
      .then(r => r.json()).then(j => j.ok ? ok(j.value) : fail(new Error(j.error || 'NETWORK'))).catch(() => fail(new Error('NETWORK')));
  } });
  return p;
} } };
</script>`;

let html = fs.readFileSync(src, 'utf8');
html = html.replace('<base target="_top">', '').replace('</head>', adapter + '\n</head>');
html = html.replace('Word Quest · House Kit · Blueprint Before You Build', 'Word Quest · Netlify house · Blueprint Before You Build');
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'public', 'index.html'), html);
// keep a copy inside this kit so a GitHub template / Deploy button works on its own
fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
if (src !== path.join(root, 'shared', 'Index.html')) fs.copyFileSync(src, path.join(root, 'shared', 'Index.html'));
console.log('public/index.html built from', path.relative(root, src));
