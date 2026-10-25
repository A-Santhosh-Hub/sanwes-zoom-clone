// Breakout rooms: the host splits a meeting into smaller rooms (automatically, by hand, or let people choose), opens them,
// can broadcast to all of them, and closes them (people get a countdown and are brought back to the main meeting).
// Each breakout room is an ordinary LiveKit room named "<main>~b<n>". Who may enter is decided here, from accounts:
// the main meeting's host and co-hosts may enter any room, everybody else only the room they were assigned (or any room when
// the host chose "let people choose"). The page asks /api/token for the breakout room like for any other room.
import { DataPacket_Kind } from 'livekit-server-sdk';

const TOPIC = 'sanwes.class';
const enc = new TextEncoder();
const BO_NAME = /^(.+)~b(\d{1,2})$/;
export const parseBo = (room) => { const m = BO_NAME.exec(String(room)); return m ? { main: m[1], n: Number(m[2]) } : null; };
const text = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, ' ').trim().slice(0, max);

export function initBreakout({ app, roomService, meetings, who, ensureState, findRoom, parseMeta, MAX_ROOM }) {
  const post = (path, opts, fn) => app.post(`/api/bo/${path}`, async (req, res) => {
    const c = await who(req, res, opts); if (!c) return;
    try { await fn(c, req, res); } catch (e) { console.error(`breakout ${path} failed: ${e.message}`); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again.' }); }
  });
  const boName = (main, n) => `${main}~b${n}`;
  const send = (room, payload, ids) => roomService.sendData(room, enc.encode(JSON.stringify(payload)), DataPacket_Kind.RELIABLE, { topic: TOPIC, ...(ids ? { destinationIdentities: ids } : {}) }).catch(() => {});
  const nameOfUid = (st, uid, fallback = 'Someone') => st.names?.get(uid) ?? fallback;

  /** Everyone who is not a host: in the main room (where 0) or inside an open breakout room (where n). */
  async function roster(main, st) {
    const out = [], seen = new Set();
    const take = async (room, where) => {
      const state = where ? meetings.get(room) : st;
      for (const p of await roomService.listParticipants(room)) {
        let role = 'member'; try { role = JSON.parse(p.metadata || '{}').role ?? 'member'; } catch { /* default */ }
        if (['host', 'cohost', 'bot'].includes(role)) continue;
        const uid = state?.identUser.get(p.identity); if (!uid || seen.has(uid)) continue;
        seen.add(uid); (st.names ??= new Map()).set(uid, p.name || p.identity);
        out.push({ identity: p.identity, uid, name: p.name || p.identity, where, room });
      }
    };
    await take(main, 0);
    if (st.bo?.open) for (const r of st.bo.rooms) { try { await take(boName(main, r.n), r.n); } catch { /* room gone */ } }
    return out;
  }
  const attendees = async (main, st) => (await roster(main, st)).filter((p) => p.where === 0);
  const boState = (st) => (st.bo ??= { rooms: [], open: false, opts: { allowChoose: false, allowReturn: true, minutes: 0 }, endsAt: 0, timer: null, closing: false });
  const roomOf = (bo, uid) => bo.rooms.find((r) => r.uids.has(uid));

  /** Tell people where to go. A person is told in the room they are in now (main or another breakout room). */
  async function notifyAssigned(main, st, bo, only = null) {
    for (const p of await roster(main, st)) {
      if (only && p.uid !== only) continue;
      const r = roomOf(bo, p.uid);
      if (r && r.n !== p.where) await send(p.room, { k: 'bo-open', n: r.n, name: r.name, endsAt: bo.endsAt, allowReturn: bo.opts.allowReturn }, [p.identity]);
      else if (!r && bo.opts.allowChoose && p.where === 0) await send(p.room, { k: 'bo-open', n: 0, name: '', endsAt: bo.endsAt, allowReturn: bo.opts.allowReturn }, [p.identity]);
    }
  }

  post('state', { key: 'list', allowBo: true }, async (c, req, res) => {
    const bo = boState(c.st);
    const main = c.room; // who() already resolved the main room even for a caller inside a breakout room
    const out = { open: bo.open, endsAt: bo.endsAt, opts: bo.opts, inBo: c.inBo || 0, mine: roomOf(bo, c.uid)?.n ?? null, rooms: bo.rooms.map((r) => ({ n: r.n, name: r.name, size: r.uids.size })) };
    if (c.isMgr) {
      const counts = new Map();
      if (bo.open) for (const r of bo.rooms) { try { counts.set(r.n, (await roomService.listParticipants(boName(main, r.n))).length); } catch { counts.set(r.n, 0); } }
      const people = await roster(main, c.st);
      out.people = people.map((p) => ({ uid: p.uid, name: p.name, room: roomOf(bo, p.uid)?.n ?? 0, where: p.where }));
      for (const r of out.rooms) r.now = counts.get(r.n) ?? 0;
    }
    res.set('Cache-Control', 'no-store').json(out);
  });

  post('create', { mgr: true }, async (c, req, res) => {
    const bo = boState(c.st);
    if (bo.open) return res.status(409).json({ error: 'Close the breakout rooms before creating new ones.' });
    const count = Math.round(Number(req.body?.count));
    if (!(count >= 1 && count <= 50)) return res.status(400).json({ error: 'Choose between 1 and 50 rooms.' });
    const mode = ['auto', 'manual', 'choose'].includes(req.body?.mode) ? req.body.mode : 'auto';
    bo.rooms = Array.from({ length: count }, (_, i) => ({ n: i + 1, name: `Breakout Room ${i + 1}`, uids: new Set() }));
    bo.opts = { allowChoose: mode === 'choose', allowReturn: req.body?.allowReturn !== false, minutes: Math.max(0, Math.min(240, Math.round(Number(req.body?.minutes) || 0))) };
    if (mode === 'auto') {
      const people = (await attendees(c.room, c.st)).sort(() => Math.random() - 0.5);
      people.forEach((p, i) => bo.rooms[i % count].uids.add(p.uid));
    }
    res.json({ ok: true });
  });

  post('assign', { mgr: true }, async (c, req, res) => {
    const bo = boState(c.st), uid = String(req.body?.uid ?? ''), n = Math.round(Number(req.body?.n) || 0);
    if (!uid) return res.status(400).json({ error: 'Pick a person.' });
    for (const r of bo.rooms) r.uids.delete(uid);
    const target = bo.rooms.find((r) => r.n === n);
    if (n && !target) return res.status(404).json({ error: 'No such room.' });
    target?.uids.add(uid);
    if (bo.open && target) await notifyAssigned(c.room, c.st, bo, uid);
    res.json({ ok: true });
  });

  post('open', { mgr: true }, async (c, req, res) => {
    const bo = boState(c.st);
    if (bo.open) return res.status(409).json({ error: 'The breakout rooms are already open.' });
    if (!bo.rooms.length) return res.status(400).json({ error: 'Create the rooms first.' });
    const meta = parseMeta((await findRoom(c.room))?.metadata);
    for (const r of bo.rooms) {
      const name = boName(c.room, r.n);
      if (!(await findRoom(name))) await roomService.createRoom({ name, metadata: JSON.stringify({ ...meta, v: 1, type: 'meeting', title: `${r.name} · ${meta.title || c.room}`, game: '', cover: '', waiting: false, spotlight: [], talkers: [], suspended: false, breakoutOf: c.room, n: r.n }), emptyTimeout: 120, maxParticipants: MAX_ROOM });
    }
    bo.open = true; bo.closing = false;
    bo.endsAt = bo.opts.minutes ? Date.now() + bo.opts.minutes * 60_000 : 0;
    clearTimeout(bo.timer);
    if (bo.endsAt) bo.timer = setTimeout(() => closeAll(c.room, c.st, 60).catch(() => {}), bo.opts.minutes * 60_000 - 60_000 > 0 ? bo.opts.minutes * 60_000 - 60_000 : 0);
    await notifyAssigned(c.room, c.st, bo);
    res.json({ ok: true });
  });

  async function closeAll(main, st, secs = 60) {
    const bo = boState(st);
    if (!bo.open || bo.closing) return;
    bo.closing = true; clearTimeout(bo.timer);
    const message = { k: 'bo-end', secs };
    for (const r of bo.rooms) await send(boName(main, r.n), message);
    bo.timer = setTimeout(async () => {
      for (const r of bo.rooms) { try { await roomService.deleteRoom(boName(main, r.n)); } catch { /* already empty */ } meetings.delete(boName(main, r.n)); }
      bo.open = false; bo.closing = false; bo.endsAt = 0;
      await send(main, { k: 'bo-closed' });
    }, Math.max(0, secs) * 1000);
  }
  post('close', { mgr: true }, async (c, req, res) => {
    const bo = boState(c.st);
    if (!bo.open) return res.status(409).json({ error: 'The breakout rooms are not open.' });
    const secs = Math.max(0, Math.min(300, Math.round(Number(req.body?.secs ?? 60))));
    await closeAll(c.room, c.st, secs);
    res.json({ ok: true, secs });
  });
  post('discard', { mgr: true }, async (c, req, res) => {
    const bo = boState(c.st);
    if (bo.open) return res.status(409).json({ error: 'Close the breakout rooms first.' });
    bo.rooms = []; res.json({ ok: true });
  });

  post('broadcast', { mgr: true }, async (c, req, res) => {
    const bo = boState(c.st), t = text(req.body?.text, 300);
    if (!t) return res.status(400).json({ error: 'Type the message.' });
    if (!bo.open) return res.status(409).json({ error: 'The breakout rooms are not open.' });
    for (const r of bo.rooms) await send(boName(c.room, r.n), { k: 'bo-msg', text: t, from: c.name });
    res.json({ ok: true });
  });

  post('help', { key: 'ask', allowBo: true }, async (c, req, res) => {
    const bo = boState(c.st);
    if (!c.inBo) return res.status(400).json({ error: 'You are not in a breakout room.' });
    const ids = [];
    for (const p of await roomService.listParticipants(c.room)) { let role = ''; try { role = JSON.parse(p.metadata || '{}').role; } catch { /* none */ } if (['host', 'cohost'].includes(role)) ids.push(p.identity); }
    if (ids.length) await send(c.room, { k: 'bo-help', n: c.inBo, from: c.name }, ids);
    res.json({ ok: true, sent: ids.length });
  });

  /** Used by /api/token: may this account enter this breakout room? Returns { main, n, st, manager } or null. */
  function entry(room, uid) {
    const p = parseBo(room); if (!p) return null;
    const st = meetings.get(p.main); if (!st?.bo?.open) return null;
    const manager = st.hostUsers.has(uid) || st.cohostUsers.has(uid);
    const mine = roomOf(st.bo, uid);
    const allowed = manager || mine?.n === p.n || (st.bo.opts.allowChoose && st.bo.rooms.some((r) => r.n === p.n));
    return allowed ? { main: p.main, n: p.n, st, manager } : null;
  }
  return { entry };
}
