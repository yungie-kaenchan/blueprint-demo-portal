// In-memory stand-ins for the Google Sheets client and Netlify Blobs (tests + local preview)
// latency (ms, optional): each call waits a random 0..latency ms before it touches the data,
// so concurrent calls interleave the way real network calls do. The read or write itself stays atomic.
/* ---------- fakes ---------- */
const col = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const pause = latency => (latency ? new Promise(r => setTimeout(r, Math.random() * latency)) : Promise.resolve());
export function fakeSheets({ latency = 0 } = {}) {
  const tabs = {}; let writes = 0;
  const parse = range => {
    const [t, a1] = range.split('!'); const m = a1.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
    return { t, c1: col(m[1]), r1: +m[2], c2: m[3] ? col(m[3]) : 99, r2: m[4] ? +m[4] : 1e6 };
  };
  const filled = row => (row || []).some(v => v !== '' && v !== undefined);
  const api = {
    tabs, get writes() { return writes; },
    async meta() { await pause(latency); return { properties: { timeZone: 'Asia/Bangkok' }, sheets: Object.keys(tabs).map(title => ({ properties: { title } })) }; },
    async batchUpdate(reqs) { await pause(latency); reqs.forEach(r => { tabs[r.addSheet.properties.title] = []; }); },
    // like the Sheets API: empty rows inside the range come back as [], trailing empty rows are left out
    async batchGet(ranges) {
      await pause(latency);
      return ranges.map(r => {
        const p = parse(r);
        const rows = Array.from((tabs[p.t] || []).slice(p.r1 - 1, p.r2), row => (filled(row) ? row.slice(p.c1 - 1, p.c2) : []));
        while (rows.length && !filled(rows[rows.length - 1])) rows.pop();
        return rows;
      });
    },
    async append(range, rows) {
      await pause(latency);
      writes++; const p = parse(range); const t = tabs[p.t];
      let last = t.length; while (last > 0 && !(t[last - 1] || []).some(v => v !== '')) last--;
      rows.forEach((row, i) => { t[last + i] = row.slice(); });
      return last + 1;
    },
    async update(range, rows) {
      await pause(latency);
      writes++; const p = parse(range); const t = tabs[p.t];
      rows.forEach((row, i) => { const r = t[p.r1 - 1 + i] = (t[p.r1 - 1 + i] || []).slice(); row.forEach((v, j) => { r[p.c1 - 1 + j] = v; }); });
    },
  };
  return api;
}
// Netlify Blobs stand-in, including ETags and conditional writes (onlyIfNew / onlyIfMatch) like @netlify/blobs 11
export function memStore({ latency = 0 } = {}) {
  const m = new Map(); let version = 0;
  const read = (v, o) => (o && o.type === 'json' ? JSON.parse(v.data) : v.data);
  async function write(k, data, o = {}) {
    await pause(latency);
    const cur = m.get(k);
    if (o.onlyIfNew && cur) return { modified: false };
    if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
    const etag = '"v' + (++version) + '"';
    m.set(k, { data, metadata: (o && o.metadata) || {}, etag });
    return { modified: true, etag };
  }
  return {
    async get(k, o) { await pause(latency); return m.has(k) ? read(m.get(k), o) : null; },
    async getWithMetadata(k, o) { await pause(latency); const v = m.get(k); return v ? { data: read(v, o), metadata: v.metadata, etag: v.etag } : null; },
    setJSON: (k, v, o) => write(k, JSON.stringify(v), o),
    set: (k, data, o) => write(k, data, o),
    async delete(k) { await pause(latency); m.delete(k); },
    size: () => m.size,
  };
}
