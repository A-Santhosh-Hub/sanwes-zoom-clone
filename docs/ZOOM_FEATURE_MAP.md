# Zoom feature map for SanWe's

Audience: the SanWe's developer team. Purpose: record what Zoom's meeting product does, how each feature works in principle,
and how SanWe's implements it. Every row has a status, so this doubles as the roadmap.

## How this was produced, and where the line is

- **Analysis (REA + Ghidra, read-only).** Installed Zoom 7.1.9 (valid Zoom Communications signature) was inspected. Its
  launcher `Zoom.exe` is small (1,313 functions, 1,324 strings) and loads about 250 separate components by name. Those names,
  plus Zoom's public feature set, are the evidence for the feature list below.
- **Looked at the real client, not inside it.** For the home, join and scheduling screens, the installed client was opened and its own windows were viewed on screen (layout only; nothing was extracted). Those screenshots were deleted afterwards.
- **Second pass (host tools, record, whiteboard, settings).** Zoom was opened, an instant meeting was started, and its Host tools pages, Participants and Advanced pages, More menu, local-recording controls, whiteboard window and in-meeting Settings were viewed on screen (wording and layout only; screenshots deleted). REA was also pointed at the installed meeting UI component (`zVideoUI.dll`, 14.5 MB): Ghidra's full import did not finish inside its 15-minute limit, so the evidence from REA for this pass is the component inventory (`zWBUI.dll` whiteboard, `zmbRecord.dll` recording, `zSettingUI.dll` settings, `CptShare.dll` capture) and the literal feature identifiers read from the file (for example `allowWhiteboardShare`, `RecordInProgressMenu`, `Start Recording from Meeting Control Menu`). The behaviour above comes from using the client, not from its code.
- **Not done, on purpose.** Zoom's video, audio, network and crypto components were **not decompiled**, and nothing from Zoom
  was copied. Its internal protocol and engine are proprietary, and SanWe's does not need them: the same features are built
  from scratch on open components (LiveKit SFU, WebRTC, MediaPipe, RNNoise).
- **"Same architecture" therefore means the same shape, not the same code.** The comparison is in the next section.

## Architecture: Zoom (as inferred) vs SanWe's

| Concern | Zoom | SanWe's |
|---|---|---|
| Client | Native Windows app made of many modules (`zVideoApp`, `zRenderEngine`, `zChatUI`, `zSipCallApp`, `CptShare`, `zNet`, `zNetDiagnostic`, `zmbRecord`, `ZoomSpeechSDK`...) | Browser client in ES modules: `main.js` (call), `meeting.js` (people, host tools, hand, reactions), `background.js`, `noise.js`, `gain.js` |
| Media servers | Zoom's own multimedia routers | LiveKit SFU (open source) |
| Control plane | Web services: scheduling, auth, waiting room, host actions | Node/Express token server: tokens + roles, waiting-room tickets, `/api/host/*` |
| On-device AI | OpenVINO and ONNX Runtime (background blur, noise reduction, speech) | MediaPipe segmentation (blur / virtual background) and RNNoise (noise suppression), both run in the browser, served from the app |
| Screen capture | Dedicated capture module (`CptShare`) with "share computer sound" and "optimize for video" | `getDisplayMedia` with its own stereo audio track; separate "Share video" path from a file |
| Diagnostics | `zNetDiagnostic` | Connection health panel (path, RTT, loss, jitter, stretching, shared-sound level) |
| Recording / transcode | `zmbRecord`, `zmbTranscode` | Planned |

## Feature map

Status: **Done** (built and tested), **Next** (planned, fits the current design), **Infra** (needs servers or accounts),
**Skip** (outside this project).

### Joining and access
| Feature | Purpose | How it works | In SanWe's | Status |
|---|---|---|---|---|
| Accounts, sign in / sign out | Know who is in the meeting; keep meetings and roles with a person | Server-side accounts and sessions | Create account (username, password twice, email twice), Sign in, Keep me signed in, Sign out, Sign out of all devices, change password, delete account, administrator tools; hosts and co-hosts follow accounts. See [ACCOUNTS.md](ACCOUNTS.md) and [ZOOM_ACCOUNTS_REPORT.md](ZOOM_ACCOUNTS_REPORT.md) | Done |
| Join by link | Invite someone with one URL | URL carries the room id | `/?room=<name>`; **Invite** button copies it | Done |
| Passcode | Stop uninvited people | Server checks a secret before issuing a media token | Set at room creation; compared in constant time; lockout after repeated failures | Done |
| Waiting room | Host admits each person | Guest gets a ticket instead of a token until the host approves | `/api/token` returns 202 + ticket; `/api/join-status`; full-screen "Please wait, the meeting host will let you in soon." for the guest; host and co-hosts Admit / Deny / Admit all; admitted guests can rejoin after a drop | Done |
| Lock meeting | No new joins | Server refuses tokens | Host toggle | Done |
| Join by meeting ID | Enter a number or paste a link | 10-digit meeting id; link carries `?room=<id>&pwd=<passcode>` | **Join** dialog (id, name, "Don't connect to audio", "Turn off my video"); unknown numbers are refused as "Invalid meeting ID"; an invitation link opens the dialog already filled in | Done |
| Schedule a meeting | Plan one-off or repeating meetings | Server-side schedule: topic, start/end in a chosen time zone, repeat, invitees, id mode, passcode, options | **Schedule** dialog ("New event"): topic, start and end (end follows start), time zone, Repeat (Never / Daily / Weekly / Monthly), invitees, Generate automatically or Personal Meeting ID, agenda, **More Options** (passcode, waiting room, host and participant video, mute on entry, join before host, calendar). Saved to `data/meetings.json` | Done |
| Invitation and calendar | Tell people when and how to join | Invitation text, `.ics` file, calendar link | After saving: invitation text (topic, time, repeat, link, meeting id, passcode, agenda) with **Copy invitation**, **Google Calendar** and **Outlook / .ics** (standards-compliant file with repeat rule and attendees) | Done |
| Start a scheduled meeting | Host opens it when the time comes | Owner proves ownership; server creates the live room and returns the host secret | **Start** from Home or Meetings; also restores host rights after a reload or server restart | Done |
| Meeting not started | Guests arrive early | Server answers "not started"; client polls | Full-screen "The meeting has not started. Please wait for the host to start this meeting." then joins automatically; or **join before host** if allowed | Done |
| Meeting reminders | Be told before a meeting starts | Reminder times are computed in the browser from your scheduled meetings; one card per meeting, a chime, and a desktop notification when the tab is in the background | **Settings > General**: default reminders (at the start, 1, 2, 5, 10, 15, 30 min; several at once), sound, desktop notifications, **Send a test reminder**. The schedule dialog has **Remind me** (my defaults, none, or up to two times for that meeting). The card says "Starts in 5 minutes" with **Start**, **Snooze** (1 minute) and **Dismiss**; opening the page late shows one card with the real time left; a reminder never repeats after a reload. Home rows show "Starts in N min". The **.ics** file carries the same alarms (`VALARM`) so a calendar app rings even when SanWe's is closed | Done |
| Personal Meeting ID | A permanent room per user | One reserved id per owner | Shown on the Meetings page with **Start** and **Copy invitation**; usable from the Meet menu or the schedule dialog | Done |
| Instant meeting | Start now | Create a room with a fresh 10-digit id | **Meet** tile; menu: "Start with video on", "Use my Personal Meeting ID" | Done |

### Roles and host controls
| Feature | Purpose | How it works | In SanWe's | Status |
|---|---|---|---|---|
| Host | Owns the meeting | Secret issued at creation; token metadata carries the role | Host / member / spectator roles | Done |
| Participants panel | See who is here and their state | Live participant list | **People** tab: host badge, mic and camera state, hand | Done |
| Mute one / mute all | Control noise | Server-side track mute through the LiveKit API | Host buttons; participants can unmute themselves | Done |
| Remove participant | Eject someone | Server removes them and revokes their ticket | Host **Remove**, with confirmation | Done |
| Make host | Hand the meeting over | The host's role moves to another person; the old host becomes a co-host and the old secret is retired | Row **...** menu > **Make host** (host only) | Done |
| Co-host | Share host powers | Host puts an identity on a co-host list; the co-host proves it with their own signed LiveKit token | **Make co-host / Revoke co-host** (host only). A co-host can admit from the waiting room, mute, remove and lock, but cannot end the meeting, make co-hosts, or act on the host or another co-host. Enforced by the server | Done |
| End meeting for all | Close the room | Delete room via API | Host-only **Leave** menu: "End meeting for all" / "Leave meeting"; everyone else is told the host ended it | Done |
| Spotlight video | Put one person on everybody's stage | Room setting lists the spotlighted people | Row menu > **Spotlight video** / Remove; **Remove spotlight for everyone** | Done |
| Ask to unmute / start video | Nudge a person | Private data message | Row menu > **Ask to unmute** / **Ask to start video**; the person gets a banner with a button | Done |
| Allow to talk | Let one student speak when everybody is muted | Per-account permission on the media server | Row menu > **Allow to talk** / **Take back the floor** | Done |
| Lower hand / lower all hands | Manage questions | Server clears the hand attribute | Row menu and People > More; hands are queued in the order they went up | Done |
| Hold SPACE to talk | Quick unmute | Key handler | Press and hold SPACE while muted | Done |

### Communication
| Feature | Purpose | How it works | In SanWe's | Status |
|---|---|---|---|---|
| Audio and video calls | Core | WebRTC through an SFU | LiveKit; 64 kbit/s Opus voice; echo cancellation | Done |
| Raise hand | Ask to speak | Participant attribute synced to all | **Raise hand**; host is notified and sees the hand in People | Done |
| Reactions | Quick feedback | Small data message, animation | Whitelisted emoji only, floating animation | Done |
| Chat | Text | Data messages | Message panel, plain-text rendering, length cap. A **To:** list sends to everyone or to one person (private messages travel only to that person). The chat **...** menu: **Save chat** (text file) and, for hosts, **Allow participants to chat with: No one / Host only / Everyone** | Done |
| File sharing in chat | Send files | Upload + link | The paperclip in chat sends a file (up to 25 MB) to this computer; people who were in the meeting download it; host switch **Send files in chat** (off for students by default); programs and web pages are blocked for students | Done |
| Polls and quizzes | Quick votes | Server keeps the poll; one vote per account | More > **Polls**: single or multiple choice, correct answers (quiz), anonymous, launch, end, share results, download CSV | Done |
| Q&A | Questions from a big audience | Server keeps the questions | More > **Q&A**: ask (anonymous too), upvote, answer in text or privately, answer live, dismiss; host switch to turn it off | Done |
| Live captions | Accessibility | Speech-to-text on audio | More > **Captions**: the host's browser turns their voice into text (the browser's online speech service), everyone shows captions and can save the transcript | Done (speech itself untested) |

### Sharing
| Feature | Purpose | How it works | In SanWe's | Status |
|---|---|---|---|---|
| Screen share | Show your screen | `getDisplayMedia` published as video | Resolution, frame rate, format, bitrate, preset, optimize for detail or motion | Done |
| Share computer sound | Include audio | Separate audio track | Own stereo track (128 or 256 kbit/s), no silence suppression, own volume boost | Done |
| Share video file | Watch a clip together | Play a file locally and publish it | **Share video** with pause, seek, volume bar; measured clean sound | Done |
| Speaker / gallery view | Layout | Client-side layout; active speaker from LiveKit | **View** menu: Speaker (active speaker large, others in a strip) and Gallery (auto-fit grid); a screen share takes the stage; pin; theater stage | Done |
| Whiteboard | Draw together | Shared canvas via data messages | **More > Whiteboards > New whiteboard**: pen, highlighter, eraser, shapes (rectangle, ellipse, line, arrow), text, sticky notes, colours, three sizes, undo / redo, zoom, move, **Save as image**, **Clear**. Everyone follows the board automatically, people who join later receive it, and the host decides who may draw (Host tools > Advanced > Whiteboard). **Stop** closes it for everyone | Done |
| Annotation on a shared screen | Draw on top of a share | Overlay canvas | Not yet | Next |

### Audio and video quality
| Feature | Purpose | How it works | In SanWe's | Status |
|---|---|---|---|---|
| Background noise suppression | Remove fans, typing | Neural model on the mic | RNNoise (WASM), on by default, switchable | Done |
| Virtual background / blur | Privacy | Person segmentation on each frame | MediaPipe model, blur and three built-in backgrounds, fully offline | Done |
| Device selection | Pick mic, speaker, camera | `enumerateDevices` | Settings | Done |
| Network diagnostics | Explain bad calls | WebRTC stats | Connection health panel | Done |
| Reconnect | Survive drops | Retry + rejoin | Automatic retry with countdown | Done |

### Larger features
| Feature | Purpose | How it works | In SanWe's | Status |
|---|---|---|---|---|
| Breakout rooms | Split into groups | Several rooms, host assigns people | More > **Breakout rooms**: create, assign automatically / by hand / let people choose, open, broadcast, ask for help, move people, visit, timer, 60-second close countdown, back to main | Done |
| Local recording | Keep a copy | A canvas drawn from the visible tiles (or the shared screen / whiteboard) plus a Web Audio mix of every voice and shared sound, written by MediaRecorder straight into **MP4 (H.264 + AAC) and M4A** | **More > Record**: red **REC** badge with the time, a red **Record** button in the toolbar with **Pause / Resume / Stop recording** and **Recording settings**. You choose what to keep (Settings > Recording): **Video with sound (MP4)**, **Video only (MP4, no sound track)**, **Audio only (`audio_only.m4a`)**, **a separate sound file for each participant (`Audio Record/<name>.m4a`)**. One kind of file downloads as is; several come in one `.zip`. No conversion wait after Stop. If nobody was unmuted you are warned that no sound was captured. Everyone is told when you start or stop, and the host decides whether participants may record. Nothing is uploaded | Done |
| Cloud recording, transcripts | Server-side archive | LiveKit Egress + storage | Not yet | Infra |
| Phone dial-in | Join by phone | SIP trunk | Not yet | Infra |
| Calendar / mail integration | Invites | Third-party APIs | Not yet | Infra |
| Translation, AI summary | Understanding | Speech + language models | Not yet | Infra |
| End-to-end encryption | Privacy | Per-room keys in the client | Supported by LiveKit; not enabled | Infra |
| Zoom Phone, Mail, Clips, Contact Center | Other Zoom products | n/a | n/a | Skip |

### How reminders were modelled (REA)

A read-only scan of the installed Zoom 7.1.9 components (`zUIClient.dll`, `zPreMeetingApp.dll`, `zCalendarUI.dll`) found:
`InitRemindUncomingMeeting` and `NotiUpcomingMeetings` (a notification setting "remind me before upcoming meetings"),
a calendar model with a **list** of reminders per event (each a method plus minutes: `eventReminder_s`, `CalendarReminder_`,
`ReminderMethod`), account-wide `defaultReminders` / `defaultAllDayReminders`, a `remindOnRespondedEventsOnly` filter, and a
dedicated `meeting_reminder_toast`. SanWe's follows the same shape: default reminders, per-meeting reminders, a list of
several, a toast. It does not copy any Zoom code.

Limits: reminders fire while SanWe's is open in a browser tab (a background tab's timer can be up to a minute late). Guests
have no accounts and no server push, so a closed page cannot ring; that is what the calendar-file alarms are for. Only the
meetings scheduled in this browser (your owner key) get reminders; people you invite get the alarm through the `.ics`.

### How recording was modelled (REA)

A read-only scan of the installed Zoom 7.1.9 recorder (`zmbRecord.dll`, `zmbTranscode.dll`, `zUIClient.dll`) found the file
names and the pipeline: `audio_only.m4a` (all sound in one file), `Audio Record\` (one sound file per person, switched by
`RecSeparateAudioFiles`), `zmb.muxer.mp4` / `playback_vlcplayer.mp4` (the video with sound) and `playback.m3u`. The converter
(`zmbTranscode.dll`) contains an MP4 muxer with AAC sample entries next to a bundled FFmpeg (`avcodec_zm-61.dll`): the client
records into a working file and rewrites it into standard MP4 / M4A when the meeting ends (the "will be converted to MP4"
message). SanWe's offers the same three kinds of output and writes the standard formats directly, so there is no wait.

Why the old files seemed to have no sound: they were WebM with Opus audio. Tests with live microphones showed the sound *was*
in them, but common Windows players (Movies & TV, Windows Media Player) show the picture and play no sound for Opus-in-WebM.
MP4 with AAC plays everywhere. Where the browser cannot write MP4 (older Chrome, Firefox) files are saved as WebM and the
Settings page says so; VLC and Chrome play those.

## Home screen and Meetings page (desktop-client layout)

Drawn after a look at the installed client's layout, with original icons and colours:

- **Left rail:** Home, Meetings, Settings. **Top bar:** search ("Search meetings (Ctrl+E)") and the profile avatar (name).
- **Home:** large clock and date; five rounded tiles: **Meet** (orange, with a menu), **Join**, **Schedule**, **Share** (instant meeting, then pick what to share), **Game room** (this project's main concept); an upcoming-meetings card for the day ("Today, Oct 23", Today button, previous/next day, "No meetings scheduled" empty state); a **Live rooms** panel.
- **Meetings page:** mini month calendar (today circled, dots on busy days), a **+** button, toolbar with Today, arrows, month title and an **Agenda / Day** view menu, event rows (time, topic, meeting id, repeat) with Start / Copy invitation / Edit / Delete, and the **Personal meeting ID** panel.
- Dialogs are light, like the desktop client's; the in-meeting window is dark.

Not cloned (outside this project): Team Chat, Phone, Hub, Notes, AI assistant, account sign-in and plans. SanWe's has no accounts: a name and a private key stay in the browser.

## Interface (in-meeting window)

Drawn after starting an instant meeting in the installed client and looking at its own windows (layout, wording and behaviour only; own icons, own colours, no Zoom assets, no code):

- **Top bar:** product wordmark, **meeting-info button** (title; opens a popup with invite link + copy, meeting ID in groups, passcode, host, type, and a Host tools shortcut), a green **shield** when the room is protected, the elapsed **timer**, and a **View** menu (Speaker / Gallery).
- **Bottom toolbar** (icon over label, each with its own state):
  **Audio** with a caret (devices: microphone and speaker lists, Microphone modes *Noise suppression* / *Original sound for musicians*, **Test speaker & microphone**, **Leave computer audio**, Audio settings) ·
  **Video** with a caret (camera list, blur switch, Video settings) ·
  **Participants** with a count ·
  **Chat** with an unread badge ·
  **React** (effects, emoji row, feedback buttons such as yes / no / slower / faster, **Raise Hand**, **Be right back**) ·
  **Share** with a caret (what to share, optimize for video, share sound) ·
  **Host tools** (host and co-hosts only) ·
  **More** (Share video, Meeting info, Invite, Settings) ·
  a red **End** button that opens "End meeting for all / Leave meeting / Cancel" for the host, "Leave meeting" for everyone else.
- **Side panels:** Participants (rows "Name (Host, me)", "(Co-host)", mic / camera state, status chips, a **...** menu per person with Mute, Make / Remove co-host, Remove; footer **Invite**, **Mute All**, **...**; a **Waiting room (n)** block with Admit / Deny / Admit all) and Chat (the "Everyone" tab, a "Who can see your messages" note).
- **Host tools pane:** switches for **Waiting room**, **Share screen** (participants may share), **Chat** (participants may chat) and **Lock meeting**; **Waiting room**, **Lock** and **Share screen** are enforced on the server (new guests are held or refused; members' media permissions drop the screen-share sources, so a forged share attempt fails). **Chat** is applied by every client (the message box is disabled for participants; the host and co-hosts can still write) and is not enforced by the server. Room settings are stored in the live room's metadata so everyone's toolbar updates at once.
- **Before you enter:** a **preview window** (camera picture or initial avatar, microphone and camera pickers, **Backgrounds**, "Always show this preview when joining", **Start** / **Join**). Closing it cancels. The choice is remembered.
- **After you leave:** the call appears under **Recent** on Home (title, date, time range, host, **Rejoin**, **Remove**), kept in this browser only.
- **Waiting room screen** for guests, **speaker highlight** on whoever is talking, floating **reactions** (bigger for the effects row).

Deliberately not copied: Zoom's logo, icon artwork and colour palette.

- **Settings** (More > Settings, or from the Audio, Video, Share and Record menus): a category list on the left: **Video & effects**, **Audio**, **Display & controls**, **Recording**, **Share screen**, **Statistics** (connection health).

Not built yet from the same session: captions, breakout rooms, polls, apps and docs, private-chat tabs, post-meeting survey, auto-framing, personalized audio isolation, AI features.

## Shared-screen view (View menu, strip of people, side-by-side)

What the real client does when someone shares (looked at in a screenshot of a live consultation meeting, plus REA):

- **People strip across the TOP, picture below.** Small thumbnails, names under them (not over), the active speaker outlined in green, a drag handle between strip and picture.
- **View menu** (top right): Standard, Side-by-side: Speaker, Side-by-side: Gallery, Dynamic gallery, Multi-speaker, Immersive; Sort gallery by; Follow host's video order; Change theme; Set meeting wallpaper; Hide self view; Hide non-video participants; Swap video and shared screen; Show meeting timers; Fullscreen.
- **The sharer** sees a small toolbar (Annotation, Share audio, Stop share), not a copy of their own screen.
- **Mute all** asks first: "Mute all current and new participants", with **Allow participants to unmute themselves**, **Yes / No**.

REA findings in the installed client (read-only string scan, `zVideoUI.dll`, `zUIClient.dll`, `zVideoApp.dll`, `zm_conf_universal_ui.dll`):

| Identifier | Meaning for the design |
|---|---|
| `SubMenuViewMode`, `ISubMenuViewModeSink`, `CShareFactorToolBar::SubMenuViewModeClick`, `GetViewModeCurSelectedId` | the View menu is one shared sub-menu, also reachable from the share toolbar; one selected layout at a time |
| `ImmersiveSharePort`, `ImmersiveVideoPort`, `CProctorModeSideBySideSharePort`, `...SideBySideVideoPort`, `ShareSideBySide`, `UpdateSideBySideControls` | side-by-side is two separate areas: a **share port** and a **video port** |
| `DynamicGalleryView::Layout`, `OnFitDisplayChange`, `OnShowHideMySelfChanged`, `OnUserVideoStatusChanged`, `OnVideoResolutionChanged` | the gallery is re-laid-out whenever someone's video, resolution or your self-view changes |
| `MultiSpeakerStrategy`, `OnClickMultiSpeakerViewButton`, `z_GalleryPlusLayoutMode`, `z_LSViewMode`, `multi_speaker_enabled` | layout mode is a number held in settings; multi-speaker is a strategy object |
| `MeetHideSelfVideo`, `MenuMeetingTimers`, `UpdateShowMeetingTimers`, `is_switch_video_as_share` | hide self view, show meeting timers and swap-video-and-share are plain on/off settings |
| `z_GalleryView_SortType` | the gallery has a sort type |
| `LocalShareToolbar` | the sharer's own floating toolbar |
| `HostMuteAll`, `ToggleAllowUnmute`, `check-allow-unmute-self-audio-feature`, `Cmm_OnDisallowUnmuteselfStatusChanged`, `PSSendAllowUnmuteAudioListUpdate` | mute all and "allow to unmute themselves" are separate host actions; the server also keeps a per-person allow-unmute list |
| `PreSubScribe`, `ShowVideoAsWallView`, `CanRecvVideoEx` | the client subscribes to video selectively |

How SanWe's does it (own layout code, own icons):

| Zoom | SanWe's |
|---|---|
| Standard | **Standard**: with a share, people strip on top (height set by dragging the handle, remembered; double-click resets), picture below; without a share, the gallery |
| Side-by-side: Speaker / Gallery | **Side-by-side: Speaker** (the picture left, only the active speaker right) and **Gallery** (picture left, a column of people right) |
| Speaker / Gallery | **Speaker** (active speaker large, strip on top) and **Gallery** |
| Sort gallery by | **Joined first** (you first), **Video on first**, **Name (A to Z)** |
| Hide self view / Hide non-video participants | the same two switches; people stay in the Participants list |
| Swap video and shared screen | the active speaker takes the stage, the shared screen moves into the strip |
| Show meeting timers, Fullscreen | the same |
| Sharer's toolbar | the sharer sees **"You are sharing your screen"** with the sound state and **Stop share**, not a mirror of their own screen (the stream is still attached underneath, so recording still captures it) |
| Mute all | **Mute all current and new participants** dialog: "Allow participants to unmute themselves", Yes / No. Yes mutes everyone now, mutes anyone who joins later (`muteOnEntry`) and, if unticked, turns **Unmute themselves** off for everyone |
| Green speaker outline | the active speaker is outlined in green |

Not built: Dynamic gallery, Multi-speaker, Immersive, Follow host's video order, Change theme, Set meeting wallpaper, the per-person allow-unmute list. On a phone held upright the side-by-side layouts fall back to the Standard layout (content on top, people below).

## Phones and narrow windows

- **Home:** the menu is a bar along the bottom; Recent and the five tiles fit the width.
- **Meeting:** one swipeable row of controls with **End** pinned at the right; panels (chat, participants, host tools) take the whole screen; menus are limited to the screen width. The picture area can no longer grow past the screen, so the participant strip never runs under the controls.
- **Shared video, tall or wide:** a **portrait** share fills the space with people in a strip underneath; a **landscape** share is only as tall as its shape needs, with everyone else in a two-column grid below it. Held **sideways**, the title bar and button labels go away and the picture gets the screen.
- **Shared screens on a phone:** **pinch** to zoom (up to 5x), **drag** to look around, **double-tap** to zoom in and out. **Fullscreen** turns the phone sideways for wide pictures and keeps portrait pictures upright (Android Chrome; elsewhere rotate by hand).
- Phone browsers cannot share a screen (no `getDisplayMedia`), so the Share button is hidden there; a phone can still send camera and sound and watch shares.
- Not analysed with REA: the Zoom phone app. REA's Android tools need `adb` (Android platform-tools) and a phone with USB debugging, neither of which is on this PC; the behaviour above follows how the video-meeting phone clients commonly work, and was tested in a phone-sized browser, not on a physical phone.

## Where the project's main concept fits

The game theater (host streams a game, spectators watch) and request-to-play build directly on what exists now: roles,
the host-only API, participant attributes (hand raise becomes "request to play"), and data messages (controller input).
Next phase: **request to play** with host approval, then the Windows companion app for controller input.

## Class tasks and recording protection

| Zoom (what REA showed) | SanWe's |
|---|---|
| Auto co-host is a paid extra | picked accounts become co-host when they join ([CLASS_TASKS.md](CLASS_TASKS.md)) |
| `SetWindowDisplayAffinity` on every meeting window, `RequestRecordPermissionDlg`, `ConfWaterMarkerHelp`, audio watermark | the Viewer app uses the same Windows switch; recording stays a host right; per-student watermark ([report](ZOOM_CAPTURE_PROTECTION_REPORT.md)) |
| (not in Zoom) scheduled auto-start, video timeline, auto-record | class bot, `server/tasks.js`, `client/src/bot.js` |

## Known limits

- Rooms, host secrets, passcodes, tickets and locks live in server memory: a server restart ends active meetings' host rights.
- Removing someone does not ban them; they can ask again through the waiting room (if enabled).
- Browser-side effects (blur, noise suppression) need a reasonably modern Chromium-based browser.
- Automated browser tests were used during development but are not committed to the repository yet; adding them under
  `tests/` is recommended before more features land.
