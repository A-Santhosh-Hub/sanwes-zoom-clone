# SanWe's — self-hosted Zoom clone with classroom automation and a Game Hub

<p>
  <img alt="Node.js 20.6+" src="https://img.shields.io/badge/Node.js-20.6%2B-3c873a?logo=node.js&logoColor=white">
  <img alt="WebRTC LiveKit" src="https://img.shields.io/badge/WebRTC-LiveKit-0e72ed">
  <img alt="Electron" src="https://img.shields.io/badge/Desktop-Electron-47848f?logo=electron&logoColor=white">
  <img alt="Windows and Linux" src="https://img.shields.io/badge/Windows%20%7C%20Linux-supported-555">
  <img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue">
  <img alt="Status: about 70% complete" src="https://img.shields.io/badge/status-~70%25%20complete-orange">
</p>

**SanWe's** is an open-source **Zoom clone / Zoom alternative** that you run on your own computer or server. It does what people expect from Zoom or Google Meet
(video meetings, screen share, chat, polls, breakout rooms, recording, scheduling, host controls) and adds two things Zoom does not have:

1. **Class automation.** Schedule a class once and SanWe's opens the room, makes the teachers co-hosts, plays your waiting-room and prayer videos at the exact minute, and records the class by itself, every day, with nobody clicking. Built for online teaching with 300 to 400 students per class.
2. **Game Hub.** Stream a game; viewers can ask to *play* it. The streamer says yes, and the viewer then controls the streamer's PC with **keyboard, mouse, gamepad, or an on-screen touch controller on a phone** (like Parsec / Steam Remote Play, but inside the room).

> Developed by **Santhosh A, SanStudio**. Status: **about 70% complete** — a working, tested core with an honest list of what is still missing (see [Status](#status-and-what-was-tested)).

---

## Quick start

You need **Node.js 20.6 or newer** (the LTS from <https://nodejs.org>). Nothing else: no Docker, no database.

### Windows (easiest)
1. Click **Code → Download ZIP** on GitHub, and unzip it.
2. Double-click **`START-HERE.bat`**.
3. Wait 2 to 5 minutes the first time. It sets everything up by itself, starts SanWe's and opens <http://localhost:3000>.
4. Create your account. **The first account becomes the administrator.**

### Any system (Windows / Linux)
```bash
git clone https://github.com/A-Santhosh-Hub/sanwes-zoom-clone.git
cd sanwes-zoom-clone
npm start
```
`npm start` runs the setup the first time and then launches everything. Open <http://localhost:3000>. Press `Ctrl+C` to stop.

### What the automatic setup does
| Step | What happens |
|---|---|
| 1 | Checks your Node.js version |
| 2 | Installs the server and web-client packages (`npm install`) |
| 3 | Creates **your own** `.env` and `livekit.yaml` with a new random secret. They never leave your computer and are in `.gitignore` |
| 4 | Downloads the **LiveKit media server** from its official release page and checks its SHA-256 checksum (macOS: `brew install livekit`) |
| 5 | Builds the web client. The background-blur / noise models are already in `client/public` |
| 6 | *Windows only, optional:* fetches the ViGEm library and builds the Game Hub input helper from source |

No `.exe` is stored in this repository; everything is downloaded or built on your machine. Running it again is safe: it only does what is missing.

### Use it from phones, other PCs, or the internet
- **Same Wi-Fi:** `npm start` prints a `http://<your-ip>:3000` address. Browsers only allow camera/microphone on `localhost` or **HTTPS**, so for other devices use HTTPS (`deploy/Caddyfile`) or a tunnel.
- **Internet link without a server:** on Windows run `start-sanwes-with-tunnel.bat` (needs [cloudflared](https://github.com/cloudflare/cloudflared)); it prints a public link.
- Details, TURN and HTTPS: [docs/FEATURES.md](docs/FEATURES.md#using-it-from-other-devices--the-internet).

---

## Features

### Meetings (Zoom-style)
- Gallery, speaker and side-by-side views; pin, spotlight, fullscreen; meeting timer; up to **500 people** per room (configurable, with paged gallery and selective subscriptions)
- Camera, microphone, **screen share with sound** (1080p/60, H.264/VP9/AV1 choices), **share a video file** with clean stereo sound
- **Virtual backgrounds, background blur and AI noise suppression**, all running in the browser
- Chat (to everyone or one person), **files in chat**, reactions, raise hand, be-right-back
- **Host tools:** waiting room, lock meeting, mute/ask-to-unmute, who may chat/share/record/rename, make **co-hosts**, remove people, suspend activities, end for all
- **Classroom tools:** **polls and quizzes**, **Q&A**, **breakout rooms**, **live captions**, shared **whiteboard**, hold-SPACE to talk
- **Scheduling:** meeting IDs, passcodes, repeat, invitations (copy / Google Calendar / .ics), time zones, reminders with chime and desktop notification
- **Recording** to MP4/M4A on your own computer (video + sound, audio only, or one file per person)

### Accounts and administration
- Sign-up / sign-in with scrypt-hashed passwords, sessions, rate limits; the first account is the administrator
- The administrator can see a **password list** kept in a separate **AES-256-GCM encrypted vault** (can be switched off)
- Roles follow accounts (owner = host; co-hosts by account)

### Class automation (for teachers)
- Schedule once, repeats daily: the class opens by itself, teachers become co-hosts when they join, the **class bot plays your videos on a timeline** (at minute N, or right after the previous one), and **records when the teacher starts speaking**
- Windows **auto-start at sign-in** and optional **wake from sleep** so the 4:30 am class runs unattended
- A status strip in the class window says exactly what is happening, and every run is logged
- **Recording protection:** a watermark with each student's name, or the **SanWe's Viewer** app whose window Windows hides from screen recorders
- **SanWe's Studio** (Electron desktop app, built on your PC): opens the class window by itself and records it with sound to H.264/AAC MP4
- Details: [docs/CLASS_TASKS.md](docs/CLASS_TASKS.md), [docs/STUDIO.md](docs/STUDIO.md)

### Game Hub (stream a game, let a viewer play)
- A viewer asks to play, the streamer allows each person and chooses what they may control
- **Keyboard + mouse** (hardware scan codes, absolute or pointer-lock "game" mouse), **gamepads** as virtual **Xbox 360** controllers (ViGEmBus) with **rumble sent back**
- **Phone support:** a full on-screen **PlayStation/Xbox-style touch controller** (multi-touch sticks, triggers, d-pad that slides into diagonals, vibration), goes full screen the moment the phone asks to play, portrait and landscape layouts, one-tap Stop
- **Safety:** input only while the chosen game window is in front; Windows key / Alt+Tab / Alt+F4 blocked; emergency stop hotkey; keys are released if anyone's connection drops or the page closes; audit log; only the streamer's own computer can control it
- Measured on a mid-range laptop: key press → game about **16 to 24 ms**; picture about **125 to 160 ms** old (software H.264, everything on one computer)
- Details, safety table and numbers: [docs/GAME_HUB.md](docs/GAME_HUB.md)

### Research behind it
How Zoom's web client, AnyDesk and UltraViewer (PC and Android) work, studied with a reverse-engineering toolkit and turned into features here:
[Zoom web](docs/ZOOM_WEB_REPORT.md) · [Zoom accounts](docs/ZOOM_ACCOUNTS_REPORT.md) · [capture protection](docs/ZOOM_CAPTURE_PROTECTION_REPORT.md) · [feature map](docs/ZOOM_FEATURE_MAP.md) · [AnyDesk / UltraViewer](docs/REMOTE_CONTROL_REPORT.md)

---

## How it works

```
 Browser / phone / SanWe's Viewer           SanWe's server (Node + Express)             LiveKit media server (SFU)
 ───────────────────────────────           ───────────────────────────────           ─────────────────────────
  Vite web client  ── sign in, token ──▶   accounts · meetings · class tasks  ──▶   rooms · tracks · data channels
        │                                   host controls · classroom tools                  ▲
        └──────────── WebRTC video / audio / data (UDP) ─────────────────────────────────────┘
                                                   │
        Class bot (headless Edge/Chrome page)  ◀───┤   plays videos, records
        SanWe's Studio (Electron)              ◀───┤   opens class window, records it
        Game Hub agent ── sanwes-input.exe ────────┘   keyboard / mouse / virtual Xbox pad (Windows, loopback only)
```

## Project structure
```
server/      Express app: accounts, tokens, meetings, class scheduler + bot control, classroom tools, breakouts, vault, Game Hub agent
client/      Vite web client (home, meeting, class bot page, Game Hub, touch controller). public/ holds the background-blur models
desktop/     SanWe's Studio and Viewer (Electron, built on your PC) and input/ (the Game Hub helper, C#, built from source)
scripts/     setup.mjs (one-command setup), run.mjs (starts everything), check.mjs, Windows launcher/auto-start scripts
deploy/      Caddyfile (HTTPS) and a production LiveKit example config
docs/        feature guides and the research reports
```

## Configuration
`npm run setup` writes `.env` for you. The useful options (all commented in [`.env.example`](.env.example)): `PORT`, `LIVEKIT_URL`, `JOIN_PASSWORD`, `ROOM_PASSWORDS`, `TOKEN_RATE_MAX`, `MAX_PARTICIPANTS`, `RECORDINGS_DIR`, `MEDIA_MAX_MB`, `BROWSER_PATH`, `KEEP_PASSWORDS`, `DATA_DIR`. To use other ports run setup with `SANWES_APP_PORT` / `SANWES_LK_PORT` set.

## Platform support
| Part | Windows | Linux | macOS |
|---|---|---|---|
| Meetings, chat, polls, breakouts, scheduling, accounts | yes | yes | yes (install the media server with `brew install livekit`) |
| Class automation window and recording (needs Edge or Chrome) | yes | untested | untested |
| Auto-start, Studio, Viewer, recording protection | yes | – | – |
| Game Hub: watching, requesting, touch controller | yes | yes | yes |
| Game Hub: the streamer's PC (keyboard / mouse / gamepad control) | **yes** | – | – |

## Status and what was tested
**Working and tested** (automated end-to-end tests with real browsers and the real media server): sign-in and roles, meetings and host controls, classroom tools, breakout rooms, class automation including the Studio desktop app, the password vault, large-room behaviour, Game Hub request/approve/control, the virtual Xbox pad (read back through Windows XInput), the safety stops, and the phone touch controller (phone-sized touch browser, portrait and landscape).

**Not finished or not tested yet:** a native phone app; a real physical gamepad and real phone hardware for the touch controller; fullscreen-exclusive and anti-cheat games; more than one simultaneous player; load tests with 400 live students; Linux/macOS for the class bot; an independent security review. See the "not tested" lists in each guide.

**Roadmap:** native Android/iOS app · GPU-encoded game stream on every PC · more controller layouts · translations · cloud deployment guide.

## Security
Secrets live only in `.env`, `livekit.yaml` and `data/`, all ignored by git; setup creates new ones for each computer. See [SECURITY.md](SECURITY.md) for how to report a problem and what to do before exposing it to the internet.

## Credits and licences
Built with [LiveKit](https://livekit.io), Express, Vite, Electron and MediaPipe; the full list is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). SanWe's is not affiliated with Zoom, AnyDesk, UltraViewer or Parsec; those names only describe what was studied.

**Developed by Santhosh A — SanStudio.** MIT licence, see [LICENSE](LICENSE). Contributions welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

---

### Repository settings (copy these into GitHub → About)
- **Name:** `sanwes-zoom-clone`
- **Description:** Self-hosted Zoom clone & Zoom alternative (WebRTC + LiveKit): video meetings, screen share, polls, breakout rooms, recording, class automation, plus a Game Hub where viewers can play your game with keyboard, gamepad or a phone touch controller.
- **Topics:** `zoom-clone` `zoom-alternative` `video-conferencing` `webrtc` `livekit` `self-hosted` `google-meet-alternative` `online-classes` `education` `screen-sharing` `game-streaming` `remote-play` `cloud-gaming` `parsec-alternative` `virtual-gamepad` `touch-controller` `electron` `nodejs` `vite` `javascript`
