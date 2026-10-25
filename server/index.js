import express from 'express';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import httpProxy from 'http-proxy';
import { jwtVerify } from 'jose';
import { createLimiter } from './limiter.js';
import { initAuth } from './auth.js';
import { initTasks } from './tasks.js';
import { initClassroom } from './classroom.js';
import { initBreakout, parseBo } from './breakout.js';
import { initGameHubAgent } from './gamehub-agent.js';

const {
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
  LIVEKIT_URL = 'ws://localhost:7880',
  PORT = 3000,
  TOKEN_TTL = '1h',            // LiveKit refreshes tokens of connected participants; this only bounds how long a leaked token can be used to join
  JOIN_PASSWORD = '',          // optional: password required for every room
  ROOM_PASSWORDS = '',         // optional: JSON {"room":"password"}; overrides JOIN_PASSWORD for that room
  TRUST_PROXY = 'loopback',    // Caddy/nginx on the same machine; set to "false" to ignore X-Forwarded-*
  TOKEN_RATE_MAX = '20',       // token requests per IP per minute
  MAX_PARTICIPANTS: MAX_PARTICIPANTS_ENV = '500', // people allowed in one room (the media server refuses more)
  PASSWORD_FAIL_MAX = '5',     // wrong passwords per IP per 10 minutes before lockout
  LIVEKIT_API_URL = 'http://127.0.0.1:7880', // where THIS server reaches LiveKit (not the browser URL)
  SIGNAL_PROXY = 'on',         // 'off' disables the /lk signalling relay used when the page is served over HTTPS (tunnel / Caddy)
  ROOM_LIST = 'on',            // 'off' hides the public list of live rooms on the join screen
} = process.env;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET (see .env)');
  process.exit(1);
}

let livekitUrl;
try { livekitUrl = new URL(LIVEKIT_URL); } catch { console.error(`LIVEKIT_URL is not a valid URL: ${LIVEKIT_URL}`); process.exit(1); }
if (!/^wss?:$/.test(livekitUrl.protocol)) { console.error('LIVEKIT_URL must start with ws:// or wss://'); process.exit(1); }

let roomPasswords = {};
if (ROOM_PASSWORDS) {
  try {
    roomPasswords = JSON.parse(ROOM_PASSWORDS);
    if (!roomPasswords || typeof roomPasswords !== 'object' || Array.isArray(roomPasswords)) throw new Error('not an object');
  } catch (e) { console.error(`ROOM_PASSWORDS must be a JSON object like {"room":"password"} (${e.message})`); process.exit(1); }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY === 'false' ? false : TRUST_PROXY);
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)' });
  next();
});

// HTTPS pages (Cloudflare tunnel, Caddy...) cannot open ws://<lan-ip>:7880, so signalling is relayed through this server
// at /lk. Only the client signalling endpoints (/rtc/...) are exposed - never LiveKit's admin API.
const lkProxy = httpProxy.createProxyServer({ target: LIVEKIT_API_URL, ws: true, changeOrigin: true });
lkProxy.on('error', (_err, _req, res) => { if (res?.writeHead) { res.writeHead(502).end(); } else res?.destroy?.(); });
const rtcOnly = (url) => /^\/rtc(\/|\?|$)/.test(url);
if (SIGNAL_PROXY !== 'off') {
  app.use('/lk', (req, res) => (rtcOnly(req.url) ? lkProxy.web(req, res) : res.status(404).end()));
}
app.use(express.json({ limit: '64kb' })); // schedule forms carry up to 100 co-host ids and six video steps

// Accounts live on this computer (data/users.json). Everything that joins, creates or schedules needs a signed-in account.
const dataDir = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
await fs.mkdir(dataDir, { recursive: true });
const auth = await initAuth({ app, dataDir });

const clean = (s, max) => String(s ?? '').trim().replace(/[^\w .\-]/g, '').slice(0, max);
// A room name as sent by the page. Only the server makes names like "123~b2" (breakout rooms), so "~b<n>" is kept
// when it ends a name; people cannot create a room with such a name (/api/rooms uses clean()).
const cleanRoom = (s) => { const m = /^(.*)~b(\d{1,2})$/.exec(String(s ?? '').trim()); return m ? `${clean(m[1], 64)}~b${m[2]}` : clean(s, 64); };
const cleanTitle = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);
const digest = (s) => createHash('sha256').update(String(s)).digest();
const samePassword = (a, b) => timingSafeEqual(digest(a), digest(b));
const isLoopback = (h) => h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
const passcodes = new Map(); // room -> passcode chosen by the host when creating it
const meetings = new Map(); // room -> { waiting, locked, tickets: Map(ticket -> { name, status, at }), createdAt }
const scheduled = new Map(); // meeting id -> scheduled meeting (persisted in data/meetings.json)
const passwordFor = (room) => parseBo(room) ? null : passcodes.get(room) ?? (scheduled.get(room)?.passcode || null) ?? ((Object.hasOwn(roomPasswords, room) ? String(roomPasswords[room]) : JOIN_PASSWORD) || null);

const MAX_PARTICIPANTS = Math.min(5000, Math.max(2, Number(MAX_PARTICIPANTS_ENV) || 500));
const tokenLimiter = createLimiter({ windowMs: 60_000, max: Number(TOKEN_RATE_MAX) });
const failLimiter = createLimiter({ windowMs: 10 * 60_000, max: Number(PASSWORD_FAIL_MAX) });

// The browser connects to LIVEKIT_URL directly, so it must be reachable from where the page was loaded.
function livekitUrlProblem(req) {
  const pageHost = req.hostname;
  const mediaHost = livekitUrl.hostname;
  if (isLoopback(mediaHost) && !isLoopback(pageHost)) {
    return `LIVEKIT_URL (${LIVEKIT_URL}) points at this machine's loopback, but you opened the app as "${pageHost}". Set LIVEKIT_URL to an address other devices can reach (e.g. ws://${pageHost}:7880, or wss://${pageHost}/lk behind Caddy).`;
  }
  if (req.protocol === 'https' && livekitUrl.protocol === 'ws:' && !isLoopback(mediaHost)) {
    return `The app is served over HTTPS but LIVEKIT_URL (${LIVEKIT_URL}) is plain ws://. Browsers block that; use wss:// (see deploy/Caddyfile).`;
  }
  return null;
}

// Roles follow ACCOUNTS, not browsers: the account that created a room is its host whenever it comes back (reload, another device),
// and so is an account the host handed the role to. Co-hosts are accounts too.
function ensureState(room) {
  let s = meetings.get(room);
  if (!s) { s = { waiting: false, locked: false, tickets: new Map(), cohosts: new Set(), createdAt: Date.now() }; meetings.set(room, s); }
  s.hostUsers ??= new Set(); s.cohostUsers ??= new Set(); s.identUser ??= new Map();
  return s;
}
// A scheduled meeting's live room (created when its owner starts it, or when others may join before the host)
async function startScheduledRoom(m, hostName, uid) {
  const meta = liveMeta(m, hostName);
  if (!(await findRoom(m.id))) await roomService.createRoom({ name: m.id, metadata: JSON.stringify(meta), emptyTimeout: 300, maxParticipants: MAX_PARTICIPANTS });
  if (m.passcode) passcodes.set(m.id, m.passcode); else passcodes.delete(m.id);
  const st = ensureState(m.id); st.waiting = m.waiting; applySchedRules(st, m);
  if (uid) st.hostUsers.add(uid);
  for (const c of m.cohosts ?? []) if (c !== uid) st.cohostUsers.add(c); // accounts picked as co-hosts when scheduling
  return meta;
}
const roomService = new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const ROOM_TYPES = new Set(['hangout', 'meeting', 'game']);
const hostSecrets = new Map(); // room name -> secret handed to whoever created the room (in memory: lost on restart)
const parseMeta = (m) => { try { const o = JSON.parse(m || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const findRoom = async (name) => (await roomService.listRooms([name])).find((r) => r.name === name);

// Shared password + lockout logic. Returns true if the caller may continue, otherwise has already sent the response.
function passwordOk(req, res, room) {
  const lockedFor = failLimiter.blocked(req.ip);
  if (lockedFor) { res.set('Retry-After', String(lockedFor)).status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(lockedFor / 60)} min.` }); return false; }
  const required = passwordFor(room);
  if (!required) return true;
  const given = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!given) { res.status(401).json({ error: 'This room needs a password.', passwordRequired: true }); return false; }
  if (!samePassword(given, required)) {
    failLimiter.hit(req.ip);
    res.status(401).json({ error: 'Wrong password.', passwordRequired: true });
    return false;
  }
  failLimiter.reset(req.ip);
  return true;
}

const rateOk = (req, res) => {
  const rate = tokenLimiter.hit(req.ip);
  if (!rate.ok) res.set('Retry-After', String(rate.retryAfterSec)).status(429).json({ error: `Too many requests. Try again in ${rate.retryAfterSec}s.` });
  return rate.ok;
};

// Host tools switches decide which kinds of track an ordinary participant may publish. Hosts and co-hosts are never limited.
const ALL_SOURCES = [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
// uid: an account the host gave the floor ("Allow to talk") may use mic and camera even when everybody else may not
const memberSources = (m, uid) => ALL_SOURCES.filter((s) => !(
  (s === TrackSource.MICROPHONE && m?.allowUnmute === false && !m?.talk?.has(uid))
  || (s === TrackSource.CAMERA && m?.allowVideo === false && !m?.talk?.has(uid))
  || ((s === TrackSource.SCREEN_SHARE || s === TrackSource.SCREEN_SHARE_AUDIO) && m?.allowShare === false)));
async function applyPermissions(room) {
  const m = meetings.get(room);
  for (const p of await roomService.listParticipants(room)) {
    if (parseMeta(p.metadata).role !== 'member') continue; // hosts, co-hosts and theater spectators keep their own rules
    await roomService.updateParticipant(room, p.identity, undefined, { canSubscribe: true, canPublish: true, canPublishData: true, canUpdateMetadata: true, canPublishSources: memberSources(m, m?.identUser?.get(p.identity)) });
  }
}
async function putRoomSettings(room, patch) { // stored on the live room so every client sees the same switches
  const live = await findRoom(room);
  await roomService.updateRoomMetadata(room, JSON.stringify({ ...parseMeta(live?.metadata), ...patch }));
}

app.post('/api/token', async (req, res) => {
  const user = auth.requireUser(req, res); if (!user) return;
  if (!rateOk(req, res)) return;
  const room = cleanRoom(req.body?.room);
  const name = clean(user.displayName, 32) || user.username; // your name in the meeting is your account's display name
  if (!room) return res.status(400).json({ error: 'room is required' });
  if (!passwordOk(req, res, room)) return;

  // Page served over HTTPS => browsers need wss://, so use this server's own /lk relay instead of LIVEKIT_URL.
  const relayed = SIGNAL_PROXY !== 'off' && req.protocol === 'https';
  const mediaUrl = relayed ? `wss://${req.host}/lk` : LIVEKIT_URL;
  if (!relayed) {
    const problem = livekitUrlProblem(req);
    if (problem) { console.error(problem); return res.status(500).json({ error: problem }); }
  }

  // Roles: whoever created the room holds its secret and is the host. In a game (theater) room everyone else is a
  // spectator who can talk and chat but cannot publish camera or screen.
  let meta = {}, liveRoom = null;
  try { liveRoom = await findRoom(room); meta = parseMeta(liveRoom?.metadata); } catch { /* media server hiccup: treat as a plain room */ }
  // A breakout room ("<main>~b<n>"): only people the host assigned (or let choose) may enter; the main meeting's hosts and co-hosts keep their roles
  let boInfo = null;
  if (parseBo(room)) {
    boInfo = breakout?.entry(room, user.id);
    if (!boInfo) return res.status(403).json({ error: 'This breakout room is not open for you.' });
    const bst = ensureState(room);
    for (const u of boInfo.st.hostUsers) bst.hostUsers.add(u);
    for (const u of boInfo.st.cohostUsers) bst.cohostUsers.add(u);
    for (const k of ['allowUnmute', 'allowVideo', 'allowShare', 'chatWho']) if (boInfo.st[k] !== undefined) bst[k] = boInfo.st[k];
    bst.talk = boInfo.st.talk;
  }
  const given = typeof req.body?.hostSecret === 'string' ? req.body.hostSecret : '';
  const secret = hostSecrets.get(room);
  const sched = scheduled.get(room);
  const pre = meetings.get(room);
  const ownsSched = !!sched && sched.ownerHash === auth.ownerHashFor(user.id);
  const isHost = (!!secret && !!given && samePassword(given, secret)) || !!pre?.hostUsers?.has(user.id) || ownsSched;
  const isCohostUser = !isHost && (!!pre?.cohostUsers?.has(user.id) || !!sched?.cohosts?.includes(user.id));
  if (ownsSched && !liveRoom) { // the owner opening their own scheduled meeting starts it
    try { meta = await startScheduledRoom(sched, name, user.id); liveRoom = { metadata: JSON.stringify(meta) }; }
    catch (e) { console.error(`start meeting failed: ${e.message}`); return res.status(502).json({ error: 'Media server unreachable.' }); }
  }
  if (/^\d{9,12}$/.test(room) && !liveRoom && !sched && !isHost) return res.status(404).json({ error: 'Invalid meeting ID. Check the number and try again.', invalidMeeting: true });

  // A scheduled meeting only exists once its host starts it, unless the host allowed joining before them.
  if (sched && !liveRoom && !isHost) {
    if (!sched.joinBeforeHost) return res.status(425).json({ error: 'Waiting for the host to start this meeting.', notStarted: true });
    try {
      meta = liveMeta(sched, sched.hostName);
      await roomService.createRoom({ name: room, metadata: JSON.stringify(meta), emptyTimeout: 300, maxParticipants: MAX_PARTICIPANTS });
      applySchedRules(ensureState(room), sched);
    } catch (e) { console.error(`createRoom for scheduled meeting failed: ${e.message}`); return res.status(502).json({ error: 'Media server unreachable.' }); }
  }
  const role = isHost ? 'host' : isCohostUser ? 'cohost' : meta.type === 'game' ? 'spectator' : 'member';

  // "Recording protection: SanWe's Viewer app only": people (not hosts or co-hosts) must come from the Viewer app, whose window Windows
  // hides from screen recorders. The Viewer adds this header; it is a strong deterrent, not a lock (see docs/ZOOM_CAPTURE_PROTECTION_REPORT.md).
  if ((meta.protect || sched?.protect) === 'app' && (role === 'member' || role === 'spectator') && req.get('x-sanwes-viewer') !== '1') {
    return res.status(403).json({ error: "The host turned on recording protection for this class. Open it in the SanWe's Viewer app (ask your host for it) instead of a web browser.", viewerRequired: true });
  }

  // Meeting controls set by the host: locked meeting, waiting room (guests get a ticket and wait to be admitted).
  const state = meetings.get(room);
  if (!isHost && !isCohostUser && state?.locked) return res.status(403).json({ error: 'The host has locked this meeting.' });
  if (!isHost && !isCohostUser && state?.waiting) {
    const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
    const t = state.tickets.get(ticket);
    if (!t || t.name !== name) {
      if ([...state.tickets.values()].filter((x) => x.status === 'pending').length >= 100) return res.status(429).json({ error: 'The waiting room is full.' });
      const id = randomBytes(12).toString('hex');
      state.tickets.set(id, { name, status: 'pending', at: Date.now() });
      return res.status(202).json({ waiting: true, ticket: id });
    }
    if (t.status === 'pending') return res.status(202).json({ waiting: true, ticket });
    if (t.status === 'denied') { state.tickets.delete(ticket); return res.status(403).json({ error: 'The host declined your request to join.' }); }
    t.status = 'active'; t.at = Date.now(); // admitted: the same ticket lets them rejoin after a network drop
  }

  const identity = `${name}-${Math.random().toString(36).slice(2, 8)}`;
  const st = ensureState(room);
  st.identUser.set(identity, user.id);
  if (isCohostUser) st.cohosts.add(identity);
  if (isHost) st.hostUsers.add(user.id);
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: TOKEN_TTL,
    metadata: JSON.stringify({ role }),
  });
  at.addGrant({
    roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true,
    ...(role === 'spectator' ? { canPublishSources: [TrackSource.MICROPHONE] } : {}),
    ...(role === 'member' ? { canPublishSources: memberSources(meetings.get(room), user.id) } : {}), // host tools: who may unmute, start video, share
  });
  res.set('Cache-Control', 'no-store').json({ token: await at.toJwt(), url: mediaUrl, role, ...(boInfo ? { breakout: { main: boInfo.main, n: boInfo.n } } : {}) });
});

// ---- room creation (title, type, cover art). Metadata lives on the LiveKit room, so it disappears when the room empties.
const COVER_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
await fs.mkdir(uploadsDir, { recursive: true });
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sniffImage = (b) => {
  if (b.length < 12) return null;
  if (b.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
};
const coverLimiter = createLimiter({ windowMs: 60 * 60_000, max: 20 });

app.post('/api/covers', express.raw({ type: Object.values(COVER_TYPES), limit: '1.5mb' }), async (req, res) => {
  if (!auth.requireUser(req, res)) return;
  if (!coverLimiter.hit(req.ip).ok) return res.status(429).json({ error: 'Too many uploads. Try again later.' });
  const ext = Buffer.isBuffer(req.body) ? sniffImage(req.body) : null; // trust the bytes, not the Content-Type header
  if (!ext) return res.status(400).json({ error: 'Cover must be a PNG, JPEG or WebP image up to 1.5 MB.' });
  const id = randomBytes(8).toString('hex');
  await fs.writeFile(path.join(uploadsDir, `${id}.${ext}`), req.body);
  res.json({ cover: `/covers/${id}.${ext}` });
});
app.use('/covers', express.static(uploadsDir, {
  index: false, maxAge: '7d',
  setHeaders: (res) => res.set({ 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' }),
}));

app.post('/api/rooms', async (req, res) => {
  const user = auth.requireUser(req, res); if (!user) return;
  if (!rateOk(req, res)) return;
  const room = clean(req.body?.room, 64);
  const name = clean(user.displayName, 32) || user.username;
  if (!room) return res.status(400).json({ error: 'a room name is required' });
  if (!passwordOk(req, res, room)) return;
  const type = ROOM_TYPES.has(req.body?.type) ? req.body.type : 'hangout';
  const cover = /^\/covers\/[a-f0-9]{16}\.(png|jpg|webp)$/.test(req.body?.cover ?? '') ? req.body.cover : '';
  const waiting = req.body?.waiting === true;
  const meta = { v: 1, type, title: cleanTitle(req.body?.title, 48) || room, game: type === 'game' ? cleanTitle(req.body?.game, 48) : '', cover, host: name, waiting };
  try {
    if (await findRoom(room)) return res.status(409).json({ error: `A room called "${room}" is already live. Pick another name or join it.` });
    await roomService.createRoom({ name: room, metadata: JSON.stringify(meta), emptyTimeout: 120, maxParticipants: MAX_PARTICIPANTS });
  } catch (e) {
    console.error(`createRoom failed: ${e.message}`);
    return res.status(502).json({ error: 'Media server unreachable.' });
  }
  const hostSecret = randomBytes(16).toString('hex');
  hostSecrets.set(room, hostSecret);
  const passcode = clean(req.body?.passcode, 32);
  if (passcode) passcodes.set(room, passcode); else passcodes.delete(room);
  meetings.delete(room); const st = ensureState(room); st.waiting = waiting; st.hostUsers.add(user.id);
  res.json({ room, hostSecret, meta });
});

// ---- scheduled meetings (Zoom-style: topic, time, repeat, invitees, meeting id, passcode, options). Persisted in data/meetings.json.
// There are no accounts: a browser makes a random owner key, and only its hash is stored. Whoever holds the key owns the meetings.
const meetingsFile = path.join(dataDir, 'meetings.json');
try { for (const m of JSON.parse(await fs.readFile(meetingsFile, 'utf8')).meetings ?? []) scheduled.set(m.id, m); } catch { /* first run */ }
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { const tmp = `${meetingsFile}.tmp`; await fs.writeFile(tmp, JSON.stringify({ meetings: [...scheduled.values()] }, null, 1)); await fs.rename(tmp, meetingsFile); }
    catch (e) { console.error(`saving meetings failed: ${e.message}`); }
  }, 200);
}
// forget one-off meetings that ended more than 30 days ago
for (const [id, m] of scheduled) if (!m.personal && m.repeat === 'none' && Date.parse(m.start) + (m.durationMin + 30 * 1440) * 60_000 < Date.now()) scheduled.delete(id);

const tasks = await initTasks({ app, auth, scheduled, persist, roomService, startScheduledRoom, findRoom, dataDir, port: PORT, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET, livekitApiUrl: LIVEKIT_API_URL, cleanTitle });
const meetLimiter = createLimiter({ windowMs: 60_000, max: 120 });
const ownerHash = (key) => createHash('sha256').update(`sanwes-owner:${key}`).digest('hex');
const validKey = (k) => typeof k === 'string' && /^[a-f0-9]{32,64}$/.test(k);
const REPEATS = new Set(['none', 'daily', 'weekly', 'monthly']);
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const newMeetingId = () => { for (;;) { const id = String(randomInt(1_000_000_000, 10_000_000_000)); if (!scheduled.has(id) && !hostSecrets.has(id)) return id; } };
const newPasscode = () => randomBytes(4).toString('hex').slice(0, 6);

const ownerView = ({ ownerHash: _o, ...m }) => m;
const liveMeta = (m, host) => ({ v: 1, type: 'meeting', title: m.topic, game: '', cover: '', host: host || m.hostName || '', waiting: m.waiting, muteOnEntry: m.muteOnEntry, hostVideo: m.hostVideo, participantVideo: m.participantVideo, protect: m.protect || 'off', allowUnmute: m.allowUnmute !== false, allowVideo: m.allowVideo !== false });
// The rules the schedule chose for the room: who may unmute / start video (hosts and co-hosts are never limited)
function applySchedRules(st, m) { st.muteOnEntry = m.muteOnEntry === true; st.allowUnmute = m.allowUnmute !== false; st.allowVideo = m.allowVideo !== false; }

// Gate for every owner call: rate limit + a valid key. Returns the key's hash, or null after answering.
function ownerOk(req, res) {
  const user = auth.requireUser(req, res); if (!user) return null;
  if (!meetLimiter.hit(req.ip).ok) { res.status(429).json({ error: 'Too many requests.' }); return null; }
  req.user = user;
  return auth.ownerHashFor(user.id);
}
const mine = (m, h) => m && m.ownerHash === h;

app.post('/api/meetings/personal', (req, res) => { // each owner has one permanent Personal Meeting ID
  const h = ownerOk(req, res); if (!h) return;
  let m = [...scheduled.values()].find((x) => x.personal && x.ownerHash === h);
  if (!m) {
    const hostName = clean(req.user.displayName, 32) || 'Host';
    m = { id: newMeetingId(), ownerHash: h, personal: true, topic: `${hostName}'s Personal Meeting Room`, start: null, durationMin: 0, tz: 'UTC', repeat: 'none', invitees: [], agenda: '', passcode: newPasscode(), waiting: true, joinBeforeHost: false, hostVideo: false, participantVideo: false, muteOnEntry: false, hostName, createdAt: Date.now() };
    scheduled.set(m.id, m); persist();
  }
  res.json({ meeting: ownerView(m) });
});

app.post('/api/meetings/list', (req, res) => {
  const h = ownerOk(req, res); if (!h) return;
  res.json({ meetings: [...scheduled.values()].filter((m) => m.ownerHash === h).map(ownerView) });
});

const REMINDER_MINUTES = new Set([0, 1, 2, 3, 5, 10, 15, 30, 60]);
app.post('/api/meetings/save', (req, res) => {
  const h = ownerOk(req, res); if (!h) return;
  const b = req.body ?? {};
  const topic = String(b.topic ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  const start = new Date(b.start);
  const durationMin = Math.round(Number(b.durationMin));
  const tz = validTz(b.tz) ? b.tz : 'UTC';
  const repeat = REPEATS.has(b.repeat) ? b.repeat : 'none';
  if (!topic) return res.status(400).json({ error: 'Give the meeting a topic.' });
  if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Pick a valid start time.' });
  if (!(durationMin >= 5 && durationMin <= 1440)) return res.status(400).json({ error: 'A meeting lasts between 5 minutes and 24 hours.' });
  if (start.getTime() > Date.now() + 2 * 365 * 86400_000) return res.status(400).json({ error: 'Pick a date within the next two years.' });
  // Reminders: minutes before the start (0 = at the start), up to 4. null means "use the viewer's own defaults".
  const reminders = b.reminders === null || b.reminders === undefined ? null
    : [...new Set((Array.isArray(b.reminders) ? b.reminders : []).map(Number).filter((n) => REMINDER_MINUTES.has(n)))].sort((x, y) => y - x).slice(0, 4);
  const invitees = [...new Set((Array.isArray(b.invitees) ? b.invitees : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (invitees.length > 50 || invitees.some((e) => !EMAIL.test(e) || e.length > 120)) return res.status(400).json({ error: 'Check the invitee email addresses (up to 50).' });

  const extra = tasks.sanitize(b, req.user);
  if (extra.error) return res.status(400).json({ error: extra.error });
  let m = b.id ? scheduled.get(String(b.id)) : null;
  if (b.id && !mine(m, h)) return res.status(404).json({ error: 'Meeting not found.' });
  if (!m && [...scheduled.values()].filter((x) => x.ownerHash === h).length >= 200) return res.status(400).json({ error: 'Too many meetings. Delete some first.' });
  let id = m?.id;
  if (!m) { // "Personal Meeting ID" schedules the owner's permanent room; anything else gets a fresh id
    if (b.idMode === 'personal') {
      m = [...scheduled.values()].find((x) => x.personal && x.ownerHash === h);
      if (!m) return res.status(400).json({ error: 'Open the Meetings page once to create your Personal Meeting ID.' });
      id = m.id;
    } else id = newMeetingId();
  }
  const personal = m?.personal === true;
  const passcode = personal ? m.passcode : b.passcode === true ? (m?.passcode || newPasscode()) : typeof b.passcode === 'string' ? clean(b.passcode, 32) : '';
  m = { ...(m ?? {}), id, ownerHash: h, personal, topic, start: start.toISOString(), durationMin, tz, repeat, invitees,
    reminders, agenda: String(b.agenda ?? '').slice(0, 2000), passcode, waiting: b.waiting === true, joinBeforeHost: b.joinBeforeHost === true,
    hostVideo: b.hostVideo === true, participantVideo: b.participantVideo === true, muteOnEntry: b.muteOnEntry === true,
    allowUnmute: b.allowUnmute !== false, allowVideo: b.allowVideo !== false,
    hostName: clean(req.user.displayName, 32) || m?.hostName || 'Host', createdAt: m?.createdAt ?? Date.now(),
    ownerUid: req.user.id, cohosts: extra.cohosts, auto: extra.auto, protect: extra.protect };
  if (!personal && !extra.auto) { delete m.autoLast; delete m.autoEnded; }
  scheduled.set(id, m); persist();
  res.json({ meeting: ownerView(m) });
});

app.post('/api/meetings/delete', (req, res) => {
  const h = ownerOk(req, res); if (!h) return;
  const m = scheduled.get(String(req.body?.id ?? ''));
  if (!mine(m, h)) return res.status(404).json({ error: 'Meeting not found.' });
  if (m.personal) return res.status(400).json({ error: 'The Personal Meeting Room cannot be deleted.' });
  scheduled.delete(m.id); persist();
  res.json({ ok: true });
});

// What a guest may know about a meeting (no secrets): used by the join dialog and while waiting for the host.
app.get('/api/meetings/:id/public', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!auth.requireUser(req, res)) return;
  if (!meetLimiter.hit(req.ip).ok) return res.status(429).json({ error: 'Too many requests.' });
  const m = scheduled.get(String(req.params.id).replace(/\D/g, ''));
  if (!m) return res.status(404).json({ error: 'Unknown meeting.' });
  let live = false;
  try { live = !!(await findRoom(m.id)); } catch { /* media server hiccup */ }
  res.json({ id: m.id, topic: m.topic, start: m.start, durationMin: m.durationMin, tz: m.tz, repeat: m.repeat, passcodeRequired: !!m.passcode, personal: m.personal, host: m.hostName, live, joinBeforeHost: m.joinBeforeHost, autoClass: !!m.auto?.enabled });
});

// The owner starts (or re-enters) their meeting: creates the live room and hands back the host secret.
app.post('/api/meetings/:id/start', async (req, res) => {
  const h = ownerOk(req, res); if (!h) return;
  const m = scheduled.get(String(req.params.id));
  if (!mine(m, h)) return res.status(404).json({ error: 'Meeting not found.' });
  const hostName = clean(req.user.displayName, 32) || m.hostName || 'Host';
  let meta;
  try { meta = await startScheduledRoom(m, hostName, req.user.id); }
  catch (e) { console.error(`start meeting failed: ${e.message}`); return res.status(502).json({ error: 'Media server unreachable.' }); }
  let secret = hostSecrets.get(m.id);
  if (!secret) { secret = randomBytes(16).toString('hex'); hostSecrets.set(m.id, secret); } // ownership is proven by the owner key, so this also restores host rights after a server restart
  res.json({ room: m.id, hostSecret: secret, meta, passcode: m.passcode });
});

// ---- waiting room + host / co-host controls.
// The host proves identity with the secret returned when the room was created. A co-host proves identity with their own
// LiveKit access token (signed by us): it names the room and their identity, and the host put that identity on the co-host list.
const hostLimiter = createLimiter({ windowMs: 60_000, max: 240 });
let breakout; // set just below
const classroom = await initClassroom({ app, auth, roomService, meetings, hostSecrets, samePassword, jwtKey: new TextEncoder().encode(LIVEKIT_API_SECRET), apiKey: LIVEKIT_API_KEY, clean: cleanRoom, applyPermissions, putRoomSettings, dataDir });
breakout = initBreakout({ app, roomService, meetings, who: classroom.who, ensureState, findRoom, parseMeta, MAX_ROOM: MAX_PARTICIPANTS });
const statusLimiter = createLimiter({ windowMs: 60_000, max: 90 });
const jwtKey = new TextEncoder().encode(LIVEKIT_API_SECRET);

async function manager(req, res, { hostOnly = false } = {}) {
  if (!hostLimiter.hit(req.ip).ok) { res.status(429).json({ error: 'Too many requests.' }); return null; }
  const room = cleanRoom(req.body?.room);
  const given = typeof req.body?.hostSecret === 'string' ? req.body.hostSecret : '';
  const secret = hostSecrets.get(room);
  // the caller's own join token (signed by us) names their identity, whichever way they prove their right to act
  let identity = null;
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (room && token) {
    try {
      // clockTolerance: the join token is short-lived but the right to act lasts as long as the meeting
      const { payload } = await jwtVerify(token, jwtKey, { clockTolerance: '1d' });
      if (payload.iss === LIVEKIT_API_KEY && payload.video?.room === room) identity = payload.sub;
    } catch { /* not a valid token */ }
  }
  const m = meetings.get(room);
  const uid = identity ? m?.identUser?.get(identity) : null; // the account behind this join token
  if (room && secret && given && samePassword(given, secret)) return { room, actor: 'host', identity };
  if (uid && m?.hostUsers?.has(uid)) return { room, actor: 'host', identity, uid }; // the creator, or an account handed the host role
  if (identity && m?.hosts?.has(identity)) return { room, actor: 'host', identity, uid }; // handed the host role (older path)
  if (!hostOnly && identity && (m?.cohosts.has(identity) || (uid && m?.cohostUsers?.has(uid)))) return { room, actor: 'cohost', identity, uid };
  res.status(403).json({ error: hostOnly ? 'Only the host can do that.' : 'Only the host or a co-host can do that.' });
  return null;
}

// Game Hub: lets viewers the streamer approved play on the streamer's own computer (keyboard, mouse, gamepad). Only reachable from this computer.
initGameHubAgent({
  app, auth, manager, dataDir, rootDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  gameRoom: async (room) => parseMeta((await findRoom(room))?.metadata).type === 'game',
  thisComputerOnly: (req) => !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress),
});

// Guests poll this while waiting to be admitted.
app.get('/api/join-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!statusLimiter.hit(req.ip).ok) return res.status(429).json({ error: 'Too many requests.' });
  const t = meetings.get(cleanRoom(req.query.room))?.tickets.get(String(req.query.ticket ?? ''));
  res.json({ status: t?.status ?? 'unknown' });
});

app.post('/api/host/waiting', async (req, res) => {
  const m0 = await manager(req, res); if (!m0) return;
  const m = meetings.get(m0.room), now = Date.now(), waiting = [];
  for (const [ticket, t] of m?.tickets ?? []) {
    if (now - t.at > (t.status === 'active' ? 6 * 3600_000 : 15 * 60_000)) { m.tickets.delete(ticket); continue; }
    if (t.status === 'pending') waiting.push({ ticket, name: t.name });
  }
  res.json({ waiting, locked: !!m?.locked });
});

app.post('/api/host/admit', async (req, res) => {
  const m0 = await manager(req, res); if (!m0) return;
  const t = meetings.get(m0.room)?.tickets.get(String(req.body?.ticket ?? ''));
  if (!t) return res.status(404).json({ error: 'That request is gone.' });
  t.status = req.body?.allow === false ? 'denied' : 'admitted';
  res.json({ ok: true });
});

// Every Host tools switch: boolean, or one of a fixed list of values. Anything else is refused.
const SETTINGS = {
  waiting: 'bool', muteOnEntry: 'bool', allowShare: 'bool', allowUnmute: 'bool', allowVideo: 'bool', allowRename: 'bool', allowRecord: 'bool', hideAvatars: 'bool',
  qaOn: 'bool', qaAnon: 'bool', allowFiles: 'bool', playOpen: 'bool', protect: ['off', 'watermark', 'app'], chatWho: ['all', 'host', 'none'], shareMax: ['multi', 'one'], shareWhen: ['all', 'host'], wbWho: ['all', 'host'],
};
const PERMISSION_KEYS = new Set(['allowShare', 'allowUnmute', 'allowVideo']); // these change what the media server lets people publish
const HOST_ONLY_ACTIONS = new Set(['cohost', 'uncohost', 'makehost', 'end']);
app.post('/api/host/action', async (req, res) => {
  const action = String(req.body?.action ?? '');
  const mgr = await manager(req, res, { hostOnly: HOST_ONLY_ACTIONS.has(action) }); if (!mgr) return;
  const { room, actor } = mgr;
  const identity = String(req.body?.identity ?? '').slice(0, 128);
  const roleOfP = (p) => parseMeta(p.metadata).role;
  const protectedFor = (p) => roleOfP(p) === 'host' || (actor === 'cohost' && roleOfP(p) === 'cohost');
  try {
    if (action === 'lock' || action === 'unlock') {
      const m = meetings.get(room); if (m) m.locked = action === 'lock';
      return res.json({ ok: true, locked: action === 'lock' });
    }
    if (action === 'setting') { // Host tools switches. Stored on the room (everyone sees them) and applied to the live meeting.
      const key = String(req.body?.key ?? ''), spec = SETTINGS[key];
      if (!spec) return res.status(400).json({ error: 'Unknown setting.' });
      const value = spec === 'bool' ? req.body?.value === true : req.body?.value;
      if (spec !== 'bool' && !spec.includes(value)) return res.status(400).json({ error: 'That value is not allowed.' });
      const m = meetings.get(room); if (!m) return res.status(404).json({ error: 'This meeting has no host controls.' });
      m[key] = value;
      await putRoomSettings(room, { [key]: value });
      if (PERMISSION_KEYS.has(key)) await applyPermissions(room);
      return res.json({ ok: true, key, value });
    }
    if (action === 'suspend' || action === 'resume') { // "Suspend participant activities": everything stops, the meeting is locked
      const m = meetings.get(room); if (!m) return res.status(404).json({ error: 'This meeting has no host controls.' });
      const on = action === 'suspend';
      const patch = on
        ? { allowShare: false, allowUnmute: false, allowVideo: false, allowRecord: false, chatWho: 'none', suspended: true }
        : { allowShare: true, allowUnmute: true, allowVideo: true, allowRecord: false, chatWho: 'all', suspended: false };
      Object.assign(m, patch, { locked: on });
      await putRoomSettings(room, patch);
      if (on) {
        for (const p of await roomService.listParticipants(room)) {
          if (['host', 'cohost'].includes(roleOfP(p))) continue;
          for (const tr of p.tracks) if (!tr.muted) await roomService.mutePublishedTrack(room, p.identity, tr.sid, true);
        }
      }
      await applyPermissions(room);
      return res.json({ ok: true, locked: on });
    }
    if (action === 'end') { // end the meeting for everyone
      await roomService.deleteRoom(room);
      meetings.delete(room); hostSecrets.delete(room); passcodes.delete(room); classroom.forget(room);
      return res.json({ ok: true });
    }
    const muteMic = async (p) => { for (const t of p.tracks) if (t.source === TrackSource.MICROPHONE && !t.muted) await roomService.mutePublishedTrack(room, p.identity, t.sid, true); };
    if (action === 'muteAll') {
      for (const p of await roomService.listParticipants(room)) if (!['host', 'cohost'].includes(roleOfP(p))) await muteMic(p);
      return res.json({ ok: true });
    }
    const target = identity && (await roomService.listParticipants(room)).find((p) => p.identity === identity);
    if (!target) return res.status(404).json({ error: 'That person is no longer in the meeting.' });
    if (roleOfP(target) === 'host') return res.status(400).json({ error: 'The host cannot be targeted.' });
    if (action === 'cohost' || action === 'uncohost') {
      const m = meetings.get(room);
      const tuid = m?.identUser?.get(identity);
      if (action === 'cohost') { m?.cohosts.add(identity); if (tuid) m?.cohostUsers?.add(tuid); } else { m?.cohosts.delete(identity); if (tuid) m?.cohostUsers?.delete(tuid); }
      const base = parseMeta((await findRoom(room))?.metadata).type === 'game' ? 'spectator' : 'member';
      await roomService.updateParticipant(room, identity, JSON.stringify({ role: action === 'cohost' ? 'cohost' : base }));
      return res.json({ ok: true });
    }
    if (action === 'makehost') { // hand the host role over: the target becomes host, the person acting becomes a co-host
      const m = meetings.get(room); if (!m) return res.status(404).json({ error: 'This meeting has no host controls.' });
      (m.hosts ??= new Set()).add(identity); m.cohosts.delete(identity);
      const tuid = m.identUser?.get(identity);
      if (tuid) { (m.hostUsers ??= new Set()).add(tuid); m.cohostUsers?.delete(tuid); }
      if (mgr.identity && mgr.identity !== identity) {
        m.cohosts.add(mgr.identity); m.hosts.delete(mgr.identity);
        if (mgr.uid) { m.hostUsers?.delete(mgr.uid); (m.cohostUsers ??= new Set()).add(mgr.uid); }
        await roomService.updateParticipant(room, mgr.identity, JSON.stringify({ role: 'cohost' }));
      }
      hostSecrets.set(room, randomBytes(16).toString('hex')); // the old secret stops working
      await roomService.updateParticipant(room, identity, JSON.stringify({ role: 'host' }));
      return res.json({ ok: true });
    }
    if (protectedFor(target)) return res.status(400).json({ error: 'A co-host cannot do that to another co-host.' });
    if (action === 'mute') { await muteMic(target); return res.json({ ok: true }); }
    if (action === 'remove') {
      const who = identity.replace(/-[a-z0-9]{1,8}$/, '');
      for (const t of meetings.get(room)?.tickets.values() ?? []) if (t.name === who) t.status = 'denied';
      meetings.get(room)?.cohosts.delete(identity);
      await roomService.removeParticipant(room, identity);
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    console.error(`host action ${action} failed: ${e.message}`);
    res.status(502).json({ error: 'Media server unreachable.' });
  }
});

// Forget host secrets / passcodes / tickets of rooms that ended (a room lives 2 min after its last person leaves).
setInterval(async () => {
  try {
    const live = new Set((await roomService.listRooms()).map((r) => r.name));
    for (const [room, m] of meetings) {
      if (live.has(room) || Date.now() - m.createdAt < 5 * 60_000) continue;
      meetings.delete(room); hostSecrets.delete(room); passcodes.delete(room); classroom.forget(room);
    }
  } catch { /* media server down: try again next minute */ }
}, 60_000).unref();

// Live rooms for the join screen (demo convenience; set ROOM_LIST=off to disable). Cached so many viewers polling don't hammer LiveKit.
const roomsLimiter = createLimiter({ windowMs: 60_000, max: 120 });
let roomsCache = { at: 0, data: [] };
// Public: lets the launcher scripts check that the app can reach the media server (no account needed, no details leaked)
app.get('/api/health', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { await roomService.listRooms(); res.json({ ok: true, media: true, accounts: auth.count() }); }
  catch { res.status(503).json({ ok: false, media: false, accounts: auth.count() }); }
});

app.get('/api/rooms', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!auth.requireUser(req, res)) return;
  if (ROOM_LIST === 'off') return res.json({ rooms: [], enabled: false });
  if (!roomsLimiter.hit(req.ip).ok) return res.status(429).json({ error: 'Too many requests.' });
  if (Date.now() - roomsCache.at > 2000) {
    try {
      const live = await roomService.listRooms();
      roomsCache = {
        at: Date.now(),
        data: live.filter((r) => r.numParticipants > 0)
          .map((r) => {
            const m = parseMeta(r.metadata);
            return { name: r.name, participants: r.numParticipants, locked: !!passwordFor(r.name), type: ROOM_TYPES.has(m.type) ? m.type : 'hangout', title: m.title || r.name, game: m.game || '', cover: m.cover || '', host: m.host || '', play: m.playOpen === true };
          })
          .sort((a, b) => b.participants - a.participants || a.name.localeCompare(b.name)),
      };
    } catch (e) {
      console.error(`listRooms failed: ${e.message}`);
      return res.status(502).json({ error: 'Media server unreachable.' });
    }
  }
  res.json({ rooms: roomsCache.data, enabled: true });
});

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');
app.use(express.static(dist));

const server = app.listen(PORT, () => {
  console.log(`SanWe's running at http://localhost:${PORT}  (media: ${LIVEKIT_URL})`);
  const protectedRooms = Object.keys(roomPasswords).length;
  console.log(JOIN_PASSWORD || protectedRooms
    ? `Passwords: ${JOIN_PASSWORD ? 'all rooms' : ''}${JOIN_PASSWORD && protectedRooms ? ' + ' : ''}${protectedRooms ? `${protectedRooms} room override(s)` : ''}`
    : 'Passwords: none (anyone who can reach this server can join any room)');
});

server.on('upgrade', (req, socket, head) => {
  if (SIGNAL_PROXY !== 'off' && req.url.startsWith('/lk/') && rtcOnly(req.url.slice(3))) {
    req.url = req.url.slice(3);
    lkProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});
