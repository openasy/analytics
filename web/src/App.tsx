import {
  AppShell,
  Badge,
  BarList,
  BrandProvider,
  Button,
  DataTable,
  Dialog,
  DonutChart,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  OverviewGrid,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SearchInput,
  SelectField,
  StatusBadge,
  TimeSeriesChart,
  toLocale,
  usePath,
  useAgo,
  useLocalePreference,
  useThemePreference,
  CHART_COLORS,
  type Column,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  Activity,
  Clock,
  Download,
  CirclePlay,
  ClipboardList,
  Eye,
  FileText,
  Flame,
  Funnel,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  MousePointerClick,
  Radio,
  Share2,
  Trash2,
  TrendingDown,
  UserRound,
  Users,
  Route as RouteIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ProductLink, type Report, type Site, type Summary, type Visit, type VisitDetail } from "./api.ts";
import { Code, duration, nothing, percent, ReportHeader, shortDay, time, useApi, useChoice, useReport, type Call, type Choice } from "./common.tsx";
import { useT } from "./i18n.ts";
import { FormsPage, FunnelsPage, HeatmapsPage, ReplayPage, ReplaysPage } from "./insights.tsx";
import { search } from "./search.ts";

const PAGES = [
  "pages",
  "sources",
  "behavior",
  "funnels",
  "forms",
  "heatmaps",
  "replays",
  "visits",
  "sites",
  "setup",
  "account",
  "members",
  "signin",
  "tokens",
  "about",
] as const;
type Route = { page: "overview" | (typeof PAGES)[number] } | { page: "visit" | "replay"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "visits" && id) return { page: "visit", id: decodeURIComponent(id) };
  if (page === "replays" && id) return { page: "replay", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "overview" };
}

// ---------------------------------------------------------------- Overview

function OverviewPage({ call, sites, choice }: { call: Call; sites: Site[]; choice: Choice }) {
  const t = useT();
  const r = useReport(call, choice);
  const devices: Record<string, string> = { desktop: t("device.desktop"), mobile: t("device.mobile"), tablet: t("device.tablet") };
  return (
    <>
      <ReportHeader title={t("overview.title")} description={t("overview.description", { site: choice.site })} sites={sites} choice={choice} />
      {r && (
        <KpiGrid minWidth={150}>
          <KpiCard label={t("overview.visitors")} value={r.totals.visitors} icon={Users} tone="info" trend={r.series.map((d) => d.visitors)} />
          <KpiCard label={t("overview.visits")} value={r.totals.visits} icon={Activity} trend={r.series.map((d) => d.visits)} />
          <KpiCard label={t("overview.pageviews")} value={r.totals.pageviews} icon={Eye} trend={r.series.map((d) => d.pageviews)} />
          <KpiCard label={t("overview.bounceRate")} value={percent(r.totals.bounceRate)} icon={TrendingDown} />
          <KpiCard label={t("overview.visitLength")} value={duration(r.totals.duration)} icon={Clock} />
        </KpiGrid>
      )}
      {r && (
        <Panel title={t("overview.overTime")} description={t("overview.overTimeDetail")}>
          <TimeSeriesChart
            label={t("overview.overTime")}
            series={[
              { id: "visitors", name: t("overview.visitors"), data: r.series.map((d) => d.visitors) },
              { id: "pageviews", name: t("overview.pageviews"), data: r.series.map((d) => d.pageviews) },
            ]}
            labels={r.series.map((d) => shortDay(d.day))}
            height={180}
            xTicks={7}
            area
          />
        </Panel>
      )}
      {r && (
        <OverviewGrid layout="halves">
          <Panel title={t("overview.topPages")} description={t("overview.topPagesDetail")} footer={<a href="/pages">{t("overview.allPages")}</a>}>
            {r.pages.length ? (
              <BarList
                label={t("overview.topPages")}
                items={r.pages.slice(0, 8).map((p) => ({ id: p.path, label: <span className="font-mono text-xs">{p.path}</span>, value: p.views }))}
              />
            ) : (
              nothing(t)
            )}
          </Panel>
          <Panel title={t("overview.sources")} description={t("overview.sourcesDetail")} footer={<a href="/sources">{t("overview.allSources")}</a>}>
            {r.sources.length ? (
              <BarList
                label={t("overview.sources")}
                items={r.sources.slice(0, 8).map((s) => ({ id: s.source ?? "", label: s.source ?? t("sources.direct"), value: s.visits }))}
              />
            ) : (
              nothing(t)
            )}
          </Panel>
        </OverviewGrid>
      )}
      {r && r.totals.visits > 0 && (
        <OverviewGrid layout="halves">
          <Panel title={t("overview.devices")}>
            <DonutChart
              label={t("overview.devices")}
              caption={t("overview.visits")}
              slices={r.devices.map((d, i) => ({
                id: d.name,
                name: devices[d.name] ?? d.name,
                value: d.visits,
                color: CHART_COLORS[i % CHART_COLORS.length]!,
              }))}
            />
          </Panel>
          <Panel title={t("overview.goals")} description={t("overview.goalsDetail")} footer={<a href="/behavior">{t("overview.allBehavior")}</a>}>
            {r.goals.length ? (
              <BarList label={t("overview.goals")} items={r.goals.map((g) => ({ id: g.name, label: g.name, value: g.visits }))} />
            ) : (
              <EmptyState title={t("overview.noGoals")}>{t("overview.noGoalsDetail")}</EmptyState>
            )}
          </Panel>
        </OverviewGrid>
      )}
      {r === null && <EmptyState title={t("report.failed")} />}
    </>
  );
}

// ---------------------------------------------------------------- Pages

function PagesPage({ call, sites, choice }: { call: Call; sites: Site[]; choice: Choice }) {
  const t = useT();
  const r = useReport(call, choice);
  const columns: Column<Report["pages"][number]>[] = [
    {
      id: "path",
      header: t("pages.page"),
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="analytics-wrap font-mono text-xs">{p.path}</span>
          {p.title && <span className="analytics-clamp text-xs text-fg-muted">{p.title}</span>}
        </span>
      ),
    },
    { id: "views", header: t("pages.views"), align: "right", sortValue: (p) => p.views, cell: (p) => p.views },
    { id: "visitors", header: t("pages.visitors"), align: "right", sortValue: (p) => p.visitors, cell: (p) => p.visitors },
    { id: "time", header: t("pages.time"), align: "right", sortValue: (p) => p.time ?? -1, cell: (p) => duration(p.time) },
    { id: "scroll", header: t("pages.scroll"), align: "right", sortValue: (p) => p.scroll ?? -1, cell: (p) => (p.scroll === null ? "–" : `${p.scroll}%`) },
  ];
  const list = (rows: Report["entries"], label: string) =>
    rows.length ? (
      <BarList
        label={label}
        items={rows.map((e) => ({ id: e.path ?? "", label: <span className="font-mono text-xs">{e.path ?? "–"}</span>, value: e.visits }))}
      />
    ) : (
      nothing(t)
    );
  return (
    <>
      <ReportHeader title={t("pages.title")} description={t("pages.description")} sites={sites} choice={choice} />
      <Panel flush>
        <DataTable
          label={t("pages.title")}
          columns={columns}
          rows={r?.pages ?? []}
          loading={r === undefined}
          getRowId={(p) => p.path}
          minWidth={640}
          pageSize={50}
          empty={nothing(t)}
        />
      </Panel>
      {r && (
        <OverviewGrid layout="halves">
          <Panel title={t("pages.entries")} description={t("pages.entriesDetail")}>
            {list(r.entries, t("pages.entries"))}
          </Panel>
          <Panel title={t("pages.exits")} description={t("pages.exitsDetail")}>
            {list(r.exits, t("pages.exits"))}
          </Panel>
        </OverviewGrid>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Sources

function SourcesPage({ call, sites, choice }: { call: Call; sites: Site[]; choice: Choice }) {
  const t = useT();
  const r = useReport(call, choice);
  const named = (rows: Array<{ name: string; visits: number }>, label: string) =>
    rows.length ? <BarList label={label} items={rows.map((b) => ({ id: b.name, label: b.name, value: b.visits }))} /> : nothing(t);
  return (
    <>
      <ReportHeader title={t("sources.title")} description={t("sources.description")} sites={sites} choice={choice} />
      <Panel title={t("sources.referrers")} description={t("sources.referrersDetail")} flush>
        <DataTable
          label={t("sources.referrers")}
          columns={[
            { id: "source", header: t("sources.source"), cell: (s) => s.source ?? <span className="text-fg-muted">{t("sources.direct")}</span> },
            { id: "visits", header: t("sources.visits"), align: "right", sortValue: (s) => s.visits, cell: (s) => s.visits },
            { id: "visitors", header: t("sources.visitors"), align: "right", sortValue: (s) => s.visitors, cell: (s) => s.visitors },
          ]}
          rows={r?.sources ?? []}
          loading={r === undefined}
          getRowId={(s) => s.source ?? ""}
          minWidth={480}
          empty={nothing(t)}
        />
      </Panel>
      <Panel title={t("sources.campaigns")} description={t("sources.campaignsDetail")} flush>
        <DataTable
          label={t("sources.campaigns")}
          columns={[
            { id: "source", header: "utm_source", mono: true, cell: (c) => c.source ?? "–" },
            { id: "medium", header: "utm_medium", mono: true, cell: (c) => c.medium ?? "–" },
            { id: "campaign", header: "utm_campaign", mono: true, cell: (c) => c.campaign ?? "–" },
            { id: "visits", header: t("sources.visits"), align: "right", sortValue: (c) => c.visits, cell: (c) => c.visits },
          ]}
          rows={r?.campaigns ?? []}
          loading={r === undefined}
          getRowId={(c) => `${c.source}|${c.medium}|${c.campaign}`}
          minWidth={560}
          empty={<EmptyState title={t("sources.noCampaigns")}>{t("sources.noCampaignsDetail")}</EmptyState>}
        />
      </Panel>
      {r && (
        <OverviewGrid layout="halves">
          <Panel title={t("sources.browsers")}>{named(r.browsers, t("sources.browsers"))}</Panel>
          <Panel title={t("sources.systems")}>{named(r.systems, t("sources.systems"))}</Panel>
        </OverviewGrid>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Behaviour

function BehaviorPage({ call, sites, choice }: { call: Call; sites: Site[]; choice: Choice }) {
  const t = useT();
  const r = useReport(call, choice);
  return (
    <>
      <ReportHeader title={t("behavior.title")} description={t("behavior.description")} sites={sites} choice={choice} />
      <Panel title={t("behavior.goals")} description={t("behavior.goalsDetail")} flush>
        <DataTable
          label={t("behavior.goals")}
          columns={[
            { id: "name", header: t("behavior.goal"), cell: (g) => <span className="font-medium">{g.name}</span> },
            { id: "when", header: t("behavior.reached"), mono: true, cell: (g) => (g.path ? g.path : t("behavior.event", { name: g.event ?? "" })) },
            { id: "visits", header: t("behavior.visits"), align: "right", sortValue: (g) => g.visits, cell: (g) => g.visits },
            { id: "rate", header: t("behavior.rate"), align: "right", sortValue: (g) => g.rate, cell: (g) => percent(g.rate) },
          ]}
          rows={r?.goals ?? []}
          loading={r === undefined}
          getRowId={(g) => g.name}
          minWidth={560}
          empty={<EmptyState title={t("overview.noGoals")}>{t("overview.noGoalsDetail")}</EmptyState>}
        />
      </Panel>
      <Panel title={t("behavior.events")} description={t("behavior.eventsDetail")} flush>
        <DataTable
          label={t("behavior.events")}
          columns={[
            { id: "name", header: t("behavior.name"), mono: true, cell: (e) => e.name },
            { id: "count", header: t("behavior.count"), align: "right", sortValue: (e) => e.count, cell: (e) => e.count },
            { id: "visitors", header: t("behavior.visitors"), align: "right", sortValue: (e) => e.visitors, cell: (e) => e.visitors },
          ]}
          rows={r?.events ?? []}
          loading={r === undefined}
          getRowId={(e) => e.name}
          minWidth={480}
          empty={<EmptyState title={t("behavior.noEvents")}>{t("behavior.noEventsDetail")}</EmptyState>}
        />
      </Panel>
      <Panel title={t("behavior.clicks")} description={t("behavior.clicksDetail")} flush>
        <DataTable
          label={t("behavior.clicks")}
          columns={[
            {
              id: "element",
              header: t("behavior.element"),
              cell: (c) => (
                <span className="flex min-w-0 flex-col">
                  <span className="analytics-clamp">{c.text ?? "–"}</span>
                  <span className="analytics-wrap font-mono text-xs text-fg-muted">{c.target}</span>
                </span>
              ),
            },
            { id: "href", header: t("behavior.link"), cell: (c) => <span className="analytics-wrap font-mono text-xs">{c.href ?? "–"}</span> },
            { id: "count", header: t("behavior.count"), align: "right", sortValue: (c) => c.count, cell: (c) => c.count },
            { id: "visitors", header: t("behavior.visitors"), align: "right", sortValue: (c) => c.visitors, cell: (c) => c.visitors },
          ]}
          rows={r?.clicks ?? []}
          loading={r === undefined}
          getRowId={(c) => `${c.target}|${c.text}|${c.href}`}
          minWidth={720}
          empty={nothing(t)}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Visits

function VisitsPage({ call, sites, choice }: { call: Call; sites: Site[]; choice: Choice }) {
  const t = useT();
  const ago = useAgo();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Visit[]>();
  const [more, setMore] = useState<string>();
  const query = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams({ site: choice.site, limit: "100" });
      // An id the site gave the person is searched as a user; the script's ids start the same way every time.
      const id = q.trim();
      if (id) p.set(/^[A-Za-z0-9_-]{22}$/.test(id) ? "visitor" : "user", id);
      if (cursor) p.set("cursor", cursor);
      return call<{ visits: Visit[]; nextCursor?: string }>(`/api/v1/visits?${p}`);
    },
    [call, choice.site, q],
  );
  useEffect(() => {
    if (!choice.site) return;
    void query().then(
      (r) => (setRows(r.visits), setMore(r.nextCursor)),
      () => setRows([]),
    );
  }, [query, choice.site]);
  const loadMore = () => more && query(more).then((r) => (setRows((x) => [...(x ?? []), ...r.visits]), setMore(r.nextCursor)));
  const columns: Column<Visit>[] = [
    {
      id: "when",
      header: t("visits.when"),
      sortValue: (v) => v.lastAt,
      cell: (v) => (
        <a href={`/visits/${encodeURIComponent(v.id)}`} className="text-xs whitespace-nowrap">
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
    { id: "source", header: t("visits.source"), cell: (v) => <span className="text-xs">{v.source ?? t("sources.direct")}</span> },
    { id: "device", header: t("visits.device"), cell: (v) => <span className="text-xs">{`${v.browser}, ${v.os}`}</span> },
    { id: "user", header: t("visits.user"), mono: true, cell: (v) => v.user ?? "–" },
  ];
  return (
    <>
      <PageHeader
        title={t("visits.title")}
        description={t("visits.description")}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <SearchInput label={t("visits.search")} className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />
            {sites.length > 1 && (
              <SelectField
                aria-label={t("choice.site")}
                value={choice.site}
                onChange={(e) => choice.setSite(e.target.value)}
                options={sites.map((s) => ({ value: s.name, label: s.name }))}
              />
            )}
          </span>
        }
      />
      <Panel
        flush
        footer={
          more ? (
            <Button size="sm" onClick={loadMore}>
              {t("visits.loadMore")}
            </Button>
          ) : undefined
        }
      >
        <DataTable
          label={t("visits.title")}
          columns={columns}
          rows={rows ?? []}
          loading={!rows}
          getRowId={(v) => v.id}
          minWidth={860}
          pageSize={50}
          empty={nothing(t)}
        />
      </Panel>
    </>
  );
}

function VisitPage({ call, id, choice }: { call: Call; id: string; choice: Choice }) {
  const t = useT();
  const { can } = useAuth();
  const [visit, setVisit] = useState<VisitDetail | null>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(
    () => void call<VisitDetail>(`/api/v1/visits/${encodeURIComponent(id)}?site=${encodeURIComponent(choice.site)}`).then(setVisit, () => setVisit(null)),
    [call, id, choice.site],
  );

  const visitor = visit ? `/api/v1/visitors/${encodeURIComponent(visit.visitor)}?site=${encodeURIComponent(visit.site)}` : "";
  const exportData = async () => {
    try {
      const data = await call<unknown>(visitor);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      a.download = `visitor-${visit!.visitor}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = () =>
    call(visitor, { method: "DELETE" }).then(
      () => (setDeleting(false), navigate("/visits")),
      (err: Error) => setError(err.message),
    );

  if (visit === null)
    return (
      <EmptyState title={t("visit.notFound")}>
        {t("visit.notFoundDetail")} <a href="/visits">{t("visit.back")}</a>.
      </EmptyState>
    );
  const step = (e: VisitDetail["timeline"][number]) => {
    if (e.type === "pageview") return { label: t("visit.viewed"), detail: `${e.path}${e.query ?? ""}`, note: e.title };
    if (e.type === "leave")
      return {
        label: t("visit.left"),
        detail: e.path,
        note: t("visit.leftDetail", { time: duration(e.duration === null ? null : e.duration / 1000), scroll: e.scroll ?? 0 }),
      };
    if (e.type === "click") return { label: t("visit.clicked"), detail: e.text ?? e.target, note: e.href ? `→ ${e.href}` : e.target };
    if (e.type === "form") {
      const field = e.field ? t("visit.field", { field: e.field, kind: e.kind ?? "" }) : null;
      if (e.action === "start") return { label: t("visit.formStarted"), detail: e.form, note: field };
      if (e.action === "submit") return { label: t("visit.formSent"), detail: e.form, note: null };
      if (e.action === "abandon") return { label: t("visit.formLeft"), detail: e.form, note: field && t("visit.formLeftAt", { field: e.field ?? "" }) };
      return {
        label: t("visit.fieldLeft"),
        detail: e.field,
        note: [duration(e.duration === null ? null : e.duration / 1000), e.filled ? t("visit.filled") : t("visit.empty"), e.again ? t("visit.again") : null]
          .filter(Boolean)
          .join(", "),
      };
    }
    return {
      label: t("visit.event"),
      detail: e.name,
      note: e.props
        ? Object.entries(e.props)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        : null,
    };
  };
  return (
    <>
      <PageHeader
        title={t("visit.title")}
        description={visit ? `${time(visit.startedAt)} · ${visit.browser}, ${visit.os} · ${visit.source ?? t("sources.direct")}` : undefined}
        actions={
          visit && (
            <>
              {visit.replay && (
                <Button icon={<CirclePlay />} variant="primary" onClick={() => navigate(`/replays/${encodeURIComponent(visit.id)}`)}>
                  {t("visit.watch")}
                </Button>
              )}
              {can("admin") && (
                <>
                  <Button icon={<Download />} onClick={() => void exportData()}>
                    {t("visit.export")}
                  </Button>
                  <Button icon={<Trash2 />} onClick={() => setDeleting(true)}>
                    {t("visit.delete")}
                  </Button>
                </>
              )}
            </>
          )
        }
      />
      {error && <p className="m-0 text-sm text-danger">{error}</p>}
      {visit && (
        <>
          <KpiGrid minWidth={150}>
            <KpiCard label={t("visit.length")} value={duration(visit.duration)} icon={Clock} />
            <KpiCard label={t("visit.pages")} value={visit.pageviews} icon={Eye} />
            <KpiCard label={t("visit.actions")} value={visit.events} icon={MousePointerClick} />
          </KpiGrid>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge mono>{t("visit.visitor", { id: visit.visitor })}</Badge>
            {visit.user && <Badge mono>{t("visit.user", { id: visit.user })}</Badge>}
            {visit.utm.campaign && <Badge>{t("visit.campaign", { name: visit.utm.campaign })}</Badge>}
            <Badge>{t(`device.${visit.device}` as "device.desktop")}</Badge>
            {visit.rage > 0 && <Badge tone="warning">{t("replay.rage", { count: visit.rage })}</Badge>}
          </div>
          <Panel title={t("visit.timeline")} description={t("visit.timelineDetail")}>
            <ol className="analytics-list flex flex-col gap-2">
              {visit.timeline.map((e, i) => {
                const s = step(e);
                return (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="w-24 shrink-0 font-mono text-xs whitespace-nowrap text-fg-muted">
                      {new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span>
                        <span className="font-medium">{s.label}</span> <span className="analytics-wrap font-mono text-xs">{s.detail}</span>
                      </span>
                      {s.note && <span className="analytics-wrap text-xs text-fg-muted">{s.note}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Panel>
        </>
      )}
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("visit.deleteTitle")}
        description={t("visit.deleteDetail")}
        footer={
          <>
            <Button type="button" onClick={() => setDeleting(false)}>
              {t("visit.cancel")}
            </Button>
            <Button type="button" variant="primary" onClick={() => void remove()}>
              {t("visit.delete")}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm">{t("visit.deleteNote")}</p>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- Sites

const EXAMPLE = `sites:
  - name: shop
    domains: [https://www.example.com, https://example.com]
    # consent: required   # nothing is sent or stored until the page calls openasy.consent(true)
    query: [q]            # query parameters kept besides utm_*
    ignore: [/admin/*]    # paths that are not recorded
    keep: { events: 90d, days: 730d }
    goals:
      - { name: Bought, path: /checkout/done }
      - { name: Signed up, event: signup }
    funnels:              # steps a visit takes in order
      - name: Trial
        steps:
          - { name: Pricing, path: /pricing }
          - { name: Signed up, event: signup }
    forms: true           # which form fields are entered and left, never what they hold
    replays: { sample: 10%, keep: 30d }   # record a share of visits, with every field masked
    # serverKey: ANALYTICS_SHOP_KEY   # the variable that holds the key for events from your servers`;

function FileState({ summary }: { summary?: Summary }) {
  const t = useT();
  const ago = useAgo();
  const file = summary?.file;
  if (!file) return null;
  return (
    <Panel
      title={t("sites.file")}
      description={file.path}
      actions={file.error ? <StatusBadge tone="danger">{t("sites.notApplied")}</StatusBadge> : <StatusBadge tone="success">{t("sites.applied")}</StatusBadge>}
    >
      <div className="flex flex-col gap-1 text-sm">
        {file.appliedAt && <span className="text-fg-muted">{t("sites.appliedAt", { ago: ago(file.appliedAt), count: file.sites })}</span>}
        {file.error && <span className="text-danger">{file.error}</span>}
        {file.error && file.appliedAt && <span className="text-fg-muted">{t("sites.lastGoodStays")}</span>}
        {file.warnings.map((w) => (
          <span key={w} className="text-warning">
            {w}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function SitesPage({ sites, summary }: { sites: Site[]; summary?: Summary }) {
  const t = useT();
  const ago = useAgo();
  const columns: Column<Site>[] = [
    { id: "name", header: t("sites.site"), sortValue: (s) => s.name, cell: (s) => <span className="font-medium">{s.name}</span> },
    { id: "domains", header: t("sites.domains"), cell: (s) => <span className="analytics-wrap font-mono text-xs">{s.domains.join(", ")}</span> },
    {
      id: "consent",
      header: t("sites.consent"),
      cell: (s) => (s.consent === "required" ? <Badge tone="info">{t("sites.asksFirst")}</Badge> : <Badge>{t("sites.fromFirstPage")}</Badge>),
    },
    {
      id: "records",
      header: t("sites.records"),
      cell: (s) => (
        <span className="flex flex-wrap gap-1">
          {s.funnels.length > 0 && <Badge>{t("sites.funnels", { count: s.funnels.length })}</Badge>}
          {s.forms && <Badge>{t("sites.forms")}</Badge>}
          {s.replays && <Badge tone="info">{t("sites.replays", { sample: s.replays.sample })}</Badge>}
        </span>
      ),
    },
    {
      id: "today",
      header: t("sites.today"),
      align: "right",
      sortValue: (s) => s.today.visitors,
      cell: (s) => t("sites.todayValue", { visitors: s.today.visitors, pageviews: s.today.pageviews }),
    },
    { id: "last", header: t("sites.lastEvent"), cell: (s) => <span className="text-xs">{ago(s.lastEventAt)}</span> },
  ];
  return (
    <>
      <PageHeader title={t("sites.title")} description={t("sites.description")} />
      <FileState summary={summary} />
      <Panel flush>
        <DataTable
          label={t("sites.title")}
          columns={columns}
          rows={sites}
          getRowId={(s) => s.name}
          minWidth={860}
          empty={<EmptyState title={t("sites.none")}>{t("sites.noneDetail")}</EmptyState>}
        />
      </Panel>
      {sites.map((s) => (
        <Panel key={s.name} title={t("sites.scriptFor", { site: s.name })} description={t("sites.scriptDetail")}>
          <div className="flex flex-col gap-2">
            <Code>{`<script defer src="${s.script}"></script>`}</Code>
            {s.serverKey && !s.serverKey.set && <span className="text-sm text-warning">{t("sites.keyMissing", { variable: s.serverKey.variable })}</span>}
          </div>
        </Panel>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- Setup

function SetupPage({ summary }: { summary?: Summary }) {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setup.title")} description={t("setup.description")} />
      <FileState summary={summary} />
      <Panel title={t("setup.step1")} description={t("setup.step1Detail", { path: summary?.file?.path ?? "/config/analytics.yaml" })}>
        <Code>{EXAMPLE}</Code>
      </Panel>
      <Panel title={t("setup.step2")} description={t("setup.step2Detail")}>
        <Code>{`<script defer src="${origin}/s/shop.js"></script>`}</Code>
      </Panel>
      <Panel title={t("setup.step3")} description={t("setup.step3Detail")}>
        <Code>{`openasy.track("signup", { plan: "pro" });   // one of your own events
openasy.identify("u-42");                     // your own id for the person, never an email
openasy.consent(true);                        // on a site with consent: required
openasy.consent(false);                       // stops, and deletes what was kept about this visitor

<button data-analytics="Start trial">Go</button>   <!-- names a click -->
<div data-analytics-mask>…</div>                  <!-- its text is never sent -->`}</Code>
      </Panel>
      <Panel title={t("setup.step4")} description={t("setup.step4Detail")}>
        <Code>{`curl -sf -X POST ${origin}/api/v1/collect -H "x-analytics-key: $ANALYTICS_SHOP_KEY" -d '{
  "site": "shop", "visitor": "<from openasy.ids()>", "session": "<from openasy.ids()>",
  "events": [{ "type": "event", "url": "https://www.example.com/checkout", "name": "paid", "props": { "total": 120 } }]
}'`}</Code>
      </Panel>
      <Panel title={t("setup.kept")}>
        <ul className="analytics-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>{t("setup.kept1")}</li>
          <li>{t("setup.kept2")}</li>
          <li>{t("setup.kept3")}</li>
          <li>{t("setup.kept4")}</li>
        </ul>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settings.adminsOnly")}>{t("settings.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settings.${page}`)}
        description={t(`settings.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settings.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [sites, setSites] = useState<Site[]>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const choice = useChoice(sites);
  const onSearch = useMemo(() => search(call, msg, choice.site), [call, msg, choice.site]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "analytics" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<{ sites: Site[] }>("/api/v1/sites").then(
      (r) => setSites(r.sites),
      () => {},
    );
  }, [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "pages", label: msg("nav.pages"), icon: FileText },
    { id: "sources", label: msg("nav.sources"), icon: Share2 },
    { id: "behavior", label: msg("nav.behavior"), icon: MousePointerClick },
    { id: "funnels", label: msg("nav.funnels"), icon: Funnel },
    { id: "forms", label: msg("nav.forms"), icon: ClipboardList },
    { id: "heatmaps", label: msg("nav.heatmaps"), icon: Flame },
    { id: "replays", label: msg("nav.replays"), icon: CirclePlay },
    { id: "visits", label: msg("nav.visits"), icon: RouteIcon, count: summary?.live || undefined },
    { id: "sites", label: msg("nav.sites"), icon: Globe, count: summary?.sites },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "visit" ? "visits" : route.page === "replay" ? "replays" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const reports = ["overview", "pages", "sources", "behavior", "funnels", "forms", "heatmaps", "replays", "visits"].includes(route.page);
  const list = sites ?? [];

  return (
    <AppShell
      product="analytics"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {summary && summary.live > 0 && reports && (
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Radio className="size-3.5 text-success" aria-hidden /> {msg("live", { count: summary.live })}
        </span>
      )}
      {reports && sites && sites.length === 0 ? (
        <SetupPage summary={summary} />
      ) : route.page === "overview" ? (
        <OverviewPage call={call} sites={list} choice={choice} />
      ) : route.page === "pages" ? (
        <PagesPage call={call} sites={list} choice={choice} />
      ) : route.page === "sources" ? (
        <SourcesPage call={call} sites={list} choice={choice} />
      ) : route.page === "behavior" ? (
        <BehaviorPage call={call} sites={list} choice={choice} />
      ) : route.page === "funnels" ? (
        <FunnelsPage call={call} sites={list} choice={choice} />
      ) : route.page === "forms" ? (
        <FormsPage call={call} sites={list} choice={choice} />
      ) : route.page === "heatmaps" ? (
        <HeatmapsPage call={call} sites={list} choice={choice} />
      ) : route.page === "replays" ? (
        <ReplaysPage call={call} sites={list} choice={choice} />
      ) : route.page === "replay" ? (
        <ReplayPage key={route.id} call={call} id={route.id} choice={choice} />
      ) : route.page === "visits" ? (
        <VisitsPage call={call} sites={list} choice={choice} />
      ) : route.page === "visit" ? (
        <VisitPage key={route.id} call={call} id={route.id} choice={choice} />
      ) : route.page === "sites" ? (
        <SitesPage sites={list} summary={summary} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <SettingsPage page={route.page} />
      ) : (
        <SetupPage summary={summary} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Analytics">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
