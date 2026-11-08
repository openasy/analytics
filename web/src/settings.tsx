// Settings that are kept in analytics.yaml: shown here, read-only, with the file as it was applied. They are changed in
// the file and reviewed like code; analytics reads it again within a minute.
//
// Rebuilt here from published @openasy/ui components after the FileSettings page of the ui repo's Storybook
// (src/stories/shared/FileSettings.tsx), which is not in a published @openasy/ui version yet.
import { Callout, PageHeader, Panel, StatusBadge, useAgo } from "@openasy/ui";
import { FileCode } from "lucide-react";
import type { ReactNode } from "react";
import type { SettingsFile, Site, Summary } from "./api.ts";
import { useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { Failed, Loading, useLoad } from "./report.tsx";

interface Item {
  label: string;
  value: ReactNode;
  /** Where it is in the file, such as sites.shop.goals. */
  path: string;
}

function Group({ title, description, items }: { title: string; description?: string; items: Item[] }) {
  return (
    <Panel title={title} description={description} aria-label={title}>
      <dl className="analytics-settings m-0 grid gap-x-3 gap-y-2 text-xs">
        {items.map((i) => (
          <div key={i.path} className="contents">
            <dt className="flex flex-col text-fg-muted">
              {i.label}
              <code className="truncate font-mono text-2xs text-fg-muted">{i.path}</code>
            </dt>
            <dd className="m-0 min-w-0 text-fg">{i.value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

const mono = (v: string) => <span className="analytics-wrap font-mono">{v}</span>;

export function SettingsFilePage({ sites, summary }: { sites: Site[]; summary?: Summary }) {
  const t = useT();
  const f = useFormat();
  const ago = useAgo();
  const data = useLoad<SettingsFile>("/api/v1/settings");
  const file = data?.file;
  const name = file?.path.split("/").pop() ?? "analytics.yaml";
  const applied = file?.appliedAt ? ago(file.appliedAt) : t("file.never");
  const off = t("file.off");
  const geo = summary?.location;
  const site = (s: Site): Item[] => {
    const p = `sites.${s.name}`;
    return [
      { label: t("file.domains"), value: mono(s.domains.join(", ")), path: `${p}.domains` },
      { label: t("file.consent"), value: s.consent === "required" ? t("sites.asksFirst") : t("sites.fromFirstPage"), path: `${p}.consent` },
      {
        label: t("file.goals"),
        value: s.goals.length
          ? s.goals
              .map(
                (g) =>
                  `${g.name} (${g.path ? g.path : g.download ? g.download : t("goals.ruleEvent", { name: g.event ?? "" })}${g.value ? `, ${t("table.value")} ${"amount" in g.value ? g.value.amount : g.value.prop}` : ""})`,
              )
              .join(", ")
          : t("file.none"),
        path: `${p}.goals`,
      },
      {
        label: t("file.funnels"),
        value: s.funnels.length ? s.funnels.map((x) => t("file.funnelSteps", { name: x.name, count: x.steps.length })).join("; ") : t("file.none"),
        path: `${p}.funnels`,
      },
      {
        label: t("file.search"),
        value: s.search ? mono(`${s.search.path ?? "*"}?${s.search.params.join("=, ")}=`) : off,
        path: `${p}.search`,
      },
      { label: t("file.notFound"), value: s.notFound ? t("file.notFoundTitle", { title: s.notFound.title }) : t("file.notFoundMeta"), path: `${p}.notFound` },
      {
        label: t("file.channels"),
        value: Object.keys(s.channels).length
          ? Object.entries(s.channels)
              .map(([c, list]) => `${f.channel(c)}: ${list.join(", ")}`)
              .join("; ")
          : t("file.builtIn"),
        path: `${p}.channels`,
      },
      { label: t("file.currency"), value: s.currency ? mono(s.currency) : t("file.none"), path: `${p}.currency` },
      { label: t("file.ecommerce"), value: s.ecommerce ? t("file.on") : off, path: `${p}.ecommerce` },
      ...(["google", "bing", "yandex"] as const)
        .filter((e) => s.searchConsole?.[e])
        .map((e) => ({ label: t(`file.searchConsole_${e}`), value: mono(s.searchConsole[e]!), path: `${p}.searchConsole.${e}` })),
      { label: t("file.forms"), value: s.forms ? t("file.on") : off, path: `${p}.forms` },
      { label: t("file.vitals"), value: s.vitals ? t("file.on") : off, path: `${p}.vitals` },
      {
        label: t("file.replays"),
        value: s.replays ? t("file.replaysValue", { sample: s.replays.sample, keep: s.replays.keep }) : off,
        path: `${p}.replays`,
      },
      { label: t("file.location"), value: t(`file.location_${s.location}`), path: `${p}.location` },
      { label: t("file.downloads"), value: s.downloads.length ? mono(s.downloads.join(", ")) : t("file.none"), path: `${p}.downloads` },
      { label: t("file.keep"), value: t("file.keepValue", { events: s.keep.events, days: s.keep.days }), path: `${p}.keep` },
      ...(s.query.length ? [{ label: t("file.query"), value: mono(s.query.join(", ")), path: `${p}.query` }] : []),
      ...(s.ignore.length ? [{ label: t("file.ignore"), value: mono(s.ignore.join(", ")), path: `${p}.ignore` }] : []),
      ...(s.serverKey
        ? [
            {
              label: t("file.serverKey"),
              value: (
                <span className="flex flex-wrap items-center gap-1.5">
                  {mono(s.serverKey.variable)}
                  <StatusBadge tone={s.serverKey.set ? "success" : "warning"}>{s.serverKey.set ? t("file.keySet") : t("file.keyMissing")}</StatusBadge>
                </span>
              ),
              path: `${p}.serverKey`,
            },
          ]
        : []),
    ];
  };
  return (
    <>
      <PageHeader
        title={t("file.title")}
        description={t("file.description", { file: name })}
        meta={
          file?.error ? (
            <StatusBadge tone="danger">{t("sites.notApplied")}</StatusBadge>
          ) : file?.appliedAt ? (
            <StatusBadge tone="success">{t("file.applied", { when: applied })}</StatusBadge>
          ) : undefined
        }
      />
      <Callout tone="info" title={t("file.readOnly", { file: name })}>
        {t("file.readOnlyDetail")}
      </Callout>
      {file?.error && (
        <Callout tone="danger" title={t("file.notAppliedTitle")}>
          <span className="flex flex-col gap-1">
            <span className="analytics-wrap font-mono text-xs">{file.error}</span>
            {file.appliedAt && <span>{t("sites.lastGoodStays")}</span>}
          </span>
        </Callout>
      )}
      {file?.warnings.length ? (
        <Callout tone="warning" title={t("file.warnings")}>
          <ul className="analytics-list flex flex-col gap-1">
            {file.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {data === null && <Failed />}
      {data === undefined && <Loading />}
      {data && (
        <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-2.5">
            {sites.map((s) => (
              <Group key={s.name} title={s.name} description={s.domains.map((d) => d.replace(/^https?:\/\//, "")).join(", ")} items={site(s)} />
            ))}
            {geo && (
              <Group
                title={t("file.locationGroup")}
                description={t("file.locationGroupDetail")}
                items={[
                  { label: t("file.geoDatabase"), value: geo.enabled ? mono(geo.database ?? geo.file) : off, path: "geoip.database" },
                  {
                    label: t("file.geoUpdate"),
                    value: !geo.enabled ? off : geo.update ? t("file.geoMonthly", { month: geo.month ?? "–" }) : t("file.geoNever"),
                    path: "geoip.update",
                  },
                  ...(geo.error ? [{ label: t("file.geoError"), value: <span className="text-danger-text">{geo.error}</span>, path: "geoip" }] : []),
                ]}
              />
            )}
          </div>
          <Panel
            title={name}
            description={t("file.asApplied", { when: applied })}
            actions={<FileCode aria-hidden className="size-3.5 text-fg-muted" />}
            className="self-start"
          >
            <pre
              aria-label={t("file.yamlLabel", { file: name })}
              className="m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg"
            >
              {data.yaml ?? t("file.noFile")}
            </pre>
          </Panel>
        </div>
      )}
    </>
  );
}
