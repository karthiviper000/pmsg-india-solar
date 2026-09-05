#!/usr/bin/env node
'use strict';
const fs   = require('node:fs');
const path = require('node:path');
const { open, q } = require('./db');

const ROOT   = path.join(__dirname, '..');
const DIST   = path.join(ROOT, 'dist');
const REDACT = process.argv.includes('--redact');

const db     = open();
const snaps  = q.snapshots(db);
if (!snaps.length) { db.close(); throw new Error('database is empty'); }

const latest  = snaps[0].snapshot_id;
const previous= snaps[1]?.snapshot_id ?? null;

const states    = q.states(db, latest);
const districts = q.districts(db, latest);
const cmp       = q.compare(db, latest, previous);
const top       = q.topVendors(db, latest, null, 50);
const india     = q.indiaStats(db, latest);

// Build a flat coverage index: dIndex[i] = "STATE|districtName"
// coverage rows: [dIndex, vendorId, installs, capacity]
const dIndex = districts.map(d => d.state + '|' + d.district);
const dMap   = Object.fromEntries(dIndex.map((k,i) => [k,i]));

const covRows = db.prepare(`
  SELECT st.name AS state, d.name AS dist, vd.vendor_id, vd.installs, ROUND(vd.capacity,3) AS cap
  FROM vendor_district vd
  JOIN district d  ON d.district_id=vd.district_id
  JOIN state    st ON st.state_id=d.state_id
  WHERE vd.snapshot_id=? AND vd.installs>0
  ORDER BY vd.installs DESC`).all(latest);

const coverage = covRows.map(r => [dMap[r.state+'|'+r.dist] ?? -1, r.vendor_id, r.installs, r.cap]).filter(r=>r[0]>=0);

const vendorRows = db.prepare(`
  SELECT DISTINCT v.* FROM vendor v
  JOIN vendor_district vd ON vd.vendor_id=v.vendor_id
  WHERE vd.snapshot_id=?`).all(latest);

const vendors = {};
for (const v of vendorRows) {
  vendors[v.vendor_id] = REDACT
    ? { id:v.vendor_id, name:v.name, rating:v.rating, rc:v.rating_count, brands:v.brands,
        si:v.state_installs, sc:v.state_capacity, ni:v.nat_installs, nc:v.nat_capacity, redacted:true }
    : { id:v.vendor_id, name:v.name, rating:v.rating, rc:v.rating_count, brands:v.brands,
        si:v.state_installs, sc:v.state_capacity, ni:v.nat_installs, nc:v.nat_capacity,
        cn:v.contact_name, cp:v.contact_phone, ce:v.contact_email, addr:v.address, web:v.website_url };
}

// Enrich top vendors with states count for the all-india leaderboard
const vendorStates = {};
covRows.forEach(r => { (vendorStates[r.vendor_id] = vendorStates[r.vendor_id] || new Set()).add(r.state); });
top.forEach(v => { v._states = [...(vendorStates[v.vendor_id]||[])]; });

db.close();

const bundle = {
  generatedAt: new Date().toISOString(), redacted: REDACT,
  snapshots: snaps.map(s=>({snapshot_id:s.snapshot_id,captured_at:s.captured_at,source:s.source,states:s.states,districts_ok:s.districts_ok})),
  latest, previous, india, states, districts, dIndex, compare: cmp, top, vendors, coverage
};

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'data.json'), JSON.stringify(bundle));
fs.copyFileSync(path.join(ROOT, 'public', 'index.html'), path.join(DIST, 'index.html'));
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const sz = fs.statSync(path.join(DIST, 'data.json')).size;
console.log(`dist/ built`);
console.log(`  states     ${states.map(s=>s.display).join(', ')}`);
console.log(`  districts  ${districts.length}`);
console.log(`  vendors    ${Object.keys(vendors).length.toLocaleString()}`);
console.log(`  coverage   ${coverage.length.toLocaleString()} rows`);
console.log(`  data.json  ${(sz/1048576).toFixed(2)} MB${REDACT?' (redacted)':' (includes contacts)'}`);
if (!REDACT) console.log('\n  Public repo? Re-run with --redact');
