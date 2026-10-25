// Live captions. A host or co-host can turn on "Caption my voice": their own browser turns their microphone into text
// (the browser's speech service, see the note in the dialog) and sends the text to the meeting; everybody who wants captions sees
// them at the bottom of the picture, and anybody can save the transcript. Only text from hosts and co-hosts is shown.
export const CC_TOPIC = 'sanwes.cc';
const LANGS = [['en-IN', 'English (India)'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['hi-IN', 'Hindi'], ['ta-IN', 'Tamil'], ['te-IN', 'Telugu'], ['ml-IN', 'Malayalam'], ['kn-IN', 'Kannada'], ['bn-IN', 'Bengali'], ['mr-IN', 'Marathi'], ['gu-IN', 'Gujarati'], ['pa-IN', 'Punjabi'], ['ur-IN', 'Urdu'], ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German'], ['ar-SA', 'Arabic']];

export function initCaptions({ $, getRoom, meeting, toast, store, isMgrP }) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let on = false, rec = null, seq = 0, lastSent = 0, show = store.get('sanwes.cc.show') !== '0', fade = 0;
  const transcript = [];
  $('cc-lang').replaceChildren(...LANGS.map(([v, t]) => new Option(t, v)));
  $('cc-lang').value = store.get('sanwes.cc.lang') || 'en-IN';

  function paintBar(who, text) {
    const bar = $('cc-bar');
    if (!show || !text) { bar.hidden = true; return; }
    $('cc-who').textContent = who; $('cc-text').textContent = text;
    bar.hidden = false;
    clearTimeout(fade); fade = setTimeout(() => { bar.hidden = true; }, 7000);
  }
  /** A caption from somebody else (checked: it must come from a host or co-host). */
  function onData(payload, participant) {
    if (!participant || !isMgrP(participant)) return;
    let m; try { m = JSON.parse(dec.decode(payload)); } catch { return; }
    const t = String(m?.t ?? '').slice(0, 400); if (!t) return;
    const who = participant.name || participant.identity;
    paintBar(who, t);
    if (m.f === true) transcript.push(`[${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${who}: ${t}`);
  }
  async function send(t, f) {
    const lp = getRoom()?.localParticipant; if (!lp) return;
    try { await lp.publishData(enc.encode(JSON.stringify({ t, f, n: ++seq })), { topic: CC_TOPIC, reliable: f }); } catch { /* best effort */ }
  }
  function start() {
    if (!SR) { toast('This browser cannot turn speech into text. Use Chrome or Edge.'); return false; }
    rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = $('cc-lang').value;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], t = r[0].transcript.trim(); if (!t) continue;
        if (r.isFinal) { send(t, true); paintBar('You', t); transcript.push(`[${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] You: ${t}`); }
        else if (Date.now() - lastSent > 350) { lastSent = Date.now(); send(t, false); paintBar('You', t); }
      }
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { toast('Captions need the microphone and the browser\'s speech service.'); stop(); } };
    rec.onend = () => { if (on) { try { rec.start(); } catch { /* already running */ } } }; // the service stops after a pause: keep it going
    try { rec.start(); } catch (e) { toast(`Captions: ${e.message}`); return false; }
    on = true; return true;
  }
  function stop() { on = false; try { rec?.stop(); } catch { /* not running */ } rec = null; paint(); }
  function paint() {
    $('cc-show').checked = show;
    $('cc-speak').hidden = !meeting.isManager();
    $('cc-speak-btn').textContent = on ? 'Stop captioning my voice' : 'Caption my voice';
    $('btn-cc').classList.toggle('on', on || show);
  }
  $('btn-cc').onclick = () => { $('more-menu').hidden = true; paint(); $('cc-dialog').showModal(); };
  $('cc-close').onclick = () => $('cc-dialog').close();
  $('cc-show').onchange = () => { show = $('cc-show').checked; store.set('sanwes.cc.show', show ? '1' : '0'); if (!show) $('cc-bar').hidden = true; paint(); };
  $('cc-lang').onchange = () => { store.set('sanwes.cc.lang', $('cc-lang').value); if (on) { stop(); start(); paint(); } };
  $('cc-speak-btn').onclick = () => { if (on) stop(); else start(); paint(); };
  $('cc-save').onclick = () => {
    if (!transcript.length) { toast('There is no transcript yet.', 'info'); return; }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([`${$('room-title').textContent}\n\n${transcript.join('\n')}\n`], { type: 'text/plain' })), download: 'transcript.txt' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return { onData, reset() { stop(); transcript.length = 0; $('cc-bar').hidden = true; }, paint, supported: !!SR };
}
