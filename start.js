#!/usr/bin/env node
'use strict';
/**
 *   node start.js              — load data, open dashboard
 *   node start.js --auto       — + re-harvest every 60 min
 *   node start.js --auto --now — + run first harvest immediately
 */
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
const { open, ingest, q } = require(path.join(ROOT, 'src', 'db'));

const COMPACT = ['vid','rowId','name','contact','email','phone','addr','web','rating',
                 'ratingCount','brands','natInst','natCap','stInst','stCap'];

function expand(src) {
  const vend = id => Object.fromEntries(COMPACT.map((k,i)=>[k,(src.V[id]||[])[i]]));
  const d={};
  for(const [dist,vid,di,dc] of src.M){
    const v=vend(vid);
    (d[dist]||=[]).push({id:v.rowId,vendorId:+vid,vendorName:v.name,previousVendorName:null,
      contactPersonName:v.contact,contactPersonEmail:v.email,contactPersonMobile:v.phone,
      address:v.addr,websiteUrl:v.web,rating:v.rating,consumerRatingCount:v.ratingCount||0,
      vendorBrandsList:v.brands?String(v.brands).split('|').filter(Boolean).map(b=>({brandName:b})):[],
      nationwiseInstallationAndCapacity:  {vendorId:+vid,installationCount:v.natInst||0,installedCapacity:v.natCap||0},
      statewiseInstallationAndCapacity:   {vendorId:+vid,installationCount:v.stInst||0, installedCapacity:v.stCap||0},
      districtwiseInstallationAndCapacity:{vendorId:+vid,installationCount:di||0,        installedCapacity:dc||0}});
  }
  return d;
}

function loadFile(file, snapshotId=null) {
  const src = JSON.parse(fs.readFileSync(file,'utf8'));
  // Guess state from filename when missing
  const STATE_PFX = {tn:'TAMIL NADU',kl:'KERALA',ka:'KARNATAKA',mh:'MAHARASHTRA',
    ap:'ANDHRA PRADESH',ts:'TELANGANA',gj:'GUJARAT',rj:'RAJASTHAN',up:'UTTAR PRADESH',
    wb:'WEST BENGAL',pb:'PUNJAB',hr:'HARYANA',mp:'MADHYA PRADESH',br:'BIHAR'};
  if (!src.state || src.state==='UNKNOWN') {
    const m=path.basename(file).match(/^pmsg-([a-z]+)-/i);
    if(m) src.state=STATE_PFX[m[1].toLowerCase()]||m[1].toUpperCase();
  }
  const districts = src.V&&src.M ? expand(src) : src.districts || null;
  if (!districts) throw new Error('unrecognised format');
  return ingest({ capturedAt: src.capturedAt||new Date().toISOString(),
    state: src.state||'UNKNOWN', source: src.source==='demo'?'demo':'portal',
    districts, failed: src.failed||[], snapshotId });
}

function findHarvests() {
  const home = os.homedir();
  const dirs = [ROOT, path.join(ROOT,'data'), path.join(home,'Downloads'), path.join(home,'Desktop')];
  const hits = [];
  for (const dir of dirs) {
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!/^pmsg-(tn|kl|[a-z]{2,4})-.*\.json$/i.test(n)) continue;
        const f=path.join(dir,n); hits.push({file:f,mtime:fs.statSync(f).mtimeMs,size:fs.statSync(f).size,name:n});
      }
    } catch {}
  }
  // Group by state prefix (pmsg-kl-*, pmsg-tn-*), take the largest per state
  const byState={};
  for(const h of hits){
    const m=h.name.match(/^pmsg-([a-z]+)-/i);
    const st=m?m[1].toLowerCase():'xx';
    if(!byState[st]||h.size>byState[st].size) byState[st]=h;
  }
  return Object.values(byState).sort((a,b)=>a.name.localeCompare(b.name));
}

function bootstrap() {
  let db=open(); const existing=q.snapshots(db); db.close();
  if (existing.length) {
    console.log(`Database ready — ${existing.length} snapshot(s), latest covers: ${existing[0].states}`); return;
  }
  console.log('Database empty. Looking for harvest files…');
  const found = findHarvests();
  if (found.length) {
    let snapId=null;
    for (const h of found) {
      try {
        process.stdout.write(`  loading ${path.basename(h.file)}… `);
        const r = loadFile(h.file, snapId);
        snapId = r.snapshotId;     // all states share the same snapshot
        console.log(`${r.districts} districts, ${r.vendors.toLocaleString()} vendors`);
      } catch(e) { console.log(`skipped (${e.message})`); }
    }
    return;
  }
  console.log('  no harvest files found — generating demo data.\n');
  try { require(path.join(ROOT,'src','seed-demo')); } catch {}
  for (const f of ['demo-tn.json','demo-kl.json']) {
    const p=path.join(ROOT,'data',f); if(fs.existsSync(p)){
      const r=loadFile(p); console.log(`  loaded ${f}: ${r.rows.toLocaleString()} rows`);
    }
  }
}

bootstrap();

const PORT = Number(process.env.PORT||8787);
process.env.PORT=String(PORT);
require(path.join(ROOT,'src','server'));

setTimeout(()=>{
  const cmd=process.platform==='darwin'?['open',[`http://localhost:${PORT}`]]:
            process.platform==='win32' ?['cmd',['/c','start','',`http://localhost:${PORT}`]]:
                                        ['xdg-open',[`http://localhost:${PORT}`]];
  execFile(cmd[0],cmd[1],()=>{});
},700);

if (process.argv.includes('--auto')) {
  const ei=process.argv.indexOf('--every'); const mins=Math.max(15,ei>-1?Number(process.argv[ei+1])||60:60);
  let harvester=null;
  try { harvester=require(path.join(ROOT,'src','auto-harvest')); } catch(e){ console.log('\n[auto] unavailable:',e.message); }
  if (harvester) {
    try { require('playwright'); } catch {
      console.log('\n[auto] Playwright not installed. Run:');
      console.log('[auto]   npm install playwright && npx playwright install chromium');
      harvester=null;
    }
  }
  if (harvester) {
    let busy=false;
    const cycle=async()=>{
      if(busy){console.log('[auto] still running, skipping');return;}
      busy=true; console.log('[auto] starting harvest…');
      try{ await harvester.runAll(); }finally{ busy=false; }
      console.log(`[auto] done. Next in ${mins} min.`);
    };
    console.log(`\n[auto] ON — every ${mins} min. Leave this running. Ctrl-C to stop.`);
    if(process.argv.includes('--now')) setTimeout(cycle,2000);
    else console.log(`[auto] first harvest in ${mins} min (add --now to run immediately)`);
    setInterval(cycle, mins*60*1000);
  }
}
