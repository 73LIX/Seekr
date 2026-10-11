'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('organizer','participant')),
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby','running','ended')),
  settings TEXT NOT NULL DEFAULT '{}',
  winner_team_id INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX events_org ON events(organizer_id);

CREATE TABLE stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  riddle_text TEXT NOT NULL DEFAULT '',
  answers TEXT NOT NULL DEFAULT '[]',
  hints TEXT NOT NULL DEFAULT '[]',
  lat REAL,
  lng REAL,
  location_name TEXT NOT NULL DEFAULT '',
  verify_type TEXT NOT NULL DEFAULT 'qr' CHECK (verify_type IN ('qr','photo','either')),
  object_description TEXT NOT NULL DEFAULT '',
  geofence_m INTEGER NOT NULL DEFAULT 0,
  match_threshold INTEGER,
  review_min INTEGER,
  allow_review INTEGER NOT NULL DEFAULT 1,
  qr_token TEXT NOT NULL,
  riddle_image TEXT,
  target_image TEXT,
  success_message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX stages_event ON stages(event_id, position);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  code TEXT NOT NULL UNIQUE,
  leader_id INTEGER NOT NULL,
  stage_pos INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'riddle' CHECK (phase IN ('riddle','unlocked','done')),
  hints_used INTEGER NOT NULL DEFAULT 0,
  wrong_answers INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  progress_at INTEGER,
  last_lat REAL,
  last_lng REAL,
  last_acc REAL,
  last_seen INTEGER,
  UNIQUE (event_id, name)
);

CREATE TABLE event_members (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_members_user ON event_members(user_id);

CREATE TABLE team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id),
  UNIQUE (event_id, user_id)
);

CREATE TABLE hints_issued (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL,
  level INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX hints_team ON hints_issued(team_id, stage_id);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  score INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  image_file TEXT,
  image_sha TEXT,
  dhash TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by INTEGER
);
CREATE INDEX submissions_team ON submissions(team_id, stage_id);
CREATE INDEX submissions_sha ON submissions(stage_id, image_sha);
CREATE INDEX submissions_status ON submissions(event_id, status);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id INTEGER,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX activity_event ON activity(event_id, id);
`;

function migrate(db) {
  const { user_version: v } = db.prepare('PRAGMA user_version').get();
  if (v === 0) {
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else if (v > SCHEMA_VERSION) {
    throw new Error(`Database schema v${v} is newer than this app (v${SCHEMA_VERSION})`);
  }
}

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  migrate(raw);

  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  return {
    raw,
    get: (sql, ...p) => prep(sql).get(...p),
    all: (sql, ...p) => prep(sql).all(...p),
    run: (sql, ...p) => prep(sql).run(...p),
    /** run fn inside a write transaction (re-entrant) */
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      } finally {
        depth--;
      }
    },
    close() {
      cache.clear();
      raw.close();
    },
  };
}

module.exports = { openDb, SCHEMA_VERSION };
