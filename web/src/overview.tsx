// Overview and Realtime: how the site did over the period, against the period compared with and with the team's
// annotations on its days, and who is on it now.
import {
  BarList,
  Button,
  DonutChart,
  EmptyState,
  KpiCard,
  KpiGrid,
  Panel,
  SelectField,
  StackedBarChart,
  StatusBadge,
  TextField,
  TimeSeriesChart,
  Dialog,
  cn,
  useAgo,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Pause, Play, StickyNote, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Annotation, Realtime, Report as ReportData } from "./api.ts";
import { duration, shortDay } from "./common.tsx";
import { useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { AnnotationStrip, Failed, Flag, Loading, Nothing, Report, useBreakdown, useDelta, useLoad, useReport } from "./report.tsx";

export function OverviewPage() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const delta = useDelta();
  const { can } = useAuth();
  const data = useLoad<ReportData>(r.site ? `/api/v1/report?${r.query()}` : null);
  const countries = useBreakdown("country", { limit: 5 });
  // Annotations added or deleted here, until the report is loaded again.
  const [added, setAdded] = useState<Annotation[]>([]);
  const [deleted, setDeleted] = useState<number[]>([]);
  const [active, setActive] = useState<number>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  const domains = r.current?.domains.map((d) => d.replace(/^https?:\/\//, "")).join(", ") ?? "";
  const header = (children: ReactNode) => (
    <Report title={t("overview.title")} description={t("overview.description", { site: r.site, domains })}>
      {children}
    </Report>
  );
  if (data === null) return header(<Failed />);
  if (!data) return header(<Loading />);

  const days = data.series.map((d) => d.day);
  const labels = days.map(shortDay);
  const then = data.compare;
  const series = [
    { id: "visitors", name: t("overview.visitors"), data: data.series.map((d) => d.visitors) },
    ...(then
      ? [
          {
            id: "compare",
            name: then.period === "year" ? t("overview.sameDaysLastYear") : t("overview.previousPeriod"),
            data: then.series.map((d) => d.visitors),
            color: "var(--oa-fg-subtle)",
          },
        ]
      : []),
  ];
  const max = Math.max(1, ...series.flatMap((s) => s.data));
  const notes = [...data.annotations.filter((a) => !added.some((x) => x.id === a.id)), ...added.filter((a) => days.includes(a.date))]
    .filter((a) => !deleted.includes(a.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const note = notes.find((n) => n.id === active);
  const tot = data.totals;
  const was = then?.totals;

  const remove = (id: number) =>
    r.call(`/api/v1/annotations/${id}?site=${encodeURIComponent(r.site)}`, { method: "DELETE" }).then(
      () => (setDeleted((d) => [...d, id]), setActive(undefined)),
      (err: Error) => setError(err.message),
    );

  return header(
    <>
      {tot.visits === 0 && <Nothing />}
      <KpiGrid>
        <KpiCard label={t("overview.visitors")} value={f.num(tot.visitors)} delta={delta(tot.visitors, was?.visitors)} />
        <KpiCard label={t("overview.visits")} value={f.num(tot.visits)} delta={delta(tot.visits, was?.visits)} />
        <KpiCard label={t("overview.pageviews")} value={f.num(tot.pageviews)} delta={delta(tot.pageviews, was?.pageviews)} />
        <KpiCard
          label={t("overview.bounceRate")}
          value={f.pct(tot.bounceRate)}
          delta={delta(tot.bounceRate, was?.bounceRate, { lowerIsBetter: true, points: true })}
        />
        <KpiCard
          label={t("overview.engagementRate")}
          value={f.pct(tot.engagementRate)}
          delta={delta(tot.engagementRate, was?.engagementRate, { points: true })}
        />
        <KpiCard label={t("overview.visitLength")} value={duration(tot.duration)} unit={t("overview.average")} delta={delta(tot.duration, was?.duration)} />
      </KpiGrid>
      <Panel
        title={t("overview.visitorsADay")}
        description={
          then ? (then.period === "year" ? t("overview.againstYear") : t("overview.againstPrevious", { count: days.length })) : t("overview.marksAreNotes")
        }
        actions={
          can("editor") && (
            <Button size="sm" variant="ghost" icon={<StickyNote aria-hidden />} onClick={() => setAdding(true)}>
              {t("annotations.add")}
            </Button>
          )
        }
      >
        <TimeSeriesChart label={t("overview.visitorsADay")} series={series} labels={labels} height={220} xTicks={6} />
        <AnnotationStrip
          days={days}
          notes={notes.map((n) => ({ id: n.id, day: days.indexOf(n.date), text: n.text, label: shortDay(n.date) }))}
          max={max}
          format={(v) => f.num(v)}
          active={active}
          onSelect={(id) => setActive(id === active ? undefined : id)}
        />
        {note && (
          <p className="m-0 mt-1 flex flex-wrap items-center gap-2 text-xs text-fg" aria-live="polite">
            <span>
              <span className="font-semibold">{shortDay(note.date)}</span> · {note.text}
              {note.createdBy && <span className="text-fg-muted"> · {note.createdBy}</span>}
            </span>
            {can("editor") && (
              <Button size="xs" variant="ghost" icon={<Trash2 aria-hidden />} onClick={() => void remove(note.id)}>
                {t("annotations.delete")}
              </Button>
            )}
          </p>
        )}
        {error && <p className="m-0 mt-1 text-xs text-danger-text">{error}</p>}
      </Panel>
      <div className="grid gap-2.5 lg:grid-cols-3">
        <Panel title={t("overview.channels")} description={t("overview.visits")} footer={<a href="/acquisition">{t("overview.allChannels")}</a>}>
          {data.channels.length ? (
            <BarList
              label={t("overview.visitsByChannel")}
              items={data.channels.map((c) => ({ id: c.channel ?? "", label: f.channel(c.channel), value: c.visits }))}
            />
          ) : (
            <Empty />
          )}
        </Panel>
        <Panel title={t("overview.topPages")} description={t("overview.views")} footer={<a href="/behavior">{t("overview.allPages")}</a>}>
          {data.pages.length ? (
            <BarList
              label={t("overview.topPages")}
              items={data.pages.slice(0, 6).map((p) => ({ id: p.path, label: <span className="font-mono text-xs">{p.path}</span>, value: p.views }))}
            />
          ) : (
            <Empty />
          )}
        </Panel>
        <Panel title={t("overview.newAndReturning")} description={t("overview.visitors")}>
          {tot.visitors ? (
            <DonutChart
              label={t("overview.newAndReturningVisitors")}
              caption={t("overview.visitorsCaption")}
              slices={[
                { id: "new", name: t("value.new"), value: tot.newVisitors },
                { id: "returning", name: t("value.returning"), value: tot.returningVisitors },
              ]}
            />
          ) : (
            <Empty />
          )}
        </Panel>
        <Panel title={t("overview.countries")} description={t("overview.visitors")} footer={<a href="/visitors">{t("overview.allPlaces")}</a>}>
          {countries === undefined ? (
            <Loading />
          ) : countries?.rows.length ? (
            <BarList
              label={t("overview.visitorsByCountry")}
              items={countries.rows.map((c) => ({
                id: c.value ?? "",
                label: (
                  <>
                    <Flag code={c.value} /> {f.country(c.value)}
                  </>
                ),
                value: c.visitors,
              }))}
            />
          ) : (
            <Empty />
          )}
        </Panel>
        <Panel title={t("overview.devices")} description={t("overview.visits")} footer={<a href="/visitors/devices">{t("overview.allDevices")}</a>}>
          {data.devices.length ? (
            <DonutChart
              label={t("overview.visitsByDevice")}
              caption={t("overview.visitsCaption")}
              slices={data.devices.map((d) => ({ id: d.name, name: f.device(d.name), value: d.visits }))}
            />
          ) : (
            <Empty />
          )}
        </Panel>
        <Panel title={t("overview.goals")} description={t("overview.goalsDetail")} footer={<a href="/conversions">{t("overview.allGoals")}</a>}>
          {data.goals.length ? (
            <BarList
              label={t("overview.goals")}
              items={data.goals.map((g) => ({ id: g.name, label: g.name, value: Math.round(g.rate * 1000) / 10 }))}
              format={(v) => `${f.num(v)}%`}
            />
          ) : (
            <EmptyState title={t("goals.none")}>{t("goals.noneDetail")}</EmptyState>
          )}
        </Panel>
      </div>
      {adding && (
        <AnnotationDialog
          days={days}
          onClose={() => setAdding(false)}
          onAdd={(date, text) =>
            r.call<Annotation>(`/api/v1/annotations?site=${encodeURIComponent(r.site)}`, { method: "POST", body: JSON.stringify({ date, text }) }).then((a) => {
              setAdded((x) => [...x, a]);
              setActive(a.id);
              setAdding(false);
            })
          }
        />
      )}
    </>,
  );
}

function Empty() {
  const t = useT();
  return <p className="m-0 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>;
}

function AnnotationDialog({ days, onClose, onAdd }: { days: string[]; onClose: () => void; onAdd: (date: string, text: string) => Promise<void> }) {
  const t = useT();
  const [day, setDay] = useState(() => days.at(-1) ?? new Date().toISOString().slice(0, 10));
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("annotations.addTitle")}
      description={t("annotations.addDetail")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        onAdd(day, text.trim()).catch((err: Error) => (setError(err.message), setBusy(false)));
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!text.trim()} loading={busy}>
            {t("annotations.add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SelectField
          label={t("annotations.date")}
          value={day}
          onChange={(e) => setDay(e.target.value)}
          options={[...days].reverse().map((d) => ({ value: d, label: shortDay(d) }))}
        />
        <TextField
          label={t("annotations.note")}
          value={text}
          maxLength={280}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("annotations.placeholder")}
          hint={t("annotations.everyone")}
          error={error}
        />
      </div>
    </Dialog>
  );
}

/* ----------------------------------------------------------- realtime */

export function RealtimePage() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const ago = useAgo();
  const [paused, setPaused] = useState(false);
  const every = paused ? undefined : 10_000;
  const now = useLoad<Realtime>(r.site ? `/api/v1/realtime?${r.params()}` : null, every);
  const second = (iso: string) => new Date(iso).toLocaleTimeString(f.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const minute = (iso: string) => new Date(iso).toLocaleTimeString(f.locale, { hour: "2-digit", minute: "2-digit" });
  const lastHalfHour = now?.minutes.reduce((n, m) => n + m.pageviews, 0) ?? 0;
  return (
    <Report
      title={t("realtime.title")}
      description={t("realtime.description")}
      live
      meta={<StatusBadge tone={paused ? "neutral" : "success"}>{paused ? t("realtime.paused") : t("realtime.live")}</StatusBadge>}
      actions={
        <Button icon={paused ? <Play aria-hidden /> : <Pause aria-hidden />} onClick={() => setPaused((p) => !p)}>
          {paused ? t("realtime.resume") : t("realtime.pause")}
        </Button>
      }
    >
      {now === null && <Failed />}
      {now === undefined && <Loading />}
      {now && (
        <>
          <KpiGrid>
            <KpiCard label={t("realtime.visitorsNow")} value={f.num(now.visitors)} unit={t("realtime.last5")} />
            <KpiCard label={t("realtime.activeVisits")} value={f.num(now.visits)} unit={t("realtime.last5")} />
            <KpiCard label={t("realtime.pageviews")} value={f.num(now.pageviews)} unit={t("realtime.last5")} />
            <KpiCard label={t("realtime.pageviews")} value={f.num(lastHalfHour)} unit={t("realtime.last30")} />
            {now.goals.length > 0 && (
              <KpiCard
                label={t("realtime.goals")}
                value={f.num(now.goals.reduce((n, g) => n + g.visits, 0))}
                unit={t("realtime.last30")}
                footer={
                  <span className="text-xs text-fg-muted">
                    {now.goals
                      .filter((g) => g.visits)
                      .map((g) => `${f.num(g.visits)} ${g.name}`)
                      .join(", ") || t("realtime.noGoals")}
                  </span>
                }
              />
            )}
          </KpiGrid>
          <Panel title={t("realtime.perMinute")}>
            <StackedBarChart
              label={t("realtime.perMinute")}
              categories={now.minutes.map((m) => minute(m.minute))}
              segments={[{ id: "views", name: t("realtime.pageviews") }]}
              values={now.minutes.map((m) => [m.pageviews])}
              height={140}
              xTicks={6}
            />
          </Panel>
          <div className="analytics-live grid gap-2.5">
            <div className="flex min-w-0 flex-col gap-2.5">
              <Panel title={t("realtime.pages")}>
                {now.pages.length ? (
                  <BarList
                    label={t("realtime.pages")}
                    items={now.pages
                      .slice(0, 10)
                      .map((p) => ({ id: p.path ?? "", label: <span className="font-mono text-xs">{p.path ?? "–"}</span>, value: p.visitors }))}
                  />
                ) : (
                  <Quiet />
                )}
              </Panel>
              <Panel title={t("realtime.countries")}>
                {now.countries.length ? (
                  <BarList
                    label={t("realtime.countriesLabel")}
                    items={now.countries.map((c) => ({
                      id: c.country ?? "",
                      label: (
                        <>
                          <Flag code={c.country} /> {f.country(c.country)}
                        </>
                      ),
                      value: c.visitors,
                    }))}
                  />
                ) : (
                  <Quiet />
                )}
              </Panel>
            </div>
            <div className="flex min-w-0 flex-col gap-2.5">
              <Panel title={t("realtime.sources")}>
                {now.sources.length ? (
                  <BarList
                    label={t("realtime.sourcesLabel")}
                    items={now.sources.map((s) => ({ id: s.source ?? "", label: f.source(s.source), value: s.visitors }))}
                  />
                ) : (
                  <Quiet />
                )}
              </Panel>
              <Panel title={t("realtime.channels")}>
                {now.channels.length ? (
                  <BarList
                    label={t("realtime.channelsLabel")}
                    items={now.channels.map((c) => ({ id: c.channel ?? "", label: f.channel(c.channel), value: c.visitors }))}
                  />
                ) : (
                  <Quiet />
                )}
              </Panel>
            </div>
            <Panel flush title={t("realtime.latest")} description={paused ? t("realtime.latestPaused") : t("realtime.latestDetail")}>
              {now.feed.length ? (
                <ol aria-label={t("realtime.latest")} className="analytics-list flex flex-col">
                  {now.feed.map((e, i) => (
                    <li key={`${e.visit}-${e.at}-${i}`} className="flex items-start gap-2 border-b border-subtle px-3 py-1.5 text-xs last:border-0">
                      <span className="w-16 shrink-0 font-mono whitespace-nowrap text-fg-muted tabular-nums">{second(e.at)}</span>
                      <span className="flex min-w-0 flex-col">
                        <a
                          href={`/visits/${encodeURIComponent(e.visit)}`}
                          className={cn("truncate", e.kind === "goal" ? "font-semibold text-success" : "text-fg")}
                        >
                          {e.kind === "goal"
                            ? e.value !== null
                              ? t("realtime.feedGoalValue", { name: e.name ?? "", value: f.money(e.value, r.current?.currency) })
                              : t("realtime.feedGoal", { name: e.name ?? "" })
                            : e.kind === "visit"
                              ? t("realtime.feedVisit", { source: f.source(e.source), path: e.path ?? "/" })
                              : e.kind === "page"
                                ? t("realtime.feedPage", { path: e.path ?? "/" })
                                : e.kind === "download"
                                  ? t("realtime.feedDownload", { file: e.file ?? "" })
                                  : t("realtime.feedEvent", { name: e.name ?? "" })}
                        </a>
                        <span className="truncate text-2xs text-fg-muted">
                          {[e.country ? `${e.city ? `${e.city}, ` : ""}${f.country(e.country)}` : null, ago(e.at)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="px-3 py-2">
                  <Quiet />
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </Report>
  );
}

function Quiet() {
  const t = useT();
  return <p className="m-0 text-sm text-fg-muted">{t("realtime.nobody")}</p>;
}
