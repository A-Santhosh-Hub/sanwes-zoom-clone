// Game Hub: viewers of a game room ask to play, the streamer says yes, and then they play on the streamer's PC with keyboard, mouse and gamepad.
//
//  VIEWER (any browser)                                   STREAMER (SanWe's Studio; the page there can talk to the input helper)
//   "Play" -> request (reliable data message)  ------->   Game Hub panel: Allow / Deny, what they may use
//   <---- the streamer's attribute "rp" lists who may play (the only thing a viewer believes)
//   keys, mouse, wheel, gamepad -> ONE small "state" message, many times a second, on the lossy channel (like UDP)
//                                                  ---->  compared with the last one -> key down/up, mouse, pad lines -> Studio -> sanwes-input.exe
//   <---- ping answers and rumble (lossy)
//
// Why a full state each time instead of "key W went down": a lost message is replaced by the next one 4 to 100 ms later, so a key can never get stuck,
// and mouse movement is a running total so a lost message cannot lose movement either. Nothing waits for a lost message (no head-of-line blocking).
//
// Safety (streamer side): input is only taken from people the streamer allowed and whose identity LiveKit itself stamps on every message;
// it stops when they leave, go quiet for 1.5 s, or the streamer presses Stop / Ctrl+Alt+Shift+F12; Studio only accepts well-formed commands and can limit them to the game window.
import { Track } from 'livekit-client';
import { store } from './ui.js';
import { createAgent } from './gamehub-agent.js';
import { createTouchPad } from './touchpad.js';

export const RP_TOPIC = 'sanwes.rp';
export const RPI_TOPIC = 'sanwes.rpi';

// ---- keyboard: KeyboardEvent.code -> hardware scan code (+256 for the "extended" keys). Games read scan codes, so layout does not matter.
const KEYS = {};
const run = (sc, ...codes) => codes.forEach((c, i) => { KEYS[c] = sc + i; });
run(0x02, 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'Backspace', 'Tab',
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Enter', 'ControlLeft',
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Backquote', 'ShiftLeft', 'Backslash',
  'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash', 'ShiftRight', 'NumpadMultiply', 'AltLeft', 'Space', 'CapsLock',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'NumLock', 'ScrollLock',
  'Numpad7', 'Numpad8', 'Numpad9', 'NumpadSubtract', 'Numpad4', 'Numpad5', 'Numpad6', 'NumpadAdd', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad0', 'NumpadDecimal');
Object.assign(KEYS, { Escape: 0x01, IntlBackslash: 0x56, F11: 0x57, F12: 0x58 });
run(0x64, 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23');
for (const [c, sc] of Object.entries({ NumpadEnter: 0x1C, ControlRight: 0x1D, NumpadDivide: 0x35, AltRight: 0x38, Home: 0x47, ArrowUp: 0x48, PageUp: 0x49, ArrowLeft: 0x4B,
  ArrowRight: 0x4D, End: 0x4F, ArrowDown: 0x50, PageDown: 0x51, Insert: 0x52, Delete: 0x53 })) KEYS[c] = sc | 256;

// ---- gamepad: the browser's "standard" layout -> Xbox 360 report bits
const PAD_BTN = { 0: 0x1000, 1: 0x2000, 2: 0x4000, 3: 0x8000, 4: 0x0100, 5: 0x0200, 8: 0x0020, 9: 0x0010, 10: 0x0040, 11: 0x0080, 12: 0x0001, 13: 0x0002, 14: 0x0004, 15: 0x0008 };
const stick = (v) => { const a = Math.abs(v) < 0.08 ? 0 : v; return Math.max(-32768, Math.min(32767, Math.round(a * 32767))); };
function readPad(gp) {
  let b = 0;
  gp.buttons.forEach((x, i) => { if (PAD_BTN[i] && x.pressed) b |= PAD_BTN[i]; });
  const lt = Math.round((gp.buttons[6]?.value ?? 0) * 255), rt = Math.round((gp.buttons[7]?.value ?? 0) * 255);
  return [b, lt, rt, stick(gp.axes[0] ?? 0), stick(-(gp.axes[1] ?? 0)), stick(gp.axes[2] ?? 0), stick(-(gp.axes[3] ?? 0))];
}
// Stream quality choices for a game room (same fields as the screen-share presets in main.js). All use hardware-friendly H.264 and the "motion" hint.
export const GAME_PRESETS = {
  game: { label: 'Smooth 1080p at 60 fps (recommended)', res: '1080', fps: '60', hint: 'motion', codec: 'h264', vbr: 'auto', audio: 'music' },
  game720: { label: 'Light 720p at 60 fps (weaker PC or network)', res: '720', fps: '60', hint: 'motion', codec: 'h264', vbr: 'auto', audio: 'music' },
  game1440: { label: 'Sharp 1440p at 60 fps (fast PC and network)', res: '1440', fps: '60', hint: 'motion', codec: 'h264', vbr: 'auto', audio: 'music' },
  gamelan: { label: 'Same room / LAN: 1080p60 at 30 Mbit/s', res: '1080', fps: '60', hint: 'motion', codec: 'h264', vbr: '30000000', audio: 'hifi' },
};
// Hardware HEVC: only browsers that have a GPU encoder for it list H.265 as a codec they can send (Chrome / Edge yes, the Studio window no).
GAME_PRESETS.gamehevc = { label: 'GPU HEVC 1080p at 60 fps (needs Chrome or Edge with a GPU; viewers need a recent browser)', res: '1080', fps: '60', hint: 'motion', codec: 'h265', vbr: 'auto', audio: 'music' };
export const canSendHevc = () => { try { return RTCRtpSender.getCapabilities('video').codecs.some((c) => /h265|hevc/i.test(c.mimeType)); } catch { return false; } };
export const gamePreset = () => {
  const p = GAME_PRESETS[store.get('sanwes.gh.q')] ?? GAME_PRESETS.game;
  return p.codec === 'h265' && !canSendHevc() ? GAME_PRESETS.game : p; // this browser cannot encode HEVC: use H.264
};

// ---- Faster start. WebRTC starts a stream at about 0.3 Mbit/s and works its way up, so the first 10 to 30 seconds of a game would be a blurry
// 320p picture. The sender can be told the starting bitrate in the codec lines of the session description it gets back from the media server
// (x-google-start-bitrate / x-google-min-bitrate; the same settings WebRTC's own "bitrate" hints use). It is only done for the streamer of a game room.
function tuneSdp(sdp, { start, min }) {
  const lines = sdp.split('\r\n'), out = [];
  let inVideo = false;
  const pts = new Map(); // payload type -> codec, for the video section
  for (const l of lines) { if (l.startsWith('m=')) inVideo = l.startsWith('m=video'); const m = inVideo && /^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\//i.exec(l); if (m) pts.set(m[1], m[2]); }
  const extra = `x-google-start-bitrate=${start};x-google-min-bitrate=${min}`;
  inVideo = false; const done = new Set();
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const f = inVideo && /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && pts.has(f[1]) && !/x-google-start-bitrate/.test(l)) { out.push(`${l};${extra}`); done.add(f[1]); continue; }
    out.push(l);
    const r = inVideo && /^a=rtpmap:(\d+) /.exec(l);
    if (r && pts.has(r[1]) && !lines.some((x) => x.startsWith(`a=fmtp:${r[1]} `))) { out.push(`a=fmtp:${r[1]} ${extra}`); done.add(r[1]); }
  }
  return out.join('\r\n');
}
if (!window.__ghSdpPatched) {
  window.__ghSdpPatched = true;
  const orig = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (desc, ...rest) {
    try { const tune = window.__ghSdpTune; if (tune && desc && desc.type === 'answer' && /m=video/.test(desc.sdp)) desc = { type: 'answer', sdp: tuneSdp(desc.sdp, tune) }; } catch { /* leave it as it is */ }
    return orig.call(this, desc, ...rest);
  };
}
/** Called just before a game stream starts: the bitrate (bit/s) it may use at most. */
export function tuneStream(maxBitrate) { window.__ghSdpTune = maxBitrate ? { start: Math.round((maxBitrate * 0.7) / 1000), min: Math.round((maxBitrate * 0.25) / 1000) } : null; }
const LAT = { lowest: 0, low: 40, smooth: 150 }; // how long the viewer's player may wait for late video (ms)

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const btn = (txt, fn, cls = 'secondary') => { const b = el('button', cls, txt); b.type = 'button'; b.onclick = fn; return b; };
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

export function initGameHub({ $, getRoom, getSession, toast, meeting, isTheater }) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const agent = createAgent(getSession);
  let studio = null; // the Game Hub agent on this computer, once it is known to be usable (see probeAgent)
  const room = () => getRoom();
  const me = () => room()?.localParticipant;
  const isHost = () => getSession()?.role === 'host';
  const idName = (id) => room()?.remoteParticipants.get(id)?.name || id;
  const streamer = () => [...(room()?.remoteParticipants.values() ?? [])].find((p) => p.getTrackPublication(Track.Source.ScreenShare)) ?? null;

  const sendRel = (msg, to) => me()?.publishData(enc.encode(JSON.stringify(msg)), { reliable: true, topic: RP_TOPIC, ...(to ? { destinationIdentities: [].concat(to) } : {}) }).catch((e) => { lastErr = e?.message || String(e); });
  let lastErr = '';
  const sendLossy = (msg, to) => me()?.publishData(enc.encode(JSON.stringify(msg)), { reliable: false, topic: RPI_TOPIC, destinationIdentities: [].concat(to) }).catch(() => {});

  // =====================================================================================================================
  // STREAMER SIDE
  // =====================================================================================================================
  const H = { accepting: false, max: 2, lockWindow: true, allowSys: false, players: new Map(), reqs: new Map(), vigem: null, target: null, targets: { windows: [], screens: [] }, key: 'Ctrl+Alt+Shift+F12', fg: true, started: false, enc: '', env: 'unknown' };

  function hostPublish() {
    me()?.setAttributes({ rp: JSON.stringify({ o: H.accepting ? 1 : 0, g: H.vigem ? 1 : 0, n: H.max, p: [...H.players].map(([id, p]) => [id, p.kbm ? 1 : 0, p.pad]) }) }).catch(() => {});
    studio?.hud([...H.players.values()].map((p) => ({ name: p.name, what: [p.kbm && 'keyboard & mouse', p.pad && `gamepad ${p.pad}`].filter(Boolean).join(' + ') })));
    renderHost();
  }
  // Is the agent (in the server, on this computer) usable from this page? Only when the room was opened on the streaming PC itself as http://localhost:3000.
  async function probeAgent() {
    if (H.env !== 'unknown') return;
    H.env = 'checking';
    const ok = await agent.available();
    H.env = ok ? 'ok' : 'no';
    if (ok) { studio = agent; wireEvents(); }
    renderHost();
  }
  async function hostStart() {
    if (!studio) return false;
    const r = await studio.start({ allowSys: H.allowSys });
    if (!r.ok) { toast(r.error || 'Could not start the input helper.'); return false; }
    H.started = true; H.vigem = r.vigem; H.key = (r.key || H.key).replace('Control', 'Ctrl');
    if (!r.hotkey) toast('The emergency key could not be registered (another program uses it). Use the Stop button.', 'info');
    await refreshTargets(true);
    return true;
  }
  // What players may control: one program window (only while it is in front) or a whole screen. Nothing is controlled until the streamer picks.
  async function refreshTargets(auto = false) {
    if (!studio || !H.started) return;
    try { H.targets = await studio.windows(); } catch { return; }
    if (auto && !H.target) await autoTarget();
    renderHost();
  }
  async function autoTarget() { // a best guess from what the browser is sharing; the streamer can change it
    const tr = me()?.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    const st = tr?.getSettings?.() ?? {}, label = String(tr?.label ?? '');
    if (st.displaySurface === 'window') {
      const w = H.targets.windows.find((x) => label && (x.title === label || label.includes(x.title) || x.title.includes(label)));
      if (w) return pickTarget({ kind: 'window', hwnd: w.hwnd, title: w.title });
    }
    if (st.displaySurface === 'monitor') {
      const m = /([0-9]+)/.exec(label); const sc = H.targets.screens.find((x) => m && x.index === Number(m[1]) - 1) ?? H.targets.screens.find((x) => x.primary);
      if (sc) return pickTarget({ kind: 'screen', index: sc.index });
    }
  }
  async function pickTarget(t2) {
    H.target = t2;
    if (studio && H.started) { try { await studio.target(t2 ?? { kind: 'none' }, H.lockWindow); } catch (e) { toast(e.message); } }
    renderHost();
  }
  async function setAccepting(on) {
    if (on) {
      if (!studio) { toast('Open this room on the streaming computer itself at http://localhost:3000 to let viewers play.'); return false; }
      if (!H.started && !(await hostStart())) return false;
    }
    H.accepting = on;
    if (!on) { for (const [id] of [...H.reqs]) { sendRel({ t: 'no', why: 'The streamer stopped taking play requests.' }, id); } H.reqs.clear(); }
    meeting.setSetting?.('playOpen', on).catch(() => {});
    studio?.log(on ? 'accepting play requests' : 'not accepting play requests');
    hostPublish(); return true;
  }
  function stopAll(why, keepOpen = false) {
    for (const id of [...H.players.keys()]) hostRemove(id, why, true);
    if (!keepOpen && H.accepting) { H.accepting = false; meeting.setSetting?.('playOpen', false).catch(() => {}); for (const [id] of H.reqs) sendRel({ t: 'no', why }, id); H.reqs.clear(); }
    studio?.release();
    hostPublish();
  }
  function hostRelease(pl) { // let go of everything this player is holding
    if (!studio) return;
    for (const k of pl.keys) studio.line(`KU ${k & 255} ${k >> 8}`);
    pl.keys.clear();
    for (let b = 0; b < 5; b++) if (pl.b & (1 << b)) studio.line(`MB ${b} 0`);
    pl.b = 0;
    if (pl.pad) { studio.line(`PD ${pl.pad - 1} 0 0 0 0 0 0 0`); pl.g = ''; }
  }
  function hostRemove(id, why, quiet = false) {
    const pl = H.players.get(id); if (!pl) return;
    hostRelease(pl);
    if (pl.pad) studio?.line(`PX ${pl.pad - 1}`);
    H.players.delete(id);
    studio?.log(`${pl.name} stopped playing (${why})`);
    sendRel({ t: 'end', why }, id);
    if (!quiet) hostPublish();
  }
  function hostAllow(id, want) {
    if (!H.target) { toast('Choose what players will control first (the window or screen you are streaming).'); return; }
    const rq = H.reqs.get(id); H.reqs.delete(id);
    const name = rq?.name || idName(id);
    if (!room()?.remoteParticipants.has(id)) { hostPublish(); return; }
    const used = new Set([...H.players.values()].map((p) => p.pad));
    let pad = 0;
    if (want.pad && H.vigem) for (let s = 1; s <= H.max; s++) if (!used.has(s)) { pad = s; break; }
    let kbm = !!want.kbm;
    if (kbm) for (const [oid, o] of [...H.players]) if (o.kbm && oid !== id) { hostRelease(o); o.kbm = false; if (o.pad) sendRel({ t: 'ok', kbm: false, pad: o.pad }, oid); else hostRemove(oid, 'the keyboard went to someone else', true); } // the keyboard moves to the newest player
    if (!kbm && !pad) { sendRel({ t: 'no', why: 'Nothing was available to give you.' }, id); hostPublish(); return; }
    const old = H.players.get(id);
    H.players.set(id, old ? Object.assign(old, { kbm, pad: pad || old.pad }) : { name, kbm, pad, seq: -1, at: Date.now(), keys: new Set(), b: 0, mx: 0, my: 0, ax: -1, ay: -1, w: 0, h: 0, g: '', first: true });
    studio?.log(`${name} may play: ${[kbm && 'keyboard+mouse', pad && `gamepad ${pad}`].filter(Boolean).join(' + ')}`);
    sendRel({ t: 'ok', kbm, pad }, id);
    hostPublish();
  }
  function hostToggle(id, what) {
    const pl = H.players.get(id); if (!pl) return;
    if (what === 'kbm') {
      if (pl.kbm) { hostRelease(pl); pl.kbm = false; }
      else { for (const [oid, o] of [...H.players]) if (o.kbm) { hostRelease(o); o.kbm = false; if (o.pad) sendRel({ t: 'ok', kbm: false, pad: o.pad }, oid); else hostRemove(oid, 'the keyboard went to someone else', true); } pl.kbm = true; }
    } else if (pl.pad) { studio?.line(`PD ${pl.pad - 1} 0 0 0 0 0 0 0`); studio?.line(`PX ${pl.pad - 1}`); pl.pad = 0; }
    else if (H.vigem) { const used = new Set([...H.players.values()].map((p) => p.pad)); for (let s = 1; s <= H.max; s++) if (!used.has(s)) { pl.pad = s; break; } }
    if (!pl.kbm && !pl.pad) return hostRemove(id, 'the streamer took everything away');
    sendRel({ t: 'ok', kbm: pl.kbm, pad: pl.pad }, id);
    hostPublish();
  }
  function onReq(p, msg) {
    if (!isHost() || !H.accepting) { sendRel({ t: 'no', why: 'The streamer is not taking play requests right now.' }, p.identity); return; }
    if (H.reqs.size >= 12 && !H.reqs.has(p.identity)) { sendRel({ t: 'no', why: 'Too many people are waiting. Try again later.' }, p.identity); return; }
    const had = H.reqs.has(p.identity);
    const old = H.reqs.get(p.identity); // a repeat of the same request keeps what the streamer already ticked
    H.reqs.set(p.identity, { name: p.name || p.identity, kbm: old ? old.kbm : !!msg.kbm, pad: old ? old.pad : !!msg.pad, at: old ? old.at : Date.now() });
    if (had) return;
    toast(`${p.name || p.identity} wants to play. Open Game Hub to allow it.`, 'info'); studio?.log(`${p.name || p.identity} asked to play`);
    renderHost(); paintButton();
  }

  // One state message from a player -> the commands that change what the PC sees
  function onFrame(p, f) {
    const pl = H.players.get(p.identity); if (!pl || !studio) return;
    if (!num(f.s, 0, 2 ** 31)) return;
    if (f.s <= pl.seq && pl.seq - f.s < 100000) return; // late or repeated (the channel may reorder)
    pl.seq = f.s; pl.at = Date.now();
    if (num(f.p, 0, 1e12)) sendLossy({ t: 'pong', p: f.p }, p.identity);
    if (pl.kbm) {
      const keys = new Set((Array.isArray(f.k) ? f.k : []).slice(0, 24).filter((k) => Number.isInteger(k) && k > 0 && k < 512));
      for (const k of keys) if (!pl.keys.has(k)) studio.line(`KD ${k & 255} ${k >> 8}`);
      for (const k of pl.keys) if (!keys.has(k)) studio.line(`KU ${k & 255} ${k >> 8}`);
      pl.keys = keys;
      if (Array.isArray(f.a) && num(f.a[0], 0, 65535) && num(f.a[1], 0, 65535) && (f.a[0] !== pl.ax || f.a[1] !== pl.ay)) { pl.ax = f.a[0]; pl.ay = f.a[1]; studio.line(`MA ${f.a[0]} ${f.a[1]}`); }
      if (num(f.mx, -1e9, 1e9) && num(f.my, -1e9, 1e9)) {
        if (pl.first) { pl.mx = f.mx; pl.my = f.my; }
        let dx = f.mx - pl.mx, dy = f.my - pl.my; pl.mx = f.mx; pl.my = f.my;
        while ((dx || dy) && Math.abs(dx) + Math.abs(dy) < 20000) { const sx = Math.max(-2500, Math.min(2500, dx)), sy = Math.max(-2500, Math.min(2500, dy)); studio.line(`MR ${sx} ${sy}`); dx -= sx; dy -= sy; }
      }
      const b = Number.isInteger(f.b) ? f.b & 31 : 0;
      for (let i = 0; i < 5; i++) if ((b ^ pl.b) & (1 << i)) studio.line(`MB ${i} ${b & (1 << i) ? 1 : 0}`);
      pl.b = b;
      for (const [key, line] of [['w', 'MW'], ['h', 'MH']]) {
        if (!num(f[key], -1e9, 1e9)) continue;
        if (pl.first) pl[key] = f[key];
        const d = Math.max(-2400, Math.min(2400, f[key] - pl[key])); pl[key] = f[key];
        if (d) studio.line(`${line} ${d}`);
      }
    }
    if (pl.pad) {
      const g = Array.isArray(f.g) && f.g.length === 7 && f.g[0] === (f.g[0] | 0) && num(f.g[1], 0, 255) && num(f.g[2], 0, 255) && f.g.slice(3).every((v) => num(v, -32768, 32767)) ? f.g : [0, 0, 0, 0, 0, 0, 0];
      const s = g.join(' ');
      if (s !== pl.g) { pl.g = s; studio.line(`PD ${pl.pad - 1} ${g[0] & 0xF3FF} ${g.slice(1).join(' ')}`); }
    }
    pl.first = false;
  }
  setInterval(() => { // somebody who went quiet (closed the tab, lost the connection) must not keep keys pressed on this PC
    const now = Date.now();
    for (const [id, pl] of H.players) {
      if (now - pl.at > 30000) hostRemove(id, 'connection lost');
      else if (now - pl.at > 1500 && (pl.keys.size || pl.b || pl.g)) { hostRelease(pl); pl.first = true; }
    }
    for (const [id, r] of H.reqs) if (now - r.at > 120000 || !room()?.remoteParticipants.has(id)) { H.reqs.delete(id); renderHost(); paintButton(); }
  }, 500);
  function wireEvents() {
    studio.onEvent((m) => {
      if (m.type === 'panic') { stopAll(`the streamer stopped everything (${m.why})`); toast('All players were stopped.', 'info'); }
      else if (m.type === 'fg') { H.fg = m.v; renderHost(); }
      else if (m.type === 'fb') { for (const [id, pl] of H.players) if (pl.pad === m.slot + 1) sendLossy({ t: 'fb', a: m.big, b: m.small }, id); }
      else if (m.type === 'error') toast(`Input helper: ${m.text}`);
      else if (m.type === 'helper-exit') { H.started = false; if (H.players.size || H.accepting) { stopAll('the input helper stopped'); toast('The input helper stopped, so all players were stopped.'); } }
    });
  }

  // =====================================================================================================================
  // VIEWER SIDE
  // =====================================================================================================================
  // A phone or tablet has no keyboard, mouse or gamepad: it gets an on-screen controller (touchpad.js) that makes the same gamepad numbers.
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const V = {
    state: 'idle', play: null, host: null, want: { kbm: !coarse, pad: coarse }, touchOn: store.get('sanwes.gh.touch') != null ? store.get('sanwes.gh.touch') === '1' : coarse, armed: false, mode: store.get('sanwes.gh.mouse') === 'rel' ? 'rel' : 'abs',
    lat: LAT[store.get('sanwes.gh.lat')] != null ? store.get('sanwes.gh.lat') : 'lowest', stats: false,
    keys: new Set(), b: 0, mx: 0, my: 0, ax: null, ay: null, w: 0, h: 0, g: null, seq: 0, lastSig: '', lastPing: 0, rtt: null, flushT: 0, timers: [], rum: null, sample: null, text: '',
  };
  const tp = createTouchPad({
    onChange: () => { if (playing()) flush(); },
    onStop: () => { sendRel({ t: 'quit' }, V.host); stopPlaying('You stopped playing.'); },
    getStats: () => V.text,
  });
  function syncTouch() { // show the on-screen controller while this person may use a gamepad and wants it
    const want = playing() && !!V.play.pad && V.touchOn;
    if (want && !tp.shown && !document.fullscreenElement) toast('Controller ready. Tap the top-left button for full screen.', 'info');
    if (want) tp.show(); else { tp.hide(); tp.exitFullscreen(); }
  }
  const hostAttr = () => { try { return JSON.parse(streamer()?.attributes?.rp || 'null'); } catch { return null; } };
  const playing = () => V.state === 'playing' && !!V.play;

  function contentRect(v) { // where the picture really is inside the <video> (it is letterboxed)
    const r = v.getBoundingClientRect(), vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return r;
    const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  }
  const stageTile = () => document.querySelector('#stage .tile.screen');
  const tileOf = (target) => target?.closest?.('.tile.screen');

  function frame(force) {
    const f = { k: [...V.keys], b: V.b, mx: V.mx, my: V.my, w: V.w, h: V.h };
    if (V.ax != null) f.a = [V.ax, V.ay];
    if (V.play?.pad) { if (tp.active) f.g = tp.state(); else { const gp = [...(navigator.getGamepads?.() ?? [])].find((x) => x && x.connected); if (gp) f.g = readPad(gp); } }
    const sig = JSON.stringify(f);
    const now = performance.now();
    if (!force && sig === V.lastSig) return null;
    V.lastSig = sig; f.s = ++V.seq;
    if (now - V.lastPing > 400) { f.p = Math.round(now); V.lastPing = now; }
    return f;
  }
  function flush(force = false) {
    if (V.flushT) { clearTimeout(V.flushT); V.flushT = 0; }
    if (!playing() || !V.host) return;
    const f = frame(force); if (f) sendLossy(f, V.host);
  }
  const queueFlush = () => { if (!V.flushT) V.flushT = setTimeout(() => { V.flushT = 0; flush(); }, 0); };
  function letGo() { V.keys.clear(); V.b = 0; if (document.pointerLockElement) document.exitPointerLock?.(); flush(true); }

  // ---- events (installed while playing)
  const MB = { 0: 0, 2: 1, 1: 2, 3: 3, 4: 4 };
  function onKey(e) {
    if (!playing() || !V.play.kbm || !V.armed) return;
    const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = KEYS[e.code]; if (k == null) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'keydown') { if (e.repeat) return; V.keys.add(k); } else V.keys.delete(k);
    flush();
  }
  function onDown(e) {
    if (!playing()) return;
    if (e.target?.closest?.('.tp-root')) return; // the on-screen controller handles its own touches
    const tile = tileOf(e.target);
    if (!tile || e.target.closest('button')) { if (V.armed) { V.armed = false; letGo(); paintBar(); } return; }
    if (!V.armed) { V.armed = true; paintBar(); lockKeys(); }
    if (!V.play.kbm) return;
    e.preventDefault();
    const bit = MB[e.button]; if (bit == null) return;
    V.b |= 1 << bit; setAbs(e); flush();
    if (V.mode === 'rel' && document.pointerLockElement !== tile) { try { const r = tile.requestPointerLock({ unadjustedMovement: true }); r?.catch?.(() => tile.requestPointerLock()); } catch { /* not allowed */ } }
  }
  function onUp(e) {
    if (!playing() || !V.play.kbm) return;
    const bit = MB[e.button]; if (bit == null || !(V.b & (1 << bit))) return;
    V.b &= ~(1 << bit); flush(); if (V.armed) e.preventDefault();
  }
  function setAbs(e) {
    const v = stageTile()?.querySelector('video'); if (!v || V.mode !== 'abs') { V.ax = null; return; }
    const r = contentRect(v);
    V.ax = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 65535); V.ay = Math.round(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 65535);
  }
  function onMove(e) {
    if (!playing() || !V.play.kbm || !V.armed) return;
    if (document.pointerLockElement) { // game mode: only the movement counts
      const list = e.getCoalescedEvents?.() ?? []; const evs = list.length ? list : [e];
      for (const c of evs) { V.mx += c.movementX || 0; V.my += c.movementY || 0; }
      queueFlush();
    } else if (V.mode === 'abs' && tileOf(e.target)) { setAbs(e); queueFlush(); }
  }
  function onWheel(e) {
    if (!playing() || !V.play.kbm || !V.armed || !tileOf(e.target)) return;
    e.preventDefault();
    const unit = e.deltaMode === 0 ? e.deltaY / 100 : e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY;
    const notches = Math.max(-5, Math.min(5, unit)); V.w -= Math.round(notches * 120);
    const hx = e.deltaMode === 0 ? e.deltaX / 100 : e.deltaX; if (hx) V.h += Math.round(Math.max(-5, Math.min(5, hx)) * 120);
    flush();
  }
  const noMenu = (e) => { if (playing() && tileOf(e.target)) e.preventDefault(); };
  const noDbl = (e) => { if (playing() && tileOf(e.target)) { e.stopImmediatePropagation(); e.preventDefault(); } };
  function lockKeys() { try { if (document.fullscreenElement) navigator.keyboard?.lock?.(['Escape', 'Tab', 'AltLeft', 'AltRight', 'KeyW', 'F11']); } catch { /* optional */ } }
  function onBlur() { if (playing()) { V.armed = false; tp.releaseAll(); letGo(); paintBar(); } }
  function onLock() { paintBar(); }
  function onVis() { if (document.hidden) onBlur(); }

  function startPlaying(play) {
    V.play = play; V.state = 'playing'; V.host = streamer()?.identity ?? null; V.armed = false; V.keys.clear(); V.b = 0; V.seq = 0; V.lastSig = '';
    if (!V.listening) {
      V.listening = true;
      addEventListener('keydown', onKey, true); addEventListener('keyup', onKey, true);
      addEventListener('pointerdown', onDown, true); addEventListener('pointerup', onUp, true); addEventListener('pointermove', onMove, true);
      addEventListener('wheel', onWheel, { capture: true, passive: false }); addEventListener('contextmenu', noMenu, true); addEventListener('dblclick', noDbl, true);
      addEventListener('blur', onBlur); document.addEventListener('visibilitychange', onVis); document.addEventListener('pointerlockchange', onLock);
    }
    if (play.pad) V.timers.push(setInterval(() => flush(), 8)); // gamepad: sent when it changes
    V.timers.push(setInterval(() => flush(true), 100)); // heartbeat: also tells the streamer's PC we are still here
    V.timers.push(setInterval(statsTick, 1000));
    paintBar(); paintPanel(); paintButton(); syncTouch();
  }
  function stopPlaying(msg) {
    if (V.state === 'playing') { letGo(); }
    V.timers.forEach(clearInterval); V.timers = [];
    if (V.listening) {
      V.listening = false;
      removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKey, true);
      removeEventListener('pointerdown', onDown, true); removeEventListener('pointerup', onUp, true); removeEventListener('pointermove', onMove, true);
      removeEventListener('wheel', onWheel, true); removeEventListener('contextmenu', noMenu, true); removeEventListener('dblclick', noDbl, true);
      removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', onVis); document.removeEventListener('pointerlockchange', onLock);
    }
    try { navigator.keyboard?.unlock?.(); } catch { /* optional */ }
    rumbleStop();
    V.state = 'idle'; V.play = null; V.armed = false; V.rtt = null;
    tp.hide(); tp.exitFullscreen();
    if (msg) toast(msg, 'info');
    paintBar(); paintPanel(); paintButton();
  }

  // ---- rumble from the game, played on the player's own pad
  function rumble(big, small) {
    if (tp.active) { try { navigator.vibrate?.(big || small ? Math.min(300, 40 + Math.round((big + small) / 2)) : 0); } catch { /* not supported */ } return; }
    const gp = [...(navigator.getGamepads?.() ?? [])].find((x) => x && x.connected);
    const act = gp?.vibrationActuator; if (!act) return;
    clearInterval(V.rum); V.rum = null;
    if (!big && !small) { act.reset?.(); return; }
    const go = () => act.playEffect('dual-rumble', { startDelay: 0, duration: 120, weakMagnitude: small / 255, strongMagnitude: big / 255 }).catch(() => {});
    go(); V.rum = setInterval(go, 100);
  }
  const rumbleStop = () => { clearInterval(V.rum); V.rum = null; try { [...(navigator.getGamepads?.() ?? [])].find((x) => x?.connected)?.vibrationActuator?.reset?.(); } catch { /* none */ } };

  // ---- delay tuning of the incoming picture and sound, and the numbers shown to the player
  function applyReceivers() {
    const sp = streamer(); if (!sp) return;
    const ms = LAT[V.lat];
    for (const src of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
      const rx = sp.getTrackPublication(src)?.track?.receiver; if (!rx) continue;
      try { if ('jitterBufferTarget' in rx) rx.jitterBufferTarget = ms; } catch { /* older browser */ }
      try { if ('playoutDelayHint' in rx) rx.playoutDelayHint = ms / 1000; } catch { /* older browser */ }
    }
  }
  async function statsTick() {
    applyReceivers();
    const sp = streamer(); const rx = sp?.getTrackPublication(Track.Source.ScreenShare)?.track?.receiver; if (!rx) { V.text = ''; paintBar(); return; }
    let rep; try { rep = await rx.getStats(); } catch { return; }
    let inb = null, pair = null; const cands = new Map(), codecs = new Map(); let transport = null;
    rep.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s;
      else if (s.type === 'candidate-pair') { if (s.nominated || s.state === 'succeeded') pair = (!pair || s.nominated) ? s : pair; }
      else if (s.type === 'local-candidate') cands.set(s.id, s);
      else if (s.type === 'codec') codecs.set(s.id, s);
      else if (s.type === 'transport') transport = s;
    });
    if (transport?.selectedCandidatePairId) rep.forEach((s) => { if (s.id === transport.selectedCandidatePairId) pair = s; });
    if (!inb) return;
    const now = performance.now(), prev = V.sample; V.sample = { t: now, bytes: inb.bytesReceived, frames: inb.framesDecoded, lost: inb.packetsLost, recv: inb.packetsReceived, jb: inb.jitterBufferDelay, jbn: inb.jitterBufferEmittedCount };
    const lc = pair ? cands.get(pair.localCandidateId) : null;
    const parts = [];
    if (V.rtt != null) parts.push(`Input ${Math.round(V.rtt)} ms`);
    if (pair?.currentRoundTripTime != null) parts.push(`Network ${Math.round(pair.currentRoundTripTime * 1000)} ms`);
    if (prev) {
      const dt = (now - prev.t) / 1000;
      parts.push(`${Math.round((inb.framesDecoded - prev.frames) / dt)} fps`);
      parts.push(`${((inb.bytesReceived - prev.bytes) * 8 / dt / 1e6).toFixed(1)} Mbps`);
      const dl = inb.packetsLost - prev.lost, dr = inb.packetsReceived - prev.recv;
      parts.push(`loss ${dr + dl > 0 ? Math.max(0, (100 * dl) / (dr + dl)).toFixed(1) : '0.0'}%`);
      if (inb.jitterBufferEmittedCount > prev.jbn) parts.push(`buffer ${Math.round(((inb.jitterBufferDelay - prev.jb) / (inb.jitterBufferEmittedCount - prev.jbn)) * 1000)} ms`);
    }
    if (inb.frameWidth) parts.push(`${inb.frameWidth}x${inb.frameHeight}`);
    const codec = codecs.get(inb.codecId)?.mimeType?.replace('video/', '');
    if (codec) parts.push(codec);
    if (lc?.protocol) parts.push(lc.protocol.toUpperCase());
    V.text = parts.join(' · ');
    V.tcp = lc?.protocol === 'tcp';
    paintBar();
    const ps = panel?.querySelector('.gh-bar-stats'); if (ps) ps.textContent = V.text;
    tp.refreshMenu();
  }

  // ---- what the player sees
  let bar = null;
  function paintBar() {
    if (!playing()) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      bar = el('div', 'gh-bar'); bar.id = 'gh-bar';
      bar.append(el('div', 'gh-bar-top'), el('div', 'gh-bar-stats'), el('div', 'gh-bar-ctl'));
      document.body.append(bar);
    }
    bar.hidden = false;
    const [top, st, ctl] = bar.children;
    const got = [V.play.kbm && 'keyboard & mouse', V.play.pad && `gamepad ${V.play.pad}`].filter(Boolean).join(' + ');
    top.textContent = '';
    top.append(el('b', '', '\u{1F3AE} You can play'), document.createTextNode(` · ${got} · `), el('span', V.armed ? 'gh-on' : 'gh-off', V.armed ? (document.pointerLockElement ? 'mouse captured (Esc gives it back)' : 'keys are going to the game') : V.play.kbm ? 'click the picture to start' : 'gamepad is live'));
    st.textContent = V.text || 'measuring…'; st.classList.toggle('bad', !!V.tcp);
    if (V.tcp) st.textContent += ' · this connection uses TCP, so expect lag';
    if (!ctl.dataset.built) {
      ctl.dataset.built = '1';
      const mouse = el('select'); mouse.id = 'gh-mouse'; mouse.title = 'Mouse mode';
      mouse.append(new Option('Mouse: pointer (menus, strategy)', 'abs'), new Option('Mouse: game (shooters, look around)', 'rel'));
      mouse.value = V.mode; mouse.onchange = () => { V.mode = mouse.value; store.set('sanwes.gh.mouse', V.mode); if (V.mode === 'abs' && document.pointerLockElement) document.exitPointerLock(); V.ax = null; };
      const lat = latSelect(); lat.id = 'gh-lat-bar';
      ctl.append(mouse, lat, btn('Stop playing', () => { sendRel({ t: 'quit' }, V.host); stopPlaying('You stopped playing.'); }, 'gh-stop'));
    }
    $('gh-mouse') && ($('gh-mouse').value = V.mode);
  }
  function latSelect() {
    const s = el('select'); s.title = 'How long the player may wait for late video. Lowest = least delay, may stutter on a weak network.';
    s.append(new Option('Delay: lowest', 'lowest'), new Option('Delay: low', 'low'), new Option('Delay: smooth', 'smooth'));
    s.value = V.lat; s.onchange = () => { V.lat = s.value; store.set('sanwes.gh.lat', V.lat); applyReceivers(); document.querySelectorAll('.gh-lat').forEach((x) => { x.value = V.lat; }); };
    s.classList.add('gh-lat'); return s;
  }

  // =====================================================================================================================
  // PANEL (host: requests and players. viewer: ask to play)
  // =====================================================================================================================
  let panel = null, open = false;
  function build() {
    panel = el('div', 'gh-card'); panel.id = 'gh-panel'; panel.hidden = true;
    const head = el('div', 'gh-head'); head.append(el('strong', '', '\u{1F3AE} Game Hub'), btn('×', () => togglePanel(false), 'icon-btn'));
    panel.append(head, el('div', 'gh-body'));
    document.body.append(panel);
  }
  function togglePanel(on) {
    if (!panel) build();
    open = on ?? !open; panel.hidden = !open;
    if (open) paintPanel();
    $('btn-play')?.setAttribute('aria-pressed', String(open));
  }
  const paintPanel = () => { if (!panel || panel.hidden) return; (isHost() ? renderHost : renderViewer)(); };
  const sec = (t) => el('div', 'gh-sec', t);
  const note = (t, cls = '') => el('p', `gh-note ${cls}`, t);
  function check(label, checked, onchange, disabled = false) {
    const l = el('label', 'gh-check'); const c = el('input'); c.type = 'checkbox'; c.checked = checked; c.disabled = disabled; c.onchange = () => onchange(c.checked);
    l.append(c, document.createTextNode(` ${label}`)); return l;
  }

  function targetRow() {
    const wrap = el('div', 'gh-target');
    wrap.append(el('div', 'gh-sec', 'Players control'));
    const s = el('select'); s.append(new Option('Choose what players control...', ''));
    const og1 = document.createElement('optgroup'); og1.label = 'Program window (safest)';
    for (const w of H.targets.windows) og1.append(new Option(w.title, `w:${w.hwnd}`));
    const og2 = document.createElement('optgroup'); og2.label = 'Whole screen (they can use everything on it)';
    for (const sc of H.targets.screens) og2.append(new Option(`Screen ${sc.index + 1} (${sc.width}x${sc.height})${sc.primary ? ' - main' : ''}`, `s:${sc.index}`));
    s.append(og1, og2);
    const cur = H.target ? (H.target.kind === 'window' ? `w:${H.target.hwnd}` : `s:${H.target.index}`) : '';
    if (cur && ![...s.options].some((o) => o.value === cur)) s.append(new Option(H.target.title || 'selected', cur)); // the window was closed since
    s.value = cur;
    s.onchange = () => {
      const v = s.value; if (!v) return pickTarget(null);
      const [k, id] = v.split(':');
      pickTarget(k === 'w' ? { kind: 'window', hwnd: id, title: H.targets.windows.find((w) => w.hwnd === id)?.title ?? '' } : { kind: 'screen', index: Number(id) });
    };
    const row = el('div', 'gh-acts'); row.append(s, btn('Refresh list', () => refreshTargets(false)));
    wrap.append(row);
    return wrap;
  }

  function renderHost() {
    if (!panel || panel.hidden) return;
    const body = panel.querySelector('.gh-body'); body.replaceChildren();
    probeAgent();
    if (!studio) {
      body.append(note(H.env === 'no'
        ? 'Viewers can watch this stream from any browser. To let them play on your PC with their keyboard, mouse or gamepad, open this room on the streaming computer itself at http://localhost:3000 (not through the public link), with the input helper built (desktop/input/build-input.bat).'
        : 'Checking this computer...'), note('Stream quality for games is chosen below.'), qualityRow());
      return;
    }
    const sw = el('label', 'gh-switch'); const c = el('input'); c.type = 'checkbox'; c.checked = H.accepting; c.setAttribute('role', 'switch');
    c.onchange = async () => { c.disabled = true; const ok = await setAccepting(c.checked); if (!ok) c.checked = !c.checked; c.disabled = false; };
    sw.append(el('span', '', 'Let viewers ask to play'), c); body.append(sw);
    const t = H.target;
    if (H.started) {
      body.append(targetRow());
      body.append(note(!t ? 'Nothing is controlled until you choose a window or screen above.'
        : t.kind === 'window' ? `Players control only the window "${t.title}"${H.lockWindow ? ', and only while it is in front' : ''}.`
          : 'Players control the whole screen. They could open anything on it. Choosing just the game window is safer.', !t || t.kind === 'screen' ? 'warn' : ''));
      if (t && t.kind === 'window' && H.lockWindow && !H.fg) body.append(note('The game window is not in front, so input is paused. Click the game to continue.', 'warn'));
      body.append(note(H.vigem ? 'Gamepads: ready (virtual Xbox 360 controllers).' : 'Gamepads: not available. Install the ViGEmBus driver to let viewers use gamepads. Keyboard and mouse work without it.', H.vigem ? '' : 'warn'));
    } else body.append(note('Turn the switch on to start. SanWe\'s will then be allowed to press keys for the viewers you accept.'));

    body.append(sec(`Requests (${H.reqs.size})`));
    if (!H.reqs.size) body.append(note('Nobody is waiting.'));
    for (const [id, r] of H.reqs) {
      const row = el('div', 'gh-row'); row.append(el('div', 'gh-name', r.name), el('div', 'gh-sub', `wants: ${[r.kbm && 'keyboard & mouse', r.pad && 'gamepad'].filter(Boolean).join(' + ') || 'to watch closely'}`));
      const acts = el('div', 'gh-acts');
      const kb = check('Keyboard & mouse', r.kbm, (v) => { r.kbm = v; }), pd = check('Gamepad', r.pad && !!H.vigem, (v) => { r.pad = v; }, !H.vigem);
      acts.append(kb, pd, btn('Allow', () => hostAllow(id, { kbm: r.kbm, pad: r.pad }), 'primary'), btn('Deny', () => { H.reqs.delete(id); sendRel({ t: 'no', why: 'The streamer said no.' }, id); renderHost(); paintButton(); }));
      row.append(acts); body.append(row);
    }
    body.append(sec(`Playing now (${H.players.size}/${H.max})`));
    if (!H.players.size) body.append(note('Nobody is playing.'));
    for (const [id, pl] of H.players) {
      const row = el('div', 'gh-row');
      row.append(el('div', 'gh-name', pl.name), el('div', 'gh-sub', `${pl.kbm ? 'keyboard & mouse' : 'no keyboard'}${pl.pad ? ` · gamepad ${pl.pad}` : ''}${Date.now() - pl.at > 1500 ? ' · not heard for a moment' : ''}`));
      const acts = el('div', 'gh-acts');
      acts.append(btn(pl.kbm ? 'Take keyboard away' : 'Give keyboard', () => hostToggle(id, 'kbm')));
      if (H.vigem) acts.append(btn(pl.pad ? 'Take gamepad away' : 'Give gamepad', () => hostToggle(id, 'pad')));
      acts.append(btn('Remove', () => hostRemove(id, 'the streamer removed you'), 'gh-stop'));
      row.append(acts); body.append(row);
    }
    if (H.players.size) body.append(btn(`Stop everyone (${H.key})`, () => { stopAll('the streamer stopped everything', true); }, 'gh-stop gh-wide'));

    const det = el('details', 'gh-adv'); det.append(el('summary', '', 'Settings and safety'));
    const max = el('select'); for (let i = 1; i <= 4; i++) max.append(new Option(`${i} player${i > 1 ? 's' : ''} at most`, String(i))); max.value = String(H.max);
    max.onchange = () => { H.max = Number(max.value); hostPublish(); };
    det.append(max,
      check('Only control the game while its window is in front', H.lockWindow, async (v) => { H.lockWindow = v; await pickTarget(H.target); }),
      check('Allow Windows key, Alt+Tab, Alt+F4 (leave off unless you trust them)', H.allowSys, (v) => { H.allowSys = v; studio.allowSystemKeys(v); }),
      note("Gamepad rumble from the game is sent to the player's own gamepad."), qualityRow());
    body.append(det);
    if (H.enc) body.append(note(H.enc));
  }
  function qualityRow() {
    const wrap = el('label', 'gh-q', 'Stream quality '); const s = el('select');
    for (const [k, v] of Object.entries(GAME_PRESETS)) if (v.codec !== 'h265' || canSendHevc()) s.append(new Option(v.label, k));
    s.value = GAME_PRESETS[store.get('sanwes.gh.q')] ? store.get('sanwes.gh.q') : 'game';
    s.onchange = () => { store.set('sanwes.gh.q', s.value); toast('Saved. It applies the next time you press "Go live".', 'info'); };
    wrap.append(s); return wrap;
  }

  function renderViewer() {
    if (!panel || panel.hidden) return;
    const body = panel.querySelector('.gh-body'); body.replaceChildren();
    const sp = streamer(), a = hostAttr();
    if (!sp) { body.append(note('Waiting for the streamer to go live.')); return; }
    const s = V.state;
    body.append(note(`${sp.name || 'The streamer'} is streaming. Watching is free. If they allow it, you can play with your keyboard, mouse or gamepad.`));
    if (s === 'playing') {
      body.append(note(`You are playing: ${[V.play.kbm && 'keyboard & mouse', V.play.pad && `gamepad ${V.play.pad}`].filter(Boolean).join(' + ')}.`, 'ok'),
        note('Click the picture to start. Keys go to the game while you are clicked in; click anywhere else (chat, a button) to stop sending them. Game mouse mode: Esc gives your mouse back.'),
        V.play.pad ? check('Show the touch controller on this screen', V.touchOn, (v) => { V.touchOn = v; store.set('sanwes.gh.touch', v ? '1' : '0'); syncTouch(); }) : el('span'),
        btn('Stop playing', () => { sendRel({ t: 'quit' }, V.host); stopPlaying('You stopped playing.'); }, 'gh-stop gh-wide'));
    } else if (s === 'asking') {
      body.append(note(`Waiting for ${sp.name || 'the streamer'} to say yes…`), btn('Cancel request', () => cancelAsk(sp)));
    } else if (!a || !a.o) {
      body.append(note('The streamer is not taking play requests right now.', 'warn'));
    } else {
      const gps = [...(navigator.getGamepads?.() ?? [])].filter((x) => x && x.connected);
      body.append(check('Keyboard & mouse', V.want.kbm, (v) => { V.want.kbm = v; }),
        check(gps.length ? `Gamepad (${gps[0].id.replace(/\(.*$/, '').trim().slice(0, 40)})` : coarse ? 'Gamepad (the touch controller on your screen)' : 'Gamepad (press a button on yours so the browser sees it)', V.want.pad, (v) => { V.want.pad = v; }, !a.g),
        check('Show the touch controller on this screen', V.touchOn, (v) => { V.touchOn = v; store.set('sanwes.gh.touch', v ? '1' : '0'); syncTouch(); }),
        !a.g ? note('The streamer\'s PC cannot take gamepads.') : el('span'),
        btn('Ask to play', () => ask(sp), 'primary gh-wide'));
      if (a.p?.length) body.append(note(`Playing now: ${a.p.map((x) => idName(x[0])).join(', ')}`));
    }
    const lat = latSelect(); const w = el('label', 'gh-q', 'Delay '); w.append(lat);
    body.append(w, check('Show stream numbers while watching', V.stats, (v) => { V.stats = v; store.set('sanwes.gh.stats', v ? '1' : '0'); statsLoop(); }), el('div', 'gh-bar-stats', V.text || ''));
  }
  function cancelAsk(sp) {
    clearInterval(V.askT); sendRel({ t: 'cancel' }, sp.identity); V.state = 'idle';
    tp.endWait(); tp.exitFullscreen(); paintPanel(); paintButton();
  }
  function ask(sp) {
    if (!V.want.kbm && !V.want.pad) { toast('Tick what you want to use.'); return; }
    // On a phone with the touch controller: go full screen NOW (browsers only allow it right after a tap, and the streamer's "yes" comes later),
    // and show a clean waiting screen. When the streamer allows it, the controller simply appears on the same full-screen view.
    if (coarse && V.touchOn && V.want.pad) { tp.enterFullscreen(); tp.wait(`Waiting for ${sp.name || 'the streamer'} to let you play...`, () => cancelAsk(sp)); }
    V.state = 'asking'; paintPanel(); paintButton();
    // The first message from someone who has not published anything yet has to open the connection back to the server first; a request that is
    // not answered is simply sent again (the streamer treats a repeat as the same request), so one lost message cannot leave anyone waiting.
    clearInterval(V.askT); const t0 = Date.now(); let tries = 0;
    const send = () => {
      if (V.state !== 'asking') { clearInterval(V.askT); return; }
      if (Date.now() - t0 > 120000) { clearInterval(V.askT); V.state = 'idle'; tp.endWait(); tp.exitFullscreen(); toast(lastErr ? `Could not reach the streamer: ${lastErr}` : 'No answer yet. You can ask again.', 'info'); paintPanel(); paintButton(); return; }
      tries++; sendRel({ t: 'req', kbm: V.want.kbm, pad: V.want.pad }, sp.identity);
    };
    send(); V.askT = setInterval(send, 3000);
  }
  let statsT = 0;
  function statsLoop() { clearInterval(statsT); statsT = 0; V.stats = store.get('sanwes.gh.stats') === '1'; if (V.stats && !playing()) statsT = setInterval(statsTick, 1000); }

  // ---- the toolbar button
  function paintButton() {
    const b = $('btn-play'); if (!b) return;
    const show = isTheater() && !!room();
    b.hidden = !show; if (!show) return;
    $('play-lbl').textContent = isHost() ? 'Game Hub' : playing() ? 'Playing' : 'Play';
    const n = isHost() ? H.reqs.size : 0; const badge = $('play-badge'); badge.hidden = !n; badge.textContent = String(n);
  }
  $('btn-play') && ($('btn-play').onclick = () => togglePanel());

  // ---- hooks called by the page
  function onData(topic, payload, p) {
    if (!p) return;
    let m; try { m = JSON.parse(dec.decode(payload)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (topic === RPI_TOPIC) {
      if (isHost()) { if (m.s != null) onFrame(p, m); return; }
      if (p.identity !== streamer()?.identity) return; // only the streamer's word counts
      if (m.t === 'pong' && num(m.p, 0, 1e12)) { V.rtt = Math.max(0, performance.now() - m.p); }
      else if (m.t === 'fb' && playing() && num(m.a, 0, 255) && num(m.b, 0, 255)) rumble(m.a, m.b);
      return;
    }
    if (isHost()) {
      if (m.t === 'req') onReq(p, m);
      else if (m.t === 'cancel') { H.reqs.delete(p.identity); renderHost(); paintButton(); }
      else if (m.t === 'quit') hostRemove(p.identity, 'left');
      return;
    }
    if (p.identity !== streamer()?.identity) return;
    if (m.t === 'ok') {
      const play = { kbm: !!m.kbm, pad: Number(m.pad) || 0 };
      if (playing()) { if (V.play.kbm && !play.kbm) letGo(); V.play = play; paintBar(); paintPanel(); syncTouch(); toast('The streamer changed what you can use.', 'info'); }
      else {
        clearInterval(V.askT);
        if (play.kbm) toast('You can play now. Click the picture to start.', 'info'); else if (!(coarse && V.touchOn && play.pad)) toast('You can play now.', 'info');
        startPlaying(play);
      }
    }
    else if (m.t === 'no') { clearInterval(V.askT); V.state = 'idle'; tp.endWait(); tp.exitFullscreen(); toast(String(m.why || 'The streamer said no.').slice(0, 160), 'info'); paintPanel(); paintButton(); }
    else if (m.t === 'end') stopPlaying(`Your turn ended: ${String(m.why || '').slice(0, 120)}`);
  }
  function onAttributes(changed, p) {
    if (!('rp' in changed) || isHost()) return;
    if (p.identity !== streamer()?.identity) return;
    const a = hostAttr();
    if (playing() && !(a?.p ?? []).some((x) => x[0] === me()?.identity)) stopPlaying('You are not playing any more.');
    paintPanel(); paintButton();
  }
  function onLeft(p) {
    if (isHost()) { if (H.players.has(p.identity)) hostRemove(p.identity, 'left'); H.reqs.delete(p.identity); renderHost(); paintButton(); }
    else if (playing() && p.identity === V.host) stopPlaying('The stream ended.');
    else paintPanel();
  }
  async function onTracks() { // the streamer's picture changed: aim input at the new window/screen and tune the player
    if (isHost() && H.started) { await refreshTargets(true); hostEncoderInfo(); }
    else applyReceivers();
    paintButton(); paintPanel();
  }
  async function hostEncoderInfo() {
    try {
      const tr = me()?.getTrackPublication(Track.Source.ScreenShare)?.track; const rep = await tr?.sender?.getStats(); let out = null;
      rep?.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') out = s; });
      if (out) { H.enc = `Encoder: ${out.encoderImplementation || 'unknown'}${out.frameWidth ? ` · ${out.frameWidth}x${out.frameHeight}` : ''}${out.framesPerSecond ? ` · ${Math.round(out.framesPerSecond)} fps` : ''}${out.qualityLimitationReason && out.qualityLimitationReason !== 'none' ? ` · limited by ${out.qualityLimitationReason}` : ''}`; renderHost(); }
    } catch { /* not publishing */ }
  }
  setInterval(() => { if (isHost() && room() && me()?.isScreenShareEnabled && panel && !panel.hidden) hostEncoderInfo(); }, 3000);
  function reset() {
    window.__ghSdpTune = null;
    clearInterval(V.askT);
    if (playing()) stopPlaying();
    if (H.started || H.players.size) { stopAll('the room closed'); studio?.stop(); H.started = false; }
    H.accepting = false; H.reqs.clear(); H.enc = ''; H.target = null; H.targets = { windows: [], screens: [] };
    V.state = 'idle'; V.text = ''; if (panel) { panel.hidden = true; open = false; }
    paintButton();
  }
  statsLoop();

  return {
    onData, onAttributes, onLeft, onTracks, reset, paintButton,
    onRoomMeta: () => { if (isHost() && isTheater()) probeAgent(); paintButton(); paintPanel(); },
    state: () => ({ H, V, tp }), // for tests
  };
}
