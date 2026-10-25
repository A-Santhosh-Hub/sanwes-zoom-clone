// Classroom tools in the page: polls and quizzes, Q&A, files in chat, and the host's requests to one person
// (ask to unmute / start video, allow to talk). The data lives on the server (server/classroom.js); the page asks for it,
// and the server pings everyone through a data message (topic sanwes.class) when something changed.
export const CLASS_TOPIC = 'sanwes.class';
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const btn = (txt, fn, cls = 'secondary') => { const b = el('button', cls, txt); b.type = 'button'; b.onclick = fn; return b; };

export function initClassroom({ $, getRoom, getSession, toast, meeting, setChatOpen, addChat, onBo }) {
  const isMgr = () => meeting.isManager();
  async function call(path, body = {}) {
    const s = getSession(); if (!s) throw new Error('You are not in a meeting.');
    const r = await fetch(`/api/class/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: s.roomName, token: s.token, hostSecret: s.hostSecret || undefined, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
    return j;
  }
  const act = (fn) => fn().catch((e) => toast(e.message));
  const paneOpen = (name) => !$('chat').hidden && !$(`${name}-pane`).hidden;

  // ============================================================ polls
  let polls = [], pollV = 0, seen = new Set(), popupFor = null;
  async function refreshPolls(force = false) {
    if (!getSession()) return;
    try {
      const r = await call('poll/list', { since: force ? 0 : pollV });
      if (r.same) return;
      pollV = r.v; polls = r.polls ?? [];
      renderPolls(); maybePopup();
    } catch { /* the meeting may be ending */ }
  }
  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
  function bars(p, container) {
    p.options.forEach((o, i) => {
      const row = el('div', 'pbar');
      const head = el('div', 'pbar-head'); head.append(el('span', 'pbar-t', `${o}${(p.correct ?? []).includes(i) ? '  ✔' : ''}`), el('span', 'pbar-n', `${pct(p.counts[i], p.total)}% (${p.counts[i]})`));
      const fill = el('div', 'pbar-fill'); fill.style.width = `${pct(p.counts[i], p.total)}%`;
      if ((p.correct ?? []).includes(i)) fill.classList.add('good');
      row.append(head, el('div', 'pbar-track')); row.lastChild.append(fill);
      container.append(row);
    });
    container.append(el('div', 'muted small-note', `${p.total} ${p.total === 1 ? 'person' : 'people'} answered`));
  }
  function csv(p) {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const rows = [['Question', p.q], ['Answer', 'Votes', 'Percent', 'Correct']];
    p.options.forEach((o, i) => rows.push([o, p.counts[i], `${pct(p.counts[i], p.total)}%`, (p.correct ?? []).includes(i) ? 'yes' : '']));
    if (p.voters) { rows.push([], ['Who', 'Answer']); for (const v of p.voters) rows.push([v.name, v.choices.map((i) => p.options[i]).join('; ')]); }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([rows.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' })), download: 'poll-results.csv' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function hostCard(p) {
    const card = el('div', `pcard ${p.status}`);
    card.append(el('div', 'pq', p.q));
    card.append(el('div', 'pmeta', `${p.multi ? 'Multiple choice' : 'Single choice'}${p.correct.length ? ' · Quiz' : ''}${p.anonymous ? ' · Anonymous' : ''} · ${{ draft: 'Not launched', open: 'Open for answers', ended: p.shared ? 'Ended, results shared' : 'Ended' }[p.status]}`));
    if (p.status === 'draft') p.options.forEach((o) => card.append(el('div', 'popt', `• ${o}`))); else bars(p, card);
    const acts = el('div', 'pacts');
    if (p.status === 'draft') acts.append(btn('Launch', () => act(() => call('poll/launch', { id: p.id }).then(() => refreshPolls(true))), 'primary'));
    if (p.status === 'open') acts.append(btn('End poll', () => act(() => call('poll/end', { id: p.id }).then(() => refreshPolls(true))), 'primary'));
    if (p.status === 'ended') {
      acts.append(btn(p.shared ? 'Stop sharing results' : 'Share results', () => act(() => call(p.shared ? 'poll/unshare' : 'poll/share', { id: p.id }).then(() => refreshPolls(true))), 'primary'));
      acts.append(btn('Launch again', () => act(() => call('poll/launch', { id: p.id }).then(() => refreshPolls(true)))));
      acts.append(btn('Download', () => csv(p)));
    }
    if (p.status !== 'open') acts.append(btn('Delete', () => { if (confirm('Delete this poll?')) act(() => call('poll/delete', { id: p.id }).then(() => refreshPolls(true))); }, 'secondary danger-text'));
    card.append(acts);
    return card;
  }
  function voteForm(p, dlg = false) {
    const form = el('form', 'pvote');
    p.options.forEach((o, i) => {
      const l = el('label', 'check'); const i1 = document.createElement('input'); i1.type = p.multi ? 'checkbox' : 'radio'; i1.name = `pv-${p.id}${dlg ? '-d' : ''}`; i1.value = String(i); i1.checked = !!p.mine?.includes(i);
      l.append(i1, document.createTextNode(` ${o}`)); form.append(l);
    });
    const err = el('p', 'error'); const go = el('button', 'primary', p.mine ? 'Change my answer' : 'Submit'); go.type = 'submit';
    form.append(err, go);
    form.onsubmit = async (e) => {
      e.preventDefault(); err.textContent = '';
      const choices = [...form.querySelectorAll('input:checked')].map((i) => Number(i.value));
      try { await call('poll/vote', { id: p.id, choices }); toast('Your answer was sent.', 'info'); if (dlg) $('poll-vote').close(); await refreshPolls(true); } catch (ex) { err.textContent = ex.message; }
    };
    return form;
  }
  function memberCard(p) {
    const card = el('div', `pcard ${p.status}`);
    card.append(el('div', 'pq', p.q));
    if (p.status === 'open') { card.append(el('div', 'pmeta', p.multi ? 'Choose all that apply' : 'Choose one')); card.append(voteForm(p)); }
    else if (p.counts) { bars(p, card); if (p.mine) card.append(el('div', 'pmeta', `You answered: ${p.mine.map((i) => p.options[i]).join(', ')}`)); }
    return card;
  }
  function renderPolls() {
    const mgr = isMgr();
    $('poll-host-bar').hidden = !mgr;
    const list = mgr ? polls : polls.filter((p) => p.status === 'open' || (p.status === 'ended' && p.shared));
    const cards = list.slice().reverse().map(mgr ? hostCard : memberCard);
    $('poll-list').replaceChildren(...(cards.length ? cards : [el('p', 'muted', mgr ? 'No polls yet. Create one, then launch it.' : 'There is no poll right now. When the host launches one it appears here.')]));
  }
  function maybePopup() {
    if (isMgr()) return;
    const open = polls.find((p) => p.status === 'open' && !p.mine && !seen.has(p.id));
    if (!open) { if (popupFor && !polls.some((p) => p.id === popupFor && p.status === 'open')) { $('poll-vote').close(); popupFor = null; } return; }
    seen.add(open.id); popupFor = open.id;
    $('pv-q').textContent = open.q; $('pv-hint').textContent = open.multi ? 'Choose all that apply.' : 'Choose one answer.';
    const f = voteForm(open, true); $('pv-opts').replaceChildren(f); $('pv-err').textContent = '';
    $('poll-vote-form').onsubmit = (e) => { e.preventDefault(); f.requestSubmit(); };
    $('pv-later').onclick = () => $('poll-vote').close();
    if (!$('poll-vote').open) $('poll-vote').showModal();
  }

  // create-a-poll dialog
  let pnRows = [];
  function paintNew() {
    $('pn-opts').replaceChildren(...pnRows.map((r, i) => {
      const row = el('div', 'pn-row'); const t = document.createElement('input'); t.maxLength = 100; t.placeholder = `Answer ${i + 1}`; t.value = r.t; t.oninput = () => { r.t = t.value; };
      const c = document.createElement('input'); c.type = 'checkbox'; c.title = 'This is the correct answer (makes it a quiz)'; c.checked = r.ok; c.onchange = () => { r.ok = c.checked; };
      const x = btn('×', () => { if (pnRows.length > 2) { pnRows.splice(i, 1); paintNew(); } }, 'step-x');
      row.append(c, t, x); return row;
    }));
    $('pn-add').hidden = pnRows.length >= 10;
  }
  $('poll-new-btn').onclick = () => { pnRows = [{ t: '', ok: false }, { t: '', ok: false }]; $('pn-q').value = ''; $('pn-err').textContent = ''; $('pn-single').checked = true; $('pn-anon').checked = false; paintNew(); $('poll-new').showModal(); $('pn-q').focus(); };
  $('pn-add').onclick = () => { pnRows.push({ t: '', ok: false }); paintNew(); };
  $('pn-cancel').onclick = () => $('poll-new').close();
  $('poll-new-form').onsubmit = async (e) => {
    e.preventDefault();
    const options = pnRows.map((r) => r.t.trim()), keep = options.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
    try {
      await call('poll/create', { q: $('pn-q').value, options: keep.map((i) => options[i]), correct: keep.map((i, n) => (pnRows[i].ok ? n : -1)).filter((n) => n >= 0), multi: $('pn-multi').checked, anonymous: $('pn-anon').checked });
      $('poll-new').close(); await refreshPolls(true);
    } catch (ex) { $('pn-err').textContent = ex.message; }
  };

  // ============================================================ Q&A
  let questions = [], qaV = 0, qaOn = true, anonOk = true, filter = 'all', lastCount = 0, answering = null;
  async function refreshQa(force = false) {
    if (!getSession()) return;
    try {
      const r = await call('qa/list', { since: force ? 0 : qaV });
      if (r.same) return;
      qaV = r.v; qaOn = r.on; anonOk = r.anonymousAllowed;
      if (isMgr() && questions.length < r.questions.length && lastCount && !paneOpen('qa')) toast('New question in Q&A', 'info');
      questions = r.questions; lastCount = questions.length;
      renderQa(); paintMoreBadge();
    } catch { /* the meeting may be ending */ }
  }
  const shownQ = () => questions.filter((q) => ({ all: true, open: ['open', 'live'].includes(q.status), answered: q.status === 'answered', mine: q.mine })[filter]);
  function qCard(q) {
    const card = el('div', `qcard ${q.status}`);
    const head = el('div', 'qhead'); head.append(el('strong', '', q.who), el('span', 'time', ago(q.at)));
    if (q.status === 'live') head.append(el('span', 'qbadge live', 'Answering live'));
    if (q.status === 'answered') head.append(el('span', 'qbadge', 'Answered'));
    if (q.status === 'dismissed') head.append(el('span', 'qbadge dim', 'Dismissed'));
    card.append(head, el('div', 'qtext', q.text));
    for (const a of q.answers) card.append(el('div', 'qans', `${a.by}${a.private ? ' (private)' : ''}: ${a.text}`));
    const row = el('div', 'qacts');
    const up = btn(`▲ ${q.ups}`, () => act(() => call('qa/upvote', { id: q.id }).then(() => refreshQa(true))), q.upped ? 'primary' : 'secondary'); up.title = 'I have this question too'; row.append(up);
    if (isMgr()) {
      row.append(btn('Answer', () => { answering = answering === q.id ? null : q.id; renderQa(); }));
      row.append(btn(q.status === 'live' ? 'Stop live' : 'Answer live', () => act(() => call('qa/live', { id: q.id }).then(() => refreshQa(true)))));
      if (q.status !== 'answered') row.append(btn('Mark answered', () => act(() => call('qa/done', { id: q.id }).then(() => refreshQa(true)))));
      if (q.status === 'dismissed' || q.status === 'answered') row.append(btn('Reopen', () => act(() => call('qa/reopen', { id: q.id }).then(() => refreshQa(true)))));
      if (q.status !== 'dismissed') row.append(btn('Dismiss', () => act(() => call('qa/dismiss', { id: q.id }).then(() => refreshQa(true)))));
      row.append(btn('Delete', () => act(() => call('qa/delete', { id: q.id }).then(() => refreshQa(true))), 'secondary danger-text'));
    }
    card.append(row);
    if (isMgr() && answering === q.id) {
      const f = el('form', 'qanswer'); const t = document.createElement('textarea'); t.rows = 2; t.maxLength = 600; t.placeholder = 'Type your answer here...';
      const priv = document.createElement('input'); priv.type = 'checkbox'; const pl = el('label', 'check'); pl.append(priv, document.createTextNode(' Send privately to the asker'));
      const go = el('button', 'primary', 'Send'); go.type = 'submit'; f.append(t, pl, go);
      f.onsubmit = (e) => { e.preventDefault(); act(() => call('qa/answer', { id: q.id, text: t.value, private: priv.checked }).then(() => { answering = null; return refreshQa(true); })); };
      card.append(f); queueMicrotask(() => t.focus());
    }
    return card;
  }
  function renderQa() {
    for (const b of document.querySelectorAll('#qa-pane .qa-tabs button')) b.classList.toggle('on', b.dataset.qa === filter);
    const list = shownQ();
    $('qa-list').replaceChildren(...(list.length ? list.map(qCard) : [el('p', 'muted', questions.length ? 'No questions in this tab.' : 'No questions yet. Ask the first one below.')]));
    const meta = meeting.roomMeta(); // the host's switches arrive with the room's settings, so this follows them at once
    const can = meta.qaOn !== false || isMgr();
    $('qa-form').hidden = !can; $('qa-off').hidden = can;
    $('qa-anon-l').hidden = meta.qaAnon === false;
  }
  function paintMoreBadge() { const open = isMgr() ? questions.filter((q) => q.status === 'open').length : 0; $('btn-qa').dataset.n = open ? String(open) : ''; }
  for (const b of document.querySelectorAll('#qa-pane .qa-tabs button')) b.onclick = () => { filter = b.dataset.qa; renderQa(); };
  $('qa-form').onsubmit = (e) => {
    e.preventDefault();
    const t = $('qa-input').value.trim(); if (!t) return;
    act(async () => { await call('qa/ask', { text: t, anonymous: $('qa-anon').checked }); $('qa-input').value = ''; await refreshQa(true); });
  };
  $('qa-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('qa-form').requestSubmit(); } });

  // ============================================================ files in chat
  const filesAllowed = () => isMgr() || meeting.roomMeta().allowFiles === true;
  function paintAttach() { $('chat-attach').hidden = !filesAllowed(); }
  $('chat-attach').onclick = () => $('chat-file').click();
  $('chat-file').onchange = () => {
    const f = $('chat-file').files[0]; $('chat-file').value = '';
    if (!f) return;
    if (f.size > 25 * 1048576) { toast('Files can be up to 25 MB.'); return; }
    const s = getSession(); toast(`Sending ${f.name}…`, 'info');
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/class/file?room=${encodeURIComponent(s.roomName)}&name=${encodeURIComponent(f.name)}`);
    xhr.setRequestHeader('x-sanwes-token', s.token); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.onload = async () => {
      let j = {}; try { j = JSON.parse(xhr.responseText); } catch { /* none */ }
      if (xhr.status !== 200) { toast(j.error ?? `Could not send the file (${xhr.status}).`); return; }
      try {
        await getRoom().localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ text: '', file: j.file })), { reliable: true, topic: 'sanwes.chat' });
        addChat('me', `${s.name} (you)`, '', j.file);
      } catch (ex) { toast(`File not shared: ${ex.message}`); }
    };
    xhr.onerror = () => toast('Could not send the file. Check the connection.');
    xhr.send(f);
  };
  /** A file line in the chat: who sent it, name, size and a download link. */
  function fileNode(file) {
    const s = getSession();
    const a = document.createElement('a'); a.className = 'file-link'; a.textContent = `📎 ${file.name} (${mb(file.size)})`;
    a.href = `/api/class/file/${file.id}?room=${encodeURIComponent(s?.roomName ?? '')}`; a.download = file.name; a.rel = 'noopener';
    return a;
  }

  // ============================================================ what the server tells us
  function onData(payload, participant) {
    if (participant) return; // only the server speaks on this topic
    let m; try { m = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    if (typeof m.k === 'string' && m.k.startsWith('bo-')) return onBo?.(m);
    if (m.k === 'poll') refreshPolls();
    else if (m.k === 'qa') { if (paneOpen('qa') || isMgr()) refreshQa(); }
    else if (m.k === 'ask') askBanner(m.what === 'video' ? 'video' : 'unmute', String(m.from ?? 'The host').slice(0, 40));
    else if (m.k === 'talk') toast(m.on ? `${String(m.from ?? 'The host').slice(0, 40)} gave you the floor: you can unmute and start your video now.` : 'You can no longer unmute. The host took back the floor.', 'info');
  }
  let bannerEl = null;
  function askBanner(what, from) {
    bannerEl?.remove();
    const b = el('div', 'ask-banner'); b.setAttribute('role', 'alertdialog');
    b.append(el('span', '', what === 'video' ? `${from} would like you to start your video.` : `${from} would like you to unmute.`));
    const lp = getRoom()?.localParticipant;
    b.append(btn(what === 'video' ? 'Start video' : 'Unmute', async () => {
      b.remove(); try { await (what === 'video' ? lp.setCameraEnabled(true) : lp.setMicrophoneEnabled(true)); } catch (e) { toast(e.message); }
    }, 'primary'), btn('Not now', () => b.remove(), 'outline'));
    document.body.append(b); bannerEl = b; setTimeout(() => b.remove(), 30000);
  }

  // ============================================================ opening the panes, timers
  function openPane(name) { setChatOpen(true, name); if (name === 'qa') refreshQa(true); else refreshPolls(true); }
  $('btn-polls').onclick = () => { closeMore(); openPane('poll'); };
  $('btn-qa').onclick = () => { closeMore(); openPane('qa'); };
  const closeMore = () => { $('more-menu').hidden = true; };
  const timer = setInterval(() => {
    if (!getSession() || document.hidden) return;
    if (paneOpen('qa')) refreshQa();
    if (paneOpen('poll') && isMgr()) refreshPolls(); // the host watches the answers come in
  }, 4000);
  void timer;
  return {
    onData, openPane, paintAttach, fileNode,
    /** the meeting started or ended: forget everything */
    reset() { polls = []; questions = []; pollV = qaV = 0; seen = new Set(); lastCount = 0; answering = null; popupFor = null; bannerEl?.remove(); $('poll-vote').open && $('poll-vote').close(); $('poll-new').open && $('poll-new').close(); renderPolls(); renderQa(); },
    start() { refreshPolls(true); refreshQa(true); paintAttach(); },
    onRoomMeta() { paintAttach(); if (!$('qa-pane').hidden) renderQa(); },
  };
}
