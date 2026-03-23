# CLAUDE.md

## Overview

SushiRoad is a web-based reservation and wait-time monitoring tool for Sushiro Taiwan (壽司郎). It reverse-engineers the official mobile app's API to provide store browsing, smart reservation, and ntfy.sh-based push notifications.

## Tech Stack

- **Backend**: Node.js + Express (`server.js`, port 3737)
- **Frontend**: Vanilla HTML/CSS/JS (no framework, `public/` directory)
- **API**: Proxies to Sushiro CRM at `https://crm-tw.akindo-sushiro.co.jp/api/2.0`
- **Push**: ntfy.sh JSON API for monitoring notifications
- **Deployment**: systemd (`sushiroad.service`) + Cloudflare Tunnel

## Build & Run

```bash
npm install
npm start        # production
npm run dev      # development (--watch)
```

No build step. No tests. Static files served directly by Express.

## Key Architecture Decisions

### Authentication
- Sushiro API uses HTTP Basic Auth with format `email@TW:password` (region appended to username)
- Login endpoint uses `application/x-www-form-urlencoded` (not JSON)
- Region is uppercase `TW`
- User-Agent must be `Dart/3.6 (dart:io)` to match the Flutter app

### Reservation Flow
- Uses `/remote_auth/newreservation` (not `/remote/newticket` which requires app-level device registration)
- Sushiro server has a bug: `newreservation` returns E010 even on success — we verify via `opentickets` endpoint
- Check-in code = last 4 digits of `ticketId`
- Time slots use `yyyyMMdd` date format and `HHmmss` time format

### Monitoring
- Monitors are in-memory (Map), not persisted
- Each monitor polls store wait time at configurable intervals (30-300s)
- Notification logic: `wait=0` → "go eat directly", `wait>0 && now+wait≈target` → "go take ticket"
- ntfy.sh notifications use JSON API to support UTF-8 titles

### Security
- Per-IP login rate limiting (5/min)
- Monitor endpoints require sessionId ownership
- ntfyTopic validated with regex `^[a-zA-Z0-9._-]{1,64}$`
- Max 3 monitors per session
- URL params validated with strict integer regex
- Session cleanup cancels orphan monitors

## File Structure

```
server.js          # Express backend (API proxy + monitoring)
public/
  index.html       # Main UI (tabs: stores, history, monitor, settings)
  app.js           # Frontend logic
  style.css        # Styles (mobile-first)
package.json
```

## Sushiro API Reference

Base URL: `https://crm-tw.akindo-sushiro.co.jp/api/2.0`

- `GET /info/storelist?guid=<uuid>&region=TW` — All stores with wait times
- `GET /info/reservationtimeslots?storeid=<id>&numpersons=<n>&guid=<uuid>&tabletype=T&region=TW` — Available slots
- `POST /remote/login` (form-urlencoded) — Login
- `POST /remote_auth/newreservation` (JSON + Basic Auth) — Create reservation
- `GET /remote_auth/opentickets?region=TW` (Basic Auth) — Active tickets/reservations
- `POST /remote_auth/cancel` (JSON + Basic Auth) — Cancel reservation

### Known API Quirks
- `newreservation` returns E010 (HTTP 500) even on success — must verify via `opentickets`
- `newticket` (v2.0) requires hidden device registration via compiled Dart code — unusable from web
- `newticket` (v1.0 at `/api/1.0/`) works but creates tickets in a legacy queue that stores don't call
- `tabletype` valid values: `T` (table), `C` (counter), `P` (pair)
- `seatconfig` date format: `yyyyMMdd` (not `yyyy-MM-dd`)
