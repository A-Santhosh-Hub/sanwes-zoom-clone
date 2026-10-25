// The class bot. SanWe's opens this page in a hidden Edge/Chrome window on the host computer.
// It joins the meeting as "Class video", plays the scheduled videos as a shared screen with sound, and records the class.
// Everything it needs comes from /api/bot/* with the run key in the page address.
import { Room, RoomEvent, Track, LocalVideoTrack, LocalAudioTrack, VideoPreset, AudioPresets, ConnectionState } from 'livekit-client';

const params = new URLSearchParams(location.hash.slice(1));
const RUN = params.get('run') ?? '', KEY = params.get('key') ?? '';
const logEl = document.getElementById('log');
const outbox = []; // lines for the server's log of this run
const say = (m) => { outbox.push(m); logEl.textContent += `\n${new Date().toLocaleTimeString()} ${m}`; if (logEl.textContent.length > 6000) logEl.textContent = logEl.textContent.slice(-4000); };
const q = (p) => `${p}${p.includes('?') ? '&' : '?'}run=${RUN}&key=${encodeURIComponent(KEY)}`;
const j = async (p, opt) => { const r = await fetch(q(p), opt); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roleOf = (p) => { try { return JSON.parse(p?.metadata || '{}').role ?? 'member'; } catch { return 'member'; } };
const isMgr = (p) => ['host', 'cohost'].includes(roleOf(p));

const W = 1280, H = 720;
let cfg, room, offset = 0, lastError = '';
const done = new Set();                  // steps that have played to their end (or were stopped)
let cur = -1, manual = false;            // step playing now; manual = started from the board, ignores the timeline until it ends
const talk = [];                         // last few seconds: was a host or co-host talking? (sampled four times a second)
let videosDoneAt = 0;                    // when the last scheduled video finished (or when there are none)
let recorder = null;                     // { stop() }
let emptySince = 0, leaving = false, sawPeople = false;

// ---------------------------------------------------------------- audio graph: nothing goes to the speakers of this computer
const ac = new AudioContext({ sampleRate: 48000 });
const pubDest = ac.createMediaStreamDestination(); // what the class hears from the video
const recDest = ac.createMediaStreamDestination(); // what the recording hears
pubDest.channelCount = 2; recDest.channelCount = 2;
const video = Object.assign(document.createElement('video'), { playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0';
document.body.append(video);
const vSrc = ac.createMediaElementSource(video);
vSrc.connect(pubDest); vSrc.connect(recDest);

// ---------------------------------------------------------------- picture: two canvases, one for what we publish, one for the recording
const pubCanvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
const recCanvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
const pubCtx = pubCanvas.getContext('2d', { alpha: false }), recCtx = recCanvas.getContext('2d', { alpha: false });
function contain(ctx, el, x, y, w, h) {
  const sw = el.videoWidth || el.width, sh = el.videoHeight || el.height; if (!sw || !sh) return;
  const s = Math.min(w / sw, h / sh), dw = sw * s, dh = sh * s;
  ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// ---------------------------------------------------------------- what the bot listens to / watches in the room
const els = new Map(); // track sid -> { el, pub, p, node }
function wantedPub(p, pub, now) {
  if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) return true;
  if (isMgr(p)) return pub.source === Track.Source.Camera || pub.source === Track.Source.Microphone;
  if (pub.source === Track.Source.Microphone) return speakers.has(p.identity) && now - speakers.get(p.identity) < 8000; // a student who is talking
  return false;
}
const speakers = new Map(); // identity -> last time seen speaking
let subTimer = 0;
function updateSubs() {
  if (!room || room.state !== ConnectionState.Connected) return;
  const now = Date.now();
  for (const p of room.remoteParticipants.values()) {
    if (roleOf(p) === 'bot') continue;
    for (const pub of p.trackPublications.values()) {
      const want = wantedPub(p, pub, now);
      if (pub.__want !== want) { pub.__want = want; pub.setSubscribed(want); }
    }
  }
}
const scheduleSubs = () => { if (!subTimer) subTimer = setTimeout(() => { subTimer = 0; updateSubs(); }, 300); };

function onSubscribed(track, pub, p) {
  const mst = track.mediaStreamTrack, stream = new MediaStream([mst]);
  const rec = { pub, p, track };
  if (track.kind === Track.Kind.Video) {
    rec.el = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true, srcObject: stream });
    rec.el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0';
    document.body.append(rec.el); rec.el.play().catch(() => {});
  } else { // audio: into the recording only. The muted element keeps the browser feeding the stream (a known quirk)
    rec.el = Object.assign(document.createElement('audio'), { muted: true, srcObject: stream }); rec.el.play().catch(() => {});
    rec.node = ac.createMediaStreamSource(stream); rec.node.connect(recDest);
  }
  els.set(track.sid ?? pub.trackSid, rec);
}
function onUnsubscribed(track, pub) {
  const id = track.sid ?? pub.trackSid, rec = els.get(id); if (!rec) return;
  rec.node?.disconnect(); rec.el?.pause(); rec.el?.remove(); els.delete(id);
}
const videoOf = (p, source) => { for (const r of els.values()) if (r.p === p && r.pub.source === source && r.track.kind === Track.Kind.Video && r.el.videoWidth) return r.el; return null; };
function teacherCam() {
  const all = [...room.remoteParticipants.values()].filter((p) => roleOf(p) !== 'bot');
  for (const role of ['host', 'cohost']) for (const p of all) if (roleOf(p) === role) { const v = videoOf(p, Track.Source.Camera); if (v) return v; }
  return null;
}
function anyShare() {
  for (const r of els.values()) if (r.pub.source === Track.Source.ScreenShare && r.p.identity !== room.localParticipant.identity && r.el.videoWidth) return r.el;
  return null;
}

// ---------------------------------------------------------------- drawing
function drawPub() {
  pubCtx.fillStyle = '#000'; pubCtx.fillRect(0, 0, pubCanvas.width, pubCanvas.height);
  contain(pubCtx, video, 0, 0, pubCanvas.width, pubCanvas.height);
}
function drawRec() {
  const c = recCtx; c.fillStyle = '#0d1117'; c.fillRect(0, 0, W, H);
  const playing = cur >= 0 && !video.paused && video.readyState >= 2;
  const share = anyShare(), cam = teacherCam();
  const main = playing ? video : share ?? cam;
  if (main) contain(c, main, 0, 0, W, H);
  else {
    c.fillStyle = '#e6edf3'; c.font = '600 44px system-ui'; c.textAlign = 'center'; c.fillText(cfg?.topic ?? "SanWe's", W / 2, H / 2 - 10);
    c.fillStyle = '#8b949e'; c.font = '24px system-ui'; c.fillText(new Date().toLocaleString(), W / 2, H / 2 + 34);
  }
  if (cam && main !== cam) { // the teacher's camera in the corner while something else fills the picture
    const w = 320, h = 180, x = W - w - 16, y = H - h - 16;
    c.fillStyle = '#000'; c.fillRect(x - 2, y - 2, w + 4, h + 4); contain(c, cam, x, y, w, h);
  }
}
let drawTimer = 0;
function startDrawing() {
  if (drawTimer) return;
  drawTimer = setInterval(() => { if (cur >= 0) drawPub(); if (recorder) drawRec(); }, 33);
}

// ---------------------------------------------------------------- publishing the video
let pubVideo = null, pubAudio = null, vPub = null, aPub = null;
async function publishVideo() {
  if (vPub) return;
  const vt = pubCanvas.captureStream(cfg.pub.fps).getVideoTracks()[0];
  vt.contentHint = 'motion';
  pubVideo = new LocalVideoTrack(vt, undefined, true);
  pubAudio = new LocalAudioTrack(pubDest.stream.getAudioTracks()[0], undefined, true);
  const top = cfg.pub.kbps * 1000, small = cfg.pub.h > 360;
  const layers = small ? [new VideoPreset(640, 360, Math.min(350_000, top / 2), cfg.pub.fps), new VideoPreset(320, 180, 120_000, 15)] : [new VideoPreset(320, 180, 110_000, 15)];
  vPub = await room.localParticipant.publishTrack(pubVideo, {
    source: Track.Source.ScreenShare, name: 'class-video', simulcast: true,
    videoEncoding: { maxBitrate: top, maxFramerate: cfg.pub.fps }, screenShareEncoding: { maxBitrate: top, maxFramerate: cfg.pub.fps },
    videoSimulcastLayers: layers, screenShareSimulcastLayers: layers, degradationPreference: 'maintain-framerate',
  });
  aPub = await room.localParticipant.publishTrack(pubAudio, { source: Track.Source.ScreenShareAudio, name: 'class-video-sound', audioPreset: AudioPresets.music, dtx: false, red: false });
}
async function unpublishVideo() {
  if (!vPub && !aPub) return;
  try { if (pubVideo) await room.localParticipant.unpublishTrack(pubVideo, true); } catch { /* gone */ }
  try { if (pubAudio) await room.localParticipant.unpublishTrack(pubAudio, true); } catch { /* gone */ }
  pubVideo = pubAudio = vPub = aPub = null;
}

// ---------------------------------------------------------------- the timeline
const nowMs = () => Date.now() + offset;
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const clockOf = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
async function playStep(i, fromMs, isManual) {
  const s = cfg.steps[i]; if (!s) return;
  await withTimeout(ac.resume(), 5000, 'the audio system did not start').catch(() => {});
  video.loop = s.loop;
  video.src = s.url;
  await withTimeout(new Promise((ok, fail) => { video.onloadedmetadata = ok; video.onerror = () => fail(new Error(`"${s.name}" cannot be played by this browser`)); }), 40_000, `"${s.name}" did not load (is the video file complete?)`);
  const dur = video.duration || 0;
  if (fromMs > 0 && dur) {
    if (!s.loop && fromMs / 1000 >= dur - 1) { done.add(i); cur = -1; say(`"${s.name}" was already over when the class bot started`); checkVideosDone(); return; } // already over
    video.currentTime = s.loop ? (fromMs / 1000) % dur : fromMs / 1000;
  }
  cur = i; manual = isManual; videosDoneAt = 0;
  await withTimeout(video.play(), 10_000, `"${s.name}" would not start playing`);
  drawPub();
  await withTimeout(publishVideo(), 25_000, 'the video could not be sent to the room');
  say(`playing "${s.name}"${s.loop ? ' (repeating)' : ''}`);
}
async function stopPlaying(markDone = true) {
  if (cur < 0) return;
  const i = cur; cur = -1; manual = false;
  video.pause(); video.removeAttribute('src'); video.load();
  if (markDone) done.add(i);
  await unpublishVideo();
  say('video stopped');
  checkVideosDone();
}
video.addEventListener('ended', () => { if (cur >= 0 && !video.loop) stopPlaying(true).then(() => timelineTick()).catch(() => {}); }); // the next step ("right after this video") starts at once

const LATE_OK_MS = 30_000; // up to this late, a video still starts from its beginning
// Which step should be playing now? A step starts at its minute, or (after) the moment the step above it has finished.
function wantedIndex(el) {
  let want = -1;
  cfg.steps.forEach((s, i) => { if (!s.after && s.atMs <= el) want = i; });
  cfg.steps.forEach((s, i) => { if (s.after && i > 0 && done.has(i - 1) && !done.has(i) && i > want) want = i; });
  return want;
}
function checkVideosDone() {
  const pending = cfg.steps.some((_, i) => !done.has(i));
  if (cur < 0 && !pending && !videosDoneAt) { videosDoneAt = Date.now(); say('all scheduled videos are finished'); }
}
/** What plays next and when (wall clock of this computer), for the board. */
function nextInfo() {
  for (let i = 0; i < cfg.steps.length; i++) {
    if (done.has(i) || i === cur) continue;
    const s = cfg.steps[i];
    if (!s.after) return { nextName: s.name, nextAt: cfg.occ - offset + s.atMs };
    if (cur === i - 1 && !video.loop && video.duration) return { nextName: s.name, nextAt: Date.now() + (video.duration - video.currentTime) * 1000 };
    return { nextName: s.name, nextAt: 0 };
  }
  return { nextName: '', nextAt: 0 };
}
let ticking = false, retryAt = 0, lastWaitSay = 0;
const failed = {}; // step index -> how many times it could not start
async function timelineTick() {
  if (!room || room.state !== ConnectionState.Connected || ticking || Date.now() < retryAt) return;
  ticking = true;
  try {
    const el = nowMs() - cfg.occ;
    if (cur < 0 && !manual && Date.now() - lastWaitSay > 20_000) { // so the log always says what the bot is waiting for
      const n = nextInfo(); if (n.nextName && wantedIndex(el) < 0) { lastWaitSay = Date.now(); say(`waiting: "${n.nextName}" starts ${n.nextAt ? `at ${clockOf(n.nextAt)} (in ${Math.max(0, Math.round((n.nextAt - Date.now()) / 1000))} s)` : 'right after the video above'}`); }
    }
    if (!manual) {
      const want = wantedIndex(el);
      for (let i = 0; i < want; i++) if (i !== cur && !done.has(i)) done.add(i); // steps before the wanted one that never played are over
      if (want >= 0 && want !== cur && !done.has(want)) {
        if (cur >= 0) await stopPlaying(true); // the next step takes over (from a repeating one, for example)
        // A video that was due while this bot was still opening (it takes a few seconds) plays from its beginning, not from the middle
        const late = cfg.steps[want].after ? 0 : el - cfg.steps[want].atMs;
        try { await playStep(want, late <= LATE_OK_MS ? 0 : late, false); }
        catch (e) {
          cur = -1; video.pause(); await unpublishVideo().catch(() => {});
          failed[want] = (failed[want] ?? 0) + 1; lastError = e.message;
          if (failed[want] < 3) { say(`${e.message}. Trying again in 5 seconds (${failed[want]}/3).`); retryAt = Date.now() + 5000; }
          else { done.add(want); say(`giving up on step ${want + 1}: ${e.message}`); }
        }
      } else if (want >= 0 && cur >= 0 && cur !== want) { await stopPlaying(true); }
    }
    checkVideosDone();
  } finally { ticking = false; }
}

// ---------------------------------------------------------------- recording
function pickMime(list) { return list.find((m) => window.MediaRecorder?.isTypeSupported(m)); }
let partNo = 0;
function makeUploader(kind, ext, part) {
  let chain = Promise.resolve();
  return {
    push(blob) {
      chain = chain.then(async () => {
        for (let t = 0; t < 4; t++) {
          try { const r = await fetch(q(`/api/bot/rec?kind=${kind}&ext=${ext}&part=${part}`), { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/octet-stream' } }); if (r.ok) return; } catch { /* retry */ }
          await sleep(500 * (t + 1));
        }
        lastError = 'a piece of the recording could not be saved';
      });
    },
    flush: () => chain,
  };
}
let wantRecord = false; // external recording: SanWe's Studio records the class window while this is true
async function startRecording(why) {
  if (recorder || !room) return;
  if (cfg.record.external) { // Studio records what the class window shows, with the sound of the computer: nothing to capture here
    recorder = { async stop() {} }; wantRecord = true;
    await room.localParticipant.setAttributes({ rec: '1' }).catch(() => {});
    say(`recording requested (${why}): SanWe\u2019s Studio records the class window`);
    return;
  }
  const part = Math.min(99, Number(cfg.restarts || 0) * 10 + partNo++);
  await ac.resume().catch(() => {});
  const mimeV = pickMime(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']);
  if (!mimeV) { lastError = 'this browser cannot record video'; return; }
  const extV = mimeV.startsWith('video/mp4') ? 'mp4' : 'webm';
  drawRec();
  const vStream = new MediaStream([recCanvas.captureStream(30).getVideoTracks()[0], recDest.stream.getAudioTracks()[0]]);
  const mrV = new MediaRecorder(vStream, { mimeType: mimeV, videoBitsPerSecond: 4_500_000, audioBitsPerSecond: 160_000 });
  const upV = makeUploader('video', extV, part);
  mrV.ondataavailable = (e) => { if (e.data?.size) upV.push(e.data); };
  mrV.start(3000);
  let mrA = null, upA = null;
  if (cfg.record.audioToo) {
    const mimeA = pickMime(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus']);
    if (mimeA) {
      const extA = mimeA.startsWith('audio/mp4') ? 'm4a' : 'webm';
      mrA = new MediaRecorder(new MediaStream([recDest.stream.getAudioTracks()[0].clone()]), { mimeType: mimeA, audioBitsPerSecond: 160_000 });
      upA = makeUploader('audio', extA, part);
      mrA.ondataavailable = (e) => { if (e.data?.size) upA.push(e.data); };
      mrA.start(3000);
    }
  }
  recorder = {
    async stop() {
      const stopped = (mr) => new Promise((ok) => { if (!mr || mr.state === 'inactive') return ok(); mr.onstop = ok; mr.stop(); });
      await Promise.all([stopped(mrV), stopped(mrA)]);
      await Promise.all([upV.flush(), upA?.flush()]);
    },
  };
  await room.localParticipant.setAttributes({ rec: '1' }).catch(() => {}); // everyone sees the red "recording" notice
  say(`recording started (${why})`);
}
async function stopRecording() {
  if (!recorder) return;
  const r = recorder; recorder = null; wantRecord = false;
  await room?.localParticipant?.setAttributes({ rec: '' }).catch(() => {});
  await r.stop();
  say('recording saved');
}
function autoRecordTick() {
  const mode = cfg.record.mode;
  if (recorder || mode === 'off' || mode === 'manual') return;
  if (mode === 'start') { startRecording('at the start').catch(() => {}); return; }
  if (!videosDoneAt) return;
  if (mode === 'videos') { startRecording('videos finished').catch(() => {}); return; }
  if (mode === 'speech') {
    if (teacherTalking()) startRecording('the teacher started speaking').catch(() => {});
    else if (Date.now() - videosDoneAt > 5 * 60_000) startRecording('5 minutes after the videos, nobody spoke yet').catch(() => {});
  }
}

// Speech has pauses, so "the teacher is speaking" means: in the last 6 seconds a host or co-host was heard in at least 3 of 24 samples.
function sampleTalk() {
  const on = room ? [...room.remoteParticipants.values()].some((p) => isMgr(p) && p.isSpeaking) : false;
  talk.push(on); if (talk.length > 24) talk.shift();
}
setInterval(sampleTalk, 250);
const teacherTalking = () => talk.filter(Boolean).length >= 3;

// ---------------------------------------------------------------- run
async function report(extra = {}) {
  const remote = room ? [...room.remoteParticipants.values()].filter((p) => roleOf(p) !== 'bot').length : 0;
  const body = { connected: room?.state === ConnectionState.Connected, step: cur, playing: cur >= 0, recording: !!recorder, speaking: teacherTalking(), wantRecord, remote, error: lastError, logs: outbox.splice(0), ...(cfg ? nextInfo() : {}), ...extra };
  lastError = '';
  const r = await j('/api/bot/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const c of r.cmds ?? []) {
    if (c.cmd === 'quit') leave('stopped from the board').catch(() => {});
    else if (c.cmd === 'play') { if (cur >= 0) await stopPlaying(false); done.delete(c.step); playStep(c.step, 0, true).catch((e) => { lastError = e.message; }); }
    else if (c.cmd === 'stopvideo') await stopPlaying(true);
    else if (c.cmd === 'rec') { if (c.on) await startRecording('started from the board'); else await stopRecording(); }
  }
}
async function leave(why) {
  if (leaving) return; leaving = true;
  say(`leaving: ${why}`);
  try { await stopPlaying(true); } catch { /* ignore */ }
  try { await stopRecording(); } catch { /* ignore */ }
  try { await room?.disconnect(); } catch { /* ignore */ }
  try { await report({ event: 'bye', connected: false, playing: false, recording: false }); } catch { /* ignore */ }
}

async function main() {
  if (!RUN || !KEY) { say('missing run key'); return; }
  cfg = await j('/api/bot/config');
  offset = cfg.serverNow - Date.now();
  pubCanvas.width = cfg.pub.w; pubCanvas.height = cfg.pub.h; // the class video is published at the size the schedule chose
  room = new Room({ adaptiveStream: false, dynacast: true });
  room
    .on(RoomEvent.TrackPublished, scheduleSubs).on(RoomEvent.ParticipantConnected, scheduleSubs)
    .on(RoomEvent.ParticipantMetadataChanged, scheduleSubs).on(RoomEvent.TrackUnpublished, scheduleSubs)
    .on(RoomEvent.TrackSubscribed, onSubscribed).on(RoomEvent.TrackUnsubscribed, onUnsubscribed)
    .on(RoomEvent.ActiveSpeakersChanged, (list) => {
      const now = Date.now();
      for (const p of list) if (!p.isLocal) speakers.set(p.identity, now);
      scheduleSubs();
    })
    .on(RoomEvent.Disconnected, (reason) => { if (!leaving) leave(`disconnected (${reason ?? 'room closed'})`).catch(() => {}); });
  await room.connect(cfg.url, cfg.token, { autoSubscribe: false });
  say(`joined room ${cfg.room} as "${room.localParticipant.name}"`);
  say(`plan: ${cfg.steps.length ? cfg.steps.map((s, i) => `${s.after ? (i ? 'then, right after' : '') : `at ${clockOf(cfg.occ - offset + s.atMs)}`} "${s.name}"${s.loop ? ' (repeating)' : ''}`.trim()).join(' ; ') : 'no videos'}; recording: ${cfg.record.mode}${cfg.record.external ? ' (SanWe\u2019s Studio records the class window)' : ''}`);
  startDrawing();
  updateSubs();
  setInterval(() => { if (!leaving) timelineTick().catch((e) => { lastError = e.message; }); }, 1000);
  setInterval(() => { if (!leaving) { autoRecordTick(); updateSubs(); } }, 1000);
  setInterval(() => { // quit when everyone has gone home
    if (leaving || !room) return;
    const n = [...room.remoteParticipants.values()].filter((p) => roleOf(p) !== 'bot').length;
    if (n > 0) { emptySince = 0; sawPeople = true; }
    else if (!emptySince) emptySince = Date.now();
    // everybody went home (or nobody ever came: give a late teacher 45 minutes before giving up)
    else if (Date.now() - emptySince > 3 * 60_000 && nowMs() - cfg.occ > 5 * 60_000 && (sawPeople || nowMs() - cfg.occ > 45 * 60_000)) leave('everyone left').catch(() => {});
  }, 5000);
  let lost = 0;
  const poll = async () => {
    try { await report(); lost = 0; } catch (e) { say(`status: ${e.message}`); if (++lost >= 20) { leave('the SanWe’s server is gone').catch(() => {}); return; } }
    if (!leaving) setTimeout(poll, 1000);
  };
  poll();
  window.__bot = { get state() { return { cur, recording: !!recorder, done: [...done], talking: teacherTalking(), videosDoneAt, remote: room.remoteParticipants.size }; } };
}
main().catch((e) => { say(`failed: ${e.message}`); j('/api/bot/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connected: false, error: `bot failed: ${e.message}` }) }).catch(() => {}); });
