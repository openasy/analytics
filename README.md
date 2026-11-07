# analytics

[![CI](https://github.com/openasy/analytics/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/analytics/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Analytics product: how people use your websites, from one script tag. Visits
with where they came from, the pages they read and for how long, what they clicked, your own events and goals, kept in
your install and nowhere else. Sites are set in a file, not in the UI.

```
analytics.yaml ──▶ analytics ──▶ /s/shop.js ──▶ <script> on every page of the site
                       ▲                              │
                       └──── POST /api/v1/collect ◀───┘  page views, time and scroll, clicks, your events
```

## Add a site

List it in the sites file, `/config/analytics.yaml` (`ANALYTICS_CONFIG`):

```yaml
sites:
  - name: shop
    domains: [https://www.example.com, https://example.com]
    goals:
      - { name: Bought, path: /checkout/done }
      - { name: Signed up, event: signup }
    funnels:
      - name: Trial
        steps:
          - { name: Pricing, path: /pricing }
          - { name: Sign-up form, path: /signup }
          - { name: Signed up, event: signup }
    forms: true
    replays: { sample: 10%, keep: 30d }
```

Then add its script to the head of every page:

```html
<script defer src="https://analytics.example.com/s/shop.js"></script>
```

That is all. Visits show on the overview within seconds.

### The sites file

The file is the only way in: no screen and no API route adds, changes or removes a site, so the list can live in git
and be reviewed like code. It is read at start and again within a minute of a change, and applied whole or not at all.
A file with a mistake leaves the last good version in place, and the log and the Sites page say which site and field to
fix. Mount the folder rather than the file, so a save that replaces the file still reaches the container.

| Field | | |
| --- | --- | --- |
| `name` | required | Lowercase letters, digits and `-`. The script is `/s/<name>.js` |
| `domains` | required | The origins the script may send from, such as `https://www.example.com`; `http://` only for localhost |
| `consent` | `none` | `required`: nothing is sent or stored until the page calls `openasy.consent(true)` |
| `goals` | | A `name` with a `path` (`*` matches anything, such as `/blog/*`) or an `event` |
| `query` | | Query parameters kept besides `utm_*`; every other one is dropped |
| `ignore` | | Path patterns that are not recorded, such as `/admin/*` |
| `keep` | `{ events: 90d, days: 730d }` | How long visits and events, and the daily totals, are kept |
| `rateLimit` | `ANALYTICS_RATE_LIMIT` | Events a minute the site may send |
| `serverKey` | | The name of the environment variable that holds the key for events from the site's servers. Never the key itself |
| `funnels` | | Up to 20, each a `name` and 2 to 10 `steps`; a step is a `path` or an `event`, with an optional `name` |
| `forms` | `false` | `true`: the script reports which form fields are entered and left, by name and kind, never what they hold |
| `replays` | off | `true`, or `{ sample, keep }`: record this share of visits (`10%`) and keep each replay this long (`30d`, up to `365d`) |

Removing a site stops it from sending; what it sent stays until the default retention removes it.

## On the page

```js
openasy.track("signup", { plan: "pro" }); // one of your own events, up to 20 short properties
openasy.identify("u-42"); // your own id for the person; an email address or phone number is refused
openasy.consent(true); // on a site with consent: required
openasy.consent(false); // stops, and deletes what was kept about this visitor
openasy.ids(); // { visitor, session }, to send events of the same visit from your servers
```

`data-analytics="Start trial"` names a click; `data-analytics-mask` keeps an element's text out of what is sent, and out
of replays; `data-analytics-block` leaves an element out of replays whole. Calls
made before the script loads are kept with `window.openasy = window.openasy || { q: [] }` and
`openasy.q.push(["track", "signup"])`.

From a site's servers, send the key its `serverKey` names:

```bash
curl -sf -X POST https://analytics.example.com/api/v1/collect -H "x-analytics-key: $ANALYTICS_SHOP_KEY" -d '{
  "site": "shop", "visitor": "<from openasy.ids()>", "session": "<from openasy.ids()>",
  "events": [{"type": "event", "url": "https://www.example.com/checkout", "name": "paid", "props": {"total": 120}}]
}'
```

## What is recorded

- **Visits.** A visitor id in the site's `localStorage` and a visit id in `sessionStorage`, both random and made per
  site; a visit ends after 30 minutes without activity. A visit keeps where it came from (the referring site and the
  `utm_*` parameters), its entry and exit pages, its browser, system and kind of device, and everything it sent, in
  order.
- **Pages.** Each page view, then the time spent on it and how far down it was read. Single-page apps count each move
  of the address as a page view.
- **Clicks** on links, buttons and elements marked `data-analytics`: a short selector, the first 80 characters of
  what the element says, and the link it follows.
- **Your events and goals**, and the share of visits that reached each goal.
- **Funnels.** For each funnel of the file, how many visits reached each step having taken the steps before it in
  order, the median time between steps, and how each source converts.
- **Forms**, on sites with `forms: true`: which forms are started and sent, and for each field how many reached it, left
  the form there, the time in it and how often it was filled again. A field named like a password or a card number is
  kept by its kind only.
- **Heatmaps.** Where in each clicked element a click landed, and how far each page was read. Analytics opens the page
  in a frame and the site's script draws the clicks on it, so the heatmap follows the page as it is today. The page
  must let Analytics frame it (`frame-ancestors` in its Content-Security-Policy); while it is framed, it records
  nothing.
- **Replays**, on sites with `replays`: the share of visits the file names is recorded with
  [rrweb](https://github.com/rrweb-io/rrweb), loaded only for those visits. Every form field is masked in the browser;
  emails, tokens and keys in the page's text are masked again before a replay is kept, gzipped, for its own `keep`.
  Three clicks on the same element within a second count as a rage click on the visit.

## What is not kept

- The value of any form field. The script never reads one, a batch that holds a field it does not know is refused, and
  replays mask every field in the browser.
- Query strings, but for `utm_*` and the parameters a site lists. Emails, tokens and keys in addresses, titles, texts
  and properties are masked before anything is stored.
- The IP address and the user agent. Only the browser, system and kind of device are kept.
- Names, emails and phone numbers. A user id that looks like one is refused.

Pages driven by automation send nothing, and batches from crawlers are dropped. The script is public, so anyone can
still send made-up events from a page that copies it; the origin check and the rate limit keep that small, not
impossible.

## Consent

`consent: none`, the default, measures from the first page. Whether a site needs its visitors to agree first is a legal
question for the site's owner: under the KVKK cookie guide, GDPR and the ePrivacy Directive it usually turns on storing
an id in the browser and following a visitor across pages, not on where the data is kept. With `consent: required`,
nothing is sent and nothing is stored in the browser until the site's own banner calls `openasy.consent(true)`.

A visitor's data can be exported and deleted by an admin from the visit's page, or with
`GET` and `DELETE /api/v1/visitors/{id}?site=`, for requests under GDPR Art. 15 and 17 and KVKK Art. 11. The export
holds the visitor's replays, and deleting removes them. `openasy.consent(false)` stops a replay being recorded.

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/analytics.yaml   # your sites
docker compose up -d
docker compose logs analytics | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI, the API
and the sites' script are on http://localhost:8080. Sites on `https://` can only load the script from `https://`, so put
Analytics behind TLS. `openasy-kek` encrypts sign-in secrets in the database (ADR 0021): keep it apart from the volume
and with your backups.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `ANALYTICS_PUBLIC_URL` | `http://localhost:8080` | The address people open and the sites' pages send to, with `https://` behind your TLS proxy |
| `ANALYTICS_CONFIG` | `/config/analytics.yaml` | The sites file |
| `ANALYTICS_RATE_LIMIT` | `6000` | Events a minute a site may send, unless the file gives it its own. Over it: 429 with `Retry-After` |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `ANALYTICS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `ANALYTICS_DB` | `/data/analytics.db` | SQLite file (WAL), on the `/data` volume |
| `ANALYTICS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `ANALYTICS_HEADLESS` | `false` | `true` serves only the API and the script |
| `ANALYTICS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)). Owners can also add identity providers under Settings, Sign-in |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. The rate
limit counts in memory: a restart gives every site a fresh minute. Batches are not written to the request log, so the
sites' traffic stays out of the logs.

## Roles

Viewers see every report and visit; admins also export and delete a visitor's data, and manage members and API tokens
(ADR 0003). Editors see what viewers see. Pages need no key: a batch is taken only from one of its site's domains.

## Coming next

Core Web Vitals, and JavaScript errors sent on to Errors.

## Develop

```bash
npm install
npm test        # the sites file, batches, reports, the script in jsdom, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
