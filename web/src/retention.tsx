// Retention: whether visitors come back. Weekly cohorts, daily, weekly and monthly active visitors, and each week's
// visitors as new, returning or back after four weeks or more away.
import { DataTable, KpiCard, KpiGrid, Panel, SegmentedControl, StackedBarChart, TimeSeriesChart } from "@openasy/ui";
import { useState, type ReactNode } from "react";
import type { Retention } from "./api.ts";
import { shortDay } from "./common.tsx";
import { useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { CohortGrid, Failed, Loading, Note, Report, useLoad, useReport, useTab } from "./report.tsx";

const TABS = ["cohorts", "stickiness", "lifecycle"] as const;

export function RetentionPage({ at }: { at?: string }) {
  const t = useT();
  const r = useReport();
  const [tab, setTab] = useTab("retention", TABS, at);
  // Stickiness follows the period of the filter bar; cohorts and the weeks are the last eight.
  const data = useLoad<Retention>(r.site ? `/api/v1/retention?${r.query({ weeks: "8", days: String(Math.max(7, r.days)) }, { compare: false })}` : null);
  const page = (children: ReactNode) => (
    <Report
      noCompare
      title={t("retention.title")}
      description={t(`retention.${tab}Detail`)}
      tabs={TABS.map((x) => ({ value: x, label: t(`retention.${x}`) }))}
      tab={tab}
      onTab={setTab}
    >
      {children}
      <Note>{t("retention.note")}</Note>
    </Report>
  );
  if (data === null) return page(<Failed />);
  if (!data) return page(<Loading />);
  return page(
    <>
      {tab === "cohorts" && <CohortsTab data={data} />}
      {tab === "stickiness" && <StickinessTab data={data} />}
      {tab === "lifecycle" && <LifecycleTab data={data} />}
    </>,
  );
}

function CohortsTab({ data }: { data: Retention }) {
  const t = useT();
  const f = useFormat();
  const [show, setShow] = useState<"share" | "visitors">("share");
  // The average of a week after, over the cohorts that have had it, weighted by size; the week not over is left out.
  const back = (i: number) => {
    const rows = data.cohorts.filter((c) => c.counts.length > i + 1 && c.visitors);
    const size = rows.reduce((n, c) => n + c.visitors, 0);
    return size ? rows.reduce((n, c) => n + c.counts[i]!, 0) / size : null;
  };
  const w1 = back(1);
  const w4 = back(4);
  const best = data.cohorts.filter((c) => c.counts.length > 2 && c.visitors).sort((a, b) => b.shares[1]! - a.shares[1]!)[0];
  return (
    <>
      <KpiGrid>
        <KpiCard label={t("retention.backWeek", { n: 1 })} value={w1 === null ? "–" : f.pct(w1)} unit={t("retention.average")} />
        <KpiCard label={t("retention.backWeek", { n: 4 })} value={w4 === null ? "–" : f.pct(w4)} unit={t("retention.average")} />
        <KpiCard
          label={t("retention.bestWeek1")}
          value={best ? f.pct(best.shares[1]!) : "–"}
          footer={best ? <span className="text-xs text-fg-muted">{t("retention.weekOf", { day: shortDay(best.week) })}</span> : undefined}
        />
        <KpiCard label={t("retention.newThisWeek")} value={f.num(data.cohorts.at(-1)?.visitors ?? 0)} unit={t("table.visitors")} />
      </KpiGrid>
      <Panel
        title={t("retention.weekly")}
        description={t("retention.weeklyDetail")}
        actions={
          <SegmentedControl
            label={t("retention.show")}
            value={show}
            onChange={setShow}
            options={[
              { value: "share", label: t("retention.share") },
              { value: "visitors", label: t("table.visitors") },
            ]}
          />
        }
      >
        <CohortGrid
          label={t("retention.weekly")}
          cohorts={data.cohorts.map((c) => ({ id: c.week, label: shortDay(c.week), size: c.visitors, values: show === "share" ? c.shares : c.counts }))}
          format={(v) => (show === "share" ? f.pct(v) : f.num(v))}
        />
      </Panel>
    </>
  );
}

function StickinessTab({ data }: { data: Retention }) {
  const t = useT();
  const f = useFormat();
  const s = data.stickiness;
  const last = s.at(-1);
  const week = s.slice(-7);
  const dau = week.reduce((n, d) => n + d.dau, 0) / Math.max(1, week.length);
  const labels = s.map((d) => shortDay(d.day));
  return (
    <>
      <KpiGrid>
        <KpiCard label={t("retention.daily")} value={f.num(Math.round(dau))} unit={t("retention.sevenDayAverage")} />
        <KpiCard label={t("retention.weeklyActive")} value={f.num(last?.wau ?? 0)} />
        <KpiCard label={t("retention.monthly")} value={f.num(last?.mau ?? 0)} />
        <KpiCard
          label="DAU / MAU"
          value={last?.mau ? f.pct(dau / last.mau) : "–"}
          footer={<span className="text-xs text-fg-muted">{t("retention.dauMauHint")}</span>}
        />
        <KpiCard label="DAU / WAU" value={last?.wau ? f.pct(dau / last.wau) : "–"} />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title={t("retention.active")} description={t("retention.activeDetail")}>
          <TimeSeriesChart
            label={t("retention.active")}
            series={[
              { id: "dau", name: t("retention.daily"), data: s.map((d) => d.dau) },
              { id: "wau", name: t("retention.weeklyActive"), data: s.map((d) => d.wau) },
              { id: "mau", name: t("retention.monthly"), data: s.map((d) => d.mau) },
            ]}
            defaultHidden={["mau"]}
            labels={labels}
            height={200}
            area={false}
            xTicks={5}
          />
        </Panel>
        <Panel title={t("retention.ratioDaily")}>
          <TimeSeriesChart
            label={t("retention.ratioDaily")}
            series={[{ id: "ratio", name: "DAU / MAU", data: s.map((d) => (d.mau ? Math.round((d.dau / d.mau) * 1000) / 10 : 0)) }]}
            labels={labels}
            height={200}
            xTicks={5}
            format={(v) => `${f.num(v)}%`}
          />
        </Panel>
      </div>
    </>
  );
}

function LifecycleTab({ data }: { data: Retention }) {
  const t = useT();
  const f = useFormat();
  type W = Retention["lifecycle"][number];
  return (
    <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Panel title={t("retention.byKind")}>
        <StackedBarChart
          label={t("retention.byKind")}
          categories={data.lifecycle.map((w) => t("retention.weekOf", { day: shortDay(w.week) }))}
          segments={[
            { id: "new", name: t("value.new") },
            { id: "returning", name: t("value.returning") },
            { id: "resurrected", name: t("retention.resurrected") },
          ]}
          values={data.lifecycle.map((w) => [w.new, w.returning, w.resurrected])}
          height={220}
          xTicks={4}
        />
      </Panel>
      <Panel flush title={t("retention.quietAndBack")} className="self-start">
        <DataTable<W>
          label={t("retention.quietAndBack")}
          columns={[
            { id: "week", header: t("retention.weekOfHeader"), width: "34%", cell: (x) => shortDay(x.week) },
            {
              id: "dormant",
              header: t("retention.dormant"),
              align: "right",
              mono: true,
              cell: (x) => f.num(x.dormant),
              description: t("retention.dormantDetail"),
            },
            {
              id: "resurrected",
              header: t("retention.back"),
              align: "right",
              mono: true,
              cell: (x) => f.num(x.resurrected),
              description: t("retention.backDetail"),
            },
          ]}
          rows={data.lifecycle}
          getRowId={(x) => x.week}
          resizable={false}
          columnMenu={false}
        />
      </Panel>
    </div>
  );
}
