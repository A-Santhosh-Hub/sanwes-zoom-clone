// The password vault: a separate, encrypted record of the passwords people choose, so the administrator can tell somebody
// the password they forgot. It is OFF the normal sign-in path (sign-in still checks the scrambled hash in users.json) and it
// is only ever read by the administrator's own screens.
//   data/vault/passwords.vault   one encrypted entry per account (AES-256-GCM; the entry is bound to the account)
//   data/vault/vault.key         the key. Keep the two files apart if you copy or back up data\ (or leave the key out of the backup).
// Switch it off with KEEP_PASSWORDS=off in .env: nothing is recorded then, and what was recorded can be deleted by removing data\vault.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function openVault(dataDir, { enabled = true } = {}) {
  const dir = path.join(dataDir, 'vault'), file = path.join(dir, 'passwords.vault'), keyFile = path.join(dir, 'vault.key');
  const entries = new Map(); // uid -> { u, iv, tag, ct, at }
  let key = null, timer = null;
  if (enabled) {
    fs.mkdirSync(dir, { recursive: true });
    try { key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'); } catch { /* first use */ }
    if (!key || key.length !== 32) { key = randomBytes(32); fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 }); }
    try { for (const [uid, e] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).entries ?? {})) entries.set(uid, e); } catch { /* none yet */ }
  }
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(entries) }, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { console.error(`saving the password vault failed: ${e.message}`); } }, 150);
  };
  return {
    enabled,
    set(uid, username, password) {
      if (!enabled) return;
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(uid));
      const ct = Buffer.concat([c.update(String(password), 'utf8'), c.final()]);
      entries.set(uid, { u: username, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex'), at: Date.now() });
      save();
    },
    /** { password, at } or null (never recorded: the account was made before the vault existed) */
    get(uid) {
      const e = enabled && entries.get(uid); if (!e) return null;
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex'));
        d.setAAD(Buffer.from(uid)); d.setAuthTag(Buffer.from(e.tag, 'hex'));
        return { password: Buffer.concat([d.update(Buffer.from(e.ct, 'hex')), d.final()]).toString('utf8'), at: e.at };
      } catch { return null; }
    },
    remove(uid) { if (entries.delete(uid)) save(); },
    flush() { clearTimeout(timer); if (enabled) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(entries) }, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); } },
  };
}
