# Third-party software

SanWe's is MIT licensed (see `LICENSE`). It uses these open-source projects. Nothing below is copied into this repository except the two small browser model/runtime files noted; everything else is installed by `npm` or downloaded by `npm run setup` on your computer.

| Project | What for | Licence |
|---|---|---|
| [LiveKit](https://github.com/livekit/livekit) server (downloaded by setup, not stored here) | the media server (WebRTC SFU) | Apache-2.0 |
| livekit-client, livekit-server-sdk, @livekit/track-processors | client / token / camera-background libraries | Apache-2.0 |
| [Express](https://expressjs.com), http-proxy, jose | web server, proxy, tokens | MIT |
| [Vite](https://vitejs.dev) | builds the web client | MIT |
| [Electron](https://www.electronjs.org), @electron/packager | the optional desktop apps (built on your computer) | MIT / BSD-2-Clause |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe) tasks-vision runtime and the selfie-segmentation model (`client/public/mediapipe`, `client/public/models`) | blurring or replacing the camera background in the browser | Apache-2.0 |
| @sapphi-red/web-noise-suppressor | noise removal for the microphone | see the package |
| [Nefarius.ViGEm.Client](https://github.com/ViGEm/ViGEm.NET) (downloaded by setup on Windows) | virtual Xbox 360 controllers for Game Hub | MIT |
| [ViGEmBus](https://github.com/nefarius/ViGEmBus) driver (you install it yourself, optional) | the Windows driver that makes the virtual controllers | see its project page |

Design ideas for the on-screen game controller were taken from the open-source projects kw-m/virtual-gamepad-lib, GDur/gamepad and nipplejs (all MIT); no code was copied.
"SanWe's" is an independent project. It is not affiliated with, or endorsed by, Zoom, AnyDesk, UltraViewer, Parsec or any other company named in the documents. Those names are used only to describe what was studied.
