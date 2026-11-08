// Ecommerce and attribution: what a shop sold and what brought the visits that bought.
//
// Orders come from openasy.ecommerce("purchase", { order, value, currency, items }) on the page or the same event from
// the shop's servers; each order id is kept once, and a refund marks its order. Products carry a SKU, name, category,
// price and quantity, never who bought them.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Goal, Site } from "./config.ts";
import { goalSql, goalWorthSql, type Scope, type Window } from "./query.ts";

type Row = Record<string, any>;
const round = (n: number | null | undefined) => Math.round((n ?? 0) * 100) / 100;

/** The steps of the purchase funnel, by GA4's event names. */
export const SHOP_STEPS = ["view_item", "add_to_cart", "begin_checkout", "purchase"] as const;

export function commerceOf(db: DatabaseSync, site: Site, w: Window, sc: Scope) {
  const all = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as Row[];
  const o = sc.events("o");
  const t = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(value), 0) AS revenue, COALESCE(SUM(items), 0) AS units, COUNT(DISTINCT session) AS visits,
         COUNT(refunded_at) AS refunds, COALESCE(SUM(refunded), 0) AS refunded
       FROM orders o WHERE ${o.sql}`,
    )
    .get(...o.args) as Row;
  const visits = (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${sc.sessions.sql}`).get(...sc.sessions.args) as Row).n as number;
  const days = new Map(
    all(`SELECT substr(at, 1, 10) AS day, COUNT(*) AS orders, SUM(value) AS revenue FROM orders o WHERE ${o.sql} GROUP BY day`, ...o.args).map((r) => [
      r.day as string,
      r,
    ]),
  );

  // The purchase funnel: visits that took each step having taken the ones before it, in order.
  const e = sc.events();
  const reached = SHOP_STEPS.map(() => 0);
  let current = "";
  let step = 0;
  for (const r of db
    .prepare(
      `SELECT session, name FROM events WHERE ${e.sql} AND type = 'event' AND name IN ('view_item', 'add_to_cart', 'begin_checkout', 'purchase') ORDER BY session, at, id`,
    )
    .iterate(...e.args) as Iterable<Row>) {
    if (r.session !== current) ((current = r.session as string), (step = 0));
    if (step < SHOP_STEPS.length && r.name === SHOP_STEPS[step]) reached[step++]!++;
  }

  const i = sc.events("i");
  const products = all(
    `SELECT sku, MAX(name) AS name, MAX(category) AS category,
       SUM(CASE WHEN action = 'view_item' THEN 1 ELSE 0 END) AS views,
       SUM(CASE WHEN action = 'add_to_cart' THEN 1 ELSE 0 END) AS carts,
       SUM(CASE WHEN action = 'purchase' THEN quantity ELSE 0 END) AS units,
       SUM(CASE WHEN action = 'purchase' THEN COALESCE(price, 0) * quantity ELSE 0 END) AS revenue,
       SUM(CASE WHEN action = 'refund' THEN quantity ELSE 0 END) AS refunded
     FROM items i WHERE ${i.sql} GROUP BY sku ORDER BY revenue DESC, views DESC, sku LIMIT 200`,
    ...i.args,
  ).map((r) => ({
    sku: r.sku as string,
    name: (r.name as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    views: r.views as number,
    carts: r.carts as number,
    units: r.units as number,
    revenue: round(r.revenue),
    refunded: r.refunded as number,
  }));

  /** Revenue by a column of the visit that bought (last touch), beside that value's visits. */
  const by = (column: string) => {
    const sold = new Map(
      all(
        `SELECT ${column} AS value, COUNT(*) AS orders, SUM(o.value) AS revenue FROM orders o JOIN sessions s ON s.site = o.site AND s.id = o.session
         WHERE ${o.sql} GROUP BY 1`,
        ...o.args,
      ).map((r) => [r.value as string | null, r]),
    );
    return all(
      `SELECT ${column} AS value, COUNT(*) AS visits FROM sessions s WHERE ${sc.sessions.sql} GROUP BY 1 ORDER BY visits DESC LIMIT 500`,
      ...sc.sessions.args,
    )
      .map((r) => {
        const x = sold.get((r.value as string | null) ?? null);
        return {
          value: (r.value as string | null) ?? null,
          visits: r.visits as number,
          orders: (x?.orders as number) ?? 0,
          revenue: round(x?.revenue as number),
        };
      })
      .sort((a, b) => b.revenue - a.revenue || b.visits - a.visits)
      .slice(0, 50);
  };

  return {
    enabled: site.ecommerce,
    currency: site.currency,
    totals: {
      revenue: round(t.revenue),
      orders: t.orders as number,
      averageOrder: t.orders ? round((t.revenue as number) / (t.orders as number)) : 0,
      units: t.units as number,
      /** Visits that bought, and their share of all visits. */
      buyingVisits: t.visits as number,
      conversionRate: visits ? (t.visits as number) / visits : 0,
      visits,
      refunds: t.refunds as number,
      refunded: round(t.refunded),
    },
    series: w.days.map((day) => ({ day, orders: (days.get(day)?.orders as number) ?? 0, revenue: round(days.get(day)?.revenue as number) })),
    funnel: SHOP_STEPS.map((name, n) => ({ event: name, visits: reached[n]! })),
    products,
    sources: by("s.source").map(({ value, ...r }) => ({ source: value, ...r })),
    campaigns: by("s.utm_campaign").map(({ value, ...r }) => ({ campaign: value, ...r })),
    channels: by("s.channel").map(({ value, ...r }) => ({ channel: value, ...r })),
  };
}

export const MODELS = ["first", "last", "linear"] as const;
export const ATTRIBUTE_BY = { channel: "channel", source: "source", campaign: "utm_campaign" } as const;
export type AttributeBy = keyof typeof ATTRIBUTE_BY;

/**
 * Credit for a goal's conversions in the period, given to where the converting visitor's visits came from over the
 * lookback before it: all to the first visit (first touch), all to the converting visit (last touch), or shared evenly
 * among them (linear). Visits are a visitor's own by the id the script keeps, so only kept visits count.
 */
export function attributionOf(db: DatabaseSync, site: Site, sc: Scope, goal: Goal, lookback: number, by: AttributeBy) {
  const g = goalSql(goal);
  const worth = goalWorthSql(goal);
  const e = sc.events();
  const conversions = db
    .prepare(
      `SELECT session, MIN(at) AS at${worth && "prop" in goal.value! ? `, SUM(CASE WHEN ${g.sql} THEN ${worth.sql} END) AS worth` : ""}
       FROM events WHERE ${e.sql} AND type IN ('pageview', 'event', 'click') AND ${g.sql} GROUP BY session`,
    )
    .all(...(worth && "prop" in goal.value! ? [...g.args, ...worth.args] : []), ...e.args, ...g.args) as Row[];
  const column = ATTRIBUTE_BY[by];
  const credit = new Map<string | null, Record<"first" | "last" | "linear" | "firstValue" | "lastValue" | "linearValue", number>>();
  const touches: number[] = [];
  if (conversions.length) {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS attribution_sessions (id TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM attribution_sessions;");
    try {
      const add = db.prepare("INSERT OR IGNORE INTO attribution_sessions (id) VALUES (?)");
      for (const c of conversions) add.run(c.session as string);
      const converted = new Map(
        (db.prepare(`SELECT id, visitor, started_at FROM sessions WHERE site = ? AND id IN (SELECT id FROM attribution_sessions)`).all(site.name) as Row[]).map(
          (r) => [r.id as string, r],
        ),
      );
      const earliest = Math.min(...[...converted.values()].map((r) => Date.parse(r.started_at as string))) - lookback * 86_400_000;
      const visits = new Map<string, Array<{ at: number; value: string | null }>>();
      for (const r of db
        .prepare(
          `SELECT visitor, started_at, ${column} AS value FROM sessions WHERE site = ? AND started_at >= ?
             AND visitor IN (SELECT visitor FROM sessions WHERE site = ? AND id IN (SELECT id FROM attribution_sessions)) ORDER BY visitor, started_at`,
        )
        .iterate(site.name, new Date(earliest).toISOString(), site.name) as Iterable<Row>) {
        const list = visits.get(r.visitor as string) ?? [];
        list.push({ at: Date.parse(r.started_at as string), value: (r.value as string | null) ?? null });
        visits.set(r.visitor as string, list);
      }
      const bucket = (k: string | null) => {
        let b = credit.get(k);
        if (!b) credit.set(k, (b = { first: 0, last: 0, linear: 0, firstValue: 0, lastValue: 0, linearValue: 0 }));
        return b;
      };
      for (const c of conversions) {
        const s = converted.get(c.session as string);
        if (!s) continue;
        const at = Date.parse(s.started_at as string);
        const path = (visits.get(s.visitor as string) ?? []).filter((v) => v.at <= at && v.at >= at - lookback * 86_400_000);
        if (!path.length) continue;
        const value = !goal.value ? 0 : "amount" in goal.value ? goal.value.amount : ((c.worth as number | null) ?? 0);
        touches.push(path.length);
        const first = bucket(path[0]!.value);
        first.first++;
        first.firstValue += value;
        const last = bucket(path.at(-1)!.value);
        last.last++;
        last.lastValue += value;
        for (const v of path) {
          const b = bucket(v.value);
          b.linear += 1 / path.length;
          b.linearValue += value / path.length;
        }
      }
    } finally {
      db.exec("DELETE FROM attribution_sessions");
    }
  }
  touches.sort((a, b) => a - b);
  const rows = [...credit]
    .map(([value, b]) => ({
      value,
      first: b.first,
      last: b.last,
      linear: Math.round(b.linear * 100) / 100,
      ...(goal.value ? { firstValue: round(b.firstValue), lastValue: round(b.lastValue), linearValue: round(b.linearValue) } : {}),
    }))
    .sort((a, b) => b.last - a.last || b.first - a.first || String(a.value).localeCompare(String(b.value)));
  return {
    goal: goal.name,
    by,
    lookback,
    currency: site.currency,
    hasValue: !!goal.value,
    conversions: touches.length,
    /** The median of the visits each conversion had in its lookback, the converting one included. */
    medianVisits: touches.length ? touches[(touches.length - 1) >> 1]! : null,
    rows: rows.map((r) => ({ firstValue: null, lastValue: null, linearValue: null, ...r })),
  };
}
