# Class tasks: classes that start, play videos and record by themselves

Audience: the person who runs the classes (the administrator on each computer). Everything here is built into SanWe's; nothing
is paid for by the class and nothing leaves the computer.

## The problem it solves

Every morning and evening the same person had to be awake early, open each class by hand, play the waiting-room song with the
logo, give host and co-host to the teachers one by one, switch to the prayer video at the same moment in every room, stop the
video, and press Record when the teacher began to speak. Zoom charges extra for automatic co-hosts. Here it is a form you fill in
once, and it repeats every day.

## The idea: nobody opens anything

1. Switch the computer on and sign in to Windows. **SanWe's starts by itself, hidden** (see "Start with Windows" below).
2. At the class time the class **opens by itself** with you as host, the picked teachers become co-hosts when they join, the **first video starts playing at once**, the next videos follow, and **recording starts** when the videos are over and the teacher speaks.
3. Students join muted and cannot unmute. Hosts and co-hosts are never muted or limited.
4. You only end the meeting at the end.

## Start with Windows (so nobody has to run SanWe's)

Double-click **`install-autostart.bat`** once on each computer. From then on SanWe's (the media server and the app) starts hidden about 30 seconds
after you sign in to Windows. Options (type them after the file name in a command window, or make a shortcut):
`install-autostart.bat tunnel` also starts the public internet link (its address is saved in `public-link.txt`), and `install-autostart.bat wake=04:15`
also wakes the computer from **sleep** at 04:15 every day (it cannot wake a computer that is shut down). **`remove-autostart.bat`** turns it off again.
For a computer nobody signs in to, set Windows to sign in automatically (Windows key, type `netplwiz`, untick "Users must enter a user name and password").
If a class starts while the computer was off, it still starts when SanWe's comes up, as long as the class has not ended yet.

**Prefer the desktop app?** `install-autostart.bat studio` starts **SanWe's Studio** in class mode instead: the class window is Studio's own window, it opens
by itself and Studio **records that window with the computer's sound**. See [STUDIO.md](STUDIO.md). Without Studio an Edge window opens instead.

## Set up a class (once)

1. **Meetings > +** (or **Schedule**). Give it a topic, the start time (for example 04:30), and **Repeat: Daily**.
2. Open **More Options**.
3. **Co-hosts:** search the saved accounts (the administrator sees all of them) and tick the teachers. They become co-host **the
   moment they join**, every time. You can also type an exact username and press Enter.
4. **Class automation:** tick *Run this class by itself*, then:
   - **Upload a video** (MP4 H.264 + AAC, or WebM; up to 4 GB each, see `MEDIA_MAX_MB`). Videos stay in your library and can be
     used by any class. Add as many steps as you need (up to 6).
   - Each **step** is a video and **when it starts**: at a minute after the meeting start (the form shows the real clock time, for example
     "= 04:40 AM"), or **right after the video above ends**. Examples: *waiting song, minute 0, repeat* then *prayer, minute 10*; or
     *video 1, minute 0* then *video 2, right after*. A video set to repeat plays again and again until the next step begins, so nothing can
     start "right after" it. Two videos cannot start at the same minute (the form tells you). The first video starts from its beginning
     even if the class bot needed a few seconds to open.
   - **Record:** *when the teacher starts speaking after the videos* (recommended), *as soon as the videos finish*, *from the very
     start*, or *do not record by itself*. A sound-only file can be saved as well.
   - **Video quality:** *Light* (360p) for 200 or more students, *Standard* (720p) or *High* for small groups. The note under the
     choice says how much upload it needs for 100 and for 400 students.
5. **Video and audio** (More Options): *Mute participants on entry* and *Participants can unmute themselves*. Ticking "Run this class by itself"
   switches the first on and the second off for a new class, which is what a class needs. Host and co-hosts are not affected. *Host video on when joining*
   turns the camera on by itself for hosts and co-hosts. A class that runs by itself has no camera preview window: people go straight in.
6. **Recording protection** (under Security): *Off*, *Watermark*, or *Viewer app only* (see below).
7. **Save.** Do this once for each class (basic astrology, advanced, vastu...). Give each its own time and its own teachers.

## What happens at 04:30

- SanWe's opens the room by itself with **you (the person who saved the class) as host**, makes the picked teachers co-hosts as
  they arrive, and sends the **class bot**: a hidden Edge/Chrome window on this computer that joins as "Class video".
- The bot plays the first video as a **shared screen with sound** to everybody, then at minute 10 switches to the prayer video,
  and stops when it ends. Students see it exactly as if a host had shared a video. The bot does not appear in the people list.
- When the videos are over and a host or co-host **starts speaking** (or after 5 minutes if nobody does), the bot starts
  **recording the class**: the picture a student sees (shared screen or the teacher's camera, with the teacher's camera in a
  corner over a share), and the sound of the hosts, co-hosts, shared videos and anyone who speaks. Everyone sees the red
  "recording" notice.
- Files go to **Videos > SanWe's Recordings > (date and class name)**: `class.mp4` (H.264 + AAC) and `class_audio.m4a`.
  They are written while the class runs, so a crash loses seconds, not the class.
- **Ending the class stays manual**, as before: end the meeting from the host's **End** button. The bot then saves the recording and
  leaves. It also leaves by itself when everybody has gone home for 3 minutes.

## The board (on each class's row in Meetings)

Each class that runs by itself shows a line under it:

| What you see | What you can do |
|---|---|
| *Runs by itself, Next: Sat 04:30* | **Start the class now** (opens it immediately; the timeline counts from now) |
| *Class is running, Playing: (video), Then: (next video) at 04:40:00, Recording starts when the teacher speaks* | **Stop video**, pick a video and **Play now**, **Start recording** / **Stop recording**, **End class bot** |
| *Edge or Chrome not found* | install Microsoft Edge or Chrome on this computer (or set `BROWSER_PATH` in `.env`) |

One person can watch all of today's classes on this page. The bot's video is also visible in the meeting itself, so you can
watch it like any student.

A plan line under each class lists the clock times ("Plan: 04:30 AM Waiting song (repeats) -> 04:40 AM Prayer"), and after a class the row says
**Last class: finished / stopped from the board / stopped with a problem**. Every class run is also written to `data\logs\classes-<date>.log`.
Pressing **End class bot** ends the video player and recording for that class and it will **not** start again by itself that day.

## Several computers

Each computer is independent: its own accounts, videos, classes and recordings. To set up another one, double-click
**`make-copy-for-another-pc.bat`**. It makes `SanWes-for-another-PC.zip` on the Desktop **without** this computer's accounts,
meetings, videos or secret keys. On the other computer: install Node.js and Edge or Chrome, unzip, double-click
`start-sanwes.bat` (it makes that computer's own keys the first time), open the page, and **create the administrator account**.
Then schedule the classes there the same way. The classes run on every computer that has them scheduled.

## Recording protection (stop students recording)

See [ZOOM_CAPTURE_PROTECTION_REPORT.md](ZOOM_CAPTURE_PROTECTION_REPORT.md) for what REA found in Zoom and why a web page alone cannot do
this. In short, there are three settings, in the class form and in **Host tools > Advanced > Recording protection** while the class runs:

| Setting | What it does | How strong |
|---|---|---|
| Off | nothing | - |
| Watermark | each student's name and username float over the picture and tile across it (not shown to hosts and co-hosts). A leaked recording names its owner. Right-click and PrintScreen are blocked on the picture. | deters; works in any browser, phone or computer |
| Viewer app only | the watermark, **and** students must open the class in **SanWe's Viewer** (`build-sanwes-viewer.bat` makes `SanWes Viewer.exe`). Windows hides that window from screenshots, Game Bar, OBS and screen sharing: recordings show black. A student in an ordinary browser is refused with a message. Hosts and co-hosts can still use a browser. | blocks software recording on Windows. Not a lock: a phone camera pointed at the screen still works, and a determined person could pretend to be the Viewer to the server |

Give students the Viewer: send them `SanWes Viewer.exe` (the folder `desktop\dist\SanWes Viewer-win32-x64`), they paste the class
link. Phones: a Viewer app for Android (the same idea, `FLAG_SECURE`) is a later step; until then phone students need Watermark mode.

## How many students

The limit is **upload speed**, not the PC. Every student downloads the class video from the computer running SanWe's:

| Class video quality | 100 students | 400 students |
|---|---|---|
| Light (360p) | about 35 Mbit/s | about 140 Mbit/s |
| Standard (720p) | about 110 Mbit/s | about 440 Mbit/s |

plus the teacher's camera. A normal home connection (20 to 100 Mbit/s) fits about 100 to 250 students on Light; 400 students needs
a faster uplink or the media server on a cloud machine (see [LARGE_MEETINGS.md](LARGE_MEETINGS.md)). Light is the right choice for a
waiting-room song with a logo. Rooms hold up to 500 people (`MAX_PARTICIPANTS`).

## Files and settings

| What | Where |
|---|---|
| Video library | `data\media\` and `data\media.json` |
| Recordings | `C:\Users\<you>\Videos\SanWe's Recordings\` (change with `RECORDINGS_DIR` in `.env`) |
| Max video size | `MEDIA_MAX_MB` in `.env` (default 4096) |
| Browser for the bot | Edge or Chrome, found automatically; `BROWSER_PATH` in `.env` to choose |

## Tested

Automated runs on this laptop with real browsers and a private server: the class started itself at its time; the bot joined and
played a waiting video, switched to a second video at its minute and stopped; a student saw the video as a shared screen with
its sound track, 640x360 on Light; the picked co-host became co-host with no clicks and the creator host; the recording started
when the teacher spoke, and the saved `class.mp4` was H.264 1280x720 with AAC sound at a measured level, plus the sound-only file;
stopping from the board saved and left; the form's picker, upload, steps, quality note and editing worked; the Viewer-only class
refused a browser student and accepted the Viewer's header; the Viewer's window reports Windows' "excluded from capture" flag.

**Not tested:** 400 real students, a whole real-time day of repeats (a daily repeat was checked by calculation), other computers,
Android, a recording longer than a few minutes.

## Not built

Email or SMS to teachers, a different host than the person who saved the class, per-student recordings, DRM streaming, an
Android Viewer, approval of new accounts.
