// The streamer's page talking to the Game Hub agent in the SanWe's server on the SAME computer (see server/gamehub-agent.js).
// Works in any browser that opened the room as http://localhost:3000, and in SanWe's Studio. Over the public link it says "not available".
const BASE = '/api/gamehub/agent';

export function createAgent(getSession) {
  let key = '', es = null, hb = 0;
  const listeners = new Set();
  const emit = (m) => { for (const cb of listeners) { try { cb(m); } catch { /* page bug */ } } };
  const headers = () => ({ 'content-type': 'application/json', ...(key ? { 'x-gh-key': key } : {}) });
  const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
  const cmd = async (c, extra = {}) => {
    const r = await post('/cmd', { cmd: c, ...extra });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Game Hub agent: ${r.status}`);
    return j;
  };

  // key / mouse / pad lines are sent in small batches, one request at a time, so their order is kept
  let queue = [], sending = false;
  async function drain() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length && key) {
        const lines = queue.splice(0, 60);
        const r = await post('/lines', { lines }).catch(() => null);
        if (r && r.status === 401) { emit({ type: 'helper-exit' }); queue = []; break; }
      }
    } finally { sending = false; }
  }

  return {
    /** Is the agent usable from this page (same computer, helper built)? */
    async available() {
      try { const j = await (await fetch(`${BASE}/info`, { cache: 'no-store' })).json(); return !!j.available; } catch { return false; }
    },
    async start({ allowSys }) {
      const s = getSession();
      const r = await fetch(`${BASE}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: s.roomName, hostSecret: s.hostSecret || undefined, token: s.token, allowSys: !!allowSys }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j.error || `Could not start (${r.status}).` };
      key = j.key;
      es?.close(); es = new EventSource(`${BASE}/events?k=${encodeURIComponent(key)}`);
      es.addEventListener('fg', (e) => emit({ type: 'fg', v: !!JSON.parse(e.data).v }));
      es.addEventListener('fb', (e) => { const d = JSON.parse(e.data); emit({ type: 'fb', slot: d.slot, big: d.big, small: d.small }); });
      es.addEventListener('panic', (e) => emit({ type: 'panic', why: JSON.parse(e.data).why }));
      es.addEventListener('error', (e) => { if (e.data) emit({ type: 'error', text: JSON.parse(e.data).text }); });
      es.addEventListener('exit', () => { key = ''; emit({ type: 'helper-exit' }); });
      clearInterval(hb); hb = setInterval(() => { if (key) cmd('ping').catch(() => {}); }, 2500);
      return { ok: true, vigem: j.vigem, hotkey: j.hotkey, key: j.stopKey };
    },
    line(s) { queue.push(s); if (!sending) queueMicrotask(drain); },
    windows: () => cmd('windows'),
    target: (target, lockWindow) => cmd('target', { target, lockWindow }),
    allowSystemKeys: (on) => cmd('sys', { on: !!on }).catch(() => {}),
    hud: (players) => cmd('hud', { text: players.length ? `${players.map((p) => `${p.name}${p.what ? ` (${p.what})` : ''}`).join(', ')} ${players.length === 1 ? 'is' : 'are'} playing on this PC` : '' }).catch(() => {}),
    log: (text) => { if (key) cmd('log', { text }).catch(() => {}); },
    release: () => { queue = []; if (key) cmd('release').catch(() => {}); },
    async stop() { clearInterval(hb); es?.close(); es = null; queue = []; if (key) { try { await cmd('stop'); } catch { /* already gone */ } } key = ''; },
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
