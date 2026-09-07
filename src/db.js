'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ROOT    = path.join(__dirname, '..');
const DB_PATH = process.env.PMSG_DB || path.join(ROOT, 'data', 'pmsg.db');
const SCHEMA  = path.join(ROOT, 'db', 'schema.sql');

const titleCase = s => String(s).toLowerCase()
  .replace(/\b([a-z])/g, (_, c) => c.toUpperCase());

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  return db;
}

/* ───────────────────────── ingest ───────────────────────── */
/**
 * Load one state's harvest into the database.
 * Can be called multiple times (for different states) sharing the same snapshotId.
 *
 * @param {object} p
 *   capturedAt  - ISO timestamp
 *   state       - 'TAMIL NADU' | 'KERALA' | …
 *   source      - 'portal' | 'demo'
 *   districts   - { [districtName]: rawVendorArray }
 *   failed      - string[]
 *   snapshotId  - number | null  (null = create new snapshot)
 * @returns { snapshotId, harvestId, vendors, rows, districts }
 */
function ingest(p) {
  const { capturedAt, state, source = 'portal',
          districts = {}, failed = [], snapshotId: existingSnap = null } = p;
  const dnames = Object.keys(districts);
  const db = open();

  const insSnap     = db.prepare(`INSERT INTO snapshot (captured_at, source) VALUES (?,?)`);
  const insHarvest  = db.prepare(`INSERT INTO state_harvest (snapshot_id, state, districts_ok, districts_failed, harvested_at) VALUES (?,?,?,?,?)
    ON CONFLICT(snapshot_id, state) DO UPDATE SET districts_ok=excluded.districts_ok, districts_failed=excluded.districts_failed, harvested_at=excluded.harvested_at`);
  const insState    = db.prepare(`INSERT INTO state (name, display) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET display=excluded.display`);
  const getState    = db.prepare(`SELECT state_id FROM state WHERE name=?`);
  const insDist     = db.prepare(`INSERT INTO district (state_id, name, display) VALUES (?,?,?) ON CONFLICT(state_id, name) DO UPDATE SET display=excluded.display`);
  const getDist     = db.prepare(`SELECT district_id FROM district WHERE state_id=? AND name=?`);
  const upsVendor   = db.prepare(`
    INSERT INTO vendor (vendor_id,row_id,name,previous_name,contact_name,contact_email,
                        contact_phone,address,website_url,rating,rating_count,brands,
                        nat_installs,nat_capacity,state_installs,state_capacity,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(vendor_id) DO UPDATE SET
      name=excluded.name, previous_name=COALESCE(excluded.previous_name,vendor.previous_name),
      contact_name=COALESCE(excluded.contact_name,vendor.contact_name),
      contact_email=COALESCE(excluded.contact_email,vendor.contact_email),
      contact_phone=COALESCE(excluded.contact_phone,vendor.contact_phone),
      address=COALESCE(excluded.address,vendor.address),
      website_url=COALESCE(excluded.website_url,vendor.website_url),
      rating=excluded.rating, rating_count=excluded.rating_count, brands=excluded.brands,
      nat_installs=excluded.nat_installs, nat_capacity=excluded.nat_capacity,
      state_installs=excluded.state_installs, state_capacity=excluded.state_capacity,
      last_seen=excluded.last_seen`);
  const insVD = db.prepare(`
    INSERT INTO vendor_district (snapshot_id,district_id,vendor_id,installs,capacity)
    VALUES (?,?,?,?,?)
    ON CONFLICT(snapshot_id,district_id,vendor_id) DO UPDATE SET installs=excluded.installs,capacity=excluded.capacity`);

  db.exec('BEGIN');
  let snapId, harvestId, vendorsSeen = new Set(), rows = 0;
  try {
    snapId = existingSnap ?? Number(insSnap.run(capturedAt, source).lastInsertRowid);
    harvestId = Number(insHarvest.run(snapId, state, dnames.length, failed.length, capturedAt).lastInsertRowid);

    insState.run(state, titleCase(state));
    const stateId = getState.get(state).state_id;

    for (const dname of dnames) {
      insDist.run(stateId, dname, titleCase(dname));
      const districtId = getDist.get(stateId, dname).district_id;

      for (const v of districts[dname]) {
        const nat = v.nationwiseInstallationAndCapacity  || {};
        const st  = v.statewiseInstallationAndCapacity   || {};
        const di  = v.districtwiseInstallationAndCapacity|| {};
        const brands = (v.vendorBrandsList||[]).map(b=>b.brandName||b.brand||b.name||'').filter(Boolean).join('|');

        upsVendor.run(v.vendorId, v.id??null, v.vendorName??'(unnamed)', v.previousVendorName??null,
          v.contactPersonName??null, v.contactPersonEmail??null, v.contactPersonMobile??null,
          v.address??null, v.websiteUrl||null, v.rating??null, v.consumerRatingCount??0, brands,
          nat.installationCount??0, nat.installedCapacity??0,
          st.installationCount??0,  st.installedCapacity??0,
          capturedAt, capturedAt);
        vendorsSeen.add(v.vendorId);
        insVD.run(snapId, districtId, v.vendorId, di.installationCount??0, di.installedCapacity??0);
        rows++;
      }
    }
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); db.close(); throw e; }
  db.close();
  return { snapshotId: snapId, harvestId, vendors: vendorsSeen.size, rows, districts: dnames.length };
}

/* ───────────────────────── queries ───────────────────────── */
const q = {
  latestId: db => (db.prepare(`SELECT MAX(snapshot_id) AS id FROM snapshot`).get()||{}).id ?? null,

  snapshots: db => db.prepare(`
    SELECT s.snapshot_id, s.captured_at, s.source,
           GROUP_CONCAT(sh.state,' | ') AS states,
           SUM(sh.districts_ok) AS districts_ok,
           i.installs, i.capacity_kw, i.unique_vendors
    FROM snapshot s
    JOIN state_harvest sh ON sh.snapshot_id=s.snapshot_id
    LEFT JOIN v_india_stats i ON i.snapshot_id=s.snapshot_id
    GROUP BY s.snapshot_id ORDER BY s.snapshot_id DESC`).all(),

  // Which states are in a given snapshot
  states: (db, id) => db.prepare(`
    SELECT s.state_id, s.name, s.display,
           vs.districts, vs.installs, vs.capacity_kw, vs.unique_vendors, vs.active_slots
    FROM v_state_stats vs JOIN state s ON s.state_id=vs.state_id
    WHERE vs.snapshot_id=? ORDER BY vs.installs DESC`).all(id),

  indiaStats: (db, id) => db.prepare(`SELECT * FROM v_india_stats WHERE snapshot_id=?`).get(id)||null,

  districts: (db, id, stateName=null) => {
    const base = `SELECT * FROM v_district_stats WHERE snapshot_id=?`;
    const rows = stateName
      ? db.prepare(base + ` AND state=? ORDER BY installs DESC`).all(id, stateName)
      : db.prepare(base + ` ORDER BY state ASC, installs DESC`).all(id);
    return rows;
  },

  districtVendors: (db, id, districtName, stateName, limit=300) => db.prepare(`
    SELECT v.vendor_id, v.name, v.contact_name, v.contact_phone, v.contact_email,
           v.address, v.website_url, v.rating, v.rating_count, v.brands,
           vd.installs, vd.capacity, v.state_installs, v.nat_installs
    FROM vendor_district vd
    JOIN vendor v ON v.vendor_id=vd.vendor_id
    JOIN district d ON d.district_id=vd.district_id
    JOIN state st ON st.state_id=d.state_id
    WHERE vd.snapshot_id=? AND d.name=? AND st.name=?
    ORDER BY vd.installs DESC, v.name ASC LIMIT ?`).all(id, districtName, stateName, limit),

  vendor: (db, id, vendorId) => {
    const v = db.prepare(`SELECT * FROM vendor WHERE vendor_id=?`).get(vendorId);
    if (!v) return null;
    v.coverage = db.prepare(`
      SELECT st.name AS state, st.display AS state_label,
             d.name AS district, d.display AS label,
             vd.installs, vd.capacity
      FROM vendor_district vd
      JOIN district d ON d.district_id=vd.district_id
      JOIN state st ON st.state_id=d.state_id
      WHERE vd.snapshot_id=? AND vd.vendor_id=?
      ORDER BY vd.installs DESC`).all(id, vendorId);
    return v;
  },

  topVendors: (db, id, stateName=null, limit=25) => {
    const where = stateName ? `AND st.name=?` : '';
    const args  = stateName ? [id, stateName, limit] : [id, limit];
    return db.prepare(`
      SELECT v.vendor_id, v.name, v.rating, v.rating_count,
             COUNT(DISTINCT d.state_id)    AS states,
             COUNT(DISTINCT vd.district_id) AS districts,
             SUM(vd.installs)               AS installs,
             ROUND(SUM(vd.capacity),3)      AS capacity
      FROM vendor_district vd
      JOIN vendor v ON v.vendor_id=vd.vendor_id
      JOIN district d ON d.district_id=vd.district_id
      JOIN state st ON st.state_id=d.state_id
      WHERE vd.snapshot_id=? ${where}
      GROUP BY v.vendor_id ORDER BY installs DESC LIMIT ?`).all(...args);
  },

  search: (db, id, term, stateName=null, limit=50) => {
    const like = `%${term}%`;
    const where = stateName ? `AND st.name=?` : '';
    const args  = stateName ? [id,like,like,like,stateName,limit] : [id,like,like,like,limit];
    return db.prepare(`
      SELECT v.vendor_id, v.name, v.contact_name, v.contact_phone, v.rating, v.brands,
             COUNT(DISTINCT d.state_id)     AS states,
             COUNT(DISTINCT vd.district_id) AS districts,
             SUM(vd.installs)               AS installs
      FROM vendor_district vd
      JOIN vendor v ON v.vendor_id=vd.vendor_id
      JOIN district d ON d.district_id=vd.district_id
      JOIN state st ON st.state_id=d.state_id
      WHERE vd.snapshot_id=? AND (v.name LIKE ? OR v.contact_name LIKE ? OR v.brands LIKE ?) ${where}
      GROUP BY v.vendor_id ORDER BY installs DESC LIMIT ?`).all(...args);
  },

  compare: (db, curId, prevId, stateName=null) => {
    const where = stateName ? `AND c.state=?` : '';
    const args  = stateName ? [prevId??-1, curId, stateName] : [prevId??-1, curId];
    return db.prepare(`
      SELECT c.state, c.state_label, c.district, c.district_label,
             c.vendor_count AS vendors, c.installs, c.capacity_kw AS capacity,
             c.active_vendors,
             COALESCE(p.vendor_count,0) AS prev_vendors,
             COALESCE(p.installs,0)     AS prev_installs,
             COALESCE(p.capacity_kw,0)  AS prev_capacity,
             (c.vendor_count - COALESCE(p.vendor_count,0)) AS d_vendors,
             (c.installs     - COALESCE(p.installs,0))     AS d_installs,
             ROUND(c.capacity_kw - COALESCE(p.capacity_kw,0),3) AS d_capacity
      FROM v_district_stats c
      LEFT JOIN v_district_stats p
        ON p.district_id=c.district_id AND p.snapshot_id=?
      WHERE c.snapshot_id=? ${where}
      ORDER BY c.state ASC, c.installs DESC`).all(...args);
  }
};

module.exports = { open, ingest, q, titleCase, DB_PATH };
