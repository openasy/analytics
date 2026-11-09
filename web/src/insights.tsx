// Heatmaps and replays: the pages that show how people move through a page, not only what they saw. Both follow the
// filter bar: a replay list of the visits it keeps, a heatmap of their clicks.
import {
  Badge,
  Button,
  Callout,
  DataTable,
  EmptyState,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SegmentedControl,
  SelectField,
  useAgo,
  type Column,
} from "@openasy/ui";
import { Clock, Eye, MousePointerClick, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Heatmap, Recording, Visit } from "./api.ts";
import { Code, duration, percent, time } from "./common.tsx";
import { useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { Failed, Report, useLoad, useReport } from "./report.tsx";

// ---------------------------------------------------------------- Heatmaps

/** The width the page is shown at for each kind of device, so its layout is the one those visitors saw. */
const WIDTHS: Record<string, number> = { desktop: 1280, tablet: 820, mobile: 390 };
const MAX_FRAME = 16_000;

export function HeatmapsPage() {
  const t = useT();
  const report = useReport();
  const [path, setPath] = useState("/");
  const [mode, setMode] = useState<"clicks" | "scroll">("clicks");
  const [device, setDevice] = useState("desktop");
  const r = useLoad<Heatmap>(report.site ? `/api/v1/heatmap?${report.query({ path, device }, { compare: false })}` : null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(800);
  const [late, setLate] = useState(false);
  const origin = r ? new URL(r.url).origin : null;

  // A path that is no longer among the site's pages moves to its most viewed one.
  useEffect(() => {
    if (r && r.pages.length && !r.views && !r.pages.some((p) => p.path === path)) setPath(r.pages[0]!.path);
  }, [r, path]);

  // The overlay in the site's page says it is ready; it gets the data, from this window only and for that origin only.
  useEffect(() => {
    setReady(false);
    setLate(false);
    if (!origin) return;
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { openasy?: string; height?: number } | null;
      if (ev.origin !== origin || ev.source !== frame.current?.contentWindow || d?.openasy !== "heatmap-ready") return;
      setReady(true);
      if (typeof d.height === "number" && d.height > 0) setHeight(Math.min(MAX_FRAME, d.height));
    };
    addEventListener("message", onMessage);
    const timer = setTimeout(() => setLate(true), 10_000);
    return () => (removeEventListener("message", onMessage), clearTimeout(timer));
  }, [origin, r?.url, device]);

  useEffect(() => {
    if (!ready || !r || !origin) return;
    frame.current?.contentWindow?.postMessage({ openasy: "heatmap", mode, points: r.points, scroll: r.scroll }, origin);
  }, [ready, r, mode, origin]);

  const width = WIDTHS[device] ?? 1280;
  const pages = r?.pages.length ? r.pages : [{ path, views: 0 }];
  return (
    <Report title={t("heatmaps.title")} description={t("heatmaps.description")} noCompare>
      <div className="flex flex-wrap items-center gap-2">
        <SelectField
          aria-label={t("heatmaps.page")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          options={pages.map((p) => ({ value: p.path, label: p.views ? t("heatmaps.pageOption", { path: p.path, views: p.views }) : p.path }))}
        />
        <SegmentedControl<"clicks" | "scroll">
          label={t("heatmaps.show")}
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "clicks", label: t("heatmaps.clicks") },
            { value: "scroll", label: t("heatmaps.scroll") },
          ]}
        />
        <SegmentedControl<string>
          label={t("heatmaps.device")}
          size="sm"
          value={device}
          onChange={setDevice}
          options={[
            { value: "desktop", label: t("device.desktop") },
            { value: "tablet", label: t("device.tablet") },
            { value: "mobile", label: t("device.mobile") },
          ]}
        />
      </div>
      {r === null && <Failed />}
      {r && (
        <KpiGrid minWidth={150}>
          <KpiCard label={t("heatmaps.views")} value={r.views} icon={Eye} />
          <KpiCard label={t("heatmaps.clicks")} value={r.clicks} icon={MousePointerClick} />
          <KpiCard label={t("heatmaps.half")} value={percent(r.scroll.find((s) => s.depth === 50)?.share ?? 0)} icon={Clock} />
        </KpiGrid>
      )}
      {r && late && !ready && (
        <Callout tone="warning" title={t("heatmaps.notLoaded")}>
          {t("heatmaps.notLoadedDetail", { origin: window.location.origin })}
        </Callout>
      )}
      {r && (
        <Panel title={r.url} description={t("heatmaps.frameDetail", { width })} flush>
          <div className="overflow-x-auto bg-subtle">
            <iframe
              key={`${r.url}|${device}`}
              ref={frame}
              title={t("heatmaps.frame", { path: r.path })}
              src={`${r.url}#openasy-heatmap`}
              // The site's own page and scripts, without forms, pop-ups or leaving the frame.
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              className="mx-auto block border-0 bg-white"
              style={{ width, height: Math.max(600, height) }}
            />
          </div>
        </Panel>
      )}
      {r && (
        <Panel title={t("heatmaps.elements")} description={t("heatmaps.elementsDetail")} flush>
          <DataTable
            label={t("heatmaps.elements")}
            columns={[
              {
                id: "element",
                header: t("table.element"),
                cell: (e) => (
                  <span className="flex min-w-0 flex-col">
                    <span className="analytics-clamp">{e.text ?? "–"}</span>
                    <span className="analytics-wrap font-mono text-xs text-fg-muted">{e.target}</span>
                  </span>
                ),
              },
              { id: "count", header: t("table.clicks"), align: "right", sortValue: (e) => e.count, cell: (e) => e.count },
              { id: "visitors", header: t("table.visitors"), align: "right", sortValue: (e) => e.visitors, cell: (e) => e.visitors },
            ]}
            rows={r.elements}
            getRowId={(e) => e.target}
            minWidth={480}
            empty={<EmptyState title={t("heatmaps.noClicks")} />}
          />
        </Panel>
      )}
    </Report>
  );
}

// ---------------------------------------------------------------- Replays

export function ReplaysPage() {
  const t = useT();
  const f = useFormat();
  const ago = useAgo();
  const report = useReport();
  const { call, query } = report;
  const [rows, setRows] = useState<Visit[]>();
  const [more, setMore] = useState<string>();
  const site = report.current;
  const load = useCallback(
    (cursor?: string) =>
      call<{ replays: Visit[]; nextCursor?: string }>(`/api/v1/replays?${query({ limit: "100", ...(cursor && { cursor }) }, { compare: false })}`),
    [call, query],
  );
  useEffect(() => {
    if (!report.site) return;
    setRows(undefined);
    void load().then(
      (r) => (setRows(r.replays), setMore(r.nextCursor)),
      () => setRows([]),
    );
  }, [load, report.site]);
  const columns: Column<Visit>[] = [
    {
      id: "when",
      header: t("visits.when"),
      sortValue: (v) => v.lastAt,
      cell: (v) => (
        <a href={`/replays/${encodeURIComponent(v.id)}`} className="text-xs whitespace-nowrap">
          {ago(v.lastAt)}
        </a>
      ),
    },
    {
      id: "path",
      header: t("visits.path"),
      cell: (v) => <span className="analytics-wrap font-mono text-xs">{v.entry === v.exit ? v.entry : `${v.entry ?? "–"} → ${v.exit ?? "–"}`}</span>,
    },
    { id: "pages", header: t("visits.pages"), align: "right", sortValue: (v) => v.pageviews, cell: (v) => v.pageviews },
    { id: "length", header: t("visits.length"), align: "right", sortValue: (v) => v.duration, cell: (v) => duration(v.duration) },
    {
      id: "rage",
      header: t("replays.rage"),
      align: "right",
      sortValue: (v) => v.rage,
      cell: (v) => (v.rage ? <Badge tone="warning">{v.rage}</Badge> : 0),
    },
    { id: "device", header: t("visits.device"), cell: (v) => <span className="text-xs">{`${f.device(v.device)} · ${v.browser}, ${v.os}`}</span> },
    { id: "source", header: t("visits.source"), cell: (v) => <span className="text-xs">{f.source(v.source)}</span> },
  ];
  return (
    <Report
      noCompare
      title={t("replays.title")}
      description={site?.replays ? t("replays.description", { sample: site.replays.sample, keep: site.replays.keep }) : t("replays.descriptionOff")}
    >
      {site && !site.replays && !rows?.length ? (
        <EmptyState title={t("replays.off")}>
          <span className="flex flex-col gap-2">
            {t("replays.offDetail")}
            <Code>{"    replays: { sample: 10%, keep: 30d }"}</Code>
          </span>
        </EmptyState>
      ) : (
        <Panel
          flush
          footer={
            more ? (
              <Button size="sm" onClick={() => void load(more).then((r) => (setRows((x) => [...(x ?? []), ...r.replays]), setMore(r.nextCursor)))}>
                {t("visits.loadMore")}
              </Button>
            ) : undefined
          }
        >
          <DataTable
            label={t("replays.title")}
            columns={columns}
            rows={rows ?? []}
            loading={!rows}
            getRowId={(v) => v.id}
            minWidth={760}
            pageSize={50}
            empty={<EmptyState title={t("replays.none")}>{report.active.length ? t("replays.noneFiltered") : t("replays.noneDetail")}</EmptyState>}
          />
        </Panel>
      )}
    </Report>
  );
}

type Player = import("@rrweb/replay").Replayer;
const SPEEDS = ["1", "2", "4", "8"] as const;
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function ReplayPage({ id }: { id: string }) {
  const t = useT();
  const { site } = useReport();
  const r = useLoad<Recording>(site ? `/api/v1/replays/${encodeURIComponent(id)}?site=${encodeURIComponent(site)}` : null);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>("1");
  const [now, setNow] = useState(0);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!r || !stage.current || r.events.length < 2) return;
    let gone = false;
    let frame = 0;
    let size = { width: 1280, height: 800 };
    const fit = () => {
      const wrapper = stage.current?.querySelector<HTMLElement>(".replayer-wrapper");
      if (!wrapper || !box.current) return;
      const scale = Math.min(1, box.current.clientWidth / size.width);
      wrapper.style.transform = `scale(${scale})`;
      wrapper.style.transformOrigin = "top left";
      box.current.style.height = `${Math.round(size.height * scale)}px`;
    };
    const observer = new ResizeObserver(fit);
    // The player is large, and only this page needs it.
    void Promise.all([import("@rrweb/replay"), import("@rrweb/replay/dist/style.css")])
      .then(([{ Replayer }]) => {
        if (gone || !stage.current) return;
        const p = new Replayer(r.events as never, {
          root: stage.current,
          skipInactive: true,
          mouseTail: false,
          UNSAFE_replayCanvas: false,
          triggerFocus: false,
        });
        player.current = p;
        setTotal(p.getMetaData().totalTime);
        p.on("resize", (d) => {
          const v = d as { width: number; height: number };
          size = { width: v.width, height: v.height };
          fit();
        });
        p.on("finish", () => setPlaying(false));
        observer.observe(box.current!);
        const tick = () => {
          setNow(p.getCurrentTime());
          frame = requestAnimationFrame(tick);
        };
        tick();
        p.pause(0);
        fit();
      })
      .catch(() => setFailed(true));
    return () => {
      gone = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      player.current?.destroy();
      player.current = null;
    };
  }, [r]);

  const toggle = () => {
    const p = player.current;
    if (!p) return;
    if (playing) p.pause();
    else p.play(now >= total ? 0 : now);
    setPlaying(!playing);
  };
  const seek = (ms: number) => {
    const p = player.current;
    if (!p) return;
    if (playing) p.play(ms);
    else p.pause(ms);
    setNow(ms);
  };
  const changeSpeed = (s: (typeof SPEEDS)[number]) => {
    setSpeed(s);
    player.current?.setConfig({ speed: Number(s) });
  };

  if (r === null)
    return (
      <EmptyState title={t("replay.notFound")}>
        {t("replay.notFoundDetail")} <a href="/replays">{t("replay.back")}</a>.
      </EmptyState>
    );
  const v = r?.visit;
  return (
    <>
      <PageHeader
        title={t("replay.title")}
        description={v ? `${time(v.startedAt)} · ${v.browser}, ${v.os} · ${v.source ?? t("sources.direct")}` : undefined}
        actions={v && <a href={`/visits/${encodeURIComponent(v.id)}`}>{t("replay.timeline")}</a>}
      />
      {v && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge mono>{t("visit.visitor", { id: v.visitor })}</Badge>
          {v.user && <Badge mono>{t("visit.user", { id: v.user })}</Badge>}
          <Badge>{t(`device.${v.device}` as "device.desktop")}</Badge>
          <Badge>{t("replay.pages", { count: v.pageviews })}</Badge>
          {v.rage > 0 && <Badge tone="warning">{t("replay.rage", { count: v.rage })}</Badge>}
        </div>
      )}
      {failed && <Failed />}
      {r && r.events.length < 2 && <EmptyState title={t("replay.short")}>{t("replay.shortDetail")}</EmptyState>}
      {r && r.events.length >= 2 && (
        <Panel
          flush
          footer={
            <div className="flex w-full flex-wrap items-center gap-3">
              <Button size="sm" variant="primary" icon={playing ? <Pause /> : <Play />} onClick={toggle}>
                {playing ? t("replay.pause") : t("replay.play")}
              </Button>
              <input
                type="range"
                aria-label={t("replay.position")}
                className="analytics-range flex-1"
                min={0}
                max={Math.max(1, total)}
                step={100}
                value={Math.min(now, total)}
                onChange={(e) => seek(Number(e.target.value))}
              />
              <span className="font-mono text-xs whitespace-nowrap text-fg-muted">
                {clock(now)} / {clock(total)}
              </span>
              <SegmentedControl<(typeof SPEEDS)[number]>
                label={t("replay.speed")}
                size="sm"
                value={speed}
                onChange={changeSpeed}
                options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))}
              />
            </div>
          }
        >
          <div ref={box} className="relative overflow-hidden bg-subtle" style={{ height: 480 }}>
            <div ref={stage} className="absolute top-0 start-0" />
          </div>
        </Panel>
      )}
      <p className="m-0 text-xs text-fg-muted">{t("replay.masked")}</p>
    </>
  );
}
