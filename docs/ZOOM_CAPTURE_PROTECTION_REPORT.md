# Report: how Zoom stops other people recording or capturing a meeting, and what SanWe's can and cannot take from it

Audience: the SanWe's developer team and the administrator. Produced with REA on the installed Zoom Workplace 7.1.9
components (`zVideoUI.dll`, `zVideoUIPlugin.dll`, `zBusinessUIComponent.dll`, `zSettingUI.dll`, `zWebService.dll`). Nothing was
decompiled or copied. REA's full Ghidra analysis of the 14 MB `zVideoUI.dll` timed out (15 minutes), so the findings below come
from REA's string/identifier view plus a read-only identifier scan of the same files. Only names were read, not logic.

## What REA found

| Identifier | File | What it tells us |
|---|---|---|
| `SetWindowDisplayAffinity`, `GetWindowDisplayAffinity` | zVideoUI, zVideoUIPlugin, zBusinessUIComponent, zSettingUI | Zoom asks **Windows itself** to hide a window from capture. Windows then gives screen recorders, screenshots and screen shares a **black rectangle** where that window is. The picture is not hidden by Zoom drawing black; the operating system does it. |
| `CZMDisplayAffinityMapT<…>` (one for **every** meeting window class: toolbar, chat, polls, breakout, dialogs…), `ZMWndDisplayAffinityNotiEventAgent`, `ResetWndDisplayAffinityNone`, `ResetAttachWndDisplayAffinityNone`, `IsNeedDisplayOnlyMonitor`, `UpdateWindowDisplayMonitorChanged` | zVideoUI, zVideoUIPlugin | Every window takes part in one shared **"display affinity" policy**: set when needed, reset to "none" when not, re-applied when the window moves to another monitor. |
| `RequestRecordPermissionDlg` | zVideoUI | A participant must **ask the host for permission** to record locally. Recording is a host-granted right, not something everyone has. |
| `ConfWaterMarkerHelp`, `VideoStripe::RefershWatermark`, `chk_show_watermark_on_share_content`, `btn_audio_watermark`, `WaterMarkParameter` | zVideoUI, zWebService | Two kinds of **watermark**: a visible one on shared content, and an **audio watermark** (an inaudible tag naming who the recording came from). These do not stop recording; they make a leak **traceable**. |
| `CProctorMode*`, `CBubbleStopProctorModeWnd` | zVideoUI | A "proctor" layout where the host sees everyone; unrelated to capture blocking. |

## What this means

1. **Zoom's "black screen" is an operating-system feature of its desktop application.** It works because Zoom owns the window.
   The same switch exists for Electron apps (`win.setContentProtection(true)`) and for Android apps (`FLAG_SECURE`). It does **not**
   exist for a normal web page: a browser tab cannot tell Windows to hide it, so a web page cannot produce a black recording.
2. **Netflix and Jio Hotstar** do it in two ways: (a) the same app-level protection on phones and TVs, and (b) in browsers,
   **encrypted video (DRM: Widevine, PlayReady, FairPlay)**, where the picture is decrypted inside a protected part of the graphics
   hardware so screen recorders get black. DRM needs a licence server and licence from a DRM provider and works on pre-packaged
   streams; it **cannot** be used with live WebRTC meetings on a single laptop. It is not available to SanWe's.
3. **Nothing stops a phone camera filming a screen** (Zoom, Netflix and Hotstar included). The goal is "no easy recording", then
   "traceable if leaked".
4. Zoom makes recording a **permission**: the host can disable recording for others and approve requests.

## What SanWe's does (and does not)

| Layer | Works for | How | Honest limit |
|---|---|---|---|
| **Recording is a host-only right** | everyone | The in-meeting recorder is only offered to the host and co-hosts, and participants cannot start it. (Exists since the recording work.) | Cannot stop a screen recorder program on the student's computer. |
| **Black-screen mode in the SanWe's Viewer app** | Windows students using the app | The Viewer is the same Electron app as Studio, started in viewer mode. It calls `setContentProtection(true)`, the same Windows feature Zoom uses, so OBS, Game Bar, Snipping Tool, Teams/Zoom screen share and PrintScreen show a **black window**. | Windows only; the student must install the app. A later Android app can do the same with `FLAG_SECURE`. |
| **Protected classes can require the Viewer** | per class | The host chooses *Protection: Off / Watermark / Viewer app only*. In "Viewer app only" a normal browser is refused with an explanation and a download link. | A determined person can fake the Viewer's identity to the server, so this is a strong deterrent, not a vault. |
| **Moving watermark with the student's name** | every browser, phone and computer | The student's name and username float over the video, and move so they cannot be cropped. A leaked recording identifies the person. | A watermark does not prevent recording, only identifies who did it. |
| **No-capture hints in the web page** | browsers | Right-click and drag are off, the picture blanks when the tab is hidden or PrintScreen is pressed. | Only against casual copying. A browser cannot detect or block screen recorders. |

## Decision

Build exactly the layers above, label each as **block** or **deter**, and tell the administrator plainly that a browser alone cannot
produce a black screen. DRM is not possible for live classes without an external paid DRM service.
