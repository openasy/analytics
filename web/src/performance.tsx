// Performance: Core Web Vitals from real visits at the 75th percentile, with the share of good and poor samples, by
// kind of device and by page.
import { Badge, DataTable, EmptyState, KpiCard, KpiGrid, Panel, SegmentedControl, TimeSeriesChart, type Column, type Tone } from "@openasy/ui";
import { useState, type ReactNode } from "react";
import type { Vital, Vitals, VitalSummary } from "./api.ts";
import { Code, shortDay } from "./common.tsx";
import { useFormat, type Format } from "./format.ts";
import { useT } from "./i18n.ts";
import { CsvButton, Failed, Loading, Note, Report, SplitBar, useDelta, useLoad, useReport } from "./report.tsx";

const KEYS: Vital[] = ["lcp", "inp", "cls"];

/** LCP in seconds, INP in milliseconds, CLS as a score. */
export function vitalValue(f: Format, k: Vital, v: number | null): string {
  if (v === null) return "–";
  if (k === "lcp") return `${f.num(Math.round(v / 100) / 10)} s`;
  if (k === "inp") return `${f.num(Math.round(v))} ms`;
  return new Intl.NumberFormat(f.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

const toneOf = (v: number | null, [good, poor]: [number, number]): Tone | undefined =>
  v === null ? undefined : v <= good ? "success" : v <= poor ? "warning" : "danger";

export function PerformancePage() {
  const t = useT();
  const f = useFormat();
  const r = useReport();
  const delta = useDelta();
  const [device, setDevice] = useState("all");
  const [daily, setDaily] = useState<Vital>("lcp");
  const data = useLoad<Vitals>(r.site ? `/api/v1/vitals?${r.query()}` : null);
  const head = (children: ReactNode) => (
    <Report title={t("performance.title")} description={t("performance.description")}>
      {children}
    </Report>
  );
  if (data === null) return head(<Failed />);
  if (!data) return head(<Loading />);
  if (!data.totals.samples && !r.current?.vitals)
    return head(
      <EmptyState title={t("performance.off")}>
        <span className="flex flex-col gap-2">
          {t("performance.offDetail")}
          <Code>{"    vitals: true"}</Code>
        </span>
      </EmptyState>,
    );
  const pick = (v: Vitals | Vitals["compare"] | undefined): (Record<Vital, VitalSummary> & { samples: number }) | undefined =>
    !v ? undefined : device === "all" ? v.totals : v.devices.find((d) => d.device === device);
  const now = pick(data);
  const then = pick(data.compare);
  const pages = data.pages.filter((p) => device === "all" || p.device === device);
  type P = (typeof pages)[number];
  const cell = (k: Vital, v: number | null) => {
    const tone = toneOf(v, data.thresholds[k]);
    return tone === "success" || !tone ? <span className="font-mono">{vitalValue(f, k, v)}</span> : <Badge tone={tone}>{vitalValue(f, k, v)}</Badge>;
  };
  const cols: Column<P>[] = [
    { id: "path", header: t("table.page"), cell: (p) => <span className="analytics-wrap font-mono text-xs font-medium">{p.path}</span> },
    ...(device === "all" ? [{ id: "device", header: t("table.device"), cell: (p: P) => <span className="text-xs">{f.device(p.device)}</span> }] : []),
    { id: "samples", header: t("table.samples"), align: "right", mono: true, sortValue: (p) => p.samples, cell: (p) => f.num(p.samples) },
    ...KEYS.map((k): Column<P> => ({
      id: k,
      header: t(`vitals.${k}`),
      align: "right",
      sortValue: (p) => (p[k] ?? -1) / data.thresholds[k][0],
      cell: (p) => cell(k, p[k]),
    })),
  ];
  return head(
    <>
      {data.devices.length > 1 && (
        <SegmentedControl
          label={t("table.device")}
          value={device}
          onChange={setDevice}
          options={[{ value: "all", label: t("performance.allDevices") }, ...data.devices.map((d) => ({ value: d.device, label: f.device(d.device) }))]}
        />
      )}
      <KpiGrid minWidth={240}>
        {KEYS.map((k) => {
          const v = now?.[k];
          const tone = toneOf(v?.p75 ?? null, data.thresholds[k]);
          const [good, poor] = data.thresholds[k];
          return (
            <KpiCard
              key={k}
              label={`${t(`vitals.${k}`)} · ${t(`vitals.${k}Full`)}`}
              value={vitalValue(f, k, v?.p75 ?? null)}
              unit="p75"
              tone={tone}
              delta={v?.p75 != null && then?.[k].p75 != null ? delta(v.p75, then[k].p75, { lowerIsBetter: true }) : undefined}
              footer={
                <span className="flex flex-col gap-1">
                  <span className="text-xs text-fg-muted">
                    {t("performance.thresholds", {
                      verdict: tone
                        ? t(`vitals.${tone === "success" ? "good" : tone === "warning" ? "needsImprovement" : "poor"}`)
                        : t("performance.noSamples"),
                      good: vitalValue(f, k, good),
                      poor: vitalValue(f, k, poor),
                    })}
                  </span>
                  {v && v.samples > 0 && <SplitBar label={t(`vitals.${k}`)} good={v.good} poor={v.poor} />}
                  <span className="text-2xs text-fg-muted">{t("performance.samples", { count: v?.samples ?? 0, samples: f.num(v?.samples ?? 0) })}</span>
                </span>
              }
            />
          );
        })}
      </KpiGrid>
      {data.series.some((d) => d.samples > 0) && (
        <Panel
          title={t("performance.daily", { vital: t(`vitals.${daily}`) })}
          description={t("performance.dailyDetail")}
          actions={
            <SegmentedControl
              label={t("performance.dailyVital")}
              value={daily}
              onChange={setDaily}
              options={KEYS.map((k) => ({ value: k, label: t(`vitals.${k}`) }))}
            />
          }
        >
          <TimeSeriesChart
            label={t("performance.daily", { vital: t(`vitals.${daily}`) })}
            series={[{ id: daily, name: `${t(`vitals.${daily}`)} p75`, data: data.series.map((d) => d[daily] ?? 0) }]}
            labels={data.series.map((d) => shortDay(d.day))}
            height={200}
            xTicks={6}
            area={false}
            threshold={{ value: data.thresholds[daily][0], label: t("performance.goodUpTo", { value: vitalValue(f, daily, data.thresholds[daily][0]) }) }}
            format={(x) => vitalValue(f, daily, x)}
          />
        </Panel>
      )}
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel flush title={t("performance.byDevice")} description={t("performance.byDeviceDetail")} className="self-start">
          <DataTable
            label={t("performance.byDevice")}
            columns={[
              { id: "device", header: t("table.device"), cell: (d) => <span className="font-medium">{f.device(d.device)}</span> },
              { id: "samples", header: t("table.samples"), align: "right", mono: true, sortValue: (d) => d.samples, cell: (d) => f.num(d.samples) },
              ...KEYS.map((k): Column<Vitals["devices"][number]> => ({
                id: k,
                header: t(`vitals.${k}`),
                align: "right",
                sortValue: (d) => d[k].p75 ?? -1,
                cell: (d) => cell(k, d[k].p75),
              })),
            ]}
            rows={data.devices}
            getRowId={(d) => d.device}
            minWidth={420}
            onRowClick={(d) => setDevice(d.device)}
            activeRowId={device === "all" ? undefined : device}
            empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>}
          />
        </Panel>
        <Panel
          flush
          title={t("performance.byPage")}
          description={t("performance.byPageDetail")}
          actions={
            <CsvButton
              name={`web-vitals-${device}`}
              rows={pages}
              columns={[
                [t("table.page"), (p) => p.path],
                [t("table.device"), (p) => p.device],
                [t("table.samples"), (p) => p.samples],
                ["LCP ms", (p) => p.lcp],
                ["INP ms", (p) => p.inp],
                ["CLS", (p) => p.cls],
              ]}
            />
          }
        >
          <DataTable
            key={device}
            label={t("performance.byPage")}
            columns={cols}
            rows={pages}
            getRowId={(p) => `${p.path}|${p.device}`}
            defaultSort={{ id: "lcp", direction: "desc" }}
            minWidth={560}
            pageSize={25}
            empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>}
          />
        </Panel>
      </div>
      <Note>{t("performance.note")}</Note>
    </>,
  );
}
