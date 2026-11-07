import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- One visit: what a visitor did from arriving until 30 minutes without activity. Sites are named, as in the file.
   CREATE TABLE sessions (
     site TEXT NOT NULL,
     id TEXT NOT NULL,
     visitor TEXT NOT NULL,
     user_id TEXT,
     started_at TEXT NOT NULL,
     last_at TEXT NOT NULL,
     entry_path TEXT,
     exit_path TEXT,
     pageviews INTEGER NOT NULL DEFAULT 0,
     events INTEGER NOT NULL DEFAULT 0,
     source TEXT,
     referrer TEXT,
     utm_source TEXT,
     utm_medium TEXT,
     utm_campaign TEXT,
     browser TEXT NOT NULL,
     os TEXT NOT NULL,
     device TEXT NOT NULL,
     PRIMARY KEY (site, id)
   );
   CREATE INDEX sessions_started ON sessions (site, started_at);
   CREATE INDEX sessions_last ON sessions (site, last_at DESC);
   CREATE INDEX sessions_visitor ON sessions (site, visitor);
   CREATE INDEX sessions_user ON sessions (site, user_id) WHERE user_id IS NOT NULL;
   -- Everything a visit sent, in order: page views, the time and scroll of each page, clicks and the site's own events.
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     site TEXT NOT NULL,
     session TEXT NOT NULL,
     visitor TEXT NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('pageview', 'leave', 'click', 'event')),
     path TEXT,
     query TEXT,
     title TEXT,
     target TEXT,
     text TEXT,
     href TEXT,
     name TEXT,
     props TEXT,
     duration INTEGER,
     scroll INTEGER
   );
   CREATE INDEX events_at ON events (site, at);
   CREATE INDEX events_session ON events (site, session, at);
   CREATE INDEX events_visitor ON events (site, visitor);
   -- Who was seen on a day, only to count each visitor once a day. Kept as long as events.
   CREATE TABLE visitor_days (site TEXT NOT NULL, day TEXT NOT NULL, visitor TEXT NOT NULL, PRIMARY KEY (site, day, visitor)) WITHOUT ROWID;
   -- Totals of each day (UTC), counted as events arrive, kept longer than the events themselves.
   CREATE TABLE days (
     site TEXT NOT NULL,
     day TEXT NOT NULL,
     visitors INTEGER NOT NULL DEFAULT 0,
     visits INTEGER NOT NULL DEFAULT 0,
     pageviews INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (site, day)
   )`,
  // Form fields entered and left (their names and kinds, never their values), where in an element a click landed, and
  // session replays. SQLite cannot change a CHECK, so events is made again with the form type.
  `CREATE TABLE events_v2 (
     id INTEGER PRIMARY KEY,
     site TEXT NOT NULL,
     session TEXT NOT NULL,
     visitor TEXT NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('pageview', 'leave', 'click', 'event', 'form')),
     path TEXT,
     query TEXT,
     title TEXT,
     target TEXT,
     text TEXT,
     href TEXT,
     name TEXT,
     props TEXT,
     duration INTEGER,
     scroll INTEGER,
     x INTEGER,
     y INTEGER,
     form TEXT,
     field TEXT,
     kind TEXT,
     action TEXT CHECK (action IN ('start', 'leave', 'submit', 'abandon')),
     filled INTEGER,
     again INTEGER
   );
   INSERT INTO events_v2 (id, site, session, visitor, at, type, path, query, title, target, text, href, name, props, duration, scroll)
     SELECT id, site, session, visitor, at, type, path, query, title, target, text, href, name, props, duration, scroll FROM events;
   DROP TABLE events;
   ALTER TABLE events_v2 RENAME TO events;
   CREATE INDEX events_at ON events (site, at);
   CREATE INDEX events_session ON events (site, session, at);
   CREATE INDEX events_visitor ON events (site, visitor);
   CREATE INDEX events_forms ON events (site, form, at) WHERE type = 'form';
   -- A replay is the visit's rrweb events in the order they came, gzipped as the page sent them.
   CREATE TABLE replay_chunks (
     site TEXT NOT NULL,
     session TEXT NOT NULL,
     visitor TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     size INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (site, session, seq)
   );
   CREATE INDEX replay_chunks_at ON replay_chunks (site, at);
   CREATE INDEX replay_chunks_visitor ON replay_chunks (site, visitor);
   ALTER TABLE sessions ADD COLUMN replay INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN rage INTEGER NOT NULL DEFAULT 0;`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
