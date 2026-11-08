// Sharing: email reports on a schedule, read-only links for people without an account, and alerts on traffic that is
// far from the usual. The shared dashboard itself, which such a link opens without signing in, is at the end.
import {
  Badge,
  BarList,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SegmentedControl,
  SelectField,
  StatusBadge,
  Switch,
  Tabs,
  TextField,
  TimeRangePicker,
  TimeSeriesChart,
  useAgo,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Copy, Mail, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SECTIONS, type Alert, type AlertRule, type EmailReport, type Range, type Section, type Share } from "./api.ts";
import { Code, shortDay, time } from "./common.tsx";
import { useFormat } from "./format.ts";
import { useT } from "./i18n.ts";
import { Failed, Flag, Loading, Note, useReport, useTab } from "./report.tsx";

const TABS = ["email", "links", "alerts"] as const;

export function SharingPage({ at }: { at?: string }) {
  const t = useT();
  const r = useReport();
  const [tab, setTab] = useTab("sharing", TABS, at);
  return (
    <>
      <PageHeader title={t("sharing.title")} description={t(`sharing.${tab}Detail`)}>
        {r.sites.length > 1 && (
          <SelectField
            aria-label={t("choice.site")}
            className="w-40"
            value={r.site}
            onChange={(e) => r.setSite(e.target.value)}
            options={r.sites.map((s) => ({ value: s.name, label: s.name }))}
          />
        )}
        <Tabs label={t("sharing.title")} value={tab} onChange={setTab} items={TABS.map((x) => ({ value: x, label: t(`sharing.${x}`) }))} />
      </PageHeader>
      <div className="flex min-w-0 flex-col gap-2.5">
        {tab === "email" && <EmailReportsTab />}
        {tab === "links" && <SharedLinksTab />}
        {tab === "alerts" && <AlertsTab />}
      </div>
    </>
  );
}

function Status({ text, error }: { text: string; error?: boolean }) {
  if (!text) return <span />;
  return (
    <p role={error ? "alert" : "status"} className={`m-0 text-sm ${error ? "text-danger-text" : "text-success"}`}>
      {text}
    </p>
  );
}

const SMTP_EXAMPLE = `smtp:
  host: mail.example.com
  port: 587
  security: starttls
  user: analytics@example.com
  from: "Analytics <analytics@example.com>"
  timeZone: Europe/Istanbul`;

function useList<T>(path: string | null) {
  const { call } = useReport();
  const [data, setData] = useState<T | null>();
  const load = useCallback(() => {
    if (path) void call<T>(path).then(setData, () => setData(null));
  }, [call, path]);
  useEffect(load, [load]);
  return [data, load] as const;
}

const recipientList = (v: string) =>
  v
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function SectionPicker({ value, onChange, legend }: { value: Section[]; onChange: (v: Section[]) => void; legend: string }) {
  const t = useT();
  const r = useReport();
  const list = SECTIONS.filter((s) => s !== "ecommerce" || r.current?.ecommerce);
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1 text-xs font-medium text-fg">{legend}</legend>
      <div className="grid grid-cols-2 gap-1.5">
        {list.map((s) => (
          <Checkbox
            key={s}
            label={t(`sharing.section_${s}`)}
            checked={value.includes(s)}
            onChange={() => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s])}
          />
        ))}
      </div>
    </fieldset>
  );
}

/* --------------------------------------------------------- email reports */

function EmailReportsTab() {
  const t = useT();
  const r = useReport();
  const { can } = useAuth();
  const [data, reload] = useList<{ reports: EmailReport[]; smtp: boolean }>(r.site ? `/api/v1/email-reports?site=${encodeURIComponent(r.site)}` : null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState({ text: "", error: false });
  if (data === null) return <Failed />;
  if (!data) return <Loading />;
  const segment = (id: string | null) => (id ? (r.segments.find((s) => s.id === id)?.name ?? t("sharing.segmentGone")) : t("segments.all"));
  const send = (m: EmailReport) =>
    r.call<EmailReport & { sent: number }>(`/api/v1/email-reports/${encodeURIComponent(m.id)}/send`, { method: "POST" }).then(
      (x) => (setStatus({ text: x.lastError ? x.lastError : t("sharing.sentTo", { name: m.name, count: x.sent }), error: !!x.lastError }), reload()),
      (err: Error) => setStatus({ text: err.message, error: true }),
    );
  const remove = (m: EmailReport) =>
    r.call(`/api/v1/email-reports/${encodeURIComponent(m.id)}`, { method: "DELETE" }).then(
      () => (setStatus({ text: t("sharing.reportDeleted", { name: m.name }), error: false }), reload()),
      (err: Error) => setStatus({ text: err.message, error: true }),
    );
  const cols: Column<EmailReport>[] = [
    {
      id: "name",
      header: t("sharing.report"),
      cell: (m) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{m.name}</span>
          <span className="truncate text-2xs text-fg-muted">
            {m.sections.map((s) => t(`sharing.section_${s}`)).join(", ")} · {segment(m.segment)}
          </span>
        </span>
      ),
    },
    { id: "to", header: t("sharing.to"), cell: (m) => <span className="analytics-wrap text-xs">{m.recipients.join(", ")}</span> },
    { id: "when", header: t("sharing.when"), cell: (m) => t(`sharing.every_${m.every}`) },
    {
      id: "last",
      header: t("sharing.lastSent"),
      cell: (m) =>
        m.lastError ? (
          <Badge tone="danger" title={m.lastError}>
            {t("sharing.notSent")}
          </Badge>
        ) : m.lastSentAt ? (
          <span className="text-xs">{time(m.lastSentAt)}</span>
        ) : (
          <span className="text-xs text-fg-muted">{t("sharing.notYet")}</span>
        ),
    },
    ...(can("editor")
      ? [
          {
            id: "actions",
            header: <span className="sr-only">{t("sharing.actions")}</span>,
            label: t("sharing.actions"),
            align: "right" as const,
            cell: (m: EmailReport) => (
              <span className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" icon={<Mail aria-hidden />} disabled={!data.smtp} onClick={() => void send(m)}>
                  {t("sharing.sendNow")}
                </Button>
                <IconButton size="sm" label={t("sharing.deleteReport", { name: m.name })} onClick={() => void remove(m)}>
                  <Trash2 aria-hidden />
                </IconButton>
              </span>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      {!data.smtp && (
        <Callout tone="warning" title={t("sharing.noSmtp")}>
          <span className="flex flex-col gap-2">
            {t("sharing.noSmtpDetail")}
            <Code>{SMTP_EXAMPLE}</Code>
          </span>
        </Callout>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Status {...status} />
        {can("editor") && (
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
            {t("sharing.newReport")}
          </Button>
        )}
      </div>
      <Panel flush title={t("sharing.email")}>
        <DataTable
          label={t("sharing.email")}
          columns={cols}
          rows={data.reports}
          getRowId={(m) => m.id}
          minWidth={760}
          empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("sharing.noReports")}</p>}
        />
      </Panel>
      <Note>{t("sharing.emailNote")}</Note>
      {open && (
        <EmailReportDialog
          onClose={() => setOpen(false)}
          onCreated={(m) => {
            setOpen(false);
            setStatus({ text: t("sharing.reportCreated", { name: m.name, when: t(`sharing.every_${m.every}`) }), error: false });
            reload();
          }}
        />
      )}
    </>
  );
}

function EmailReportDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (m: EmailReport) => void }) {
  const t = useT();
  const r = useReport();
  const [name, setName] = useState("");
  const [to, setTo] = useState("");
  const [every, setEvery] = useState<EmailReport["every"]>("weekly");
  const [sections, setSections] = useState<Section[]>(["overview"]);
  const [segment, setSegment] = useState("");
  const [error, setError] = useState("");
  const ok = name.trim() && recipientList(to).length && sections.length;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("sharing.newReport")}
      description={t("sharing.newReportDetail")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        void r
          .call<EmailReport>("/api/v1/email-reports", {
            method: "POST",
            body: JSON.stringify({ site: r.site, name: name.trim(), recipients: recipientList(to), every, sections, segment: segment || null }),
          })
          .then(onCreated, (err: Error) => setError(err.message));
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ok}>
            {t("sharing.createReport")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label={t("sharing.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("sharing.reportPlaceholder")} />
        <TextField
          label={t("sharing.recipients")}
          hint={t("sharing.recipientsHint")}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="name@example.com"
        />
        <SegmentedControl
          label={t("sharing.howOften")}
          value={every}
          onChange={setEvery}
          options={(["daily", "weekly", "monthly"] as const).map((x) => ({ value: x, label: t(`sharing.${x}`) }))}
        />
        <p className="m-0 text-xs text-fg-muted">{t(`sharing.every_${every}`)}</p>
        <SectionPicker legend={t("sharing.sections")} value={sections} onChange={setSections} />
        <SelectField
          label={t("segments.segment")}
          value={segment}
          onChange={(e) => setSegment(e.target.value)}
          options={[{ value: "", label: t("segments.all") }, ...r.segments.map((s) => ({ value: s.id, label: s.name }))]}
        />
        {error && (
          <p role="alert" className="m-0 text-xs text-danger-text">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------- shared links */

function SharedLinksTab() {
  const t = useT();
  const r = useReport();
  const f = useFormat();
  const { can } = useAuth();
  const [data, reload] = useList<{ shares: Share[] }>(r.site ? `/api/v1/shares?site=${encodeURIComponent(r.site)}` : null);
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<{ name: string; url: string } | null>(null);
  const [status, setStatus] = useState({ text: "", error: false });
  if (data === null) return <Failed />;
  if (!data) return <Loading />;
  const revoke = (l: Share) =>
    r.call(`/api/v1/shares/${encodeURIComponent(l.id)}`, { method: "DELETE" }).then(
      () => (setStatus({ text: t("sharing.revoked", { name: l.name }), error: false }), reload()),
      (err: Error) => setStatus({ text: err.message, error: true }),
    );
  const cols: Column<Share>[] = [
    {
      id: "name",
      header: t("sharing.link"),
      cell: (l) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{l.name}</span>
          <span className="truncate text-2xs text-fg-muted">
            {l.sections.map((s) => t(`sharing.section_${s}`)).join(", ")}
            {l.createdBy ? ` · ${t("sharing.by", { name: l.createdBy })}` : ""}
          </span>
        </span>
      ),
    },
    {
      id: "access",
      header: t("sharing.access"),
      cell: (l) => (l.password ? <Badge tone="info">{t("sharing.withPassword")}</Badge> : <Badge tone="warning">{t("sharing.public")}</Badge>),
    },
    { id: "expires", header: t("sharing.expires"), cell: (l) => <span className="text-xs">{l.expiresAt ? time(l.expiresAt) : t("sharing.never")}</span> },
    { id: "views", header: t("sharing.opened"), align: "right", mono: true, sortValue: (l) => l.views, cell: (l) => f.num(l.views) },
    ...(can("editor")
      ? [
          {
            id: "actions",
            header: <span className="sr-only">{t("sharing.actions")}</span>,
            label: t("sharing.actions"),
            align: "right" as const,
            cell: (l: Share) => (
              <IconButton size="sm" label={t("sharing.revoke", { name: l.name })} onClick={() => void revoke(l)}>
                <Trash2 aria-hidden />
              </IconButton>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Status {...status} />
        {can("editor") && (
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
            {t("sharing.newLink")}
          </Button>
        )}
      </div>
      {made && (
        <Callout tone="success" title={t("sharing.linkReady", { name: made.name })}>
          <span className="flex flex-wrap items-center gap-2">
            <code className="analytics-wrap font-mono text-xs">{made.url}</code>
            <Button
              size="sm"
              icon={<Copy aria-hidden />}
              onClick={() => void navigator.clipboard?.writeText(made.url).then(() => setStatus({ text: t("sharing.copied"), error: false }))}
            >
              {t("sharing.copy")}
            </Button>
          </span>
          <span className="mt-1 block text-xs">{t("sharing.linkOnce")}</span>
        </Callout>
      )}
      <Panel flush title={t("sharing.links")}>
        <DataTable
          label={t("sharing.links")}
          columns={cols}
          rows={data.shares}
          getRowId={(l) => l.id}
          minWidth={680}
          empty={<p className="m-0 px-3 py-2 text-sm text-fg-muted">{t("sharing.noLinks")}</p>}
        />
      </Panel>
      <Callout tone="info" title={t("sharing.totalsOnly")}>
        {t("sharing.totalsOnlyDetail")}
      </Callout>
      {open && (
        <ShareLinkDialog
          onClose={() => setOpen(false)}
          onCreated={(l) => {
            setOpen(false);
            setMade({ name: l.name, url: l.url });
            reload();
          }}
        />
      )}
    </>
  );
}

function ShareLinkDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (l: Share & { url: string }) => void }) {
  const t = useT();
  const r = useReport();
  const [name, setName] = useState("");
  const [sections, setSections] = useState<Section[]>(["overview"]);
  const [access, setAccess] = useState<"password" | "public">("password");
  const [password, setPassword] = useState("");
  const [expires, setExpires] = useState("30");
  const [error, setError] = useState("");
  const ok = name.trim() && sections.length && (access === "public" || password.length >= 12);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("sharing.newLink")}
      description={t("sharing.newLinkDetail", { site: r.site })}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        void r
          .call<Share & { url: string }>("/api/v1/shares", {
            method: "POST",
            body: JSON.stringify({
              site: r.site,
              name: name.trim(),
              sections,
              password: access === "password" ? password : null,
              expiresDays: expires === "never" ? null : Number(expires),
            }),
          })
          .then(onCreated, (err: Error) => setError(err.message));
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ok}>
            {t("sharing.createLink")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label={t("sharing.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("sharing.linkPlaceholder")} />
        <SectionPicker legend={t("sharing.reports")} value={sections} onChange={setSections} />
        <SegmentedControl
          label={t("sharing.access")}
          value={access}
          onChange={setAccess}
          options={[
            { value: "password", label: t("sharing.withPassword") },
            { value: "public", label: t("sharing.public") },
          ]}
        />
        {access === "password" && (
          <TextField
            label={t("sharing.password")}
            type="password"
            hint={t("sharing.passwordHint")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        )}
        <SelectField
          label={t("sharing.expires")}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          options={["7", "30", "90", "never"].map((x) => ({ value: x, label: x === "never" ? t("sharing.never") : t("sharing.inDays", { count: Number(x) }) }))}
        />
        {error && (
          <p role="alert" className="m-0 text-xs text-danger-text">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* --------------------------------------------------------------- alerts */

function AlertsTab() {
  const t = useT();
  const r = useReport();
  const f = useFormat();
  const ago = useAgo();
  const { can } = useAuth();
  const [data, reload] = useList<{ rules: AlertRule[]; alerts: Alert[]; smtp: boolean }>(r.site ? `/api/v1/alerts?site=${encodeURIComponent(r.site)}` : null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState({ text: "", error: false });
  if (data === null) return <Failed />;
  if (!data) return <Loading />;
  const rule = (a: AlertRule) => t(a.kind === "drop" ? "sharing.ruleDrop" : "sharing.ruleSpike", { share: f.pct(a.ratio, 0), times: f.num(a.ratio) });
  const to = (a: AlertRule) =>
    [a.recipients.join(", "), a.webhook ? t("sharing.webhookTo", { host: URL.parse(a.webhook)?.host ?? a.webhook }) : ""].filter(Boolean).join("; ");
  const toggle = (a: AlertRule, enabled: boolean) =>
    r
      .call(`/api/v1/alerts/${encodeURIComponent(a.id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) })
      .then(reload, (err: Error) => setStatus({ text: err.message, error: true }));
  const remove = (a: AlertRule) =>
    r.call(`/api/v1/alerts/${encodeURIComponent(a.id)}`, { method: "DELETE" }).then(reload, (err: Error) => setStatus({ text: err.message, error: true }));
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Status {...status} />
        {can("editor") && (
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
            {t("sharing.newRule")}
          </Button>
        )}
      </div>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title={t("sharing.rules")} description={t("sharing.rulesDetail")}>
          {data.rules.length ? (
            <ul className="m-0 flex list-none flex-col p-0">
              {data.rules.map((a) => (
                <li key={a.id} className="flex items-start gap-2 border-b border-subtle py-2 last:border-0">
                  <span className="min-w-0 flex-1">
                    {can("editor") ? (
                      <Switch
                        checked={a.enabled}
                        onCheckedChange={(on) => void toggle(a, on)}
                        label={a.name}
                        description={`${rule(a)}. ${t("sharing.to")}: ${to(a)}.`}
                      />
                    ) : (
                      <span className="flex flex-col text-xs">
                        <span className="font-semibold text-fg">{a.name}</span>
                        <span className="text-fg-muted">{`${rule(a)}. ${t("sharing.to")}: ${to(a)}.`}</span>
                      </span>
                    )}
                  </span>
                  {a.open && <StatusBadge tone="warning">{t("sharing.firing")}</StatusBadge>}
                  {can("editor") && (
                    <IconButton size="sm" label={t("sharing.deleteRule", { name: a.name })} onClick={() => void remove(a)}>
                      <Trash2 aria-hidden />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t("sharing.noRules")}</p>
          )}
        </Panel>
        <Panel title={t("sharing.recent")} className="self-start">
          {data.alerts.length ? (
            <ol aria-label={t("sharing.recent")} className="m-0 flex list-none flex-col p-0">
              {data.alerts.map((h) => (
                <li key={h.id} className="flex flex-col gap-0.5 border-b border-subtle py-2 text-xs last:border-0">
                  <span className="flex items-center gap-2">
                    <span className="font-semibold text-fg">{h.name ?? t("sharing.ruleGone")}</span>
                    <span className="text-fg-muted">{time(h.hour)}</span>
                    <StatusBadge tone={h.endedAt ? "neutral" : "warning"} className="ml-auto">
                      {h.endedAt ? t("sharing.ended", { ago: ago(h.endedAt) }) : t("sharing.firing")}
                    </StatusBadge>
                  </span>
                  <span className="text-fg">{t("sharing.alertText", { visits: f.num(h.visits), usual: f.num(h.usual) })}</span>
                  {h.sent && <span className="text-2xs text-fg-muted">{t("sharing.sentBy", { how: h.sent })}</span>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t("sharing.noAlerts")}</p>
          )}
        </Panel>
      </div>
      <Note>{t("sharing.alertsNote")}</Note>
      {open && (
        <AlertDialog
          smtp={data.smtp}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            reload();
          }}
        />
      )}
    </>
  );
}

function AlertDialog({ smtp, onClose, onCreated }: { smtp: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const r = useReport();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"drop" | "spike">("drop");
  const [ratio, setRatio] = useState("0.5");
  const [to, setTo] = useState("");
  const [webhook, setWebhook] = useState("");
  const [error, setError] = useState("");
  const ok = name.trim() && (recipientList(to).length || webhook.trim());
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("sharing.newRule")}
      description={t("sharing.newRuleDetail")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        void r
          .call("/api/v1/alerts", {
            method: "POST",
            body: JSON.stringify({
              site: r.site,
              name: name.trim(),
              kind,
              ratio: Number(ratio),
              recipients: recipientList(to),
              webhook: webhook.trim() || null,
            }),
          })
          .then(onCreated, (err: Error) => setError(err.message));
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ok}>
            {t("sharing.createRule")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label={t("sharing.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("sharing.rulePlaceholder")} />
        <SegmentedControl
          label={t("sharing.kind")}
          value={kind}
          onChange={(k) => (setKind(k), setRatio(k === "drop" ? "0.5" : "2"))}
          options={[
            { value: "drop", label: t("sharing.drop") },
            { value: "spike", label: t("sharing.spike") },
          ]}
        />
        <SelectField
          label={kind === "drop" ? t("sharing.dropBelow") : t("sharing.spikeAbove")}
          value={ratio}
          onChange={(e) => setRatio(e.target.value)}
          options={(kind === "drop" ? ["0.25", "0.5", "0.75"] : ["1.5", "2", "3", "5"]).map((x) => ({
            value: x,
            label: kind === "drop" ? t("sharing.ofUsual", { share: `${Number(x) * 100}%` }) : t("sharing.timesUsual", { times: x }),
          }))}
        />
        <TextField
          label={t("sharing.recipients")}
          hint={smtp ? t("sharing.recipientsHint") : t("sharing.noSmtp")}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="ops@example.com"
          disabled={!smtp}
        />
        <TextField
          label={t("sharing.webhook")}
          hint={t("sharing.webhookHint")}
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          placeholder="https://hooks.example.com/analytics"
        />
        {error && (
          <p role="alert" className="m-0 text-xs text-danger-text">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------ shared dashboard */

interface SharedMeta {
  name: string;
  site: string;
  sections: Section[];
  password: boolean;
  unlocked: boolean;
  currency: string | null;
  expiresAt: string | null;
}

type Row = Record<string, any>;

/** What a shared link opens, for people without an account: the link's sections of one site, read-only. */
export function SharedDashboard({ token }: { token: string }) {
  const t = useT();
  const [access, setAccess] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(`analytics.share.${token}`);
    } catch {
      return null;
    }
  });
  const [meta, setMeta] = useState<SharedMeta | null>();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [days, setDays] = useState<Range>(30);
  const [compare, setCompare] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [data, setData] = useState<Row | null>();
  const headers = useCallback((): Record<string, string> => (access ? { "x-share-access": access } : {}), [access]);
  useEffect(() => {
    void fetch(`/api/v1/shared/${encodeURIComponent(token)}`, { headers: headers() }).then(
      async (r) => (r.ok ? setMeta((await r.json()) as SharedMeta) : setMeta(null)),
      () => setMeta(null),
    );
  }, [token, headers]);
  const shown = meta?.sections.includes(section) ? section : meta?.sections[0];
  useEffect(() => {
    if (!meta?.unlocked || !shown) return;
    setData(undefined);
    const q = new URLSearchParams({ section: shown, days: String(days), ...(compare && { compare: "previous" }) });
    void fetch(`/api/v1/shared/${encodeURIComponent(token)}/report?${q}`, { headers: headers() }).then(
      async (r) => setData(r.ok ? (((await r.json()) as { data: Row }).data ?? null) : null),
      () => setData(null),
    );
  }, [meta, shown, days, compare, token, headers]);
  const frame = (children: ReactNode) => <main className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6">{children}</main>;
  if (meta === undefined) return frame(<Loading />);
  if (meta === null) return frame(<EmptyState title={t("shared.gone")}>{t("shared.goneDetail")}</EmptyState>);
  if (!meta.unlocked)
    return frame(
      <Panel title={meta.name} description={t("shared.needsPassword")} className="mx-auto w-full max-w-md">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void fetch(`/api/v1/shared/${encodeURIComponent(token)}/unlock`, {
              method: "POST",
              body: JSON.stringify({ password }),
              headers: { "content-type": "application/json" },
            }).then(async (r) => {
              const body = (await r.json().catch(() => ({}))) as { access?: string; detail?: string };
              if (!r.ok || !body.access) return setError(r.status === 429 ? t("shared.tooMany") : t("shared.wrongPassword"));
              try {
                sessionStorage.setItem(`analytics.share.${token}`, body.access);
              } catch {
                // kept for this page only
              }
              setAccess(body.access);
            });
          }}
        >
          <TextField
            label={t("sharing.password")}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && (
            <p role="alert" className="m-0 text-xs text-danger-text">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={!password}>
            {t("shared.open")}
          </Button>
        </form>
      </Panel>,
    );
  return frame(
    <>
      <PageHeader title={meta.name} description={t("shared.description", { site: meta.site })}>
        <div className="flex flex-wrap items-center gap-2">
          <TimeRangePicker
            size="md"
            value={String(days)}
            onChange={(v) => setDays(Number(v) as Range)}
            ranges={([1, 7, 30, 90] as const).map((d) => ({ value: String(d), label: d === 1 ? t("choice.today") : t("choice.lastDays", { count: d }) }))}
          />
          <Switch checked={compare} onCheckedChange={setCompare} label={t("choice.previous")} />
        </div>
        {meta.sections.length > 1 && shown && (
          <Tabs label={meta.name} value={shown} onChange={setSection} items={meta.sections.map((s) => ({ value: s, label: t(`sharing.section_${s}`) }))} />
        )}
      </PageHeader>
      {data === undefined && <Loading />}
      {data === null && <Failed />}
      {data && shown && <SharedSection section={shown} data={data} currency={meta.currency} />}
      <Note>{t("shared.note")}</Note>
    </>,
  );
}

function SharedSection({ section, data, currency }: { section: Section; data: Row; currency: string | null }) {
  const t = useT();
  const f = useFormat();
  const c = data.compare as Row | undefined;
  const change = (now: number, then: number | undefined) =>
    then === undefined || !then
      ? undefined
      : {
          label: `${now >= then ? "+" : "−"}${f.num(Math.abs(Math.round(((now - then) / then) * 1000) / 10))}%`,
          direction: now > then ? ("up" as const) : now < then ? ("down" as const) : ("flat" as const),
          intent: "neutral" as const,
        };
  const list = (title: string, rows: Row[], label: (r: Row) => ReactNode, value: (r: Row) => number) => (
    <Panel title={title}>
      {rows.length ? (
        <BarList label={title} items={rows.slice(0, 8).map((r, i) => ({ id: String(i), label: label(r), value: value(r) }))} />
      ) : (
        <p className="m-0 text-sm text-fg-muted">{t("report.noneInPeriod")}</p>
      )}
    </Panel>
  );
  if (section === "overview" || section === "acquisition" || section === "conversions") {
    const tot = data.totals as Row;
    return (
      <>
        <KpiGrid>
          <KpiCard label={t("overview.visitors")} value={f.num(tot.visitors)} delta={change(tot.visitors, c?.totals?.visitors)} />
          <KpiCard label={t("overview.visits")} value={f.num(tot.visits)} delta={change(tot.visits, c?.totals?.visits)} />
          <KpiCard label={t("overview.pageviews")} value={f.num(tot.pageviews)} delta={change(tot.pageviews, c?.totals?.pageviews)} />
          <KpiCard label={t("overview.bounceRate")} value={f.pct(tot.bounceRate)} />
        </KpiGrid>
        {section === "overview" && (
          <Panel title={t("overview.visitorsDaily")}>
            <TimeSeriesChart
              label={t("overview.visitorsDaily")}
              series={[{ id: "v", name: t("overview.visitors"), data: (data.series as Row[]).map((d) => d.visitors) }]}
              labels={(data.series as Row[]).map((d) => shortDay(d.day))}
              height={200}
              xTicks={6}
            />
          </Panel>
        )}
        <div className="grid gap-2.5 lg:grid-cols-3">
          {section !== "conversions" &&
            list(
              t("overview.channels"),
              data.channels,
              (r) => f.channel(r.channel),
              (r) => r.visits,
            )}
          {section === "overview" &&
            list(
              t("overview.topPages"),
              data.pages,
              (r) => <span className="font-mono text-xs">{r.path}</span>,
              (r) => r.views,
            )}
          {section === "overview" &&
            list(
              t("overview.countries"),
              data.countries ?? [],
              (r) => (
                <>
                  <Flag code={r.country} /> {f.country(r.country)}
                </>
              ),
              (r) => r.visitors,
            )}
          {section === "acquisition" &&
            list(
              t("acquisition.sources"),
              data.sources,
              (r) => f.source(r.source),
              (r) => r.visits,
            )}
          {section === "acquisition" &&
            list(
              t("acquisition.campaigns"),
              data.campaigns,
              (r) => r.campaign ?? r.source ?? "–",
              (r) => r.visits,
            )}
          {section !== "acquisition" &&
            list(
              t("conversions.goals"),
              data.goals,
              (r) => (r.value !== null ? `${r.name} · ${f.money(r.value, currency)}` : r.name),
              (r) => r.visits,
            )}
        </div>
      </>
    );
  }
  if (section === "ecommerce") {
    const tot = data.totals as Row;
    return (
      <>
        <KpiGrid>
          <KpiCard label={t("ecommerce.revenue")} value={f.money(tot.revenue, currency)} delta={change(tot.revenue, c?.totals?.revenue)} />
          <KpiCard label={t("ecommerce.orders")} value={f.num(tot.orders)} delta={change(tot.orders, c?.totals?.orders)} />
          <KpiCard label={t("ecommerce.averageOrder")} value={f.money(tot.averageOrder, currency)} />
          <KpiCard label={t("ecommerce.conversion")} value={f.pct(tot.conversionRate, 2)} />
        </KpiGrid>
        <Panel title={t("ecommerce.revenueDaily")}>
          <TimeSeriesChart
            label={t("ecommerce.revenueDaily")}
            series={[{ id: "r", name: t("ecommerce.revenue"), data: (data.series as Row[]).map((d) => d.revenue) }]}
            labels={(data.series as Row[]).map((d) => shortDay(d.day))}
            height={200}
            xTicks={6}
            format={(v) => f.money(v, currency, true)}
          />
        </Panel>
        <div className="grid gap-2.5 lg:grid-cols-2">
          {list(
            t("ecommerce.products"),
            data.products,
            (r) => r.name ?? r.sku,
            (r) => r.revenue,
          )}
          {list(
            t("ecommerce.revenueBy_source"),
            (data.sources as Row[]).filter((x) => x.orders),
            (r) => f.source(r.source),
            (r) => r.revenue,
          )}
        </div>
      </>
    );
  }
  if (section === "search") {
    const tot = data.totals as Row;
    return (
      <>
        <KpiGrid>
          <KpiCard label={t("searchConsole.clicks")} value={f.num(tot.clicks)} delta={change(tot.clicks, c?.totals?.clicks)} />
          <KpiCard label={t("searchConsole.impressions")} value={f.num(tot.impressions)} />
          <KpiCard label="CTR" value={f.pct(tot.ctr)} />
          <KpiCard label={t("searchConsole.averagePosition")} value={tot.position === null ? "–" : f.num(tot.position)} />
        </KpiGrid>
        {list(
          t("searchConsole.queries"),
          data.queries,
          (r) => r.query,
          (r) => r.clicks,
        )}
      </>
    );
  }
  const tot = data.totals as Row;
  const vital = (k: "lcp" | "inp" | "cls", v: number | null) =>
    v === null ? "–" : k === "lcp" ? `${f.num(Math.round(v / 100) / 10)} s` : k === "inp" ? `${f.num(v)} ms` : f.num(v);
  return (
    <KpiGrid>
      {(["lcp", "inp", "cls"] as const).map((k) => (
        <KpiCard key={k} label={`${t(`vitals.${k}`)} · ${t(`vitals.${k}Full`)}`} value={vital(k, tot[k].p75)} unit="p75" />
      ))}
    </KpiGrid>
  );
}
