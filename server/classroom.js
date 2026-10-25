// Classroom tools for a live room, kept on the server so they survive a page reload and cannot be forged by a browser:
//   - Polls and quizzes (host creates, launches, ends and shares results; people vote once)
//   - Q&A (people ask, upvote, optionally anonymous; hosts answer in text, answer live, dismiss)
//   - Files in chat (upload to this computer, download by people who were in the meeting)
//   - Host actions on one person: spotlight, ask to unmute / start video, allow to talk, lower hand
// Who is calling is proven by the caller's own LiveKit join token (signed by us) and checked against who is in the room now.
// State lives with the room (like the waiting room) and goes when the room ends.
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DataPacket_Kind } from 'livekit-server-sdk';
import { jwtVerify } from 'jose';
import { createLimiter } from './limiter.js';
import { parseBo } from './breakout.js';

const CLASS_TOPIC = 'sanwes.class';
const FILE_MAX = 25 * 1024 * 1024;
const BLOCKED_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|jar|lnk|dll|hta|html?|svg|xhtml|php|sh|reg|apk)$/i;
const text = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, ' ').trim().slice(0, max);
const enc = new TextEncoder();

export async function initClassroom(ctx) {
  const { app, auth, roomService, meetings, hostSecrets, samePassword, jwtKey, apiKey, clean, ensureState, applyPermissions, dataDir } = ctx;
  const filesDir = path.join(dataDir, 'chatfiles');
  await fs.rm(filesDir, { recursive: true, force: true }); // rooms do not survive a restart, neither do their files
  await fs.mkdir(filesDir, { recursive: true });
  const limit = {
    vote: createLimiter({ windowMs: 60_000, max: 30 }), ask: createLimiter({ windowMs: 60_000, max: 6 }), list: createLimiter({ windowMs: 10_000, max: 12 }),
    file: createLimiter({ windowMs: 60_000, max: 8 }), act: createLimiter({ windowMs: 60_000, max: 240 }),
  };

  // ------------------------------------------------------------ who is calling
  const present = new Map(); // room -> { at, ids: Set(identity) }
  async function isPresent(room, identity) {
    let p = present.get(room);
    if (!p || Date.now() - p.at > 4000) {
      try { p = { at: Date.now(), ids: new Set((await roomService.listParticipants(room)).map((x) => x.identity)) }; present.set(room, p); }
      catch { return !!p?.ids.has(identity); }
    }
    return p.ids.has(identity);
  }
  /** The caller, or null after answering. `mgr: true` requires host or co-host. */
  async function who(req, res, { mgr = false, key = 'act', allowBo = false } = {}) {
    const room = clean(req.body?.room ?? req.query?.room, 64);
    const token = String(req.body?.token ?? req.get('x-sanwes-token') ?? '');
    const deny = (code, error) => { res.status(code).json({ error }); return null; };
    if (!room || !token) return deny(400, 'Join the meeting first.');
    let payload;
    try { ({ payload } = await jwtVerify(token, jwtKey, { clockTolerance: '1d' })); } catch { return deny(401, 'Your meeting session is not valid. Rejoin the meeting.'); }
    if (payload.iss !== apiKey) return deny(401, 'Your meeting session is not valid. Rejoin the meeting.');
    // a token for one of this meeting's breakout rooms also speaks for the main meeting, where the call allows it
    const claim = payload.video?.room, boPart = claim !== room && allowBo ? parseBo(claim) : null;
    if (claim !== room && !(boPart && boPart.main === room)) return deny(401, 'Your meeting session is not valid. Rejoin the meeting.');
    const st = meetings.get(room);
    if (!st) return deny(404, 'This meeting has ended.');
    const identity = payload.sub, uid = (boPart ? meetings.get(claim) : st)?.identUser.get(identity);
    if (!(await isPresent(boPart ? claim : room, identity))) return deny(403, 'You are not in this meeting any more.');
    const given = typeof req.body?.hostSecret === 'string' ? req.body.hostSecret : '', secret = hostSecrets.get(room);
    const isHost = (!!secret && !!given && samePassword(given, secret)) || (!!uid && st.hostUsers.has(uid)) || st.hosts?.has(identity) === true;
    const isCohost = !isHost && (st.cohosts.has(identity) || (!!uid && st.cohostUsers.has(uid)));
    if (mgr && !isHost && !isCohost) return deny(403, 'Only the host or a co-host can do that.');
    if (!limit[key].hit(uid || identity).ok) return deny(429, 'Too many requests. Slow down a little.');
    return { room, st, identity, uid: uid || identity, name: text(payload.name, 40) || identity, isHost, isCohost, isMgr: isHost || isCohost, inBo: boPart ? boPart.n : 0 };
  }
  const classState = (st) => (st.cls ??= { polls: [], qa: [], pollV: 1, qaV: 1, files: new Map(), talk: new Set(), spotlight: [] });

  // ------------------------------------------------------------ "something changed" pings (people then fetch what they need)
  const pings = new Map();
  function ping(room, kind) {
    const k = `${room}|${kind}`;
    if (pings.has(k)) return;
    pings.set(k, setTimeout(async () => {
      pings.delete(k);
      const st = meetings.get(room); if (!st) return;
      const v = kind === 'poll' ? classState(st).pollV : classState(st).qaV;
      try { await roomService.sendData(room, enc.encode(JSON.stringify({ k: kind, v })), DataPacket_Kind.RELIABLE, { topic: CLASS_TOPIC }); } catch { /* room gone */ }
    }, 700));
  }
  const post = (path_, opts, fn) => app.post(`/api/class/${path_}`, async (req, res) => {
    const c = await who(req, res, opts); if (!c) return;
    try { await fn(c, req, res); } catch (e) { console.error(`class ${path_} failed: ${e.message}`); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again.' }); }
  });

  // ============================================================ polls and quizzes
  const MAX_POLLS = 25;
  const tally = (p) => {
    const counts = p.options.map(() => 0);
    for (const v of p.votes.values()) for (const i of v.choices) counts[i]++;
    return { counts, total: p.votes.size };
  };
  const pollMgrView = (p) => ({
    id: p.id, q: p.q, options: p.options, multi: p.multi, anonymous: p.anonymous, correct: p.correct, status: p.status, shared: p.shared, ...tally(p),
    voters: p.anonymous ? undefined : [...p.votes.values()].map((v) => ({ name: v.name, choices: v.choices })),
  });
  const pollMemberView = (p, uid) => {
    const mine = p.votes.get(uid)?.choices ?? null;
    const base = { id: p.id, q: p.q, options: p.options, multi: p.multi, anonymous: p.anonymous, status: p.status, mine, shared: p.shared };
    return p.status === 'ended' && p.shared ? { ...base, ...tally(p), correct: p.correct } : base;
  };

  post('poll/create', { mgr: true }, (c, req, res) => {
    const cs = classState(c.st), b = req.body ?? {};
    if (cs.polls.length >= MAX_POLLS) return res.status(400).json({ error: 'Too many polls in this meeting. Delete some first.' });
    const q = text(b.q, 200);
    const options = (Array.isArray(b.options) ? b.options : []).map((o) => text(o, 100)).filter(Boolean).slice(0, 10);
    if (!q) return res.status(400).json({ error: 'Type the question.' });
    if (options.length < 2) return res.status(400).json({ error: 'A poll needs at least two answers.' });
    const correct = [...new Set((Array.isArray(b.correct) ? b.correct : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < options.length))];
    const p = { id: randomBytes(5).toString('hex'), q, options, multi: b.multi === true, anonymous: b.anonymous === true, correct, status: 'draft', shared: false, votes: new Map(), createdAt: Date.now() };
    cs.polls.push(p); cs.pollV++;
    res.json({ poll: pollMgrView(p) });
  });
  const pollAct = (name, fn) => post(`poll/${name}`, { mgr: true }, (c, req, res) => {
    const cs = classState(c.st), p = cs.polls.find((x) => x.id === String(req.body?.id ?? ''));
    if (!p) return res.status(404).json({ error: 'That poll is gone.' });
    const out = fn(p, cs, res); if (out === false) return;
    cs.pollV++; ping(c.room, 'poll');
    res.json({ ok: true });
  });
  pollAct('launch', (p, cs) => { for (const o of cs.polls) if (o.status === 'open') o.status = 'ended'; p.status = 'open'; p.shared = false; p.votes = new Map(); p.openedAt = Date.now(); });
  pollAct('end', (p) => { p.status = 'ended'; });
  pollAct('share', (p, _cs, res) => { if (p.status === 'open') { res.status(400).json({ error: 'End the poll before sharing the results.' }); return false; } p.shared = true; return true; });
  pollAct('unshare', (p) => { p.shared = false; });
  pollAct('delete', (p, cs) => { cs.polls.splice(cs.polls.indexOf(p), 1); });

  post('poll/vote', { key: 'vote' }, (c, req, res) => {
    const cs = classState(c.st), p = cs.polls.find((x) => x.id === String(req.body?.id ?? ''));
    if (!p || p.status !== 'open') return res.status(409).json({ error: 'This poll is closed.' });
    if (c.isMgr) return res.status(403).json({ error: 'The host and co-hosts cannot vote.' });
    const choices = [...new Set((Array.isArray(req.body?.choices) ? req.body.choices : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < p.options.length))];
    if (!choices.length || (!p.multi && choices.length > 1)) return res.status(400).json({ error: p.multi ? 'Pick at least one answer.' : 'Pick one answer.' });
    p.votes.set(c.uid, { choices, name: c.name, at: Date.now() });
    cs.pollV++; // results change, but only the host's own open panel refreshes on its own timer (no ping to everyone per vote)
    res.json({ ok: true });
  });
  post('poll/list', { key: 'list' }, (c, req, res) => {
    const cs = classState(c.st);
    if (Number(req.body?.since) === cs.pollV && !c.isMgr) return res.json({ v: cs.pollV, same: true });
    res.set('Cache-Control', 'no-store').json({ v: cs.pollV, polls: cs.polls.filter((p) => c.isMgr || p.status !== 'draft').map((p) => (c.isMgr ? pollMgrView(p) : pollMemberView(p, c.uid))) });
  });

  // ============================================================ Q&A
  const MAX_Q = 500;
  const qView = (q, c) => {
    const answers = q.answers.filter((a) => !a.to || c.isMgr || a.to === c.uid || a.byUid === c.uid).map((a) => ({ by: a.by, text: a.text, private: !!a.to, at: a.at }));
    return {
      id: q.id, text: q.text, at: q.at, status: q.status, ups: q.ups.size, upped: q.ups.has(c.uid), mine: q.uid === c.uid,
      who: q.anon ? (c.isMgr ? `${q.name} (anonymous)` : 'Anonymous participant') : q.name, answers,
    };
  };
  post('qa/ask', { key: 'ask' }, (c, req, res) => {
    const cs = classState(c.st);
    if (c.st.qaOn === false && !c.isMgr) return res.status(403).json({ error: 'The host turned off questions.' });
    const t = text(req.body?.text, 300);
    if (!t) return res.status(400).json({ error: 'Type your question.' });
    if (cs.qa.length >= MAX_Q) return res.status(400).json({ error: 'Too many questions. Ask the host to clear some.' });
    const anon = req.body?.anonymous === true && c.st.qaAnon !== false;
    cs.qa.push({ id: randomBytes(5).toString('hex'), uid: c.uid, name: c.name, anon, text: t, at: Date.now(), ups: new Set(), status: 'open', answers: [] });
    cs.qaV++; ping(c.room, 'qa');
    res.json({ ok: true });
  });
  post('qa/upvote', { key: 'vote' }, (c, req, res) => {
    const cs = classState(c.st), q = cs.qa.find((x) => x.id === String(req.body?.id ?? ''));
    if (!q || q.status === 'dismissed') return res.status(404).json({ error: 'That question is gone.' });
    if (q.ups.has(c.uid)) q.ups.delete(c.uid); else q.ups.add(c.uid);
    cs.qaV++; ping(c.room, 'qa');
    res.json({ ok: true });
  });
  const qaMgr = (name, fn) => post(`qa/${name}`, { mgr: true }, (c, req, res) => {
    const cs = classState(c.st), q = cs.qa.find((x) => x.id === String(req.body?.id ?? ''));
    if (!q) return res.status(404).json({ error: 'That question is gone.' });
    const out = fn(q, cs, c, req, res); if (out === false) return;
    cs.qaV++; ping(c.room, 'qa');
    res.json({ ok: true });
  });
  qaMgr('answer', (q, _cs, c, req, res) => {
    const t = text(req.body?.text, 600);
    if (!t) { res.status(400).json({ error: 'Type the answer.' }); return false; }
    q.answers.push({ by: c.name, byUid: c.uid, text: t, to: req.body?.private === true ? q.uid : null, at: Date.now() });
    q.status = 'answered';
  });
  qaMgr('live', (q) => { q.status = q.status === 'live' ? 'open' : 'live'; });
  qaMgr('done', (q) => { q.status = 'answered'; });
  qaMgr('dismiss', (q) => { q.status = 'dismissed'; });
  qaMgr('reopen', (q) => { q.status = 'open'; });
  qaMgr('delete', (q, cs) => { cs.qa.splice(cs.qa.indexOf(q), 1); });
  post('qa/list', { key: 'list' }, (c, req, res) => {
    const cs = classState(c.st);
    if (Number(req.body?.since) === cs.qaV) return res.json({ v: cs.qaV, same: true });
    const rank = { live: 0, open: 1, answered: 2, dismissed: 3 };
    const qs = cs.qa.filter((q) => q.status !== 'dismissed' || c.isMgr).sort((a, b) => rank[a.status] - rank[b.status] || b.ups.size - a.ups.size || a.at - b.at);
    res.set('Cache-Control', 'no-store').json({ v: cs.qaV, on: c.st.qaOn !== false, anonymousAllowed: c.st.qaAnon !== false, questions: qs.map((q) => qView(q, c)) });
  });

  // ============================================================ files in chat
  app.put('/api/class/file', async (req, res) => {
    const c = await who(req, res, { key: 'file' }); if (!c) return;
    const cs = classState(c.st);
    if (!c.isMgr && c.st.allowFiles !== true) return res.status(403).json({ error: 'The host has not allowed participants to send files.' });
    const name = text(String(req.query.name ?? '').replace(/[\\/:*?"|]/g, '_'), 120) || 'file';
    if (!c.isMgr && BLOCKED_EXT.test(name)) return res.status(400).json({ error: 'That kind of file cannot be sent (programs and web pages are blocked).' });
    const len = Number(req.headers['content-length'] || 0);
    if (len > FILE_MAX) return res.status(413).json({ error: 'Files can be up to 25 MB.' });
    if (cs.files.size >= 200) return res.status(400).json({ error: 'This meeting has reached its limit of 200 files.' });
    const id = randomBytes(8).toString('hex'), dir = path.join(filesDir, c.room.replace(/[^\w.-]/g, '_')), file = path.join(dir, id);
    await fs.mkdir(dir, { recursive: true });
    const out = createWriteStream(file);
    let size = 0, over = false, done = false;
    const fail = (code, error) => { if (done) return; done = true; out.destroy(); fs.rm(file, { force: true }).catch(() => {}); if (!res.headersSent) res.status(code).json({ error }); };
    req.on('data', (b) => { size += b.length; if (size > FILE_MAX && !over) { over = true; fail(413, 'Files can be up to 25 MB.'); req.destroy(); } });
    req.on('aborted', () => fail(400, 'Upload cancelled.'));
    out.on('error', () => fail(500, 'Could not save the file on this computer.'));
    out.on('finish', () => {
      if (done) return; done = true;
      if (!size) { fs.rm(file, { force: true }).catch(() => {}); return res.status(400).json({ error: 'That file is empty.' }); }
      cs.files.set(id, { id, name, size, file, by: c.name, uid: c.uid, at: Date.now() });
      res.json({ file: { id, name, size } });
    });
    req.pipe(out);
  });
  app.get('/api/class/file/:id', (req, res) => {
    const user = auth.requireUser(req, res); if (!user) return;
    const st = meetings.get(clean(req.query.room, 64)), f = st?.cls?.files.get(String(req.params.id));
    if (!f || ![...st.identUser.values()].includes(user.id)) return res.status(404).json({ error: 'That file is not available.' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=600' });
    res.download(f.file, f.name);
  });

  // ============================================================ actions on one person (host and co-hosts)
  const target = async (c, req, res) => {
    const identity = String(req.body?.identity ?? '').slice(0, 128);
    if (!identity || !(await isPresent(c.room, identity))) { res.status(404).json({ error: 'That person is no longer in the meeting.' }); return null; }
    return identity;
  };
  post('spotlight', { mgr: true }, async (c, req, res) => {
    const cs = classState(c.st), identity = req.body?.identity === '' ? '' : await target(c, req, res); if (identity === null) return;
    const on = req.body?.on !== false;
    cs.spotlight = identity === '' ? [] : on ? [...new Set([...cs.spotlight, identity])].slice(-4) : cs.spotlight.filter((x) => x !== identity);
    await ctx.putRoomSettings(c.room, { spotlight: cs.spotlight });
    res.json({ ok: true, spotlight: cs.spotlight });
  });
  post('ask', { mgr: true }, async (c, req, res) => {
    const identity = await target(c, req, res); if (!identity) return;
    const what = req.body?.what === 'video' ? 'video' : 'unmute';
    await roomService.sendData(c.room, enc.encode(JSON.stringify({ k: 'ask', what, from: c.name })), DataPacket_Kind.RELIABLE, { topic: CLASS_TOPIC, destinationIdentities: [identity] });
    res.json({ ok: true });
  });
  post('talk', { mgr: true }, async (c, req, res) => {
    const cs = classState(c.st), identity = await target(c, req, res); if (!identity) return;
    const uid = c.st.identUser.get(identity); if (!uid) return res.status(404).json({ error: 'That person cannot be given the floor.' });
    if (req.body?.on === false) cs.talk.delete(uid); else cs.talk.add(uid); // allowed to unmute and show video even when everybody else may not
    c.st.talk = cs.talk;
    await applyPermissions(c.room);
    const talkers = [...c.st.identUser].filter(([id, u]) => cs.talk.has(u)).map(([id]) => id);
    await ctx.putRoomSettings(c.room, { talkers });
    await roomService.sendData(c.room, enc.encode(JSON.stringify({ k: 'talk', on: req.body?.on !== false, from: c.name })), DataPacket_Kind.RELIABLE, { topic: CLASS_TOPIC, destinationIdentities: [identity] });
    res.json({ ok: true });
  });
  post('lowerhand', { mgr: true }, async (c, req, res) => {
    const only = req.body?.identity ? await target(c, req, res) : null;
    if (req.body?.identity && !only) return;
    for (const p of await roomService.listParticipants(c.room)) {
      if (only && p.identity !== only) continue;
      if (p.attributes?.hand === '1') await roomService.updateParticipant(c.room, p.identity, { attributes: { hand: '0' } });
    }
    res.json({ ok: true });
  });

  /** Called by the server when a room is forgotten: remove its uploaded files. */
  async function forget(room) { present.delete(room); await fs.rm(path.join(filesDir, room.replace(/[^\w.-]/g, '_')), { recursive: true, force: true }).catch(() => {}); }
  return { forget, classState, who };
}
