#!/usr/bin/env node
'use strict';
const fs   = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { ingest } = require('./db');

const ROOT    = path.join(__dirname,'..');
const STORE   = path.join(ROOT,'data','store');
const HISTORY = path.join(STORE,'history.json');
const DB      = path.join(ROOT,'data','pmsg.db');
const REDACT  = process.argv.includes('--redact');
const { STATES, runAll } = require('./auto-harvest');

const readGz  = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
const writeGz = (f,o) => fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(o)),{level:9}));
const log     = (...a) => console.log('[ci]',...a);
const storeFile = name => path.join(STORE, name+'.json.gz');

const COMPACT_F=['vid','rowId','name','contact','email','phone','addr','web','rating','ratingCount','brands','natInst','natCap','stInst','stCap'];
function compact2portal(V,M){const vend=id=>Object.fromEntries(COMPACT_F.map((k,i)=>[k,(V[id]||[])[i]]));const d={};for(const[dist,vid,di,dc]of M){const v=vend(vid);(d[dist]||=[]).push({id:v.rowId,vendorId:+vid,vendorName:v.name,previousVendorName:null,contactPersonName:v.contact,contactPersonEmail:v.email,contactPersonMobile:v.phone,address:v.addr,websiteUrl:v.web,rating:v.rating,consumerRatingCount:v.ratingCount||0,vendorBrandsList:v.brands?String(v.brands).split('|').filter(Boolean).map(b=>({brandName:b})):[],nationwiseInstallationAndCapacity:{vendorId:+vid,installationCount:v.natInst||0,installedCapacity:v.natCap||0},statewiseInstallationAndCapacity:{vendorId:+vid,installationCount:v.stInst||0,installedCapacity:v.stCap||0},districtwiseInstallationAndCapacity:{vendorId:+vid,installationCount:di||0,installedCapacity:dc||0}});}return d;}

function rebuildAndExport() {
  [DB, DB+'-wal', DB+'-shm'].forEach(f=>fs.rmSync(f,{force:true}));
  let snapId=null;
  for (const s of STATES) {
    for (const slot of ['previous','latest']) {
      const f=storeFile(s.name.replace(/\s+/g,'-')+'-'+slot);
      if(!fs.existsSync(f))continue;
      const src=readGz(f);
      const districts=compact2portal(src.V,src.M);
      const r=ingest({capturedAt:src.capturedAt,state:s.name,source:'portal',districts,failed:src.failed||[],snapshotId:slot==='previous'?snapId:null});
      if(slot==='previous')snapId=r.snapshotId;
      log(`ingested ${path.basename(f)} → snapshot #${r.snapshotId} (${r.districts} districts)`);
    }
  }
  execFileSync(process.execPath,[path.join(ROOT,'src','export-static.js'),...(REDACT?['--redact']:[])],{stdio:'inherit'});
}

(async()=>{
  fs.mkdirSync(STORE,{recursive:true});
  let anyData=false;
  for(const s of STATES){ if(fs.existsSync(storeFile(s.name.replace(/\s+/g,'-')+'-latest'))){anyData=true;break;} }

  // Harvest
  try {
    await runAll();
    // Each state wrote raw to data/harvests; read them back and rotate store
    const harvestDir=path.join(ROOT,'data','harvests');
    for(const s of STATES){
      const prefix=s.name.replace(/\s+/g,'-');
      const files=fs.existsSync(harvestDir)?fs.readdirSync(harvestDir).filter(f=>f.startsWith(prefix)&&f.endsWith('.json')).sort():[];
      if(!files.length)continue;
      const latest=JSON.parse(fs.readFileSync(path.join(harvestDir,files[files.length-1]),'utf8'));
      const latestKey=storeFile(prefix+'-latest');
      // Check if identical
      const prevSum=fs.existsSync(latestKey)?readGz(latestKey).M.reduce((s,r)=>s+r[2],0):null;
      const newSum=latest.M.reduce((s,r)=>s+r[2],0);
      if(prevSum===newSum){log(`${s.name}: identical to last run, not rotating`);continue;}
      if(fs.existsSync(latestKey))fs.copyFileSync(latestKey,storeFile(prefix+'-previous'));
      writeGz(latestKey,latest);
      log(`${s.name}: rotated store`);
    }
  } catch(e) {
    log(`harvest failed: ${e.message}`);
    if(!anyData){log('no previous data; cannot publish'); process.exit(1);}
    log('using previous data');
  }

  rebuildAndExport();

  // Append history row
  const hist=fs.existsSync(HISTORY)?JSON.parse(fs.readFileSync(HISTORY,'utf8')):[];
  const db=require('./db').open(), india=require('./db').q.indiaStats(db,require('./db').q.latestId(db));db.close();
  hist.push({at:new Date().toISOString(),installs:india?.installs||0,capacity:india?.capacity_kw||0,districts:india?.districts||0});
  fs.writeFileSync(HISTORY,JSON.stringify(hist.slice(-8760)));
  log(`history: ${hist.length} entries`);
})();
