# msOauth2api

Turns Microsoft OAuth2 mailboxes into simple HTTP endpoints, with a Vue web panel for
managing accounts and reading mail. Self-hosted as a single Docker container.

Version **0.8.1**, MIT licensed. Pin `liveinaus/msoauth2api:0.8.1` for a fixed deployment,
or track `latest`.

## What it does

Given a Microsoft `client_id` and a `refresh_token`, it reads and sends mail without you
touching OAuth. It tries **Graph API** first and falls back to **IMAP** when the token was
not granted `Mail.Read` -- Graph is faster and less rate-limited. Accounts consented only to
the older Outlook IMAP permission can be marked to go straight to IMAP; see
[Accounts on the older IMAP grant](#accounts-on-the-older-imap-grant).

- Read the latest message, or a whole folder (inbox and junk)
- Automatic verification-code extraction
- Empty the inbox or junk folder
- Send mail over Outlook SMTP
- Refresh tokens, individually or in batches
- Optional AI summarisation via any OpenAI-compatible endpoint
- Web panel: account list, import/export, mailbox browser, API key management
- Copy an address from the panel and it watches that mailbox for the code that follows
- Usage tracking, on copy alone or on mail arriving after the copy (Settings decides which)

## Quick start

```bash
docker run -d --name msoauth2api \
  -p 3000:3000 \
  -v /docker/msoauth2api-data:/app/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e MSAPI_DATA_KEY="$(openssl rand -hex 32)" \
  -e ADMIN_PASSWORD=changeme \
  liveinaus/msoauth2api:latest
```

Open `http://localhost:3000` and sign in as `admin` / `changeme`. You will be asked to set a
real password before you can continue.

Or with compose (see [docker-compose.yml](docker-compose.yml)):

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d
```

> Back up `MSAPI_DATA_KEY`. It encrypts the stored refresh tokens, and without it they
> cannot be recovered -- you would have to import every account again.

## Configuration

Every variable is documented in [env.example](env.example). The essentials:

| Variable                                              | Required    | Purpose                                                                                                       |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                                          | **yes**     | Signs login tokens. The app refuses to start without it.                                                      |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD`                   | no          | Seed the admin login on first run (`admin` / `changeme`). Ignored afterwards; change credentials in Settings. |
| `MSAPI_DATA_KEY`                                      | recommended | Encrypts stored refresh tokens and mail passwords at rest.                                                    |
| `PASSWORD`                                            | no          | Upstream's shared secret for the mail endpoints, still accepted verbatim.                                     |
| `SEND_PASSWORD`                                       | no          | Upstream's separate secret for `/api/send-mail`.                                                              |
| `AI_API_KEY` / `AI_API_URL` / `AI_MODEL`              | no          | Enables AI summarisation.                                                                                     |
| `PORT`, `DB_PATH`, `TZ`, `TRUST_PROXY`, `CORS_ORIGIN` | no          | Server tuning. Set `TRUST_PROXY=1` behind a reverse proxy so login rate limiting sees real client IPs.        |
| `IMAP_TIMEOUT_MS` and friends                         | no          | Mail fetch timeouts and retries. Defaults suit a normal connection; see [Slow mailboxes](#slow-mailboxes).    |

## Authentication

The panel uses an admin login: argon2-hashed credentials, JWT sessions, an image **captcha**
and per-IP rate limiting on every password check.

The captcha answer never leaves the server. The browser is given an opaque id and the answer
stays in the process, because signing it into a token for the client to quote back would put
it one `atob` away (a JWT payload is base64, not ciphertext). Each challenge is also burnt on
a single attempt, win or lose, so one solved captcha cannot cover a run of password guesses.

The mail endpoints are meant for scripts, so they carry no captcha and take an **API key**
created under Settings. Send it either way:

```bash
# Preferred: a header, so the secret stays out of logs
curl -H "X-API-Key: msk_..." "http://localhost:3000/api/mail-new?email=a@b.com&mailbox=INBOX"

# Upstream-compatible: a query parameter
curl "http://localhost:3000/api/mail-new?email=a@b.com&mailbox=INBOX&password=msk_..."
```

If `PASSWORD` is set, its value is accepted in the `password` parameter exactly as upstream,
so existing automation needs no changes.

> Unlike upstream, leaving `PASSWORD` unset does **not** make the endpoints public: a
> container holding a database of mailboxes should never answer an unauthenticated caller.

## API

All endpoints accept GET or POST, and read parameters from the query string or the body.

| Endpoint                      | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `GET/POST /api/mail-new`      | Latest message in a folder                                    |
| `GET/POST /api/mail-all`      | Messages in a folder, newest first                            |
| `GET/POST /api/refresh-token` | Exchange a refresh token for its replacement                  |
| `GET/POST /api/process-inbox` | Empty the inbox                                               |
| `GET/POST /api/process-junk`  | Empty the junk folder                                         |
| `GET/POST /api/send-mail`     | Send a message over SMTP                                      |
| `POST /api/ai`                | Streaming OpenAI-compatible proxy (SSE)                       |
| `GET /api/auth/captcha`       | Issues a login captcha: `{ svg, captchaToken }`               |
| `POST /api/auth/login`        | Needs `username`, `password`, `captchaToken`, `captchaAnswer` |
| `GET /api/health`             | Unauthenticated liveness, used by the container healthcheck   |

Rate limits, all per IP over 15 minutes: 10 login attempts, 10 credential changes, 60 captcha
requests. Set `TRUST_PROXY` correctly behind a reverse proxy or every visitor shares one
bucket.

### Parameters

| Name                            | Endpoints                  | Notes                                                      |
| ------------------------------- | -------------------------- | ---------------------------------------------------------- |
| `refresh_token`, `client_id`    | all mail endpoints         | Optional if the address is a stored account                |
| `email`                         | all except `refresh-token` | The mailbox to act on                                      |
| `mailbox`                       | `mail-new`, `mail-all`     | `INBOX` or `Junk` only                                     |
| `response_type`                 | `mail-new`                 | `json` (default) or `html`                                 |
| `limit`                         | `mail-all`                 | Defaults to 100, capped at 1000                            |
| `shape`                         | `mail-new`                 | `array` or `object`, to pin the response shape (see below) |
| `to`, `subject`, `text`, `html` | `send-mail`                | `text` or `html` is required                               |

Because accounts are stored server-side, you can call an endpoint with just an address and
let the server supply the credentials:

```bash
curl -H "X-API-Key: msk_..." \
  "http://localhost:3000/api/mail-new?email=a@b.com&mailbox=INBOX"
```

### Response

```json
[
  {
    "send": "no-reply@example.com",
    "subject": "Your verification code",
    "text": "Your code is 483920",
    "html": "<p>Your code is <b>483920</b></p>",
    "date": "2026-08-13T01:02:03Z",
    "code": "483920"
  }
]
```

`code` is the one field added to upstream's shape, carrying the extracted verification code
when the message has one.

## Address pool API

For systems that sign up for a service and then wait for its verification code. Ask for an
address not yet used for a **type** (`Telegram`, `Discord`, anything you like), hand it to
that service, then poll for the code. Types are free text, matched case-insensitively, and
an address used for one type stays available for every other.

All of these need an API key, like the mail endpoints.

| Endpoint                            | Purpose                                      |
| ----------------------------------- | -------------------------------------------- |
| `GET/POST /api/get-available-email` | Leases the next address unused for `type`    |
| `GET/POST /api/get-code`            | The code for an address, if one has arrived  |
| `POST /api/confirm-email`           | Retires an address for a type without a code |
| `POST /api/release-email`           | Hands a leased address back early            |
| `GET /api/email-status`             | What an address has been used for            |
| `GET /api/pool-status`              | Remaining capacity for a type                |

### Leases

An address is claimed the moment it is handed out, so two callers cannot be given the same
one, but the claim expires (15 minutes by default, set under Settings). If no code ever
arrives the address returns to the pool, so an abandoned signup does not consume it. Finding
a code confirms the claim permanently, as does `confirm-email`.

Addresses that are disabled, or whose last token refresh failed, are never handed out: an
address that cannot receive mail is worse than none.

### Priority

Within the pool, addresses are handed out highest priority first, and only then in the usual
round-robin. Select rows on the Accounts page and use the priority buttons to raise or lower
the selection, or the cross to put it back to normal; a negative priority keeps an address in
the pool but at the back of the queue. Priority is per address, not per type, and it does not
override the disabled or failed-refresh rules above.

### Typical run

```bash
# 1. Take an address for this signup.
curl -H "X-API-Key: msk_..." \
  "http://localhost:3000/api/get-available-email?type=Telegram"
# {"email":"a@b.com","type":"telegram","leasedAt":1786…,"leaseExpiresAt":1786…,"remaining":42}

# 2. Sign up with a@b.com, then poll. 200 either way; read `status`.
curl -H "X-API-Key: msk_..." \
  "http://localhost:3000/api/get-code?email=a@b.com&type=Telegram&from=telegram"
# {"status":"pending","email":"a@b.com","type":"telegram","query":{…}}
# {"status":"found","code":"483920","message":{"from":"noreply@telegram.org",
#  "subject":"Login code","date":"2026-08-13T12:05:00Z","mailbox":"Junk"}}

# 3. Only if you give up, so the address is not wasted.
curl -X POST -H "X-API-Key: msk_..." -H "Content-Type: application/json" \
  -d '{"email":"a@b.com","type":"Telegram"}' \
  http://localhost:3000/api/release-email
```

### Parameters

| Name              | Endpoints                             | Notes                                                              |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `type`            | all except `get-code`, where optional | The integration label, e.g. `Telegram`                             |
| `email`           | all except `get-available-email`      | Must be a stored account                                           |
| `from`, `subject` | `get-code`                            | Case-insensitive substring filters on sender and subject           |
| `since`           | `get-code`                            | Epoch ms or ISO date. Defaults to the lease time when `type` given |
| `limit`           | `get-code`                            | Messages scanned per folder, default 10, capped at 50              |

`get-code` searches the inbox and the junk folder, because verification mail from an unknown
sender is exactly what Outlook files as junk. Pass `type` wherever you can: it scopes the
search to mail that arrived after the address was leased, which is what stops a previous
run's code being handed back as this run's.

### Statuses

`get-code` answers `200` with `status: "found"` or `status: "pending"`, so a poller can tell
"not yet" from a real failure. `404` means the address is not a stored account. Exhausting
the pool gives `409` from `get-available-email`, with the counts:

```json
{
  "error": "No address available for type \"telegram\"",
  "type": "telegram",
  "available": 0,
  "leased": 12,
  "confirmed": 88
}
```

#### One inherited quirk

Upstream's `mail-new` answered with an **array of one** on the Graph path but a **bare
object** on the IMAP path. Both are reproduced exactly, by transport, so clients written
against either keep working. Pass `shape=array` or `shape=object` to stop depending on which
transport served the request.

### Slow mailboxes

Outlook is regularly slow rather than broken, so a read that stumbles is retried before it
is called a failure. The whole read, retries included, runs under one budget
(`IMAP_TIMEOUT_MS`, default 45s, `IMAP_ATTEMPTS` goes inside it), and Graph and token calls
have their own (`MAIL_HTTP_TIMEOUT_MS`, default 30s). Each phase can be tuned separately;
see [env.example](env.example).

Two outcomes are kept apart, because only one of them is the account's fault:

- **The mailbox will not serve IMAP** -- Outlook says so in as many words, it does not clear
  on a retry, so it answers `502`, is recorded against the account, and takes the address
  out of the pool.
- **The mailbox was merely slow** -- nothing is recorded, the address stays in the pool, and
  `get-code` answers `200` with `status: "pending"` and a `warning` naming the reason, since
  a poller should ask again rather than send someone to read the code by hand. The other
  mail endpoints answer `503` with `Retry-After`.

Reading the inbox and the junk folder is likewise not all-or-nothing: if one folder answers
and the other does not, the messages that were found are still returned.

### When an account gets marked

The warning badge on a row is not a log line: the pool skips any account carrying one, so a
marked address is out of circulation until something clears it. Two rules keep it off
working accounts.

- **Only the account's own fault counts.** Microsoft rejecting the grant does; a throttled
  (`429`), unwell (`5xx`) or unreachable token endpoint does not, nor does a timeout. Those
  fail the request and nothing more.
- **It has to repeat.** A verdict is only written after `ACCOUNT_FAULT_STREAK` consecutive
  failures (default 2), and any successful read resets the count. A dead token fails every
  time and is marked on the next attempt; a blip never gets its second one.

A mailbox that answers also **clears** a mark left over from an earlier bad minute, so an
account that recovers comes back into the pool on its own. Reading mail from the row (the
envelope button) or running a refresh is enough to do that by hand.

## Keeping tokens alive

Microsoft invalidates a refresh token that goes unused for long enough, and a pool whose
addresses are handed out unevenly will have some nobody has touched in months. Settings can
turn that from a surprise at the moment an address is needed into a scheduled job: set
**Refresh tokens older than** to a number of days and pick a **check** time, 04:00 by
default. Zero days leaves the sweep off, which is the default.

Once a day the panel refreshes every token that has not been refreshed inside that window,
oldest first, three at a time -- the same path and the same throttling as the panel's
**Refresh tokens** button, so the marking rules under
[When an account gets marked](#when-an-account-gets-marked) apply unchanged.

- **A token never refreshed counts as stale.** It holds whatever was imported or consented,
  of unknown age.
- **Disabled accounts are skipped.** Someone switched those off; refreshing one puts it back
  in circulation as far as Microsoft is concerned.
- **A missed window is caught up, not skipped.** A container down at 04:00 and back at 06:00
  still sweeps that day. The run is tracked by local calendar date, so the tick cannot fire
  twice in one night and a restart cannot repeat it.
- **Switching it on part way through a day waits for the next one.** Enabling it at noon does
  not put the whole panel through the token endpoint straight away; the Refresh tokens button
  is there for that.

Times are local to the container, so set `TZ` if you want 04:00 to mean 04:00 where you are.

## Backup and migration

Settings has a **Backup and migration** card that exports the whole panel as one JSON
document and restores it on another instance: every account with its metadata and usage
history, the type configuration, the panel settings, the API keys (as hashes) and the admin
login.

Both endpoints take a panel session, so they are reachable from a script with a login token:

```bash
# Export
curl -H "Authorization: Bearer $TOKEN" \
  https://panel.example.com/api/backup/export -o backup.json

# Restore on another instance (merge is the default; "replace" wipes first)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"mode\":\"replace\",\"includeAdmin\":true,\"backup\":$(cat backup.json)}" \
  https://other.example.com/api/backup/import
```

Notes:

- **JSON, not a copy of the SQLite file.** Secrets are encrypted at rest with
  `MSAPI_DATA_KEY`, so a file copy is unreadable on an instance holding a different key. The
  export decrypts and the import re-encrypts under the target's own key, which means the two
  instances need not share one.
- **The file holds refresh tokens and mailbox passwords in the clear.** It can read every
  mailbox on the panel. Treat it like the database.
- **Accounts are matched by address**, not by row id, so a merge into a populated panel
  updates the addresses it knows and adds the rest. Addresses are compared without regard to
  case, so `John@x.com` cannot become a second row alongside `john@x.com`.
- **The admin login is only restored when `includeAdmin` is set.** Doing so retires every
  session on the target, including the one that ran the import.
- **API keys travel as hashes**, so existing scripts keep working after a migration without
  the plain keys ever being written to the file.

## Differences from upstream

Behaviour that changed deliberately, beyond the port itself:

- **The account list is ordered by the server.** `GET /api/accounts` takes `sort` and `dir`,
  defaulting to `priority`/`desc` -- the order the pool spends addresses in. Sortable:
  `priority`, `email`, `clientId`, `status`, `lastRefreshAt`, `lastUsedAt`, `id`. Rows with
  no date sort last either way, `id` always breaks a tie so paging is stable, and an
  unrecognised value falls back to the default rather than erroring. The verification code
  and usage columns are not sortable: both come from the usages table, one row per type, so
  an address used for three types has no single value to order by.
- **Accounts are stored server-side** in SQLite, encrypted at rest, instead of in browser
  `localStorage`. Refresh tokens are never sent to the page -- the panel sees a fingerprint.
- **Rolled refresh tokens are persisted.** Microsoft invalidates the old token when it issues
  a new one, so an install that never wrote the replacement back would work once per account
  and then go stale.
- **Endpoints are never public**, as described above.
- **`mail-all` is bounded** (100 by default, 1000 max). Upstream asked Graph for `$top=10000`
  and fetched every IMAP message in the folder, which times out on a large mailbox.
- **IMAP uses `imapflow`** rather than the callback-based `node-imap`. Upstream's `mail-all`
  could resolve before the last message finished parsing and reply with a partial list.
- **Batch operations are concurrency-limited**, because Microsoft throttles the token
  endpoint. Upstream's browser loop fired one unbounded request per account.
- **Message HTML renders in a sandboxed iframe** under a CSP with `script-src 'self'`, so
  sender markup cannot reach the session token. Remote images are blocked, which also stops
  tracking pixels.
- **The SMTP `ciphers: 'SSLv3'` pin is gone**; modern OpenSSL refuses that suite outright.
- **Verification-code extraction is implemented.** Upstream's README advertised it but the
  code was not there.
- **The admin login has a captcha and rate limiting.** Upstream had no panel login at all:
  the shared `PASSWORD` was typed into the page and kept in `localStorage`.

## Development

```bash
./dev.sh
```

Starts the backend on `:3000` and Vite on `:5173`, creating `backend/.env` from
`env.example` and generating a `JWT_SECRET` on first run. Vite proxies `/api` to the
backend.

```
backend/          Express + TypeScript (strict)
  src/db/         SQLite access, at-rest encryption
  src/auth/       Admin credentials, API keys
  src/middleware/ JWT and API key guards
  src/services/   OAuth, Graph, IMAP, SMTP, AI, code extraction
  src/routes/     HTTP layer
frontend/         Vue 3 + Vite + vue-router, en/zh i18n
```

```bash
cd backend  && npm run build && npm test   # tsc + vitest
cd frontend && npm run build               # vue-tsc + vite
npx prettier --write .
```

## Building the image

```bash
docker build -t msoauth2api:local .
```

Three stages: build the SPA, compile the backend and prune to production dependencies, then
assemble a Debian slim runtime. Debian rather than Alpine because `better-sqlite3` and
`argon2` are native addons that must be built against the libc they run on. The container
runs as the non-root `node` user, with a healthcheck on `/api/health`.

Releases publish multi-arch images to Docker Hub and GHCR via
[.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml), building
amd64 and arm64 on native runners and merging them into one manifest. Tags map to image
tags with the `v` stripped, plus a moving alias per channel:

| Git tag         | Image tags             |
| --------------- | ---------------------- |
| `v0.8.1`        | `0.8.1`, `latest`      |
| `v0.8.1-beta.1` | `0.8.1-beta.1`, `beta` |
| `dev-v0.8.1-1`  | `dev-v0.8.1-1`, `dev`  |

A stable release goes out when a GitHub release is published; beta and dev tags publish on a
direct tag push. [.github/workflows/dockerhub-description.yml](.github/workflows/dockerhub-description.yml)
pushes this README to the Docker Hub repository description.

## Getting a refresh token

You need an Azure app registration with delegated `Mail.ReadWrite`, `Mail.Send` and
`offline_access` (add `IMAP.AccessAsUser.All` and `SMTP.Send` for the IMAP fallback). It has
to be a **public client** -- "Allow public client flows" enabled, registered for personal
Microsoft accounts -- because the token exchange sends `client_id` and no secret. An app that
requires a secret is rejected on every refresh.

There are then two ways to get a token, and the panel can do it for you.

### Connecting a mailbox through the panel

`POST /api/oauth/start` builds an authorisation URL; the mailbox owner signs in; Microsoft
redirects to `GET /api/oauth/callback`, which redeems the code and **writes the account
straight into the database**. No import step, and the refresh token never passes through a
terminal or a clipboard.

Set the app registration once, under Settings or as `OAUTH_CLIENT_ID` / `OAUTH_REDIRECT_URI`
(see [env.example](env.example)). Then, per mailbox:

```bash
curl -X POST -H "X-API-Key: msk_..." -H "Content-Type: application/json" \
  -d '{"email":"a@b.com"}' \
  https://panel.example.com/api/oauth/start
# {"authorizeUrl":"https://login.microsoftonline.com/consumers/...","state":"…","expiresAt":…}
```

`/start` takes an API key or a panel session, so a script can onboard mailboxes without a
browser session. Note that this lets a key **create** accounts, not merely read them.

Open `authorizeUrl`, sign in as `a@b.com`, accept consent. The callback answers with a page
saying whether the mailbox was saved, and the row is on the Accounts page immediately.

`clientId`, `redirectUri` and `authType` can be passed per request to override the
configured defaults.

Settings also decides where a newly connected mailbox lands in the pool queue: normal, level
with or one above the current highest, level with or one below the current lowest, or a fixed
rank. It is worked out against the pool as it stands when the account is stored, and applies
only to accounts the flow **adds** -- reconnecting one already on the panel leaves the
priority someone set by hand alone. The returned `authorizeUrl` carries the `client_id` and `redirect_uri`
it resolved, so it doubles as a check that they match the app registration.

Register the callback URL on the app registration exactly as the panel will send it, e.g.
`https://panel.example.com/api/oauth/callback`. Entra allows plain `http` only for
`localhost`, so a deployed panel must be behind TLS; `/start` rejects anything else rather
than letting Microsoft do it later.

What the flow guarantees:

- **The PKCE verifier stays in the server.** It is generated by `/start`, held in memory
  against the `state`, and never sent to the browser -- a verifier the client holds is one an
  interceptor holds too, which is the whole point of PKCE.
- **A flow is single-use.** The `state` is burnt on the first callback, before the exchange,
  so a leaked code cannot be redeemed twice or replayed against a live flow. Flows expire
  after 20 minutes.
- **The signed-in mailbox is checked.** The `id_token` is compared against the address the
  flow was started for, so an admin already signed in as someone else cannot file that
  account's token under the address they typed. On a mismatch nothing is stored.
- **A reconnect updates the row.** Accounts are matched by address, and a fresh consent also
  clears a stale failure badge, putting a recovered address back into the pool.

### By hand

[tools/get-refresh-token.mjs](tools/get-refresh-token.mjs) runs the same flow from a
terminal, for a mailbox you would rather not connect through the panel:

```bash
# Browser on this machine: it captures the redirect itself.
node tools/get-refresh-token.mjs --client-id <guid> --email a@b.com

# Browser elsewhere: print the URL and redeem the code by hand. Nothing needs to listen.
node tools/get-refresh-token.mjs --client-id <guid> --url
node tools/get-refresh-token.mjs --client-id <guid> --code '<code>' --verifier '<verifier>'
```

It prints a ready-made import line. The `code` in a redirect is not a refresh token: it is
single-use, lasts about ten minutes, and has to be exchanged with the verifier from the same
run before it means anything.

Accounts import as delimited lines, four fields, `----` by default:

```
email----password----client_id----refresh_token
```

Re-importing an address updates it rather than adding a duplicate, and the comparison ignores case: an address is stored lower-cased, so the same mailbox written any way lands on the one row.

### Accounts on the older IMAP grant

Some accounts were only ever consented to the Outlook IMAP permission, never to Graph. Their
tokens have to ask for `https://outlook.office.com/IMAP.AccessAsUser.All` by name, so they
are marked with a **protocol** of `imap` and skip the Graph probe entirely. Everything else
stays on `auto`, which is the original Graph-first behaviour and remains the default.

Marking is an optimisation, not a requirement: an `auto` account with no Graph consent has
its Graph probe rejected outright, and that rejection now degrades to IMAP rather than
surfacing as an error, so the account still reads. Marking it `imap` just skips the probe --
worth doing for a large batch, since that is one guaranteed-to-fail, rate-limited call per
account on every poll.

Set it in any of these ways:

- **Panel**: tick the accounts, then pick `IMAP only (old OAuth2)` from the protocol
  selector in the toolbar. The account list shows an `IMAP` badge against each one.
- **Import**: choose the protocol in the import dialog to apply it to the whole file, or add
  an optional fifth field to a line to set it for that account alone:

  ```
  email----password----client_id----refresh_token----imap
  ```

- **API**: `POST /api/accounts/auth-type` with `{"ids": [105, 106], "authType": "imap"}`, or
  pass `authType` to `POST /api/accounts` and `PATCH /api/accounts/:id`.

The mail endpoints also take an `auth_type` parameter alongside `refresh_token` and
`client_id`, for callers passing credentials this install has never stored.

Exports now carry the protocol as a fifth field so a backup round-trips. Four-field files
still import exactly as before, and an import that says nothing about the protocol leaves
whatever an existing account is already set to.

Sending works too. `SMTP.Send` is a separate permission from the IMAP read scope -- a token
scoped for one does not authenticate the other -- so `/api/send-mail` fetches its own
SMTP.Send token for these accounts. It relies on the registration having consented to
SMTP.Send, which the bulk consumer registrations these accounts come from generally have.

## Licence

MIT. The full text is in [LICENSE](LICENSE).

The project is a port of an MIT-licensed upstream and keeps the same terms. MIT requires the
copyright notice to travel with the code, so keep `LICENSE` in place if you redistribute
this or build on it.
