// Game Hub, streamer side: the part that lets people the streamer approved play on THIS computer.
//
// The streamer's page (any Chrome / Edge window, or SanWe's Studio, opened as http://localhost:3000) talks to this module, which runs the input helper
// (desktop/input/sanwes-input.exe): real keyboard / mouse input, virtual Xbox pads, the emergency hotkey and the "who is playing" pill.
//
// Why it is safe to have this in the server:
//   - every request must come from THIS computer (not through the public link, which always adds X-Forwarded-For) and from our own page (Origin);
//   - the caller must be signed in AND prove they are the host of a live game room (host secret or the room's join token), then gets a random key
//     that only that page holds; without it nothing is accepted;
//   - only a short list of well-formed helper commands is passed on; the window rule and screen area are set here, never by the page;
//   - if the page goes silent for 8 seconds, or the helper dies, everything is let go and the helper is stopped;
//   - every grant and stop is written to data/logs/remote-play-<date>.log.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The only lines the page may pass on to the helper (input only). Everything else (window rule, screen area, pill, hotkey) goes through named commands below.
const LINE_OK = [
  /^(KD|KU) \d{1,3} [01]$/, /^MR -?\d{1,5} -?\d{1,5}$/, /^MA \d{1,5} \d{1,5}$/, /^MB [0-4] [01]$/, /^(MW|MH) -?\d{1,5}$/,
  /^PD [0-3] \d{1,5} \d{1,3} \d{1,3} -?\d{1,5} -?\d{1,5} -?\d{1,5} -?\d{1,5}$/, /^PX [0-3]$/, /^RA$/,
];
const QUIET_MS = 8000; // the page has to be heard from at least this often while the agent runs

export function initGameHubAgent({ app, auth, manager, gameRoom, thisComputerOnly, dataDir, rootDir }) {
  const helperPath = process.env.SANWES_INPUT_HELPER || path.join(rootDir, 'desktop', 'input', 'sanwes-input.exe');
  const logDir = path.join(dataDir, 'logs');
  let helper = null, ready = false, vigem = false, hotkey = 'none', session = null /* { key, room, uid, at } */, sse = null, buf = '';
  const waiters = new Map(); // 'WINEND' | 'SCREND' -> { rows, resolve }
  let screens = [];

  const log = (text) => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0'), day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      fs.appendFileSync(path.join(logDir, `remote-play-${day}.log`), `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}  ${String(text).replace(/[\r\n]+/g, ' ').slice(0, 300)}\r\n`);
    } catch { /* read-only folder: the log is a courtesy */ }
  };
  const put = (line) => { try { if (helper?.stdin.writable) helper.stdin.write(`${line}\n`); } catch { /* helper gone */ } };
  const emit = (event, data) => { try { sse?.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`); } catch { /* client gone */ } };
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

  // ---------------------------------------------------------------- the helper process
  function onHelperLine(l) {
    const [w, a, b, c] = l.split(' ');
    if (w === 'READY') { ready = true; vigem = a === '1'; waiters.get('READY')?.resolve(); }
    else if (w === 'HK') { hotkey = l.slice(3) || 'none'; waiters.get('HK')?.resolve(); }
    else if (w === 'FG') emit('fg', { v: a === '1' });
    else if (w === 'FB') emit('fb', { slot: Number(a), big: Number(b), small: Number(c) });
    else if (w === 'PANIC') { log(`STOP ALL (${a})`); emit('panic', { why: a }); }
    else if (w === 'ERR') { log(`helper: ${l}`); emit('error', { text: l.slice(4, 160) }); }
    else if (w === 'WIN' || w === 'SCR') { const wt = waiters.get(w === 'WIN' ? 'WINEND' : 'SCREND'); if (wt) wt.rows.push(l); }
    else if (w === 'WINEND' || w === 'SCREND') { const wt = waiters.get(w); if (wt) { waiters.delete(w); wt.resolve(wt.rows); } }
  }
  function waitFor(key, ms = 4000) { // a reply the helper sends once
    return new Promise((resolve) => {
      const t = setTimeout(() => { waiters.delete(key); resolve(key.endsWith('END') ? [] : false); }, ms);
      waiters.set(key, { rows: [], resolve: (v) => { clearTimeout(t); waiters.delete(key); resolve(v ?? true); } });
    });
  }
  async function startHelper() {
    if (helper && ready) return true;
    if (!fs.existsSync(helperPath)) return false;
    ready = false; buf = '';
    const w = waitFor('READY', 7000);
    helper = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    helper.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l) onHelperLine(l); } });
    helper.stderr.on('data', () => {});
    helper.stdin.on('error', () => {});
    helper.on('exit', (code) => { helper = null; ready = false; log(`helper stopped (${code})`); emit('exit', { code }); });
    return (await w) === true;
  }
  function stopHelper(why) {
    if (!helper) return;
    log(`stopped: ${why}`);
    put('RA'); put('HUD'); put('Q');
    const h = helper; setTimeout(() => { try { h.kill(); } catch { /* gone */ } }, 800);
    session = null;
  }
  setInterval(() => { // the page went away without saying so
    if (session && Date.now() - session.at > QUIET_MS) { emit('exit', { code: 'quiet' }); stopHelper('the streamer\'s page went silent'); try { sse?.end(); } catch { /* gone */ } sse = null; }
  }, 1500).unref();
  process.on('exit', () => { try { helper?.kill(); } catch { /* gone */ } });

  // ---------------------------------------------------------------- who may call
  function fromThisPage(req, res) {
    if (!thisComputerOnly(req)) { res.status(403).json({ error: 'Game Hub play controls only work from the computer that is streaming (open http://localhost:3000 there).' }); return false; }
    const origin = req.get('origin');
    if (origin) { try { if (new URL(origin).host !== req.get('host')) throw new Error('other site'); } catch { res.status(403).json({ error: 'Not allowed from another site.' }); return false; } }
    return true;
  }
  function keyed(req, res) {
    if (!fromThisPage(req, res)) return null;
    const k = String(req.get('x-gh-key') ?? req.query?.k ?? '');
    if (!session || !k || !same(k, session.key)) { res.status(401).json({ error: 'Game Hub is not running for this page. Switch it on again.' }); return null; }
    session.at = Date.now();
    return session;
  }

  app.get('/api/gamehub/agent/info', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!thisComputerOnly(req)) return res.json({ available: false, why: 'remote' });
    res.json({ available: fs.existsSync(helperPath), running: !!session });
  });

  app.post('/api/gamehub/agent/start', async (req, res) => {
    if (!fromThisPage(req, res)) return;
    const user = auth.requireUser(req, res); if (!user) return;
    const m = await manager(req, res, { hostOnly: true }); if (!m) return;
    if (!(await gameRoom(m.room))) return res.status(400).json({ error: 'Play requests only work in a Game Hub room.' });
    if (!fs.existsSync(helperPath)) return res.status(501).json({ error: 'The input helper is missing (desktop\\input\\sanwes-input.exe). Run desktop\\input\\build-input.bat.' });
    if (helper) stopHelper('another stream took over');
    await new Promise((r) => setTimeout(r, helper ? 900 : 0));
    if (!(await startHelper())) return res.status(502).json({ error: 'The input helper did not start.' });
    session = { key: randomBytes(18).toString('hex'), room: m.room, uid: user.id, at: Date.now() };
    put(`SYS ${req.body?.allowSys ? 1 : 0}`);
    const hk = waitFor('HK'); put('HK'); await hk;
    put('TW 1'); put('TG 1'); // window 1 does not exist: nothing is pressed until the streamer chooses a window or screen
    log(`ready: gamepads ${vigem ? 'available' : 'NOT available (ViGEmBus missing)'}; emergency stop ${hotkey === 'none' ? 'NOT registered (every combination was taken)' : hotkey}; streamer ${user.username}; room ${m.room}`);
    res.json({ ok: true, key: session.key, vigem, hotkey: hotkey !== 'none', stopKey: hotkey });
  });

  // events for the page (fg / fb / panic / error / exit) as a server-sent stream
  app.get('/api/gamehub/agent/events', (req, res) => {
    if (!keyed(req, res)) return;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    try { sse?.end(); } catch { /* gone */ }
    sse = res; res.write('event: hello\ndata: {}\n\n');
    const beat = setInterval(() => { try { res.write(': \n\n'); if (session) session.at = Date.now(); } catch { /* gone */ } }, 3000);
    req.on('close', () => { clearInterval(beat); if (sse === res) sse = null; });
  });

  // keyboard / mouse / gamepad lines, many per second
  app.post('/api/gamehub/agent/lines', (req, res) => {
    if (!keyed(req, res)) return;
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 60) : [];
    for (const l of lines) if (typeof l === 'string' && l.length < 100 && LINE_OK.some((re) => re.test(l))) put(l);
    res.status(204).end();
  });

  app.post('/api/gamehub/agent/cmd', async (req, res) => {
    const s = keyed(req, res); if (!s) return;
    const b = req.body ?? {};
    switch (b.cmd) {
      case 'ping': return res.json({ ok: true });
      case 'windows': { // what could be controlled: program windows and screens
        const w = waitFor('WINEND'), c = waitFor('SCREND'); put('LISTWIN'); put('SCREENS');
        const [wrows, srows] = await Promise.all([w, c]);
        screens = srows.map((l) => l.split(' ')).map((p) => ({ index: Number(p[1]), left: Number(p[2]), top: Number(p[3]), width: Number(p[4]), height: Number(p[5]), primary: p[6] === '1' }));
        const windows = wrows.map((l) => { const p = l.split(' '); return { hwnd: p[1], pid: Number(p[2]), title: p.slice(3).join(' ') }; });
        return res.json({ windows, screens });
      }
      case 'target': { // which window or screen the players control
        const t = b.target ?? {};
        if (t.kind === 'window' && /^\d{1,15}$/.test(String(t.hwnd))) {
          put(`TW ${t.hwnd}`); put(`TG ${b.lockWindow === false ? 0 : 1}`);
          log(`players control the window ${t.hwnd} "${String(t.title ?? '').replace(/[\r\n]/g, ' ').slice(0, 80)}"${b.lockWindow === false ? ' (not only while in front)' : ' (only while it is in front)'}`);
        } else if (t.kind === 'screen' && Number.isInteger(t.index)) {
          if (!screens.length) { const w = waitFor('SCREND'); put('SCREENS'); const rows = await w; screens = rows.map((l) => l.split(' ')).map((p) => ({ index: Number(p[1]), left: Number(p[2]), top: Number(p[3]), width: Number(p[4]), height: Number(p[5]), primary: p[6] === '1' })); }
          const sc = screens.find((x) => x.index === t.index);
          if (!sc) return res.status(400).json({ error: 'That screen is not there.' });
          put('TW 0'); put('TG 1'); put(`TR ${sc.left} ${sc.top} ${sc.width} ${sc.height}`);
          log(`players control the whole screen ${sc.index}`);
        } else { put('TW 0'); put('TG 1'); }
        return res.json({ ok: true });
      }
      case 'sys': put(`SYS ${b.on ? 1 : 0}`); log(`system keys ${b.on ? 'allowed' : 'blocked'}`); return res.json({ ok: true });
      case 'hud': put(`HUD ${String(b.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 140)}`.trimEnd()); return res.json({ ok: true });
      case 'log': log(String(b.text ?? '')); return res.json({ ok: true });
      case 'release': put('RA'); return res.json({ ok: true });
      case 'stop': stopHelper('the streamer switched Game Hub off'); try { sse?.end(); } catch { /* gone */ } sse = null; return res.json({ ok: true });
      default: return res.status(400).json({ error: 'Unknown command.' });
    }
  });

  return { stop: () => stopHelper('the server is stopping') };
}
