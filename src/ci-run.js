#!/usr/bin/env node
'use strict';
/**
 * CI entrypoint — runs on GitHub Actions.
 * Priority:
 *   1. Try to scrape the portal live (Playwright)
 *   2. If scrape fails, fall back to harvest JSON files committed in the repo
 *   3. If neither exists, exit with error
 */
const fs   = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { ingest, open, q } = require('./db');

const ROOT    = path.join(__dirname, '..');
const STORE   = path.join(ROOT, 'data', 'store');
const HISTORY = path.join(STORE, 'history.json');
const DB      = path.join(ROOT, 'data', 'pmsg.db');
const REDACT  = process.argv.includes('--redact');

const log = (...a) => console.log(new Date().toISOString().slice(11,19), '[ci]', ...a);
const readGz  = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
const writeGz = (f,o) => fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(o)),{level:9}));
const storeFile = n => path.join(STORE, n+'.json.gz');

const COMPACT_F = ['vid','rowId','name','contact','email','phone','addr','web','rating',
                   'ratingCount','brands','natInst','natCap','stInst','stCap'];

// Map filename prefix to state name
const PREFIX_TO_STATE = {
  'tn':'TAMIL NADU','kl':'KERALA','ka':'KARNATAKA','mh':'MAHARASHTRA',
  'ap':'ANDHRA PRADESH','ts':'TELANGANA','gj':'GUJARAT','rj':'RAJASTHAN',
  'up':'UTTAR PRADESH','wb':'WEST BENGAL','pb':'PUNJAB','hr':'HARYANA'
};

function compact2portal(V, M) {
  const vend = id => Object.fromEntries(COMPACT_F.map((k,i) => [k,(V[id]||[])[i]]));
  const d = {};
  for (const [dist,vid,di,dc] of M) {
    const v = vend(vid);
    (d[dist]||=[]).push({
      id:v.rowId, vendorId:+vid, vendorName:v.name, previousVendorName:null,
      contactPersonName:v.contact, contactPersonEmail:v.email, contactPersonMobile:v.phone,
      address:v.addr, websiteUrl:v.web, rating:v.rating, consumerRatingCount:v.ratingCount||0,
      vendorBrandsList: v.brands?String(v.brands).split('|').filter(Boolean).map(b=>({brandName:b})):[],
      nationwiseInstallationAndCapacity:  {vendorId:+vid,installationCount:v.natInst||0,installedCapacity:v.natCap||0},
      statewiseInstallationAndCapacity:   {vendorId:+vid,installationCount:v.stInst||0, installedCapacity:v.stCap||0},
      districtwiseInstallationAndCapacity:{vendorId:+vid,installationCount:di||0,        installedCapacity:dc||0}
    });
  }
  return d;
}

function loadRawFile(file) {
  const src = JSON.parse(fs.readFileSync(file,'utf8'));
  // detect state from filename if not set
  if (!src.state || src.state === 'UNKNOWN') {
    const m = path.basename(file).match(/^pmsg-([a-z]+)-/i);
    if (m) src.state = PREFIX_TO_STATE[m[1].toLowerCase()] || m[1].toUpperCase();
  }
  const districts = src.V && src.M ? compact2portal(src.V, src.M) : src.districts;
  if (!districts) throw new Error('unrecognised format');
  return { state: src.state, capturedAt: src.capturedAt||new Date().toISOString(),
           districts, failed: src.failed||[] };
}

function rebuildDB() {
  [DB, DB+'-wal', DB+'-shm'].forEach(f => fs.rmSync(f,{force:true}));

  // Load from rotating store (previous then latest for delta comparisons)
  const STATES_CFG = (() => {
    try { return require('./auto-harvest').STATES; }
    catch(e) { return [{name:'TAMIL NADU'},{name:'KERALA'}]; }
  })();

  let anyLoaded = false;
  for (const slot of ['previous','latest']) {
    let snapId = null, firstInSlot = true;
    for (const s of STATES_CFG) {
      const key = s.name.replace(/\s+/g,'-')+'-'+slot;
      const f   = storeFile(key);
      if (!fs.existsSync(f)) continue;
      const src = readGz(f);
      const r = ingest({
        capturedAt: src.capturedAt, state: s.name, source:'portal',
        districts: compact2portal(src.V, src.M),
        failed: src.failed||[],
        snapshotId: firstInSlot ? null : snapId
      });
      if (firstInSlot) { snapId = r.snapshotId; firstInSlot = false; }
      log(`loaded ${key} → snapshot #${r.snapshotId} (${r.districts} districts)`);
      anyLoaded = true;
    }
  }
  return anyLoaded;
}

async function main() {
  fs.mkdirSync(STORE, {recursive:true});

  // ── Step 1: Try live scrape ──────────────────────────────────────────────
  let scraped = false;
  try {
    const { runAll } = require('./auto-harvest');
    log('attempting live scrape…');
    await runAll();

    // rotate store from harvests folder
    const harvestDir = path.join(ROOT,'data','harvests');
    const STATES_CFG = require('./auto-harvest').STATES;
    for (const s of STATES_CFG) {
      const prefix = s.name.replace(/\s+/g,'-');
      const files  = fs.existsSync(harvestDir)
        ? fs.readdirSync(harvestDir).filter(f=>f.startsWith(prefix)&&f.endsWith('.json')).sort()
        : [];
      if (!files.length) continue;
      const latest    = JSON.parse(fs.readFileSync(path.join(harvestDir,files[files.length-1]),'utf8'));
      const latestKey = storeFile(prefix+'-latest');
      const prevSum   = fs.existsSync(latestKey) ? readGz(latestKey).M.reduce((s,r)=>s+r[2],0) : null;
      const newSum    = latest.M.reduce((s,r)=>s+r[2],0);
      if (prevSum === newSum) { log(`${s.name}: unchanged`); continue; }
      if (fs.existsSync(latestKey)) fs.copyFileSync(latestKey, storeFile(prefix+'-previous'));
      writeGz(latestKey, latest);
      log(`${s.name}: store rotated`);
      scraped = true;
    }
  } catch(e) {
    log(`live scrape failed (${e.message}) — using committed harvest files`);
  }

  // ── Step 2: If store is empty, load from committed JSON files ────────────
  const storeHasData = fs.readdirSync(STORE).some(f=>f.endsWith('.json.gz'));
  if (!storeHasData) {
    log('store empty — loading from committed harvest files…');
    // look for pmsg-*.json files in the repo root and data/
    const searchDirs = [ROOT, path.join(ROOT,'data')];
    const files = [];
    for (const dir of searchDirs) {
      try {
        fs.readdirSync(dir)
          .filter(f=>/^pmsg-[a-z]+-.*\.json$/i.test(f))
          .forEach(f=>files.push(path.join(dir,f)));
      } catch(e){}
    }
    if (!files.length) {
      log('ERROR: no harvest files found anywhere. Commit pmsg-tn-*.json and pmsg-kl-*.json to the repo root.');
      process.exit(1);
    }
    // sort by size descending (more districts = bigger file = load first)
    files.sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size);
    let snapId = null;
    for (const file of files) {
      try {
        const { state, capturedAt, districts, failed } = loadRawFile(file);
        const r = ingest({ capturedAt, state, source:'portal', districts, failed, snapshotId: snapId });
        snapId = r.snapshotId;
        // save to store so next run can compare
        const key = state.replace(/\s+/g,'-')+'-latest';
        const V={}, M=[];
        for (const [dist,arr] of Object.entries(districts)) {
          for (const v of arr) {
            const n=v.nationwiseInstallationAndCapacity||{},s=v.statewiseInstallationAndCapacity||{},x=v.districtwiseInstallationAndCapacity||{};
            if(!V[v.vendorId])V[v.vendorId]=[v.vendorId,v.id,v.vendorName,v.contactPersonName,v.contactPersonEmail,v.contactPersonMobile,v.address,v.websiteUrl,v.rating,v.consumerRatingCount,'',n.installationCount||0,n.installedCapacity||0,s.installationCount||0,s.installedCapacity||0];
            M.push([dist,v.vendorId,x.installationCount||0,x.installedCapacity||0]);
          }
        }
        writeGz(storeFile(key), {capturedAt,state,source:'portal',V,M,failed});
        log(`loaded ${path.basename(file)} → ${state}, snapshot #${r.snapshotId}, ${r.rows.toLocaleString()} rows`);
      } catch(e) { log(`skipped ${path.basename(file)}: ${e.message}`); }
    }
  } else {
    rebuildDB();
  }

  // ── Step 3: Export ───────────────────────────────────────────────────────
  execFileSync(process.execPath,
    [path.join(ROOT,'src','export-static.js'), ...(REDACT?['--redact']:[])],
    {stdio:'inherit'});

  // ── Step 4: History ──────────────────────────────────────────────────────
  const db2 = open(); const id = q.latestId(db2); const india = id?q.indiaStats(db2,id):null; db2.close();
  const hist = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY,'utf8')) : [];
  hist.push({at:new Date().toISOString(),installs:india?.installs||0,capacity:india?.capacity_kw||0,districts:india?.districts||0,scraped});
  fs.writeFileSync(HISTORY, JSON.stringify(hist.slice(-8760)));
  log(`done · ${(india?.installs||0).toLocaleString()} installs · ${india?.districts||0} districts`);
}

main().catch(e=>{ console.error(e.message); process.exit(1); });
