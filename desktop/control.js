// Control panel: links, public link, and the recorder.
// The recorder captures the MEETING window (picture) together with the sound the computer plays (loopback) and, if ticked,
// the microphone, mixes the sound, and writes H.264 + AAC MP4 (and an M4A) straight to disk while recording.
const $ = (id) => document.getElementById(id);
const QUALITY = { standard: { fps: 30, mbps: 8 }, high: { fps: 60, mbps: 14 }, max: { fps: 60, mbps: 24 } };
const pick = (list) => list.find((m) => MediaRecorder.isTypeSupported(m));
const VIDEO_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];
const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus'];
let S = {};

// ---------------------------------------------------------------- links, services
function paint(s) {
  S = s;
  const ok = s.app?.startsWith('running') && s.media?.startsWith('running');
  const bad = ['did not start', 'missing', 'stopped'].some((x) => s.app === x || s.media === x);
  $('svc').className = `svc ${ok ? 'ok' : bad ? 'bad' : ''}`;
  $('svc').querySelector('span').textContent = ok ? 'Meeting server running' : bad ? `Problem: app ${s.app}, media ${s.media}` : 'Starting…';
  $('u-local').textContent = s.local; $('u-lan').textContent = s.lan;
  $('u-tunnel').textContent = s.tunnel || (s.tunnelBusy ? 'starting… (a few seconds)' : 'not started'); $('u-tunnel').classList.toggle('dim', !s.tunnel);
  $('t-copy').hidden = !s.tunnel;
  $('t-go').textContent = s.tunnel || s.tunnelBusy ? 'Stop public link' : 'Start public link';
  $('t-go').classList.toggle('primary', !(s.tunnel || s.tunnelBusy));
  $('t-hint').textContent = s.note || (s.cloudflared ? 'The public link lets people outside your Wi-Fi join. Send it to your guests, then start the meeting.' : 'cloudflared is not installed, so there is no public link. Install it with: winget install Cloudflare.cloudflared');
  $('dir').textContent = s.recordingsDir;
}
for (const b of document.querySelectorAll('[data-copy]')) b.onclick = async () => { const t = $(b.dataset.copy).textContent; if (/^https?:/.test(t)) { await studio.copy(t); const w = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = w; }, 1200); } };
$('t-go').onclick = () => studio.tunnel(!(S.tunnel || S.tunnelBusy));
$('open-meeting').onclick = () => studio.openMeeting();
let large = false;
$('size-meeting').onclick = async () => { large = !(await studio.meetingSize(!large)) ? false : true; $('size-meeting').textContent = large ? 'Back to the normal window size' : 'Make the meeting window large (best for recording)'; };
$('open-folder').onclick = () => studio.rec.folder();
studio.onState(paint); studio.state().then(paint);
setInterval(async () => {
  const m = await studio.meetingInfo();
  $('m-state').textContent = m?.inMeeting ? `In a meeting: ${m.title}` : 'Not in a meeting yet. Start or join one in the meeting window.';
}, 1500);

// ---------------------------------------------------------------- microphone list
async function fillMics() {
  try {
    const t = await navigator.mediaDevices.getUserMedia({ audio: true }); t.getTracks().forEach((x) => x.stop());
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    $('mic').replaceChildren(...devs.map((d, i) => new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  } catch { $('mic').replaceChildren(new Option('No microphone available', '')); }
}
$('use-mic').onchange = () => { $('mic-row').hidden = !$('use-mic').checked; };
fillMics();

// ---------------------------------------------------------------- recorder
let rec = null; // { jobs, ctx, tracks, timer, started, paused, ... }
let autoRun = null; // the class run whose recording the server asked for (class mode): its start and end are reported back
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
function setBusy(state) { // 'idle' | 'on' | 'paused' | 'saving'
  document.querySelector('.rec').classList.toggle('on', state === 'on' || state === 'paused');
  $('r-start').disabled = state !== 'idle'; $('r-pause').disabled = !(state === 'on' || state === 'paused'); $('r-stop').disabled = !(state === 'on' || state === 'paused');
  $('r-pause').textContent = state === 'paused' ? 'Resume' : 'Pause';
  for (const id of ['quality', 'use-mic', 'mic', 'want-audio']) $(id).disabled = state !== 'idle';
}
function note(text, warn) { $('r-note').textContent = text; $('r-note').style.color = warn ? '#e6b450' : ''; }

async function startRecording() {
  $('r-saved').hidden = true; note('');
  if (await studio.meetingMinimized()) { note('The meeting window is minimized: restore it first, or the recording will be empty.', true); return; }
  const q = QUALITY[$('quality').value];
  let disp;
  try { disp = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: q.fps } }, audio: true }); }
  catch (e) { note(`Could not capture the meeting window (${e.name}). Open the meeting window and try again.`, true); return; }
  const vtrack = disp.getVideoTracks()[0], sys = disp.getAudioTracks();
  const ctx = new AudioContext({ sampleRate: 48000 }), dest = ctx.createMediaStreamDestination(), an = ctx.createAnalyser(); an.fftSize = 1024;
  const sinkMute = ctx.createGain(); sinkMute.gain.value = 0; an.connect(sinkMute); sinkMute.connect(ctx.destination);
  // two sources (the computer's sound and your microphone) can add up past the maximum: a limiter keeps the mix clean
  const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -6; limiter.knee.value = 3; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.15;
  const mixBus = ctx.createGain(); mixBus.gain.value = 0.8; mixBus.connect(limiter); limiter.connect(dest); limiter.connect(an);
  const nodes = [];
  if (sys.length) nodes.push(ctx.createMediaStreamSource(new MediaStream(sys)));
  let micStream = null;
  if ($('use-mic').checked) {
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $('mic').value ? { exact: $('mic').value } : undefined, echoCancellation: true, noiseSuppression: false, autoGainControl: false } }); nodes.push(ctx.createMediaStreamSource(micStream)); }
    catch { note('The microphone could not be opened, so it is not in the recording.', true); }
  }
  for (const n of nodes) n.connect(mixBus);
  await ctx.resume();
  const atrack = dest.stream.getAudioTracks()[0];
  const vType = pick(VIDEO_TYPES), aType = pick(AUDIO_TYPES);
  const vExt = vType.startsWith('video/mp4') ? 'mp4' : 'webm', aExt = aType.startsWith('audio/mp4') ? 'm4a' : 'weba';
  const kinds = { video: `meeting.${vExt}` }; if ($('want-audio').checked) kinds.audio = `audio_only.${aExt}`;
  const { dir, ids } = await studio.rec.begin(kinds);
  const jobs = [];
  const mk = (kind, stream, type, opts) => {
    const r = new MediaRecorder(stream, { mimeType: type, ...opts });
    const job = { kind, r, id: ids[kind].id, queue: Promise.resolve(), stopped: new Promise((res) => { r.onstop = res; }) };
    r.ondataavailable = (e) => { if (e.data?.size) job.queue = job.queue.then(async () => studio.rec.write(job.id, new Uint8Array(await e.data.arrayBuffer()))); };
    jobs.push(job); return job;
  };
  mk('video', new MediaStream([vtrack, atrack]), vType, { videoBitsPerSecond: q.mbps * 1e6, audioBitsPerSecond: 192_000 });
  if (kinds.audio) mk('audio', new MediaStream([atrack]), aType, { audioBitsPerSecond: 192_000 });
  for (const j of jobs) j.r.start(1000);
  rec = { jobs, ctx, disp, micStream, dir, ids, started: Date.now(), paused: false, pausedAt: 0, pausedTotal: 0, peak: 0, vExt };
  rec.timer = setInterval(() => {
    const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let m = 0; for (const x of d) m = Math.max(m, Math.abs(x)); rec.peak = Math.max(rec.peak, m);
    $('r-level').style.width = `${Math.min(100, Math.round(Math.sqrt(m) * 130))}%`;
    $('r-time').textContent = fmt(Math.round(((rec.paused ? rec.pausedAt : Date.now()) - rec.started - rec.pausedTotal) / 1000));
  }, 120);
  vtrack.onended = () => { if (rec) stopRecording(true); };
  if (autoRun) studio.autoStatus({ run: autoRun, recording: true, file: ids.video?.file });
  setBusy('on'); { const st = vtrack.getSettings(); note(`Recording ${st.width}×${st.height} at up to ${q.fps} fps, ${q.mbps} Mbit/s (${vExt.toUpperCase()}). Everyone in the meeting has been told.`); }
}
function pauseResume() {
  if (!rec) return;
  if (!rec.paused) { for (const j of rec.jobs) j.r.pause(); rec.paused = true; rec.pausedAt = Date.now(); studio.rec.flag('2'); setBusy('paused'); }
  else { for (const j of rec.jobs) j.r.resume(); rec.paused = false; rec.pausedTotal += Date.now() - rec.pausedAt; studio.rec.flag('1'); setBusy('on'); }
}
async function stopRecording(windowClosed) {
  if (!rec) return; const R = rec; rec = null;
  clearInterval(R.timer); setBusy('saving'); note('Saving…');
  for (const j of R.jobs) { if (j.r.state === 'paused') j.r.resume(); if (j.r.state !== 'inactive') j.r.stop(); }
  await Promise.all(R.jobs.map((j) => j.stopped));
  await Promise.all(R.jobs.map((j) => j.queue));
  const saved = []; for (const j of R.jobs) saved.push(await studio.rec.end(j.id));
  R.disp.getTracks().forEach((t) => t.stop()); R.micStream?.getTracks().forEach((t) => t.stop()); R.ctx.close().catch(() => {});
  studio.rec.flag('');
  $('r-level').style.width = '0';
  const silent = R.peak < 0.003;
  const box = $('r-saved'); box.hidden = false; box.className = `saved${silent ? ' warn' : ''}`;
  box.textContent = `${windowClosed ? 'The meeting window was closed, so the recording stopped. ' : ''}Saved in ${R.dir}\n${saved.filter(Boolean).map((s) => `${s.file.split('\\').pop()}  (${(s.size / 1e6).toFixed(1)} MB)`).join('\n')}${silent ? '\n\nNo sound was captured. Nobody was talking, or the computer was playing no sound (check the volume and the output device).' : ''}`;
  box.style.whiteSpace = 'pre-line';
  note(''); setBusy('idle');
  if (autoRun) { studio.autoStatus({ run: autoRun, recording: false, file: saved.find((s) => s && /\.(mp4|webm)$/.test(s.file) && !/audio_only/.test(s.file))?.file }); autoRun = null; }
  $('open-folder').onclick = () => studio.rec.folder(R.dir);
}
$('r-start').onclick = () => startRecording().catch((e) => { note(`Recording failed: ${e.message}`, true); setBusy('idle'); });
$('r-pause').onclick = pauseResume;
$('r-stop').onclick = () => stopRecording(false);
studio.onMeetingClosed(() => { if (rec) stopRecording(true); });
setBusy('idle');

// class mode: the server says "record the class window now" / "stop" (the quality is the best one, no microphone: the class sound is the computer's sound)
studio.onAutoRecord(async ({ on, run }) => {
  if (on) {
    if (rec) return;
    autoRun = run; $('quality').value = 'high'; $('use-mic').checked = false; $('mic-row').hidden = true; $('want-audio').checked = true;
    try { await startRecording(); } catch (e) { note(`Recording failed: ${e.message}`, true); setBusy('idle'); autoRun = null; return; }
    if (!rec) { studio.autoStatus({ run, recording: false }); autoRun = null; } // it could not start (for example the window was not there)
  } else if (rec) await stopRecording(false);
});

// for automated tests
window.__studio = { startRecording, stopRecording: () => stopRecording(false), get recording() { return !!rec; } };
