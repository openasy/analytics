// Email reports and alerts go out through the install's own mail server, named under smtp: in the sites file, with its
// password in ANALYTICS_SMTP_PASSWORD. A small SMTP conversation with no dependencies: plain, STARTTLS or implicit
// TLS, with AUTH PLAIN or LOGIN. Tests send to a catcher they start, so no mail leaves the machine.
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Smtp } from "./config.ts";

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{ filename: string; contentType: string; content: string | Buffer }>;
  headers?: Record<string, string>;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

interface Reply {
  code: number;
  text: string;
}

class Conn {
  private buffer = "";
  private parts: string[] = [];
  private waiters: Array<(r: Reply) => void> = [];
  private pending: Reply[] = [];
  private error: Error | null = null;
  readonly raw: Socket | TLSSocket;

  constructor(socket: Socket | TLSSocket) {
    this.raw = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err: Error) => this.fail(err));
    socket.on("timeout", () => (this.fail(new Error("the SMTP server did not answer in time")), socket.destroy()));
    socket.on("close", () => this.fail(new Error("the SMTP connection closed")));
  }

  private fail(err: Error) {
    this.error ??= err;
    for (const w of this.waiters.splice(0)) w({ code: 0, text: err.message });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) continue;
      this.parts.push(m[3]!);
      if (m[2] === " ") {
        const reply = { code: Number(m[1]), text: this.parts.join(" ") };
        this.parts = [];
        const w = this.waiters.shift();
        if (w) w(reply);
        else this.pending.push(reply);
      }
    }
  }

  read(): Promise<Reply> {
    const ready = this.pending.shift();
    if (ready) return Promise.resolve(ready);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async cmd(line: string, expect: number[], shown = line.split(" ")[0]): Promise<Reply> {
    this.raw.write(line + "\r\n");
    const reply = await this.read();
    if (!expect.includes(reply.code)) throw new Error(`SMTP ${shown} got ${reply.code}: ${reply.text}`);
    return reply;
  }
}

/** A header value with anything but plain ASCII as an RFC 2047 encoded word. */
export function encodeHeader(v: string): string {
  const clean = v.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?utf-8?B?${Buffer.from(clean).toString("base64")}?=`;
}

/** An address header, such as Analytics <a@example.com>, with the name encoded when it needs to be. */
function addressHeader(v: string): string {
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(v.trim());
  return m && m[1] ? `${encodeHeader(m[1].replace(/^"|"$/g, ""))} <${m[2]}>` : v.trim();
}

const base64Lines = (v: string | Buffer) =>
  Buffer.from(v)
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();

/** The RFC 5322 message: the text and HTML as alternatives, and the attachments, all in base64 so no line is too long. */
export function buildMessage(mail: Mail, now = new Date()): string {
  const id = randomBytes(9).toString("hex");
  const alt = `oa-alt-${id}`;
  const mixed = `oa-mix-${id}`;
  const domain = /@([^>\s]+)/.exec(mail.from)?.[1] ?? "analytics.local";
  const headers = [
    `From: ${addressHeader(mail.from)}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    "MIME-Version: 1.0",
    ...Object.entries(mail.headers ?? {}).map(([k, v]) => `${k}: ${v.replace(/[\r\n]+/g, " ")}`),
  ];
  const alternative = [
    `--${alt}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.text),
    `--${alt}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.html),
    `--${alt}--`,
  ].join("\r\n");
  if (!mail.attachments?.length) return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`].join("\r\n") + "\r\n\r\n" + alternative + "\r\n";
  const parts = mail.attachments.map((a) =>
    [
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${a.filename.replace(/["\r\n]/g, "")}"`,
      `Content-Disposition: attachment; filename="${a.filename.replace(/["\r\n]/g, "")}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(a.content),
    ].join("\r\n"),
  );
  return (
    [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`].join("\r\n") +
    "\r\n\r\n" +
    [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "", alternative, ...parts, `--${mixed}--`, ""].join("\r\n")
  );
}

export interface MailerOptions {
  password?: string;
  /** For a test server with a self-signed certificate; never set in production. */
  insecureTls?: boolean;
  timeoutMs?: number;
}

/** A mailer for the file's smtp: server. Each send opens its own connection, so one stuck send does not hold the others. */
export function createMailer(smtp: Smtp, { password, insecureTls, timeoutMs = 20_000 }: MailerOptions = {}): Mailer {
  const name = "analytics.openasy.local";
  async function open(): Promise<Socket | TLSSocket> {
    const socket =
      smtp.security === "tls"
        ? tlsConnect({ host: smtp.host, port: smtp.port, servername: smtp.host, rejectUnauthorized: !insecureTls })
        : createConnection({ host: smtp.host, port: smtp.port });
    socket.setTimeout(timeoutMs);
    await once(socket, smtp.security === "tls" ? "secureConnect" : "connect");
    return socket;
  }
  const ehlo = async (conn: Conn) => {
    try {
      return (await conn.cmd(`EHLO ${name}`, [250])).text;
    } catch {
      await conn.cmd(`HELO ${name}`, [250]);
      return "";
    }
  };
  return {
    async send(mail) {
      let conn = new Conn(await open());
      try {
        const greeting = await conn.read();
        if (greeting.code !== 220) throw new Error(`SMTP greeting was ${greeting.code}: ${greeting.text}`);
        let caps = await ehlo(conn);
        if (smtp.security === "starttls") {
          await conn.cmd("STARTTLS", [220]);
          const secure = tlsConnect({ socket: conn.raw, servername: smtp.host, rejectUnauthorized: !insecureTls });
          await once(secure, "secureConnect");
          secure.setTimeout(timeoutMs);
          conn = new Conn(secure);
          caps = await ehlo(conn);
        }
        if (smtp.user && password) {
          if (/AUTH[ =][^\r\n]*PLAIN/i.test(caps)) await conn.cmd(`AUTH PLAIN ${Buffer.from(`\0${smtp.user}\0${password}`).toString("base64")}`, [235], "AUTH");
          else {
            await conn.cmd("AUTH LOGIN", [334]);
            await conn.cmd(Buffer.from(smtp.user).toString("base64"), [334], "AUTH");
            await conn.cmd(Buffer.from(password).toString("base64"), [235], "AUTH");
          }
        }
        const envelope = /<([^<>]+)>/.exec(mail.from)?.[1] ?? mail.from;
        await conn.cmd(`MAIL FROM:<${envelope}>`, [250]);
        await conn.cmd(`RCPT TO:<${mail.to}>`, [250, 251]);
        await conn.cmd("DATA", [354]);
        // A line that starts with a dot gets another, so the message cannot end the DATA early.
        const reply = await conn.cmd(buildMessage(mail).replace(/^\./gm, "..") + "\r\n.", [250], "DATA");
        void reply;
        await conn.cmd("QUIT", [221]).catch(() => {});
      } finally {
        conn.raw.destroy();
      }
    },
  };
}
