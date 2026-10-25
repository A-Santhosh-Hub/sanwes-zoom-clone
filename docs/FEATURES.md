# SanWe's feature guide (long version)

The short version is in the [README](../README.md). Paths below are relative to the project root.

Group voice/video calls and screen sharing in the browser. Built from scratch on
WebRTC via [LiveKit](https://livekit.io) (open-source SFU, Apache-2.0) - scales past 4 people.

## Start, stop and check (Windows)
Double-click these in the project folder:
- `start-sanwes.bat`: starts the media server and the app, **checks that everything works**, and opens the browser. Safe to run again (it never starts duplicates). If your PC's network address changed since last time, it fixes `LIVEKIT_URL` in `.env` for you (the old file is saved as `.env.bak`).
- `start-sanwes-with-tunnel.bat`: the same, plus an internet tunnel (needs `cloudflared`) and prints its address.
- `status-sanwes.bat`: checks whether it is running and healthy; starts nothing.
- `stop-sanwes.bat`: stops the app and the media server. Tunnels you started yourself are left alone; add the word `tunnel` to stop them too.

## Run
```powershell
npm run setup        # once: installs server + client deps
npm run media        # terminal 1: LiveKit media server (bin\livekit-server.exe, port 7880)
npm start            # terminal 2: builds client, serves http://localhost:3000
```
Open http://localhost:3000, enter a name and room, share `http://localhost:3000/?room=<name>` to invite.
Camera/mic/screen capture need `localhost` or HTTPS.

## Layout
- `server/index.js`  - Express: `POST /api/token` (LiveKit join token) + serves `client/dist`
- `server/limiter.js` - tiny in-memory rate limiter used by the token endpoint
- `client/`          - Vite + livekit-client UI (join screen, tile grid, mic / camera / screen share, pin/focus view, chat, device pickers, reconnect handling)
- `deploy/`          - `Caddyfile` (HTTPS + wss on one host) and `livekit.prod.example.yaml` (external IP + TURN)
- `livekit.yaml`, `.env` - local dev keys (generated; `.env` is gitignored)
- `bin/livekit-server.exe` - LiveKit v1.13.10 (sha256 verified)

## Features
- **Layout:** the gallery picks the column count that gives the biggest 16:9 tiles, so 4-25+ people fit without a fixed grid. Screen shares auto-focus; use **Pin / Unpin** on any tile (or double-click it) to put it on the stage, **Gallery view** to go back.
- **Chat:** text chat over LiveKit data messages (reliable, topic `sanwes.chat`). It is ephemeral: late joiners do not see earlier messages.
- **Devices:** *Devices* button switches mic, speaker (Chromium only) and camera live; choices are remembered per browser.
- **Reconnect:** short network drops are handled by LiveKit (banner shown). If the session is lost, the client re-fetches a token and rejoins automatically (up to 6 tries with backoff, or immediately when the browser comes back online); mic/camera state is restored, screen share is not.

## Home, scheduling and joining
The home screen has **Meet**, **Join**, **Schedule**, **Share** and **Game room** tiles, an upcoming-meetings card, and a **Meetings** page with a calendar and agenda. **Schedule** saves a meeting (topic, time zone, repeat, invitees, passcode, waiting room, mute on entry, join before host) to `data/meetings.json`, gives you an invitation to copy, and can add it to Google Calendar or download an `.ics` file. Share the link or the meeting ID and passcode; guests who arrive early wait on a "meeting has not started" screen. Every browser has a **Personal Meeting ID**. There are no accounts: your name and a private key are stored in this browser, so use the same browser to manage your meetings.

## Accounts (sign in first)

Everyone creates an account (username, password twice, email twice) before joining, creating or scheduling a meeting. Accounts are
stored on the computer that runs SanWe's. **The first account created is the administrator**, so create yours before sharing the
link. The meeting's creator is its host; hosts can make co-hosts, and these roles follow accounts. Details and recovery:
[docs/ACCOUNTS.md](docs/ACCOUNTS.md); how Zoom's sign-in works and what was taken from it: [docs/ZOOM_ACCOUNTS_REPORT.md](docs/ZOOM_ACCOUNTS_REPORT.md).

## Class tasks (classes that start, play videos and record by themselves)
Double-click `install-autostart.bat` once and SanWe's starts hidden every time you sign in to Windows, so the day's classes open, play and record without anyone running anything.
Schedule a class once (More Options > **Class automation**) and it repeats: at the start time the room opens with you as host, the picked
teachers become **co-host automatically** when they join, a hidden "class bot" plays your **waiting-room and prayer videos** on a timeline
and **records the class** when the teacher starts speaking. A line under each class in Meetings shows its state with buttons (start now,
stop video, record). Recording protection: watermark with each student's name, or **SanWe's Viewer** (Windows hides its window from
screen recorders). `make-copy-for-another-pc.bat` makes a copy for another computer without your accounts or keys. See [docs/CLASS_TASKS.md](docs/CLASS_TASKS.md) and
[docs/ZOOM_CAPTURE_PROTECTION_REPORT.md](docs/ZOOM_CAPTURE_PROTECTION_REPORT.md).

## Classroom tools (found with REA in Zoom's web client)
**More** menu: **Polls** (quizzes too), **Q&A**, **Breakout rooms**, **Captions**; chat has a paperclip for **files**; People menu: **Spotlight**, **Ask to unmute**, **Allow to talk**, **Lower hand**. Press and hold SPACE to talk while muted.
See [docs/ZOOM_WEB_REPORT.md](docs/ZOOM_WEB_REPORT.md) for what Zoom has and what is still missing.

## SanWe's Studio (desktop app, recommended for the host)

An `.exe` that runs everything on your computer, opens the meeting in its own window, makes the public link for guests and
**records the meeting window with its sound** (MP4 picture + sound, plus a sound-only M4A). Build it with
`build-sanwes-studio.bat`, open it with `start-sanwes-studio.bat`. Details: [docs/STUDIO.md](docs/STUDIO.md).

## Game Hub (stream a game, let a viewer play)
A streamer plays a game; viewers watch and can ask to play with a **keyboard, mouse or gamepad**, or from a **phone with an on-screen controller**. The streamer allows each person, chooses the window they may control, and can cut everyone off with Ctrl+Alt+Shift+F12. Uses the free ViGEmBus driver for virtual Xbox pads. Guide, safety, speed measurements and what was not tested: [docs/GAME_HUB.md](docs/GAME_HUB.md); what was learned from UltraViewer and AnyDesk (PC and Android): [docs/REMOTE_CONTROL_REPORT.md](docs/REMOTE_CONTROL_REPORT.md). Build the input helper once with `desktop\inputuild-input.bat`.

## Meeting features (Zoom-style)
Create a room (any type) with an optional **waiting room** and **passcode**. Starting or joining shows a **preview window** (camera, microphone, backgrounds) first. The meeting window has a Zoom-style layout: bottom toolbar (**Audio**, **Video**, **Participants**, **Chat**, **React**, **Share**, **Host tools**, **More**, **End**), a meeting-info popup, a **Participants** panel with per-person menus, **Host tools** switches (waiting room, who can share, who can chat, lock), and a **View** menu (Standard with the people strip on top, Side-by-side, Speaker, Gallery, sort, hide self view, hide non-video, swap video and shared screen, meeting timer, fullscreen). Meetings you were in appear under **Recent** on Home. **Reminders:** scheduled meetings remind you (a card with Start / Snooze, a chime, a desktop notification when the tab is in the background); choose the defaults in Settings > General or per meeting in the schedule dialog. **Host tools** opens in pages (waiting room, lock, hide profile pictures; Participants: suspend activities and who may chat, rename, unmute, start video or record; Advanced: share rules and whiteboard). **More** has **Record** (saved on your computer as MP4 / M4A: video with sound, video only, audio only, or a sound file per person; everyone is told), **Whiteboards** (shared drawing board), Meeting info, Invite and **Settings**. Chat can go to everyone or to one person, and can be saved. Profile pictures can be hidden by the host. Hosts can mute one person or everyone, make **co-hosts**, remove people, lock the meeting, admit or deny waiting guests, and **end the meeting for all**. Everyone can **raise a hand**, send **reactions**, copy an **invite link**, blur or replace their **camera background** (runs locally; the model is served from `client/public`), and use AI noise suppression. **Large meetings:** up to 500 people in one room (`MAX_PARTICIPANTS`), with a paged gallery and selective subscriptions; measurements, hardware and bandwidth limits are in [docs/LARGE_MEETINGS.md](docs/LARGE_MEETINGS.md). See [docs/ZOOM_FEATURE_MAP.md](docs/ZOOM_FEATURE_MAP.md) for how each feature works, what is done and what is planned.

## Live room list (demo convenience)
The join screen lists rooms that have people in them (`GET /api/rooms`, refreshed every 3 s); one click joins with your saved name, or a random `Guest-123` name if none is set. Password-protected rooms show a lock and ask for the password. Anyone who can reach the server can see room names, so set `ROOM_LIST=off` in `.env` to hide the list. `LIVEKIT_API_URL` (default `http://127.0.0.1:7880`) is where the Node server reaches LiveKit.

## Token endpoint hardening (`POST /api/token`)
Configure in `.env` (see `.env.example`):
- `JOIN_PASSWORD` / `ROOM_PASSWORDS` - optional shared or per-room passwords (constant-time compare). The join form shows a password box when the server asks for one.
- Rate limits - `TOKEN_RATE_MAX` requests/min/IP (default 20) and `PASSWORD_FAIL_MAX` wrong passwords/10 min/IP (default 5), both answered with `429` + `Retry-After`.
- `TOKEN_TTL` - join token lifetime, default `1h` (was 6h). Connected users are refreshed by LiveKit; the client fetches a fresh token whenever it rejoins.
- `LIVEKIT_URL` check - the server refuses to hand out a token when `LIVEKIT_URL` is loopback but the page was opened from another host, or when the page is HTTPS and `LIVEKIT_URL` is plain `ws://`, and tells you what to change.
- `TRUST_PROXY` - defaults to `loopback` so the real client IP is used behind a local Caddy.
Rooms are not password protected unless you set one of the passwords above; there are no user accounts.

## Using it from other devices / the internet
- LAN: use `http://<your-ip>:3000` for the app, set `LIVEKIT_URL=ws://<your-ip>:7880` in `.env`,
  and allow ports 3000, 7880, 7881/tcp and 7882/udp in Windows Firewall. Browsers only
  allow screen capture on HTTPS or localhost, so for non-localhost use put both behind HTTPS (e.g. Caddy).
- Internet: also set `rtc.use_external_ip: true` in `livekit.yaml` and add a TURN server (coturn or LiveKit's built-in `turn:` block).

## HTTPS, LAN and TURN
Screen capture and (off-localhost) camera/mic need HTTPS. The simplest setup is Caddy in front of both the app and LiveKit signalling:
1. Install [Caddy](https://caddyserver.com), then `$env:SANWES_HOST = "<lan-ip-or-dns-name>"; caddy run --config deploy\Caddyfile`.
2. In `.env`: `LIVEKIT_URL=wss://<same host>/lk` (the Caddyfile strips `/lk` and proxies to port 7880).
3. LAN/IP hosts use Caddy's internal CA: run `caddy trust` on the server and install `root.crt` on other devices. A real DNS name gets a Let's Encrypt cert if you delete `tls internal`.
4. Media bypasses Caddy: allow `7881/tcp` and `7882/udp` to the LiveKit server. Copy the relevant parts of `deploy/livekit.prod.example.yaml` into `livekit.yaml` (`use_external_ip` for internet, or `node_ip` for LAN).
5. Internet/strict networks: enable the built-in TURN block in that example (needs a DNS name + cert; open `3478/udp`, `5349/tcp`). Do not hand out the app without setting a password.

