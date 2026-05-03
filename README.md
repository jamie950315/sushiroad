# SushiRoad 🍣

A web-based reservation and wait-time monitoring tool for **Sushiro Taiwan (壽司郎)**, reverse-engineered from the official mobile app's API.

## Features

- **Store Browser** — Browse all 56 Taiwan Sushiro locations with real-time queue status, geolocation-based distance sorting (auto-saved), and search
- **Smart Reservation** — Input your desired dining time; the system checks for available slots within ±15 minutes and lets you pick, or falls back to monitoring mode
- **Wait-Time Monitoring** — When no reservation slot is available, monitors the store's queue in real-time and sends a push notification via [ntfy.sh](https://ntfy.sh) when it's the optimal time to take a ticket in the app
- **Cross-Device Account Sync** — Active reservations, monitors, and user settings are tied to the logged-in Sushiro account, so another device signed into the same account can view, cancel, and reuse the same configuration
- **Shared Monitor Polling** — Active monitors share one store-list fetch per 30 seconds to reduce external API traffic
- **Configurable Timing** — Set how many minutes early or late you're willing to arrive
- **Auto-Setup** — ntfy topic auto-generated from your email on login; geolocation persisted across sessions

## How It Works

```
User selects store + time (e.g. 14:30)
        │
        ▼
┌─────────────────────┐
│ Check available      │
│ slots (±15 min)      │
└─────────┬───────────┘
          │
    ┌─────┴─────┐
    │           │
  Exact     Nearby slots
  match     found (±15min)
    │           │
    ▼           ▼
 Reserve    Show picker
 directly   (user chooses)
                │
          ┌─────┴─────┐
          │           │
        Pick slot   No slots
          │           │
          ▼           ▼
       Reserve    Start monitor
                      │
                      ▼
              Poll wait time
              every 30-120s
              (shared cache)
                      │
                      ▼
              wait + now ≈ target?
              (configurable window)
                      │
                 ┌────┴────┐
                 │         │
              wait=0    wait>0
                 │         │
                 ▼         ▼
           "No queue,  "Go take a
            go eat!"    ticket now!"
                 │         │
                 └────┬────┘
                      ▼
               ntfy.sh push
               notification
```

## Reverse Engineering

The Sushiro CRM API was reverse-engineered from the official Flutter/Dart mobile app (`tw.co.akindo_sushiro.sushiroapp`):

- **APK decompilation** via jadx to extract environment configs and API endpoint definitions
- **Authentication format** discovered via mitmproxy traffic capture on a rooted Android device:
  - Login: `POST /remote/login` with `application/x-www-form-urlencoded` body
  - Basic Auth: `email@REGION:password` (not just `email:password`)
  - Region code is uppercase (`TW`)
- **Reservation API**: `POST /remote_auth/newreservation` with Basic Auth + JSON body
- **Check-in code**: Last 4 digits of `ticketId`

### API Endpoints Used

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /info/storelist` | None | List all stores with queue status |
| `GET /info/reservationtimeslots` | None | Available reservation time slots |
| `POST /remote/login` | Body (form) | Authenticate user |
| `POST /remote_auth/newreservation` | Basic Auth | Create reservation |
| `GET /remote_auth/opentickets` | Basic Auth | Check active reservations |
| `POST /remote_auth/cancel` | Basic Auth | Cancel reservation |
| `GET /remote/groupqueues` | None | Queue numbers for a store |

## Tech Stack

- **Backend**: Node.js + Express (port 3737)
- **Frontend**: Vanilla HTML/CSS/JS (mobile-first UI)
- **Storage**: Lightweight local JSON database for account-scoped monitors and reservation metadata
- **Push Notifications**: [ntfy.sh](https://ntfy.sh) (JSON API for UTF-8 support)
- **Deployment**: systemd service + Cloudflare Tunnel
- **Platform**: Raspberry Pi 5

## Setup

```bash
npm install
npm start
```

Environment: Node.js 20+. Runs on port 3737 by default (`PORT` env var to override).

### ntfy.sh Setup

1. Install the [ntfy app](https://ntfy.sh) on your phone
2. Login to SushiRoad — a topic is auto-generated from your email
3. Subscribe to that topic in the ntfy app (shown in Settings)
4. You can customize the topic name in Settings

### Cloudflare Tunnel

Add to `/etc/cloudflared/config.yml`:

```yaml
- hostname: sushiroad.your-domain.com
  service: http://localhost:3737
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| ntfy Topic | `{email-prefix}-sushiroad` | Auto-generated on login, customizable |
| 允許提早 | 10 min | How many minutes early is acceptable |
| 允許遲到 | 5 min | How many minutes late is acceptable |
| 監控間隔 | 60s | How often to check wait times |
| 店鋪刷新 | 60s | How often to refresh store list |
| 地理位置 | Auto-saved | GPS coordinates persisted across sessions |

When logged in, settings are synced by Sushiro account. Before login, the browser keeps local settings and uploads them to the account on first sync.

Runtime account data is stored server-side in `data/sushiroad.db.json` by default. Override with `SUSHIROAD_DB=/path/to/file.json` if needed.

## Limitations

- **"Go Now" (立即前往)** ticket creation via `/remote/newticket` requires a hidden device registration flow embedded in the Flutter app's compiled Dart code (BoringSSL with stripped symbols). This endpoint cannot be called from outside the app. The web service uses `newreservation` instead.
- Reservations book a specific time slot (earliest usually 60-90 min away), unlike "Go Now" which joins the live queue immediately.

## License

ISC
