// Accounts in the browser: the sign-in / create-account screen, the account menu, the profile extras (change password,
// sign out of all devices, delete) and the administrator's list of accounts. The server (server/auth.js) does the real work.
import { $, store, paintAvatar } from './ui.js';

const post = async (path, body = {}) => {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error ?? `Request failed (${res.status})`), { status: res.status, field: j.field, auth: !!j.auth });
  return j;
};
const get = async (path) => {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error ?? `Request failed (${res.status})`), { status: res.status, ...j });
  return j;
};

export function initAccount({ onSignedIn, openSettings, openProfile, toast }) {
  let user = null, emailMasked = '';

  // ---------------------------------------------------------------- the sign-in / create-account screen
  const show = (which) => {
    const up = which === 'signup';
    $('signin-form').hidden = up; $('signup-form').hidden = !up;
    $('at-signin').setAttribute('aria-selected', String(!up)); $('at-signup').setAttribute('aria-selected', String(up));
    $('auth-notice').hidden = true;
    ($(up ? 'su-username' : 'si-id')).focus();
  };
  $('at-signin').onclick = () => show('signin'); $('go-signin').onclick = () => show('signin');
  $('at-signup').onclick = () => show('signup'); $('go-signup').onclick = () => show('signup');
  function showAuth({ needsSetup = false, notice = '' } = {}) {
    $('join').hidden = true; $('call').hidden = true; $('auth').hidden = false;
    $('su-first').hidden = !needsSetup;
    show(needsSetup ? 'signup' : 'signin');
    if (notice) { $('auth-notice').textContent = notice; $('auth-notice').hidden = false; }
  }
  for (const b of document.querySelectorAll('[data-eye]')) b.onclick = () => { const i = $(b.dataset.eye), on = i.type === 'password'; i.type = on ? 'text' : 'password'; b.textContent = on ? 'Hide' : 'Show'; b.setAttribute('aria-label', on ? 'Hide password' : 'Show password'); };

  const clearErrors = (form) => { for (const e of form.querySelectorAll('.err')) e.textContent = ''; for (const i of form.querySelectorAll('input')) i.removeAttribute('aria-invalid'); };
  const fieldErr = (form, field, msg, inputId) => {
    const slot = form.querySelector(`[data-err="${field}"]`);
    if (slot) slot.textContent = msg; if (inputId) $(inputId).setAttribute('aria-invalid', 'true');
  };

  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('si-err').textContent = '';
    const identifier = $('si-id').value.trim(), password = $('si-pw').value;
    if (!identifier || !password) { $('si-err').textContent = 'Enter your username (or email) and password.'; return; }
    $('si-go').disabled = true;
    try { const r = await post('/api/auth/login', { identifier, password, keep: $('si-keep').checked }); $('si-pw').value = ''; await enter(r.user); }
    catch (ex) { $('si-err').textContent = ex.message; $('si-pw').select(); }
    finally { $('si-go').disabled = false; }
  });

  // password strength: a rough guide next to the real rules
  $('su-pw').addEventListener('input', () => {
    const v = $('su-pw').value; let s = 0;
    if (v.length >= 8) s++; if (v.length >= 12) s++; if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++; if (/\d/.test(v)) s++; if (/[^\w\s]/.test(v)) s++;
    const m = $('su-meter'); m.style.width = `${v ? Math.max(12, s * 20) : 0}%`; m.style.background = s <= 2 ? '#e5484d' : s === 3 ? '#e6b450' : '#35c77f';
    $('su-pw-hint').textContent = !v ? 'At least 8 characters, with letters and a number.' : s <= 2 ? 'Weak: add length, numbers or capitals.' : s === 3 ? 'Fair.' : 'Strong.';
  });
  const PAIRS = [['su-pw2', 'su-pw', 'password2', 'The two passwords do not match.'], ['su-email2', 'su-email', 'email2', 'The two email addresses do not match.']];
  // An error line that disappears when you click away would move the button between mouse-down and mouse-up and swallow the click,
// so mismatches are cleared while typing, and only ever added on blur.
for (const [a, b, f, msg] of PAIRS) {
  const same = () => $(a).value.trim().toLowerCase() === $(b).value.trim().toLowerCase();
  const sync = () => { if (same()) { $('signup-form').querySelector(`[data-err="${f}"]`).textContent = ''; $(a).removeAttribute('aria-invalid'); } };
  $(a).addEventListener('input', sync); $(b).addEventListener('input', sync);
  $(a).addEventListener('blur', () => { if ($(a).value && !same()) fieldErr($('signup-form'), f, msg, a); });
}

  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = $('signup-form'); clearErrors(form); $('su-err').textContent = '';
    const b = { username: $('su-username').value.trim(), password: $('su-pw').value, password2: $('su-pw2').value, email: $('su-email').value.trim(), email2: $('su-email2').value.trim(), displayName: $('su-display').value.trim(), keep: true };
    const ids = { username: 'su-username', password: 'su-pw', password2: 'su-pw2', email: 'su-email', email2: 'su-email2' };
    // quick checks here; the server checks again
    if (b.password !== b.password2) { fieldErr(form, 'password2', 'The two passwords do not match.', 'su-pw2'); return; }
    if (b.email.toLowerCase() !== b.email2.toLowerCase()) { fieldErr(form, 'email2', 'The two email addresses do not match.', 'su-email2'); return; }
    $('su-go').disabled = true;
    try { const r = await post('/api/auth/signup', b); $('su-pw').value = $('su-pw2').value = ''; if (r.first) toast?.('Your account is the administrator account of this computer.', 'info'); await enter(r.user); }
    catch (ex) { if (ex.field && ids[ex.field]) { fieldErr(form, ex.field, ex.message, ids[ex.field]); $(ids[ex.field]).focus(); } else $('su-err').textContent = ex.message; }
    finally { $('su-go').disabled = false; }
  });

  // ---------------------------------------------------------------- signed in
  async function enter(u) {
    user = u;
    try { emailMasked = (await get('/api/auth/me')).emailMasked ?? ''; } catch { /* the menu just shows no email */ }
    $('auth').hidden = true; $('join').hidden = false;
    store.set('sanwes.name', u.displayName);
    onSignedIn(u);
  }
  async function boot() {
    try { const r = await get('/api/auth/me'); user = r.user; emailMasked = r.emailMasked ?? ''; $('auth').hidden = true; $('join').hidden = false; store.set('sanwes.name', user.displayName); onSignedIn(user); }
    catch (ex) { showAuth({ needsSetup: !!ex.needsSetup }); }
  }
  // any request answered "please sign in" (session ended, signed out elsewhere) lands here
  window.addEventListener('sanwes:signed-out', () => { if (!user) return; user = null; showAuth({ notice: 'You were signed out. Please sign in again.' }); });

  // ---------------------------------------------------------------- account menu
  const menu = $('acct-menu');
  function openMenu() {
    if (!user) return;
    paintAvatar($('am-avatar'), user.displayName, store.get('sanwes.pic'));
    $('am-name').textContent = user.displayName; $('am-email').textContent = emailMasked || user.email; $('am-role').textContent = user.role === 'admin' ? 'Administrator' : '';
    $('am-accounts').hidden = user.role !== 'admin';
    const r = $('btn-profile').getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = `${r.bottom + 8}px`; menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  }
  $('btn-profile').onclick = (e) => { e.stopPropagation(); if (menu.hidden) openMenu(); else menu.hidden = true; };
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('#acct-menu')) menu.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });
  $('am-profile').onclick = () => { menu.hidden = true; openProfile(); };
  $('am-settings2').onclick = () => { menu.hidden = true; openSettings('general'); };
  $('am-accounts').onclick = () => { menu.hidden = true; openAccounts(); };
  async function signOut() { try { await post('/api/auth/logout'); } catch { /* signed out anyway */ } location.reload(); }
  $('am-signout').onclick = signOut;

  // ---------------------------------------------------------------- profile extras
  $('p-pw').onclick = () => { $('profile-dialog').close(); $('pw-err').textContent = ''; $('pw-form').reset(); $('pw-dialog').showModal(); $('pw-cur').focus(); };
  $('pw-cancel').onclick = () => $('pw-dialog').close();
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('pw-err').textContent = '';
    try { await post('/api/auth/password', { current: $('pw-cur').value, next: $('pw-new').value, next2: $('pw-new2').value }); $('pw-dialog').close(); toast?.('Password changed. Other devices were signed out.', 'info'); }
    catch (ex) { $('pw-err').textContent = ex.message; }
  });
  $('p-outall').onclick = async () => { if (!confirm('Sign out of every device, including this one?')) return; try { await post('/api/auth/logout-all'); } catch { /* ignore */ } location.reload(); };
  $('p-delete').onclick = async () => {
    const pw = window.prompt('Delete your account? This cannot be undone. Type your password to confirm:');
    if (!pw) return;
    try { await post('/api/auth/delete', { password: pw }); location.reload(); } catch (ex) { alert(ex.message); }
  };

  // ---------------------------------------------------------------- administrator: every account on this computer
  async function openAccounts() {
    $('ac-err').textContent = ''; $('accounts-dialog').showModal();
    await paintAccounts();
  }
  async function paintAccounts() {
    let list = [];
    try { list = (await get('/api/admin/users')).users; } catch (ex) { $('ac-err').textContent = ex.message; return; }
    const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
    $('ac-body').replaceChildren(...list.map((u) => {
      const tr = document.createElement('tr');
      const td = (text) => { const c = document.createElement('td'); c.textContent = text; tr.append(c); return c; };
      td(u.username + (u.you ? ' (you)' : '')); td(u.displayName); td(u.email); td(u.role === 'admin' ? 'Administrator' : 'Member'); td(when(u.lastLoginAt));
      const act = document.createElement('td'); act.className = 'ac-act';
      const mk = (label, fn, cls = 'secondary') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; b.onclick = fn; act.append(b); };
      mk('Reset password', async () => { const pw = window.prompt(`New password for ${u.username} (8+ characters, letters and a number). Tell them in person; they can change it afterwards:`); if (!pw) return; try { await post('/api/admin/reset', { id: u.id, password: pw }); toast?.(`Password for ${u.username} was reset.`, 'info'); } catch (ex) { $('ac-err').textContent = ex.message; } });
      if (!u.you) {
        mk(u.role === 'admin' ? 'Remove admin' : 'Make admin', async () => { try { await post('/api/admin/role', { id: u.id, role: u.role === 'admin' ? 'user' : 'admin' }); await paintAccounts(); } catch (ex) { $('ac-err').textContent = ex.message; } });
        mk('Delete', async () => { if (!confirm(`Delete the account "${u.username}"? Their scheduled meetings stay but nobody can open them.`)) return; try { await post('/api/admin/delete', { id: u.id }); await paintAccounts(); } catch (ex) { $('ac-err').textContent = ex.message; } }, 'secondary danger-text');
      }
      tr.append(act); return tr;
    }));
  }
  $('ac-close').onclick = () => $('accounts-dialog').close();

  // the password list (administrator only): show a password for a few seconds, copy it, or download the whole list
  async function openPasswordList() {
    $('pl-err').textContent = ''; $('pl-body').replaceChildren(); $('pwlist-dialog').showModal();
    let r; try { r = await get('/api/admin/passwords'); } catch (ex) { $('pl-err').textContent = ex.message; return; }
    $('pl-download').hidden = !r.enabled;
    if (!r.enabled) { $('pl-note').textContent = 'Recording passwords is switched off on this computer (KEEP_PASSWORDS=off in .env).'; return; }
    $('pl-body').replaceChildren(...r.rows.map((u) => {
      const tr = document.createElement('tr');
      const td = (text) => { const c = document.createElement('td'); c.textContent = text; tr.append(c); return c; };
      td(u.username); td(u.displayName);
      const pw = document.createElement('td'); pw.className = 'pl-pw'; tr.append(pw);
      const act = document.createElement('td'); act.className = 'ac-act'; tr.append(act);
      const mk = (label, fn, cls = 'secondary') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; b.onclick = fn; act.append(b); };
      if (u.password === null) {
        pw.textContent = 'not saved'; pw.title = 'This account was made before passwords were recorded. Reset it to record a new one.'; pw.classList.add('dim');
        mk('Reset password', async () => { const p = window.prompt(`New password for ${u.username} (8+ characters, letters and a number):`); if (!p) return; try { await post('/api/admin/reset', { id: u.id, password: p }); await openPasswordList(); } catch (ex) { $('pl-err').textContent = ex.message; } });
      } else {
        pw.textContent = '••••••••';
        let t = 0;
        mk('Show', () => { pw.textContent = u.password; clearTimeout(t); t = setTimeout(() => { pw.textContent = '••••••••'; }, 10_000); });
        mk('Copy', async () => { try { await navigator.clipboard.writeText(u.password); toast?.(`Password of ${u.username} copied.`, 'info'); } catch { window.prompt('Copy this password:', u.password); } });
      }
      return tr;
    }));
  }
  $('ac-pwlist').onclick = openPasswordList;
  $('pl-close').onclick = () => { $('pl-body').replaceChildren(); $('pwlist-dialog').close(); };
  $('pwlist-dialog').addEventListener('close', () => $('pl-body').replaceChildren()); // nothing stays on the screen

  return { boot, me: () => user, emailMasked: () => emailMasked, signOut, showAuth, refreshUser: (u) => { user = { ...user, ...u }; } };
}
