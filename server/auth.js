// Accounts for SanWe's, stored on this computer (no outside service).
//   - data/users.json     one record per account: username, email, display name, role, a salted scrypt hash of the password
//   - data/sessions.json  signed-in browsers: only a hash of the session token is stored, never the token itself
// The first account ever created is the administrator (the person running this computer). Passwords are never stored or logged.
// Modelled on how a desktop meeting client signs people in: a remembered-sign-in token instead of a stored password,
// "sign out" and "sign out of all devices", automatic sign-out after a period of inactivity, lockout after repeated failures.
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLimiter } from './limiter.js';
import { openVault } from './vault.js';

const scryptAsync = promisify(scrypt);
const COOKIE = 'sanwes_session';
const KEEP_DAYS = 30;          // "Keep me signed in": the sign-in lasts this long after the last visit
const IDLE_HOURS = 24;         // otherwise: signed out after this long without visiting, and when the browser closes
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou1', 'admin123', 'letmein123', 'welcome123', 'abc12345', 'sanwes123']);
const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

export async function hashPassword(password, salt) {
  return scryptAsync(String(password).normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
export function passwordProblem(pw, username = '') {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common. Pick another.';
  if (username && pw.toLowerCase().includes(username.toLowerCase()) && username.length >= 4) return 'The password must not contain your username.';
  return '';
}
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return ''; } };
const parseCookies = (h) => Object.fromEntries(String(h ?? '').split(/;\s*/).filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), safeDecode(p.slice(i + 1))]; }));
export const maskEmail = (e) => { const [u, d] = String(e).split('@'); return `${u.slice(0, Math.min(3, Math.max(1, u.length - 1)))}***@${d}`; };

export async function initAuth({ app, dataDir }) {
  const usersFile = path.join(dataDir, 'users.json'), sessionsFile = path.join(dataDir, 'sessions.json');
  // The administrator's password vault (separate encrypted file, see server/vault.js). KEEP_PASSWORDS=off turns it off.
  const vault = openVault(dataDir, { enabled: String(process.env.KEEP_PASSWORDS ?? 'on').toLowerCase() !== 'off' });
  const users = new Map();      // id -> user
  const sessions = new Map();   // sha256(token) -> { uid, created, last, keep, ua }
  const readJson = async (f, fallback) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; } };
  for (const u of (await readJson(usersFile, { users: [] })).users ?? []) users.set(u.id, u);
  for (const [k, s] of Object.entries((await readJson(sessionsFile, { sessions: {} })).sessions ?? {})) sessions.set(k, s);

  const timers = {};
  const writeLater = (key, file, make) => { clearTimeout(timers[key]); timers[key] = setTimeout(async () => { try { const tmp = `${file}.tmp`; await fs.writeFile(tmp, JSON.stringify(make(), null, 1)); await fs.rename(tmp, file); } catch (e) { console.error(`saving ${path.basename(file)} failed: ${e.message}`); } }, 250); };
  const saveUsers = () => writeLater('u', usersFile, () => ({ users: [...users.values()] }));
  const saveSessions = () => writeLater('s', sessionsFile, () => ({ sessions: Object.fromEntries(sessions) }));
  const byName = (n) => [...users.values()].find((u) => u.usernameLower === String(n).toLowerCase());
  const byEmail = (e) => [...users.values()].find((u) => u.emailLower === String(e).toLowerCase());

  const signupLimiter = createLimiter({ windowMs: 60 * 60_000, max: Number(process.env.SIGNUP_RATE_MAX) || 10 }); // new accounts per hour per address
  const ipFails = createLimiter({ windowMs: 10 * 60_000, max: 12 });
  const idFails = createLimiter({ windowMs: 10 * 60_000, max: 5 });
  const dummy = { salt: randomBytes(16), hash: await hashPassword('not-a-real-password-1', randomBytes(16)) };

  const view = (u, { full = true } = {}) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, createdAt: u.createdAt, ...(full ? { email: u.email, lastLoginAt: u.lastLoginAt ?? null } : {}) });

  // ------------------------------------------------------------ sessions
  function ttlFor(s) { return s.keep ? KEEP_DAYS * 86400_000 : IDLE_HOURS * 3600_000; }
  function sessionOf(req) {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok || !/^[\w-]{40,64}$/.test(tok)) return null;
    const key = sha(tok), s = sessions.get(key);
    if (!s) return null;
    const now = Date.now();
    if (now - s.last > ttlFor(s) || !users.has(s.uid)) { sessions.delete(key); saveSessions(); return null; }
    if (now - s.last > 5 * 60_000) { s.last = now; saveSessions(); } // sliding expiry, written at most every few minutes
    return { key, s, user: users.get(s.uid) };
  }
  function startSession(req, res, user, keep) {
    const tok = randomBytes(32).toString('base64url');
    sessions.set(sha(tok), { uid: user.id, created: Date.now(), last: Date.now(), keep: !!keep, ua: String(req.headers['user-agent'] ?? '').slice(0, 120) });
    saveSessions();
    const parts = [`${COOKIE}=${tok}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (keep) parts.push(`Max-Age=${KEEP_DAYS * 86400}`);
    if (req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }
  function clearCookie(req, res) { res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`); }
  function dropSessions(uid, exceptKey) { for (const [k, s] of sessions) if (s.uid === uid && k !== exceptKey) sessions.delete(k); saveSessions(); }
  setInterval(() => { const now = Date.now(); let n = 0; for (const [k, s] of sessions) if (now - s.last > ttlFor(s)) { sessions.delete(k); n++; } if (n) saveSessions(); }, 3600_000).unref();

  // Every state-changing request must come from this site itself.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    if (origin) { try { const h = new URL(origin).host; if (h !== req.get('host') && h !== req.get('x-forwarded-host')) return res.status(403).json({ error: 'Cross-site request refused.' }); } catch { return res.status(403).json({ error: 'Bad origin.' }); } }
    next();
  });

  const need = (req, res, { admin = false } = {}) => {
    const ss = sessionOf(req);
    if (!ss) { res.status(401).json({ error: 'Please sign in.', auth: true }); return null; }
    if (admin && ss.user.role !== 'admin') { res.status(403).json({ error: 'Only the administrator can do that.' }); return null; }
    return ss.user;
  };

  // ------------------------------------------------------------ routes
  app.get('/api/auth/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ss = sessionOf(req);
    if (!ss) return res.status(401).json({ error: 'Not signed in.', auth: true, needsSetup: users.size === 0 });
    res.json({ user: view(ss.user), emailMasked: maskEmail(ss.user.email), devices: [...sessions.values()].filter((s) => s.uid === ss.user.id).length });
  });

  app.post('/api/auth/signup', async (req, res) => {
    if (!signupLimiter.hit(req.ip).ok) return res.status(429).json({ error: 'Too many new accounts from here. Try again later.' });
    const b = req.body ?? {};
    const username = String(b.username ?? '').trim(), email = String(b.email ?? '').trim();
    const fail = (field, error) => res.status(400).json({ error, field });
    if (!USERNAME.test(username)) return fail('username', 'Username: 3 to 24 letters, numbers, dots, dashes or underscores, starting with a letter or number.');
    if (byName(username)) return fail('username', 'That username is taken. Pick another.');
    if (!EMAIL.test(email) || email.length > 120) return fail('email', 'Enter a valid email address.');
    if (String(b.email2 ?? '').trim().toLowerCase() !== email.toLowerCase()) return fail('email2', 'The two email addresses do not match.');
    if (byEmail(email)) return fail('email', 'An account with this email already exists. Sign in instead.');
    const pw = typeof b.password === 'string' ? b.password : '';
    const problem = passwordProblem(pw, username);
    if (problem) return fail('password', problem);
    if (pw !== b.password2) return fail('password2', 'The two passwords do not match.');
    const displayName = String(b.displayName ?? '').trim().replace(/[^\w .\-]/g, '').slice(0, 32) || username;
    const salt = randomBytes(16);
    const u = { id: randomUUID(), username, usernameLower: username.toLowerCase(), email, emailLower: email.toLowerCase(), displayName,
      role: users.size === 0 ? 'admin' : 'user', salt: hex(salt), hash: hex(await hashPassword(pw, salt)), createdAt: Date.now(), lastLoginAt: Date.now() };
    users.set(u.id, u); saveUsers(); vault.set(u.id, u.username, pw);
    startSession(req, res, u, b.keep !== false);
    res.json({ user: view(u), first: u.role === 'admin' });
  });

  app.post('/api/auth/login', async (req, res) => {
    const id = String(req.body?.identifier ?? '').trim().slice(0, 120), pw = typeof req.body?.password === 'string' ? req.body.password : '';
    const lock = Math.max(ipFails.blocked(req.ip), idFails.blocked(id.toLowerCase()));
    if (lock) return res.set('Retry-After', String(lock)).status(429).json({ error: `Too many sign-in attempts. Try again in ${Math.ceil(lock / 60)} min.` });
    if (!id || !pw) return res.status(400).json({ error: 'Enter your username (or email) and password.' });
    const u = id.includes('@') ? byEmail(id) : byName(id);
    const salt = u ? Buffer.from(u.salt, 'hex') : dummy.salt, want = u ? Buffer.from(u.hash, 'hex') : dummy.hash; // same work for unknown names
    const got = await hashPassword(pw, salt);
    if (!u || !timingSafeEqual(got, want)) {
      ipFails.hit(req.ip); idFails.hit(id.toLowerCase());
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    ipFails.reset(req.ip); idFails.reset(id.toLowerCase());
    u.lastLoginAt = Date.now(); saveUsers();
    startSession(req, res, u, req.body?.keep === true);
    res.json({ user: view(u) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const ss = sessionOf(req);
    if (ss) { sessions.delete(ss.key); saveSessions(); }
    clearCookie(req, res); res.json({ ok: true });
  });
  app.post('/api/auth/logout-all', (req, res) => {
    const ss = sessionOf(req); if (!ss) return res.status(401).json({ error: 'Please sign in.', auth: true });
    dropSessions(ss.user.id); clearCookie(req, res); res.json({ ok: true });
  });

  app.post('/api/auth/profile', (req, res) => {
    const u = need(req, res); if (!u) return;
    const name = String(req.body?.displayName ?? '').trim().replace(/[^\w .\-]/g, '').slice(0, 32);
    if (!name) return res.status(400).json({ error: 'Enter a display name.' });
    u.displayName = name; saveUsers(); res.json({ user: view(u) });
  });

  app.post('/api/auth/password', async (req, res) => {
    const ss = sessionOf(req); if (!ss) return res.status(401).json({ error: 'Please sign in.', auth: true });
    const u = ss.user, b = req.body ?? {};
    const lock = idFails.blocked(`pw:${u.id}`);
    if (lock) return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(lock / 60)} min.` });
    if (!timingSafeEqual(await hashPassword(String(b.current ?? ''), Buffer.from(u.salt, 'hex')), Buffer.from(u.hash, 'hex'))) { idFails.hit(`pw:${u.id}`); return res.status(401).json({ error: 'Your current password is wrong.', field: 'current' }); }
    const problem = passwordProblem(b.next, u.username);
    if (problem) return res.status(400).json({ error: problem, field: 'next' });
    if (b.next !== b.next2) return res.status(400).json({ error: 'The two new passwords do not match.', field: 'next2' });
    const salt = randomBytes(16); u.salt = hex(salt); u.hash = hex(await hashPassword(b.next, salt)); saveUsers(); vault.set(u.id, u.username, b.next);
    dropSessions(u.id, ss.key); // every other device is signed out
    res.json({ ok: true });
  });

  app.post('/api/auth/delete', async (req, res) => {
    const ss = sessionOf(req); if (!ss) return res.status(401).json({ error: 'Please sign in.', auth: true });
    const u = ss.user;
    if (!timingSafeEqual(await hashPassword(String(req.body?.password ?? ''), Buffer.from(u.salt, 'hex')), Buffer.from(u.hash, 'hex'))) return res.status(401).json({ error: 'Wrong password.' });
    if (u.role === 'admin' && [...users.values()].filter((x) => x.role === 'admin').length === 1 && users.size > 1) return res.status(400).json({ error: 'You are the only administrator. Make someone else an administrator first.' });
    users.delete(u.id); saveUsers(); vault.remove(u.id); dropSessions(u.id); clearCookie(req, res); res.json({ ok: true });
  });

  // ------------------------------------------------------------ administrator
  app.get('/api/admin/users', (req, res) => {
    const a = need(req, res, { admin: true }); if (!a) return;
    const open = new Map(); for (const s of sessions.values()) open.set(s.uid, (open.get(s.uid) ?? 0) + 1);
    res.set('Cache-Control', 'no-store').json({ users: [...users.values()].sort((x, y) => x.createdAt - y.createdAt).map((u) => ({ ...view(u), devices: open.get(u.id) ?? 0, you: u.id === a.id })) });
  });
  app.post('/api/admin/reset', async (req, res) => {
    const a = need(req, res, { admin: true }); if (!a) return;
    const u = users.get(String(req.body?.id ?? '')); if (!u) return res.status(404).json({ error: 'No such account.' });
    const pw = String(req.body?.password ?? ''), problem = passwordProblem(pw, u.username);
    if (problem) return res.status(400).json({ error: problem });
    const salt = randomBytes(16); u.salt = hex(salt); u.hash = hex(await hashPassword(pw, salt)); saveUsers(); vault.set(u.id, u.username, pw); dropSessions(u.id);
    res.json({ ok: true });
  });
  app.post('/api/admin/delete', (req, res) => {
    const a = need(req, res, { admin: true }); if (!a) return;
    const u = users.get(String(req.body?.id ?? '')); if (!u) return res.status(404).json({ error: 'No such account.' });
    if (u.id === a.id) return res.status(400).json({ error: 'Use "Delete my account" for your own account.' });
    users.delete(u.id); saveUsers(); vault.remove(u.id); dropSessions(u.id); res.json({ ok: true });
  });
  // The password list: what each person chose, for the administrator to hand back to someone who forgot it.
  // Only an administrator can open it; every time it is opened, a line is added to data/logs/admin.log.
  const listLimiter = createLimiter({ windowMs: 60_000, max: 30 });
  const passwordRows = () => [...users.values()].sort((x, y) => x.createdAt - y.createdAt).map((u) => { const r = vault.get(u.id); return { id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role, password: r?.password ?? null, savedAt: r?.at ?? null }; });
  const auditAdmin = (a, what) => fs.mkdir(path.join(dataDir, 'logs'), { recursive: true }).then(() => fs.appendFile(path.join(dataDir, 'logs', 'admin.log'), `${new Date().toISOString()}  ${a.username}  ${what}\n`)).catch(() => {});
  app.get('/api/admin/passwords', (req, res) => {
    const a = need(req, res, { admin: true }); if (!a) return;
    if (!listLimiter.hit(req.ip).ok) return res.status(429).json({ error: 'Too many requests.' });
    auditAdmin(a, 'opened the password list');
    res.set('Cache-Control', 'no-store').json({ enabled: vault.enabled, rows: passwordRows() });
  });
  app.get('/api/admin/passwords.txt', (req, res) => {
    const a = need(req, res, { admin: true }); if (!a) return;
    if (!listLimiter.hit(req.ip).ok) return res.status(429).json({ error: 'Too many requests.' });
    auditAdmin(a, 'downloaded the password list');
    const rows = passwordRows();
    const lines = [`SanWe's password list  (${new Date().toLocaleString()})`, 'Keep this file private. Delete it when you have given people their passwords.', '', 'Username'.padEnd(26) + 'Password'.padEnd(30) + 'Name / email'];
    for (const r of rows) lines.push(r.username.padEnd(26) + (r.password ?? '(not saved: reset it in Accounts)').padEnd(30) + `${r.displayName} / ${r.email}`);
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="sanwes-passwords.txt"' }).send(`${lines.join('\r\n')}\r\n`);
  });
  app.post('/api/admin/role', (req, res) => {
    const a = need(req, res, { admin: true }); if (!a) return;
    const u = users.get(String(req.body?.id ?? '')); if (!u) return res.status(404).json({ error: 'No such account.' });
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    if (u.id === a.id && role !== 'admin') return res.status(400).json({ error: 'Ask another administrator to change your role.' });
    u.role = role; saveUsers(); res.json({ ok: true });
  });

  // ------------------------------------------------------------ directory (for choosing co-hosts when scheduling)
  // The administrator sees every account (username and name only, never emails). Everyone else can look up one exact username.
  app.get('/api/directory', (req, res) => {
    const u = need(req, res); if (!u) return;
    res.set('Cache-Control', 'no-store');
    if (u.role !== 'admin') return res.json({ canList: false, users: [] });
    res.json({ canList: true, users: [...users.values()].sort((x, y) => x.username.localeCompare(y.username, undefined, { sensitivity: 'base' })).map((x) => ({ id: x.id, username: x.username, displayName: x.displayName, role: x.role })) });
  });
  app.get('/api/directory/lookup', (req, res) => {
    const u = need(req, res); if (!u) return;
    const f = req.query.id ? users.get(String(req.query.id)) : byName(String(req.query.username ?? '').trim());
    res.set('Cache-Control', 'no-store').json(f ? { user: { id: f.id, username: f.username, displayName: f.displayName } } : { user: null });
  });

  return {
    /** The signed-in account, or null after answering 401. */
    requireUser: (req, res) => need(req, res),
    userOf: (req) => sessionOf(req)?.user ?? null,
    ownerHashFor: (uid) => sha(`sanwes-owner:user:${uid}`),
    /** Sign the browser in as this account (no password): only for the class window SanWe's opens itself on this computer. */
    startSessionFor: (req, res, uid, keep = false) => { const u = users.get(uid); if (!u) return false; startSession(req, res, u, keep); return true; },
    count: () => users.size,
    userById: (id) => { const u = users.get(id); return u ? view(u, { full: false }) : null; },
  };
}
