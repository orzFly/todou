# Deploying todou

A single systemd **user** unit runs one process that serves both the API and
the built web app. No reverse proxy is required; put one in front only for TLS.

## Layout

State lives outside the checkout, so `git pull` never touches data:

```
~/todou/                    the checkout (disposable — rebuildable from git)
~/todou-data/
├── config.toml             configuration
└── data/
    ├── system/             PGlite database
    └── attachments/        uploaded blobs
```

Relative paths in `config.toml` resolve against the process working
directory, which the unit sets to `~/todou-data`. `http.static_dir` is
absolutised at load, so it may be given relative or absolute.

## Prerequisites

Node 24 (the server runs `.ts` sources natively) and pnpm. On a Debian host,
`libpam-systemd`, `dbus`, and `git`; the first two are what make
`systemctl --user` and lingering work at all.

```bash
apt-get install -y libpam-systemd dbus git
useradd -m -s /bin/bash todou
loginctl enable-linger todou      # so the unit starts at boot with no login
```

Then, as that user, install the toolchain — e.g. with mise:

```bash
curl https://mise.run | sh
mise use -g node@24 pnpm@11
```

## Install

```bash
git clone <repo> ~/todou
cd ~/todou && pnpm install --frozen-lockfile && pnpm build
mkdir -p ~/todou-data
```

`~/todou-data/config.toml`:

```toml
[http]
port = 8637
static_dir = "/home/todou/todou/projects/web/dist"

[database]
system = "pglite://./data/system"

[storage]
path = "./data/attachments"
```

PGlite auto-migrates on open, so there is nothing to run for a fresh install.
For PostgreSQL, set `database.system` to a `postgres://` URL and apply
migrations explicitly: `todou-server migrate` applies pending migrations to
the system database and every project database.

## Docker

The same server + built SPA, prepackaged:

```bash
docker run -d -p 8637:8637 -v todou-data:/data ghcr.io/orzfly/todou:latest
```

Tags: `latest` is the most recent release, `x.y.z` a specific one, `edge`
the tip of master, and `sha-*` an exact commit.

Everything under [Layout](#layout) that lives in `~/todou-data` lives in the
`/data` volume here. Configure with `TODOU_*` environment variables (each
config key has one; see the sections below), or drop a `todou.toml` into the
volume — the process working directory is `/data`, so the default config
path finds it. Environment variables win over the file.

The image runs as the unprivileged uid 65532 and contains no shell. A named
volume inherits the right ownership automatically; a bind mount must be
`chown -R 65532:65532` on the host first. For administrative commands, the
image entrypoint is `node`, so pass the server entry and a subcommand — with
PostgreSQL, migrations stay explicit:

```bash
docker run --rm -e TODOU_DATABASE_SYSTEM=postgres://… \
  ghcr.io/orzfly/todou:latest /app/projects/server/src/index.ts migrate
```

## Serving the SPA

With `http.static_dir` set, one process serves both the SPA and the API —
there is no second process and no proxy to configure. Hashed files under
`/assets` are served immutable; `index.html` is revalidated, and any
unmatched non-`/api` path returns it so the client router can resolve deep
links. Because the SPA is then same-origin with the API, the session cookie
and the SSE stream need no CORS or reverse-proxy buffering setup.

## Database placement

```toml
[database]
system = "pglite://./data/system"        # or postgres://…

[database.projects]
placement = "shared"                     # project data lives in the system db
# placement = "dedicated"                # …or route each project by template:
# url_template = "pglite://./data/projects/${project.id}"
# url_template = "postgres://${project.id > 100 ? 'pg-b' : 'pg-a'}/todou_${project.id}"
# workers = false                        # opt out of worker-thread PGlite hosts
#                                        # (they default to on under dedicated placement)
```

`url_template` is compiled once at startup as a JS template literal with
`project = {id, slug}` in scope — keep it deterministic; per-project moves
go through the registry's `database_url` override column.

### Worker-hosted project databases

With `workers` enabled — the default under dedicated placement — each
PGlite project database runs in its own `worker_threads` worker; a
main-thread proxy forwards drizzle's query surface over a `MessagePort`.
PGlite is single-connection WASM — hosted inline, every project's queries
compute on the main thread, so total database throughput is capped at one
core no matter how many projects are busy. Only PGlite project databases
under dedicated placement are affected; the system database always runs
inline, and `postgres://` targets ignore the flag.

Trade-offs, measured with `pnpm --filter @todou/server bench:db` (32-core
host; rerun it on yours):

- The proxy hop costs ~0.2 ms per query. That is visible only on
  sub-millisecond single-client writes (~30% lower throughput); reads and
  heavier queries are at parity even with a single project.
- With several busy project databases, throughput scales with cores
  instead of plateauing: at 8 projects, 3.7× on writes, 4.5× on aggregate
  reads, and heavy ~100 ms queries keep a flat p50 where inline latency
  grows linearly with the number of busy projects.
- Each worker adds a thread and V8 isolate on top of the WASM heap the
  PGlite instance needs in either mode — budget roughly one thread per
  open handle, bounded by `max_open`.
- If a worker crashes, in-flight queries on that database fail (they are
  never retried automatically) and a fresh worker reopens the data
  directory, recovering committed data; other projects never notice.
  After three consecutive crashes without a successful query in between,
  the handle stops respawning and fails fast instead.

### PostgreSQL pool sizing

Every `postgres://` target gets its own `pg.Pool`, tunable in one place
(defaults shown — they are pg's own):

```toml
[database.pool]
max = 10                    # connections per pool
idle_timeout_ms = 10000
connection_timeout_ms = 0   # 0 = wait forever
```

Under `dedicated` placement each open project database is a separate pool,
so the theoretical connection ceiling is `database.projects.max_open ×
pool.max` (plus one pool for the system database). Work backwards from the
PostgreSQL server's `max_connections` when raising either knob.

## The unit

`~/.config/systemd/user/todou.service`:

```ini
[Unit]
Description=todou server 🥔
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/todou-data
ExecStart=%h/.local/share/mise/shims/node %h/todou/projects/server/src/index.ts serve --config %h/todou-data/config.toml
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Calling the mise **shim** directly means the unit needs no shell activation.

On SIGTERM the server ends its SSE streams, drains in-flight requests for
up to a second, and force-exits itself after five — so a stop normally
completes in well under a second. `TimeoutStopSec=10` caps the outage if
that ever regresses; without it, systemd's default gives a hung stop ~90s
of 502s per deploy before the SIGKILL.

```bash
systemctl --user daemon-reload
systemctl --user enable --now todou
```

## Updating

```bash
cd ~/todou
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart todou
```

Keep this as a script on the host rather than in the repo — a script that
`git pull`s itself while the shell is still reading it is a footgun.

## Verifying

```bash
systemctl --user status todou
journalctl --user -u todou -n 30        # "todou server listening on :8637 🥔"

curl -sSI http://localhost:8637/                 # 200 text/html, no-cache
curl -sSI http://localhost:8637/settings/tokens  # 200 text/html — deep link
curl -sS  http://localhost:8637/api/openapi.json # the API document
curl -sS  http://localhost:8637/api/nope         # JSON error, never HTML

loginctl show-user todou | grep Linger           # expect Linger=yes
```

## Behind a reverse proxy

Forward everything on one origin to `:8637` — do not split `/api` from the
static files, or the session cookie and SSE stream stop being same-origin.

Have the proxy set `X-Forwarded-Proto` (and `X-Forwarded-Host` if it
rewrites hosts). Forwarded headers are only believed when the TCP peer
matches `http.trusted_proxies`, which defaults to loopback:

```toml
[http]
trusted_proxies = ["127.0.0.1/32", "::1/128"]   # add your proxy's address/CIDR
public_origin = "https://todou.example"          # optional; see oidc below
```

The session cookie is `HttpOnly; SameSite=Lax`; its `Secure` flag follows
the request — set automatically when a trusted proxy says
`X-Forwarded-Proto: https`, absent over plain HTTP, so one deployment can
serve both a TLS domain and localhost. Pin it with `[auth] cookie_secure =
true|false` if a proxy setup confuses the detection.

For SSE (`/api/projects/:slug/events`), response buffering must be off.
Traefik and Caddy stream by default; nginx needs `proxy_buffering off`.

## Auth modes

`auth.mode` picks how HUMANS sign in — exactly one per deployment. Bearer
PATs (agents, the CLI) work identically in every mode and may hit the
backend port directly, bypassing any auth proxy. `GET /api/auth/mode` is
public; the web login page branches on it.

### `single` (default)

Zero-input login as the built-in `user` account. What this document
described so far; nothing to configure.

### `oidc`

Authorization-code + PKCE against any OpenID Connect provider
(Keycloak, Authelia, Authentik, Google, …); the callback creates the same
30-day sliding DB session single mode uses.

```toml
[auth]
mode = "oidc"

[auth.oidc]
issuer = "https://auth.example.com"
client_id = "todou"
client_secret = "…"                  # or TODOU_AUTH_OIDC_CLIENT_SECRET
# scopes = "openid profile email"    # defaults
# login_claim = "preferred_username"
# auto_create = true
```

Register the client with redirect URI `<origin>/api/auth/callback`. The
origin comes from `http.public_origin` when set, otherwise it is derived
per request from (trusted) forwarded headers — set it explicitly when the
IdP is strict about redirect URIs and you want no surprises.

Register that URI exactly. If your IdP only takes wildcard or regex
patterns, scope them no wider than `<origin>/api/auth/` — never the whole
origin: todou serves user-uploaded attachments on the same origin, and an
origin-wide pattern lets an authorization code be redirected onto
user-controlled content.

Login maps the `login_claim` value to a todou login (lowercased; must be
lowercase letters, digits, dashes). Accounts are matched by the IdP's
`sub` claim alone — an asserted username is a public, re-registrable
name, never proof of owning an existing account, so it never matches
one. Unknown subjects are auto-created when `auto_create` is on, with
the username as the login; a taken login (human or machine alike) gets
a random `-xxxx` suffix instead. The first created human becomes
instance admin.

### Migrating from `single` mode

The builtin account holds your history, and nothing adopts it
automatically. Hand it your IdP identity explicitly:

1. Switch `auth.mode` and sign in once — this creates a fresh account
   bound to your IdP identity.
2. Stop the server if it runs on PGlite (the data directory is
   single-process; postgres deployments can stay up).
3. `todou-server user adopt --into user --from <your-idp-username>` —
   the history account takes over the new account's subject *and*
   login; the emptied shell is renamed `…-retired-<id>` and disabled.
   Add `--keep-login` if the history account already has the login you
   want (the shell then carries a suffixed variant of it).
4. Start the server and sign in again: you are your history.

`todou-server user list` shows every binding;
`user bind-subject <login> --subject <value> [--force|--clear]` repairs
a wrong one. Switching back to single mode seeds a fresh builtin
account; it does not undo any of this.

Deployments that ran forward mode before subject keying existed carry
humans with no subject binding — those accounts will not be matched
again; bind each once with `user bind-subject <login> --subject <the
forwarded username>`.

### `forward`

Trust an authenticating reverse proxy (Authelia forward-auth,
oauth2-proxy, Tailscale serve, …) to assert the user on every request via
a header. No sessions, no cookies; logout lives in the proxy, and the web
UI hides its logout button.

```toml
[auth]
mode = "forward"

[auth.forward]
user_header = "Remote-User"          # Authelia; oauth2-proxy: "X-Auth-Request-User"
# name_header = "Remote-Name"        # optional, read only when creating the user
# email_header = "Remote-Email"
# auto_create = true
```

Two hard requirements, both enforced:

- the request must come from a peer in `http.trusted_proxies`, and
- **the proxy must strip/overwrite the identity header on every route** —
  a client that can reach the backend port directly, or a proxy that
  passes the header through, is an impersonation hole. The 401 messages
  distinguish "untrusted peer" from "header missing" to keep this
  debuggable.

Provisioning follows the same rules as oidc (subject keying, auto-create
with suffixing, first-human-is-admin): the header value doubles as the
stored subject, so renaming a login inside todou never detaches the
identity. One caveat comes with that: an ex-single-mode builtin account
is tracked by the sentinel subject `builtin`, which is also a valid
username — an upstream user literally named `builtin` would match that
account, history and admin bit included. The header namespace is the
operator's responsibility; retire or rebind the builtin account when
migrating (see the single-mode migration above).

## S3 attachment storage

Attachments and avatars default to local disk (`[storage] path`). Setting
`backend = "s3"` moves the blobs to any S3-compatible store (MinIO, AWS
S3, R2). Public URLs never change — the API still serves
`/api/projects/<slug>/attachments/<id>/download/<name>` and friends — but
downloads answer with a 302 to a short-lived presigned URL, and browsers
upload straight to the store via a presigned PUT (the multipart API stays
as the fallback and keeps old CLI binaries working).

```toml
[storage]
backend = "s3"
# path stays meaningful: it is the fs end of `storage migrate`.
path = "./data/attachments"

[storage.s3]
endpoint = "http://127.0.0.1:9000"     # server-side operations
# Browsers must reach this one; presigned signatures are host-bound.
# Empty = same as endpoint.
public_endpoint = "https://files.example.com"
region = "us-east-1"
bucket = "todou-attachments"
# key_prefix = "todou/"                # namespace inside a shared bucket
# force_path_style = true              # default; AWS virtual-host: false
access_key_id = ""                     # or TODOU_STORAGE_S3_ACCESS_KEY_ID,
secret_access_key = ""                 # or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
# presign_expiry_seconds = 300         # download redirects
# upload_expiry_seconds = 3600         # direct-upload PUT window
# request_timeout_ms = 30000
# retries = 3
```

Credentials resolve in order: `TODOU_STORAGE_S3_*` environment >
`todou.toml` > standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
(+ `AWS_SESSION_TOKEN`). The startup log names the source; the server
refuses to boot if the bucket is unreachable.

Two operational requirements:

- **Bucket CORS.** Direct uploads (PUT) and the web app's text previews
  (GET after the 302) are cross-origin requests from the browser. MinIO's
  default configuration already reflects any origin. On AWS, attach a
  CORS policy to the bucket, e.g.:

  ```json
  [{ "AllowedMethods": ["GET", "PUT"],
     "AllowedOrigins": ["https://todou.example"],
     "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"] }]
  ```

  A missing CORS policy is not an outage: clients fall back to the
  multipart upload API automatically, and plain link/image downloads
  (top-level navigations) don't need CORS at all.

- **Keep `public_endpoint` on its own origin**, not a path under the API
  host. HTML attachments are served through the sandboxed `/view` route
  either way, but a separate origin removes the whole class of
  same-origin confusion.

### Migrating existing attachments

```sh
todou-server storage migrate --to s3 --dry-run   # inventory, writes nothing
todou-server storage migrate --to s3             # idempotent, resumable
# … verify the counts, then flip backend = "s3" and restart …
```

The copy walks the databases (avatars + every project's attachments), so
it never lists the bucket; keys already present with the right size are
skipped, which makes interrupted runs safely re-runnable. The source is
never deleted. Rolling back is the same command with `--to fs` (to pick
up anything uploaded to s3 since the switch) plus flipping
`backend = "fs"` back.

### Reaping abandoned direct uploads

A direct upload that is requested but never completed leaves an object
with no attachment row. Every issued upload is recorded in the database,
so cleanup is database-driven:

```sh
todou-server storage gc --dry-run    # list what would be reaped
todou-server storage gc              # delete orphans older than expiry+24h
```

Run it ad hoc or from a timer; `--min-age <hours>` widens the safety
margin past the presign expiry.
