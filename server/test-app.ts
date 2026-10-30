// Starts the app on a random port for tests.
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createAnalytics, type AnalyticsOptions } from "./analytics.ts";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const SHOP = "https://www.shop.example";
export const SERVER_KEY = "shop-server-key-0123456789";

/** The sites file the tests start with. */
export const SITES = `
sites:
  - name: shop
    domains: [${SHOP}, https://shop.example]
    query: [q]
    ignore: [/admin/*]
    rateLimit: 200
    serverKey: SHOP_KEY
    goals:
      - { name: Bought, path: /checkout/done }
      - { name: Signed up, event: signup }
  - name: blog
    domains: [https://blog.example]
    consent: required
`;

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse("2026-10-22T12:00:00Z")) {
  let t = start;
  const clock = Object.assign(() => t, { advance: (ms: number) => void (t += ms) });
  return clock;
}

export const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export async function startApp(opts: Partial<AppOptions> & { version: string; sites?: string; analyticsOptions?: AnalyticsOptions }) {
  const db = openDb(":memory:");
  const { analyticsOptions, sites = SITES, ...rest } = opts;
  const clock = fakeClock();
  const analytics = createAnalytics(db, { env: { SHOP_KEY: SERVER_KEY }, ...analyticsOptions, clock });
  analytics.setSites(parseConfig(sites));
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "analytics", productName: "OpenAsy Analytics", origin: base });
  handler = createApp({ db, analytics, auth, adminToken: ADMIN_TOKEN, publicUrl: base, tracker: "var OAT={start:function(){}};", ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  /** Sends a batch the way the script on a page does: text/plain, from the page's origin. */
  const collect = (body: unknown, { origin = SHOP, ua = CHROME, headers = {} as Record<string, string> } = {}) =>
    fetch(`${base}/api/v1/collect`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": ua, ...(origin && { origin }), ...headers },
    });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, analytics, auth, base, admin, collect, clock, close };
}
