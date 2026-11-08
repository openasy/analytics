// The script a site's pages load from /s/<site>.js. It is built into one small file with no dependencies, and the
// server wraps it with the site's settings: `OAT.start({ site, endpoint, consent })`.
//
// What it sends: page views with the browser's language, time zone and screen size, the time spent on each page, how
// far it was read and its Core Web Vitals (LCP, INP, CLS), clicks on links, buttons and elements marked data-analytics
// with where in the element they landed, clicks that changed nothing (dead clicks), the site's own events, and on sites
// with forms: true the form fields entered and left (their names and kinds). What it never reads: the value of any
// form field, and the text of elements marked data-analytics-mask.
//
// Two more files load only when needed: the replay recorder (replay.ts) for the share of visits a site records, and
// the heatmap overlay (heatmap.ts) when Analytics opens the page in its frame with #openasy-heatmap.

export interface Config {
  site: string;
  /** The product's /api/v1/collect. */
  endpoint: string;
  /** required: nothing is sent or stored until the site calls openasy.consent(true). */
  consent: "none" | "required";
  /** Report form fields entered and left. */
  forms?: boolean;
  /** Record this share of visits (0 to 100) with the replay script, which sends to its endpoint. */
  replay?: { sample: number; script: string; endpoint: string } | null;
  /** The heatmap overlay, loaded when Analytics frames the page. */
  heatmap?: string;
  /** Measure Core Web Vitals, on sites with vitals: true. */
  vitals?: boolean;
  /** Send openasy.ecommerce() calls, on sites with ecommerce: true. */
  ecommerce?: boolean;
}

/** A product in an ecommerce call: what it is and what it cost, never who bought it. */
export interface Item {
  sku: string;
  name?: string;
  category?: string;
  price?: number;
  quantity?: number;
}
/** What an ecommerce call says: the order's id (for a purchase or a refund), its value and currency, and the products. */
export interface Commerce {
  order?: string;
  value?: number;
  currency?: string;
  items?: Item[];
}

type Props = Record<string, string | number | boolean>;
interface Event {
  type: "pageview" | "leave" | "click" | "event" | "form" | "forget";
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
  x?: number;
  y?: number;
  form?: string;
  field?: string;
  kind?: string;
  action?: "start" | "leave" | "submit" | "abandon";
  filled?: boolean;
  again?: boolean;
  language?: string;
  timezone?: string;
  screen?: string;
  notFound?: boolean;
  dead?: boolean;
  lcp?: number;
  inp?: number;
  cls?: number;
  noResults?: boolean;
  order?: string;
  value?: number;
  currency?: string;
  items?: Item[];
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
  /** Marks the page as not found, for a site that cannot add <meta name="analytics" content="404">. */
  notFound(): void;
  /** Marks a search page that found nothing, for a site that cannot add <meta name="analytics" content="no-results">. */
  noResults(): void;
  /** view_item, add_to_cart, begin_checkout, purchase or refund, by GA4's names, on a site with ecommerce: true. */
  ecommerce(name: "view_item" | "add_to_cart" | "begin_checkout" | "purchase" | "refund", data?: Commerce): void;
}

const VISITOR = "openasy.visitor";
const SESSION = "openasy.session";
const CONSENT = "openasy.consent";
const USER = "openasy.user";
const REPLAY = "openasy.replay";
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

/**
 * A selector that finds the element again, for the heatmap: up to the nearest parent with an id, or five levels, each
 * its tag, first two classes, and its place among siblings of the same tag when it has any.
 */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el, n = 0; e && e !== document.body && e !== document.documentElement && n < 5; e = e.parentElement, n++) {
    let part = e.tagName.toLowerCase();
    if (e.id && /^[A-Za-z][\w-]{0,40}$/.test(e.id)) {
      parts.unshift(`${part}#${e.id}`);
      break;
    }
    const classes = [...e.classList].filter((c) => /^[A-Za-z][\w-]{0,40}$/.test(c)).slice(0, 2);
    if (classes.length) part += `.${classes.join(".")}`;
    const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e!.tagName) : [];
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
    parts.unshift(part);
  }
  return parts.join(" > ").slice(0, 200);
}

const FIELDS = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea";

/** A form's selector: its id or name, else where it is. */
export function formOf(form: Element): string {
  const id = form.id || form.getAttribute("name");
  return id && /^[A-Za-z][\w-]{0,40}$/.test(id) ? `form#${id}` : selectorOf(form);
}

/** A field's name or id and its kind; never what it holds. */
export function fieldOf(el: Element): { field?: string; kind: string } {
  const kind =
    el instanceof HTMLSelectElement ? "select" : el instanceof HTMLTextAreaElement ? "textarea" : ((el as HTMLInputElement).type || "text").toLowerCase();
  const name = (el.getAttribute("name") || el.id || "").slice(0, 64);
  // The server keeps a field named like a card number or a password by its kind only; so does the page.
  const field =
    /^[A-Za-z0-9_.:[\]-]{1,64}$/.test(name) && !/pass|pwd|secret|token|card|cc-?(num|csc|exp)|cvc|cvv|iban|ssn|tckn|kimlik|account|routing/i.test(name)
      ? name
      : `(${kind})`;
  return { field, kind };
}

/** Whether a field has anything in it, without reading what. */
function filledIn(el: Element): boolean {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked;
  if (el instanceof HTMLSelectElement) return el.selectedIndex > 0;
  return ((el as HTMLInputElement).value ?? "").length > 0;
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

/** Elements a click on which leaves the page or types into it: they are never dead clicks. */
const LIVE = "a[href],input,select,textarea,label,[contenteditable],button[type=submit],form button:not([type])";

/**
 * Core Web Vitals as web.dev measures them, in a few lines instead of its library: LCP of the page as loaded, CLS as
 * the worst burst of layout shifts, INP as the slowest interaction but one in every fifty. `reset` starts CLS and INP
 * again for the next page of a single-page app; LCP is only measured for the page the browser loaded.
 */
export function vitals() {
  let lcp = 0;
  let cls = 0;
  let burst = 0;
  let first = 0;
  let last = 0;
  let hard = document.visibilityState !== "hidden";
  let slow = new Map<number, number>();
  const supported = (t: string) => !!window.PerformanceObserver?.supportedEntryTypes?.includes(t);
  const watch = (type: string, cb: (e: PerformanceEntry & Record<string, any>) => void, more = {}) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(cb as (e: PerformanceEntry) => void)).observe({ type, buffered: true, ...more });
    } catch {
      // not in this browser
    }
  };
  watch("largest-contentful-paint", (e) => (lcp = e.startTime));
  watch("layout-shift", (e) => {
    if (e.hadRecentInput) return;
    if (burst && e.startTime - last < 1000 && e.startTime - first < 5000) burst += e.value;
    else ((burst = e.value), (first = e.startTime));
    last = e.startTime;
    cls = Math.max(cls, burst);
  });
  const interaction = (e: PerformanceEntry & Record<string, any>) =>
    e.interactionId && slow.set(e.interactionId, Math.max(slow.get(e.interactionId) ?? 0, e.duration));
  watch("event", interaction, { durationThreshold: 16 });
  watch("first-input", interaction);
  return {
    take(): Pick<Event, "lcp" | "inp" | "cls"> {
      const d = [...slow.values()].sort((a, b) => b - a);
      const v = {
        ...(hard && lcp > 0 && { lcp: Math.round(lcp) }),
        ...(d.length && { inp: Math.round(d[Math.min(d.length - 1, Math.floor(d.length / 50))]!) }),
        ...(supported("layout-shift") && { cls: Math.round(cls * 1e4) / 1e4 }),
      };
      hard = false;
      cls = burst = 0;
      slow = new Map();
      return v;
    },
  };
}

/** Loads one of the product's other scripts, once. */
function load(src: string) {
  if (document.querySelector(`script[src="${src}"]`)) return;
  const s = document.createElement("script");
  s.src = src;
  s.async = true;
  document.head.append(s);
}

/** `signal` stops the script: its listeners, its timer and its watch on history. Only tests need it. */
export function start(config: Config, signal?: AbortSignal): Api {
  const queue: Event[] = [];
  let user = get(tab, USER);
  let allowed = config.consent === "none" || get(local, CONSENT) === "1";
  // Pages driven by automation are not people.
  if (navigator.webdriver) allowed = false;
  // Analytics showing a heatmap on this page in its frame: nothing is recorded, and the overlay draws on the page.
  const framed = location.hash === "#openasy-heatmap" && window.parent !== window;
  if (framed) {
    allowed = false;
    if (config.heatmap) load(config.heatmap);
  }

  let page: { url: string; at: number; scroll: number; left: boolean; notFound?: boolean; noResults?: boolean } | null = null;
  const vital = config.vitals ? vitals() : null;
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

  function push(e: Omit<Event, "at"> & { at?: number }) {
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
    push({
      type: "leave",
      url: page.url,
      duration: Date.now() - page.at,
      scroll: Math.max(page.scroll, scrolled()),
      ...vital?.take(),
      ...(page.notFound && { notFound: true }),
      ...(page.noResults && { noResults: true }),
    });
  }

  function pageview(referrer: string) {
    if (config.forms) abandonForms();
    leave();
    // A page the site marks as not found: <meta name="analytics" content="404">.
    const meta = (c: string) => !!document.querySelector(`meta[name="analytics"][content="${c}"]`);
    const notFound = meta("404");
    const noResults = meta("no-results");
    page = { url: location.href, at: Date.now(), scroll: 0, left: false, notFound, noResults };
    push({
      type: "pageview",
      url: location.href,
      title: document.title,
      referrer,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: `${screen.width}x${screen.height}`,
      ...(notFound && { notFound }),
      ...(noResults && { noResults }),
    });
  }

  /** A single-page app moved to another address: that is a page view of its own. */
  function moved() {
    if (location.href === last) return;
    const from = last;
    last = location.href;
    pageview(from);
  }

  // Forms: per page, which forms were started and sent, the field being filled and the fields left before.
  let forms = new Map<Element, { sent: boolean; last?: string; kind?: string; seen: Set<string> }>();
  let focus: { el: Element; at: number } | null = null;
  function leaveField() {
    if (!focus) return;
    const form = focus.el.closest("form");
    const f = form && forms.get(form);
    if (form && f) {
      const { field, kind } = fieldOf(focus.el);
      push({
        type: "form",
        url: location.href,
        form: formOf(form),
        action: "leave",
        field,
        kind,
        duration: Date.now() - focus.at,
        filled: filledIn(focus.el),
        again: f.seen.has(field!),
      });
      f.seen.add(field!);
      f.last = field;
      f.kind = kind;
    }
    focus = null;
  }
  /** The forms of the page left unsent, each at the last field filled. */
  function abandonForms() {
    leaveField();
    for (const [form, f] of forms) if (!f.sent) push({ type: "form", url: location.href, form: formOf(form), action: "abandon", field: f.last, kind: f.kind });
    forms = new Map();
  }

  /**
   * A dead click: within a second, nothing on the page changed, it did not scroll, move to another address or put the
   * focus elsewhere. The click is marked where it waits to be sent, or sent again marked, and the server joins the two.
   */
  function dead(el: Element, e: Event, alone: boolean) {
    let changed = false;
    const was = { href: location.href, y: scrollY, focus: document.activeElement };
    const watch = new MutationObserver(() => (changed = true));
    watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => {
      watch.disconnect();
      const focus = document.activeElement;
      if (changed || location.href !== was.href || scrollY !== was.y || (focus !== was.focus && focus !== el)) return;
      if (!alone && queue.includes(e)) e.dead = true;
      else if (allowed) queue.push({ ...e, dead: true });
    }, 1000);
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
    const click = (ev: MouseEvent) => {
      // A middle click opens a link in a new tab; other buttons are not clicks.
      if (ev.type === "auxclick" && ev.button !== 1) return;
      const t = ev.target instanceof Element ? ev.target : null;
      const el = t?.closest(CLICKABLE);
      // Something that looks clickable but is not a link or a button is reported only when the click changed nothing.
      const looks = !el && t && getComputedStyle(t).cursor === "pointer" ? t : null;
      const on = el ?? looks;
      if (!on) return;
      const href = on instanceof HTMLAnchorElement ? on.href : undefined;
      // Where in the element, in thousandths, so the heatmap puts it there whatever the element's size on the screen.
      const box = on.getBoundingClientRect();
      const at = (v: number, start: number, size: number) => (size > 0 ? Math.max(0, Math.min(1000, Math.round(((v - start) / size) * 1000))) : 500);
      const e: Event = {
        type: "click",
        at: Date.now(),
        url: location.href,
        target: selectorOf(on),
        text: textOf(on),
        ...(href && { href }),
        x: at(ev.clientX, box.left, box.width),
        y: at(ev.clientY, box.top, box.height),
      };
      if (el) push(e);
      // The queued copy, to mark when the click turns out dead; if it is gone, the click is sent again marked.
      const queued = queue.at(-1);
      const sent = el && queued?.at === e.at && queued.target === e.target ? queued : e;
      // A link that leaves the page may not give the timer another chance.
      if (href) return flush();
      if (ev.type === "click" && !on.closest(LIVE)) dead(on, sent, !!looks);
    };
    addEventListener("click", click, { capture: true, signal });
    addEventListener("auxclick", click, { capture: true, signal });
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        if (!signal?.aborted) moved();
        return result;
      };
    }
    addEventListener("popstate", moved, { signal });
    if (config.forms) {
      addEventListener(
        "focusin",
        (ev) => {
          const el = ev.target instanceof Element && ev.target.matches(FIELDS) ? ev.target : null;
          const form = el?.closest("form");
          if (!el || !form || el.closest("[data-analytics-mask]")) return;
          leaveField();
          if (!forms.has(form)) {
            forms.set(form, { sent: false, seen: new Set() });
            const { field, kind } = fieldOf(el);
            push({ type: "form", url: location.href, form: formOf(form), action: "start", field, kind });
          }
          focus = { el, at: Date.now() };
        },
        { signal },
      );
      addEventListener("focusout", () => leaveField(), { signal });
      addEventListener(
        "submit",
        (ev) => {
          const form = ev.target instanceof HTMLFormElement ? ev.target : null;
          if (!form) return;
          leaveField();
          const f = forms.get(form) ?? { sent: false, seen: new Set<string>() };
          f.sent = true;
          forms.set(form, f);
          push({ type: "form", url: location.href, form: formOf(form), action: "submit" });
          flush();
        },
        { capture: true, signal },
      );
    }
    addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "hidden") (leave(), flush());
      },
      { signal },
    );
    addEventListener("pagehide", () => (config.forms && abandonForms(), leave(), flush()), { signal });
    const timer = setInterval(flush, FLUSH_EVERY);
    signal?.addEventListener("abort", () => clearInterval(timer));
    replay();
  }

  /** Records this visit with the replay script when the site records replays and this visit is in its sample. */
  function replay() {
    const r = config.replay;
    const id = ids();
    if (!r || !id) return;
    // Decided once a visit, so a visit is recorded whole or not at all.
    let pick = get(tab, REPLAY);
    if (!pick || pick.split(":")[0] !== id.session) set(tab, REPLAY, (pick = `${id.session}:${Math.random() * 100 < r.sample ? 1 : 0}`));
    if (!pick.endsWith(":1")) return;
    (window as unknown as { OAR_CONFIG?: unknown }).OAR_CONFIG = { site: config.site, endpoint: r.endpoint, ids };
    load(r.script);
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
        (window as unknown as { OAR?: { stop(): void } }).OAR?.stop();
        for (const k of [VISITOR, CONSENT]) set(local, k, null);
        for (const k of [SESSION, USER, REPLAY]) set(tab, k, null);
      }
    },
    ids,
    notFound: () => mark("notFound"),
    noResults: () => mark("noResults"),
    ecommerce(name, data = {}) {
      // The server checks and cleans what it holds; the page only passes on these four.
      if (config.ecommerce) push({ type: "event", url: location.href, name, order: data.order, value: data.value, currency: data.currency, items: data.items });
    },
  };

  /** Marks the page, still waiting to be sent: the page view says it; otherwise the page's leave does. */
  function mark(what: "notFound" | "noResults") {
    if (!page) return;
    page[what] = true;
    const view = queue.find((e) => e.type === "pageview" && e.url === page!.url);
    if (view) view[what] = true;
  }

  // Calls made before the script loaded: window.openasy = window.openasy || { q: [] }, then openasy.q.push(["track", ...]).
  const early = (window as unknown as { openasy?: { q?: Array<[keyof Api, ...unknown[]]> } }).openasy?.q ?? [];
  (window as unknown as { openasy: Api }).openasy = api;
  if (allowed) begin();
  for (const [method, ...args] of early) if (typeof api[method] === "function") (api[method] as (...a: unknown[]) => unknown)(...args);
  return api;
}
