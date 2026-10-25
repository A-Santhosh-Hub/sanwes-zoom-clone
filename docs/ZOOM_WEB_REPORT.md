# Report: Zoom in the browser, and which of its features SanWe's now has

Audience: the SanWe's developer team and the administrator. Produced with REA. Nothing was copied, no meeting was joined, and
nobody was signed in or out.

## What was looked at, and what was not

| Step | Tool | Result |
|---|---|---|
| Zoom's public web client page (`app.zoom.us/wc`), opened in a throwaway browser profile | REA `list_browser_targets`, `analyze_web_bundle` | 9 small scripts, no routes or endpoints worth noting: it is only the "enter a meeting ID" page |
| The Zoom Workplace web app (`web_client_pwa/7.2.0.3259`, the page's `main.js`, 1.1 MB, and `pwa-webim.js`) | REA `analyze_javascript_application` + identifier scan | 222 modules, 320,000 syntax nodes. It is the **chat, phone, whiteboard, notes, surveys and transcript** part of Zoom, not the meeting screen |
| The in-meeting web client | not served until you join a real meeting, which was not done | Replaced by Zoom's own **public Meeting SDK for the web (6.10.0)**, the same client Zoom ships as an embeddable component: REA structural pass on its 3.5 MB bundle (727,000 syntax nodes; minified, so no module names), plus its **UI text file (3,735 labels)** and **type definitions** as the feature inventory |

The downloaded Zoom files were deleted afterwards. REA's view of the minified bundle gives structure, not feature names; the feature
names below come from the labels the client shows its users, read as text.

## What the Zoom web client has, and where SanWe's stands

| Area (Zoom's own grouping) | Zoom web client | SanWe's |
|---|---|---|
| **Breakout rooms** (`wc_bo`, 143 labels) | create N rooms, assign automatically, manually or let people choose, timer and auto-close, broadcast a message, "ask for help", move people, return to main, countdown | **Built now.** Same set, plus hosts can visit any room. Rooms are LiveKit rooms named `<meeting>~b<n>`; the server decides who may enter. |
| **Polls and quizzes** (`polling`, 139) | single / multiple choice, correct answers (quiz), anonymous, launch, end, share results, download, relaunch | **Built now.** CSV download included. |
| **Q&A** (`wc_qa`, 67) | ask (anonymous too), upvote, answer in text or privately, "answer live", dismiss, reopen, My questions | **Built now.** |
| **Chat** (`wc_chat`, 62) | who can chat with whom, private messages, **file transfer**, save chat | Had everything but files. **Files built now** (25 MB, off for students by default, programs blocked). Not built: edit, delete and react to a message. |
| **Video** (`wc_video`) | **spotlight**, ask to start video, sort by name / entry, hide self view, name tags and pronouns | **Spotlight and ask to start video built now**; sorting and hide-self already existed. Not built: name tags and pronouns. |
| **Audio** (`wc_audio`) | **host asks to unmute**, mute all current and new, press and hold SPACE to unmute | **Built now:** ask to unmute, hold SPACE; mute all (current and new) already existed. |
| **Host tools** | allow everyone to chat / rename / unmute / start video / share / send reactions | Had all but "send reactions". **New switches:** files, Q&A, anonymous questions. |
| **Non-verbal feedback** (`wc_nonverbal`) | raise / lower hand, yes, no, go faster, go slower, coffee break, clap, away | Had these (raise hand, yes, no, faster, slower, coffee, be right back). **New:** the host can **lower one hand or all hands**; raised hands are queued in the order they went up. |
| **Webinar-style control** | attendees listen, **panelists** speak | **Allow to talk / take back the floor** per person: when unmuting is off for everyone, the host gives a student the microphone and camera for a question. |
| **Transcription** (`transcription`, 65 languages) | live captions and a transcript | **Built now, opt-in:** the host's browser turns their voice into text, everyone can show captions and save the transcript. 17 languages including the Indian ones. Needs the browser's own online speech service (Chrome or Edge); the dialog says so. |
| **Whiteboards** | shared boards, who may draw | Had. |
| **Recording** | local and cloud, **request permission to record** | Local recording had; class recording by the class bot ([CLASS_TASKS.md](CLASS_TASKS.md)); recording protection ([ZOOM_CAPTURE_PROTECTION_REPORT.md](ZOOM_CAPTURE_PROTECTION_REPORT.md)). Not built: a request-permission dialog. |
| **Security** (`wc_security`, 63) | report abuse (with screenshot), lock, waiting room | Lock and waiting room had. Not built: "Report abuse". |
| **Remote control** (`wc_remote_control`) | request and approve control of a shared screen | **Not built.** A web page cannot send mouse and keyboard input to another computer. |
| **Live stream** (`live_stream`) | YouTube, Facebook, custom RTMP | **Not built.** Needs LiveKit Egress (a separate server program). |
| **Language interpretation** (`interpretation`) | interpreters with their own audio channel | **Not built.** |
| **AI Companion, smart summary, My Notes** (`ai`, `smartSummary`, `myNotes`) | meeting summary, questions answered by AI | **Not built.** These need an AI service. |
| **Other** | simulive, NDI output, archiving, DLP, companion mode | Not built, outside this project. |

## Decisions

- Polls, Q&A, files, spotlight, asking and the floor are **server-side**: the server knows who is calling (from the caller's join
  token), keeps the state with the room (so a reload does not lose it) and refuses anything a browser could forge (a student making a poll,
  voting twice, reading others' answers, or sending "spotlight"). The page is told about changes with one data message and fetches
  what it needs. Nothing is sent on every vote, so a 400-person class does not flood itself.
- Breakout rooms reuse the normal join path: moving is "disconnect, ask for a token for room N, connect", so every existing feature
  (chat, share, host tools) works inside a room without special cases.
- Captions are text only and come only from hosts and co-hosts; a student cannot post a caption.

## Not tested

Real speech recognition (needs a human voice and the browser's online service; the sending, showing, permission and transcript
parts are tested), 400 real students, and phones.
