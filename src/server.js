#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const { open, q } = require('./db');

const PORT   = Number(process.env.PORT || 8787);
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME   = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
                 '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };

const json  = (res, body, code=200) => { const s=JSON.stringify(body); res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(s); };
const withDb = fn => { const db=open(); try { return fn(db); } finally { db.close(); } };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  const sp = u.searchParams;

  try {
    const snap = () => { const id = Number(sp.get('snap')); return withDb(db => id || q.latestId(db)); };
    const state = () => sp.get('state') || null;

    if (p === '/api/meta') return json(res, withDb(db => {
      const snaps = q.snapshots(db);
      return { snapshots: snaps, latest: snaps[0]?.snapshot_id ?? null,
               previous: snaps[1]?.snapshot_id ?? null,
               allDemo: snaps.length > 0 && snaps.every(s => s.source==='demo') };
    }));

    if (p === '/api/states')    return json(res, withDb(db => q.states(db, snap())));
    if (p === '/api/india')     return json(res, withDb(db => q.indiaStats(db, snap()) || {}));
    if (p === '/api/districts') return json(res, withDb(db => q.districts(db, snap(), state())));
    if (p === '/api/compare')   return json(res, withDb(db => {
      const snaps = q.snapshots(db);
      const cur  = Number(sp.get('cur'))  || snaps[0]?.snapshot_id;
      const prev = sp.get('prev') != null ? Number(sp.get('prev')) : snaps[1]?.snapshot_id ?? null;
      return { cur, prev, rows: cur ? q.compare(db, cur, prev, state()) : [] };
    }));
    if (p === '/api/top')    return json(res, withDb(db => q.topVendors(db, snap(), state(), Math.min(Number(sp.get('limit'))||25,200))));
    if (p === '/api/search') return json(res, withDb(db => {
      const term = (sp.get('q')||'').trim();
      return term.length < 2 ? [] : q.search(db, snap(), term, state());
    }));

    let m = p.match(/^\/api\/district\/(.+)\/(.+)$/);
    if (m) return json(res, withDb(db => {
      const id = snap();
      const [, st, dist] = m.map(decodeURIComponent);
      return { district: dist, state: st, snapshot_id: id,
               vendors: q.districtVendors(db, id, dist, st, Math.min(Number(sp.get('limit'))||300,2000)) };
    }));

    m = p.match(/^\/api\/vendor\/(\d+)$/);
    if (m) return json(res, withDb(db => {
      const v = q.vendor(db, snap(), Number(m[1]));
      return v ? json(res, v) : json(res, { error: 'not found' }, 404);
    }));

    // static files
    const rel  = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return json(res, { error: 'nope' }, 403);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch(e) { json(res, { error: e.message }, 500); }
});

server.listen(PORT, () => {
  let note = '';
  try {
    const db = open(); const snaps = q.snapshots(db); db.close();
    note = snaps.length ? `${snaps.length} snapshot(s) — states: ${snaps[0].states}` : 'database empty — run an ingest first';
  } catch(e) { note = `db error: ${e.message}`; }
  console.log(`PM Surya Ghar India dashboard → http://localhost:${PORT}`);
  console.log(`  ${note}`);
});
