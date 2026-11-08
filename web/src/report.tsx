// What every report shares: the site, period, comparison, saved segment and filters at the top of each page (kept in
// the address, so a report can be linked to as it is shown), loading a report with them, CSV export of tables, and the
// few drawings no library chart covers.
//
// Rebuilt from published @openasy/ui components after the Analytics design in the ui repo's Storybook
// (src/stories/products/analytics/parts.tsx).
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  FilterBar,
  FilterChip,
  IconButton,
  niceScale,
  PageHeader,
  SegmentedControl,
  SelectField,
  Switch,
  Tabs,
  TextField,
  TimeRangePicker,
  cn,
  navigate,
  type KpiDelta,
  type TabItem,
} from "@openasy/ui";
import { Bookmark, Download, Plus, Trash2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Breakdown, BreakdownDimension, Compare, Range, Site } from "./api.ts";
import { useApi, type Call } from "./common.tsx";
import { NONE, flagOf, useFormat } from "./format.ts";
import { useT } from "./i18n.ts";

/* ------------------------------------------------------------ filters */

/** What a report can be filtered by: a dimension of a visit, or what it did (a page, an event, a goal). */
export const FILTER_DIMENSIONS = [
  "channel",
  "source",
  "referrer",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
  "entry",
  "exit",
  "page",
  "event",
  "goal",
  "country",
  "region",
  "city",
  "device",
  "browser",
  "browserVersion",
  "os",
  "osVersion",
  "screen",
  "language",
  "timezone",
  "visitorType",
] as const;
export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

export interface Filter {
  dimension: FilterDimension;
  op: "is" | "not";
  /** Alternatives: the filter keeps a visit with any of them. */
  values: string[];
}

/** Filters saved under a name on the server: a member's own, or shared with the team. */
export interface Segment {
  id: string;
  name: string;
  filters: Filter[];
  shared: boolean;
  mine: boolean;
  owner: string | null;
}

const RANGES: Range[] = [1, 7, 30, 90];
const SEGMENTS_KEY = "analytics.segments";

export const filterParam = (f: Filter) => `${f.dimension}:${f.op}:${f.values.join("|")}`;
export function parseFilter(raw: string): Filter | null {
  const m = /^([A-Za-z]+):(is|not):(.+)$/s.exec(raw);
  if (!m || !(FILTER_DIMENSIONS as readonly string[]).includes(m[1]!)) return null;
  const values = m[3]!.split("|").filter(Boolean);
  return values.length ? { dimension: m[1] as FilterDimension, op: m[2] as Filter["op"], values } : null;
}

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // The choice lasts for this page only.
  }
};

/** Segments an earlier version kept in this browser, to move to the server once. */
function oldSegments(): Array<{ name: string; filters: Filter[] }> {
  try {
    const list = JSON.parse(read(SEGMENTS_KEY) ?? "[]") as Array<{ name: string; filters: Filter[] }>;
    return Array.isArray(list) ? list.filter((s) => s && typeof s.name === "string" && Array.isArray(s.filters) && s.filters.length) : [];
  } catch {
    return [];
  }
}

interface Choice {
  site: string;
  days: Range;
  compare: Compare | null;
  filters: Filter[];
  segment: string;
}

/** The choices in an address, such as ?site=shop&days=30&compare=previous&filter=country:is:DE. */
function fromAddress(search: string): Partial<Choice> & { has: boolean } {
  const q = new URLSearchParams(search);
  const days = Number(q.get("days"));
  const compare = q.get("compare");
  const filters = q
    .getAll("filter")
    .map(parseFilter)
    .filter((f): f is Filter => !!f);
  return {
    has: ["site", "days", "compare", "filter", "segment"].some((k) => q.has(k)),
    ...(q.get("site") ? { site: q.get("site")! } : {}),
    ...(RANGES.includes(days as Range) ? { days: days as Range } : {}),
    ...(compare === "previous" || compare === "year" ? { compare } : {}),
    filters,
    segment: q.get("segment") ?? "",
  };
}

function toAddress(c: Choice): string {
  const q = new URLSearchParams();
  if (c.site) q.set("site", c.site);
  q.set("days", String(c.days));
  if (c.compare) q.set("compare", c.compare);
  for (const f of c.filters) q.append("filter", filterParam(f));
  if (c.segment) q.set("segment", c.segment);
  return `?${q}`;
}

interface ReportState extends Choice {
  sites: Site[];
  /** The chosen site's settings from the file, once the sites are loaded. */
  current: Site | undefined;
  setSite: (v: string) => void;
  setDays: (v: Range) => void;
  setCompare: (v: Compare | null) => void;
  setFilters: (f: Filter[]) => void;
  addFilter: (f: Filter) => void;
  setSegment: (id: string) => void;
  segments: Segment[];
  saveSegment: (name: string, filters: Filter[], shared: boolean) => Promise<string>;
  removeSegment: (id: string) => void;
  /** The filters and the segment's, which every report applies. */
  active: Filter[];
  call: Call;
  /** The query of a report: the site, the period, the filters and, unless left out, the comparison. */
  query: (extra?: Record<string, string>, opts?: { compare?: boolean; filters?: Filter[] }) => string;
  /** The site and the filters alone, for what has no period: realtime, a visit list. */
  params: (extra?: Record<string, string>) => string;
  /** Opens another page of the product, keeping these choices. */
  go: (path: string) => void;
  /** The address of another page with these choices, and more filters if given. */
  href: (path: string, add?: Filter[]) => string;
}

const Ctx = createContext<ReportState | null>(null);

/** Keeps the filter bar's choices while moving between reports, in the address and, for the next visit, in this browser. */
export function ReportProvider({ sites, children }: { sites: Site[] | undefined; children: ReactNode }) {
  const call = useApi();
  const [choice, setChoice] = useState<Choice>(() => {
    const a = fromAddress(location.search);
    const stored = Number(read("analytics.days"));
    const compare = read("analytics.compare");
    return {
      site: a.site ?? read("analytics.site") ?? "",
      days: a.days ?? (RANGES.includes(stored as Range) ? (stored as Range) : 7),
      compare: a.has ? (a.compare ?? null) : compare === "previous" || compare === "year" ? compare : null,
      filters: a.filters ?? [],
      segment: a.segment ?? "",
    };
  });
  const [segments, setSegments] = useState<Segment[]>([]);
  const loadSegments = useCallback(
    () =>
      call<{ segments: Segment[] }>("/api/v1/segments").then(
        (r) => setSegments(r.segments),
        () => {},
      ),
    [call],
  );
  useEffect(() => {
    // Segments saved in this browser before they were kept on the server move there, as the member's own.
    const old = oldSegments();
    void Promise.all(
      old.map((x) =>
        call("/api/v1/segments", { method: "POST", body: JSON.stringify({ name: x.name.slice(0, 80), filters: x.filters.map(filterParam) }) }).catch(() => {}),
      ),
    ).then(() => {
      if (old.length) {
        try {
          localStorage.removeItem(SEGMENTS_KEY);
        } catch {
          // nothing kept
        }
      }
      return loadSegments();
    });
  }, [call, loadSegments]);
  const list = useMemo(() => sites ?? [], [sites]);
  const site = list.some((s) => s.name === choice.site) ? choice.site : (list[0]?.name ?? choice.site);
  const state = { ...choice, site };

  // The address follows the choices; a link that carries choices of its own (such as from a rage click to its
  // replays) sets them, and one without keeps them.
  const address = toAddress(state);
  useEffect(() => {
    if (location.search !== address) history.replaceState(history.state, "", location.pathname + address + location.hash);
  });
  useEffect(() => {
    const onPop = () => {
      const a = fromAddress(location.search);
      if (!a.has) return;
      setChoice((c) => ({ ...c, ...a, compare: a.compare ?? null, filters: a.filters ?? [], segment: a.segment ?? "" }));
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const update = (patch: Partial<Choice>) => setChoice((c) => ({ ...c, site, ...patch }));
  const segment = segments.find((s) => s.id === state.segment);
  const active = useMemo(() => [...state.filters, ...(segment?.filters ?? [])], [state.filters, segment]);
  const query = useCallback(
    (extra: Record<string, string> = {}, opts: { compare?: boolean; filters?: Filter[] } = {}) => {
      const q = new URLSearchParams({ site, days: String(state.days), ...extra });
      for (const f of [...active, ...(opts.filters ?? [])]) q.append("filter", filterParam(f));
      if (state.compare && opts.compare !== false) q.set("compare", state.compare);
      return q.toString();
    },
    [site, state.days, state.compare, active],
  );
  const value: ReportState = {
    ...state,
    sites: list,
    current: list.find((s) => s.name === site),
    setSite: (v) => (update({ site: v }), write("analytics.site", v)),
    setDays: (v) => (update({ days: v }), write("analytics.days", String(v))),
    setCompare: (v) => (update({ compare: v }), write("analytics.compare", v ?? "")),
    setFilters: (filters) => update({ filters }),
    addFilter: (f) => setChoice((c) => ({ ...c, site, filters: [...c.filters.filter((x) => x.dimension !== f.dimension || x.op !== f.op), f] })),
    setSegment: (id) => update({ segment: id }),
    segments,
    saveSegment: async (name, filters, shared) => {
      const s = await call<Segment>("/api/v1/segments", { method: "POST", body: JSON.stringify({ name, filters: filters.map(filterParam), shared }) });
      setSegments((list) => [...list, s].sort((a, b) => a.name.localeCompare(b.name)));
      return s.id;
    },
    removeSegment: (id) => {
      void call(`/api/v1/segments/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
        () => setSegments((list) => list.filter((s) => s.id !== id)),
        () => {},
      );
      if (state.segment === id) update({ segment: "" });
    },
    active,
    call,
    query,
    params: (extra = {}) => {
      const q = new URLSearchParams({ site, ...extra });
      for (const f of active) q.append("filter", filterParam(f));
      return q.toString();
    },
    go: (path) => navigate(path + address),
    href: (path, add = []) => path + toAddress({ ...state, filters: [...state.filters, ...add] }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReport(): ReportState {
  const r = useContext(Ctx);
  if (!r) throw new Error("useReport needs a ReportProvider");
  return r;
}

/** Loads a report: undefined while loading, null when it failed. A null path loads nothing. */
export function useLoad<R>(path: string | null, every?: number) {
  const { call } = useReport();
  const [data, setData] = useState<R | null>();
  const [tick, setTick] = useState(0);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    // A new question clears the old answer; a refresh of the same one keeps it until the new one is in.
    if (shown.current !== path) setData(undefined);
    shown.current = path;
    void call<R>(path).then(
      (r) => live && setData(r),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, tick]);
  useEffect(() => {
    if (!every) return;
    const timer = setInterval(() => setTick((n) => n + 1), every);
    return () => clearInterval(timer);
  }, [every]);
  return data;
}

/** A breakdown of the chosen site and period by one dimension, with the comparison when one is chosen. */
export function useBreakdown(dimension: BreakdownDimension, opts: { limit?: number; filters?: Filter[]; skip?: boolean } = {}) {
  const { query, site } = useReport();
  return useLoad<Breakdown>(
    site && !opts.skip ? `/api/v1/breakdown?${query({ dimension, limit: String(opts.limit ?? 100) }, { filters: opts.filters })}` : null,
  );
}

/* ------------------------------------------------------------ comparison */

/** The change against the comparison the bar asks for, as a KPI delta. */
export function useDelta() {
  const { compare } = useReport();
  const t = useT();
  const f = useFormat();
  return (now: number, then: number | null | undefined, opts: { lowerIsBetter?: boolean; points?: boolean } = {}): KpiDelta | undefined => {
    if (!compare || then === null || then === undefined) return undefined;
    if (!opts.points && then === 0)
      return { label: now ? t(`delta.new_${compare}`) : t(`delta.same_${compare}`), direction: now ? "up" : "flat", intent: "neutral" };
    const diff = opts.points ? (now - then) * 100 : ((now - then) / then) * 100;
    const up = diff > 0;
    const change = `${up ? "+" : diff < 0 ? "−" : ""}${f.num(Math.abs(Math.round(diff * 10) / 10))}${opts.points ? ` ${t("delta.points")}` : "%"}`;
    return {
      label: t(`delta.${compare}`, { change }),
      direction: Math.abs(diff) < 0.05 ? "flat" : up ? "up" : "down",
      intent: Math.abs(diff) < 0.05 ? "neutral" : up !== !!opts.lowerIsBetter ? "good" : "bad",
    };
  };
}

/** A row's change against the same row in the period compared with, for a table's Change column. */
export function Change({ now, then, lowerIsBetter }: { now: number; then: number | undefined; lowerIsBetter?: boolean }) {
  const t = useT();
  const f = useFormat();
  if (then === undefined || then === 0)
    return now ? <span className="text-xs text-fg-muted">{t("delta.newRow")}</span> : <span className="text-fg-muted">–</span>;
  const d = ((now - then) / then) * 100;
  const good = d >= 0 !== !!lowerIsBetter;
  return <span className={good ? "text-success" : "text-danger-text"}>{`${d > 0 ? "+" : d < 0 ? "−" : ""}${f.num(Math.abs(Math.round(d)))}%`}</span>;
}

/* ------------------------------------------------------------ filter bar */

/** Site, period, comparison, segment and filters: the same row at the top of every report. */
export function ReportBar({ live, noCompare }: { live?: boolean; noCompare?: boolean }) {
  const r = useReport();
  const t = useT();
  const f = useFormat();
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const segment = r.segments.find((s) => s.id === r.segment);
  return (
    <>
      <FilterBar
        onClear={
          r.filters.length || r.segment
            ? () => {
                r.setFilters([]);
                r.setSegment("");
              }
            : undefined
        }
      >
        {r.sites.length > 1 && (
          <SelectField
            aria-label={t("choice.site")}
            className="w-28"
            value={r.site}
            onChange={(e) => r.setSite(e.target.value)}
            options={r.sites.map((s) => ({ value: s.name, label: s.name }))}
          />
        )}
        {!live && (
          <TimeRangePicker
            size="md"
            value={String(r.days)}
            onChange={(v) => r.setDays(Number(v) as Range)}
            ranges={RANGES.map((d) => ({ value: String(d), label: d === 1 ? t("choice.today") : t("choice.lastDays", { count: d }) }))}
          />
        )}
        {!live && !noCompare && (
          <SelectField
            aria-label={t("choice.compare")}
            className="w-52"
            value={r.compare ?? ""}
            onChange={(e) => r.setCompare((e.target.value || null) as Compare | null)}
            options={[
              { value: "", label: t("choice.noCompare") },
              { value: "previous", label: t("choice.previous") },
              { value: "year", label: t("choice.year") },
            ]}
          />
        )}
        <SelectField
          aria-label={t("segments.segment")}
          className="w-48"
          value={r.segment}
          onChange={(e) => r.setSegment(e.target.value)}
          options={[
            { value: "", label: t("segments.all") },
            ...r.segments.map((s) => ({ value: s.id, label: s.shared && !s.mine ? t("segments.team", { name: s.name }) : s.name })),
          ]}
        />
        {r.filters.map((x, i) => (
          <FilterChip
            key={`${filterParam(x)}-${i}`}
            field={t(`dim.${x.dimension}`)}
            value={x.values.map((v) => f.value(x.dimension, v)).join(` ${t("filters.or")} `)}
            negate={x.op === "not"}
            onRemove={() => r.setFilters(r.filters.filter((_, j) => j !== i))}
          />
        ))}
        <Button icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          {t("filters.add")}
        </Button>
        {r.filters.length > 0 && (
          <Button variant="ghost" icon={<Bookmark aria-hidden />} onClick={() => setSaving(true)}>
            {t("segments.save")}
          </Button>
        )}
        {segment && (
          <>
            <Badge tone="info" title={segment.filters.map((x) => chipText(x, t, f)).join(", ")}>
              {segment.filters.map((x) => chipText(x, t, f)).join(", ")}
            </Badge>
            {segment.mine && (
              <IconButton variant="ghost" size="sm" label={t("segments.remove", { name: segment.name })} onClick={() => r.removeSegment(segment.id)}>
                <Trash2 aria-hidden />
              </IconButton>
            )}
          </>
        )}
      </FilterBar>
      {adding && (
        <AddFilterDialog
          onClose={() => setAdding(false)}
          onAdd={(x) => {
            r.addFilter(x);
            setAdding(false);
          }}
        />
      )}
      {saving && (
        <SaveSegmentDialog
          filters={r.filters}
          onClose={() => setSaving(false)}
          onSave={(name, shared) =>
            r.saveSegment(name, r.filters, shared).then((id) => {
              r.setFilters([]);
              r.setSegment(id);
              setSaving(false);
            })
          }
        />
      )}
    </>
  );
}

const chipText = (x: Filter, t: ReturnType<typeof useT>, f: ReturnType<typeof useFormat>) =>
  t(x.op === "not" ? "filters.isNot" : "filters.is", { dimension: t(`dim.${x.dimension}`), value: x.values.map((v) => f.value(x.dimension, v)).join(", ") });

/** Patterns work on these: * matches any characters. */
const PATTERNED = new Set<FilterDimension>(["page", "entry", "exit", "referrer"]);

function AddFilterDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (f: Filter) => void }) {
  const r = useReport();
  const t = useT();
  const f = useFormat();
  const list = useId();
  const [dim, setDim] = useState<FilterDimension>("country");
  const [mode, setMode] = useState<"is" | "not">("is");
  const [value, setValue] = useState("");
  // The values this period has, most visitors first, to pick from; any other value can be typed.
  const suggested = useLoad<Breakdown>(dim === "goal" || !r.site ? null : `/api/v1/breakdown?${r.query({ dimension: dim, limit: "50" }, { compare: false })}`);
  const options =
    dim === "goal"
      ? (r.current?.goals ?? []).map((g) => ({ value: g.name, label: g.name }))
      : (suggested?.rows ?? []).map((row) => ({ value: row.value ?? NONE, label: f.value(dim, row.value) }));
  const typed = value.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("filters.addTitle")}
      description={t("filters.addDetail")}
      onSubmit={(e) => {
        e.preventDefault();
        if (typed) onAdd({ dimension: dim, op: mode, values: [typed] });
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!typed}>
            {t("filters.add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SelectField
          label={t("filters.dimension")}
          value={dim}
          onChange={(e) => {
            setDim(e.target.value as FilterDimension);
            setValue("");
          }}
          options={FILTER_DIMENSIONS.map((d) => ({ value: d, label: t(`dim.${d}`) }))}
        />
        <SegmentedControl
          label={t("filters.match")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "is", label: t("filters.include") },
            { value: "not", label: t("filters.exclude") },
          ]}
        />
        <TextField
          label={t("filters.value")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          list={list}
          autoComplete="off"
          placeholder={options[0]?.value ?? ""}
          hint={PATTERNED.has(dim) ? t("filters.patternHint") : t("filters.valueHint")}
        />
        <datalist id={list}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </datalist>
      </div>
    </Dialog>
  );
}

function SaveSegmentDialog({ filters, onClose, onSave }: { filters: Filter[]; onClose: () => void; onSave: (name: string, shared: boolean) => Promise<void> }) {
  const t = useT();
  const f = useFormat();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("segments.saveTitle")}
      description={filters.map((x) => chipText(x, t, f)).join(", ")}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim(), shared).catch((err: Error) => setError(err.message));
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {t("segments.saveButton")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label={t("segments.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("segments.namePlaceholder")} />
        <Switch checked={shared} onCheckedChange={setShared} label={t("segments.share")} description={t("segments.shareDetail")} />
        {error && (
          <p role="alert" className="m-0 text-xs text-danger-text">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------ page */

/** A page of reports: its title, the shared filter bar and, when it has several, its tabs. */
export function Report<T extends string>({
  title,
  description,
  meta,
  actions,
  tabs,
  tab,
  onTab,
  live,
  noCompare,
  children,
}: {
  title: string;
  description: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  tabs?: ReadonlyArray<TabItem<T>>;
  tab?: T;
  onTab?: (t: T) => void;
  live?: boolean;
  /** The page has no comparison, such as a list of replays. */
  noCompare?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <PageHeader title={title} description={description} meta={meta} actions={actions}>
        <ReportBar live={live} noCompare={noCompare} />
        {tabs && tab && onTab && <Tabs label={t("report.tabs", { page: title })} value={tab} onChange={onTab} items={tabs} />}
      </PageHeader>
      <div className="flex min-w-0 flex-col gap-2.5">{children}</div>
    </>
  );
}

/** The tab of a page from its address, /behavior/frustration, and a way to open another. */
export function useTab<T extends string>(page: string, tabs: readonly T[], at: string | undefined): [T, (t: T) => void] {
  const { go } = useReport();
  const tab = tabs.includes(at as T) ? (at as T) : tabs[0]!;
  return [tab, (next: T) => go(next === tabs[0] ? `/${page}` : `/${page}/${next}`)];
}

export function Loading() {
  const t = useT();
  return (
    <p role="status" className="m-0 text-sm text-fg-muted">
      {t("report.loading")}
    </p>
  );
}

export function Failed() {
  const t = useT();
  return <EmptyState title={t("report.failed")} />;
}

export function Nothing() {
  const t = useT();
  return <EmptyState title={t("report.nothingYet")}>{t("report.nothingYetDetail")}</EmptyState>;
}

/** A note under a report, such as how its numbers are counted. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 text-xs text-fg-muted">{children}</p>;
}

/* ---------------------------------------------------------------- csv */

/** Exports a table as it is shown, filters applied, as a CSV file. */
export function CsvButton<T>({ name, rows, columns }: { name: string; rows: T[]; columns: Array<[string, (row: T) => string | number | null]> }) {
  const t = useT();
  const { site } = useReport();
  const [done, setDone] = useState(false);
  const file = `${site}-${name}`;
  const save = () => {
    const quote = (v: string | number | null) => (v === null ? "" : typeof v === "number" ? String(v) : `"${v.replace(/"/g, '""')}"`);
    const csv = [columns.map(([h]) => quote(h)).join(","), ...rows.map((r) => columns.map(([, get]) => quote(get(r))).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setDone(true);
  };
  return (
    <span className="flex items-center gap-2">
      {done && (
        <span role="status" className="text-2xs text-fg-muted">
          {t("csv.saved", { file: `${file}.csv`, count: rows.length })}
        </span>
      )}
      <Button size="sm" variant="ghost" icon={<Download aria-hidden />} onClick={save} disabled={!rows.length} aria-label={t("csv.export", { name })}>
        CSV
      </Button>
    </span>
  );
}

/* --------------------------------------------------------------- flag */

/** A country's flag from its two-letter code; screen readers read the name beside it. */
export function Flag({ code }: { code: string | null }) {
  return (
    <span aria-hidden className="analytics-flag">
      {flagOf(code)}
    </span>
  );
}

/* --------------------------------------------------- annotation strip */

/**
 * Notes the team put on dates, as marks under a TimeSeriesChart and in line with its days: the left column copies the
 * chart's value axis so both share one x scale.
 */
export function AnnotationStrip({
  days,
  notes,
  max,
  format,
  active,
  onSelect,
}: {
  days: string[];
  notes: Array<{ id: number; day: number; text: string; label: string }>;
  max: number;
  format: (v: number) => string;
  active?: number;
  onSelect: (id: number) => void;
}) {
  const t = useT();
  const widest = niceScale(Math.max(1, max), 4)
    .ticks.map(format)
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-1.5">
      <span aria-hidden className="invisible min-w-6 font-mono text-2xs">
        {widest}
      </span>
      <ul aria-label={t("annotations.onChart")} className="analytics-list relative h-6">
        {notes.map((n, i) => (
          <li key={n.id} className="absolute top-0 -translate-x-1/2" style={{ left: `${days.length > 1 ? (n.day / (days.length - 1)) * 100 : 50}%` }}>
            <button
              type="button"
              onClick={() => onSelect(n.id)}
              aria-pressed={active === n.id}
              aria-label={`${i + 1}. ${n.label}: ${n.text}`}
              title={`${n.label}: ${n.text}`}
              className={cn(
                "grid size-6 cursor-pointer place-items-center rounded-full border text-2xs font-semibold",
                active === n.id ? "border-accent bg-accent text-accent-contrast" : "border-line-strong bg-surface text-fg hover:bg-subtle",
              )}
            >
              {i + 1}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- misc */

/** Good, needs improvement and poor as one bar, for a Core Web Vital. Shares are ratios. */
export function SplitBar({ label, good, poor }: { label: string; good: number; poor: number }) {
  const t = useT();
  const f = useFormat();
  const split = [good, Math.max(0, 1 - good - poor), poor];
  const tones = ["var(--oa-success)", "var(--oa-warning)", "var(--oa-danger)"];
  const names = [t("vitals.good"), t("vitals.needsImprovement"), t("vitals.poor")];
  return (
    <div
      role="img"
      aria-label={`${label}: ${split.map((v, i) => `${f.pct(v, 0)} ${names[i]}`).join(", ")}`}
      className="flex h-2 overflow-hidden rounded-full bg-subtle"
    >
      {split.map((v, i) => (
        <span key={i} style={{ width: `${v * 100}%`, background: tones[i] }} />
      ))}
    </div>
  );
}

/** A share of a whole as a small bar and a number, for a table cell. */
export function ShareBar({ part, whole }: { part: number; whole: number }) {
  const f = useFormat();
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="analytics-meter h-2 overflow-hidden rounded bg-subtle">
        <span className="block h-2 rounded" style={{ width: `${whole ? (part / whole) * 100 : 0}%`, background: "var(--oa-accent)" }} />
      </span>
      <span className="w-12 text-right font-mono text-xs tabular-nums">{f.share(part, whole)}</span>
    </span>
  );
}

/** Rows of a comparison by their value, to find a row's figure in the period compared with. */
export function byValue<R extends { value: string | null }>(rows: R[] | undefined): Map<string | null, R> {
  return new Map((rows ?? []).map((r) => [r.value, r]));
}

export { RANGES };

/* ------------------------------------------------------------ path flow */

const FLOW_W = 900;

/**
 * Where visits went from a page, step by step: each column a step, each band the visits that moved between two pages,
 * as wide as their count. A small Sankey drawn in SVG from the theme's tokens, after the design's PathFlow.
 */
export function PathFlow({
  label,
  nodes,
  links,
  height = 340,
}: {
  label: string;
  nodes: Array<{ id: string; label: string; column: number; visits: number; exit: boolean }>;
  links: Array<{ from: string; to: string; visits: number }>;
  height?: number;
}) {
  const f = useFormat();
  const t = useT();
  const [hover, setHover] = useState<string | null>(null);
  const columns = Math.max(...nodes.map((n) => n.column)) + 1;
  const nodeW = 10;
  const gap = 10;
  const total = Math.max(1, ...Array.from({ length: columns }, (_, c) => nodes.filter((n) => n.column === c).reduce((s, n) => s + n.visits, 0)));
  const most = Math.max(...Array.from({ length: columns }, (_, c) => nodes.filter((n) => n.column === c).length));
  const scale = (height - 24 - gap * (most - 1)) / total;
  const colX = (c: number) => 4 + c * ((FLOW_W - 250) / Math.max(1, columns - 1));
  const pos = new Map<string, { x: number; y: number; h: number; out: number; in: number }>();
  for (let c = 0; c < columns; c++) {
    let y = 12;
    for (const n of nodes.filter((x) => x.column === c)) {
      const h = Math.max(2, n.visits * scale);
      pos.set(n.id, { x: colX(c), y, h, out: 0, in: 0 });
      y += h + gap;
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const bands = links
    .filter((l) => pos.has(l.from) && pos.has(l.to))
    .map((l) => {
      const s = pos.get(l.from)!;
      const d = pos.get(l.to)!;
      const h = Math.max(1, l.visits * scale);
      const x0 = s.x + nodeW;
      const x1 = d.x;
      const y0 = s.y + s.out;
      const y1 = d.y + d.in;
      s.out += h;
      d.in += h;
      const xm = (x0 + x1) / 2;
      return {
        id: `${l.from}>${l.to}`,
        d: `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + h} C${xm},${y1 + h} ${xm},${y0 + h} ${x0},${y0 + h} Z`,
        link: l,
        exit: !!byId.get(l.to)?.exit,
      };
    });
  const lit = (b: { link: { from: string; to: string } }) => !hover || b.link.from === hover || b.link.to === hover;
  return (
    <div className="overflow-x-auto">
      <svg role="img" aria-label={label} viewBox={`0 0 ${FLOW_W} ${height}`} className="block w-full min-w-[720px]">
        {bands.map((b) => (
          <path
            key={b.id}
            d={b.d}
            fill={b.exit ? "var(--oa-fg-subtle)" : "var(--oa-accent)"}
            fillOpacity={lit(b) ? (b.exit ? 0.18 : 0.28) : 0.06}
            onPointerEnter={() => setHover(b.link.to)}
            onPointerLeave={() => setHover(null)}
          >
            <title>{t("paths.band", { from: byId.get(b.link.from)!.label, to: byId.get(b.link.to)!.label, visits: f.num(b.link.visits) })}</title>
          </path>
        ))}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)}>
              <rect x={p.x} y={p.y} width={nodeW} height={p.h} rx={2} fill={n.exit ? "var(--oa-fg-subtle)" : "var(--oa-accent)"} />
              <text
                x={p.x + nodeW + 6}
                y={p.y + Math.min(p.h / 2, 14) + 4}
                fontSize={12}
                fill={n.exit ? "var(--oa-fg-muted)" : "var(--oa-fg)"}
                stroke="var(--oa-surface)"
                strokeWidth={3}
                paintOrder="stroke"
                fontFamily="var(--oa-font-mono)"
              >
                {n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label} · {f.num(n.visits)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ---------------------------------------------------------- cohort grid */

/**
 * Each row a cohort of visitors first seen in the same week, each column the share that came back that many weeks
 * later. Darker is more; week 0 is everyone and stays plain.
 */
export function CohortGrid({
  label,
  cohorts,
  format,
}: {
  label: string;
  cohorts: Array<{ id: string; label: string; size: number; values: number[] }>;
  format: (v: number, size: number) => string;
}) {
  const t = useT();
  const f = useFormat();
  const width = Math.max(1, ...cohorts.map((c) => c.values.length));
  const max = Math.max(0.0001, ...cohorts.flatMap((c) => c.values.slice(1)));
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[640px] border-separate border-spacing-[2px] text-xs">
        <thead>
          <tr className="text-2xs text-fg-muted">
            <th scope="col" className="px-2 py-1 text-left font-medium">
              {t("retention.firstSeen")}
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              {t("table.visitors")}
            </th>
            {Array.from({ length: width }, (_, i) => (
              <th key={i} scope="col" className="px-2 py-1 text-center font-medium">
                {t("retention.week", { n: i })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="px-2 py-1.5 text-left font-medium whitespace-nowrap text-fg">
                {t("retention.weekOf", { day: c.label })}
              </th>
              <td className="px-2 py-1.5 text-right font-mono text-fg-muted tabular-nums">{f.num(c.size)}</td>
              {Array.from({ length: width }, (_, i) => {
                const v = c.values[i];
                return (
                  <td
                    key={i}
                    className={cn(
                      "rounded-[3px] px-2 py-1.5 text-center font-mono tabular-nums",
                      v === undefined ? "" : i === 0 ? "bg-subtle text-fg-muted" : "text-fg",
                    )}
                    style={
                      v !== undefined && i > 0
                        ? { background: `color-mix(in oklab, var(--oa-accent) ${Math.round((v / max) * 50)}%, var(--oa-surface))` }
                        : undefined
                    }
                  >
                    {v === undefined ? "" : format(v, c.size)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
