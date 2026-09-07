#!/usr/bin/env node
'use strict';
/**
 * Load any state's harvest into the unified database.
 *
 *   node src/ingest.js ~/Downloads/pmsg-kl-14districts.json
 *   node src/ingest.js ~/Downloads/pmsg-tn-38districts.json
 *   node src/ingest.js ~/Downloads/pmsg-kl-14districts.json --snap 3   # add to existing snapshot
 *
 * Accepts both formats:
 *   • raw portal harvest  { capturedAt, state, source, districts:{}, failed:[] }
 *   • compact {V, M} export from the browser rescue snippet
 *
 * --snap <id>  adds this state into an existing snapshot (useful when you harvest
 *              TN and KL in the same session and want them in one snapshot).
 */
const fs   = require('node:fs');
const path = require('node:path');
const { ingest, open, q, DB_PATH } = require('./db');

const args   = process.argv.slice(2);
const file   = args.find(a => !a.startsWith('--'));
const snapIdx = args.indexOf('--snap');
const existingSnap = snapIdx > -1 ? Number(args[snapIdx + 1]) : null;

if (!file || !fs.existsSync(file)) {
  console.error('Usage: node src/ingest.js <harvest.json> [--snap <snapshot_id>]');
  process.exit(1);
}

const src = JSON.parse(fs.readFileSync(file, 'utf8'));

// Guess state from filename when the file doesn't specify it
// e.g.  pmsg-kl-14districts.json → KERALA
const STATE_FROM_PREFIX = {
  tn:'TAMIL NADU', kl:'KERALA', ka:'KARNATAKA', mh:'MAHARASHTRA',
  ap:'ANDHRA PRADESH', ts:'TELANGANA', gj:'GUJARAT', rj:'RAJASTHAN',
  up:'UTTAR PRADESH', wb:'WEST BENGAL', pb:'PUNJAB', hr:'HARYANA',
  mp:'MADHYA PRADESH', br:'BIHAR', or:'ODISHA', jk:'JAMMU and KASHMIR'
};
if (!src.state || src.state === 'UNKNOWN') {
  const m = path.basename(file).match(/^pmsg-([a-z]+)-/i);
  if (m) src.state = STATE_FROM_PREFIX[m[1].toLowerCase()] || m[1].toUpperCase();
}

/* ── detect format ── */
const COMPACT_FIELDS = ['vid','rowId','name','contact','email','phone','addr','web','rating',
                        'ratingCount','brands','natInst','natCap','stInst','stCap'];

let districts, state, capturedAt, source;

if (src.V && src.M) {
  // compact {V, M}
  state       = src.state || 'UNKNOWN';
  capturedAt  = src.capturedAt || new Date().toISOString();
  source      = src.source === 'demo' ? 'demo' : 'portal';
  const vend  = id => Object.fromEntries(COMPACT_FIELDS.map((k,i)=>[k,(src.V[id]||[])[i]]));
  districts   = {};
  for (const [d, vid, di, dc] of src.M) {
    const v = vend(vid);
    (districts[d] ||= []).push({
      id: v.rowId, vendorId: +vid, vendorName: v.name, previousVendorName: null,
      contactPersonName: v.contact, contactPersonEmail: v.email, contactPersonMobile: v.phone,
      address: v.addr, websiteUrl: v.web, rating: v.rating, consumerRatingCount: v.ratingCount||0,
      vendorBrandsList: v.brands ? String(v.brands).split('|').filter(Boolean).map(b=>({brandName:b})) : [],
      nationwiseInstallationAndCapacity:   {vendorId:+vid,installationCount:v.natInst||0,installedCapacity:v.natCap||0},
      statewiseInstallationAndCapacity:    {vendorId:+vid,installationCount:v.stInst||0, installedCapacity:v.stCap||0},
      districtwiseInstallationAndCapacity: {vendorId:+vid,installationCount:di||0,       installedCapacity:dc||0}
    });
  }
} else if (src.districts) {
  // raw portal harvest
  ({ districts, capturedAt, source } = src);
  state       = src.state || 'UNKNOWN';
  capturedAt  = capturedAt || new Date().toISOString();
  source      = source === 'demo' ? 'demo' : 'portal';
} else {
  console.error('Unrecognised harvest format.');
  process.exit(1);
}

const t0  = Date.now();
const res = ingest({ capturedAt, state, source, districts, failed: src.failed||[], snapshotId: existingSnap });
const db  = open();
const ss  = q.states(db, res.snapshotId);
const india = q.indiaStats(db, res.snapshotId);
db.close();

console.log(`\n✓ ${state} → snapshot #${res.snapshotId} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
console.log(`  districts        ${res.districts}`);
console.log(`  unique vendors   ${res.vendors.toLocaleString()}`);
console.log(`  coverage rows    ${res.rows.toLocaleString()}`);
console.log(`\nSnapshot #${res.snapshotId} now contains:`);
for (const s of ss) console.log(`  ${s.display.padEnd(22)} ${String(s.districts).padStart(3)} districts  ${String(s.installs||0).padStart(8)} installs  ${String(s.capacity_kw||0).padStart(12)} kW`);
if (india) console.log(`  ${'TOTAL'.padEnd(22)} ${String(india.districts).padStart(3)} districts  ${String(india.installs||0).padStart(8)} installs`);
console.log(`\nDatabase: ${DB_PATH}`);
console.log(`Dashboard: node src/server.js`);
if (existingSnap) console.log(`\nTip: to add another state to this snapshot use --snap ${res.snapshotId}`);
else              console.log(`\nTip: to add another state to this snapshot use --snap ${res.snapshotId}`);
