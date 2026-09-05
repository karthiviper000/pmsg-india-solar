#!/usr/bin/env node
'use strict';
// Generates demo data for both TN and KL in one snapshot for testing.
const fs = require('node:fs');
const path = require('node:path');
const { ingest } = require('./db');

const TN = ["Ariyalur","CHENGALPATTU","Chennai","Coimbatore","Cuddalore","Dharmapuri","Dindigul","Erode","KALLAKURICHI","Kanchipuram","Kanniyakumari","Karur","Krishnagiri","Madurai","Mayiladuthurai","Nagapattinam","Namakkal","Perambalur","Pudukkottai","Ramanathapuram","Ranipet","Salem","Sivaganga","TENKASI","Thanjavur","The Nilgiris","Theni","Thiruvallur","Thiruvannamalai","Thiruvarur","Thoothukkudi","Tiruchirappalli","Tirunelveli","Tirupathur","Tiruppur","Tiruvannamalai","Vellore","Viluppuram","Virudhunagar"];
const KL = ["Alappuzha","Ernakulam","Idukki","Kannur","Kasaragod","Kollam","Kottayam","Kozhikode","Malappuram","Palakkad","Pathanamthitta","Thiruvananthapuram","Thrissur","Wayanad"];
const TN_W = {Chennai:10,Coimbatore:7.5,Tiruppur:5,Madurai:4.5,Salem:4,Erode:3.8,CHENGALPATTU:3.5};
const KL_W = {Ernakulam:10,Thrissur:7.5,Thiruvananthapuram:7,Kollam:6.5,Alappuzha:6,Malappuram:5.5};

let seed=20260803;
const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
const pick=a=>a[Math.floor(rnd()*a.length)];
const STEM=['Solar','Surya','Kadhir','Vel','Helios','Agni','Chola','Marut','Kalam','Vetri','Kondaas'];
const TAIL=['Energy Systems','Solar Solutions','Renewables','Power Projects','Green Energy','Electricals'];
const BRANDS=['Adani Solar','Waaree','Vikram Solar','Tata Power Solar','RenewSys','Goldi Solar'];
const FIRST=['Anand','Bala','Chandran','Dinesh','Gopal','Hari','Karthik','Lakshmi','Murugan','Ravi'];

function makePool(n){const p=[];for(let i=0;i<n;i++){p.push({vendorId:20000+i*7,id:1000+i,vendorName:`${pick(STEM)} ${pick(TAIL)}`,previousVendorName:null,contactPersonName:pick(FIRST),contactPersonEmail:`v${i}@example.invalid`,contactPersonMobile:`9${Math.floor(rnd()*9e8+1e8)}`,address:`${Math.floor(rnd()*200)+1}, Main Road, India`,websiteUrl:rnd()>.7?`https://example.invalid/${i}`:'',discomJson:null,rating:rnd()>.45?Math.round((3+rnd()*2)*10)/10:null,consumerRatingCount:Math.floor(rnd()*100),vendorBrandsList:rnd()>.5?[{brandName:pick(BRANDS)}]:[]});}return p;}

function makeDistricts(pool,dists,weights,growth){
  const out={};
  for(const d of dists){
    const w=weights[d]??1, n=Math.max(20,Math.round((60+w*100)*(0.9+rnd()*.2)));
    const chosen=[];
    for(let i=0;i<n&&i<pool.length;i++){const v=pool[Math.floor(rnd()*pool.length)];if(!chosen.find(c=>c.vendorId===v.vendorId))chosen.push(v);}
    out[d]=chosen.map(v=>{const active=rnd()>.5;const di=active?Math.round(rnd()*rnd()*w*15*growth):0;const dc=Math.round(di*(2.4+rnd()*3.6)*100)/100;const si=di+Math.round(rnd()*rnd()*60*growth);const ni=si+Math.round(rnd()*rnd()*90*growth);return{...v,nationwiseInstallationAndCapacity:{vendorId:v.vendorId,installationCount:ni,installedCapacity:Math.round(ni*3.1*100)/100},statewiseInstallationAndCapacity:{vendorId:v.vendorId,installationCount:si,installedCapacity:Math.round(si*3.0*100)/100},districtwiseInstallationAndCapacity:{vendorId:v.vendorId,installationCount:di,installedCapacity:dc}};});
  }return out;
}

const pool=makePool(2000);
const now=new Date().toISOString(), weekAgo=new Date(Date.now()-7*864e5).toISOString();
fs.mkdirSync(path.join(__dirname,'..','data'),{recursive:true});
const prevSnap=ingest({capturedAt:weekAgo,state:'TAMIL NADU',source:'demo',districts:makeDistricts(pool,TN,TN_W,1.0)});
ingest({capturedAt:weekAgo,state:'KERALA',source:'demo',districts:makeDistricts(pool,KL,KL_W,1.0),snapshotId:prevSnap.snapshotId});
console.log(`Snapshot #${prevSnap.snapshotId}: TN+KL (week ago)`);
seed=20260803;
const curSnap=ingest({capturedAt:now,state:'TAMIL NADU',source:'demo',districts:makeDistricts(pool,TN,TN_W,1.15)});
ingest({capturedAt:now,state:'KERALA',source:'demo',districts:makeDistricts(pool,KL,KL_W,1.15),snapshotId:curSnap.snapshotId});
console.log(`Snapshot #${curSnap.snapshotId}: TN+KL (now)`);
console.log('Demo data ready. Run: node src/server.js');
