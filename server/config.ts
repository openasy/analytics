// The sites Analytics measures, from one YAML file (ANALYTICS_CONFIG). As with the install's endpoints file, the file
// is the only way in: no screen or API route adds, changes or removes a site. It is applied whole or not at all, read
// again within a minute of a change, and a file with a mistake leaves the last good version in place.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

export interface Goal {
  name: string;
  /** A path pattern, `*` matching any characters, such as /checkout/done or /blog/*. */
  path: string | null;
  /** The name of an event sent with openasy.track(). */
  event: string | null;
}

export interface Site {
  /** Unique in the file; the script is served at /s/<name>.js. */
  name: string;
  /** The origins the script may send from, such as https://www.example.com. */
  domains: string[];
  /** none: measure from the first page. required: nothing is sent or stored until the site calls openasy.consent(true). */
  consent: "none" | "required";
  goals: Goal[];
  /** Query parameters kept besides utm_*. Every other one is dropped before anything is stored. */
  query: string[];
  /** Path patterns that are not recorded at all. */
  ignore: string[];
  /** Days events and visits are kept, and days the daily totals are kept. */
  keep: { events: number; days: number };
  /** Events a minute the site may send, or null for the install's default. */
  rateLimit: number | null;
  /** The environment variable holding the key for events sent from the site's servers; never the key itself. */
  serverKey: string | null;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const PARAM = /^[A-Za-z0-9_.-]{1,64}$/;
const PATTERN = /^\/[^\s]{0,255}$/;
const KEYS = ["name", "domains", "consent", "goals", "query", "ignore", "keep", "rateLimit", "serverKey"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** "90d" or a number of days. */
function days(v: unknown, at: string, min: number, max: number): number {
  const m = typeof v === "number" ? [String(v), String(v)] : typeof v === "string" ? /^(\d+)\s*d?$/.exec(v.trim()) : null;
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${at} is ${min} to ${max} days, such as ${min === 1 ? "90d" : "730d"}.`);
  return n;
}

function origin(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new Error(`${at} is an origin with https://, such as https://www.example.com (http:// only for localhost).`);
  return url.origin;
}

function list(v: unknown, at: string, max: number, ok: (s: string) => boolean, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || v.some((s) => typeof s !== "string" || !ok(s))) throw new Error(`${at} is a list of up to ${max} ${what}.`);
  return [...new Set(v as string[])];
}

/** Reads the file's text. Throws with the site and field at fault, so one message says what to fix. */
export function parseConfig(text: string): Site[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) return [];
  if (!isObj(doc) || Object.keys(doc).some((k) => k !== "sites")) throw new Error("The file holds one list, sites:, and nothing else.");
  const sites = doc.sites ?? [];
  if (!Array.isArray(sites)) throw new Error("sites must be a list.");
  if (sites.length > 200) throw new Error("sites holds at most 200 entries.");
  const seen = new Set<string>();
  return sites.map((s, i) => {
    const at = `sites[${i}]`;
    if (!isObj(s)) throw new Error(`${at} must be a map with at least name and domains.`);
    const extra = Object.keys(s).filter((k) => !KEYS.includes(k));
    if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; a site takes ${KEYS.join(", ")}.`);
    if (typeof s.name !== "string" || !NAME.test(s.name)) throw new Error(`${at}.name is required: up to 32 lowercase letters, digits and -.`);
    const name = s.name;
    if (seen.has(name)) throw new Error(`${at}.name: ${name} is in the file twice.`);
    seen.add(name);
    const where = `${at} (${name})`;
    if (!Array.isArray(s.domains) || s.domains.length < 1 || s.domains.length > 20) throw new Error(`${where}.domains is a list of 1 to 20 origins.`);
    const domains = [...new Set(s.domains.map((d, n) => origin(d, `${where}.domains[${n}]`)))];
    if (s.consent !== undefined && s.consent !== "none" && s.consent !== "required") throw new Error(`${where}.consent is none or required.`);

    const goals: Goal[] = [];
    if (s.goals !== undefined) {
      if (!Array.isArray(s.goals) || s.goals.length > 50) throw new Error(`${where}.goals is a list of up to 50 goals.`);
      const names = new Set<string>();
      s.goals.forEach((g, n) => {
        const gat = `${where}.goals[${n}]`;
        if (!isObj(g) || Object.keys(g).some((k) => !["name", "path", "event"].includes(k))) throw new Error(`${gat} takes name, and path or event.`);
        if (typeof g.name !== "string" || !g.name.trim() || g.name.length > 64) throw new Error(`${gat}.name is up to 64 characters.`);
        if (names.has(g.name)) throw new Error(`${gat}.name: ${g.name} is a goal twice.`);
        names.add(g.name);
        const hasPath = g.path !== undefined;
        if (hasPath === (g.event !== undefined)) throw new Error(`${gat} has a path or an event, not both.`);
        if (hasPath && (typeof g.path !== "string" || !PATTERN.test(g.path))) throw new Error(`${gat}.path starts with /, such as /checkout/done or /blog/*.`);
        if (!hasPath && (typeof g.event !== "string" || !PARAM.test(g.event)))
          throw new Error(`${gat}.event is an event name of up to 64 letters, digits and _ . -.`);
        goals.push({ name: g.name.trim(), path: hasPath ? (g.path as string) : null, event: hasPath ? null : (g.event as string) });
      });
    }

    let keep = { events: 90, days: 730 };
    if (s.keep !== undefined) {
      if (!isObj(s.keep) || Object.keys(s.keep).some((k) => k !== "events" && k !== "days")) throw new Error(`${where}.keep takes events and days.`);
      keep = {
        events: s.keep.events === undefined ? 90 : days(s.keep.events, `${where}.keep.events`, 1, 3650),
        days: s.keep.days === undefined ? 730 : days(s.keep.days, `${where}.keep.days`, 30, 3650),
      };
    }
    if (s.rateLimit !== undefined && (!Number.isInteger(s.rateLimit) || (s.rateLimit as number) < 1 || (s.rateLimit as number) > 1_000_000))
      throw new Error(`${where}.rateLimit is events a minute, 1 to 1000000.`);
    if (s.serverKey !== undefined && (typeof s.serverKey !== "string" || !ENV.test(s.serverKey)))
      throw new Error(`${where}.serverKey is the name of an environment variable, such as ANALYTICS_SHOP_KEY, never the key itself.`);

    return {
      name,
      domains,
      consent: (s.consent as Site["consent"] | undefined) ?? "none",
      goals,
      query: list(s.query, `${where}.query`, 20, (q) => PARAM.test(q), "parameter names"),
      ignore: list(s.ignore, `${where}.ignore`, 50, (p) => PATTERN.test(p), "path patterns starting with /"),
      keep,
      rateLimit: (s.rateLimit as number | undefined) ?? null,
      serverKey: (s.serverKey as string | undefined) ?? null,
    };
  });
}

/** A path pattern as a regular expression: `*` matches any characters, everything else itself. */
export function pathPattern(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  sites: number;
  /** Why the file on disk is not what is applied; the last good list stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * list to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied leaves the last
 * good list in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (sites: Site[]) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, sites: 0, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let text: string;
    let stamp: string;
    try {
      const st = statSync(path);
      text = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(text).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const sites = parseConfig(text);
      state.warnings = apply(sites);
      Object.assign(state, { appliedAt: new Date().toISOString(), sites: sites.length, error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
