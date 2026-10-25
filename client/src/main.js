import { createNoiseProcessor } from './noise.js';
import { createGainProcessor } from './gain.js';
import { initMeeting } from './meeting.js';
import { initHome } from './home.js';
import { initAccount } from './account.js';
import { initProtect } from './protect.js';
import { initClassroom, CLASS_TOPIC } from './classroom.js';
import { initGameHub, RP_TOPIC, RPI_TOPIC, gamePreset, tuneStream } from './gamehub.js';
import { initBreakoutUi } from './breakout.js';
import { initCaptions, CC_TOPIC } from './captions.js';
import { initRecorder } from './record.js';
import { initWhiteboard } from './whiteboard.js';
import { $, store, TYPE_LABEL, coverEl, fmtId, paintAvatar } from './ui.js';
import { BACKGROUNDS, backgroundsSupported, makeBackground } from './background.js';
import { Room, RoomEvent, Track, DisconnectReason, ConnectionState, supportsAudioOutputSelection } from 'livekit-client';

const joinSec = $('join'), callSec = $('call'), grid = $('grid'), stage = $('stage'), stageArea = $('stage-area');
const audioSink = document.createElement('div');
audioSink.hidden = true;
document.body.append(audioSink);

const CHAT_TOPIC = 'sanwes.chat';
const CHAT_MAX_LEN = 500, CHAT_MAX_MSGS = 200;
const MAX_REJOIN = 6;
const FATAL_REASONS = new Set([DisconnectReason.CLIENT_INITIATED, DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.ROOM_DELETED]);
const FATAL_MESSAGES = {
  [DisconnectReason.DUPLICATE_IDENTITY]: 'You joined from another tab or device.',
  [DisconnectReason.PARTICIPANT_REMOVED]: 'You were removed from the room.',
  [DisconnectReason.ROOM_DELETED]: 'The host ended the meeting.',
};

// Large meetings: above BIG people the room switches to paged galleries and selective subscriptions, so each browser
// receives only the ~25 pictures on its page, the current speaker and a few voices instead of hundreds of streams.
const BIG = 30, PAGE = 25;
let page = 0, pageCount = 1, desiredVideo = new Set();
const recent = new Map(); // identity -> when they last spoke
const isBig = () => !!room && room.remoteParticipants.size + 1 > BIG;
let room = null;
// session = { name, roomName, password, hostSecret, role, meta, joined, left, media: { mic, cam } } while in (or joining) a call.
let session = null;
let rejoin = null; // { go, timer } while waiting to retry
const tiles = new Map(); // key -> { key, el, video, avatar, label, pin, track }

// View state: undefined = auto (focus the first screen share, else gallery), null = user chose gallery, string = pinned tile key.
let pinned;
let knownScreens = new Set();

let unread = 0;

// ---------------------------------------------------------------- join / connect

async function fetchToken({ roomName, name, password, hostSecret, ticket }) {
  let res;
  try {
    res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: roomName, name, password, hostSecret, ticket }),
    });
  } catch {
    throw Object.assign(new Error('Cannot reach the server. Check your connection.'), { network: true });
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.auth) window.dispatchEvent(new Event('sanwes:signed-out'));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Token request failed (${res.status})`), { status: res.status, passwordRequired: !!body.passwordRequired });
  return body;
}

// media: { mic, cam } chosen in the join dialog; cam left undefined lets the meeting's own default decide.
async function startJoin({ name, roomName, password = '', hostSecret = '', media = {}, autoShare = false }) {
  if (session) return { ok: false, error: new Error('Already joining a meeting.') };
  session = { name, roomName, password, hostSecret, role: 'member', meta: {}, joined: false, left: false, autoShare, joinMedia: media, media: { mic: media.mic ?? true, cam: media.cam ?? false } };
  try {
    await connect();
    store.set('sanwes.room', roomName);
    return { ok: true };
  } catch (ex) {
    session = null;
    return { ok: false, error: ex };
  }
}

// ---------------------------------------------------------------- camera background (blur / virtual background)

const bgChoice = () => (BACKGROUNDS[store.get('sanwes.bg')] ? store.get('sanwes.bg') : 'off');
let bgBusy = Promise.resolve();

// Serialised so quick changes cannot race each other. GPU first; if the browser's GPU path fails, retry on the CPU.
function applyBackground() {
  bgBusy = bgBusy.then(async () => {
    const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!track) return;
    const kind = bgChoice();
    try {
      if (track.getProcessor()) await track.stopProcessor();
      if (kind === 'off') return;
      for (const delegate of ['GPU', 'CPU']) {
        try { await track.setProcessor(makeBackground(kind, delegate)); return; }
        catch (e) { if (delegate === 'CPU') throw e; if (track.getProcessor()) await track.stopProcessor().catch(() => {}); }
      }
    } catch (e) {
      toast(`Camera background unavailable: ${e.message}`);
      store.set('sanwes.bg', 'off'); $('sel-bg').value = 'off';
    }
  });
  return bgBusy;
}
{
  const sel = $('sel-bg');
  sel.replaceChildren(...Object.entries(BACKGROUNDS).map(([k, label]) => new Option(label, k)));
  sel.value = bgChoice();
  if (!backgroundsSupported()) { sel.disabled = true; sel.title = 'This browser cannot run background effects.'; }
  sel.onchange = () => { store.set('sanwes.bg', sel.value); applyBackground(); };
}

// ---------------------------------------------------------------- AI noise suppression

// On by default. When on, the browser's own (weaker) noise suppression is switched off so noise isn't processed twice;
// echo cancellation and level control stay with the browser.
const aiNoiseWanted = () => store.get('sanwes.aiNoise') !== '0';

async function applyNoiseProcessor() {
  const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!track) return;
  try {
    if (aiNoiseWanted() && !track.getProcessor()) await track.setProcessor(createNoiseProcessor());
    else if (!aiNoiseWanted() && track.getProcessor()) await track.stopProcessor();
  } catch (e) {
    toast(`AI noise suppression unavailable: ${e.message}`);
    store.set('sanwes.aiNoise', '0');
    $('chk-noise').checked = false;
  }
}

$('chk-noise').checked = aiNoiseWanted();
$('chk-noise').onchange = async () => {
  store.set('sanwes.aiNoise', $('chk-noise').checked ? '1' : '0');
  const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!track) return;
  await applyNoiseProcessor();
  // Swap the browser's own noise suppression to match, then re-capture the mic (the processor follows the new track).
  try { await track.restartTrack({ noiseSuppression: !aiNoiseWanted() }); } catch { /* keep the current capture */ }
};

async function savedDevice(kind) {
  const id = store.get(`sanwes.dev.${kind}`);
  if (!id) return undefined;
  try { return (await Room.getLocalDevices(kind, false)).some((d) => d.deviceId === id) ? id : undefined; } catch { return undefined; }
}

// Waiting room: the server answers 202 with a ticket until the host admits us; poll for the decision, then ask for the token again.
async function waitForAdmission(ticket) {
  session.ticket = ticket; session.cancelWait = false;
  $('waiting-title').textContent = session.roomName;
  $('waiting').hidden = false;
  try {
    for (let i = 0; i < 300; i++) { // about 10 minutes
      if (!session || session.cancelWait) throw new Error('You left the waiting room.');
      await new Promise((r) => setTimeout(r, 2000));
      const st = await fetch(`/api/join-status?room=${encodeURIComponent(session?.roomName ?? '')}&ticket=${ticket}`).then((r) => r.json()).catch(() => ({}));
      if (st.status === 'admitted' || st.status === 'active') break;
      if (st.status === 'denied') throw new Error('The host declined your request to join.');
      if (st.status === 'unknown') throw new Error('Your request expired. Try joining again.');
    }
  } finally { $('waiting').hidden = true; }
  return fetchToken(session);
}
$('waiting-cancel').onclick = () => { if (session) session.cancelWait = true; };

async function connect() {
  session.joined = false;
  let tk;
  for (;;) {
    try { tk = await fetchToken(session); break; }
    catch (ex) { if (ex.status === 425) await waitForHostStart(); else throw ex; }
  }
  while (tk.waiting) tk = await waitForAdmission(tk.ticket);
  const { token, url, role } = tk;
  session.token = token;
  session.role = role ?? 'member';
  // First time in a theater as a spectator: start muted so a crowd of open mics doesn't talk over the stream.
  const first = !session.joinedOnce;
  if (first && session.role === 'spectator') session.media.mic = false;
  session.joinedOnce = true;
  const [audioIn, videoIn, audioOut] = await Promise.all([savedDevice('audioinput'), savedDevice('videoinput'), savedDevice('audiooutput')]);
  const r = new Room({
    adaptiveStream: true,
    dynacast: true,
    // Voice: mono 48 kHz Opus at 64 kbit/s with redundancy (red) and silence suppression (dtx); the browser's echo
    // cancellation, noise suppression and level control stay on for the microphone.
    audioCaptureDefaults: { deviceId: audioIn, echoCancellation: true, noiseSuppression: !aiNoiseWanted(), autoGainControl: true, channelCount: 1 },
    publishDefaults: { audioPreset: { maxBitrate: 64_000 }, dtx: true, red: true },
    videoCaptureDefaults: { deviceId: videoIn },
    ...(audioOut && supportsAudioOutputSelection() ? { audioOutput: { deviceId: audioOut } } : {}),
  });
  bind(r);
  room = r;
  try {
    await r.connect(url, token, { autoSubscribe: false }); // subscriptions are managed by applySubscriptions()
  } catch (ex) {
    room = null;
    r.disconnect();
    throw ex;
  }
  if (first) { // the meeting's own defaults (set by the host when scheduling) apply the first time we get in
    let m0 = {}; try { m0 = JSON.parse(r.metadata || '{}') || {}; } catch { /* ignore */ }
    const manager = session.role === 'host' || session.role === 'cohost'; // hosts and co-hosts are never muted on entry and follow the host-video setting
    if (m0.muteOnEntry && !manager) session.media.mic = false;
    if (session.joinMedia.cam === undefined) session.media.cam = manager ? !!m0.hostVideo : !!m0.participantVideo;
  }
  session.joined = true;
  session.joinedAt ??= Date.now();
  applySubscriptions();
  applyRoomInfo();
  joinSec.hidden = true;
  callSec.hidden = false;

  try { await r.startAudio(); } catch { /* blocked until a click; AudioPlaybackStatusChanged shows a prompt */ }
  if (session.media.mic) {
    try { await r.localParticipant.setMicrophoneEnabled(true); } catch (ex) { toast(`Microphone unavailable: ${ex.message}`); }
    await applyNoiseProcessor();
    if (micMode() === 'original') await republishMic().catch(() => {});
  }
  if (session.media.cam) {
    try { await r.localParticipant.setCameraEnabled(true); } catch (ex) { toast(`Camera unavailable: ${ex.message}`); }
    await applyBackground();
  }

  rememberMedia();
  sync();
  updateButtons();
  meeting.onJoined();
  classroom.start();
  if (first && session.autoShare) {
    // Browsers only allow screen capture right after a click, which has long passed here; if it is refused, point at the button.
    try { await setScreenShare(true); } catch { toast('You are in a new meeting. Click "Share Screen" to choose what to share.', 'info'); }
    rememberMedia(); sync(); updateButtons();
  }
}

// The host has not started a scheduled meeting yet: wait here and carry on automatically when they do.
async function waitForHostStart() {
  session.cancelWait = false;
  const info = await fetch(`/api/meetings/${encodeURIComponent(session.roomName)}/public`).then((r) => r.json()).catch(() => ({}));
  $('waiting-msg').textContent = 'The meeting has not started. Please wait for the host to start this meeting.';
  $('waiting-title').textContent = info.topic ?? session.roomName;
  $('waiting').hidden = false;
  try {
    for (let i = 0; i < 1800; i++) { // about 90 minutes
      if (!session || session.cancelWait) throw new Error('You left the waiting screen.');
      await new Promise((r) => setTimeout(r, 3000));
      const st = await fetch(`/api/meetings/${encodeURIComponent(session?.roomName ?? '')}/public`).then((r) => r.json()).catch(() => ({}));
      if (st.live) return;
    }
    throw new Error('The host has not started the meeting.');
  } finally {
    $('waiting-msg').textContent = 'Please wait, the meeting host will let you in soon.';
    $('waiting').hidden = true;
  }
}

function bind(r) {
  const live = (fn) => (...args) => { if (r === room) fn(...args); };
  const resync = live(sync);
  r
    .on(RoomEvent.ParticipantConnected, live((p) => { resync(); if (!isBig()) addSystem(`${p.name || p.identity} joined`); scheduleSubs(); board.onParticipantConnected(p); paintRec(); }))
    .on(RoomEvent.ParticipantDisconnected, live((p) => { gamehub.onLeft(p); resync(); recent.delete(p.identity); if (!isBig()) addSystem(`${p.name || p.identity} left`); paintRec(); }))
    .on(RoomEvent.TrackSubscribed, live((track) => { if (track.kind === Track.Kind.Audio) audioSink.append(track.attach()); sync(); gamehub.onTracks(); }))
    .on(RoomEvent.TrackUnsubscribed, live((track) => { track.detach().forEach((el) => el.remove()); sync(); }))
    .on(RoomEvent.TrackMuted, live(() => { sync(); updateButtons(); }))
    .on(RoomEvent.TrackPublished, live(() => { scheduleSubs(); updateButtons(); gamehub.onTracks(); }))
    .on(RoomEvent.TrackUnpublished, live(() => updateButtons()))
    .on(RoomEvent.TrackUnmuted, live(() => { sync(); updateButtons(); }))
    .on(RoomEvent.LocalTrackPublished, live(() => { sync(); updateButtons(); gamehub.onTracks(); }))
    .on(RoomEvent.LocalTrackUnpublished, live(() => { if (fileShare && !room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) { const finished = fileShare.el.ended; endFileShare(); if (finished) toast('The video finished, so sharing stopped.', 'info'); } sync(); updateButtons(); }))
    .on(RoomEvent.ActiveSpeakersChanged, live((sp) => { for (const p of sp) if (!p.isLocal) recent.set(p.identity, Date.now()); scheduleSubs(); sync(); }))
    .on(RoomEvent.DataReceived, live(onData))
    .on(RoomEvent.ParticipantAttributesChanged, live((changed, p) => { meeting.onAttributesChanged(changed, p); gamehub.onAttributes(changed, p); if ('pic' in changed) sync(); if ('rec' in changed) paintRec(); }))
    .on(RoomEvent.ParticipantNameChanged, resync)
    .on(RoomEvent.ParticipantMetadataChanged, resync)
    .on(RoomEvent.RoomMetadataChanged, live(() => { applyRoomInfo(); sync(); }))
    .on(RoomEvent.MediaDevicesChanged, live(() => { if ($('settings').open) refreshDevices(); }))
    .on(RoomEvent.SignalReconnecting, live(() => setStatus('Connection lost. Reconnecting…', 'warn', 'net')))
    .on(RoomEvent.Reconnecting, live(() => setStatus('Connection lost. Reconnecting…', 'warn', 'net')))
    .on(RoomEvent.Reconnected, live(() => { clearStatus('net'); addSystem('Reconnected'); applySubscriptions(); sync(); updateButtons(); }))
    .on(RoomEvent.AudioPlaybackStatusChanged, live(() => {
      if (r.canPlaybackAudio) clearStatus('audio');
      else setStatus('Your browser blocked audio playback.', 'warn', 'audio', 'Enable audio', () => r.startAudio().catch(() => {}));
    }))
    .on(RoomEvent.Disconnected, (reason) => onDisconnected(r, reason));
}

// ---------------------------------------------------------------- reconnection

function onDisconnected(r, reason) {
  if (r !== room) return;
  room = null;
  if (!session) return leaveUi();
  const wasJoined = session.joined;
  session.joined = false;
  clearMedia();
  $('count').textContent = 'offline';
  if (session.boMain && !session.left && !session.switching && reason === DisconnectReason.ROOM_DELETED) { // the host closed the breakout rooms: go back to the main meeting
    session.joined = false; returnToMain().catch(() => leaveUi('The breakout rooms were closed.')); return;
  }
  if (session.left || FATAL_REASONS.has(reason)) return leaveUi(session.left ? undefined : FATAL_MESSAGES[reason]);
  if (!wasJoined) return; // initial connect failure is reported by the join handler
  addSystem('Disconnected from the call');
  scheduleRejoin(1);
}

function stopRejoinTimer() {
  if (rejoin) { clearInterval(rejoin.timer); rejoin = null; }
}

function scheduleRejoin(attempt) {
  stopRejoinTimer();
  clearStatus();
  updateButtons();
  if (!session) return;
  if (attempt > MAX_REJOIN) {
    setStatus('Could not reconnect to the call.', 'bad', 'net', 'Try again', () => scheduleRejoin(1));
    return;
  }
  let left = Math.min(2 * 2 ** (attempt - 1), 15);
  const show = () => setStatus(`Disconnected. Rejoining in ${left}s (attempt ${attempt}/${MAX_REJOIN})`, 'bad', 'net', 'Rejoin now', go);
  const go = async () => {
    stopRejoinTimer();
    setStatus(`Rejoining… (attempt ${attempt}/${MAX_REJOIN})`, 'warn', 'net');
    try {
      await connect();
      clearStatus('net');
      addSystem('Rejoined the call');
    } catch (ex) {
      if (!session) return;
      if (ex.status === 400 || ex.status === 401) return leaveUi(ex.message, ex.passwordRequired);
      scheduleRejoin(attempt + 1);
    }
  };
  rejoin = { go, timer: setInterval(() => { if (--left <= 0) go(); else show(); }, 1000) };
  show();
}

window.addEventListener('offline', () => { if (session?.joined) setStatus("You're offline. Waiting for the network…", 'bad', 'net'); });
window.addEventListener('online', () => {
  if (rejoin) rejoin.go();
  else if (room?.state === ConnectionState.Connected) clearStatus('net');
});

// ---------------------------------------------------------------- status banner

let statusOwner = null, statusAction = null;
function setStatus(text, kind, owner, actionLabel, action) {
  if (owner === 'audio' && statusOwner && statusOwner !== 'audio') return; // never hide a connection problem behind the audio prompt
  statusOwner = owner;
  statusAction = action ?? null;
  $('status').hidden = false;
  $('status').classList.toggle('bad', kind === 'bad');
  $('status-text').textContent = text;
  $('status-action').hidden = !action;
  if (action) $('status-action').textContent = actionLabel;
}
function clearStatus(owner) {
  if (owner && statusOwner !== owner) return;
  statusOwner = null; statusAction = null;
  $('status').hidden = true;
}
$('status-action').onclick = () => statusAction?.();

// ---------------------------------------------------------------- tiles & layout

// Room metadata (title, type, cover) comes from the LiveKit room; the role comes from our token.
const isTheater = () => session?.meta?.type === 'game';

function applyRoomInfo() {
  let meta = {};
  try { meta = JSON.parse(room?.metadata || '{}') || {}; } catch { /* ignore */ }
  if (session) session.meta = meta;
  $('room-title').textContent = meta.title || session?.roomName || '';
  const cover = $('room-cover');
  cover.hidden = !meta.cover;
  if (meta.cover) cover.src = meta.cover;
  callSec.classList.toggle('theater', isTheater());
  $('info-title').textContent = meta.title || session?.roomName || '';
  $('info-host').textContent = meta.host || 'unknown';
  $('info-id').textContent = fmtId(session?.roomName || '');
  $('info-type').textContent = TYPE_LABEL[meta.type] ?? 'Hangout';
  $('info-link').textContent = `${location.origin}/?room=${encodeURIComponent(session?.roomName ?? '')}`;
  $('info-pass').textContent = session?.password ?? '';
  $('info-pass-row').hidden = !session?.password;           // shown to people who know it (the host, or whoever typed it)
  $('shield').hidden = !(session?.password || meta.waiting);
  meeting.onRoomMeta(meta);
  classroom.onRoomMeta();
  gamehub.onRoomMeta();
  protect.apply(meta.protect, meeting.isManager());
  refreshChatTo();
  if (recorder.active && !canRecord()) { recorder.stop(); toast('Recording stopped: the host turned recording off.', 'info'); }
  paintRec();
  $('poster-art').replaceChildren();
  $('poster-art').append(coverEl(meta.cover, meta.title || session?.roomName || '?', 'poster-img'));
  $('poster-text').textContent = '';
  const h = document.createElement('div'); h.className = 'ph'; h.textContent = meta.game || meta.title || '';
  const p = document.createElement('div'); p.className = 'pp'; p.textContent = session?.role === 'host' ? 'You are the host. Click "Go live" to start streaming your screen.' : `Waiting for ${meta.host || 'the host'} to go live…`;
  $('poster-text').append(h, p);
  if (isTheater() && !$('chat').dataset.opened && matchMedia('(min-width: 761px)').matches) { $('chat').dataset.opened = '1'; setChatOpen(true); }
  updateButtons();
}

const isBotP = (p) => { try { return JSON.parse(p?.metadata || '{}').role === 'bot'; } catch { return false; } }; // the class video player/recorder is not a person
const isMgr = (p) => { try { return ['host', 'cohost'].includes(JSON.parse(p.metadata || '{}').role); } catch { return false; } };

// Order of the gallery: you, then hosts and co-hosts, then people with their camera on, then everyone else (stable by arrival).
const viewOpt = (k) => store.get(`sanwes.view.${k}`) === '1';
const setViewOpt = (k, v) => store.set(`sanwes.view.${k}`, v ? '1' : '0');
const sortMode = () => (['video', 'name'].includes(store.get('sanwes.view.sort')) ? store.get('sanwes.view.sort') : 'joined');
let tileOrder = new Map(), swapped = false;
function galleryOrder() {
  const all = [room.localParticipant, ...room.remoteParticipants.values()].filter((p) => !isBotP(p));
  const joined = (p) => p.joinedAt?.getTime?.() ?? 0, mode = sortMode();
  if (mode === 'name') return all.sort((x, y) => (x.name || x.identity).localeCompare(y.name || y.identity, undefined, { sensitivity: 'base' }));
  if (mode === 'video') return all.sort((x, y) => Number(y.isCameraEnabled) - Number(x.isCameraEnabled) || (x.isLocal ? -1 : y.isLocal ? 1 : 0) || joined(x) - joined(y));
  // default: you first; in a big room hosts and people with a camera come before the rest
  const rank = (p) => (p.isLocal ? 0 : isBig() ? (isMgr(p) ? 1 : p.isCameraEnabled ? 2 : 3) : 1);
  return all.sort((x, y) => rank(x) - rank(y) || joined(x) - joined(y));
}

function wantedTiles() {
  const out = new Map();
  const everyone = galleryOrder();
  everyone.forEach((p, i) => tileOrder.set(p.identity, i));
  // View menu: hide your own picture, hide people whose camera is off
  const hideSelf = viewOpt('hideSelf'), hideNoVideo = viewOpt('hideNoVideo');
  const visible = everyone.filter((p) => !(hideSelf && p.isLocal) && !(hideNoVideo && !p.isCameraEnabled));
  pageCount = Math.max(1, Math.ceil(visible.length / PAGE));
  if (!isBig()) page = 0; else page = Math.min(page, pageCount - 1);
  const shown = isBig() ? visible.slice(page * PAGE, (page + 1) * PAGE) : visible;
  const speaker = isBig() && ['speaker', 'sbs-speaker'].includes(viewMode) && lastSpeaker ? room.remoteParticipants.get(lastSpeaker) : null;
  if (speaker && !shown.includes(speaker)) shown.push(speaker);
  for (const id of session?.meta?.spotlight ?? []) { // a spotlighted person is shown to everybody, on any page
    const sp = id === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(id);
    if (sp && !shown.includes(sp)) shown.push(sp);
  }
  for (const p of shown) out.set(`${p.identity}:cam`, { p, source: Track.Source.Camera });
  for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) { // shared screens, including the class video player
    const s = p.getTrackPublication(Track.Source.ScreenShare);
    if (s?.track) out.set(`${p.identity}:screen`, { p, source: Track.Source.ScreenShare });
  }
  desiredVideo = new Set(shown.map((p) => p.identity));
  return out;
}

// Which tracks this browser asks the media server for. A small meeting gets everything; a large one only what is on screen.
function applySubscriptions() {
  if (!room) return;
  const big = isBig(), now = Date.now();
  const voices = new Set();
  if (big) {
    for (const [id] of [...recent].filter(([, ts]) => now - ts < 20_000).sort((x, y) => y[1] - x[1]).slice(0, 10)) voices.add(id);
    for (const p of room.remoteParticipants.values()) if (isMgr(p)) voices.add(p.identity);
  }
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      let want = true;
      if (big && pub.source !== Track.Source.ScreenShare && pub.source !== Track.Source.ScreenShareAudio) {
        want = pub.kind === Track.Kind.Audio ? voices.has(p.identity) : desiredVideo.has(p.identity);
      }
      if (pub.__want !== want) { pub.__want = want; pub.setSubscribed(want); }
    }
  }
}
let subTimer = 0;
function scheduleSubs() {
  if (!room) return;
  if (!isBig()) { applySubscriptions(); return; }
  if (!subTimer) subTimer = setTimeout(() => { subTimer = 0; applySubscriptions(); }, 250);
}

function paintPager() {
  $('pager').hidden = !(isBig() && pageCount > 1);
  $('pg-label').textContent = `${page + 1}/${pageCount}`;
  $('pg-prev').disabled = page <= 0;
  $('pg-next').disabled = page >= pageCount - 1;
}
$('pg-prev').onclick = () => { page = Math.max(0, page - 1); syncNow(); };
$('pg-next').onclick = () => { page = Math.min(pageCount - 1, page + 1); syncNow(); };

// In a big room events arrive constantly (everyone's mic, hand, picture): redraw at most about 7 times a second.
let syncTimer = 0;
function sync() {
  if (!room) return;
  if (!isBig()) { syncNow(); return; }
  if (!syncTimer) syncTimer = setTimeout(() => { syncTimer = 0; syncNow(); }, 150);
}

function syncNow() {
  if (!room) return;
  const wanted = wantedTiles();
  for (const [key, t] of tiles) {
    if (!wanted.has(key)) { t.track?.detach(t.video); t.el.remove(); tiles.delete(key); }
  }
  for (const [key, { p, source }] of wanted) {
    let t = tiles.get(key);
    if (!t) { t = makeTile(key); tiles.set(key, t); }
    updateTile(t, p, source);
  }
  for (const [key, t] of tiles) t.el.style.order = key.endsWith(':screen') ? -1 : (tileOrder.get(key.split(':')[0]) ?? 99); // View > Sort gallery by
  // A newly started screen share brings the room back to auto-focus even if someone chose the gallery.
  const screens = new Set([...wanted.keys()].filter((k) => k.endsWith(':screen')));
  if (pinned === null && [...screens].some((k) => !knownScreens.has(k))) pinned = undefined;
  knownScreens = screens;
  applyLayout();
  protect.apply(session?.meta?.protect, meeting.isManager()); // roles can change while the meeting runs
  $('count').textContent = `${[...room.remoteParticipants.values()].filter((p) => !isBotP(p)).length + 1} in call`;
  paintPager();
  scheduleSubs();
  meeting.renderPeople();
  refreshChatTo();
}

// Pinch to zoom and drag to look around a shared screen; double-tap puts it back. Works with fingers and a mouse wheel.
function attachZoom(el, video) {
  const pts = new Map();
  let s = 1, x = 0, y = 0, last = null, lastTap = 0;
  const apply = () => {
    const w = el.clientWidth, h = el.clientHeight;
    s = Math.min(5, Math.max(1, s));
    x = Math.min(0, Math.max(w - w * s, x)); y = Math.min(0, Math.max(h - h * s, y)); // never pan past the picture
    video.style.transform = s === 1 ? '' : `translate(${x}px, ${y}px) scale(${s})`;
    el.classList.toggle('zoomed', s > 1);
  };
  const reset = () => { s = 1; x = y = 0; apply(); };
  el.__resetZoom = reset;
  const zoomAt = (f, cx, cy) => { const ns = Math.min(5, Math.max(1, s * f)), k = ns / s; x = cx - (cx - x) * k; y = cy - (cy - y) * k; s = ns; apply(); };
  const live = () => el.classList.contains('screen') && el.classList.contains('focused');
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !live() || e.target.closest('button')) return; // fingers and pens only: a mouse double-click still pins
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    last = null;
    const now = Date.now();
    if (pts.size === 1 && now - lastTap < 300) { s > 1 ? reset() : zoomAt(2.5, e.clientX - el.getBoundingClientRect().left, e.clientY - el.getBoundingClientRect().top); lastTap = 0; } else lastTap = now;
  });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = el.getBoundingClientRect();
    if (pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (last) zoomAt(d / last.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      last = { d };
    } else if (pts.size === 1 && s > 1) { x += e.clientX - prev.x; y += e.clientY - prev.y; apply(); }
  });
  const up = (e) => { pts.delete(e.pointerId); last = null; };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => { if (!live() || !e.ctrlKey) return; e.preventDefault(); const r = el.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  new ResizeObserver(apply).observe(el);
}

function makeTile(key) {
  const el = document.createElement('div');
  el.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = true; // audio is played via audioSink
  const avatar = document.createElement('div'); avatar.className = 'avatar';
  const label = document.createElement('div'); label.className = 'label';
  const pin = document.createElement('button'); pin.className = 'pin'; pin.type = 'button';
  pin.onclick = () => {
    const focused = tiles.get(key)?.el.classList.contains('focused');
    if (typeof pinned === 'string' && focused) pinned = viewMode === 'speaker' ? undefined : null; // unpin
    else if (focused && viewMode !== 'speaker') pinned = null;                                      // leave the auto-focused screen share
    else pinned = key;                                                                              // pin
    applyLayout();
  };
  el.addEventListener('dblclick', (e) => { if (e.target === pin) return; if (matchMedia('(hover: none)').matches && el.classList.contains('screen')) return; /* on a phone a double-tap zooms */ pin.click(); });
  const fs = document.createElement('button'); fs.className = 'pin fs'; fs.type = 'button'; fs.textContent = 'Fullscreen';
  fs.onclick = async () => {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    try { await el.requestFullscreen?.(); } catch { return; }
    // a wide picture on a phone held upright is tiny: turn the screen sideways while it is full screen (portrait pictures stay upright)
    const wide = video.videoWidth > video.videoHeight;
    try { await screen.orientation?.lock?.(wide ? 'landscape' : 'portrait'); } catch { /* not allowed here: the user can rotate by hand */ }
  };
  const hint = document.createElement('div'); hint.className = 'zoom-hint'; hint.textContent = 'Double-tap to reset';
  // What you see instead of your own shared screen (no mirror-in-a-mirror), like the sharer's toolbar of a desktop client
  const mine = document.createElement('div'); mine.className = 'share-self';
  const mineIc = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); mineIc.setAttribute('class', 'ic'); const mineUse = document.createElementNS('http://www.w3.org/2000/svg', 'use'); mineUse.setAttribute('href', '#i-share'); mineIc.append(mineUse);
  const mineTitle = document.createElement('div'); mineTitle.className = 'ss-title'; mineTitle.textContent = 'You are sharing your screen';
  const mineSub = document.createElement('div'); mineSub.className = 'ss-sub';
  const mineStop = document.createElement('button'); mineStop.type = 'button'; mineStop.className = 'ss-stop'; mineStop.textContent = 'Stop share'; mineStop.onclick = () => $('btn-screen').click();
  mine.append(mineIc, mineTitle, mineSub, mineStop);
  el.append(video, avatar, mine, label, pin, fs, hint);
  attachZoom(el, video);
  return { key, el, video, avatar, label, pin, mineSub, track: null };
}

function updateTile(t, p, source) {
  const isScreen = source === Track.Source.ScreenShare;
  const pub = p.getTrackPublication(source);
  const track = pub?.track && !pub.isMuted ? pub.track : null;
  if (t.track !== track) {
    t.track?.detach(t.video);
    track?.attach(t.video);
    t.track = track;
  }
  const mic = p.getTrackPublication(Track.Source.Microphone);
  const micOff = !mic || mic.isMuted;
  t.el.classList.toggle('has-video', !!track);
  t.el.classList.toggle('screen', isScreen);
  t.el.classList.toggle('self-share', isScreen && p.isLocal);
  if (isScreen && p.isLocal) t.mineSub.textContent = p.getTrackPublication(Track.Source.ScreenShareAudio) ? 'Computer sound is shared' : 'Computer sound is off';
  t.el.classList.toggle('mirror', !isScreen && p.isLocal);
  t.el.classList.toggle('speaking', !isScreen && p.isSpeaking);
  paintAvatar(t.avatar, p.name || p.identity, session?.meta?.hideAvatars ? '' : p.attributes?.pic);
  const who = (p.name || p.identity) + (p.isLocal ? ' (you)' : '');
  t.label.textContent = isScreen ? `${who} — screen${t.stat ?? ''}` : `${who}${micOff ? ' 🔇' : ''}`;
}

// View modes: "gallery" (everyone in a grid; a screen share takes the stage) and "speaker" (the active speaker is large).
let viewMode = 'standard', lastSpeaker = null;

function speakerKey() {
  const sp = room?.activeSpeakers?.find((p) => !p.isLocal) ?? room?.activeSpeakers?.[0];
  if (sp) lastSpeaker = sp.identity; // keep the last speaker on stage during pauses so the picture does not jump
  if (lastSpeaker && tiles.has(`${lastSpeaker}:cam`)) return `${lastSpeaker}:cam`;
  const mine = room?.localParticipant.identity;
  const cams = [...tiles.keys()].filter((k) => k.endsWith(':cam'));
  return cams.find((k) => !k.startsWith(`${mine}:`)) ?? cams[0] ?? null;
}

function focusKey() {
  if (typeof pinned === 'string') {
    if (tiles.has(pinned)) return pinned;
    pinned = undefined; // pinned tile went away (left / stopped sharing): fall back to auto
  }
  if (pinned === null && !isTheater()) return null; // the user chose "Gallery" explicitly
  const screens = [...tiles.keys()].filter((k) => k.endsWith(':screen'));
  const spot = (session?.meta?.spotlight ?? []).map((id) => `${id}:cam`).find((k) => tiles.has(k));
  if (spot && !screens.length) return spot; // the host spotlighted someone: they take the stage for everybody
  const screen = screens.find((k) => !k.startsWith(`${room?.localParticipant.identity}:`)) ?? screens[0] ?? null;
  if (screen) return swapped ? (speakerKey() ?? screen) : screen; // "Swap video and shared screen": the speaker takes the stage
  if (['speaker', 'sbs-speaker'].includes(viewMode) && !isTheater()) return speakerKey();
  return null;
}

const LAYOUT_LABEL = { standard: 'Standard', 'sbs-speaker': 'Side-by-side', 'sbs-gallery': 'Side-by-side', speaker: 'Speaker', gallery: 'Gallery' };
function paintView() {
  $('view-label').textContent = LAYOUT_LABEL[viewMode];
  for (const m of Object.keys(LAYOUT_LABEL)) $(`view-${m}`).classList.toggle('on', viewMode === m);
  for (const m of ['joined', 'video', 'name']) $(`sort-${m}`).classList.toggle('on', sortMode() === m);
  $('view-hide-self').classList.toggle('on', viewOpt('hideSelf'));
  $('view-hide-novideo').classList.toggle('on', viewOpt('hideNoVideo'));
  $('view-swap').classList.toggle('on', swapped);
  const timers = store.get('sanwes.view.timers') !== '0';
  $('view-timers').classList.toggle('on', timers);
  $('timer').hidden = !timers;
  $('view-fullscreen').classList.toggle('on', !!document.fullscreenElement);
}
function setLayout(mode) { viewMode = mode; pinned = mode === 'gallery' ? null : undefined; swapped = false; closePops(); paintView(); syncNow(); }
for (const m of Object.keys(LAYOUT_LABEL)) $(`view-${m}`).onclick = () => setLayout(m);
for (const m of ['joined', 'video', 'name']) $(`sort-${m}`).onclick = () => { store.set('sanwes.view.sort', m); closePops(); paintView(); syncNow(); };
$('view-hide-self').onclick = () => { setViewOpt('hideSelf', !viewOpt('hideSelf')); closePops(); paintView(); syncNow(); };
$('view-hide-novideo').onclick = () => { setViewOpt('hideNoVideo', !viewOpt('hideNoVideo')); closePops(); paintView(); syncNow(); };
$('view-swap').onclick = () => { swapped = !swapped; closePops(); paintView(); syncNow(); };
$('view-timers').onclick = () => { store.set('sanwes.view.timers', store.get('sanwes.view.timers') === '0' ? '1' : '0'); closePops(); paintView(); };
$('view-fullscreen').onclick = () => { closePops(); if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); };
document.addEventListener('fullscreenchange', paintView);
paintView();

// The strip of people above the shared picture can be dragged taller or shorter (double-click puts it back).
const stripH = () => Math.min(260, Math.max(84, Number(store.get('sanwes.view.stripH')) || 138));
stageArea.style.setProperty('--strip-h', `${stripH()}px`);
$('strip-handle').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const y0 = e.clientY, h0 = stripH(), max = Math.min(260, stageArea.clientHeight * 0.5);
  const move = (ev) => stageArea.style.setProperty('--strip-h', `${Math.round(Math.min(max, Math.max(84, h0 + ev.clientY - y0)))}px`);
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); store.set('sanwes.view.stripH', parseInt(stageArea.style.getPropertyValue('--strip-h'), 10)); layoutGrid(); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});
$('strip-handle').addEventListener('dblclick', () => { store.set('sanwes.view.stripH', 138); stageArea.style.setProperty('--strip-h', '138px'); });

function place(el, parent) {
  // Re-parenting a <video> restarts its playback, so only move tiles that actually changed container.
  if (el.parentElement === parent) return;
  parent.append(el);
  el.querySelector('video')?.play().catch(() => {});
}

function applyLayout() {
  const focus = focusKey();
  for (const [key, t] of tiles) {
    const isFocus = key === focus;
    place(t.el, isFocus ? stage : grid);
    t.el.classList.toggle('focused', isFocus);
    const unpinLabel = isFocus && (typeof pinned === 'string' || viewMode !== 'speaker');
    t.pin.textContent = unpinLabel ? 'Unpin' : 'Pin';
    t.pin.setAttribute('aria-label', `${unpinLabel ? 'Unpin' : 'Pin'} ${t.label.textContent}`);
  }
  const fv = focus ? tiles.get(focus)?.video : null;
  if (fv && !fv.__ar) { fv.__ar = true; fv.addEventListener('loadedmetadata', () => applyLayout()); fv.addEventListener('resize', () => applyLayout()); }
  if (fv?.videoWidth) { stageArea.dataset.content = fv.videoWidth >= fv.videoHeight ? 'landscape' : 'portrait'; stage.style.setProperty('--ar', `${fv.videoWidth} / ${fv.videoHeight}`); }
  else { delete stageArea.dataset.content; stage.style.removeProperty('--ar'); }
  for (const [key, t] of tiles) if (key !== focus) t.el.__resetZoom?.(); // zoom only lives on the picture being looked at
  stageArea.dataset.layout = viewMode;
  const hasScreen = [...tiles.keys()].some((k) => k.endsWith(':screen'));
  $('view-swap').hidden = !hasScreen;
  if (!hasScreen) swapped = false;
  const sideKey = viewMode === 'sbs-speaker' && focus?.endsWith(':screen') ? speakerKey() : null; // side-by-side Speaker: only the speaker beside the picture
  for (const [key, t] of tiles) t.el.hidden = !!sideKey && key !== focus && key !== sideKey;
  const theater = isTheater();
  stageArea.classList.toggle('focus', !!focus || theater);
  stageArea.classList.toggle('empty-strip', (!!focus || theater) && grid.children.length === 0);
  $('poster').hidden = !theater || !!focus;
  if (!$('poster').hidden && $('poster').parentElement !== stage) stage.append($('poster'));
  if (theater) {
    const live = [...tiles.keys()].some((k) => k.endsWith(':screen'));
    const badge = $('room-badge');
    badge.hidden = false;
    badge.textContent = live ? 'LIVE' : 'OFFLINE';
    badge.classList.toggle('live', live);
  } else {
    $('room-badge').hidden = true;
  }
  layoutGrid();
}

// Pick the column count whose cells make the biggest 16:9 tiles for the current viewport.
function layoutGrid() {
  if (stageArea.classList.contains('focus')) { grid.style.removeProperty('--cols'); grid.style.removeProperty('--rows'); return; }
  const n = grid.children.length, W = grid.clientWidth, H = grid.clientHeight;
  if (!n || !W || !H) return;
  const gap = 12, ratio = 16 / 9;
  let best = { cols: 1, rows: n, area: -1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * ratio);
    if (w > 0 && w * w > best.area) best = { cols, rows, area: w * w };
  }
  grid.style.setProperty('--cols', best.cols);
  grid.style.setProperty('--rows', best.rows);
}
new ResizeObserver(layoutGrid).observe(grid);

document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { try { screen.orientation?.unlock?.(); } catch { /* ignore */ } } });

function clearMedia() {
  endFileShare();
  for (const t of tiles.values()) { t.track?.detach(t.video); t.el.remove(); }
  tiles.clear();
  audioSink.replaceChildren();
}

// ---------------------------------------------------------------- controls

function updateButtons() {
  const lp = room?.localParticipant;
  const connected = room?.state === ConnectionState.Connected;
  for (const id of ['btn-mic', 'btn-cam', 'btn-screen', 'btn-video', 'btn-chat']) $(id).disabled = id !== 'btn-chat' && !connected;
  if (!lp) return;
  // The icon (and its red slash) carries the on/off state; the label only changes when there is something else to say.
  const setBtn = (id, on, label, onIcon, offIcon) => {
    const b = $(id);
    b.setAttribute('aria-pressed', String(on));
    if (label != null) b.querySelector('.lbl').textContent = label;
    if (onIcon) b.querySelector('use').setAttribute('href', `#i-${on ? onIcon : offIcon}`);
  };
  const manager = meeting.isManager();
  setBtn('btn-mic', lp.isMicrophoneEnabled, session?.audioLeft ? 'Join Audio' : 'Audio', 'mic', 'mic-off');
  setBtn('btn-cam', lp.isCameraEnabled, 'Video', 'cam', 'cam-off');
  setBtn('btn-screen', lp.isScreenShareEnabled, lp.isScreenShareEnabled ? (isTheater() ? 'Stop stream' : 'Stop share') : (isTheater() ? 'Go live' : 'Share'));
  const spectator = session?.role === 'spectator';
  // Host tools > Share: who may share, how many at once, and who may start while someone else is sharing
  const meta = session?.meta ?? {};
  const othersSharing = [...room.remoteParticipants.values()].some((p) => p.getTrackPublication(Track.Source.ScreenShare)?.track);
  const shareRules = manager || lp.isScreenShareEnabled || (meta.allowShare !== false && !(othersSharing && (meta.shareMax === 'one' || meta.shareWhen === 'host')));
  const shareAllowed = !spectator && shareRules && !!navigator.mediaDevices?.getDisplayMedia;
  if (!manager && !spectator) { // Host tools: "Unmute themselves" and "Start video"
    const noMic = meta.allowUnmute === false && !lp.isMicrophoneEnabled, noCam = meta.allowVideo === false && !lp.isCameraEnabled;
    $('btn-mic').disabled ||= noMic; $('btn-mic').title = noMic ? 'The host has turned off unmuting' : '';
    $('btn-cam').disabled ||= noCam; $('btn-cam').title = noCam ? 'The host has turned off starting video' : '';
  }
  $('btn-cam').hidden = spectator;
  $('btn-cam-caret').hidden = spectator;
  $('btn-screen').hidden = !shareAllowed;
  $('btn-share-caret').hidden = !shareAllowed;
  $('btn-video').hidden = spectator || !canShareFile || !shareAllowed;
  $('sm-video').hidden = $('btn-video').hidden;
  $('btn-video').querySelector('.lbl').textContent = fileShare ? 'Stop video' : 'Share video';
  $('btn-video').setAttribute('aria-pressed', String(!!fileShare));
}

// What to turn back on after a rejoin. Recorded only on user actions: a dropped connection unpublishes the local
// tracks, so reading it from the room state at that point would always say "off".
function rememberMedia() {
  const lp = room?.localParticipant;
  if (lp && session && !session.freezeMedia) session.media = { mic: lp.isMicrophoneEnabled, cam: lp.isCameraEnabled }; // frozen while the rooms close, so the closing itself does not read as "camera off"
}

async function toggle(fn, label) {
  if (!room) return;
  try { await fn(); } catch (e) { if (e?.name !== 'NotAllowedError') toast(`${label}: ${e.message}`); }
  await applyNoiseProcessor();
  await applyBackground();
  rememberMedia(); sync(); updateButtons();
}

$('btn-mic').onclick = () => (session?.audioLeft ? toggleAudioLeave() : toggle(() => room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled), 'Microphone'));
$('btn-cam').onclick = () => toggle(() => room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled), 'Camera');
// ---- Screen sharing options (all changeable in Settings; presets just fill them in) ----
// Video quality is set by the encoder caps (bitrate / fps / codec); the capture constraint only asks the browser for a
// resolution and rate, and the shared source or the PC may deliver less. Shared SOUND is published as its own track with
// music settings (stereo, high bitrate, no silence suppression, no redundancy): the voice defaults used for the
// microphone (mono 64 kbit/s + DTX) make video and music sound rough.
const RESOLUTIONS = { 720: [1280, 720, '720p'], 1080: [1920, 1080, '1080p'], 1440: [2560, 1440, '1440p (2K)'], 2160: [3840, 2160, '2160p (4K)'] };
const FRAME_RATES = [15, 30, 60];
const HINTS = { detail: 'Detail: text, slides, code (keeps the picture sharp)', motion: 'Motion: video, games (keeps it smooth)' };
const CODECS = {
  h264: 'H.264: best compatibility, hardware encoding',
  vp9: 'VP9: sharper at the same bitrate, heavier on the CPU',
  av1: 'AV1: most efficient, very heavy on the CPU',
  vp8: 'VP8: lightest, lowest quality',
};
const BITRATES = { auto: 'Auto (from resolution and frame rate)', 2e6: '2 Mbit/s', 4e6: '4 Mbit/s', 8e6: '8 Mbit/s', 12e6: '12 Mbit/s', 20e6: '20 Mbit/s', 30e6: '30 Mbit/s', 40e6: '40 Mbit/s' };
const SHARE_AUDIO = {
  music: { label: 'Music / video: stereo 128 kbit/s', bitrate: 128_000, stereo: true },
  hifi: { label: 'Hi-Fi: stereo 256 kbit/s', bitrate: 256_000, stereo: true },
  voice: { label: 'Low bandwidth: 64 kbit/s', bitrate: 64_000, stereo: false },
  off: { label: 'No sound', bitrate: 0, stereo: false },
};
const SHARE_PRESETS = {
  best: { label: 'Best quality (1080p, up to 60 fps)', res: '1080', fps: '60', hint: 'detail', codec: 'h264', vbr: 'auto', audio: 'music' },
  video: { label: 'Watch a video together (smooth, stereo sound)', res: '1080', fps: '60', hint: 'motion', codec: 'h264', vbr: 'auto', audio: 'hifi' },
  max: { label: 'Maximum (1440p60, fast PC + network)', res: '1440', fps: '60', hint: 'detail', codec: 'h264', vbr: 'auto', audio: 'hifi' },
  sharp30: { label: 'Slides and text (1080p30)', res: '1080', fps: '30', hint: 'detail', codec: 'h264', vbr: 'auto', audio: 'music' },
  light: { label: 'Slow connection (720p30)', res: '720', fps: '30', hint: 'motion', codec: 'vp8', vbr: '2000000', audio: 'voice' },
};
const SHARE_KEYS = ['res', 'fps', 'hint', 'codec', 'vbr', 'audio'];

function loadShare() {
  let saved = {};
  try { saved = JSON.parse(store.get('sanwes.share') ?? '{}') || {}; } catch { /* ignore */ }
  const v = { ...SHARE_PRESETS.best, ...Object.fromEntries(SHARE_KEYS.filter((k) => saved[k] != null).map((k) => [k, String(saved[k])])) };
  if (!RESOLUTIONS[v.res]) v.res = '1080';
  if (!FRAME_RATES.includes(Number(v.fps))) v.fps = '60';
  if (!CODECS[v.codec]) v.codec = 'h264';
  if (!SHARE_AUDIO[v.audio]) v.audio = 'music';
  return v;
}
const saveShare = (v) => store.set('sanwes.share', JSON.stringify(Object.fromEntries(SHARE_KEYS.map((k) => [k, v[k]]))));

// Turn the chosen options into LiveKit capture + publish options.
function shareSettings(v = isTheater() ? gamePreset() : loadShare()) { // in a game room the stream uses the Game Hub quality choice (smooth 60 fps, low delay)
  const [width, height] = RESOLUTIONS[v.res];
  const fps = Number(v.fps);
  const bpp = { h264: 0.12, vp8: 0.12, vp9: 0.09, av1: 0.07, h265: 0.08 }[v.codec];
  const auto = Math.min(40e6, Math.round((width * height * fps * bpp) / 5e5) * 5e5);
  const bitrate = v.vbr === 'auto' ? auto : Number(v.vbr);
  const snd = SHARE_AUDIO[v.audio];
  return {
    bitrate, width, height, fps, snd,
    capture: {
      // restrictOwnAudio: leave this browser's own output (everyone's voices) out of shared system audio, otherwise the
      // sharer's speakers feed the call back into the stream as an echo. The sound itself is left untouched: no echo
      // cancellation, noise suppression or level control on it.
      audio: snd.bitrate ? {
        restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: snd.stereo ? 2 : 1 }, sampleRate: { ideal: 48000 },
      } : false,
      resolution: { width, height, frameRate: fps },
      contentHint: v.hint,
      selfBrowserSurface: 'exclude',
      systemAudio: snd.bitrate ? 'include' : 'exclude',
    },
    publish: {
      screenShareEncoding: { maxBitrate: bitrate, maxFramerate: fps, priority: 'high' },
      videoCodec: v.codec,
      // Detail: when overloaded drop frame rate, never resolution. Motion: balance both.
      degradationPreference: v.hint === 'detail' ? 'maintain-resolution' : isTheater() ? 'maintain-framerate' : 'balanced',
      screenShareSimulcastLayers: [],
      // These apply to the shared-sound track (they override the microphone defaults set on the Room).
      audioPreset: { maxBitrate: snd.bitrate || 64_000 },
      forceStereo: snd.stereo,
      dtx: false,
      red: false,
    },
  };
}

// Volume boost for shared sound (with a limiter). A quiet source such as a video played at low system volume is the usual
// reason shared sound seems "low and unclear": the codec cannot make up for a signal that was captured too quietly.
const BOOSTS = { 0: 'Normal', 6: 'Louder (+6 dB)', 12: 'Much louder (+12 dB)' };
const shareBoost = () => { const v = Number(store.get('sanwes.shareBoost') ?? 6); return BOOSTS[v] ? v : 6; };

async function applyShareBoost() {
  const track = room?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
  if (!track || !shareBoost() || track.getProcessor()) return;
  try { await track.setProcessor(createGainProcessor(shareBoost())); } catch (e) { toast(`Volume boost unavailable: ${e.message}`); }
}

function setScreenShare(on) {
  const lp = room.localParticipant;
  if (!on) return lp.setScreenShareEnabled(false);
  const q = shareSettings();
  if (isTheater()) tuneStream(q.bitrate); // game stream: start fast instead of crawling up from 0.3 Mbit/s
  return lp.setScreenShareEnabled(true, q.capture, q.publish).then(async (pub) => {
    if (q.snd.bitrate) {
      await applyShareBoost();
      toast('Sharing sound? Use headphones. If your speakers are on, your microphone picks the sound up again and everyone hears an echo.', 'info');
    }
    return pub;
  });
}
$('btn-screen').onclick = () => toggle(() => setScreenShare(!room.localParticipant.isScreenShareEnabled), 'Screen share');
// ---------------------------------------------------------------- share a video file
// Plays a local file in a hidden <video> and publishes its picture and sound straight from the player (captureStream).
// Unlike capturing the screen: no loopback of system audio, no speaker->microphone echo, and the sound does not depend on
// the Windows volume. Both tracks are published as a screen share (+ its sound) so viewers/theater treat it the same way.
let fileShare = null; // { el, url, name }
const canShareFile = typeof HTMLMediaElement !== 'undefined' && ('captureStream' in HTMLMediaElement.prototype || 'mozCaptureStream' in HTMLMediaElement.prototype);
const fileInput = document.createElement('input');
fileInput.type = 'file'; fileInput.accept = 'video/*,audio/*,.mkv'; fileInput.hidden = true;
document.body.append(fileInput);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function shareVideoClick() {
  if (!room) return;
  if (fileShare) toggle(() => setScreenShare(false), 'Video');
  else fileInput.click();
}
$('btn-video').onclick = () => { closePops(); shareVideoClick(); };
$('sm-video').onclick = () => { closePops(); shareVideoClick(); };
$('sm-settings').onclick = () => { closePops(); openSettings('share'); };
$('more-info').onclick = () => { closePops(); openPop('info-pop', $('btn-info')); };
fileInput.onchange = () => {
  const f = fileInput.files[0];
  fileInput.value = '';
  if (f) startFileShare(f).catch(async (e) => { await room?.localParticipant.setScreenShareEnabled(false).catch(() => {}); endFileShare(); toast(`Share video: ${e.message}`); });
};

async function startFileShare(file) {
  if (!room || room.state !== ConnectionState.Connected) throw new Error('not connected.');
  const lp = room.localParticipant;
  if (lp.isScreenShareEnabled) await lp.setScreenShareEnabled(false);
  endFileShare();

  const el = document.createElement('video');
  el.playsInline = true; el.preload = 'auto'; el.src = URL.createObjectURL(file);
  el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(el);
  fileShare = { el, url: el.src, name: file.name };
  await new Promise((ok, fail) => { el.onloadeddata = ok; el.onerror = () => fail(new Error('this browser cannot play that file. Use MP4 (H.264/AAC) or WebM.')); });

  const stream = (el.captureStream ?? el.mozCaptureStream).call(el);
  el.volume = Number($('vb-vol').value) / 100;
  await el.play();
  let v, a;
  for (let i = 0; i < 20; i++) { v = stream.getVideoTracks()[0]; a = stream.getAudioTracks()[0]; if (v && a) break; await wait(50); }
  if (!v) throw new Error('that file has no picture.');

  const q = shareSettings();
  await lp.publishTrack(v, { ...q.publish, source: Track.Source.ScreenShare, name: 'shared-video' });
  if (a && q.snd.bitrate) {
    await lp.publishTrack(a, { audioPreset: q.publish.audioPreset, forceStereo: true, dtx: false, red: false, source: Track.Source.ScreenShareAudio, name: 'shared-video-sound' });
    await applyShareBoost();
  }
  showVideoBar();
  rememberMedia(); sync(); updateButtons();
}

function showVideoBar() {
  const { el, name } = fileShare;
  $('vb-name').textContent = name;
  $('video-bar').hidden = false;
  const paint = () => {
    if (!fileShare) return;
    $('vb-time').textContent = `${clock(el.currentTime)} / ${clock(el.duration || 0)}`;
    if (!$('vb-seek').matches(':active')) $('vb-seek').value = el.duration ? String(Math.round((el.currentTime / el.duration) * 1000)) : '0';
    $('vb-play').textContent = el.ended ? 'Replay' : el.paused ? 'Play' : 'Pause';
  };
  for (const ev of ['timeupdate', 'play', 'pause', 'ended', 'durationchange']) el.addEventListener(ev, paint);
  paint();
}
$('vb-play').onclick = () => { const el = fileShare?.el; if (!el) return; if (el.ended) el.currentTime = 0; if (el.paused || el.ended) el.play(); else el.pause(); };
$('vb-seek').oninput = () => { const el = fileShare?.el; if (el?.duration) el.currentTime = (Number($('vb-seek').value) / 1000) * el.duration; };
$('vb-vol').oninput = () => { if (fileShare) fileShare.el.volume = Number($('vb-vol').value) / 100; };
$('vb-stop').onclick = () => toggle(() => setScreenShare(false), 'Video');

function endFileShare() {
  if (!fileShare) return;
  const { el, url } = fileShare;
  fileShare = null;
  el.pause(); el.removeAttribute('src'); el.load(); el.remove();
  URL.revokeObjectURL(url);
  $('video-bar').hidden = true;
  updateButtons();
}

// Phone browsers (Android Chrome, iOS Safari) have no getDisplayMedia, so sharing is impossible there: hide the button.
// They can still watch other people's screen shares, talk, use video and chat.
if (!navigator.mediaDevices?.getDisplayMedia) $('btn-screen').hidden = true;

{
  const fill = (id, entries) => $(id).replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  fill('sel-share', [['custom', 'Custom'], ...Object.entries(SHARE_PRESETS).map(([id, p]) => [id, p.label])]);
  fill('sel-res', Object.entries(RESOLUTIONS).map(([k, r]) => [k, r[2]]));
  fill('sel-fps', FRAME_RATES.map((f) => [String(f), `${f} fps`]));
  fill('sel-hint', Object.entries(HINTS));
  fill('sel-codec', Object.entries(CODECS));
  fill('sel-vbr', Object.entries(BITRATES));
  fill('sel-saudio', Object.entries(SHARE_AUDIO).map(([k, a]) => [k, a.label]));
  const ctl = { res: 'sel-res', fps: 'sel-fps', hint: 'sel-hint', codec: 'sel-codec', vbr: 'sel-vbr', audio: 'sel-saudio' };
  const read = () => Object.fromEntries(SHARE_KEYS.map((k) => [k, $(ctl[k]).value]));
  const note = () => {
    const q = shareSettings(read());
    const lines = [`Will send ${q.width}×${q.height} at up to ${q.fps} fps, about ${(q.bitrate / 1e6).toFixed(1)} Mbit/s of video upload${q.snd.bitrate ? ` plus ${q.snd.bitrate / 1000} kbit/s of sound` : ''}.`];
    if (q.fps === 60) lines.push('60 fps needs a capable PC, and the shared screen must run at 60 Hz.');
    if (['vp9', 'av1'].includes($('sel-codec').value)) lines.push('VP9/AV1 can only be tuned for motion by the browser; "Detail" is ignored for these formats.');
    lines.push('Applies the next time you start sharing.');
    $('share-note').textContent = lines.join(' ');
  };
  const sync = (v) => { for (const k of SHARE_KEYS) $(ctl[k]).value = v[k]; const m = Object.entries(SHARE_PRESETS).find(([, p]) => SHARE_KEYS.every((k) => p[k] === v[k])); $('sel-share').value = m ? m[0] : 'custom'; note(); };
  fill('sel-boost', Object.entries(BOOSTS));
  $('sel-boost').value = String(shareBoost());
  $('sel-boost').onchange = () => store.set('sanwes.shareBoost', $('sel-boost').value);
  sync(loadShare());
  $('sel-share').onchange = () => { const p = SHARE_PRESETS[$('sel-share').value]; if (!p) return; saveShare(p); sync(p); };
  for (const k of SHARE_KEYS) $(ctl[k]).onchange = () => { const v = read(); saveShare(v); sync(v); };
}

// Live resolution / fps readout on screen-share tiles (what is really being sent / received, not what was asked for).
const lastDecoded = new Map(); // tile key -> { frames, at }
async function pollStats() {
  if (!room || room.state !== ConnectionState.Connected) return;
  for (const [key, t] of tiles) {
    if (!key.endsWith(':screen') || !t.track) { t.stat = ''; continue; }
    try {
      let w, h, fps, limit = '';
      if (typeof t.track.getSenderStats === 'function') {
        const top = (await t.track.getSenderStats()).filter((x) => x.frameWidth).sort((a, b) => b.frameWidth - a.frameWidth)[0];
        ({ frameWidth: w, frameHeight: h, framesPerSecond: fps } = top ?? {});
        // Why the encoder is holding quality back: "cpu" = PC too slow to encode, "bandwidth" = network estimate too low.
        if (top?.qualityLimitationReason && top.qualityLimitationReason !== 'none') limit = ` · limited by ${top.qualityLimitationReason}`;
      } else if (typeof t.track.getReceiverStats === 'function') {
        const r = await t.track.getReceiverStats();
        const now = performance.now(), prev = lastDecoded.get(key);
        if (r && prev && now > prev.at) fps = ((r.framesDecoded - prev.frames) * 1000) / (now - prev.at);
        if (r) lastDecoded.set(key, { frames: r.framesDecoded, at: now });
        w = r?.frameWidth; h = r?.frameHeight;
      }
      t.stat = w ? ` · ${w}×${h}${fps ? ` · ${Math.round(fps)} fps` : ''}${limit}` : '';
      t.label.textContent = t.label.textContent.replace(/ · .*$/, '') + t.stat;
    } catch { t.stat = ''; }
  }
}
setInterval(pollStats, 2000);
function doLeave() {
  if (session) session.left = true;
  if (recorder.active) recorder.stop();
  stopRejoinTimer();
  if (room) room.disconnect(); else leaveUi();
}
$('leave-confirm').onclick = () => { closePops(); doLeave(); };
$('leave-bo').onclick = () => { closePops(); returnToMain(); };
$('leave-cancel').onclick = () => closePops();
$('leave-end').onclick = async () => {
  closePops();
  try { await meeting.endForAll(); } catch (e) { toast(`Could not end the meeting: ${e.message}`); return; }
  doLeave();
};

// ---------------------------------------------------------------- popovers (reactions, view, meeting info, leave)
const POPS = ['wb-menu', 'rec-menu', 'chat-menu', 'react-menu', 'view-menu', 'info-pop', 'leave-menu', 'audio-menu', 'video-menu2', 'share-menu', 'more-menu', 'row-menu'];
function closePops() { for (const id of POPS) $(id).hidden = true; }
function openPop(id, anchor) {
  const pop = $(id), wasHidden = pop.hidden;
  closePops();
  if (!wasHidden) return; // clicking the same button again closes it
  if (id === 'leave-menu') { $('leave-end').hidden = !meeting.canEnd() || !!session?.boMain; $('leave-bo').hidden = !session?.boMain; }
  if (id === 'audio-menu') buildAudioMenu();
  if (id === 'video-menu2') buildVideoMenu();
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), w = pop.offsetWidth;
  const centered = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const rightAligned = id === 'view-menu' || id === 'leave-menu' || id === 'row-menu' && r.left > innerWidth / 2;
  const left = rightAligned ? Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) : (id === 'info-pop' || id === 'audio-menu' || id === 'video-menu2') ? Math.max(8, r.left - 8) : centered;
  pop.style.left = `${left}px`;
  if (r.top > innerHeight / 2) { pop.style.top = 'auto'; pop.style.bottom = `${innerHeight - r.top + 8}px`; }
  else { pop.style.bottom = 'auto'; pop.style.top = `${r.bottom + 8}px`; }
}
for (const b of document.querySelectorAll('[data-pop]')) b.addEventListener('click', (e) => { e.stopPropagation(); openPop(b.dataset.pop, b); });
document.addEventListener('click', (e) => { if (!e.target.closest('.popover')) closePops(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePops(); });

// Press and hold SPACE to talk while muted (let go and you are muted again). Off while typing, and when the host does not let you unmute.
let spaceTalk = false;
const typing = (el) => el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
document.addEventListener('keydown', async (e) => {
  if (e.code !== 'Space' || e.repeat || spaceTalk || typing(document.activeElement) || !room || room.state !== ConnectionState.Connected || $('call').hidden) return;
  if (store.get('sanwes.spaceTalk') === '0' || room.localParticipant.isMicrophoneEnabled || $('btn-mic').disabled) return;
  e.preventDefault(); spaceTalk = true;
  try { await room.localParticipant.setMicrophoneEnabled(true); toast('You are unmuted while you hold SPACE.', 'info'); } catch { spaceTalk = false; }
});
document.addEventListener('keyup', async (e) => {
  if (e.code !== 'Space' || !spaceTalk) return;
  e.preventDefault(); // a focused button must not 'click' when SPACE is let go
  spaceTalk = false;
  try { await room?.localParticipant.setMicrophoneEnabled(false); } catch { /* left */ }
});
window.addEventListener('blur', () => { if (spaceTalk) { spaceTalk = false; room?.localParticipant.setMicrophoneEnabled(false).catch(() => {}); } });

// Time in the meeting
setInterval(() => {
  if (!session?.joinedAt) return;
  const sec = Math.floor((Date.now() - session.joinedAt) / 1000), h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  $('timer').textContent = `${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}, 1000);

function leaveUi(message, passwordRequired) {
  // remember a meeting you were actually in, for the "recent" list on the home screen
  const ended = session?.joinedAt ? { id: session.boMain ?? session.roomName, title: session.meta?.title || session.roomName, host: session.meta?.host || '', start: session.joinedAt, end: Date.now() } : null;
  stopRejoinTimer();
  clearTimeout(syncTimer); clearTimeout(subTimer); syncTimer = subTimer = 0; page = 0; pageCount = 1; recent.clear(); desiredVideo = new Set();
  if (recorder.active) recorder.stop();
  board.close();
  chatLog.length = 0;
  clearMedia();
  clearStatus();
  room = null;
  session = null;
  pinned = undefined;
  viewMode = 'standard'; swapped = false; lastSpeaker = null; paintView(); closePops();
  $('timer').textContent = '00:00';
  knownScreens = new Set();
  unread = 0;
  $('chat-log').replaceChildren();
  delete $('chat').dataset.opened;
  callSec.classList.remove('theater');
  setChatOpen(false);
  meeting.reset();
  classroom.reset();
  gamehub.reset();
  captions.reset();
  $('waiting').hidden = true;
  $('settings').close?.();
  callSec.hidden = true;
  joinSec.hidden = false;
  home.onLeft(message, ended);
}

// ---------------------------------------------------------------- chat (LiveKit data messages)

const encoder = new TextEncoder(), decoder = new TextDecoder();

let sidePane = 'chat';
function setChatOpen(open, pane = 'chat') {
  sidePane = pane;
  if (open) meeting.closeHostTools();
  $('chat').hidden = !open;
  $('chat-pane').hidden = pane !== 'chat';
  $('chat-more').hidden = pane !== 'chat'; // its menu (save chat, who can chat) belongs to the chat tab
  $('people-pane').hidden = pane !== 'people';
  $('qa-pane').hidden = pane !== 'qa';
  $('bo-pane').hidden = pane !== 'bo';
  $('poll-pane').hidden = pane !== 'poll';
  $('panel-title').textContent = { chat: 'Chat', qa: 'Q&A', poll: 'Polls', bo: 'Breakout rooms' }[pane] ?? `Participants (${$('people-count').textContent})`;
  $('btn-chat').setAttribute('aria-pressed', String(open && pane === 'chat'));
  $('btn-people').setAttribute('aria-pressed', String(open && pane === 'people'));
  if (open && pane === 'chat') { unread = 0; $('chat-input').focus(); $('chat-log').scrollTop = $('chat-log').scrollHeight; }
  updateBadge();
}
function updateBadge() {
  $('chat-badge').hidden = unread === 0;
  $('chat-badge').textContent = unread > 99 ? '99+' : String(unread);
}
$('panel-close').onclick = () => setChatOpen(false);
$('btn-chat').onclick = () => setChatOpen($('chat').hidden || sidePane !== 'chat', 'chat');
$('btn-people').onclick = () => setChatOpen($('chat').classList.contains('host-open') || $('chat').hidden || sidePane !== 'people', 'people');

const chatLog = []; // kept for "Save chat"
const roleOfP = (p) => { try { return JSON.parse(p?.metadata || '{}').role ?? 'member'; } catch { return 'member'; } };
const isMgrP = (p) => ['host', 'cohost'].includes(roleOfP(p));
const chatWho = () => session?.meta?.chatWho ?? (session?.meta?.allowChat === false ? 'none' : 'all');

function addChat(cls, who, text, file = null) {
  chatLog.push(`[${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${who ? `${who}: ` : ''}${file ? `[file] ${file.name}` : text}`);
  const log = $('chat-log');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  if (who) {
    const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
    const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const body = document.createElement('div');
    if (file) body.append(classroom.fileNode(file)); else body.textContent = text;
    el.append(w, tm, body);
  } else {
    el.textContent = text;
  }
  log.append(el);
  while (log.children.length > CHAT_MAX_MSGS) log.firstChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
}
function addSystem(text) { addChat('system', null, text); }

// The "To:" list: everyone, or one person. Host tools can limit it: host only, or nobody.
function refreshChatTo() {
  if (!room) return;
  const sel = $('chat-to'), keep = sel.value, who = chatWho(), mgr = meeting.isManager();
  const people = [...room.remoteParticipants.values()].filter((p) => (mgr || who === 'all' || isMgrP(p)) && (!isBig() || isMgrP(p)));
  const opts = [];
  if (mgr || who === 'all') opts.push(new Option('Everyone', 'all'));
  for (const p of people) opts.push(new Option(`${p.name || p.identity}${isMgrP(p) ? (roleOfP(p) === 'host' ? ' (Host)' : ' (Co-host)') : ''}`, p.identity));
  sel.replaceChildren(...opts);
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  const blocked = !mgr && (who === 'none' || (who === 'host' && !people.length));
  $('chat-input').disabled = blocked;
  $('chat-to').disabled = blocked;
  $('chat-input').placeholder = blocked ? (who === 'none' ? 'The host has turned chat off' : 'Only the host can be messaged') : (sel.value === 'all' ? 'Message everyone' : 'Private message');
  $('chat-who-note').textContent = blocked ? 'You cannot send messages right now' : sel.value === 'all' ? 'Everyone can see your messages' : `Only ${sel.selectedOptions[0]?.textContent.replace(/ \((Host|Co-host)\)$/, '')} can see this message`;
}
$('chat-to').onchange = refreshChatTo;

// ---------------------------------------------------------------- whiteboard and local recording
const canDrawBoard = () => meeting.isManager() || (session?.meta?.wbWho ?? 'all') === 'all';
const board = initWhiteboard({ $, getRoom: () => room, getSession: () => session, toast, isManager: () => meeting.isManager(), allowedToDraw: canDrawBoard });
const canRecord = () => meeting.isManager() || session?.meta?.allowRecord === true;
const recorder = initRecorder({ $, store, getRoom: () => room, toast, getBoardCanvas: () => board.canvas, onChange: () => paintRec() });

function paintRec() {
  const others = room ? [...room.remoteParticipants.values()].filter((p) => p.attributes?.rec) : [];
  const mine = recorder.active, anyone = mine || others.length;
  $('rec-badge').hidden = !anyone;
  $('rec-badge').classList.toggle('paused', mine && recorder.paused);
  $('rec-text').textContent = mine ? (recorder.paused ? 'PAUSED' : `REC ${String(Math.floor(recorder.seconds / 60)).padStart(2, '0')}:${String(recorder.seconds % 60).padStart(2, '0')}`) : 'REC';
  $('rec-badge').title = anyone ? [...(mine ? ['You'] : []), ...others.map((p) => p.name || p.identity)].join(', ') + ' recording' : '';
  $('btn-rec').hidden = !mine;
  $('rec-lbl').textContent = recorder.paused ? 'Paused' : 'Recording';
  $('rec-pause-label').textContent = recorder.paused ? 'Resume recording' : 'Pause recording';
  $('btn-record').setAttribute('aria-pressed', String(mine));
  $('btn-record').querySelector('.lbl').textContent = mine ? 'Stop recording' : 'Record';
  $('btn-record').hidden = !canRecord() && !mine;
  $('btn-record').disabled = recorder.busy;
}
setInterval(() => { if (recorder.active) paintRec(); }, 1000);
$('btn-record').onclick = () => { closePops(); if (recorder.active) recorder.stop(); else if (canRecord()) recorder.start(); else toast('The host has not allowed participants to record.'); };
$('rec-pause').onclick = () => { closePops(); recorder.pause(!recorder.paused); };
$('rec-stop').onclick = () => { closePops(); recorder.stop(); };
$('rec-settings').onclick = () => { closePops(); openSettings('rec'); };

$('wb-new').onclick = () => { closePops(); if (!canDrawBoard()) { toast('The host has limited who can use the whiteboard.'); return; } board.newBoard(); };
$('wb-existing').onclick = () => { closePops(); if (board.isOpen) board.newBoard(); else toast('There is no whiteboard in this meeting yet. Choose New whiteboard.', 'info'); };

function onData(payload, participant, _kind, topic) {
  if (topic === meeting.REACT_TOPIC) return meeting.onReaction(participant, payload);
  if (topic === 'sanwes.wb') return board.onData(payload, participant);
  if (topic === CLASS_TOPIC) return classroom.onData(payload, participant);
  if (topic === RP_TOPIC || topic === RPI_TOPIC) return gamehub.onData(topic, payload, participant);
  if (topic === CC_TOPIC) return captions.onData(payload, participant);
  if (topic !== CHAT_TOPIC || !participant) return; // sender name comes from LiveKit, never from the payload
  let msg;
  try { msg = JSON.parse(decoder.decode(payload)); } catch { return; }
  const text = msg?.text;
  const file = msg?.file && /^[a-f0-9]{16}$/.test(String(msg.file.id)) ? { id: String(msg.file.id), name: String(msg.file.name ?? 'file').slice(0, 120), size: Number(msg.file.size) || 0 } : null;
  if (!file && (typeof text !== 'string' || !text.trim())) return;
  // Host tools can switch chat off or limit it to the host: ordinary participants' messages are dropped by everyone else.
  const sender = isMgrP(participant), mine = meeting.isManager();
  if (!sender && !mine) { const w = chatWho(); if (w === 'none' || (w === 'host' && msg.dm !== true)) return; }
  if (!sender && chatWho() === 'none') return;
  addChat(msg.dm === true ? 'private' : '', participant.name || participant.identity, file ? '' : text.slice(0, CHAT_MAX_LEN), file);
  if ($('chat').hidden || sidePane !== 'chat') { unread++; updateBadge(); }
}

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim().slice(0, CHAT_MAX_LEN);
  if (!text || !room || room.state !== ConnectionState.Connected || input.disabled) return;
  const to = $('chat-to').value, dm = to !== 'all';
  input.value = '';
  try {
    await room.localParticipant.publishData(encoder.encode(JSON.stringify({ text, dm })), { reliable: true, topic: CHAT_TOPIC, ...(dm ? { destinationIdentities: [to] } : {}) });
    addChat(dm ? 'me private' : 'me', dm ? `You → ${$('chat-to').selectedOptions[0].textContent}` : `${session.name} (you)`, text);
  } catch (ex) {
    input.value = text;
    toast(`Message not sent: ${ex.message}`);
  }
});

// The "..." menu in the chat header: save the chat; the host also decides who people may message.
$('chat-more').addEventListener('click', () => {
  const items = [];
  const item = (label, fn, on = false) => {
    const b = document.createElement('button'); b.type = 'button';
    const chk = document.createElement('span'); chk.className = 'chk'; b.append(chk, document.createTextNode(label));
    b.classList.toggle('on', on); b.onclick = () => { closePops(); fn(); };
    items.push(b);
  };
  item('Save chat', saveChat);
  if (meeting.isManager()) {
    const t = document.createElement('div'); t.className = 'mn-title'; t.textContent = 'Allow participants to chat with:'; items.push(document.createElement('hr'), t);
    for (const [v, label] of [['none', 'No one'], ['host', 'Host only'], ['all', 'Everyone']]) item(label, () => meeting.setSetting('chatWho', v).catch((e) => toast(e.message)), chatWho() === v);
  }
  $('chat-menu').replaceChildren(...items);
});
function saveChat() {
  if (!chatLog.length) { toast('There are no messages to save yet.', 'info'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`${$('room-title').textContent}\n\n${chatLog.join('\n')}\n`], { type: 'text/plain' }));
  a.download = `chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------------------------------------------------------- device pickers

const DEVICE_KINDS = { audioinput: 'Microphone', audiooutput: 'Speaker', videoinput: 'Camera' };

async function refreshDevices() {
  let anyUnlabeled = false;
  for (const [kind, noun] of Object.entries(DEVICE_KINDS)) {
    const sel = $(`sel-${kind}`);
    if (kind === 'audiooutput' && !supportsAudioOutputSelection()) { $('lbl-audiooutput').hidden = true; continue; }
    let devices = [];
    try { devices = await Room.getLocalDevices(kind, false); } catch { /* no permission or no devices */ }
    sel.replaceChildren();
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${noun} ${i + 1}`;
      if (!d.label) anyUnlabeled = true;
      sel.append(o);
    });
    if (!devices.length) { const o = document.createElement('option'); o.textContent = `No ${noun.toLowerCase()} found`; sel.append(o); }
    sel.disabled = !devices.length;
    const active = room?.getActiveDevice(kind);
    if (active && devices.some((d) => d.deviceId === active)) sel.value = active;
  }
  $('settings-note').textContent = anyUnlabeled ? 'Device names appear after you allow microphone / camera access (turn the camera on once).' : '';
}

for (const kind of Object.keys(DEVICE_KINDS)) {
  $(`sel-${kind}`).addEventListener('change', async (e) => {
    if (!room) return;
    try {
      const ok = await room.switchActiveDevice(kind, e.target.value);
      if (!ok) throw new Error('the browser refused this device');
      store.set(`sanwes.dev.${kind}`, e.target.value);
    } catch (ex) {
      toast(`${DEVICE_KINDS[kind]}: ${ex.message}`);
      refreshDevices();
    }
  });
}

// ---------------------------------------------------------------- audio and video menus (the caret menus next to the buttons)

const micMode = () => (store.get('sanwes.micMode') === 'original' ? 'original' : 'noise');
const noop = () => {};

// "Same as system (X)" for the default device, like the real client; the browser's duplicate "communications" entry is hidden.
async function fillDevices(container, kind, noun) {
  let list = [];
  try { list = (await Room.getLocalDevices(kind, false)).filter((d) => d.deviceId !== 'communications'); } catch { /* none */ }
  const active = room?.getActiveDevice(kind) ?? store.get(`sanwes.dev.${kind}`) ?? 'default';
  if (kind === 'audiooutput' && !supportsAudioOutputSelection()) { const n = document.createElement('div'); n.className = 'mn-note'; n.textContent = "This browser can't choose a speaker."; container.replaceChildren(n); return; }
  const items = list.map((d, i) => {
    const b = document.createElement('button'); b.type = 'button';
    const chk = document.createElement('span'); chk.className = 'chk';
    const base = (d.label || `${noun} ${i + 1}`).replace(/^Default - /, '');
    b.append(chk, document.createTextNode(d.deviceId === 'default' ? `Same as system (${base})` : base));
    b.classList.toggle('on', d.deviceId === active);
    b.onclick = async () => {
      closePops();
      try { if (!(await room.switchActiveDevice(kind, d.deviceId))) throw new Error('the browser refused this device'); store.set(`sanwes.dev.${kind}`, d.deviceId); toast(`${noun[0].toUpperCase()}${noun.slice(1)} changed.`, 'info'); }
      catch (e) { toast(`${noun}: ${e.message}`); }
    };
    return b;
  });
  if (!items.length) { const n = document.createElement('div'); n.className = 'mn-note'; n.textContent = `No ${noun} found`; items.push(n); }
  container.replaceChildren(...items);
}

function buildAudioMenu() {
  fillDevices($('am-mics'), 'audioinput', 'microphone');
  fillDevices($('am-spk'), 'audiooutput', 'speaker');
  $('am-mode-noise').classList.toggle('on', micMode() === 'noise' && aiNoiseWanted());
  $('am-mode-original').classList.toggle('on', micMode() === 'original');
  $('am-leave-label').textContent = session?.audioLeft ? 'Join computer audio' : 'Leave computer audio';
}
function buildVideoMenu() {
  fillDevices($('vm-cams'), 'videoinput', 'camera');
  $('vm-blur').checked = ['blur', 'blur-strong'].includes(bgChoice());
}

// "Original sound for musicians": no echo cancellation / noise removal / level control, stereo at 128 kbit/s, no silence suppression.
// The publish settings are fixed when a track is published, so changing mode republishes the microphone.
async function republishMic() {
  const lp = room?.localParticipant; if (!lp) return;
  const pub = lp.getTrackPublication(Track.Source.Microphone);
  const wasOn = lp.isMicrophoneEnabled;
  if (pub?.track) await lp.unpublishTrack(pub.track, true);
  if (session?.audioLeft) return;
  const orig = micMode() === 'original';
  const capture = orig
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
    : { echoCancellation: true, noiseSuppression: !aiNoiseWanted(), autoGainControl: true, channelCount: 1 };
  const publish = orig
    ? { audioPreset: { maxBitrate: 128_000 }, forceStereo: true, dtx: false, red: false }
    : { audioPreset: { maxBitrate: 64_000 }, forceStereo: false, dtx: true, red: true };
  await lp.setMicrophoneEnabled(true, capture, publish);
  await applyNoiseProcessor();
  if (!wasOn) await lp.setMicrophoneEnabled(false);
  rememberMedia(); sync(); updateButtons();
}
async function setMicMode(mode) {
  store.set('sanwes.micMode', mode);
  store.set('sanwes.aiNoise', mode === 'noise' ? '1' : '0');
  $('chk-noise').checked = aiNoiseWanted();
  try {
    await republishMic();
    toast(mode === 'noise' ? 'Microphone: noise removal is on.' : 'Microphone: original sound for musicians (no filtering, stereo, 128 kbit/s).', 'info');
  } catch (e) { toast(`Microphone mode: ${e.message}`); }
}
$('am-mode-noise').onclick = () => { closePops(); setMicMode('noise'); };
$('am-mode-original').onclick = () => { closePops(); setMicMode('original'); };

async function toggleAudioLeave() {
  const lp = room?.localParticipant; if (!lp) return;
  try {
    if (session.audioLeft) {
      session.audioLeft = false;
      await lp.setMicrophoneEnabled(true); await applyNoiseProcessor();
      toast('You joined computer audio.', 'info');
    } else {
      const pub = lp.getTrackPublication(Track.Source.Microphone);
      if (pub?.track) await lp.unpublishTrack(pub.track, true);
      session.audioLeft = true;
      toast('You left computer audio: nobody can hear you until you join again.', 'info');
    }
  } catch (e) { toast(`Audio: ${e.message}`); }
  rememberMedia(); sync(); updateButtons();
}
$('am-leave').onclick = () => { closePops(); toggleAudioLeave(); };
$('am-settings').onclick = () => { closePops(); openSettings('audio'); };
$('vm-settings').onclick = () => { closePops(); openSettings('video'); };
$('vm-blur').onchange = () => { store.set('sanwes.bg', $('vm-blur').checked ? 'blur' : 'off'); $('sel-bg').value = bgChoice(); applyBackground(); };

// "Test speaker & microphone": a tone through the chosen speaker, and a live level bar for the chosen microphone.
let testStream = null, testRaf = 0;
$('am-test').onclick = async () => {
  closePops();
  $('at-note').textContent = '';
  $('audio-test').showModal();
  try {
    const mic = room?.getActiveDevice('audioinput') ?? store.get('sanwes.dev.audioinput');
    testStream = await navigator.mediaDevices.getUserMedia({ audio: mic && mic !== 'default' ? { deviceId: { exact: mic } } : true });
    const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(testStream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const draw = () => { an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); $('at-level').style.width = `${Math.min(100, peak * 1.6)}%`; testRaf = requestAnimationFrame(draw); };
    draw();
    testStream.__ctx = ctx;
  } catch (e) { $('at-note').textContent = `Could not open the microphone: ${e.message}`; }
};
$('at-play').onclick = async () => {
  const ctx = new AudioContext();
  const out = room?.getActiveDevice('audiooutput') ?? store.get('sanwes.dev.audiooutput');
  if (out && out !== 'default' && ctx.setSinkId) { try { await ctx.setSinkId(out); } catch { /* use the default speaker */ } }
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.frequency.value = 523; g.gain.value = 0.15; osc.connect(g).connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + 1.2); osc.onended = () => ctx.close();
};
const stopAudioTest = () => { cancelAnimationFrame(testRaf); testStream?.getTracks().forEach((t) => t.stop()); testStream?.__ctx?.close().catch(noop); testStream = null; };
$('at-close').onclick = () => $('audio-test').close();
$('audio-test').addEventListener('close', stopAudioTest);

function showSettingsSection(sec) {
  for (const s of document.querySelectorAll('#settings .set-body > section')) s.hidden = s.dataset.sec !== sec;
  for (const b of document.querySelectorAll('#settings .set-nav button')) b.setAttribute('aria-current', String(b.dataset.sec === sec));
}
for (const b of document.querySelectorAll('#settings .set-nav button')) b.onclick = () => showSettingsSection(b.dataset.sec);
const REC_BOXES = [['rs-names', 'names'], ['rs-time', 'time'], ['rs-share', 'share'], ['rs-side', 'side'], ['ro-video', 'oVideo'], ['ro-videoonly', 'oVideoOnly'], ['ro-audio', 'oAudio'], ['ro-each', 'oEach']];
for (const [id, key] of REC_BOXES) $(id).onchange = () => { recorder.prefs[key] = $(id).checked; };
$('chk-preview').onchange = () => store.set('sanwes.preview', $('chk-preview').checked ? '1' : '0');
async function openSettings(sec = 'video') {
  if (typeof sec !== 'string') sec = 'video'; // called straight from a click handler
  home.paintReminderSettings();
  for (const [id, key] of REC_BOXES) $(id).checked = recorder.prefs[key];
  $('ro-note').textContent = recorder.mp4Supported() ? 'Saved straight into standard MP4 / M4A files that play everywhere: there is no conversion wait after Stop. More than one file comes in a single .zip.' : 'This browser cannot write MP4, so files are saved as WebM / WEBA (VLC and Chrome play them; Windows Movies & TV may not play the sound). Use Chrome or Edge for MP4.';
  $('chk-preview').checked = store.get('sanwes.preview') !== '0';
  showSettingsSection(sec);
  await refreshDevices();
  $('settings').showModal();
  refreshHealth();
  healthTimer = setInterval(refreshHealth, 1500);
}
$('btn-settings').onclick = () => { closePops(); openSettings(); };

// ---------------------------------------------------------------- connection health (Settings)

// Reads WebRTC stats so audio problems can be told apart: bad network path (TCP / relay / high RTT), jitter and loss,
// or the receiver stretching audio to hide gaps.
const prevStats = { share: null, mic: null };
const dbfs = (power) => (power > 0 ? 10 * Math.log10(power) : -100);

async function collectHealth() {
  if (!room || room.state !== ConnectionState.Connected) return 'Not connected.';
  const lp = room.localParticipant;
  const pcs = [room.engine?.pcManager?.publisher?.pc, room.engine?.pcManager?.subscriber?.pc].filter(Boolean);
  const shareTrackId = lp.getTrackPublication(Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack.id;
  const micTrackId = lp.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack.id;
  const lines = [];
  let pair, local, outbound, remoteIn, videoOut, shareSrc, micSrc;
  const inbound = [];
  for (const pc of pcs) {
    const report = await pc.getStats();
    report.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') { pair = pair ?? r; local = local ?? report.get(r.localCandidateId); }
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound.push(r);
      if (r.type === 'outbound-rtp' && r.kind === 'audio') outbound = r;
      if (r.type === 'outbound-rtp' && r.kind === 'video') videoOut = videoOut?.frameWidth > r.frameWidth ? videoOut : r;
      if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') remoteIn = r;
      if (r.type === 'media-source' && r.kind === 'audio') {
        if (r.trackIdentifier === shareTrackId) shareSrc = r;
        else if (r.trackIdentifier === micTrackId) micSrc = r;
      }
    });
  }

  // ---- network path
  if (pair) {
    const proto = (local?.relayProtocol ?? local?.protocol ?? '?').toUpperCase();
    const via = local?.candidateType === 'relay' ? 'TURN relay' : proto;
    lines.push(`Path: ${via} · round trip ${Math.round((pair.currentRoundTripTime ?? 0) * 1000)} ms`);
    if (proto === 'TCP' || local?.candidateType === 'relay') lines.push('  ! TCP / relay adds delay and stutter. UDP is blocked or not forwarded on one side.');
  }

  // ---- what you send
  if (outbound && remoteIn) {
    const sent = outbound.packetsSent || 1;
    lines.push(`Your audio → others: loss ${((remoteIn.packetsLost / (sent + remoteIn.packetsLost)) * 100).toFixed(1)}% · jitter ${Math.round((remoteIn.jitter ?? 0) * 1000)} ms`);
  }
  const level = (src, key) => {
    if (!src) return null;
    const prev = prevStats[key]; prevStats[key] = { e: src.totalAudioEnergy, d: src.totalSamplesDuration };
    if (!prev || src.totalSamplesDuration <= prev.d) return undefined;
    return dbfs((src.totalAudioEnergy - prev.e) / (src.totalSamplesDuration - prev.d));
  };
  const sh = level(shareSrc, 'share');
  if (shareSrc) {
    if (sh == null) lines.push('Shared sound: measuring…');
    else {
      lines.push(`Shared sound level: ${sh.toFixed(0)} dBFS average ${sh < -45 ? '(silent)' : sh < -32 ? '(too quiet)' : sh > -8 ? '(very loud, may distort)' : '(good)'}`);
      if (sh < -32 && sh > -80) lines.push('  ! Raise the volume in the player (VLC) or choose "Louder" in Settings → Shared sound volume.');
    }
    if (lp.isMicrophoneEnabled && !lp.getTrackPublication(Track.Source.Microphone)?.isMuted) lines.push('  ! Mic is open while sharing sound: use headphones or mute, or listeners hear an echo.');
  }
  level(micSrc, 'mic');
  if (videoOut?.qualityLimitationReason === 'cpu') lines.push('  ! This PC is too busy to encode the video in time. That also glitches sound. Lower the resolution/frame rate in Settings.');
  if (videoOut?.qualityLimitationReason === 'bandwidth') lines.push('  ! Your upload is too slow for the chosen video quality. Lower the bitrate or resolution.');

  // ---- what you hear
  const agg = inbound.reduce((a, r) => ({
    lost: a.lost + (r.packetsLost ?? 0), got: a.got + (r.packetsReceived ?? 0),
    jitter: Math.max(a.jitter, r.jitter ?? 0),
    jbDelay: a.jbDelay + (r.jitterBufferDelay ?? 0), jbCount: a.jbCount + (r.jitterBufferEmittedCount ?? 0),
    concealed: a.concealed + (r.concealedSamples ?? 0), samples: a.samples + (r.totalSamplesReceived ?? 0),
    fast: a.fast + (r.removedSamplesForAcceleration ?? 0), slow: a.slow + (r.insertedSamplesForDeceleration ?? 0),
  }), { lost: 0, got: 0, jitter: 0, jbDelay: 0, jbCount: 0, concealed: 0, samples: 0, fast: 0, slow: 0 });
  if (inbound.length) {
    const loss = (agg.lost / (agg.got + agg.lost || 1)) * 100;
    const buffer = agg.jbCount ? (agg.jbDelay / agg.jbCount) * 1000 : 0;
    const concealed = agg.samples ? (agg.concealed / agg.samples) * 100 : 0;
    const fast = agg.samples ? (agg.fast / agg.samples) * 100 : 0, slow = agg.samples ? (agg.slow / agg.samples) * 100 : 0;
    lines.push(`Others → you (${inbound.length} stream${inbound.length > 1 ? 's' : ''}): loss ${loss.toFixed(1)}% · jitter ${Math.round(agg.jitter * 1000)} ms · delay ${Math.round(buffer)} ms`);
    lines.push(`  glitches patched ${concealed.toFixed(1)}% · sped up ${fast.toFixed(1)}% · slowed ${slow.toFixed(1)}%`);
    if (concealed > 3) lines.push('  ! Robotic sound = packets are missing and the player is guessing. Weak Wi-Fi or a busy sender.');
    if (fast > 3 || slow > 3) lines.push('  ! "Fast" or "slow" voices = the player stretches audio to hide uneven delivery. Network jitter, or an overloaded sender.');
    if (loss > 2 || agg.jitter > 0.03) lines.push('  ! Audio arrives unevenly: try 5 GHz Wi-Fi or a cable on both sides.');
    if (buffer > 250) lines.push('  ! High delay: the player is buffering a lot to survive a bad connection.');
  } else {
    lines.push('Nobody else is sending audio right now.');
  }
  if (!lines.some((l) => l.startsWith('  !'))) lines.push('Looks healthy. Echo still? Use headphones or keep devices in different rooms.');
  return lines.join('\n');
}

let healthTimer = null;
async function refreshHealth() { try { $('health').textContent = await collectHealth(); } catch (e) { $('health').textContent = `Could not read stats: ${e.message}`; } }
$('settings').addEventListener('close', () => { clearInterval(healthTimer); healthTimer = null; });

// ---------------------------------------------------------------- misc

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = kind ? `toast ${kind}` : 'toast'; el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), kind === 'info' ? 9000 : 5000);
}

const meeting = initMeeting({ $, getRoom: () => room, getSession: () => session, toast, setChatOpen, openPop, closePops });
const classroom = initClassroom({ $, getRoom: () => room, getSession: () => session, toast, meeting, setChatOpen, addChat, onBo: (m) => breakoutUi.onMessage(m) });
const gamehub = initGameHub({ $, getRoom: () => room, getSession: () => session, toast, meeting, isTheater });
const captions = initCaptions({ $, getRoom: () => room, meeting, toast, store, isMgrP });
const breakoutUi = initBreakoutUi({ $, getSession: () => session, toast, meeting, setChatOpen, onClosing: () => { rememberMedia(); if (session) session.freezeMedia = true; }, switchRoom: (name, o) => switchRoom(name, o), returnToMain: () => returnToMain() });

// Move into a breakout room (or back to the main meeting) without leaving the meeting screen: drop this room's connection,
// ask for a token for the other room and connect again. Microphone and camera choices carry over.
async function switchRoom(next, { main = null, n = 0 } = {}) {
  if (!session || session.switching) return;
  session.switching = true;
  try {
    rememberMedia();
    const old = room; room = null; stopRejoinTimer();
    session.joined = false; old?.disconnect(); clearMedia();
    classroom.reset(); gamehub.reset(); meeting.reset(); board.close(); chatLog.length = 0; $('chat-log').replaceChildren();
    if (main) {
      session.boMain = main; session.boN = n;
      session.mainSecret ??= session.hostSecret; session.mainPassword ??= session.password;
      session.hostSecret = ''; session.password = '';
    } else {
      session.hostSecret = session.mainSecret ?? session.hostSecret; session.password = session.mainPassword ?? session.password;
      delete session.boMain; delete session.boN; delete session.mainSecret; delete session.mainPassword;
    }
    session.roomName = next;
    await connect();
    breakoutUi.reset(); breakoutUi.refresh();
    toast(main ? `You joined Breakout Room ${n}.` : 'You are back in the main session.', 'info');
  } catch (ex) {
    toast(`Could not move: ${ex.message}`);
    if (session && !room) scheduleRejoin(1);
  } finally { if (session) { session.switching = false; delete session.freezeMedia; } }
}
function returnToMain() { return session?.boMain ? switchRoom(session.boMain) : Promise.resolve(); }

const home = initHome({ startJoin, toast, openSettings });
const protect = initProtect({ $, toast, getLabel: () => { const u = account.me(); return u ? `${u.displayName || u.username} · @${u.username}` : (session?.name ?? ''); } });
const account = initAccount({ onSignedIn: (u) => home.start(u), openSettings: (s) => openSettings(s), openProfile: () => home.openProfile(), toast });
account.boot();
home.setRoomNameFn(() => session?.roomName ?? null);

window.__sanwes = { get room() { return room; }, get session() { return session; }, get gamehub() { return gamehub; }, createGainProcessor, store, join: (name, roomName, extra = {}) => startJoin({ name, roomName, ...extra }) }; // handy for debugging/tests
