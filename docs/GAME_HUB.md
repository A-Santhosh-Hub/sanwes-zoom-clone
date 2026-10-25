# Game Hub: stream a game, let a viewer play it

A streamer plays a game and streams it. Viewers watch. A viewer can press **Play**, the streamer says **Allow**, and then that viewer controls the
streamer's PC with their own keyboard, mouse and gamepad (like Parsec, Steam Remote Play or AnyDesk, but inside a SanWe's room).
How it was designed, and what was learned from UltraViewer and AnyDesk: [REMOTE_CONTROL_REPORT.md](REMOTE_CONTROL_REPORT.md).

## For the streamer (step by step)

1. On the streaming PC, start SanWe's (`start-sanwes.bat`) and open **http://localhost:3000** in **Chrome or Edge** (or SanWe's Studio). Do not use the public link on this PC: play controls only work on the PC itself.
2. Home → **Game Hub** → name, game, **Create**.
3. Press **Go live**, pick the game window (or the screen). Tick *Share computer sound* if asked.
4. Toolbar → **Game Hub** → switch **Let viewers ask to play** on.
5. Under **Players control**, pick the game window (safest) or a whole screen. Nothing is controlled until you pick.
6. When someone asks, a red number appears on the button. Open Game Hub, tick what they may use, press **Allow**. **Remove** or **Stop everyone** at any time.
7. Emergency stop: **Ctrl+Alt+Shift+F12** (falls back to Q or X if another program owns it), or the red **Stop all** pill on your screen. The pill is not visible in the stream.

Gamepads need the free **ViGEmBus** driver (already installed on this PC). Without it keyboard and mouse still work.

## For the viewer

1. Join a Game Hub room (home screen list, or the link). **Play** in the toolbar.
2. Tick *Keyboard & mouse* and/or *Gamepad* → **Ask to play**.
3. When allowed, a bar appears. **Click the picture** to send keys. Clicking anywhere else (chat, a button) stops sending keys.
4. Mouse mode: *pointer* (menus, strategy) or *game* (shooters; Esc gives your mouse back). *Delay*: lowest / low / smooth.
5. The bar shows live numbers: input delay, network delay, fps, Mbps, loss, resolution, codec, UDP/TCP. Rumble from the game is played on your own gamepad.

## Playing from a phone (on-screen controller)

A phone has no keyboard, mouse or gamepad, so it gets a **touch controller** drawn over the picture, laid out like a console pad:
L2/L1 and R2/R1 on top; a d-pad and a thumbstick on the left; the four face buttons (cross = A, circle = B, square = X, triangle = Y) and a thumbstick on the right;
L3/R3 in the corners; three small buttons in the middle.

1. Join a Game Hub room on the phone, tap **Play**. On a phone the *Gamepad (the touch controller on your screen)* box is already ticked. Tap **Ask to play**.
2. **The moment you tap "Ask to play" the phone goes full screen** (the browser only allows that right after a tap, and the streamer's answer comes later) and shows a clean *Waiting for ... to let you play* screen with a **Cancel** button. Nothing else is on the screen: no title bar, chat or toolbar.
3. When the streamer allows it, the controller simply appears on that same full-screen view. If the streamer says no, or you cancel, the phone leaves full screen and the normal call screen comes back.
4. Hold the phone sideways (landscape) for the pad to fill the screen; the phone is turned landscape automatically where the browser allows it. If you hold it upright, the picture sits on top and the pad fills the bottom part. (iPhones do not allow web pages to go full screen; the view is still clean, and "Add to Home Screen" in Safari removes the address bar.)
5. Every finger works on its own: move a stick with one thumb while pressing buttons with the other, or hold several shoulder buttons together. Sliding across the d-pad gives diagonals.
6. Four small buttons across the top-middle: **screens** = full screen on/off, **gamepad** = hide the controller (a small *show pad* button and a red *stop* button stay), **menu** = Start, Back, vibration on/off, controller opacity, live numbers, **Stop playing**, and a red **STOP** button that ends playing in one tap (the phone then leaves full screen and you watch the stream normally).
7. The game's rumble makes the phone vibrate. Buttons give a tiny tap of vibration (can be switched off in the menu).
8. A tap on the picture itself clicks that spot on the streamer's PC, but only if the streamer also gave that person keyboard & mouse.

Technically the touch controller produces exactly the numbers a real gamepad would (Xbox 360 layout), so it uses the same path, the same virtual pad on the streamer's PC and the same safety rules.
It does not replace a keyboard: games that need keys will need a keyboard or a gamepad-capable game.

## Safety built in

| Risk | Protection |
|---|---|
| A stranger takes over the PC | Off by default; the streamer allows each person and chooses what they get; only the streamer's identity-stamped answer counts |
| They leave the game | Input is only sent while the chosen game window is in front; held keys are let go when it leaves the front |
| Windows keys, Alt+Tab, Alt+F4, Ctrl+Esc, Print Screen, power/sleep keys | Blocked unless the streamer ticks *Allow Windows key...* |
| Xbox Guide button | Never sent |
| Someone's connection dies with a key down | Their keys are let go after 1.5 s; they are removed after 30 s |
| The streamer's page hangs or closes | The server lets go of everything and stops the helper after 8 s |
| A website or the public link tries to use it | The agent only answers this computer, only to our own page, and only with the host's key; the viewer on the same PC is refused too |
| "Who did what?" | `data/logs/remote-play-<date>.log` records every request, allow, remove, stop and target choice |

## How it works (short)

`client/src/gamehub.js` (both sides) → `client/src/gamehub-agent.js` (streamer page) → `server/gamehub-agent.js` (loopback-only) →
`desktop/input/sanwes-input.exe` (SendInput scan codes, ViGEm virtual Xbox 360 pads, hotkey, pill). The viewer sends one small **state message**
(all keys down, mouse totals, wheel total, gamepad) many times a second on the lossy data channel, so a lost message is fixed by the next one and a key can never get stuck.
Third-party code: `desktop/input/THIRD_PARTY.md`. Build the helper: `desktop/input/build-input.bat` (needs only Windows' own compiler).

## Speed: what was measured on this PC (Intel i5-10300H laptop, GTX 1650 + Intel UHD, everything on one computer)

Network distance is **not** included (loopback). The test also loads the CPU with two Chrome windows, two servers and a busy test window, so the numbers are pessimistic.

| Part | Result |
|---|---|
| Input: viewer key press → key reaches the game window | **16 to 24 ms** typical (best 5 ms, worst about 40 ms); "Input" shown to the player 2 to 6 ms round trip |
| Video, 1080p60 H.264 (software encoder) | picture about **160 ms** old when shown (best 113, 90% under 186); CPU of the whole PC about 71% |
| Video, 720p60 H.264 | about **125 ms** (best 94, 90% under 138); CPU about 63% |
| Video, GPU HEVC (Intel encoder, Chrome/Edge only) | encoder runs on the GPU and CPU drops (about 56%), but delay was **worse** (about 430 ms): the Intel encoder took 71 ms per frame |
| Start-up | without the fast-start fix the picture sat at 320x180 for 20+ seconds; with it the stream starts at full 1080p |

So: **"zero latency" is not possible** (capture, encode, network, decode and the screen each cost time); input is very fast, video is about 0.1 to 0.2 seconds on a weak laptop and should be lower on a stronger PC. Over the internet add your network's round trip. For play over the internet the media server's UDP port **7882** must be reachable (a TCP-only path adds lag; the player's bar warns when that happens).

## Not tested

- A real physical gamepad (a faked gamepad in the browser was used; the virtual Xbox pad was read back through Windows' XInput).
- A real phone: the touch controller was tested in a phone-sized, touch-enabled Chrome with simulated multi-finger touches (the phone's screen size, touch events and vibration call, but not a real hand, a real phone browser's full-screen/rotation behaviour, or real vibration hardware).
- Fullscreen-exclusive games, anti-cheat games, other people's networks, more than one player at once, and phones.
- The NVIDIA GPU encoder (Chrome only used the Intel chip on this laptop; forcing Chrome onto the NVIDIA GPU is a Windows setting that was not changed).
- SanWe's Studio .exe was not rebuilt with this change (rebuild with `build-sanwes-studio.bat` after `desktop/input/build-input.bat`).
