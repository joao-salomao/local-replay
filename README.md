# Local Replay

A local sports instant-replay system for personal (hobby) use on a court: ordinary phones become
cameras connected to a server on the local network. After a play happens, anyone presses
**GRAVAR** (record) and gets a combined video of the angles in the gallery — ready to watch,
download, and share. Everything runs on the local network, with no dependency on the internet
during use (only when building the Docker image).

## Table of Contents

- [Requirements](#requirements)
- [Getting Started](#getting-started)
- [How to Use](#how-to-use)
- [Connecting Each Device](#connecting-each-device)
- [Configuration](#configuration)
- [Running on the Internet (Behind a Proxy)](#running-on-the-internet-behind-a-proxy)
- [Development](#development)
- [Court Checklist](#court-checklist)
- [Performance Note](#performance-note)
- [Data Structure](#data-structure)
- [Troubleshooting](#troubleshooting)

## Requirements

- **Docker** (recommended) — Docker Desktop, OrbStack, or any engine compatible with
  `docker compose`. That's all you need — the container already includes Bun, FFmpeg, and
  OpenSSL.
- **Or, to run without a container:** [Bun](https://bun.sh) 1.x + `ffmpeg` + `openssl` on the
  machine's PATH.
- A Mac (or another machine) on the same Wi-Fi network as the phones that will be filming.

## Getting Started

```bash
./start.sh
```

The script detects your machine's IP on the local network, brings up `docker compose` (building
the image the first time) and prints the entry URL in the terminal along with a **QR code**. Point
each phone's camera at the terminal's QR code (or type the URL manually) to open the system.

On the **first run**, the server automatically generates an access password and saves it to
`data/config.json`; the password is also printed in the terminal along with the URL, right below
the QR code. Save it — it doesn't change between restarts, it's only generated once. If you need
to see it again later: `docker compose logs replay | grep Senha`, or open `data/config.json` and
read the `"password"` field.

To stop: `Ctrl+C` in the terminal where `start.sh` is running, or `docker compose down` in another
terminal. The data (config, certificate, clips) is persisted in `./data` on the host thanks to the
volume in `docker-compose.yml` — starting it up again with `./start.sh` doesn't lose anything.

## How to Use

After opening the URL, each device enters the password and picks a role:

- **📷 Ser câmera** (Be a camera) — turns the phone into a fixed camera. Give the angle a name —
  e.g. "Fundo" (back) or "Lateral rede" (net side) — mount the phone on a tripod, **keep it
  plugged in**, and keep the page in the foreground for the whole session (the page shows a
  warning and recovers the buffer on its own if the tab is hidden or the operating system pauses
  the camera in the background).
- **🔴 Controlar gravação** (Control recording) — the control page: a big **GRAVAR** button, a
  clip duration selector (10/20/30/45/60s), a list of the cameras online with each one's live
  resolution/fps, the status of the last play (capturando → processando → pronto — capturing →
  processing → ready), and a QR code for other devices to join. It can be used by any
  authenticated phone or by a dedicated tablet.
- **🎬 Ver lances** (View plays) — the gallery (`/clips`): lists the most recent clips first, with
  a player, download links (combined + each individual angle), a **📤 Compartilhar** (Share)
  button (opens the phone's native share menu, with a fallback to download on browsers without
  that API), and a QR code per clip pointing straight to the video file.

**Flow of a play:** the cameras stay connected, filming and buffering the last few seconds
locally. When someone presses GRAVAR on `/control`, the server records the instant `T`, creates a
job, and notifies every camera that's online. Each camera finishes the segment in progress and
sends the buffer files covering the window `[T − duration, T]`. The server waits for the uploads
(up to 30s — whoever doesn't deliver in time is left out of the play, which still comes out with
the remaining angles), processes them with FFmpeg (exact cut, normalization, combining the
angles), and the clip appears in `/clips`; `/control` shows "Lance pronto" (Play ready).

## Connecting Each Device

The HTTPS certificate is self-signed (required for the browser camera to work), so each device
needs to accept a security warning once.

**iPhone (use Safari):**
1. Open the URL in Safari and tap "Continuar" (Continue) — or "Avançado → Visitar este site"
   (Advanced → Visit this website) — on the security warning.
2. If the page loads but the real-time connection (WebSocket) doesn't complete — camera stuck on
   "Desconectado" (Disconnected) — the browser warning wasn't enough. Download the certificate at
   `/cert` — there's a shortcut right on the login screen, under "Problemas para conectar no
   iPhone?" (Trouble connecting on iPhone?) — and install it: go to **Ajustes → Geral → VPN e
   Gerenciamento de Dispositivo** (Settings → General → VPN & Device Management) and install the
   downloaded profile, then go to **Ajustes → Geral → Sobre → Confiança de Certificado** (Settings
   → General → About → Certificate Trust Settings) and enable trust for the certificate.

**Android (use Chrome):** tap **"Avançado → Continuar"** (Advanced → Continue) on the browser
warning. That's already enough, including for the WebSocket.

**On both devices:**
- Turn off battery saving/optimization for the browser during the session — it can suspend the
  page and kill the camera.
- Keep the phone plugged in and in the shade: prolonged heat drops the fps and capture quality on
  both platforms.
- 60fps is the browser's **best effort** — several devices (including iPhones) deliver 30fps even
  when 60 is requested as the ideal. The `/camera` page shows the actual resolution/fps obtained,
  updated every 5s; the server's final output is conformed to the target resolution/fps (default
  1080p60, adjustable via `targetHeight`/`targetFps`) regardless of the source.

## Configuration

Editable in `data/config.json` on the host (stop the container, edit it, start it again — the
file is only read on startup, except for `clipDurationSeconds`, which can also be changed live via
the selector in `/control`, without touching the file or restarting):

| Key | Default | Description |
|---|---|---|
| `clipDurationSeconds` | `20` | Clip duration (seconds) used for the **next** play. Also adjustable live in `/control`. |
| `clipDurationMaxSeconds` | `60` | Ceiling accepted for `clipDurationSeconds` (the server rejects higher values). |
| `bufferCycleMinSeconds` | `30` | Minimum duration of each camera's buffer cycle. The actual cycle used is `max(bufferCycleMinSeconds, clipDurationSeconds)`. |
| `layout` | `"sequential"` | `"sequential"` (angles in sequence, hard cut) or `"side-by-side"` (angles side by side on screen, audio from the first angle). |
| `targetHeight` | `1080` | Target height (px) of the normalized output. |
| `targetFps` | `60` | Target FPS of the normalized output. |
| `retentionDays` | `null` | Days to keep clips. `null` = keep everything forever. If set, cleanup runs on startup and then once a day. |

The file also stores `password` (generated automatically on first boot — see
[Getting Started](#getting-started)).

**Environment variables** (already configured by `docker-compose.yml`/`start.sh`; only touch these
if you plan to run outside Docker or change the default ports):

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `data` | Folder where `config.json`, `certs/`, and `clips/` live. |
| `HTTPS_PORT` | `8443` | HTTPS port — this is the system's entry port. |
| `HTTP_PORT` | `8080` | HTTP port; only responds with a 301 redirect to HTTPS. |
| `HOST_LAN_IP` | *(empty)* | IP of the machine on the local network, used in the certificate (SAN) and in the URL printed on boot. `start.sh` already detects and injects this value on its own. |

## Running on the Internet (Behind a Proxy)

By default, Local Replay runs in **LAN mode** (everything above): self-signed HTTPS, designed for
use within a court's Wi-Fi network. If you want to expose the system to the internet — for
example, for an event where not everyone can get on the same network — you can run it in **proxy
mode**: Bun serves plain HTTP on an internal port, and a reverse proxy in front (Caddy, nginx,
Cloudflare Tunnel, etc.) handles TLS with a real certificate.

**Proxy mode environment variables** (in addition to the ones above; `HTTPS_PORT`/`HTTP_PORT`/
`HOST_LAN_IP` from the table above are ignored in this mode):

| Variable | Default | Description |
|---|---|---|
| `BEHIND_PROXY` | *(empty)* | Enables proxy mode when set to `1`, `true`, or `yes` (case-insensitive; e.g., `BEHIND_PROXY=1`) — any other value, including empty, `false`, or `0`, keeps the default LAN mode. In this mode, self-signed certificate generation and the HTTP→HTTPS redirect are turned off; the server instead listens for plain HTTP on `PORT`. |
| `PUBLIC_URL` | *(empty)* | Public address served by the proxy (e.g., `https://replay.exemplo.com`), used in the boot message and the terminal's QR code. **If not set, the server still boots, but warns in the terminal** that the QR code/link will point to `localhost` and won't work on players' devices. |
| `PORT` | `8080` | Plain HTTP port the app listens on, for the proxy to forward requests to. |

With `BEHIND_PROXY` enabled, the IP used to rate-limit login attempts comes from the
`X-Forwarded-For` header — the **last** entry in the list, not the first, since that's the one
that reflects the peer observed directly by the edge proxy; earlier entries come from the client
itself and can be forged — instead of the socket's IP (in this mode the socket always belongs to
the proxy, not the client). Any common reverse proxy already sets this header to the client's real
IP by default (see the Security Note below for the care needed around the `PORT` port).

### Example with Caddy

[Caddy](https://caddyserver.com) automatically provisions a Let's Encrypt certificate for the
configured domain and already forwards WebSocket traffic with no extra configuration (unlike
nginx, which requires the `Upgrade`/`Connection` headers to be set manually). A minimal
`Caddyfile`:

```
replay.exemplo.com {
    reverse_proxy localhost:8080
}
```

Start the app with `BEHIND_PROXY=1 PUBLIC_URL=https://replay.exemplo.com PORT=8080` in the
environment (see the Docker note below) and run Caddy on the same machine (or in a container
alongside it) pointing to that same port.

### Docker

In `docker-compose.yml`, publish only the HTTP port (the proxy is what's public, not the app) and
pass the three variables to that service:

```yaml
services:
  replay:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data
    environment:
      - BEHIND_PROXY=1
      - PUBLIC_URL=https://replay.exemplo.com
      - PORT=8080
    restart: unless-stopped
```

### Security Note

To be honest: the only obstacle between a stranger on the internet and this system's
cameras/clips is the **shared password** stored in `data/config.json`. There's no per-person
account, invite, or allow-list — whoever has the password (or manages to guess it) sees
everything. That's acceptable for home use on a closed network (LAN mode), but exposing it to the
internet changes the risk calculus. Minimum recommendations before exposing it publicly:

- Replace the auto-generated password with a strong one (edit the `password` field in
  `data/config.json` before starting it up, or stop the container, edit it, and start it again).
- Serve **only** HTTPS — that's exactly what the proxy from the section above already guarantees;
  don't expose the `PORT` port (plain HTTP) directly to the internet, only the proxy should be
  public.
- The login rate limit trusts the **last** entry of `X-Forwarded-For` (the peer observed directly
  by the edge proxy) — safe with Caddy (discards the XFF received from the client), nginx
  (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, which only appends), and
  Cloudflare (same, append-only). This is only safe if the `PORT` port isn't exposed directly to
  the internet (bullet above) — otherwise a client could talk directly to the app and forge the
  XFF freely.
- For a private event, also consider restricting by IP up front, in the proxy — for example, in
  Caddy, with a `remote_ip` matcher blocking anyone not on the expected list — instead of relying
  on the password alone.

The LAN mode instructions (local network, no proxy) still apply as normal and remain the default
with no new variables — see [Getting Started](#getting-started) and
[Configuration](#configuration). Proxy mode is opt-in only, via `BEHIND_PROXY`.

## Development

```bash
bun install       # installs dependencies
bun run dev       # starts the local server (bun run src/server/index.ts) — requires ffmpeg/openssl on PATH
bun test          # runs the unit + integration suite (tests/unit and tests/integration)
bun run test:e2e  # Playwright: full flow in a Chromium browser with a fake camera
bun run format    # applies Biome formatting to the project (biome format --write .)
```

> **Honest note about e2e:** `bun run test:e2e` needs a real Chromium browser that can complete
> fake media capture via `--use-fake-device-for-media-stream` — this works reliably on standard
> Linux CI (e.g., GitHub Actions `ubuntu-latest`), but not every sandboxed/headless environment
> can complete this camera handshake (observed in some macOS sandboxes). If `#conn-text` gets
> stuck on "Desconectado" and the test times out at the camera step, that's this environment's
> limitation — not a bug in the app. Run it on a machine/CI where the fake camera is actually
> granted, to validate the end-to-end flow.

## Court Checklist

Manual validation recommended before relying on the system for a real game:

- [ ] 2 phones (cameras) plugged in
- [ ] Wake lock active on each camera — screen on, not dimming during the session
- [ ] 5 plays recorded in a row
- [ ] Check all 5 in the gallery (`/clips`) — combined + individual angles open and play
- [ ] Wi-Fi drop test on one camera: turn off Wi-Fi on one device mid-session, confirm it
      disappears from the list in `/control`, and that a play recorded during that gap still comes
      out (with the remaining angle); turn Wi-Fi back on and confirm the camera reconnects on its
      own

## Performance Note

Inside Docker on a Mac, FFmpeg encodes **in software** — Docker's Linux VM can't access the Apple
Silicon media engine. At 1080p60, a play with 2 angles × 20s takes about **30–60s** to process. If
you need more speed, run outside the container: native `bun run dev` (with Homebrew's `ffmpeg`,
which uses VideoToolbox) is **5–10× faster** — the behavior is identical in both modes, only the
encoding speed changes.

## Data Structure

Everything under `data/` (a volume mapped by `docker-compose.yml`; no database):

```
data/
├── config.json           # password, clip duration, layout, target resolution/fps, retention
├── session-secret        # key used to sign the session cookie
├── certs/                 # self-signed certificate (generated on first boot; regenerated if HOST_LAN_IP changes)
│   ├── cert.pem
│   └── key.pem
└── clips/2026-07-17/clip-042/
    ├── combined.mp4
    ├── angle-fundo.mp4     # angle name comes from the nickname given on the camera (slugified)
    ├── angle-lateral.mp4
    └── meta.json           # T, window, cameras, layout, duration, partial errors
```

## Troubleshooting

| Situation | Expected behavior |
|---|---|
| Camera loses Wi-Fi / tab suspended | Disappears from the list in `/control` within ~10s (heartbeat every 3s, considered offline after 10s with no signal); when it comes back, it reconnects and restarts its buffer on its own |
| GRAVAR with no camera online | Button is disabled, with a warning |
| One camera's upload fails | 3 attempts with backoff; the play still closes with whichever angles arrived within the 30s timeout |
| FFmpeg fails on one angle | Publishes the angles that succeeded; error logged in `meta.json` and in the server log |
| Disk has less than 5 GB free | Warning appears in `/control` and `/clips` |
| Double-tap on GRAVAR | 2s server-side cooldown prevents a duplicate play |
