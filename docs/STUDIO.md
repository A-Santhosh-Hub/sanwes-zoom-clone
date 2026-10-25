# SanWe's Studio: the desktop app

Audience: the person who hosts meetings from their own computer (the admin). Studio is an `.exe` that runs SanWe's on this
computer, opens the meeting in its **own window**, makes the **public link** for guests, and **records that window with its
sound**. Nothing needs a browser tab, and guests still join with a normal browser.

## Start it

1. Build once: double-click **`build-sanwes-studio.bat`** (needs the client built once with `npm run build`). It makes
   `desktop\dist\SanWes Studio-win32-x64\SanWes Studio.exe` (about 440 MB, self-contained: the app, the SanWe's server, the
   web client and the media server are all inside).
2. Open it with **`start-sanwes-studio.bat`**, or double-click `SanWes Studio.exe`.
3. Two windows open: the **meeting window** (SanWe's, the thing you and your guests use) and the small **Studio** panel.

If the servers are already running (for example you started them with `start-sanwes.bat`), Studio uses those and does not stop
them when you close it. Closing Studio stops only what Studio itself started.

## Class mode: Studio runs the day's classes by itself

Start Studio with **class mode** and nobody has to click anything:

- **`install-autostart.bat studio`** (once) makes Windows start Studio in class mode every time you sign in (add `tunnel` for the public link and
  `wake=04:15` to wake a sleeping computer). Or start it by hand: `"SanWes Studio.exe" --class-mode`.
- Studio starts the servers hidden-ish (its panel is minimized) and **keeps the meeting window closed until a class starts**.
- When a scheduled class starts, **Studio's own meeting window opens by itself**, signs in as the person who set the class up, **joins as host**,
  and the class helper plays the videos in it. A strip at the top says what is playing, what is next and whether it is recording.
- When the class says "record" (from the start / when the videos end / when the teacher speaks), **Studio records its meeting window with the sound of
  the computer** (H.264 + AAC, 1280x800 or larger, written to disk while recording) into **Videos > SanWe's Recordings > (date and class name)**.
  When the class ends or you press End class bot, Studio stops and saves.
- It uses the accounts, videos and classes of the SanWe's folder this app sits in, so there is **one** set of accounts whether SanWe's was started by
  `start-sanwes.bat` or by Studio. If SanWe's is already running, Studio uses that.
- If Studio is not running when a class starts, a normal Edge window opens instead (and the helper records on its own).

## Signing in

SanWe's needs an account for everyone, including you. The first time, the meeting window shows **Create account**: make yours first,
because **the first account created on this computer is the administrator** (it can reset other people's passwords and manage
accounts). The meeting window remembers you for 30 days. Guests do the same on the public link. See [ACCOUNTS.md](ACCOUNTS.md).

## Classes and students

Studio records whatever happens in its window. For classes that run by themselves (the class bot records on its own, no window
needed) and for students who must not record, see [CLASS_TASKS.md](CLASS_TASKS.md): **SanWe's Viewer** is the student's app (built with
`build-sanwes-viewer.bat`), and its window is hidden from screen recorders. Do not use the Viewer to record a class yourself: it records black on purpose.

## What the Studio panel does

| Section | What it does |
|---|---|
| **Meeting link** | The link on this computer, the link for the same Wi-Fi, and **Start public link** (a Cloudflare quick tunnel, needs `cloudflared`; it shows the `https://...trycloudflare.com` link to **Copy** and send to guests). |
| **Open the meeting window** / **Make it large** | Brings the meeting window back; the large button maximizes it (a bigger picture for the recording). |
| **Recording** | **Quality** (Standard 30 fps / 8 Mbit/s, High 60 fps / 14 Mbit/s, Maximum 60 fps / 24 Mbit/s), **My microphone** (choose which), **Also save a sound-only file**, then **Record / Pause / Stop**, a timer and a sound level bar. |

## How the recording works

- It records **the meeting window itself** as Windows draws it (only that window: no other windows, no taskbar, no title bar), in
  H.264 video. This is the "whatever happens in that window" recording, not a browser-tab recording, so it does not depend on
  the web page's own recorder.
- The sound is **what this computer plays**: your guests' voices, any sound they share, and the video's sound. Your own voice
  is added from **My microphone**. A limiter keeps the mix from clipping.
- Files are written to disk **while recording** (a crash loses seconds, not the whole meeting) in
  `C:\Users\<you>\Videos\SanWe's Recordings\<date> <meeting name>\`:
  - `meeting.mp4`: picture and sound (H.264 + AAC), plays everywhere.
  - `audio_only.m4a`: just the sound.
- Everyone in the meeting is told that you are recording (a red dot by your name and a notice), like the in-page recorder.
- If nothing was audible you are told ("No sound was captured"), instead of finding a silent file later.

### Things to know

- Keep the meeting window **open and not minimized** while recording (a minimized window has nothing to capture).
- Other programs' sounds (music, notifications) are in the recording too, because the sound is taken from the computer's output.
  Mute them while recording, or use headphones for the meeting and keep the volume up.
- The size of the picture is the size of the meeting window's content. For the biggest picture use **Make the meeting window
  large**. A 1920x1080 screen gives about 1920x1008.
- Recording a separate sound file for each guest is not possible this way (all guests arrive as one mixed sound). The web
  recorder (More > Record, inside the meeting) can do that.
- Sharing a screen from inside the meeting shows a picker (screens and windows, with an optional "Share computer sound").

## What was tested

Automated runs of the packaged `.exe` on this laptop: the app starts both servers by itself, opens both windows, a guest in
Chrome joins, a recording of about 10 seconds is made, and the saved MP4 and M4A were played back and measured (picture
present, sound present, correct size, no other windows visible). The public link was started from the app and served the
meeting. Not tested: a multi-hour recording, and other computers.
