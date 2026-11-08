// Starts the app on a random port for tests.
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createTcp } from "node:net";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createAnalytics, type AnalyticsOptions } from "./analytics.ts";
import { createApp, type AppOptions } from "./app.ts";
import { parseFile } from "./config.ts";
import { openDb } from "./db.ts";
import { createSharing } from "./sharing.ts";
import { createMailer } from "./smtp.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const SHOP = "https://www.shop.example";
export const SERVER_KEY = "shop-server-key-0123456789";

/** The sites file the tests start with. */
export const SITES = `
smtp: { host: mail.example.test, port: 2525, security: none, user: analytics, from: "Analytics <analytics@example.test>", timeZone: Europe/Istanbul }
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
    funnels:
      - name: Trial
        steps:
          - { name: Pricing, path: /pricing }
          - { name: Sign-up form, path: /signup }
          - { name: Signed up, event: signup }
    forms: true
    replays: { sample: 10%, keep: 30d }
    currency: TRY
    ecommerce: true
    searchConsole: { google: "sc-domain:shop.example", bing: "https://www.shop.example/" }
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

export interface CaughtMail {
  from: string;
  to: string[];
  data: string;
}

/** A mail server that keeps what it is sent, for tests: no mail leaves the machine. */
export function startSmtpSink(): Promise<{ port: number; messages: CaughtMail[]; close: () => Promise<void> }> {
  const messages: CaughtMail[] = [];
  const server = createTcp((socket) => {
    let from = "";
    let to: string[] = [];
    let inData = false;
    let data = "";
    let buffer = "";
    socket.setEncoding("utf8");
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ from, to, data });
            ((from = ""), (to = []), (data = ""));
            socket.write("250 OK queued\r\n");
          } else data += line.replace(/^\.\./, ".") + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250-sink.test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd === "AUTH") socket.write("235 OK\r\n");
        else if (cmd === "MAIL") ((from = /<(.*)>/.exec(line)?.[1] ?? ""), socket.write("250 OK\r\n"));
        else if (cmd === "RCPT") (to.push(/<(.*)>/.exec(line)?.[1] ?? ""), socket.write("250 OK\r\n"));
        else if (cmd === "DATA") ((inData = true), socket.write("354 End with .\r\n"));
        else if (cmd === "QUIT") (socket.write("221 Bye\r\n"), socket.end());
        else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, messages, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** Mail decoded for a test to read: each base64 part as its text. */
export function readMail(data: string): string {
  return data.replace(/Content-Transfer-Encoding: base64\n\n([A-Za-z0-9+/=\n]+)/g, (_m, b64: string) =>
    Buffer.from(b64.replace(/\n/g, ""), "base64").toString("utf8"),
  );
}

export async function startApp(opts: Partial<AppOptions> & { version: string; sites?: string; analyticsOptions?: AnalyticsOptions; webhook?: typeof fetch }) {
  const db = openDb(":memory:");
  const { analyticsOptions, sites = SITES, webhook, ...rest } = opts;
  const clock = fakeClock();
  const analytics = createAnalytics(db, { env: { SHOP_KEY: SERVER_KEY }, ...analyticsOptions, clock });
  const file = parseFile(sites);
  analytics.setSites(file.sites, file.settings);
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "analytics", productName: "OpenAsy Analytics", origin: base });
  const sink = await startSmtpSink();
  const sharing = createSharing(db, analytics, {
    publicUrl: base,
    clock,
    fetch: webhook,
    mailer: () => {
      const smtp = analytics.smtp();
      return smtp ? createMailer({ ...smtp, host: "127.0.0.1", port: sink.port, security: "none" }, { password: "secret" }) : null;
    },
  });
  handler = createApp({
    db,
    analytics,
    auth,
    adminToken: ADMIN_TOKEN,
    publicUrl: base,
    tracker: "var OAT={start:function(){}};",
    replayScript: "/* replay */",
    heatmapScript: "/* heatmap */",
    sharing,
    ...rest,
  });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  /** Sends a batch the way the script on a page does: text/plain, from the page's origin. */
  const collect = (body: unknown, { origin = SHOP, ua = CHROME, headers = {} as Record<string, string> } = {}) =>
    fetch(`${base}/api/v1/collect`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": ua, ...(origin && { origin }), ...headers },
    });
  /** Sends a chunk of a replay the way replay.js does: gzipped, as text/plain, with the visit's ids in the query. */
  const replay = (id: { visitor: string; session: string }, seq: number, events: unknown[], { origin = SHOP, site = "shop", ua = CHROME } = {}) =>
    fetch(`${base}/api/v1/replay?${new URLSearchParams({ site, visitor: id.visitor, session: id.session, seq: String(seq) })}`, {
      method: "POST",
      body: gzipSync(JSON.stringify(events)),
      headers: { "content-type": "text/plain", "user-agent": ua, ...(origin && { origin }) },
    });
  const close = async () => {
    await sink.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { db, analytics, sharing, sink, auth, base, admin, collect, replay, clock, close };
}
