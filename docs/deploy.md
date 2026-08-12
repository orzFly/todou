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
The session cookie is `HttpOnly; SameSite=Lax` and carries no `Secure` flag,
so it works over both HTTP and HTTPS.

For SSE (`/api/projects/:slug/events`), response buffering must be off.
Traefik and Caddy stream by default; nginx needs `proxy_buffering off`.
