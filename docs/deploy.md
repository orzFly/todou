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
migrations explicitly with `todou-server migrate`.

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

Login maps the `login_claim` value to a todou login (lowercased; must be
lowercase letters, digits, dashes). Unknown identities are auto-created
when `auto_create` is on; a matching existing login that was never bound
to an IdP subject is adopted instead — including the single-mode builtin
account, which is the migration path: rename the builtin user's login to
your IdP username BEFORE switching modes, and your first oidc login
inherits the full history. The first created human becomes instance admin.
Switching back to single mode seeds a fresh builtin account; it does not
un-adopt.

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

Provisioning follows the same rules as oidc (auto-create, login adoption,
first-human-is-admin), keyed by the header value as the login.
