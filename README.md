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
    currency: TRY
    ecommerce: true
    goals:
      - { name: Bought, event: purchase, value: value }
      - { name: Signed up, event: signup, value: 150 }
    funnels:
      - name: Trial
        steps:
          - { name: Pricing, path: /pricing }
          - { name: Sign-up form, path: /signup }
          - { name: Signed up, event: signup }
    forms: true
    replays: { sample: 10%, keep: 30d }
    search: { path: /search, param: q }
    notFound: { title: Page not found }
    vitals: true
    searchConsole:
      google: sc-domain:example.com
      bing: https://www.example.com/
      yandex: https:www.example.com:443
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
| `goals` | | A `name` with a `path` (`*` matches anything, such as `/blog/*`), an `event`, or a `download` (a file's path or address, such as `/files/guide.pdf` or `*.pdf`), and an optional `value`: an amount each conversion is worth (`150`), or, for an event, the name of its property that holds it (`value` is an ecommerce event's own value) |
| `query` | | Query parameters kept besides `utm_*`; every other one is dropped |
| `ignore` | | Path patterns that are not recorded, such as `/admin/*` |
| `keep` | `{ events: 90d, days: 730d }` | How long visits and events, and the daily totals, are kept |
| `rateLimit` | `ANALYTICS_RATE_LIMIT` | Events a minute the site may send |
| `serverKey` | | The name of the environment variable that holds the key for events from the site's servers. Never the key itself |
| `funnels` | | Up to 20, each a `name` and 2 to 10 `steps`; a step is a `path` or an `event`, with an optional `name` |
| `forms` | `false` | `true`: the script reports which form fields are entered and left, by name and kind, never what they hold |
| `replays` | off | `true`, or `{ sample, keep }`: record this share of visits (`10%`) and keep each replay this long (`30d`, up to `365d`) |
| `search` | off | The site's own search: `{ path: /search, param: q }`, or just the parameter (`q`) or a list (`[q, s]`) for any page. The term is kept, masked and in lower case, even though the parameter is dropped from the address |
| `notFound` | | `{ title: Page not found }`: a page with this title counts as not found. A page can also say so itself (see below) |
| `channels` | | The site's own sources put in a channel before the built-in rules, such as `email: [partner-newsletter]`: a referring host (and its subdomains) or a `utm_source` |
| `vitals` | `false` | `true`: the script measures each page's Core Web Vitals (LCP, INP, CLS) |
| `downloads` | GA4's list | File endings a click on a link counts as a download for, such as `[pdf, zip]`; `false` for none |
| `location` | `city` | How precisely a visit's place is worked out from its IP address: `city`, `region`, `country` or `off` |
| `currency` | | The site's money as an ISO 4217 code, such as `TRY`: orders and goal values are in it. Required with `ecommerce` |
| `ecommerce` | `false` | `true`: the site's `openasy.ecommerce()` calls are kept (see below); on other sites they are dropped |
| `searchConsole` | | The site in each search engine's tools: `google` (a Search Console property, `sc-domain:example.com` or `https://www.example.com/`), `bing` (its address in Bing Webmaster Tools) and `yandex` (its host id in Yandex Webmaster, `https:www.example.com:443`). The keys are in the environment, never in the file |

Besides `sites:`, the file can hold three settings for the whole install:

```yaml
trustedProxies: [10.0.0.0/8]   # X-Forwarded-For is believed only from these, as is ANALYTICS_TRUSTED_PROXIES
geoip:
  database: /data/geoip/dbip-city-lite.mmdb
  update: monthly              # monthly: DB-IP Lite city is downloaded into the file; never: the file is used as it is
# geoip: off                   # no places at all
smtp:                          # the mail server email reports and alerts go through; its password is ANALYTICS_SMTP_PASSWORD
  host: mail.example.com
  port: 587                    # 587 for starttls, 465 for tls
  security: starttls           # starttls, tls or none
  user: analytics@example.com
  from: "Analytics <analytics@example.com>"
  timeZone: Europe/Istanbul    # the time zone email reports are scheduled in; UTC when not given
```

Removing a site stops it from sending; what it sent stays until the default retention removes it.

## On the page

```js
openasy.track("signup", { plan: "pro" }); // one of your own events, up to 20 short properties
openasy.identify("u-42"); // your own id for the person; an email address or phone number is refused
openasy.consent(true); // on a site with consent: required
openasy.consent(false); // stops, and deletes what was kept about this visitor
openasy.ids(); // { visitor, session }, to send events of the same visit from your servers
openasy.notFound(); // this page is a "not found" page, for single-page apps
openasy.noResults(); // this search page found nothing
openasy.ecommerce("view_item", { items: [{ sku: "ESP-1000", name: "Espresso beans 1 kg", category: "Coffee", price: 920 }] });
openasy.ecommerce("add_to_cart", { items: [{ sku: "ESP-1000", price: 920, quantity: 2 }] });
openasy.ecommerce("begin_checkout", { value: 1840, currency: "TRY", items: [{ sku: "ESP-1000", price: 920, quantity: 2 }] });
openasy.ecommerce("purchase", { order: "A-1001", value: 1840, currency: "TRY", items: [{ sku: "ESP-1000", price: 920, quantity: 2 }] });
openasy.ecommerce("refund", { order: "A-1001", value: 920 }); // without a value, the whole order
```

The ecommerce calls work on a site with `ecommerce: true`, by GA4's event names. A product takes a `sku` and
optionally a `name`, `category`, `price` and `quantity` (1 when left out), and nothing else; without a `value`, an order
is worth its products' prices times their quantities. An order id is kept once, so the thank-you page loaded again
counts no second order; an event in another currency than the site's is dropped. A refund names its order: from a page
only the visitor who bought may send it, from the site's servers any order, and it starts no visit. Send `purchase` and
`refund` from the shop's servers too (as below, with `"name": "purchase", "order": ..., "items": [...]`), and ad
blockers miss no order.

A search page that found nothing can carry `<meta name="analytics" content="no-results">` instead of calling
`openasy.noResults()`. A page not found can also carry `<meta name="analytics" content="404">` in its head, or have the title the site's
`notFound` names. The meta tag and the title are read with the page view, so the page that linked to it is kept too;
`openasy.notFound()` called after the page view was sent marks the page with its leave, without that link.

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
  site; a visit ends after 30 minutes without activity. A visit keeps where it came from (the referring site, the
  referring page's address without its query string, and the five `utm_*` parameters), its channel, its entry and exit
  pages, its browser and system with their versions, its kind of device, the browser's language, time zone and screen
  size, its country, region and city, whether the visitor came before, and everything it sent, in order.
- **Places.** Country, region and city are looked up in a local copy of the DB-IP Lite city database when a visit
  starts, to the site's `location` precision, and only the names are kept. Analytics downloads the database into the
  data volume on first start and again each month (`geoip:` in the file, or `ANALYTICS_GEOIP`, can point at a file of
  your own, such as GeoLite2 City, or turn it off). Behind a proxy, list it in `trustedProxies` or
  `ANALYTICS_TRUSTED_PROXIES`: `X-Forwarded-For` is read only from those, and without them every visit has the
  proxy's place. Events sent from a site's servers have no place.
- **Channels.** Each visit is put in one channel when it starts, by the first rule that matches: the site's own
  `channels`, then AI assistants (chatgpt.com, perplexity.ai, claude.ai, gemini.google.com, copilot.microsoft.com and
  others, by referrer or `utm_source`), email, affiliates, paid and organic search, paid and organic social, display,
  other paid traffic, referral, other (`utm_*` without a referrer) and direct. Paid is a `utm_medium` such as `cpc`,
  `ppc` or `paid*`, or an ad click id (`gclid`, `msclkid` and the like, which is not kept). The lists are in
  [server/channels.ts](server/channels.ts).
- **Engagement**, as GA4 counts it: a visit is engaged when it lasts longer than 10 seconds, views two pages or more,
  or reaches a goal. The bounce rate is the share of visits that were not engaged, and the engagement rate the rest.
  A visitor is new on their first visit that is still kept, and returning after it.
- **Pages.** Each page view, then the time spent on it and how far down it was read. Single-page apps count each move
  of the address as a page view.
- **Clicks** on links, buttons and elements marked `data-analytics`, middle clicks on links included: a short selector,
  the first 80 characters of what the element says, and the link it follows. A link to another site is a link out; a
  link to a file with one of the site's `downloads` endings is a download.
- **Rage and dead clicks.** Three clicks on the same element within a second are a rage click. A click on a button,
  or on anything that looks clickable, after which nothing on the page changed within a second (no change to the page,
  no scroll, no new address, no focus moved) is a dead click. Links and form fields are never dead clicks.
- **Site search** on sites with `search`: what was searched, masked and in lower case, whether the page found nothing,
  and what the visit did next: another page (a result clicked), another search, or nothing (left after).
- **Pages not found**, and the page or site that linked to each.
- **Core Web Vitals** on sites with `vitals: true`: each page's Largest Contentful Paint, Interaction to Next Paint and
  Cumulative Layout Shift, measured the way web.dev measures them and sent with the page's leave; reports give the 75th
  percentile by page and kind of device. LCP is measured for the page the browser loaded, CLS and INP for each page of
  a single-page app.
- **Annotations**: notes members add to a day of a site's timeline, such as a launch.
- **Saved segments**: filters a member saves under a name, for themselves or shared with the team, kept on the server.
- **Email reports**, **shared links** and **alerts**, set up under Sharing (see below).
- **Your events and goals**, the share of visits that reached each goal, and what the conversions were worth.
- **Ecommerce**, on sites with `ecommerce: true`: each product viewed, put in the cart, checked out, bought and
  refunded, with its SKU, name, category, price and quantity, and each order once by its id, with its value, its
  products and its refund. Reports give revenue, orders, the average order, refunds, the purchase funnel (visits that
  sent `view_item`, `add_to_cart`, `begin_checkout` and `purchase`, in order), each product's views, carts and sales,
  and revenue by the source, campaign and channel of the visit that bought (last touch).
- **Attribution.** For a goal, credit for each conversion in the period goes to the channel, source or campaign of the
  converting visitor's visits in the lookback before it (30 days unless asked): all to the first (first touch), all to
  the converting one (last touch), or shared evenly (linear). Only visits still kept count.
- **Paths**: where visits went on from the first view of a page, or how they reached it, up to five steps, each step
  with its six most visited pages; a reload of the same page is not a step.
- **Retention**, worked out from the visits that are kept: weekly cohorts of visitors first seen in a week (Monday to
  Sunday, UTC) and how many came back each week after; daily, weekly and monthly active visitors of each day; and each
  week's visitors as new, returning (seen in the four weeks before), resurrected (seen before, but not in those four
  weeks) or gone quiet (came the week before, not this one).
- **Search engines**, for sites with `searchConsole`: each day's queries (with the page, from Google) and pages, with
  their impressions, clicks, click-through rate and average position, from Google Search Console, Bing Webmaster Tools
  and Yandex Webmaster. They are imported daily: every day not imported yet, 30 days back the first time, and the last
  three days again, as the engines settle their numbers late. Bing gives its whole history in one answer, updated
  weekly; Yandex gives queries, not pages. Pages are shown beside the bounce rate of the visits that entered there.
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
- The IP address and the user agent. The address is used once, when a visit starts, to look up its place in the local
  database, and is never stored, logged or sent anywhere. From the user agent only the browser and system, their
  versions and the kind of device are kept.
- Ad click ids, and the query string and fragment of the page a visit came from.
- Names, emails and phone numbers. A user id that looks like one is refused, and so is a product whose SKU, name or
  category holds one, or an order id that looks like a phone number. A product has no field for who bought it.
- A shared link's token and password. Only the token's SHA-256 hash and the password's scrypt hash are kept, so a lost
  link cannot be shown again; make a new one.

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

## Sharing

- **Email reports** are sent through the file's `smtp:`: daily at 08:00 for the day before, weekly on Mondays at 09:00
  for the 7 days before, monthly on the 1st at 09:00 for the 30 days before, in its `timeZone`, with the chosen
  sections (overview, acquisition, conversions, ecommerce, search, performance) as an HTML email and their tables as
  CSV files, and a saved segment if one is chosen. Each recipient gets their own email with a link that takes them off
  the report (and `List-Unsubscribe`). A report missed while the install was down goes out when it is back. Editors
  create, send and delete them; the recipients come from the UI, the server from the file.
- **Shared links** open the chosen sections of one site for anyone with the link, without an account: public, or behind
  a password of 12 characters or more, until they expire or are revoked. They show totals and tables of pages, sources,
  goals, products, queries and vitals, never a visit, a replay, a heatmap, a visitor id or a user id; they filter only
  by channel, source, utm source, medium and campaign, country, device, browser, system, page and goal. A link opens at
  most 120 times a minute and takes 10 password tries a quarter of an hour; its password gives access for 12 hours.
- **Alerts** watch a site's visits in each whole hour (UTC) against the usual: the median of the same hour of the same
  weekday over the 8 weeks before (fewer while there is less history, at least 2). A **drop** is under the rule's share
  of the usual (0.5 unless given), when the usual is 10 visits or more; a **spike** is over its multiple (2 unless
  given), with 10 visits or more. An alert is sent once when it starts, by email to the rule's recipients and as a
  JSON `POST` to its webhook (`https://`, or `http://` for localhost), and marked ended at the first normal hour. The
  hours are checked every five minutes, each once.

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
| `ANALYTICS_TRUSTED_PROXIES` | | Addresses or ranges, such as `10.0.0.0/8`, whose `X-Forwarded-For` is believed; the file's `trustedProxies` add to them |
| `ANALYTICS_GEOIP` | | `off`, or the path of an `.mmdb` city database used as it is. The file's `geoip:` comes first. Unset: DB-IP Lite city, downloaded into `/data/geoip` monthly |
| `ANALYTICS_GEOIP_URL` | DB-IP | Where the monthly database is downloaded from, with `{month}` for `YYYY-MM`, for a mirror |
| `ANALYTICS_SMTP_PASSWORD` | | The password of the file's `smtp:` user |
| `ANALYTICS_GOOGLE_SERVICE_ACCOUNT` | | The path of a Google service account's JSON key, the account added as a user of each Search Console property |
| `ANALYTICS_GOOGLE_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN` | | Instead of a service account: an OAuth client and a refresh token with the `webmasters.readonly` scope |
| `ANALYTICS_BING_API_KEY` | | An API key from Bing Webmaster Tools (Settings, API access) |
| `ANALYTICS_YANDEX_TOKEN` | | A Yandex OAuth token with the `webmaster:hostinfo` permission |
| `ANALYTICS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)). Owners can also add identity providers under Settings, Sign-in |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. The rate
limit counts in memory: a restart gives every site a fresh minute. Batches are not written to the request log, so the
sites' traffic stays out of the logs.

## Roles

Viewers see every report and visit, and save segments of their own or for the team; editors also add and delete
annotations, email reports, shared links and alert rules; admins also export and delete a
visitor's data, and manage members and API tokens (ADR 0003). Pages need no key: a batch is taken only from one of its site's domains.

## Reports in the API

Every report (`/api/v1/report`, `breakdown`, `vitals`, `frustration`, `funnels`, `forms`, `heatmap`) takes `days`,
any number of `filter` parameters and `compare`:

```
/api/v1/report?site=shop&days=30&filter=country:is:DE|AT&filter=channel:not:direct&compare=previous
```

A filter is `dimension:is:values` or `dimension:not:values`, values separated by `|`; `(none)` matches a visit without
a value, and `*` in a page, entry, exit or referrer matches any characters. All filters apply together. The dimensions
are those of a visit (`channel`, `source`, `referrer`, `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`,
`utmContent`, `entry`, `exit`, `browser`, `browserVersion`, `os`, `osVersion`, `device`, `country`, `region`, `city`,
`language`, `timezone`, `screen`, `visitorType`) and what it did (`page`, `event`, `goal`). `compare=previous` adds
the as many days just before, `compare=year` the same days a year before, under `compare`. `/api/v1/breakdown` groups
by any dimension of a visit, or by `page`, `event`, `search`, `notFound`, `outbound` and `download`;
`/api/v1/realtime` shows the visits of the last five minutes, the page each is on, the goals of the last 30 minutes and
the latest of what happened; `/api/v1/ecommerce`, `/api/v1/attribution` (`goal`, `lookback`, `by`), `/api/v1/paths`
(`page`, `direction`, `steps`), `/api/v1/sitesearch` and `/api/v1/search-console` (`engine`) take the same parameters,
and `/api/v1/retention` takes `weeks`, `days` and filters; `/api/v1/vitals` also gives each day's 75th percentile; `/api/v1/annotations` lists,
adds and deletes annotations; `/api/v1/settings` gives the sites file as it was last applied, read-only. See
`/api/docs/` for every field.

Sharing has `/api/v1/segments`, `/api/v1/email-reports`, `/api/v1/shares` and `/api/v1/alerts`; a shared link reads
`/api/v1/shared/{token}` and its `report`.

## Coming next

JavaScript errors sent on to Errors.

## Develop

```bash
npm install
npm test        # the sites file, batches, reports, the script in jsdom, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).

IP geolocation by [DB-IP](https://db-ip.com), from the DB-IP Lite city database, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The database is downloaded by each install and is not part
of this repository or its image.
