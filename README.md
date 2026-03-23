# SushiRoad 🍣

A web-based reservation and wait-time monitoring tool for **Sushiro Taiwan (壽司郎)**, reverse-engineered from the official mobile app's API.

## Features

- **Store Browser** — Browse all 56 Taiwan Sushiro locations with real-time queue status, geolocation-based distance sorting, and search
- **Smart Reservation** — Input your desired dining time; the system checks for available slots within ±15 minutes and lets you pick one, or falls back to monitoring mode
- **Wait-Time Monitoring** — When no reservation slot is available, monitors the store's queue in real-time and sends a push notification via [ntfy.sh](https://ntfy.sh) when it's the optimal time to take a ticket in the app
- **Reservation Management** — View reservation history, check-in codes, and cancel reservations from the web interface

## How It Works

```
User selects store + time
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
                      │
                      ▼
              wait + now ≈ target?
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
- **API endpoint discovery** from `environment.json` and `environment_new.json` embedded in the Flutter assets
- **Authentication format** discovered via mitmproxy traffic capture on a rooted Android device:
  - Login: `POST /remote/login` with `application/x-www-form-urlencoded` body
  - Basic Auth: `email@REGION:password` (not just `email:password`)
  - Region code is uppercase (`TW`)
- **Reservation API**: `POST /remote_auth/newreservation` with Basic Auth + JSON body including `date`, `time`, `end` fields
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
- **Push Notifications**: [ntfy.sh](https://ntfy.sh) (JSON API)
- **Deployment**: systemd service + Cloudflare Tunnel
- **Platform**: Raspberry Pi 5

## Setup

```bash
npm install
npm start
```

Environment: Node.js 20+

The service runs on port 3737 by default (`PORT` env var to override).

### Cloudflare Tunnel

The service is exposed via Cloudflare Tunnel. Add to `/etc/cloudflared/config.yml`:

```yaml
- hostname: sushiroad.your-domain.com
  service: http://localhost:3737
```

### ntfy.sh Setup

1. Install the [ntfy app](https://ntfy.sh) on your phone
2. Subscribe to a topic (e.g., `my-sushiro-alerts`)
3. Enter the same topic name in SushiRoad's Settings page

## Limitations

- **"Go Now" (立即前往)** ticket creation via `/remote/newticket` requires a hidden device registration flow embedded in the Flutter app's compiled Dart code (BoringSSL with stripped symbols). This endpoint cannot be called from outside the app. The web service uses `newreservation` instead.
- Reservations book a specific time slot (earliest usually 60-90 min away), unlike "Go Now" which joins the live queue immediately.
- Cancel from web only — tickets created via web cannot be cancelled from the mobile app (different device GUID).

## License

ISC
