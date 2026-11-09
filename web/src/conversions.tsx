// Conversions: the goals of the sites file and the share of visits that reached each, the funnels of the file step by
// step, and forms field by field. Field names only, never what was typed.
import { Badge, BarList, Callout, DataTable, EmptyState, KpiCard, KpiGrid, Panel, SegmentedControl, SelectField, cn, type Column } from "@openasy/ui";
import { useState } from "react";
import type { Attribution, Breakdown, Forms, Funnels, Model, Report as ReportData } from "./api.ts";
import { Code, duration } from "./common.tsx";
import { useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { Change, CsvButton, Failed, Loading, Note, Report, useDelta, useLoad, useReport, useTab } from "./report.tsx";

const TABS = ["goals", "funnels", "forms", "attribution"] as const;

export function ConversionsPage({ at }: { at?: string }) {
  const t = useT();
  const r = useReport();
  const [tab, setTab] = useTab("conversions", TABS, at);
  const counts = { goals: r.current?.goals.length, funnels: r.current?.funnels.length, forms: undefined, attribution: undefined };
  return (
    <Report
      title={t("conversions.title")}
      description={t(`conversions.${tab}Detail`)}
      tabs={TABS.map((x) => ({ value: x, label: t(`conversions.${x}`), count: counts[x] || undefined }))}
      tab={tab}
      onTab={setTab}
    >
      {tab === "goals" && <GoalsTab />}
      {tab === "funnels" && <FunnelsTab />}
      {tab === "forms" && <FormsTab />}
      {tab === "attribution" && <AttributionTab />}
    </Report>
  );
}

const GOALS_EXAMPLE = `    goals:
      - { name: Bought, path: /checkout/done }
      - { name: Signed up, event: signup }
      - { name: Brew guide, download: /files/brew-guide.pdf }`;

type GoalRow = ReportData["goals"][number];

function GoalsTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const delta = useDelta();
  const goals = r.current?.goals ?? [];
  const data = useLoad<ReportData>(r.site ? `/api/v1/report?${r.query()}` : null);
  // Visits that reached any goal, counted once however many they reached.
  const any = useLoad<Breakdown>(
    r.site && goals.length
      ? `/api/v1/breakdown?${r.query({ dimension: "device", limit: "10" }, { filters: [{ dimension: "goal", op: "is", values: goals.map((g) => g.name) }] })}`
      : null,
  );
  if (data === null) return <Failed />;
  if (!data) return <Loading />;
  if (!data.goals.length)
    return (
      <EmptyState title={t("goals.none")}>
        <span className="flex flex-col gap-2">
          {t("goals.noneDetail")}
          <Code>{GOALS_EXAMPLE}</Code>
        </span>
      </EmptyState>
    );
  const sum = (rows: Breakdown["rows"] | undefined) => rows?.reduce((n, x) => n + x.visits, 0);
  const reached = sum(any?.rows);
  const reachedBefore = sum(any?.compare?.rows);
  const conversions = data.goals.reduce((n, g) => n + g.visits, 0);
  const before = data.compare?.goals;
  const was = (g: GoalRow) => before?.find((x) => x.name === g.name);
  const rule = (g: GoalRow) =>
    g.path ? t("goals.rulePath", { path: g.path }) : g.download ? t("goals.ruleDownload", { file: g.download }) : t("goals.ruleEvent", { name: g.event ?? "" });
  const cols: Column<GoalRow>[] = [
    {
      id: "name",
      header: t("table.goal"),
      cell: (g) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{g.name}</span>
          <code className="analytics-wrap text-2xs text-fg-muted">{rule(g)}</code>
        </span>
      ),
    },
    { id: "visits", header: t("table.conversions"), align: "right", mono: true, sortValue: (g) => g.visits, cell: (g) => f.num(g.visits) },
    { id: "rate", header: t("table.rate"), align: "right", mono: true, sortValue: (g) => g.rate, cell: (g) => f.pct(g.rate, 2) },
    ...(data.goals.some((g) => g.value !== null)
      ? [
          {
            id: "value",
            header: t("table.value"),
            align: "right" as const,
            mono: true,
            sortValue: (g: GoalRow) => g.value ?? -1,
            cell: (g: GoalRow) => (g.value === null ? "–" : f.money(g.value, r.current?.currency)),
          },
        ]
      : []),
    ...(before
      ? [
          {
            id: "change",
            header: t("table.change"),
            align: "right" as const,
            mono: true,
            cell: (g: GoalRow) => <Change now={g.visits} then={was(g)?.visits} />,
          },
        ]
      : []),
  ];
  return (
    <>
      <KpiGrid>
        <KpiCard
          label={t("goals.conversions")}
          value={f.num(conversions)}
          delta={delta(
            conversions,
            before?.reduce((n, g) => n + g.visits, 0),
          )}
        />
        <KpiCard
          label={t("goals.visitsWithGoal")}
          value={reached === undefined ? "–" : f.share(reached, data.totals.visits)}
          unit={reached === undefined ? undefined : t("goals.ofVisits", { visits: f.num(reached) })}
          delta={
            reached !== undefined && reachedBefore !== undefined && data.compare
              ? delta(data.totals.visits ? reached / data.totals.visits : 0, data.compare.totals.visits ? reachedBefore / data.compare.totals.visits : 0, {
                  points: true,
                })
              : undefined
          }
        />
        {data.goals.some((g) => g.value !== null) ? (
          <KpiCard
            label={t("goals.value")}
            value={f.money(
              data.goals.reduce((n, g) => n + (g.value ?? 0), 0),
              r.current?.currency,
            )}
            delta={
              before
                ? delta(
                    data.goals.reduce((n, g) => n + (g.value ?? 0), 0),
                    before.reduce((n, g) => n + (g.value ?? 0), 0),
                  )
                : undefined
            }
          />
        ) : (
          <KpiCard label={t("goals.goals")} value={f.num(data.goals.length)} />
        )}
      </KpiGrid>
      <Panel
        flush
        title={t("conversions.goals")}
        actions={
          <CsvButton
            name="goals"
            rows={data.goals}
            columns={[
              [t("table.goal"), (g) => g.name],
              [t("table.rule"), (g) => rule(g)],
              [t("table.conversions"), (g) => g.visits],
              [t("table.rate"), (g) => g.rate],
              [t("table.value"), (g) => g.value],
            ]}
          />
        }
      >
        <DataTable label={t("conversions.goals")} columns={cols} rows={data.goals} getRowId={(g) => g.name} minWidth={560} />
      </Panel>
      <Note>{t("goals.note")}</Note>
    </>
  );
}

/* ------------------------------------------------------------ funnels */

const FUNNEL_EXAMPLE = `    funnels:
      - name: Trial
        steps:
          - { name: Pricing, path: /pricing }
          - { name: Sign-up form, path: /signup }
          - { name: Signed up, event: signup }`;

function FunnelsTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const delta = useDelta();
  const data = useLoad<Funnels & { compare?: Omit<Funnels, "site" | "days"> }>(r.site ? `/api/v1/funnels?${r.query()}` : null);
  const [picked, setPicked] = useState<string>();
  if (data === null) return <Failed />;
  if (!data) return <Loading />;
  if (!data.funnels.length)
    return (
      <EmptyState title={t("funnels.none")}>
        <span className="flex flex-col gap-2">
          {t("funnels.noneDetail")}
          <Code>{FUNNEL_EXAMPLE}</Code>
        </span>
      </EmptyState>
    );
  const funnel = data.funnels.find((x) => x.name === picked) ?? data.funnels[0]!;
  const first = funnel.steps[0]?.visits ?? 0;
  const last = funnel.steps.at(-1)?.visits ?? 0;
  // The step most visits left at.
  let worst = 1;
  for (let i = 1; i < funnel.steps.length; i++)
    if (funnel.steps[i - 1]!.visits - funnel.steps[i]!.visits > funnel.steps[worst - 1]!.visits - funnel.steps[worst]!.visits) worst = i;
  const lost = funnel.steps.length > 1 ? funnel.steps[worst - 1]!.visits - funnel.steps[worst]!.visits : 0;
  const then = data.compare?.funnels.find((x) => x.name === funnel.name);
  const thenFirst = then?.steps[0]?.visits;
  const thenLast = then?.steps.at(-1)?.visits;
  return (
    <>
      {data.funnels.length > 1 && (
        <SegmentedControl
          label={t("funnels.funnel")}
          value={funnel.name}
          onChange={setPicked}
          options={data.funnels.map((x) => ({ value: x.name, label: x.name }))}
        />
      )}
      <KpiGrid>
        <KpiCard label={t("funnels.entered")} value={f.num(first)} unit={t("funnels.visits")} delta={delta(first, thenFirst)} />
        <KpiCard label={t("funnels.finished")} value={f.num(last)} unit={t("funnels.visits")} delta={delta(last, thenLast)} />
        <KpiCard
          label={t("funnels.conversion")}
          value={first ? f.share(last, first) : "–"}
          delta={first && thenFirst ? delta(last / first, (thenLast ?? 0) / thenFirst, { points: true }) : undefined}
        />
        <KpiCard
          label={t("funnels.biggestDrop")}
          value={lost ? `${funnel.steps[worst - 1]!.name} → ${funnel.steps[worst]!.name}` : "–"}
          tone={lost ? "warning" : undefined}
        />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title={funnel.name} description={t("funnels.barsDetail")}>
          <ol aria-label={t("funnels.steps", { name: funnel.name })} className="analytics-list flex flex-col gap-3">
            {funnel.steps.map((s, i) => {
              const prev = i ? funnel.steps[i - 1]!.visits : s.visits;
              return (
                <li key={i} className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="text-xs text-fg-muted tabular-nums">{i + 1}</span>
                      <span className="truncate font-medium text-fg">{s.name}</span>
                      <code className="truncate text-2xs text-fg-muted">
                        {s.path ? t("goals.rulePath", { path: s.path }) : t("goals.ruleEvent", { name: s.event ?? "" })}
                      </code>
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {f.num(s.visits)} · {f.share(s.visits, first)}
                    </span>
                  </span>
                  <span className="h-6 overflow-hidden rounded bg-subtle">
                    <span className="block h-6 rounded" style={{ width: `${first ? (s.visits / first) * 100 : 0}%`, background: "var(--oa-accent)" }} />
                  </span>
                  {i > 0 && (
                    <span className={cn("text-xs", i === worst && lost ? "text-warning-text" : "text-fg-muted")}>
                      {t("funnels.leftHere", { count: prev - s.visits, left: f.num(prev - s.visits), share: f.share(prev - s.visits, prev) })}
                      {s.median !== null && ` · ${t("funnels.median", { time: duration(s.median), step: funnel.steps[i - 1]!.name })}`}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </Panel>
        <Panel title={t("funnels.bySource")} description={t("funnels.bySourceDetail")} className="self-start">
          {funnel.sources.length ? (
            <BarList
              label={t("funnels.bySourceLabel")}
              items={funnel.sources.map((b) => ({
                id: b.source,
                label: `${b.source} (${f.num(b.finished)}/${f.num(b.entered)})`,
                value: b.entered ? Math.round((b.finished / b.entered) * 1000) / 10 : 0,
              }))}
              format={(v) => `${f.num(v)}%`}
            />
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t("funnels.nobody")}</p>
          )}
          <p className="m-0 mt-3 text-xs text-fg-muted">{t("funnels.note")}</p>
        </Panel>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- forms */

type Form = Forms["forms"][number];
type Field = Form["fields"][number];

function FormsTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const delta = useDelta();
  const data = useLoad<Forms & { compare?: Omit<Forms, "site" | "days"> }>(r.site ? `/api/v1/forms?${r.query()}` : null);
  const [picked, setPicked] = useState<string>();
  if (data === null) return <Failed />;
  if (!data) return <Loading />;
  if (!data.enabled && !data.forms.length)
    return (
      <EmptyState title={t("forms.off")}>
        <span className="flex flex-col gap-2">
          {t("forms.offDetail")}
          <Code>{"    forms: true"}</Code>
        </span>
      </EmptyState>
    );
  if (!data.forms.length) return <EmptyState title={t("forms.none")}>{t("forms.noneDetail")}</EmptyState>;
  const form = data.forms.find((x) => x.form === picked) ?? data.forms[0]!;
  const then = data.compare?.forms.find((x) => x.form === form.form);
  const cols: Column<Field>[] = [
    {
      id: "field",
      header: t("forms.field"),
      width: "30%",
      cell: (x) => (
        <span className="flex items-center gap-1.5">
          <span className="analytics-wrap font-mono text-xs">{x.field}</span>
          {x.kind && <Badge>{x.kind}</Badge>}
        </span>
      ),
    },
    {
      id: "reached",
      header: t("forms.reached"),
      align: "right",
      sortValue: (x) => x.reached,
      cell: (x) => `${f.num(x.reached)} · ${f.share(x.reached, form.starts, 0)}`,
    },
    {
      id: "left",
      header: t("forms.left"),
      align: "right",
      sortValue: (x) => x.left,
      cell: (x) => (
        <span className={cn("font-mono tabular-nums", form.starts && x.left / form.starts > 0.15 && "font-semibold text-danger-text")}>{f.num(x.left)}</span>
      ),
    },
    { id: "time", header: t("forms.fieldTime"), align: "right", sortValue: (x) => x.time ?? -1, cell: (x) => duration(x.time) },
    {
      id: "again",
      header: t("forms.again"),
      align: "right",
      sortValue: (x) => x.again,
      cell: (x) => (x.again >= 0.2 ? <Badge tone="warning">{f.pct(x.again, 0)}</Badge> : f.pct(x.again, 0)),
    },
  ];
  return (
    <div className="analytics-forms grid gap-2.5">
      <Panel flush aria-label={t("conversions.forms")} className="self-start">
        <ul className="analytics-list flex flex-col py-1">
          {data.forms.map((x) => (
            <li key={x.form}>
              <button
                type="button"
                onClick={() => setPicked(x.form)}
                aria-current={x.form === form.form ? "true" : undefined}
                className={cn(
                  "analytics-pick flex w-full flex-col px-3 py-1.5 text-start",
                  x.form === form.form ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-canvas",
                )}
              >
                <span className="truncate font-mono text-xs font-medium">{x.form}</span>
                <span className="text-2xs text-fg-muted">{t("forms.sentShare", { page: x.page ?? "–", share: f.share(x.submits, x.starts, 0) })}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      <div className="flex min-w-0 flex-col gap-2.5">
        <KpiGrid>
          <KpiCard label={t("forms.starts")} value={f.num(form.starts)} unit={t("funnels.visits")} delta={delta(form.starts, then?.starts)} />
          <KpiCard label={t("forms.submits")} value={f.num(form.submits)} unit={t("funnels.visits")} delta={delta(form.submits, then?.submits)} />
          <KpiCard
            label={t("forms.rate")}
            value={f.share(form.submits, form.starts)}
            delta={form.starts && then?.starts ? delta(form.submits / form.starts, then.submits / then.starts, { points: true }) : undefined}
          />
          <KpiCard label={t("forms.time")} value={duration(form.median)} unit={t("forms.median")} />
        </KpiGrid>
        <Panel
          flush
          title={form.form}
          description={t("forms.on", { page: form.page ?? "–" })}
          actions={
            <CsvButton
              name="form-fields"
              rows={form.fields}
              columns={[
                [t("forms.field"), (x) => x.field],
                [t("forms.kind"), (x) => x.kind],
                [t("forms.reached"), (x) => x.reached],
                [t("forms.left"), (x) => x.left],
                [t("forms.secondsInField"), (x) => x.time],
                [t("forms.again"), (x) => x.again],
              ]}
            />
          }
        >
          <DataTable label={t("forms.fields", { form: form.form })} columns={cols} rows={form.fields} getRowId={(x) => x.field} minWidth={560} />
        </Panel>
        <Callout tone="info" title={t("forms.valuesNever")}>
          {t("forms.valuesNeverDetail")}
        </Callout>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- attribution */

const MODELS: Model[] = ["first", "last", "linear"];

function AttributionTab() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const goals = r.current?.goals ?? [];
  const [goal, setGoal] = useState<string>();
  const [model, setModel] = useState<Model>("last");
  const [by, setBy] = useState<Attribution["by"]>("channel");
  const chosen = goal ?? goals[0]?.name;
  const data = useLoad<Attribution>(r.site && chosen ? `/api/v1/attribution?${r.query({ goal: chosen, by }, { compare: false })}` : null);
  if (!goals.length)
    return (
      <EmptyState title={t("goals.none")}>
        <span className="flex flex-col gap-2">
          {t("goals.noneDetail")}
          <Code>{GOALS_EXAMPLE}</Code>
        </span>
      </EmptyState>
    );
  type Row = Attribution["rows"][number];
  const total = data ? data.rows.reduce((n, x) => n + x[model], 0) : 0;
  const label = (v: string | null) => (by === "channel" ? f.channel(v) : by === "source" ? f.source(v) : (v ?? t("ecommerce.noCampaign")));
  const cols: Column<Row>[] = [
    { id: "value", header: t(`attribution.by_${by}`), cell: (x) => <span className="font-medium">{label(x.value)}</span> },
    {
      id: "credit",
      header: t("attribution.credited"),
      align: "right",
      mono: true,
      sortValue: (x) => x[model],
      cell: (x) => (model === "linear" ? f.num(Math.round(x[model] * 10) / 10) : f.num(x[model])),
    },
    { id: "share", header: t("table.share"), align: "right", mono: true, cell: (x) => f.share(x[model], total) },
    {
      id: "vs",
      header: t("attribution.vsLast"),
      align: "right",
      mono: true,
      cell: (x) => {
        if (model === "last") return "–";
        const d = Math.round((x[model] - x.last) * 10) / 10;
        return <span className={d >= 0 ? "text-success" : "text-danger-text"}>{`${d > 0 ? "+" : d < 0 ? "−" : ""}${f.num(Math.abs(d))}`}</span>;
      },
    },
    ...(data?.hasValue
      ? [
          {
            id: "worth",
            header: t("attribution.creditedValue"),
            align: "right" as const,
            mono: true,
            sortValue: (x: Row) => x[`${model}Value`] ?? 0,
            cell: (x: Row) => f.money(x[`${model}Value`] ?? 0, r.current?.currency),
          },
        ]
      : []),
  ];
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label={t("table.goal")}
          className="w-48"
          value={chosen}
          onChange={(e) => setGoal(e.target.value)}
          options={goals.map((g) => ({ value: g.name, label: g.name }))}
        />
        <SegmentedControl
          label={t("attribution.model")}
          value={model}
          onChange={setModel}
          options={MODELS.map((m) => ({ value: m, label: t(`attribution.${m}`) }))}
        />
        <SegmentedControl
          label={t("attribution.creditTo")}
          value={by}
          onChange={setBy}
          options={(["channel", "source", "campaign"] as const).map((b) => ({ value: b, label: t(`attribution.by_${b}`) }))}
        />
      </div>
      {data === null && <Failed />}
      {data === undefined && <Loading />}
      {data && (
        <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Panel
            flush
            title={t("attribution.title", { goal: data.goal, model: t(`attribution.${model}`) })}
            description={
              data.medianVisits === null
                ? t("attribution.none")
                : t("attribution.summary", {
                    count: data.conversions,
                    conversions: f.num(data.conversions),
                    visits: f.num(data.medianVisits),
                    days: data.lookback,
                  })
            }
            actions={
              <CsvButton
                name={`attribution-${data.goal}-${model}`}
                rows={data.rows}
                columns={[
                  [t(`attribution.by_${by}`), (x) => label(x.value)],
                  [t("attribution.first"), (x) => x.first],
                  [t("attribution.last"), (x) => x.last],
                  [t("attribution.linear"), (x) => x.linear],
                ]}
              />
            }
          >
            <DataTable
              key={`${model}-${by}`}
              label={t("conversions.attribution")}
              columns={cols}
              rows={data.rows}
              getRowId={(x) => x.value ?? "(none)"}
              defaultSort={{ id: "credit", direction: "desc" }}
              minWidth={600}
              empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>}
            />
          </Panel>
          <Panel title={t("attribution.models")} className="self-start">
            <dl className="m-0 flex flex-col gap-2 text-xs">
              {MODELS.map((m) => (
                <div key={m}>
                  <dt className="font-semibold text-fg">{t(`attribution.${m}`)}</dt>
                  <dd className="m-0 text-fg-muted">{t(`attribution.${m}Detail`, { days: data.lookback })}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 mb-0 text-xs text-fg-muted">{t("attribution.note")}</p>
          </Panel>
        </div>
      )}
    </>
  );
}
