-- PM Surya Ghar — India Rooftop Solar Vendor Registry
-- Multi-state schema: add any state by running a new harvest — no schema change.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS snapshot (
  snapshot_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at      TEXT    NOT NULL,
  source           TEXT    NOT NULL DEFAULT 'portal',   -- 'portal' | 'demo'
  notes            TEXT
);

-- Each harvest run covers one state; one snapshot can contain many state_harvests.
CREATE TABLE IF NOT EXISTS state_harvest (
  harvest_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id      INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  state            TEXT    NOT NULL,                    -- 'TAMIL NADU', 'KERALA', …
  districts_ok     INTEGER NOT NULL DEFAULT 0,
  districts_failed INTEGER NOT NULL DEFAULT 0,
  harvested_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_snap_state ON state_harvest(snapshot_id, state);

CREATE TABLE IF NOT EXISTS state (
  state_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,   -- portal spelling, e.g. 'TAMIL NADU'
  display     TEXT    NOT NULL           -- 'Tamil Nadu'
);

CREATE TABLE IF NOT EXISTS district (
  district_id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_id    INTEGER NOT NULL REFERENCES state(state_id),
  name        TEXT    NOT NULL,          -- portal spelling
  display     TEXT    NOT NULL,          -- title-cased
  UNIQUE(state_id, name)
);
CREATE INDEX IF NOT EXISTS ix_dist_state ON district(state_id);

CREATE TABLE IF NOT EXISTS vendor (
  vendor_id      INTEGER PRIMARY KEY,   -- portal vendorId (global, stable)
  row_id         INTEGER,
  name           TEXT    NOT NULL,
  previous_name  TEXT,
  contact_name   TEXT,
  contact_email  TEXT,
  contact_phone  TEXT,
  address        TEXT,
  website_url    TEXT,
  rating         REAL,
  rating_count   INTEGER DEFAULT 0,
  brands         TEXT,
  nat_installs   INTEGER DEFAULT 0,
  nat_capacity   REAL    DEFAULT 0,
  state_installs INTEGER DEFAULT 0,
  state_capacity REAL    DEFAULT 0,
  first_seen     TEXT,
  last_seen      TEXT
);
CREATE INDEX IF NOT EXISTS ix_vendor_name ON vendor(name);

-- Fact table: per (snapshot, district, vendor) performance
CREATE TABLE IF NOT EXISTS vendor_district (
  snapshot_id  INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  district_id  INTEGER NOT NULL REFERENCES district(district_id),
  vendor_id    INTEGER NOT NULL REFERENCES vendor(vendor_id),
  installs     INTEGER NOT NULL DEFAULT 0,
  capacity     REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, district_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS ix_vd_snap_dist ON vendor_district(snapshot_id, district_id);
CREATE INDEX IF NOT EXISTS ix_vd_snap_vend ON vendor_district(snapshot_id, vendor_id);

-- Per-district rollup
CREATE VIEW IF NOT EXISTS v_district_stats AS
SELECT
  vd.snapshot_id,
  d.district_id,  d.name AS district,  d.display AS district_label,
  s.state_id,     s.name AS state,     s.display AS state_label,
  COUNT(*)                                            AS vendor_count,
  SUM(vd.installs)                                    AS installs,
  ROUND(SUM(vd.capacity),3)                           AS capacity_kw,
  SUM(CASE WHEN vd.installs>0 THEN 1 ELSE 0 END)     AS active_vendors,
  ROUND(AVG(NULLIF(v.rating,0)),2)                    AS avg_rating,
  MAX(vd.installs)                                    AS top_vendor_installs
FROM vendor_district vd
JOIN district d  ON d.district_id = vd.district_id
JOIN state    s  ON s.state_id    = d.state_id
JOIN vendor   v  ON v.vendor_id   = vd.vendor_id
GROUP BY vd.snapshot_id, d.district_id;

-- Per-state rollup
CREATE VIEW IF NOT EXISTS v_state_stats AS
SELECT
  vd.snapshot_id,
  s.state_id,  s.name AS state,  s.display AS state_label,
  COUNT(DISTINCT vd.vendor_id)        AS unique_vendors,
  COUNT(DISTINCT d.district_id)       AS districts,
  SUM(vd.installs)                    AS installs,
  ROUND(SUM(vd.capacity),3)           AS capacity_kw,
  SUM(CASE WHEN vd.installs>0 THEN 1 ELSE 0 END) AS active_slots
FROM vendor_district vd
JOIN district d ON d.district_id = vd.district_id
JOIN state    s ON s.state_id    = d.state_id
GROUP BY vd.snapshot_id, s.state_id;

-- National rollup
CREATE VIEW IF NOT EXISTS v_india_stats AS
SELECT
  snapshot_id,
  COUNT(DISTINCT vendor_id)      AS unique_vendors,
  COUNT(DISTINCT district_id)    AS districts,
  SUM(installs)                  AS installs,
  ROUND(SUM(capacity),3)         AS capacity_kw
FROM vendor_district
GROUP BY snapshot_id;
