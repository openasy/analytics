// The heatmap overlay, /s/heatmap.js. The site's script loads it only when Analytics opens the page in its frame with
// #openasy-heatmap. It records nothing: it tells Analytics it is ready, takes the clicks and scroll depth Analytics
// sends back, and draws them on the page, finding each clicked element by its selector, so the heatmap follows the
// page as it is today.
//
// It talks only to the Analytics it was loaded from: messages from any other origin are ignored, and its own go to
// that origin only.

export interface Point {
  target: string;
  /** Where in the element, in thousandths of its width and height. */
  x: number;
  y: number;
  count: number;
}

export interface Data {
  mode: "clicks" | "scroll";
  points: Point[];
  scroll: Array<{ depth: number; share: number }>;
}

const MAX_HEIGHT = 16_000;

/** The page position of each point, where its element is on the page now; points whose element is gone are left out. */
export function place(points: Point[], doc: Document = document): Array<{ left: number; top: number; count: number }> {
  const found = new Map<string, DOMRect | null>();
  const out: Array<{ left: number; top: number; count: number }> = [];
  for (const p of points) {
    if (!found.has(p.target)) {
      let el: Element | null = null;
      try {
        el = doc.querySelector(p.target);
      } catch {
        el = null;
      }
      found.set(p.target, el ? el.getBoundingClientRect() : null);
    }
    const box = found.get(p.target);
    if (!box || (!box.width && !box.height)) continue;
    const view = doc.defaultView!;
    out.push({ left: box.left + view.scrollX + (p.x / 1000) * box.width, top: box.top + view.scrollY + (p.y / 1000) * box.height, count: p.count });
  }
  return out;
}

export function start(analytics: string) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", pointerEvents: "none", zIndex: "2147483647" });
  let data: Data | null = null;

  function draw() {
    if (!data) return;
    const doc = document.documentElement;
    const width = Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0);
    const height = Math.min(MAX_HEIGHT, Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (!canvas.isConnected) document.body.append(canvas);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.scale(ratio, ratio);
    g.clearRect(0, 0, width, height);
    if (data.mode === "scroll") {
      for (const band of data.scroll) {
        const top = ((band.depth - 10) / 100) * height;
        g.fillStyle = `rgba(37, 99, 235, ${0.08 + band.share * 0.42})`;
        g.fillRect(0, top, width, height / 10);
        g.fillStyle = "rgba(17, 24, 39, 0.9)";
        g.font = "600 13px system-ui, sans-serif";
        g.fillText(`${Math.round(band.share * 100)}% read this far`, 12, top + 20);
      }
      return;
    }
    const placed = place(data.points);
    const max = Math.max(1, ...placed.map((p) => p.count));
    g.globalCompositeOperation = "multiply";
    for (const p of placed) {
      const r = 14 + (p.count / max) * 30;
      const grad = g.createRadialGradient(p.left, p.top, 0, p.left, p.top, r);
      grad.addColorStop(0, `rgba(220, 38, 38, ${0.35 + (p.count / max) * 0.55})`);
      grad.addColorStop(1, "rgba(220, 38, 38, 0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(p.left, p.top, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  addEventListener("message", (ev) => {
    if (ev.origin !== analytics || ev.source !== window.parent) return;
    const d = ev.data as { openasy?: string } & Partial<Data>;
    if (d?.openasy !== "heatmap" || (d.mode !== "clicks" && d.mode !== "scroll") || !Array.isArray(d.points) || !Array.isArray(d.scroll)) return;
    data = { mode: d.mode, points: d.points, scroll: d.scroll };
    draw();
  });
  addEventListener("resize", draw);
  // Pages that load content late move their elements: draw again once they settle.
  addEventListener("load", draw);
  new ResizeObserver(draw).observe(document.documentElement);
  window.parent.postMessage({ openasy: "heatmap-ready", height: document.documentElement.scrollHeight }, analytics);
}

const src = (document.currentScript as HTMLScriptElement | null)?.src;
if (src && location.hash === "#openasy-heatmap" && window.parent !== window) start(new URL(src).origin);
