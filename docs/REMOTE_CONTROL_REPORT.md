# Remote-control software analysis: UltraViewer and AnyDesk

Purpose: understand how the two remote-control programs installed on this computer work, so that SanWe's **Game Hub**
(a streamer plays a game, a viewer asks to play, the streamer accepts, the viewer controls the streamer's PC with keyboard,
mouse or gamepad) takes the good ideas and avoids what makes these programs poor for games.
Only behaviour and architecture were studied; no code was copied.

## What was analysed and how

| Program | Version | Files looked at | Tool / method |
|---|---|---|---|
| UltraViewer | 6.6.124 | `C:\Program Files (x86)\UltraViewer\*` (uvc.dll, uvh.dll, uvh64.dll, uva64.dll, RemoteControl.dll, RemoteControl20.dll, UltraViewer_Desktop.exe, UltraViewer_Service.exe, uv_x64.exe, language files, service log) | REA (Ghidra) on `uvc.dll`: strings, imports; byte-level API-name scan of the other files |
| AnyDesk | current build in `Downloads\AnyDesk.exe` | its own `ad.trace` log, `system.conf` / `user.conf` / `service.conf` (setting **names** only, never the values: they hold IDs and keys) | REA on `AnyDesk.exe`: it is **packed** (54 functions, 29 strings, the real code is compressed inside), so static analysis shows nothing. The program's own log is the evidence instead |
| ViGEmBus | 1.17.333 (already installed here, service running) | driver registration | Windows service and PnP list |

Not done: no network capture, no unpacking of AnyDesk, nothing was connected to anyone. Conclusions about AnyDesk's video codec
internals come only from names in its own log and capability list, so they are labelled as such.

## UltraViewer: how it works (evidence → conclusion)

| Area | Evidence | Conclusion |
|---|---|---|
| **Screen capture** | `uvc.dll` imports `BitBlt`, `GetCursorPos`, `SetCursorPos`; `RemoteControl*.dll` also use `BitBlt` | Plain **GDI** screen copy. No DXGI / Windows Graphics Capture, so fullscreen games, DirectX overlays and protected video often come out black or slow |
| **Compression** | `uvc.dll` contains **libjpeg-turbo 1.5.2 (TurboJPEG: `tjCompress2`, `tjDecompress2`)**; settings "Optimize speed / quality", "256 Colors / High Color", "Low / High Quality" | Each screen change is sent as a **JPEG picture** (or reduced colour depth). There is **no video codec** (no H.264/VP8/AV1) and no GPU encoder. Fine for office work, hopeless for 60 fps games |
| **Input** | `RemoteControl.dll`: `mouse_event`, `MapVirtualKey`, `GetAsyncKeyState`, `SetWindowsHookExA`; `uvh.dll`/`uvh64.dll`: `SetWindowsHookExW` | Mouse and keyboard are injected with the old `mouse_event`/virtual-key route and observed with hooks. **No XInput, joystick, HID or ViGEm strings anywhere**: no gamepad support at all |
| **Sound** | `RemoteControl.dll` references **NAudio** and **WasapiLoopbackCapture** | Computer sound is captured with WASAPI loopback (same idea SanWe's Studio already uses) |
| **Network** | `RemoteControl.dll`: `Socket`, `SslStream`, AES; language file: "Connect using port **443** / **2112**", proxy settings; service log shows a licence/update check against ultraviewer.net | Everything goes over **TCP + TLS** through the vendor's servers (port 443 or 2112), so there is no UDP and no peer-to-peer path. TCP re-sends lost data and stalls the picture: that is the opposite of what a game needs |
| **Session model** | ID + password (random per run, optional custom password), partner "ID must be a number"; "Who's viewing your computer" list; chat; stored-password options | The classic **ID + one-time password** consent model: the owner gives the ID and password to the person who may connect |
| **Windows integration** | `UltraViewer_Service.exe` calls `WTSQueryUserToken`; service log: "Final path: UltraViewer_Desktop.exe ... SessionID=2", `uv_x64.exe hook <pid>`; options "UltraViewer on Winlogon screen"; `CloseRDP.bat` uses `tscon` | A **Windows service** (SYSTEM) starts the user-interface program inside the logged-in user's session and a 64-bit helper that hooks input. That is how it keeps working on the login screen and after Remote Desktop |
| **Other features** | Language file: chat with phrase suggestions, screen capture to file, "Show remote cursor/wallpaper", "Send Keystroke", hotkeys, auto-reconnect countdown, co-operate | Remote desktop *support* features. Nothing about frame rate, latency, controllers or audio quality |

## AnyDesk: how it works (evidence → conclusion)

| Area | Evidence in `ad.trace` / config | Conclusion |
|---|---|---|
| **Connection set-up** | "Connecting to relay relay-….net.anydesk.com", cipher `TLS_AES_256_GCM_SHA384 TLSv1.3`, "Main relay connection established", "Found 6 direct connection candidates", "IPv4 punch socket set up", `anynet.punch_connector` trying local, public and port-7070 addresses | A **relay server** is used to find the peer and to carry the session when nothing better works; at the same time both sides try a **direct peer-to-peer connection** (NAT hole punching, LAN address first). The log shows the direct attempts failing in that session (`Too many retries`), so the relay carried it |
| **Session features** | `Session features: deskrt, clipboard, chat, audio, input, tcp_tunnel` | One session multiplexes video ("deskrt"), input, audio, clipboard, chat and TCP tunnelling |
| **Video** | `desk_rt.display_component`, `desk_rt.d3d_view` ("Current mode: 1920x1080, 144 Hz", "Initialized (1920x1080, X8R8G8B8)"), capability names `lossless_codec`, `quality_adaptive`, `video_mode`, `encoder_reset`, `encoder_retransmit`, `request_vp_dimensions`; setting `ad.session.encoding_mode` | A purpose-built codec ("DeskRT") drawn through **Direct3D** on the viewer, with **adaptive quality**, a lossless mode, and the ability to reset the encoder and ask the sender to retransmit. It is built around desktop content and is tuned for low bandwidth, not for a game's constant motion |
| **Input** | Capabilities `keyboard_sink`, `keyboard2`, `keyboard_unicode`, `string_input`, **`relative_mouse_input`**, `keyb_hint_*`, `report_kbd_focus`, `block_input`, `send_sas`; log "Keyboard layouts differ ... Auto-mode is Translate" | Keyboard is translated between layouts; **relative mouse** exists (needed by shooters); the owner can **block the remote user's input** and the viewer sees "input permissions: enabled / allowed / forbidden". No gamepad capability in the list |
| **Permissions** | `ad.security.permission_profiles._default...`, `_unattended_access`, "Received new input permissions: (enabled forbidden supported)" changing live during the session | Per-session **permission profiles**; the owner can take away keyboard/mouse control at any moment without ending the session |
| **Privacy & safety** | Capabilities `privacy_feature`, `lock_workstation`, `logoff_session`, `two_factor_auth`, `volatile_token` | Privacy screen, lock/log-off, 2FA and one-time tokens |
| **Sound** | `sound_src`, `sound_sink` | Computer sound is streamed |
| **Extras** | `filetransfer_*`, `remote_printing`, `whiteboard`, `clip_*`, `tcp_tunnel`, `switch_sides`, `multi_stream_session`, Wake-on-LAN setting | Support / admin features. `switch_sides` (swap who controls whom) is the closest to "give someone control" |

## AnyDesk, observed while running (REA + Frida, read-only)

AnyDesk was started by the owner and REA attached to its main window process (PID of `AnyDesk.exe --`, no hooks, no memory contents read, 3 seconds).
The three running processes are the **service** (`--local-service`), the **window** (no argument) and the **local controller** (`--local-control`).

| Observation | Meaning |
|---|---|
| 32-bit process, 75 modules, 20 threads, about 38 MB image | One large self-contained program |
| Loaded: `WINHTTP`, `WS2_32`, `bcrypt`, `CRYPT32`, `gdi32`, `gdiplus`, `WindowsCodecs`, `dwmapi`, `avrt`, `winmm` | Own sockets plus HTTP proxy support, Windows crypto, GDI/WIC for pictures, DWM, `avrt` (the multimedia scheduler Windows gives to low-latency audio/video threads), `winmm` audio |
| **Not loaded: any `d3d11`/`dxgi` (idle), Media Foundation, NVENC/AMF/QSV, `xinput`, `hid`** | With no session open there is no GPU video pipeline in memory, and the video codec is AnyDesk's own, not a GPU encoder from the graphics driver. There is no gamepad/HID code at all. (The trace log shows Direct3D is used for drawing the remote picture once a session starts.) |
| Available to it in Windows: `SendInput`, `keybd_event`, `mouse_event`, `SetCursorPos`, `BlockInput`, `OpenInputDesktop`, `SetThreadDesktop`, `CreateProcessAsUserW`, `LockWorkStation`, `AddClipboardFormatListener`, `RegisterRawInputDevices` | The same OS door SanWe's Game Hub uses for keyboard and mouse; plus desktop switching (login screen / UAC), blocking the local user's input, and clipboard sync |

This agrees with the log findings above: AnyDesk is a remote-desktop tool with its own codec, relay, and permission system, **not** a game-streaming tool with GPU encoding or controllers.

## AnyDesk for Android (static analysis of the official APK)

The official `anydesk.apk` (45.7 MB, from download.anydesk.com) was opened as an untrusted file; nothing was run. It has two Java/Kotlin code files and **one native core library, `libadext.so`** (34 MB per architecture; arm64, arm32, x86, x86_64).

| Area | Evidence | Meaning |
|---|---|---|
| Video | `libvpx` "WebM Project VP8 Encoder/Decoder v1.6.0", `libyuv`, `deskrt`, `lossless_codec`, `quality_adaptive`, `multi_stream_session`; no `MediaCodec`/`video/avc` strings | Software VP8-based codec ("DeskRT"), not a phone GPU codec; adaptive and lossless modes |
| Drawing | `eglCreateContext`, `ANativeWindow_*`, "OpenGL ES 2.0", settings "Vulkan (recommended)", "OpenGL (experimental)" | The picture is drawn with the GPU (OpenGL ES or Vulkan) |
| Sound | "Could not create opus encoder / decoder" | Opus audio |
| **Touch input** | Settings `ad.input.touch_mode`, `ad.session.touch_mode`, `ad.input.auto_touch_to_touch_mode`; UI wording "Touch Mode", "**Touchpad mode**", "Touchpad Emulation", "Direct mouse mode", "Translate mouse input to touch input", `relative_mouse_input` | Three ways to use a phone as a mouse: **touch mode** (a tap clicks where you tap), **touchpad emulation** (dragging moves the cursor like a laptop trackpad) and relative mouse |
| Keyboard | "SpecialKeyboard*" buttons (modifier toggles), "Unrestricted keyboard" with dictation, `AKeyEvent_getScanCode` | An extra row of special keys (Ctrl, Alt, ...) above the phone keyboard |
| Permissions | `INJECT_EVENTS`, `BIND_DEVICE_ADMIN`, `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `RECORD_AUDIO`, `VIBRATE`, `USB_PERMISSION` | Screen sharing from the phone and (with a plugin) controlling it; vibration |
| **Gamepad** | No `gamepad`, `joystick`, `uinput`, `/dev/input`, `InputDevice` of game controllers, or HID strings | **Not supported.** A phone cannot use AnyDesk to play with a controller |

Game Hub's on-screen controller is therefore new ground compared with AnyDesk: touch mode and touchpad emulation move a mouse; Game Hub's touch controller drives a virtual Xbox pad.

## What neither program does (this is the gap Game Hub fills)

1. **No gamepad / joystick.** UltraViewer has no controller code at all; AnyDesk's capability list has none. A game needs a *virtual controller* that the game sees as a real Xbox pad.
2. **Not built for motion.** UltraViewer sends JPEG pictures over TCP; AnyDesk's codec is desktop-oriented. Neither targets 60 fps with hardware video encoding.
3. **One viewer.** Both are one-to-one. A game hub has an audience watching, and *one or more* of them may be allowed to play.
4. **Consent is "ID + password", not "request → accept".** There is no audience-visible request/accept flow.
5. **Latency is not shown or tuned.** No ping/fps/bitrate display for the person playing, no jitter-buffer control.

## What Game Hub takes from them

| Idea | Seen in | Game Hub version |
|---|---|---|
| Direct peer-to-peer first, relay as fallback | AnyDesk | LiveKit uses **UDP** (port 7882) for media; the TCP fallback (7881) is detected and the player is warned, because it adds lag |
| Owner can switch the remote user's input off live | AnyDesk (`block_input`, permissions) | Streamer's **Stop** button, a global **panic hotkey**, per-player revoke |
| Relative mouse | AnyDesk (`relative_mouse_input`) | **Pointer-lock** mouse for shooters, plus normal cursor mode |
| Keyboard sent as key codes, layout-independent | AnyDesk (`keyboard2`), UltraViewer (`MapVirtualKey`) | Physical key positions (`event.code`) sent as **scan codes**, which games read directly |
| Computer sound loopback | UltraViewer (WASAPI loopback), AnyDesk | Game sound is shared with the stream (already in SanWe's) |
| Who's controlling list | UltraViewer ("Who's viewing your computer") | Player list with the streamer's revoke buttons and an always-on-top, **capture-hidden** "X is playing" pill |
| Hardware video + D3D rendering | AnyDesk | WebRTC **H.264 (GPU encoder)** and GPU decode in the browser |

Added beyond both programs: a **virtual Xbox 360 controller per player** (ViGEmBus, already installed on this PC), force-feedback
(rumble) sent back to the player's real pad, a request → accept flow in front of an audience, and a latency read-out.

## Limits of this analysis

- AnyDesk's binary is packed, so its codec and wire format were not examined; only its log and capability names.
- No traffic was captured, so frame rates and bit rates of the two programs were not measured.
- Anything said about how other products (Parsec, Moonlight, Steam Remote Play) work is general knowledge, not part of this analysis.
