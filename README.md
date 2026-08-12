# msOauth2api

Turns Microsoft OAuth2 mailboxes into simple HTTP endpoints, with a Vue web panel for
managing accounts and reading mail. Self-hosted as a single Docker container.

A rebuild of [HChaoHui/msOauth2api](https://github.com/HChaoHui/msOauth2api) as an
npm + Vue 3 project packaged to a Docker image, following the structure of
[Bemby](https://github.com/liveinaus/Bemby). The public API stays compatible with the
original, so existing scripts keep working.

## What it does

Given a Microsoft `client_id` and a `refresh_token`, it reads and sends mail without you
touching OAuth. It tries **Graph API** first and falls back to **IMAP** when the token was
not granted `Mail.Read` -- Graph is faster and less rate-limited.

- Read the latest message, or a whole folder (inbox and junk)
- Automatic verification-code extraction
- Empty the inbox or junk folder
- Send mail over Outlook SMTP
- Refresh tokens, individually or in batches
- Optional AI summarisation via any OpenAI-compatible endpoint
- Web panel: account list, import/export, mailbox browser, API key management

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

## Authentication

The panel uses an admin login (argon2-hashed, JWT sessions). The mail endpoints are meant
for scripts and take an **API key**, created under Settings. Send it either way:

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

| Endpoint                      | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `GET/POST /api/mail-new`      | Latest message in a folder                                  |
| `GET/POST /api/mail-all`      | Messages in a folder, newest first                          |
| `GET/POST /api/refresh-token` | Exchange a refresh token for its replacement                |
| `GET/POST /api/process-inbox` | Empty the inbox                                             |
| `GET/POST /api/process-junk`  | Empty the junk folder                                       |
| `GET/POST /api/send-mail`     | Send a message over SMTP                                    |
| `POST /api/ai`                | Streaming OpenAI-compatible proxy (SSE)                     |
| `GET /api/health`             | Unauthenticated liveness, used by the container healthcheck |

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

#### One inherited quirk

Upstream's `mail-new` answered with an **array of one** on the Graph path but a **bare
object** on the IMAP path. Both are reproduced exactly, by transport, so clients written
against either keep working. Pass `shape=array` or `shape=object` to stop depending on which
transport served the request.

## Differences from upstream

Behaviour that changed deliberately, beyond the port itself:

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
amd64 and arm64 on native runners and merging them into one manifest.

## Getting a refresh token

This project consumes tokens; it does not mint them. You need an Azure app registration with
delegated `Mail.ReadWrite`, `Mail.Send` and `offline_access` (add `IMAP.AccessAsUser.All` and
`SMTP.Send` for the IMAP fallback), then any standard OAuth2 authorisation-code flow against
`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize`.

Accounts import as delimited lines, four fields, `----` by default:

```
email----password----client_id----refresh_token
```

Re-importing an address updates it rather than adding a duplicate.

## Licence

MIT, as upstream.
