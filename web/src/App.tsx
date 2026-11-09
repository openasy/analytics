import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SearchInput,
  StatusBadge,
  toLocale,
  usePath,
  useAgo,
  useLocalePreference,
  useThemePreference,
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
  Eye,
  FileCode,
  Flame,
  Gauge,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  MousePointerClick,
  Share2,
  Target,
  Trash2,
  UserCog,
  UserRound,
  Users,
  Route as RouteIcon,
  Repeat,
  Search,
  Send,
  ShoppingCart,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AcquisitionPage } from "./acquisition.tsx";
import { type ProductLink, type Site, type Summary, type Visit, type VisitDetail } from "./api.ts";
import { BehaviorPage } from "./behavior.tsx";
import { Code, duration, time, useApi } from "./common.tsx";
import { ConversionsPage } from "./conversions.tsx";
import { EcommercePage } from "./ecommerce.tsx";
import { RetentionPage } from "./retention.tsx";
import { SearchPage } from "./searchengines.tsx";
import { SharedDashboard, SharingPage } from "./sharing.tsx";
import { useFormat } from "./format.ts";
import { useT, viewerLocale, setViewerLocale } from "./i18n.ts";
import { HeatmapsPage, ReplayPage, ReplaysPage } from "./insights.tsx";
import { OverviewPage, RealtimePage } from "./overview.tsx";
import { PerformancePage } from "./performance.tsx";
import { Flag, Nothing, Report, ReportProvider, useReport } from "./report.tsx";
import { search } from "./search.ts";
import { SettingsFilePage } from "./settings.tsx";
import { VisitorsPage } from "./visitors.tsx";

/** Pages with tabs, each tab at /<page>/<tab>. */
const TABBED = ["acquisition", "visitors", "behavior", "conversions", "ecommerce", "retention", "search", "sharing"] as const;
const PAGES = [
  "realtime",
  ...TABBED,
  "performance",
  "heatmaps",
  "replays",
  "visits",
  "sites",
  "settings",
  "setup",
  "account",
  "members",
  "signin",
  "tokens",
  "about",
] as const;
type Page = "overview" | (typeof PAGES)[number];
type Route = { page: Page; tab?: string } | { page: "visit" | "replay"; id: string };
/** Pages of the reports from before, and where they are now. */
const MOVED: Record<string, string> = { pages: "/behavior", sources: "/acquisition/sources", funnels: "/conversions/funnels", forms: "/conversions/forms" };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES, ...Object.keys(MOVED)];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "visits" && id) return { page: "visit", id: decodeURIComponent(id) };
  if (page === "replays" && id) return { page: "replay", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page, tab: id };
  return { page: "overview" };
}

// ---------------------------------------------------------------- Visits

function VisitsPage() {
  const t = useT();
  const f = useFormat();
  const ago = useAgo();
  const r = useReport();
  const { call, query: reportQuery, site } = r;
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Visit[]>();
  const [more, setMore] = useState<string>();
  const query = useCallback(
    (cursor?: string) => {
      const extra: Record<string, string> = { limit: "100" };
      // An id the site gave the person is searched as a user; the script's ids start the same way every time.
      const id = q.trim();
      if (id) extra[/^[A-Za-z0-9_-]{22}$/.test(id) ? "visitor" : "user"] = id;
      if (cursor) extra.cursor = cursor;
      return call<{ visits: Visit[]; nextCursor?: string }>(`/api/v1/visits?${reportQuery(extra, { compare: false })}`);
    },
    [call, reportQuery, q],
  );
  useEffect(() => {
    if (!site) return;
    void query().then(
      (r) => (setRows(r.visits), setMore(r.nextCursor)),
      () => setRows([]),
    );
  }, [query, site]);
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
    { id: "source", header: t("visits.source"), cell: (v) => <span className="text-xs">{f.source(v.source)}</span> },
    {
      id: "place",
      header: t("visits.place"),
      cell: (v) => (
        <span className="text-xs">
          {v.country ? (
            <>
              <Flag code={v.country} /> {v.city ? `${v.city}, ` : ""}
              {f.country(v.country)}
            </>
          ) : (
            "–"
          )}
        </span>
      ),
    },
    { id: "device", header: t("visits.device"), cell: (v) => <span className="text-xs">{`${v.browser}, ${v.os}`}</span> },
    { id: "user", header: t("visits.user"), mono: true, cell: (v) => v.user ?? "–" },
  ];
  return (
    <Report
      noCompare
      title={t("visits.title")}
      description={t("visits.description")}
      actions={<SearchInput label={t("visits.search")} className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />}
    >
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
          minWidth={960}
          pageSize={50}
          empty={<Nothing />}
        />
      </Panel>
    </Report>
  );
}

function VisitPage({ id }: { id: string }) {
  const t = useT();
  const f = useFormat();
  const { call, site } = useReport();
  const { can } = useAuth();
  const [visit, setVisit] = useState<VisitDetail | null>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(
    () => void call<VisitDetail>(`/api/v1/visits/${encodeURIComponent(id)}?site=${encodeURIComponent(site)}`).then(setVisit, () => setVisit(null)),
    [call, id, site],
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
        description={
          visit
            ? [
                time(visit.startedAt),
                `${visit.browser}, ${visit.os}`,
                f.source(visit.source),
                visit.country ? `${visit.city ? `${visit.city}, ` : ""}${f.country(visit.country)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
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
            {visit.channel && <Badge>{f.channel(visit.channel)}</Badge>}
            {visit.utm.campaign && <Badge>{t("visit.campaign", { name: visit.utm.campaign })}</Badge>}
            <Badge>{f.device(visit.device)}</Badge>
            {visit.returning !== null && <Badge>{visit.returning ? t("value.returning") : t("value.new")}</Badge>}
            {visit.language && <Badge mono>{visit.language}</Badge>}
            {visit.rage > 0 && <Badge tone="warning">{t("replay.rage", { count: visit.rage })}</Badge>}
          </div>
          <Panel title={t("visit.timeline")} description={t("visit.timelineDetail")}>
            <ol className="analytics-list flex flex-col gap-2">
              {visit.timeline.map((e, i) => {
                const s = step(e);
                return (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="w-24 shrink-0 font-mono text-xs whitespace-nowrap text-fg-muted">
                      {new Date(e.at).toLocaleTimeString(viewerLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
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
    search: { path: /search, param: q }   # what people search on the site, masked
    notFound: { title: Page not found }   # or <meta name="analytics" content="404"> on the page
    channels:             # your own sources in a channel, before the built-in rules
      email: [partner-newsletter]
    vitals: true          # Core Web Vitals (LCP, INP, CLS) of each page
    location: city        # city, region, country or off; the IP address is never kept
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
          {s.search && <Badge>{t("sites.search")}</Badge>}
          {s.vitals && <Badge>{t("sites.vitals")}</Badge>}
          {s.location && <Badge>{t(`sites.location_${s.location}`)}</Badge>}
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
  const path = usePath();
  const route = parseRoute(path);
  const [summary, setSummary] = useState<Summary>();
  const [sites, setSites] = useState<Site[]>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // An address of a report from before opens where that report is now.
  const moved = MOVED[path.replace(/^\//, "").split("/")[0] ?? ""];
  useEffect(() => {
    if (moved) navigate(moved + location.search, { replace: true });
  }, [moved]);

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
    { id: "realtime", label: msg("nav.realtime"), icon: Activity, count: summary?.live || undefined },
    { id: "acquisition", label: msg("nav.acquisition"), icon: Share2 },
    { id: "visitors", label: msg("nav.visitors"), icon: Users },
    { id: "behavior", label: msg("nav.behavior"), icon: MousePointerClick },
    { id: "conversions", label: msg("nav.conversions"), icon: Target },
    ...(sites?.some((s) => s.ecommerce) ? [{ id: "ecommerce", label: msg("nav.ecommerce"), icon: ShoppingCart }] : []),
    { id: "retention", label: msg("nav.retention"), icon: Repeat },
    { id: "performance", label: msg("nav.performance"), icon: Gauge },
    { id: "search", label: msg("nav.search"), icon: Search },
    { id: "heatmaps", label: msg("nav.heatmaps"), icon: Flame },
    { id: "replays", label: msg("nav.replays"), icon: CirclePlay },
    { id: "visits", label: msg("nav.visits"), icon: RouteIcon },
    { id: "sharing", label: msg("nav.sharing"), icon: Send },
    { id: "sites", label: msg("nav.sites"), icon: Globe, count: summary?.sites },
  ];
  const footerNav = [
    { id: "settings", label: msg("nav.settings"), icon: FileCode },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: UserCog },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "visit" ? "visits" : route.page === "replay" ? "replays" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const reports = [
    "overview",
    "realtime",
    "acquisition",
    "visitors",
    "behavior",
    "conversions",
    "ecommerce",
    "retention",
    "search",
    "sharing",
    "performance",
    "heatmaps",
    "replays",
    "replay",
    "visits",
    "visit",
  ].includes(route.page);
  const list = sites ?? [];
  const tab = "tab" in route ? route.tab : undefined;

  return (
    <ReportProvider sites={sites}>
      <Shell
        nav={nav}
        footerNav={account.settings(footerNav)}
        active={active}
        products={products}
        user={{ name: me.user.name, role: roleName, ...account.user }}
        theme={theme}
        setTheme={setTheme}
        setLocale={(code) => setLocale(toLocale(code))}
      >
        {reports && sites && sites.length === 0 ? (
          <SetupPage summary={summary} />
        ) : reports && !sites ? null : route.page === "overview" ? (
          <OverviewPage />
        ) : route.page === "realtime" ? (
          <RealtimePage />
        ) : route.page === "acquisition" ? (
          <AcquisitionPage at={tab} />
        ) : route.page === "visitors" ? (
          <VisitorsPage at={tab} summary={summary} />
        ) : route.page === "behavior" ? (
          <BehaviorPage at={tab} />
        ) : route.page === "conversions" ? (
          <ConversionsPage at={tab} />
        ) : route.page === "ecommerce" ? (
          <EcommercePage at={tab} />
        ) : route.page === "retention" ? (
          <RetentionPage at={tab} />
        ) : route.page === "search" ? (
          <SearchPage at={tab} />
        ) : route.page === "sharing" ? (
          <SharingPage at={tab} />
        ) : route.page === "performance" ? (
          <PerformancePage />
        ) : route.page === "heatmaps" ? (
          <HeatmapsPage />
        ) : route.page === "replays" ? (
          <ReplaysPage />
        ) : route.page === "replay" ? (
          <ReplayPage key={route.id} id={route.id} />
        ) : route.page === "visits" ? (
          <VisitsPage />
        ) : route.page === "visit" ? (
          <VisitPage key={route.id} id={route.id} />
        ) : route.page === "sites" ? (
          <SitesPage sites={list} summary={summary} />
        ) : route.page === "settings" ? (
          <SettingsFilePage sites={list} summary={summary} />
        ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
          <SettingsPage page={route.page} />
        ) : (
          <SetupPage summary={summary} />
        )}
      </Shell>
    </ReportProvider>
  );
}

/** The product's frame: navigation, search, the product switcher, the account menu, theme and language. */
function Shell({
  nav,
  footerNav,
  active,
  products,
  user,
  theme,
  setTheme,
  setLocale,
  children,
}: {
  nav: Parameters<typeof AppShell>[0]["nav"];
  footerNav: Parameters<typeof AppShell>[0]["footerNav"];
  active: string;
  products: Array<ProductLink & { id: ProductId }>;
  user: Parameters<typeof AppShell>[0]["user"];
  theme: Parameters<typeof AppShell>[0]["theme"];
  setTheme: (t: NonNullable<Parameters<typeof AppShell>[0]["theme"]>) => void;
  setLocale: (code: string) => void;
  children: React.ReactNode;
}) {
  const msg = useT();
  const r = useReport();
  const onSearch = useMemo(() => search(r.call, msg, r.site), [r.call, msg, r.site]);
  return (
    <AppShell
      product="analytics"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      // Moving between reports keeps the site, period, comparison and filters.
      onNavigate={(id) => r.go(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      setup
      user={user}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={setLocale}
    >
      {children}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  const shared = /^\/shared\/([A-Za-z0-9_-]{20,64})\/?$/.exec(location.pathname)?.[1];
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      {shared ? (
        // A shared link opens without signing in: read-only totals of the link's sections.
        <SharedDashboard token={shared} />
      ) : (
        <AuthGate product="OpenAsy Analytics">
          <Product />
        </AuthGate>
      )}
    </BrandProvider>
  );
}
