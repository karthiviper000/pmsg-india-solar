#!/usr/bin/env node
'use strict';
/**
 * Headless browser harvester — one per state, all in a single snapshot.
 * Add states to STATES array; each entry is the name as the portal spells it.
 *
 *   node src/auto-harvest.js             # all states, headless
 *   node src/auto-harvest.js --headed    # visible browser
 *   node src/auto-harvest.js --state KERALA  # one state only
 */
const fs   = require('node:fs');
const path = require('node:path');
const { ingest } = require('./db');

const STATES = [
  { name: 'TAMIL NADU',  districts: ["Ariyalur","CHENGALPATTU","Chennai","Coimbatore","Cuddalore","Dharmapuri","Dindigul","Erode","KALLAKURICHI","Kanchipuram","Kanniyakumari","Karur","Krishnagiri","Madurai","Mayiladuthurai","Nagapattinam","Namakkal","Perambalur","Pudukkottai","Ramanathapuram","Ranipet","Salem","Sivaganga","TENKASI","Thanjavur","The Nilgiris","Theni","Thiruvallur","Thiruvannamalai","Thiruvarur","Thoothukkudi","Tiruchirappalli","Tirunelveli","Tirupathur","Tiruppur","Tiruvannamalai","Vellore","Viluppuram","Virudhunagar"] },
  { name: 'KERALA',      districts: ["Alappuzha","Ernakulam","Idukki","Kannur","Kasaragod","Kollam","Kottayam","Kozhikode","Malappuram","Palakkad","Pathanamthitta","Thiruvananthapuram","Thrissur","Wayanad"] },
  // To add a new state: just add an entry here.
  // The district list is optional — if omitted, the harvester will read
  // it from the dropdown after selecting the state.
  // { name: 'KARNATAKA', districts: [] },
];

const URL_ = 'https://pmsuryaghar.gov.in/#/registered-vendors';
const ENDPOINT = /registeredVendor\/getVendorByStateDistrict/i;
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── page agent installed inside the browser ── */
function pageAgent() {
  window.__hits = [];
  if (!window.__hooked) {
    window.__hooked = true;
    const open=XMLHttpRequest.prototype.open, send=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open=function(m,u,...r){this.__u=u;return open.call(this,m,u,...r);};
    XMLHttpRequest.prototype.send=function(b){
      if(/registeredVendor\/getVendorByStateDistrict/i.test(this.__u||'')){
        const x=this;this.addEventListener('load',()=>window.__hits.push(String(x.responseText||'')));
      }return send.call(this,b);
    };
  }
  window.__dlabel=id=>document.getElementById(id)?.querySelector('.p-dropdown-label')?.textContent.trim();
  window.__pick=async function(ddId,text,sentinel){
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    document.querySelectorAll('.p-dropdown-panel').forEach(p=>p.remove());
    document.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    await sleep(150);
    const dd=document.getElementById(ddId); if(!dd)return 'no-dd';
    (dd.querySelector('.p-dropdown-trigger')||dd).click(); await sleep(750);
    const panels=[...document.querySelectorAll('.p-dropdown-panel')]; if(!panels.length)return 'no-panel';
    let items=[...panels[panels.length-1].querySelectorAll('.p-dropdown-item')];
    if(sentinel){const i=items.map(e=>e.textContent.trim()).lastIndexOf(sentinel);if(i>=0)items=items.slice(i+1);}
    const hit=items.find(e=>e.textContent.trim().toLowerCase()===text.toLowerCase());
    if(!hit){document.body.click();return 'missing';}
    hit.click();await sleep(500);return window.__dlabel(ddId);
  };
  window.__apply=async function(ms){
    const n=window.__hits.length;
    const b=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim().toLowerCase()==='apply');
    if(!b)return null; b.click();
    const t0=Date.now();
    while(window.__hits.length===n&&Date.now()-t0<(ms||30000))await new Promise(r=>setTimeout(r,300));
    return window.__hits.length>n?window.__hits[window.__hits.length-1]:null;
  };
  return true;
}

const sigOf = arr => arr.length+'|'+arr.reduce((s,v)=>s+(v.districtwiseInstallationAndCapacity?.installationCount||0),0);

async function harvestState(page, stateCfg) {
  const { name, districts } = stateCfg;
  const V={}, M=[], sigs={}, failed=[];

  await page.evaluate(pageAgent);
  const st = await page.evaluate(([n])=>window.__pick('state',n), [name]);
  if (String(st).toUpperCase()!==name.toUpperCase()) throw new Error(`could not select ${name} (got "${st}")`);
  await page.waitForTimeout(3000);

  // Get districts from dropdown if not provided
  let dists = districts && districts.length ? districts : await page.evaluate(async()=>{
    document.querySelectorAll('.p-dropdown-panel').forEach(p=>p.remove());
    document.getElementById('district')?.querySelector('.p-dropdown-trigger')?.click();
    await new Promise(r=>setTimeout(r,900));
    const items=[...document.querySelectorAll('.p-dropdown-panel')].pop()?.querySelectorAll('.p-dropdown-item')||[];
    const list=[...items].map(e=>e.textContent.trim());
    document.body.click(); return list;
  });
  log(`${name}: ${dists.length} districts`);

  for (let i=0; i<dists.length; i++) {
    const d = dists[i];
    const tag = `${name} [${String(i+1).padStart(2,'0')}/${dists.length}] ${d}`;
    let ok=false;
    for (let attempt=1; attempt<=2&&!ok; attempt++) {
      try {
        await page.evaluate(pageAgent);
        const got = await page.evaluate(([id,n,sent])=>window.__pick(id,n,sent),['district',d,'WEST BENGAL']);
        if(String(got).toLowerCase()!==d.toLowerCase()){log(`${tag} — label fail (${got})`);continue;}
        const raw = await page.evaluate(()=>window.__apply(30000));
        if(!raw){log(`${tag} — no response`);continue;}
        const arr=JSON.parse(raw), sig=sigOf(arr);
        const clash=Object.entries(sigs).find(([,v])=>v===sig);
        if(clash){log(`${tag} — dup of ${clash[0]}, retry`);await page.evaluate(()=>{window.__hits.length=0;});await page.waitForTimeout(1200);continue;}
        for(const v of arr){
          const n=v.nationwiseInstallationAndCapacity||{},s=v.statewiseInstallationAndCapacity||{},x=v.districtwiseInstallationAndCapacity||{};
          if(!V[v.vendorId])V[v.vendorId]=[v.vendorId,v.id??null,v.vendorName||'',v.contactPersonName||'',v.contactPersonEmail||'',v.contactPersonMobile||'',v.address||'',v.websiteUrl||'',v.rating??null,v.consumerRatingCount||0,(v.vendorBrandsList||[]).map(b=>b.brandName||b.brand||'').filter(Boolean).join('|'),n.installationCount||0,n.installedCapacity||0,s.installationCount||0,s.installedCapacity||0];
          M.push([d,v.vendorId,x.installationCount||0,x.installedCapacity||0]);
        }
        sigs[d]=sig; ok=true; log(`${tag} — ${arr.length} vendors`);
      }catch(e){log(`${tag} — ${e.message}`);}
      await page.evaluate(()=>{window.__hits.length=0;}).catch(()=>{});
    }
    if(!ok) failed.push(d);
    await page.waitForTimeout(400);
  }
  return { V, M, failed, districts: Object.keys(sigs), capturedAt: new Date().toISOString() };
}

const COMPACT_F=['vid','rowId','name','contact','email','phone','addr','web','rating','ratingCount','brands','natInst','natCap','stInst','stCap'];
function compact2portal(V,M){
  const vend=id=>Object.fromEntries(COMPACT_F.map((k,i)=>[k,(V[id]||[])[i]]));
  const d={};
  for(const[dist,vid,di,dc]of M){const v=vend(vid);(d[dist]||=[]).push({id:v.rowId,vendorId:+vid,vendorName:v.name,previousVendorName:null,contactPersonName:v.contact,contactPersonEmail:v.email,contactPersonMobile:v.phone,address:v.addr,websiteUrl:v.web,rating:v.rating,consumerRatingCount:v.ratingCount||0,vendorBrandsList:v.brands?String(v.brands).split('|').filter(Boolean).map(b=>({brandName:b})):[],nationwiseInstallationAndCapacity:{vendorId:+vid,installationCount:v.natInst||0,installedCapacity:v.natCap||0},statewiseInstallationAndCapacity:{vendorId:+vid,installationCount:v.stInst||0,installedCapacity:v.stCap||0},districtwiseInstallationAndCapacity:{vendorId:+vid,installationCount:di||0,installedCapacity:dc||0}});}
  return d;
}

async function runAll(opts={}) {
  let chromium;
  try { ({chromium}=require('playwright')); } catch { throw new Error('Run: npm install playwright && npx playwright install chromium'); }
  const filter = process.argv.includes('--state') ? process.argv[process.argv.indexOf('--state')+1]?.toUpperCase() : null;
  const toRun  = filter ? STATES.filter(s=>s.name.toUpperCase()===filter) : STATES;

  const browser = await chromium.launch({headless:!opts.headed});
  const page    = await browser.newPage({viewport:{width:1400,height:900}});

  const capturedAt  = new Date().toISOString();
  let snapId        = null;
  const dir         = path.join(__dirname,'..','data','harvests');
  fs.mkdirSync(dir,{recursive:true});

  try {
    log(`opening portal…`);
    await page.goto(URL_,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForSelector('#state',{timeout:60000});

    for (const stateCfg of toRun) {
      try {
        const res = await harvestState(page, stateCfg);
        const districts = compact2portal(res.V, res.M);
        const r = ingest({capturedAt, state:stateCfg.name, source:'portal', districts, failed:res.failed, snapshotId:snapId});
        snapId = r.snapshotId;
        log(`${stateCfg.name} → snapshot #${snapId}: ${r.districts} districts, ${r.vendors.toLocaleString()} vendors`);
        if(res.failed.length) log(`  failed: ${res.failed.join(', ')}`);
        // archive raw
        const f=path.join(dir,`${stateCfg.name.replace(/\s+/g,'-')}-${capturedAt.replace(/[:.]/g,'-')}.json`);
        fs.writeFileSync(f,JSON.stringify({capturedAt,state:stateCfg.name,source:'portal',V:res.V,M:res.M,failed:res.failed}));
      } catch(e) { log(`${stateCfg.name} FAILED: ${e.message}`); }
    }
  } finally { await browser.close().catch(()=>{}); }
  // keep last 48 per state
  for(const s of STATES){ const prefix=s.name.replace(/\s+/g,'-'); const files=fs.readdirSync(dir).filter(f=>f.startsWith(prefix)).sort(); for(const f of files.slice(0,Math.max(0,files.length-48)))fs.unlinkSync(path.join(dir,f)); }
  return snapId;
}

module.exports = { runAll, STATES };
if (require.main===module) runAll({headed:process.argv.includes('--headed')}).then(id=>{ log('done, snapshot #'+id); process.exit(id?0:1); });
