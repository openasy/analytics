import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createAnalytics } from "./analytics.ts";
import { createApp, createMetricsHandler } from "./app.ts";
import { watchConfig, type FileSettings } from "./config.ts";
import { openDb } from "./db.ts";
import { createGeo, geoSettings, parseProxies } from "./geo.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { engines, searchImporter } from "./searchconsole.ts";
import { createSharing } from "./sharing.ts";
import { createMailer, type Mailer } from "./smtp.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.ANALYTICS_DB ?? "/data/analytics.db";
const configPath = process.env.ANALYTICS_CONFIG?.trim() || "/config/analytics.yaml";
const defaultRate = Number(process.env.ANALYTICS_RATE_LIMIT ?? 6000);
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const trackerFile = new URL("../dist/tracker/a.js", import.meta.url).pathname;
const scriptFile = (name: string) => {
  const file = new URL(`../dist/tracker/${name}.js`, import.meta.url).pathname;
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.ANALYTICS_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.ANALYTICS_METRICS_PORT ? Number(process.env.ANALYTICS_METRICS_PORT) : undefined;

if (!Number.isInteger(defaultRate) || defaultRate < 1) throw new Error("ANALYTICS_RATE_LIMIT must be events per minute, 1 or more");

const db = openDb(dbPath);
// The address people open analytics at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects and the
// script on the sites use it.
const publicUrl = (process.env.ANALYTICS_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.ANALYTICS_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "analytics",
  productName: "OpenAsy Analytics",
  origin: publicUrl,
  // Locally the same analytics is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.ANALYTICS_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "ANALYTICS_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
// Places from IP addresses: DB-IP Lite city, downloaded into the data volume and refreshed monthly, unless the sites
// file's geoip: or ANALYTICS_GEOIP says otherwise. Addresses are never stored or logged.
const dataDir = dbPath === ":memory:" ? "/data" : dirname(dbPath);
const geoFrom = (setting: FileSettings["geoip"]) => geoSettings(setting, process.env.ANALYTICS_GEOIP, dataDir);
let geoKey = JSON.stringify(geoFrom(null));
let geo = createGeo({ ...geoFrom(null), url: process.env.ANALYTICS_GEOIP_URL || undefined, log });
let geoStarted = false;
// Set once the server is up; a change of the file before that is picked up by the first start.
let booted = false;
/** Downloads or opens the database, once for each setting. */
function startGeo() {
  if (geoStarted) return;
  geoStarted = true;
  void geo.refresh();
}
/** Opens the database the file names, when that changed; the reports keep asking the one in use. */
function useGeo(setting: FileSettings["geoip"]) {
  const key = JSON.stringify(geoFrom(setting));
  if (key === geoKey) return;
  geoKey = key;
  geo = createGeo({ ...geoFrom(setting), url: process.env.ANALYTICS_GEOIP_URL || undefined, log });
  geoStarted = false;
  if (booted) startGeo();
}
const proxies = parseProxies(process.env.ANALYTICS_TRUSTED_PROXIES);
if (proxies.invalid.length) log("warn", "ANALYTICS_TRUSTED_PROXIES: left out entries that are not addresses or ranges", { entries: proxies.invalid });
let file: ReturnType<typeof watchConfig> | undefined;
// Google Search Console, Bing Webmaster Tools and Yandex Webmaster, with their keys from the environment.
const search = engines(process.env);
const analytics = createAnalytics(db, {
  searchEngines: search,
  defaultRate,
  fileState: () => file?.state ?? null,
  fileText: () => file?.text() ?? null,
  geo: {
    lookup: (ip) => geo.lookup(ip),
    get state() {
      return geo.state;
    },
  },
});
// The sites come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (sites, settings) => (useGeo(settings.geoip), analytics.setSites(sites, settings)), {
  onChange: (state) =>
    state.error
      ? log("warn", "sites file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "sites file applied", { file: state.path, sites: state.sites, warnings: state.warnings }),
});
// Email reports and alerts go through the file's smtp:, with its password from the environment.
let mailer: { key: string; mailer: Mailer } | null = null;
const sharing = createSharing(db, analytics, {
  publicUrl,
  mailer: () => {
    const smtp = analytics.smtp();
    if (!smtp) return null;
    const key = JSON.stringify(smtp);
    if (mailer?.key !== key) mailer = { key, mailer: createMailer(smtp, { password: process.env.ANALYTICS_SMTP_PASSWORD }) };
    return mailer.mailer;
  },
  log,
});
const importer = searchImporter(db, search);
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    analytics,
    version,
    publicUrl,
    auth,
    tracker: existsSync(trackerFile) ? readFileSync(trackerFile, "utf8") : undefined,
    replayScript: scriptFile("replay"),
    heatmapScript: scriptFile("heatmap"),
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
    trustedProxies: proxies.proxies,
    sharing,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(analytics, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "analytics started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log(
    "warn",
    "ANALYTICS_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and https sites cannot load the script. Put analytics behind TLS (ADR 0026)",
    {
      url: publicUrl,
    },
  );
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

analytics.purge();
booted = true;
startGeo();
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => analytics.purge(), 3_600_000),
  // Checked daily; a new database is downloaded once DB-IP publishes the month's.
  setInterval(() => void geo.refresh(), 86_400_000),
  // Email reports that are due, every five minutes; alerts on the hour's traffic, a few minutes into each hour.
  setInterval(() => void sharing.reports.tick().catch((err) => log("warn", "email reports not sent", { error: String(err) })), 5 * 60_000),
  setInterval(() => void sharing.alerts.check().catch((err) => log("warn", "alerts not checked", { error: String(err) })), 5 * 60_000),
  // The search engines' numbers, a few times a day; each day is imported once and the last three again.
  setInterval(() => void importer.run(analytics.sites()).catch((err) => log("warn", "search engines not imported", { error: String(err) })), 6 * 3_600_000),
];
setTimeout(() => void importer.run(analytics.sites()).catch((err) => log("warn", "search engines not imported", { error: String(err) })), 30_000).unref();

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
