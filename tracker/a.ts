// The script a site's pages load from /s/<site>.js. It is built into one small file with no dependencies, and the
// server wraps it with the site's settings: `OAT.start({ site, endpoint, consent })`.
//
// What it sends: page views, the time spent on each page and how far it was read, clicks on links, buttons and
// elements marked data-analytics, and the site's own events. What it never reads: the value of any form field, and the
// text of elements marked data-analytics-mask.

export interface Config {
  site: string;
  /** The product's /api/v1/collect. */
  endpoint: string;
  /** required: nothing is sent or stored until the site calls openasy.consent(true). */
  consent: "none" | "required";
}

type Props = Record<string, string | number | boolean>;
interface Event {
  type: "pageview" | "leave" | "click" | "event" | "forget";
  at: number;
  url?: string;
  title?: string;
  referrer?: string;
  target?: string;
  text?: string;
  href?: string;
  name?: string;
  props?: Props;
  duration?: number;
  scroll?: number;
}

export interface Api {
  /** One of the site's own events, such as a sign-up, with up to 20 short properties. */
  track(name: string, props?: Props): void;
  /** The site's own opaque id for the person signed in; never an email address. */
  identify(user: string | null): void;
  /** true starts measuring on a site that asks first; false stops it and deletes what was kept about this visitor. */
  consent(given: boolean): void;
  /** The visitor and visit ids, for a site's servers to send events of the same visit. */
  ids(): { visitor: string; session: string } | null;
}

const VISITOR = "openasy.visitor";
const SESSION = "openasy.session";
const CONSENT = "openasy.consent";
const USER = "openasy.user";
/** A visit ends after 30 minutes without activity. */
const IDLE = 30 * 60_000;
const FLUSH_EVERY = 5_000;
const CLICKABLE = "a,button,[role=button],[role=link],input[type=submit],input[type=button],summary,[data-analytics]";

/** Storage can throw (private windows, blocked site data); the script then counts the page view without ids. */
function get(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}
function set(store: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // nothing to keep it in
  }
}
const local = () => window.localStorage;
const tab = () => window.sessionStorage;

/** A random id: 22 characters, from crypto, never from anything about the person or the device. */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A short selector for an element: its tag, id or first two classes, and those of up to two parents. */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el, n = 0; e && e !== document.body && n < 3; e = e.parentElement, n++) {
    let part = e.tagName.toLowerCase();
    if (e.id && /^[A-Za-z][\w-]{0,40}$/.test(e.id)) {
      parts.unshift(`${part}#${e.id}`);
      break;
    }
    const classes = [...e.classList].filter((c) => /^[A-Za-z][\w-]{0,40}$/.test(c)).slice(0, 2);
    if (classes.length) part += `.${classes.join(".")}`;
    parts.unshift(part);
  }
  return parts.join(" > ").slice(0, 200);
}

/** What a clicked element says, never what was typed: a form field gives its label, not its value. */
export function textOf(el: Element): string | undefined {
  if (el.closest("[data-analytics-mask]")) return undefined;
  const named = el.getAttribute("data-analytics") || el.getAttribute("aria-label");
  if (named) return named.trim().slice(0, 80) || undefined;
  if (el instanceof HTMLInputElement) return el.type === "submit" || el.type === "button" ? el.value.trim().slice(0, 80) || undefined : undefined;
  const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
}

/** `signal` stops the script: its listeners, its timer and its watch on history. Only tests need it. */
export function start(config: Config, signal?: AbortSignal): Api {
  const queue: Event[] = [];
  let user = get(tab, USER);
  let allowed = config.consent === "none" || get(local, CONSENT) === "1";
  // Pages driven by automation are not people.
  if (navigator.webdriver) allowed = false;

  let page: { url: string; at: number; scroll: number; left: boolean } | null = null;
  let last = location.href;

  function ids() {
    if (!allowed) return null;
    let visitor = get(local, VISITOR);
    if (!visitor) set(local, VISITOR, (visitor = randomId()));
    const now = Date.now();
    let session: { id: string; at: number } | null = null;
    try {
      session = JSON.parse(get(tab, SESSION) ?? "null") as { id: string; at: number } | null;
    } catch {
      session = null;
    }
    if (!session || now - session.at > IDLE) session = { id: randomId(), at: now };
    session.at = now;
    set(tab, SESSION, JSON.stringify(session));
    return { visitor, session: session.id };
  }

  function push(e: Omit<Event, "at">) {
    if (!allowed) return;
    queue.push({ at: Date.now(), ...e });
    if (queue.length >= 50) flush();
  }

  function flush() {
    if (!allowed || !queue.length) return;
    const id = ids();
    if (!id) return;
    const body = JSON.stringify({ site: config.site, ...id, ...(user && { user }), events: queue.splice(0, 50) });
    // text/plain needs no preflight, and sendBeacon still sends when the page is closing.
    const blob = new Blob([body], { type: "text/plain" });
    if (!navigator.sendBeacon?.(config.endpoint, blob)) {
      void fetch(config.endpoint, { method: "POST", body, keepalive: true, credentials: "omit", headers: { "content-type": "text/plain" } }).catch(() => {});
    }
  }

  function scrolled(): number {
    const doc = document.documentElement;
    const height = Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0);
    if (height <= window.innerHeight) return 100;
    return Math.min(100, Math.round(((window.scrollY + window.innerHeight) / height) * 100));
  }

  /** The time and depth of the page being left, once per page. */
  function leave() {
    if (!page || page.left) return;
    page.left = true;
    push({ type: "leave", url: page.url, duration: Date.now() - page.at, scroll: Math.max(page.scroll, scrolled()) });
  }

  function pageview(referrer: string) {
    leave();
    page = { url: location.href, at: Date.now(), scroll: 0, left: false };
    push({ type: "pageview", url: location.href, title: document.title, referrer });
  }

  /** A single-page app moved to another address: that is a page view of its own. */
  function moved() {
    if (location.href === last) return;
    const from = last;
    last = location.href;
    pageview(from);
  }

  let started = false;
  function begin() {
    pageview(document.referrer);
    // Consent given again after it was withdrawn: the listeners are still there.
    if (started) return;
    started = true;
    addEventListener(
      "scroll",
      () => {
        if (page) page.scroll = Math.max(page.scroll, scrolled());
      },
      { passive: true, signal },
    );
    addEventListener(
      "click",
      (ev) => {
        const el = ev.target instanceof Element ? ev.target.closest(CLICKABLE) : null;
        if (!el) return;
        const href = el instanceof HTMLAnchorElement ? el.href : undefined;
        push({ type: "click", url: location.href, target: selectorOf(el), text: textOf(el), ...(href && { href }) });
        // A link that leaves the page may not give the timer another chance.
        if (href) flush();
      },
      { capture: true, signal },
    );
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        if (!signal?.aborted) moved();
        return result;
      };
    }
    addEventListener("popstate", moved, { signal });
    addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "hidden") (leave(), flush());
      },
      { signal },
    );
    addEventListener("pagehide", () => (leave(), flush()), { signal });
    const timer = setInterval(flush, FLUSH_EVERY);
    signal?.addEventListener("abort", () => clearInterval(timer));
  }

  const api: Api = {
    track(name, props) {
      push({ type: "event", url: location.href, name: String(name), ...(props && { props }) });
    },
    identify(id) {
      user = id ? String(id) : null;
      set(tab, USER, user);
    },
    consent(given) {
      if (given && !allowed && !navigator.webdriver) {
        allowed = true;
        set(local, CONSENT, "1");
        begin();
      } else if (!given) {
        // Ask the product to delete this visitor, then forget the ids here too.
        if (allowed) {
          queue.length = 0;
          push({ type: "forget" });
          flush();
        }
        allowed = false;
        for (const k of [VISITOR, CONSENT]) set(local, k, null);
        for (const k of [SESSION, USER]) set(tab, k, null);
      }
    },
    ids,
  };

  // Calls made before the script loaded: window.openasy = window.openasy || { q: [] }, then openasy.q.push(["track", ...]).
  const early = (window as unknown as { openasy?: { q?: Array<[keyof Api, ...unknown[]]> } }).openasy?.q ?? [];
  (window as unknown as { openasy: Api }).openasy = api;
  if (allowed) begin();
  for (const [method, ...args] of early) if (typeof api[method] === "function") (api[method] as (...a: unknown[]) => unknown)(...args);
  return api;
}
