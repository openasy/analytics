// Ecommerce: orders and revenue from the shop's openasy.ecommerce() calls, the steps to them, each product by SKU, and
// revenue by where the visit that bought came from.
import { Callout, DataTable, EmptyState, KpiCard, KpiGrid, Panel, SegmentedControl, TimeSeriesChart, type Column } from "@openasy/ui";
import { useState, type ReactNode } from "react";
import type { Ecommerce } from "./api.ts";
import { Code, shortDay } from "./common.tsx";
import { useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { Change, CsvButton, Failed, Loading, Note, Report, useDelta, useLoad, useReport, useTab } from "./report.tsx";

const TABS = ["sales", "products", "revenue"] as const;

const EXAMPLE = `    currency: TRY
    ecommerce: true`;
const CALL = `openasy.ecommerce("purchase", {
  order: "A-1001",
  value: 1840,
  currency: "TRY",
  items: [{ sku: "ESP-1000", name: "Espresso beans 1 kg", price: 920, quantity: 2 }],
});`;

export function EcommercePage({ at }: { at?: string }) {
  const t = useT();
  const r = useReport();
  const [tab, setTab] = useTab("ecommerce", TABS, at);
  const data = useLoad<Ecommerce>(r.site ? `/api/v1/ecommerce?${r.query()}` : null);
  const page = (children: ReactNode) => (
    <Report
      title={t("ecommerce.title")}
      description={t(`ecommerce.${tab}Detail`)}
      tabs={TABS.map((x) => ({ value: x, label: t(`ecommerce.${x}`), count: x === "products" && data?.products.length ? data.products.length : undefined }))}
      tab={tab}
      onTab={setTab}
    >
      {children}
    </Report>
  );
  if (data === null) return page(<Failed />);
  if (!data) return page(<Loading />);
  if (!data.enabled && !data.totals.orders)
    return page(
      <EmptyState title={t("ecommerce.off")}>
        <span className="flex flex-col gap-2">
          {t("ecommerce.offDetail")}
          <Code>{EXAMPLE}</Code>
          <Code>{CALL}</Code>
        </span>
      </EmptyState>,
    );
  return page(
    <>
      {tab === "sales" && <SalesTab data={data} />}
      {tab === "products" && <ProductsTab data={data} />}
      {tab === "revenue" && <RevenueTab data={data} />}
    </>,
  );
}

function SalesTab({ data }: { data: Ecommerce }) {
  const t = useT();
  const f = useFormat();
  const delta = useDelta();
  const c = data.compare?.totals;
  const money = (n: number) => f.money(n, data.currency);
  const first = data.funnel[0]?.visits ?? 0;
  return (
    <>
      <KpiGrid>
        <KpiCard label={t("ecommerce.revenue")} value={money(data.totals.revenue)} delta={delta(data.totals.revenue, c?.revenue)} />
        <KpiCard label={t("ecommerce.orders")} value={f.num(data.totals.orders)} delta={delta(data.totals.orders, c?.orders)} />
        <KpiCard
          label={t("ecommerce.averageOrder")}
          value={money(data.totals.averageOrder)}
          delta={c?.orders ? delta(data.totals.averageOrder, c.averageOrder) : undefined}
        />
        <KpiCard
          label={t("ecommerce.conversion")}
          value={f.pct(data.totals.conversionRate, 2)}
          delta={c ? delta(data.totals.conversionRate, c.conversionRate, { points: true }) : undefined}
        />
        <KpiCard
          label={t("ecommerce.refunds")}
          value={f.num(data.totals.refunds)}
          unit={data.totals.refunded ? money(data.totals.refunded) : t("ecommerce.ordersUnit")}
        />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title={t("ecommerce.revenueDaily")}>
          <TimeSeriesChart
            label={t("ecommerce.revenueDaily")}
            series={[
              { id: "revenue", name: t("ecommerce.revenue"), data: data.series.map((d) => d.revenue) },
              ...(data.compare
                ? [{ id: "compare", name: t(`choice.${data.compare.period}`), data: data.compare.series.map((d) => d.revenue), color: "var(--oa-fg-subtle)" }]
                : []),
            ]}
            labels={data.series.map((d) => shortDay(d.day))}
            height={200}
            xTicks={6}
            format={(v) => f.money(v, data.currency, true)}
          />
        </Panel>
        <Panel title={t("ecommerce.funnel")} description={t("ecommerce.funnelDetail")}>
          <ol aria-label={t("ecommerce.funnel")} className="m-0 flex list-none flex-col gap-2 p-0">
            {data.funnel.map((s, i) => (
              <li key={s.event} className="flex flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium text-fg">{t(`ecommerce.step_${s.event}`)}</span>
                    <code className="truncate text-2xs text-fg-muted">{s.event}</code>
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">
                    {f.num(s.visits)} · {f.share(s.visits, first)}
                  </span>
                </span>
                <span className="h-4 overflow-hidden rounded bg-subtle">
                  <span
                    className="block h-4 rounded"
                    style={{
                      width: `${first ? (s.visits / first) * 100 : 0}%`,
                      background: i === data.funnel.length - 1 ? "var(--oa-success)" : "var(--oa-accent)",
                    }}
                  />
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
      <Callout tone="info" title={t("ecommerce.sendsTitle")}>
        {t("ecommerce.sends")}
      </Callout>
    </>
  );
}

function ProductsTab({ data }: { data: Ecommerce }) {
  const t = useT();
  const f = useFormat();
  type P = Ecommerce["products"][number];
  const then = new Map((data.compare?.products ?? []).map((p) => [p.sku, p]));
  const cols: Column<P>[] = [
    {
      id: "name",
      header: t("ecommerce.product"),
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{p.name ?? p.sku}</span>
          <code className="truncate text-2xs text-fg-muted">
            {p.sku}
            {p.category ? ` · ${p.category}` : ""}
          </code>
        </span>
      ),
    },
    { id: "views", header: t("ecommerce.views"), align: "right", mono: true, sortValue: (p) => p.views, cell: (p) => f.num(p.views) },
    { id: "carts", header: t("ecommerce.carts"), align: "right", mono: true, sortValue: (p) => p.carts, cell: (p) => f.num(p.carts) },
    {
      id: "cartRate",
      header: t("ecommerce.cartRate"),
      align: "right",
      mono: true,
      sortValue: (p) => (p.views ? p.carts / p.views : 0),
      cell: (p) => (p.views ? f.share(p.carts, p.views) : "–"),
    },
    { id: "units", header: t("ecommerce.sold"), align: "right", mono: true, sortValue: (p) => p.units, cell: (p) => f.num(p.units) },
    { id: "revenue", header: t("ecommerce.revenue"), align: "right", mono: true, sortValue: (p) => p.revenue, cell: (p) => f.money(p.revenue, data.currency) },
    ...(data.compare
      ? [
          {
            id: "change",
            header: t("table.change"),
            align: "right" as const,
            mono: true,
            cell: (p: P) => <Change now={p.revenue} then={then.get(p.sku)?.revenue} />,
          },
        ]
      : []),
    {
      id: "refunded",
      header: t("ecommerce.refunded"),
      align: "right",
      mono: true,
      sortValue: (p) => p.refunded,
      cell: (p) => (p.refunded ? f.num(p.refunded) : "–"),
    },
  ];
  return (
    <Panel
      flush
      title={t("ecommerce.products")}
      description={t("ecommerce.productsSummary", { revenue: f.money(data.totals.revenue, data.currency), units: f.num(data.totals.units) })}
      actions={
        <CsvButton
          name="products"
          rows={data.products}
          columns={[
            ["SKU", (p) => p.sku],
            [t("ecommerce.product"), (p) => p.name],
            [t("ecommerce.views"), (p) => p.views],
            [t("ecommerce.carts"), (p) => p.carts],
            [t("ecommerce.sold"), (p) => p.units],
            [`${t("ecommerce.revenue")}${data.currency ? ` ${data.currency}` : ""}`, (p) => p.revenue],
          ]}
        />
      }
    >
      <DataTable
        label={t("ecommerce.products")}
        columns={cols}
        rows={data.products}
        getRowId={(p) => p.sku}
        defaultSort={{ id: "revenue", direction: "desc" }}
        minWidth={760}
        pageSize={50}
        empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>}
      />
    </Panel>
  );
}

function RevenueTab({ data }: { data: Ecommerce }) {
  const t = useT();
  const f = useFormat();
  const [by, setBy] = useState<"source" | "campaign" | "channel">("source");
  type Row = { value: string | null; visits: number; orders: number; revenue: number };
  const rows: Row[] =
    by === "source"
      ? data.sources.map(({ source, ...x }) => ({ value: source, ...x }))
      : by === "campaign"
        ? data.campaigns.map(({ campaign, ...x }) => ({ value: campaign, ...x }))
        : data.channels.map(({ channel, ...x }) => ({ value: channel, ...x }));
  const name = (v: string | null) => (by === "source" ? f.source(v) : by === "channel" ? f.channel(v) : (v ?? t("ecommerce.noCampaign")));
  const cols: Column<Row>[] = [
    { id: "name", header: t(`attribution.by_${by}`), cell: (x) => <span className="font-mono text-xs font-medium">{name(x.value)}</span> },
    { id: "visits", header: t("table.visits"), align: "right", mono: true, sortValue: (x) => x.visits, cell: (x) => f.num(x.visits) },
    { id: "orders", header: t("ecommerce.orders"), align: "right", mono: true, sortValue: (x) => x.orders, cell: (x) => f.num(x.orders) },
    {
      id: "rate",
      header: t("ecommerce.bought"),
      align: "right",
      mono: true,
      sortValue: (x) => (x.visits ? x.orders / x.visits : 0),
      cell: (x) => f.share(x.orders, x.visits, 2),
    },
    { id: "revenue", header: t("ecommerce.revenue"), align: "right", mono: true, sortValue: (x) => x.revenue, cell: (x) => f.money(x.revenue, data.currency) },
    {
      id: "aov",
      header: t("ecommerce.averageOrder"),
      align: "right",
      mono: true,
      sortValue: (x) => (x.orders ? x.revenue / x.orders : 0),
      cell: (x) => (x.orders ? f.money(x.revenue / x.orders, data.currency) : "–"),
    },
  ];
  return (
    <>
      <SegmentedControl
        label={t("ecommerce.revenueBy")}
        value={by}
        onChange={setBy}
        options={(["source", "campaign", "channel"] as const).map((b) => ({ value: b, label: t(`attribution.by_${b}`) }))}
      />
      <Panel
        flush
        title={t(`ecommerce.revenueBy_${by}`)}
        description={t("ecommerce.lastTouch")}
        actions={
          <CsvButton
            name={`revenue-by-${by}`}
            rows={rows}
            columns={[
              [t(`attribution.by_${by}`), (x) => name(x.value)],
              [t("table.visits"), (x) => x.visits],
              [t("ecommerce.orders"), (x) => x.orders],
              [`${t("ecommerce.revenue")}${data.currency ? ` ${data.currency}` : ""}`, (x) => x.revenue],
            ]}
          />
        }
      >
        <DataTable
          key={by}
          label={t(`ecommerce.revenueBy_${by}`)}
          columns={cols}
          rows={rows}
          getRowId={(x) => x.value ?? "(none)"}
          defaultSort={{ id: "revenue", direction: "desc" }}
          minWidth={720}
          empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>}
        />
      </Panel>
      <Note>{t("ecommerce.attributionNote")}</Note>
    </>
  );
}
