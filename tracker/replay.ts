// The replay recorder, /s/replay.js. The site's script loads it for the share of visits the site records, after
// consent when the site asks for it, and it records the page with rrweb:
//
// - every form field's value is masked in the browser (maskAllInputs), and so is the text of elements marked
//   data-analytics-mask; elements marked data-analytics-block are left out whole, as are canvas and fonts;
// - what it records goes to /api/v1/replay every few seconds, gzipped, with the visit's ids, where emails, tokens and
//   keys in it are masked again before it is kept.
import { record } from "@rrweb/record";

interface Config {
  site: string;
  endpoint: string;
  ids: () => { visitor: string; session: string } | null;
}

const FLUSH_EVERY = 5_000;
const MAX_EVENTS = 500;
/** Beacons and keepalive requests carry at most 64 KiB. */
const BEACON = 60_000;

/** The visit's next chunk number, kept in the tab across its pages so a new page does not start again at 0. */
const SEQ = "openasy.replay.seq";
function nextSeq(session: string): number {
  try {
    const [s, n] = (sessionStorage.getItem(SEQ) ?? "").split(":");
    const seq = s === session ? Number(n) + 1 : 0;
    sessionStorage.setItem(SEQ, `${session}:${seq}`);
    return seq;
  } catch {
    // Without storage the page's chunks still go in order, from a number no earlier page of the visit used.
    return Date.now() % 100_000;
  }
}

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

export function start(config: Config) {
  if (typeof CompressionStream === "undefined") return { stop() {} };
  let buffer: unknown[] = [];
  let session: string | null = null;

  async function flush(closing = false) {
    const id = config.ids();
    if (!id || !buffer.length) return;
    // A visit that ended after 30 minutes without activity: what is left goes to it, and the new one starts whole.
    if (session && session !== id.session) {
      session = id.session;
      buffer = [];
      record.takeFullSnapshot(true);
      return;
    }
    session = id.session;
    const events = buffer;
    buffer = [];
    const body = await gzip(JSON.stringify(events));
    const q = new URLSearchParams({ site: config.site, visitor: id.visitor, session: id.session, seq: String(nextSeq(id.session)) });
    const url = `${config.endpoint}?${q}`;
    const blob = new Blob([body], { type: "text/plain" });
    // text/plain needs no preflight; a beacon still goes when the page is closing, if it is small enough.
    if (closing && blob.size < BEACON && navigator.sendBeacon?.(url, blob)) return;
    void fetch(url, { method: "POST", body: blob, keepalive: blob.size < BEACON, credentials: "omit" }).catch(() => {});
  }

  const stopRecording = record({
    emit(event) {
      buffer.push(event);
      if (buffer.length >= MAX_EVENTS) void flush();
    },
    maskAllInputs: true,
    maskTextSelector: "[data-analytics-mask]",
    blockSelector: "[data-analytics-block]",
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    slimDOMOptions: "all",
    sampling: { mousemove: 50, scroll: 150, media: 800, input: "last" },
  });
  const timer = setInterval(() => void flush(), FLUSH_EVERY);
  const closing = () => void flush(true);
  addEventListener("pagehide", closing);
  addEventListener("visibilitychange", () => document.visibilityState === "hidden" && closing());

  const api = {
    stop() {
      stopRecording?.();
      clearInterval(timer);
      removeEventListener("pagehide", closing);
      buffer = [];
    },
  };
  (window as unknown as { OAR: typeof api }).OAR = api;
  return api;
}

const pending = (window as unknown as { OAR_CONFIG?: Config }).OAR_CONFIG;
if (pending) start(pending);
