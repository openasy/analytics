import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { channelOf } from "./channels.ts";

type Migration = string | ((db: DatabaseSync) => void);

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones. An entry is SQL, or a function
// for what SQL cannot work out alone; each runs once, in its own transaction.
const MIGRATIONS: Migration[] = [
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
  // Where a visit is and what it runs on, its full referrer and campaign, its channel, whether the visitor came before
  // and whether the visit was engaged (GA4's rule). Visits from before keep null in each but engaged, worked out below.
  `ALTER TABLE sessions ADD COLUMN referrer_url TEXT;
   ALTER TABLE sessions ADD COLUMN utm_term TEXT;
   ALTER TABLE sessions ADD COLUMN utm_content TEXT;
   ALTER TABLE sessions ADD COLUMN browser_version TEXT;
   ALTER TABLE sessions ADD COLUMN os_version TEXT;
   ALTER TABLE sessions ADD COLUMN language TEXT;
   ALTER TABLE sessions ADD COLUMN timezone TEXT;
   ALTER TABLE sessions ADD COLUMN screen TEXT;
   ALTER TABLE sessions ADD COLUMN country TEXT;
   ALTER TABLE sessions ADD COLUMN region TEXT;
   ALTER TABLE sessions ADD COLUMN city TEXT;
   ALTER TABLE sessions ADD COLUMN channel TEXT;
   ALTER TABLE sessions ADD COLUMN paid_click INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN is_returning INTEGER;
   ALTER TABLE sessions ADD COLUMN engaged INTEGER NOT NULL DEFAULT 0;
   UPDATE sessions SET engaged = (pageviews >= 2 OR (julianday(last_at) - julianday(started_at)) * 86400 > 10);
   -- A page's search term and whether it was not found, with the page that linked to it; whether a click left the site
   -- or downloaded a file, came in a burst (rage) or changed nothing (dead); a page's Core Web Vitals, on its leave.
   ALTER TABLE events ADD COLUMN search TEXT;
   ALTER TABLE events ADD COLUMN not_found INTEGER;
   ALTER TABLE events ADD COLUMN ref TEXT;
   ALTER TABLE events ADD COLUMN link TEXT;
   ALTER TABLE events ADD COLUMN rage INTEGER;
   ALTER TABLE events ADD COLUMN dead INTEGER;
   ALTER TABLE events ADD COLUMN lcp INTEGER;
   ALTER TABLE events ADD COLUMN inp INTEGER;
   ALTER TABLE events ADD COLUMN cls REAL;
   -- Reports read one kind of event over a period: page views, leaves or clicks. The index holds what counting pages,
   -- visitors and goals needs, so those read it alone.
   CREATE INDEX events_type ON events (site, type, at, path, visitor, session);
   CREATE INDEX events_search ON events (site, at) WHERE search IS NOT NULL;
   -- Notes on the timeline of a site's reports, such as a launch or a campaign.
   CREATE TABLE annotations (
     id INTEGER PRIMARY KEY,
     site TEXT NOT NULL,
     day TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL,
     created_by TEXT
   );
   CREATE INDEX annotations_day ON annotations (site, day);`,
  // The channel of the visits from before, from what they kept: their referring host and utm_* parameters.
  (db) => {
    const rows = db.prepare("SELECT DISTINCT source, utm_source, utm_medium, utm_campaign FROM sessions WHERE channel IS NULL").all() as Array<
      Record<string, string | null>
    >;
    const set = db.prepare(
      "UPDATE sessions SET channel = ? WHERE channel IS NULL AND source IS ? AND utm_source IS ? AND utm_medium IS ? AND utm_campaign IS ?",
    );
    for (const r of rows)
      set.run(
        channelOf({ source: r.source ?? null, utm: { source: r.utm_source ?? null, medium: r.utm_medium ?? null, campaign: r.utm_campaign ?? null } }),
        r.source ?? null,
        r.utm_source ?? null,
        r.utm_medium ?? null,
        r.utm_campaign ?? null,
      );
  },
  // Ecommerce: an order is kept once by its id, with its products; a refund marks the order. Products carry a SKU,
  // name, category, price and quantity, never who bought them. Site search marks a page that found nothing.
  `ALTER TABLE events ADD COLUMN no_results INTEGER;
   ALTER TABLE events ADD COLUMN amount REAL;
   ALTER TABLE events ADD COLUMN order_id TEXT;
   CREATE TABLE orders (
     site TEXT NOT NULL,
     id TEXT NOT NULL,
     session TEXT NOT NULL,
     visitor TEXT NOT NULL,
     at TEXT NOT NULL,
     value REAL NOT NULL DEFAULT 0,
     items INTEGER NOT NULL DEFAULT 0,
     refunded_at TEXT,
     refunded REAL,
     PRIMARY KEY (site, id)
   ) WITHOUT ROWID;
   CREATE INDEX orders_at ON orders (site, at);
   CREATE INDEX orders_visitor ON orders (site, visitor);
   -- What each ecommerce event did to each product: viewed, added to the cart, checked out, bought or refunded.
   CREATE TABLE items (
     id INTEGER PRIMARY KEY,
     site TEXT NOT NULL,
     session TEXT NOT NULL,
     visitor TEXT NOT NULL,
     at TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund')),
     order_id TEXT,
     sku TEXT NOT NULL,
     name TEXT,
     category TEXT,
     price REAL,
     quantity INTEGER NOT NULL
   );
   CREATE INDEX items_at ON items (site, at, action);
   CREATE INDEX items_visitor ON items (site, visitor);

   -- What the search engines' own tools say about the site, a row a day for each query and page, imported daily.
   CREATE TABLE search_console (
     site TEXT NOT NULL,
     engine TEXT NOT NULL CHECK (engine IN ('google', 'bing', 'yandex')),
     day TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('query', 'page', 'total')),
     query TEXT NOT NULL DEFAULT '',
     page TEXT NOT NULL DEFAULT '',
     clicks INTEGER NOT NULL,
     impressions INTEGER NOT NULL,
     position REAL,
     PRIMARY KEY (site, engine, kind, day, query, page)
   ) WITHOUT ROWID;
   CREATE TABLE search_console_imports (
     site TEXT NOT NULL,
     engine TEXT NOT NULL,
     property TEXT NOT NULL,
     last_day TEXT,
     last_at TEXT,
     error TEXT,
     PRIMARY KEY (site, engine)
   ) WITHOUT ROWID;
   -- Filters saved under a name: an owner's own, or shared with the team.
   CREATE TABLE segments (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     filters TEXT NOT NULL,
     owner TEXT NOT NULL,
     owner_name TEXT,
     shared INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   -- Reports sent by email on a schedule; recipients who stopped them are taken off the list.
   CREATE TABLE email_reports (
     id TEXT PRIMARY KEY,
     site TEXT NOT NULL,
     name TEXT NOT NULL,
     recipients TEXT NOT NULL,
     every TEXT NOT NULL CHECK (every IN ('daily', 'weekly', 'monthly')),
     sections TEXT NOT NULL,
     segment TEXT,
     created_by TEXT,
     created_at TEXT NOT NULL,
     last_period TEXT,
     last_sent_at TEXT,
     last_error TEXT
   );
   -- Read-only links to a site's totals for people without an account. Only the token's hash is kept.
   CREATE TABLE shares (
     id TEXT PRIMARY KEY,
     site TEXT NOT NULL,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     password_hash TEXT,
     sections TEXT NOT NULL,
     expires_at TEXT,
     created_by TEXT,
     created_at TEXT NOT NULL,
     views INTEGER NOT NULL DEFAULT 0,
     last_viewed_at TEXT
   );
   -- Rules that watch a site's visits an hour against the usual, and what they found.
   CREATE TABLE alert_rules (
     id TEXT PRIMARY KEY,
     site TEXT NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('drop', 'spike')),
     ratio REAL NOT NULL,
     recipients TEXT NOT NULL,
     webhook TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_by TEXT,
     created_at TEXT NOT NULL,
     open_alert INTEGER,
     checked_hour TEXT
   );
   CREATE TABLE alerts (
     id INTEGER PRIMARY KEY,
     rule TEXT NOT NULL,
     site TEXT NOT NULL,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     hour TEXT NOT NULL,
     visits INTEGER NOT NULL,
     usual REAL NOT NULL,
     sent TEXT
   );
   CREATE INDEX alerts_site ON alerts (site, started_at DESC);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string, { until = MIGRATIONS.length }: { until?: number } = {}): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Reports keep the visits a filter selects in a temporary table; it stays in memory, as the root filesystem is read-only.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  // `until` is for tests of a migration: the database as an older release left it.
  for (let v = row.v; v < Math.min(until, MIGRATIONS.length); v++) {
    db.exec("BEGIN");
    try {
      const m = MIGRATIONS[v]!;
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
