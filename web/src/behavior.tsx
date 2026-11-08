// Behavior: each page with where visits entered and left, links out and downloads, the site's own search, pages not
// found with the links to them, and rage and dead clicks with the replays that show them.
import { Badge, BarList, Callout, DataTable, EmptyState, KpiCard, KpiGrid, Panel, SegmentedControl, SelectField, type Column } from "@openasy/ui";
import { useState } from "react";
import type { BreakdownRow, Frustration, Paths, Report as ReportData, SiteSearch } from "./api.ts";
import { Code, duration } from "./common.tsx";
import { NONE, useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { byValue, Change, CsvButton, Failed, Loading, Note, PathFlow, Report, useBreakdown, useDelta, useLoad, useReport, useTab } from "./report.tsx";

const TABS = ["pages", "paths", "links", "sitesearch", "notfound", "frustration"] as const;

export function BehaviorPage({ at }: { at?: string }) {
  const t = useT();
  const [tab, setTab] = useTab("behavior", TABS, at);
  return (
    <Report
      title={t("behavior.title")}
      description={t(`behavior.${tab}Detail`)}
      tabs={TABS.map((x) => ({ value: x, label: t(`behavior.${x}`) }))}
      tab={tab}
      onTab={setTab}
    >
      {tab === "pages" && <PagesTab />}
      {tab === "paths" && <PathsTab />}
      {tab === "links" && <LinksTab />}
      {tab === "sitesearch" && <SiteSearchTab />}
      {tab === "notfound" && <NotFoundTab />}
      {tab === "frustration" && <FrustrationTab />}
    </Report>
  );
}

const none = (text: string) => <p className="m-0 px-3 py-2 text-sm text-fg-muted">{text}</p>;

type PageRow = ReportData["pages"][number];

function PagesTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const [view, setView] = useState<"all" | "entry" | "exit">("all");
  const report = useLoad<ReportData>(r.site ? `/api/v1/report?${r.query()}` : null);
  const entries = useBreakdown("entry", { limit: 200, skip: view !== "entry" });
  const exits = useBreakdown("exit", { limit: 200, skip: view !== "exit" });
  if (report === null) return <Failed />;
  const views = new Map((report?.pages ?? []).map((p) => [p.path, p]));
  const before = new Map((report?.compare?.pages ?? []).map((p) => [p.path, p]));
  const page = (path: string | null) => (
    <span className="flex min-w-0 flex-col">
      <span className="analytics-wrap font-mono text-xs font-medium">{path ?? "–"}</span>
      {path && views.get(path)?.title && <span className="truncate text-2xs text-fg-muted">{views.get(path)!.title}</span>}
    </span>
  );
  const all: Column<PageRow>[] = [
    { id: "path", header: t("table.page"), width: "34%", cell: (p) => page(p.path) },
    { id: "views", header: t("table.views"), align: "right", mono: true, sortValue: (p) => p.views, cell: (p) => f.num(p.views) },
    ...(report?.compare
      ? [
          {
            id: "change",
            header: t("table.change"),
            align: "right" as const,
            mono: true,
            cell: (p: PageRow) => <Change now={p.views} then={before.get(p.path)?.views} />,
          },
        ]
      : []),
    { id: "visitors", header: t("table.visitors"), align: "right", mono: true, sortValue: (p) => p.visitors, cell: (p) => f.num(p.visitors) },
    { id: "time", header: t("table.timeOnPage"), align: "right", sortValue: (p) => p.time ?? -1, cell: (p) => duration(p.time) },
    {
      id: "scroll",
      header: t("table.read"),
      align: "right",
      mono: true,
      sortValue: (p) => p.scroll ?? -1,
      cell: (p) => (p.scroll === null ? "–" : `${p.scroll}%`),
      description: t("table.readDetail"),
    },
  ];
  const b = view === "entry" ? entries : exits;
  const then = b?.compare ? byValue(b.compare.rows) : null;
  const ends: Column<BreakdownRow>[] = [
    { id: "path", header: t("table.page"), width: "40%", cell: (x) => page(x.value) },
    {
      id: "visits",
      header: view === "entry" ? t("table.entries") : t("table.exits"),
      align: "right",
      mono: true,
      sortValue: (x) => x.visits,
      cell: (x) => f.num(x.visits),
    },
    ...(then
      ? [
          {
            id: "change",
            header: t("table.change"),
            align: "right" as const,
            mono: true,
            cell: (x: BreakdownRow) => <Change now={x.visits} then={then.get(x.value)?.visits} />,
          },
        ]
      : []),
    view === "entry"
      ? {
          id: "bounce",
          header: t("table.bounce"),
          align: "right",
          mono: true,
          sortValue: (x) => 1 - (x.engagementRate ?? 1),
          cell: (x) => (x.engagementRate === null ? "–" : f.pct(1 - x.engagementRate)),
        }
      : {
          id: "rate",
          header: t("table.exitRate"),
          align: "right",
          mono: true,
          sortValue: (x) => x.visits / Math.max(1, views.get(x.value ?? "")?.views ?? 0),
          cell: (x) => {
            const v = views.get(x.value ?? "")?.views;
            return v ? f.share(x.visits, v) : "–";
          },
          description: t("table.exitRateDetail"),
        },
  ];
  const total = report?.totals.pageviews ?? 0;
  return (
    <>
      <SegmentedControl
        label={t("behavior.pages")}
        value={view}
        onChange={setView}
        options={[
          { value: "all", label: t("behavior.allPages") },
          { value: "entry", label: t("behavior.entryPages") },
          { value: "exit", label: t("behavior.exitPages") },
        ]}
      />
      {view === "all" ? (
        <Panel
          flush
          title={t("behavior.allPages")}
          description={t("behavior.pageviewsInAll", { count: total, views: f.num(total) })}
          actions={
            <CsvButton
              name="pages"
              rows={report?.pages ?? []}
              columns={[
                [t("table.page"), (p) => p.path],
                [t("table.title"), (p) => p.title],
                [t("table.views"), (p) => p.views],
                [t("table.visitors"), (p) => p.visitors],
                [t("table.secondsOnPage"), (p) => p.time],
                [t("table.readPercent"), (p) => p.scroll],
              ]}
            />
          }
        >
          <DataTable
            label={t("behavior.allPages")}
            columns={all}
            rows={report?.pages ?? []}
            loading={!report}
            getRowId={(p) => p.path}
            defaultSort={{ id: "views", direction: "desc" }}
            minWidth={680}
            pageSize={50}
            empty={none(t("report.noneInPeriod"))}
          />
        </Panel>
      ) : (
        <Panel
          flush
          title={view === "entry" ? t("behavior.entryPages") : t("behavior.exitPages")}
          description={view === "entry" ? t("behavior.entryDetail") : t("behavior.exitDetail")}
          actions={
            <CsvButton
              name={view === "entry" ? "entry-pages" : "exit-pages"}
              rows={b?.rows ?? []}
              columns={[
                [t("table.page"), (x) => x.value],
                [view === "entry" ? t("table.entries") : t("table.exits"), (x) => x.visits],
                [t("table.engagementRate"), (x) => x.engagementRate],
              ]}
            />
          }
        >
          {b === null ? (
            <Failed />
          ) : (
            <DataTable
              key={view}
              label={view === "entry" ? t("behavior.entryPages") : t("behavior.exitPages")}
              columns={ends}
              rows={b?.rows ?? []}
              loading={b === undefined}
              getRowId={(x) => x.value ?? NONE}
              defaultSort={{ id: "visits", direction: "desc" }}
              minWidth={600}
              pageSize={50}
              empty={none(t("report.noneInPeriod"))}
            />
          )}
        </Panel>
      )}
    </>
  );
}

function LinksTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const out = useBreakdown("outbound", { limit: 200 });
  const files = useBreakdown("download", { limit: 200 });
  const table = (kind: "outbound" | "download") => {
    const b = kind === "outbound" ? out : files;
    const title = kind === "outbound" ? t("behavior.outbound") : t("behavior.downloads");
    const cols: Column<BreakdownRow>[] = [
      {
        id: "url",
        header: kind === "outbound" ? t("table.link") : t("table.file"),
        cell: (x) => {
          const ext = /\.([A-Za-z0-9]{1,10})$/.exec(x.value ?? "")?.[1];
          return (
            <span className="flex min-w-0 flex-col">
              <span className="analytics-wrap font-mono text-xs">{x.value ?? "–"}</span>
              {kind === "download" && ext && <span className="text-2xs text-fg-muted">{ext.toUpperCase()}</span>}
            </span>
          );
        },
      },
      {
        id: "count",
        header: kind === "outbound" ? t("table.clicks") : t("table.downloads"),
        align: "right",
        mono: true,
        sortValue: (x) => x.count,
        cell: (x) => f.num(x.count),
      },
      { id: "visitors", header: t("table.visitors"), align: "right", mono: true, sortValue: (x) => x.visitors, cell: (x) => f.num(x.visitors) },
    ];
    return (
      <Panel
        flush
        title={title}
        actions={
          <CsvButton
            name={kind === "outbound" ? "outbound-links" : "downloads"}
            rows={b?.rows ?? []}
            columns={[
              [kind === "outbound" ? t("table.link") : t("table.file"), (x) => x.value],
              [kind === "outbound" ? t("table.clicks") : t("table.downloads"), (x) => x.count],
              [t("table.visitors"), (x) => x.visitors],
            ]}
          />
        }
      >
        {b === null ? (
          <Failed />
        ) : (
          <DataTable
            label={title}
            columns={cols}
            rows={b?.rows ?? []}
            loading={b === undefined}
            getRowId={(x) => x.value ?? NONE}
            minWidth={420}
            defaultSort={{ id: "count", direction: "desc" }}
            pageSize={25}
            empty={none(kind === "outbound" ? t("behavior.noOutbound") : t("behavior.noDownloads"))}
          />
        )}
      </Panel>
    );
  };
  const endings = r.current?.downloads ?? [];
  return (
    <>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {table("outbound")}
        {table("download")}
      </div>
      <Note>{endings.length ? t("behavior.linksNote", { endings: endings.map((e) => `.${e}`).join(", ") }) : t("behavior.linksNoteNoDownloads")}</Note>
    </>
  );
}

function SiteSearchTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const delta = useDelta();
  const data = useLoad<SiteSearch>(r.site ? `/api/v1/sitesearch?${r.query()}` : null);
  const where = r.current?.search ?? null;
  if (data === null) return <Failed />;
  if (!data) return <Loading />;
  if (!where && !data.terms.length)
    return (
      <EmptyState title={t("behavior.searchOff")}>
        <span className="flex flex-col gap-2">
          {t("behavior.searchOffDetail")}
          <Code>{"    search: { path: /search, param: q }"}</Code>
        </span>
      </EmptyState>
    );
  type Term = SiteSearch["terms"][number];
  const then = new Map((data.compare?.terms ?? []).map((x) => [x.term, x]));
  const cols: Column<Term>[] = [
    { id: "term", header: t("table.term"), cell: (x) => <span className="analytics-wrap font-medium">{x.term}</span> },
    { id: "searches", header: t("table.searches"), align: "right", mono: true, sortValue: (x) => x.searches, cell: (x) => f.num(x.searches) },
    ...(data.compare
      ? [
          {
            id: "change",
            header: t("table.change"),
            align: "right" as const,
            mono: true,
            cell: (x: Term) => <Change now={x.searches} then={then.get(x.term)?.searches} />,
          },
        ]
      : []),
    {
      id: "noResults",
      header: t("behavior.noResults"),
      align: "right",
      sortValue: (x) => x.noResults,
      cell: (x) => (x.noResults ? <Badge tone="danger">{f.num(x.noResults)}</Badge> : <span className="font-mono text-fg-muted">0</span>),
    },
    { id: "clicked", header: t("behavior.clicked"), align: "right", mono: true, sortValue: (x) => x.clicked, cell: (x) => f.pct(x.clicked, 0) },
    { id: "refined", header: t("behavior.refined"), align: "right", mono: true, sortValue: (x) => x.refined, cell: (x) => f.pct(x.refined, 0) },
    { id: "left", header: t("behavior.leftAfter"), align: "right", mono: true, sortValue: (x) => x.left, cell: (x) => f.pct(x.left, 0) },
  ];
  const c = data.compare?.totals;
  return (
    <>
      <KpiGrid>
        <KpiCard label={t("behavior.searches")} value={f.num(data.totals.searches)} delta={delta(data.totals.searches, c?.searches)} />
        <KpiCard label={t("behavior.visitsSearched")} value={f.pct(data.totals.visitShare)} unit={t("goals.ofVisits", { visits: f.num(data.totals.visits) })} />
        <KpiCard
          label={t("behavior.noResults")}
          value={f.num(data.totals.noResults)}
          unit={t("behavior.searchesUnit")}
          tone={data.totals.noResults ? "warning" : undefined}
        />
        <KpiCard
          label={t("behavior.leftAfter")}
          value={f.pct(data.totals.left, 0)}
          delta={c ? delta(data.totals.left, c.left, { points: true, lowerIsBetter: true }) : undefined}
        />
      </KpiGrid>
      <Panel
        flush
        title={t("behavior.searchTerms")}
        description={t("behavior.searchTermsDetail")}
        actions={
          <CsvButton
            name="site-search"
            rows={data.terms}
            columns={[
              [t("table.term"), (x) => x.term],
              [t("table.searches"), (x) => x.searches],
              [t("behavior.noResults"), (x) => x.noResults],
              [t("behavior.clicked"), (x) => x.clicked],
              [t("behavior.leftAfter"), (x) => x.left],
            ]}
          />
        }
      >
        <DataTable
          label={t("behavior.searchTerms")}
          columns={cols}
          rows={data.terms}
          getRowId={(x) => x.term}
          defaultSort={{ id: "searches", direction: "desc" }}
          minWidth={720}
          pageSize={50}
          empty={none(t("report.noneInPeriod"))}
        />
      </Panel>
      <Note>
        {where
          ? where.path
            ? t("behavior.searchNote", { params: where.params.join(", "), path: where.path })
            : t("behavior.searchNoteAnyPage", { params: where.params.join(", ") })
          : null}{" "}
        {t("behavior.noResultsNote")}
      </Note>
    </>
  );
}

/* ------------------------------------------------------------ paths */

function PathsTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const pages = useBreakdown("page", { limit: 50 });
  const [picked, setPicked] = useState<string>();
  const [direction, setDirection] = useState<"from" | "to">("from");
  const page = picked ?? pages?.rows[0]?.value ?? null;
  const data = useLoad<Paths>(r.site && page ? `/api/v1/paths?${r.query({ page, direction, steps: "3" }, { compare: false })}` : null);
  if (pages === null) return <Failed />;
  if (!pages) return <Loading />;
  if (!pages.rows.length) return <EmptyState title={t("report.noneInPeriod")} />;
  const next = data?.nodes.filter((n) => n.column === 1) ?? [];
  const name = (n: Paths["nodes"][number]) => (n.exit ? t(direction === "from" ? "paths.left" : "paths.arrived") : n.other ? t("paths.other") : (n.path ?? ""));
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label={direction === "from" ? t("paths.startingAt") : t("paths.endingAt")}
          className="w-72"
          value={page ?? ""}
          onChange={(e) => setPicked(e.target.value)}
          options={pages.rows.map((p) => ({ value: p.value ?? "", label: p.value ?? "" }))}
        />
        <SegmentedControl
          label={t("paths.direction")}
          value={direction}
          onChange={setDirection}
          options={[
            { value: "from", label: t("paths.onward") },
            { value: "to", label: t("paths.before") },
          ]}
        />
      </div>
      {data === null && <Failed />}
      {data === undefined && <Loading />}
      {data && (
        <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_280px]">
          <Panel
            title={t(direction === "from" ? "paths.from" : "paths.to", { page: data.page })}
            description={t(direction === "from" ? "paths.fromDetail" : "paths.toDetail", { visits: f.num(data.visits) })}
          >
            {data.visits ? (
              <PathFlow
                label={t(direction === "from" ? "paths.from" : "paths.to", { page: data.page })}
                nodes={data.nodes.map((n) => ({ ...n, label: name(n) }))}
                links={data.links}
              />
            ) : (
              none(t("report.noneInPeriod"))
            )}
          </Panel>
          <Panel title={t(direction === "from" ? "paths.next" : "paths.previous")} className="self-start">
            {next.length ? (
              <BarList
                label={t(direction === "from" ? "paths.next" : "paths.previous")}
                items={next.map((n) => ({ id: n.id, label: <span className="font-mono text-xs">{name(n)}</span>, value: n.visits }))}
              />
            ) : (
              none(t("report.noneInPeriod"))
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

interface Missing {
  path: string;
  views: number;
  refs: Array<{ ref: string | null; views: number }>;
}

function NotFoundTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const b = useBreakdown("notFound", { limit: 500 });
  const [picked, setPicked] = useState<string>();
  if (b === null) return <Failed />;
  if (!b) return <Loading />;
  const byPath = new Map<string, Missing>();
  for (const x of b.rows) {
    if (!x.value) continue;
    const m = byPath.get(x.value) ?? { path: x.value, views: 0, refs: [] };
    m.views += x.count;
    m.refs.push({ ref: x.group, views: x.count });
    byPath.set(x.value, m);
  }
  const rows = [...byPath.values()].map((m) => ({ ...m, refs: m.refs.sort((a, b) => b.views - a.views) })).sort((a, b) => b.views - a.views);
  const before = new Map<string, number>();
  for (const x of b.compare?.rows ?? []) if (x.value) before.set(x.value, (before.get(x.value) ?? 0) + x.count);
  const chosen = rows.find((m) => m.path === picked) ?? rows[0];
  const top = (m: Missing) => m.refs.find((x) => x.ref) ?? null;
  const cols: Column<Missing>[] = [
    { id: "path", header: t("table.address"), cell: (m) => <span className="analytics-wrap font-mono text-xs font-medium">{m.path}</span> },
    { id: "views", header: t("table.views"), align: "right", mono: true, sortValue: (m) => m.views, cell: (m) => f.num(m.views) },
    ...(b.compare
      ? [
          {
            id: "change",
            header: t("table.change"),
            align: "right" as const,
            mono: true,
            cell: (m: Missing) => <Change now={m.views} then={before.get(m.path)} lowerIsBetter />,
          },
        ]
      : []),
    {
      id: "from",
      header: t("table.mostFrom"),
      cell: (m) => {
        const x = top(m);
        return x ? <span className="analytics-wrap font-mono text-xs">{x.ref}</span> : <span className="text-xs text-fg-muted">{t("behavior.noLink")}</span>;
      },
    },
  ];
  return (
    <>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel
          flush
          title={t("behavior.notfound")}
          description={r.current?.notFound ? t("behavior.notFoundTitle", { title: r.current.notFound.title }) : t("behavior.notFoundMeta")}
          actions={
            <CsvButton
              name="not-found"
              rows={b.rows.filter((x) => x.value)}
              columns={[
                [t("table.address"), (x) => x.value],
                [t("table.linkedFrom"), (x) => x.group],
                [t("table.views"), (x) => x.count],
              ]}
            />
          }
        >
          <DataTable
            label={t("behavior.notFoundPages")}
            columns={cols}
            rows={rows}
            getRowId={(m) => m.path}
            minWidth={460}
            onRowClick={(m) => setPicked(m.path)}
            activeRowId={chosen?.path}
            defaultSort={{ id: "views", direction: "desc" }}
            pageSize={50}
            empty={none(t("behavior.noneNotFound"))}
          />
        </Panel>
        {chosen && (
          <Panel aria-label={t("behavior.linksTo", { path: chosen.path })} title={t("behavior.linksTo", { path: chosen.path })} className="self-start">
            <ul className="analytics-list flex flex-col">
              {chosen.refs.map((x) => (
                <li key={x.ref ?? NONE} className="flex items-center justify-between gap-2 border-b border-subtle py-1.5 text-xs last:border-0">
                  <span className={x.ref ? "analytics-wrap min-w-0 font-mono text-fg" : "text-fg-muted"}>
                    {x.ref ? (x.ref.startsWith("/") ? t("behavior.ownPage", { path: x.ref }) : x.ref) : t("behavior.noLink")}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">{f.num(x.views)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
      {chosen && top(chosen) && (
        <Callout tone="warning" title={t("behavior.fixLink", { from: top(chosen)!.ref!, path: chosen.path })}>
          {top(chosen)!.ref!.startsWith("/") ? t("behavior.fixOwnLink") : t("behavior.fixOtherLink")}
        </Callout>
      )}
    </>
  );
}

type Element = Frustration["elements"][number];

function FrustrationTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const delta = useDelta();
  const data = useLoad<Frustration>(r.site ? `/api/v1/frustration?${r.query()}` : null);
  if (data === null) return <Failed />;
  if (!data) return <Loading />;
  const was = data.compare?.totals;
  const replays = !!r.current?.replays;
  const cols: Column<Element>[] = [
    {
      id: "el",
      header: t("table.element"),
      width: "40%",
      cell: (x) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{x.text ?? x.target ?? "–"}</span>
          <code className="analytics-wrap text-2xs text-fg-muted">
            {x.path} · {x.target ?? "–"}
          </code>
        </span>
      ),
    },
    {
      id: "rage",
      header: t("table.rage"),
      align: "right",
      sortValue: (x) => x.rage,
      cell: (x) => (x.rage >= 20 ? <Badge tone="danger">{f.num(x.rage)}</Badge> : <span className="font-mono">{f.num(x.rage)}</span>),
      description: t("table.rageDetail"),
    },
    {
      id: "dead",
      header: t("table.dead"),
      align: "right",
      sortValue: (x) => x.dead,
      cell: (x) => (x.dead >= 50 ? <Badge tone="warning">{f.num(x.dead)}</Badge> : <span className="font-mono">{f.num(x.dead)}</span>),
      description: t("table.deadDetail"),
    },
    { id: "visitors", header: t("table.visitors"), align: "right", mono: true, sortValue: (x) => x.visitors, cell: (x) => f.num(x.visitors) },
    ...(replays
      ? [
          {
            id: "replays",
            header: t("table.replays"),
            align: "right" as const,
            cell: (x: Element) => (
              <a href={r.href("/replays", [{ dimension: "page", op: "is", values: [x.path] }])} className="text-xs text-accent-text">
                {t("behavior.watchReplays")}
              </a>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <KpiGrid>
        <KpiCard
          label={t("behavior.rageClicks")}
          value={f.num(data.totals.rage)}
          tone="danger"
          delta={delta(data.totals.rage, was?.rage, { lowerIsBetter: true })}
        />
        <KpiCard
          label={t("behavior.deadClicks")}
          value={f.num(data.totals.dead)}
          tone="warning"
          delta={delta(data.totals.dead, was?.dead, { lowerIsBetter: true })}
        />
        <KpiCard
          label={t("behavior.rageVisits")}
          value={f.num(data.totals.rageVisits)}
          delta={delta(data.totals.rageVisits, was?.rageVisits, { lowerIsBetter: true })}
        />
        <KpiCard
          label={t("behavior.deadVisits")}
          value={f.num(data.totals.deadVisits)}
          delta={delta(data.totals.deadVisits, was?.deadVisits, { lowerIsBetter: true })}
        />
      </KpiGrid>
      <Panel
        flush
        title={t("behavior.inVain")}
        description={t("behavior.inVainDetail", { clicks: f.num(data.totals.clicks) })}
        actions={
          <CsvButton
            name="frustration"
            rows={data.elements}
            columns={[
              [t("table.page"), (x) => x.path],
              [t("table.element"), (x) => x.target],
              [t("table.text"), (x) => x.text],
              [t("table.rage"), (x) => x.rage],
              [t("table.dead"), (x) => x.dead],
              [t("table.visitors"), (x) => x.visitors],
            ]}
          />
        }
      >
        <DataTable
          label={t("behavior.frustration")}
          columns={cols}
          rows={data.elements}
          getRowId={(x) => `${x.path}|${x.target}`}
          defaultSort={{ id: "dead", direction: "desc" }}
          minWidth={720}
          pageSize={50}
          empty={none(t("behavior.noFrustration"))}
        />
      </Panel>
      <Panel
        flush
        title={t("behavior.byPage")}
        actions={
          <CsvButton
            name="frustration-by-page"
            rows={data.pages}
            columns={[
              [t("table.page"), (x) => x.path],
              [t("table.clicks"), (x) => x.clicks],
              [t("table.rage"), (x) => x.rage],
              [t("table.dead"), (x) => x.dead],
              [t("table.visits"), (x) => x.visits],
            ]}
          />
        }
      >
        <DataTable
          label={t("behavior.byPage")}
          columns={[
            { id: "path", header: t("table.page"), cell: (x) => <span className="analytics-wrap font-mono text-xs font-medium">{x.path}</span> },
            { id: "clicks", header: t("table.clicks"), align: "right", mono: true, sortValue: (x) => x.clicks, cell: (x) => f.num(x.clicks) },
            { id: "rage", header: t("table.rage"), align: "right", mono: true, sortValue: (x) => x.rage, cell: (x) => f.num(x.rage) },
            { id: "dead", header: t("table.dead"), align: "right", mono: true, sortValue: (x) => x.dead, cell: (x) => f.num(x.dead) },
            {
              id: "share",
              header: t("table.inVainShare"),
              align: "right",
              mono: true,
              sortValue: (x) => (x.rage + x.dead) / Math.max(1, x.clicks),
              cell: (x) => f.share(x.rage + x.dead, x.clicks),
            },
            { id: "visits", header: t("table.visits"), align: "right", mono: true, sortValue: (x) => x.visits, cell: (x) => f.num(x.visits) },
          ]}
          rows={data.pages}
          getRowId={(x) => x.path}
          defaultSort={{ id: "dead", direction: "desc" }}
          minWidth={600}
          empty={none(t("behavior.noFrustration"))}
        />
      </Panel>
      <Note>{t("behavior.frustrationNote")}</Note>
    </>
  );
}
