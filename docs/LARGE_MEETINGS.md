# Large meetings: 500 people in one room

Audience: the SanWe's developer team and whoever runs the server. Status: **500 people in one room works** on a laptop for
the media server and one real browser (measured below). **Over the internet from a home connection it is limited by upload
bandwidth, not by the code or the PC**; the last section says what to run instead.

## What REA showed about Zoom

REA (and a read-only string scan of the installed Zoom 7.1.9 components) did not show a number like "500" in the client,
which is the point: the cap is **a value the server hands the client per meeting**, and the client's job is to cope with it.
Identifiers in `zVideoApp.dll` and `zUIClient.dll`:

| Identifier | What it tells us |
|---|---|
| `max_room_user_limits`, `max_room_user_limits_enabled`, `nMaxRoomUserLimits`, `max_total_user_limits`, `boAttendeeCountLimit` | the room limit is a server-supplied setting, can be switched on or off, and exists per room and in total |
| `MeetMaxParticipantsPerScreen` | the gallery is **paged**: a settable number of people per screen, not everyone at once |
| `z_GalleryView_SortType` | the gallery has a sort order (people with video first, and so on) |
| `LimitUplinkBandwidth.attendee_num` | the client lowers its own upload as the number of attendees grows |
| `z_WebinarMaxSharingCount` | sharing is capped separately in large events |

Ghidra's full import of `zVideoUI.dll` (14.5 MB) timed out at 15 minutes, so this is the identifier inventory, not decompiled
logic. Zoom's own public plan tiers for interactive meetings are 100 / 300 / 500 / 1000 people (from memory; check zoom.com).

## What SanWe's does about it

| Problem at 500 people | What was done |
|---|---|
| The media server's port range was 50000-50200, so at most about 200 connections | `livekit.yaml` now uses one shared UDP port, `udp_port: 7882` |
| Room cap was hard-coded at 100 | `MAX_PARTICIPANTS` (default **500**, set in `.env`); the media server refuses person 501 (tested) |
| Everyone subscribing to everyone is N x N streams | Above 30 people each browser **subscribes only to what it shows**: the 25 pictures on its page, the current speaker in Speaker view, every screen share, plus the voices of hosts and the ten most recent speakers (speaker detection runs on the server, so it works for tracks you have not subscribed to) |
| 500 tiles in the page | **Paged gallery**, 25 per page, pager in the top bar. Order: you, hosts, people with camera on, everyone else |
| 500 rows in the people list | at most 100 rows drawn, redrawn at most 2.5 times a second, with a **search box** |
| Event storms (everyone's mic, hands, pictures) | redraws throttled to about 7 per second; join / leave lines are not added to chat above 30 people; at most 20 reactions per second are drawn; profile pictures are not broadcast in rooms of 100+ |
| Chat recipient list of 500 names | above 30 people the list is Everyone plus the hosts |

Small meetings (30 or fewer) behave as before: everything is subscribed and shown.

## Measured on this laptop (Core i5-10300H, 4 cores / 8 threads, GTX 1650, 15.8 GB, Wi-Fi)

Tools: LiveKit's own `lk load-test` (v2.19.2, checksum verified) filling the room with simulated participants, plus one real
Chrome window running the SanWe's page. The simulated people run on the same laptop as the server, so the numbers are
pessimistic for the server alone.

| Test | Result |
|---|---|
| 1 camera + 2 mics, **100** listeners | 0% loss; media server about 0.75 CPU cores, 370 MB |
| same, **500** listeners | all 1500 tracks delivered, 0 errors; about 90 Mbit/s out in total (about 180 kbit/s each); media server about 2.5 cores and 1.7 GB; 2.65% loss, most likely the laptop running out of CPU while also simulating 500 clients |
| **499 people** (478 listeners + 20 cameras + 20 mics) with a real browser in the room | gallery 25 tiles, **20 video + 2 audio tracks subscribed of 40 published**; people list 100 rows; search works; paging works; page busy 135 to 355 ms per 10 s, a click shows in 25 ms; chat and hand raise work; JS heap about 10 MB; media server memory about 3.2 GB |
| 511 people trying to join | the room stops at exactly **500** |

Not measured: a real device per person (simulated listeners do not decode video), phones, bad networks.

## Hardware: what matters and what does not

- **GPU: not used by the media server.** It forwards packets; it never decodes video. The GTX 1650 only helps the presenter's
  browser encode a screen share.
- **CPU:** forwarding cost follows packets per second, so it follows how much video is delivered. Roughly 2.5 cores per
  100 Mbit/s of outgoing media on this class of CPU (an estimate from the test above); 1 Gbit/s of outgoing media wants
  8 or more fast cores.
- **Network:** this is the limit. Outgoing bandwidth is the sum of what every viewer receives:

| Scenario (500 viewers) | Outgoing bandwidth |
|---|---|
| one speaker camera at low resolution (the test above) | about 90 Mbit/s |
| one 720p screen share at 1.5 Mbit/s | about 750 Mbit/s |
| one 1080p60 screen share at 4 Mbit/s | about 2 Gbit/s |
| a full gallery page of 25 cameras at 150 kbit/s each | about 1.9 Gbit/s |

A home connection has perhaps 20 to 100 Mbit/s of upload, which carries roughly 100 to 500 viewers of **one low-resolution
camera**, or 15 to 65 viewers of a 720p screen share. **The Wi-Fi laptop is fine for a LAN event of 500, but not as the
internet-facing server for 500.**

## Running a 500-person event over the internet

1. Put the media server (`livekit-server`) on a machine with a fast, wired connection: a cloud VM with 8 or more vCPUs and
   a 5 to 10 Gbit/s network port, or LiveKit Cloud. The Node app can stay where it is (it only hands out tokens).
2. Open `7881/tcp` and `7882/udp` to the media server (and 443 via Caddy for the web page and signalling, see
   `deploy/Caddyfile`). Add TURN over TLS on 443 (`deploy/livekit.prod.example.yaml`) so people behind strict firewalls connect.
3. Set `TOKEN_RATE_MAX` high (for example 2000). It limits token requests **per IP per minute**; a company or school behind one
   address would otherwise be blocked while 500 people arrive.
4. Keep the number of people on camera small (the host and a few speakers); everyone else listens and watches. Lower the
   screen-share preset for big audiences.
5. Beyond about 1000, or to spread load, LiveKit can run several media servers behind Redis; that is not set up here.

Rehearse with `lk load-test` against your server before the event:
`lk load-test --room test --video-publishers 5 --subscribers 450 --num-per-second 20 --duration 120s`.
