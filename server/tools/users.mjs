// Account recovery for whoever runs this computer. Works on data/users.json directly: stop the server first (or restart it after).
//   node server/tools/users.mjs list
//   node server/tools/users.mjs reset <username> <new password>      (also signs that person out everywhere)
//   node server/tools/users.mjs admin <username>                    (make an account an administrator)
//   node server/tools/users.mjs delete <username>
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword, passwordProblem } from '../auth.js';
import { openVault } from '../vault.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const usersFile = path.join(dir, 'users.json'), sessionsFile = path.join(dir, 'sessions.json');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const vault = openVault(dir, { enabled: String(process.env.KEEP_PASSWORDS ?? 'on').toLowerCase() !== 'off' });
const db = read(usersFile, { users: [] }), [cmd, who, pw] = process.argv.slice(2);
const find = (n) => db.users.find((u) => u.usernameLower === String(n).toLowerCase() || u.emailLower === String(n).toLowerCase());
const save = () => fs.writeFileSync(usersFile, JSON.stringify(db, null, 1));
const signOut = (id) => { const s = read(sessionsFile, { sessions: {} }); for (const [k, v] of Object.entries(s.sessions)) if (v.uid === id) delete s.sessions[k]; fs.writeFileSync(sessionsFile, JSON.stringify(s, null, 1)); };

if (cmd === 'list') {
  for (const u of db.users) console.log(`${u.role === 'admin' ? 'ADMIN ' : 'member'}  ${u.username.padEnd(24)} ${u.email}  (name: ${u.displayName})`);
  console.log(`${db.users.length} account(s)`);
} else if (cmd === 'reset' && who && pw) {
  const u = find(who); if (!u) { console.error(`No account called "${who}".`); process.exit(1); }
  const problem = passwordProblem(pw, u.username); if (problem) { console.error(problem); process.exit(1); }
  const salt = randomBytes(16); u.salt = salt.toString('hex'); u.hash = (await hashPassword(pw, salt)).toString('hex'); save(); vault.set(u.id, u.username, pw); vault.flush(); signOut(u.id);
  console.log(`New password set for ${u.username}. Restart SanWe's so it reads the change.`);
} else if (cmd === 'admin' && who) {
  const u = find(who); if (!u) { console.error(`No account called "${who}".`); process.exit(1); }
  u.role = 'admin'; save(); console.log(`${u.username} is now an administrator. Restart SanWe's.`);
} else if (cmd === 'delete' && who) {
  const u = find(who); if (!u) { console.error(`No account called "${who}".`); process.exit(1); }
  db.users = db.users.filter((x) => x.id !== u.id); save(); vault.remove(u.id); vault.flush(); signOut(u.id); console.log(`Deleted ${u.username}. Restart SanWe's.`);
} else {
  console.log('Usage:\n  node server/tools/users.mjs list\n  node server/tools/users.mjs reset <username> <new password>\n  node server/tools/users.mjs admin <username>\n  node server/tools/users.mjs delete <username>');
}
