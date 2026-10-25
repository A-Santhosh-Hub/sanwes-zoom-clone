// Local recording. What you choose to keep, like the recording settings of a desktop meeting client:
//   - Video with sound   (one MP4: the picture as you see it, everyone's voice and any shared sound)
//   - Video only         (an MP4 with no sound track)
//   - Audio only         (one M4A with everything that was said)
//   - A sound file for each participant (one M4A per person, in an "Audio Record" folder)
// Files are written in standard formats that play everywhere (H.264 + AAC), directly by the browser: there is no
// conversion step when you press Stop. If you chose more than one file they come in one .zip. Nothing is uploaded.
// Built on a canvas (drawn from the visible tiles), a Web Audio mix of every audio track, and MediaRecorder.
const W = 1280, H = 720, FPS = 30;
const K = { names: 'sanwes.rec.names', time: 'sanwes.rec.time', share: 'sanwes.rec.share', side: 'sanwes.rec.side', oVideo: 'sanwes.rec.o.video', oVideoOnly: 'sanwes.rec.o.videoonly', oAudio: 'sanwes.rec.o.audio', oEach: 'sanwes.rec.o.each' };
const pick = (list) => list.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
const VIDEO_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const SILENT_VIDEO_TYPES = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
const extOf = (mime) => (mime.startsWith('video/mp4') ? 'mp4' : mime.startsWith('audio/mp4') ? 'm4a' : mime.startsWith('video/') ? 'webm' : 'weba');
const safe = (s) => String(s).replace(/[^\w .\-]/g, '').trim().slice(0, 60) || 'meeting';

// A .zip without compression ("stored"): enough to keep several files together, and small enough to write by hand.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
async function crc32(blob) {
  let c = 0xffffffff; const CH = 8 << 20;
  for (let o = 0; o < blob.size; o += CH) { const u = new Uint8Array(await blob.slice(o, o + CH).arrayBuffer()); for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 0xff] ^ (c >>> 8); }
  return (c ^ 0xffffffff) >>> 0;
}
async function makeZip(files) { // files: [{ name, blob }]
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = await crc32(f.blob), size = f.blob.size;
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, f.blob);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}

export function initRecorder({ $, store, getRoom, toast, getBoardCanvas, onChange }) {
  let on = false, canvas = null, g = null, actx = null, mix = null, analyser = null, drawTimer = 0, mixTimer = 0, peakTimer = 0;
  let startedAt = 0, paused = false, pausedAt = 0, pausedTotal = 0, peak = 0, saving = false, vtrack = null;
  let jobs = [];                 // { kind, name, mime, rec, chunks }
  const feeds = new Map();       // audio MediaStreamTrack -> { node, personal }
  const personal = new Map();    // identity -> { name, dest, job }
  const pics = new Map();

  const flag = (key, def) => { const v = store.get(key); return v === undefined ? def : v === '1'; };
  const prefs = {
    get names() { return flag(K.names, true); }, set names(v) { store.set(K.names, v ? '1' : '0'); },
    get time() { return flag(K.time, false); }, set time(v) { store.set(K.time, v ? '1' : '0'); },
    get share() { return flag(K.share, true); }, set share(v) { store.set(K.share, v ? '1' : '0'); },
    get side() { return flag(K.side, false); }, set side(v) { store.set(K.side, v ? '1' : '0'); },
    // what to keep
    get oVideo() { return flag(K.oVideo, true); }, set oVideo(v) { store.set(K.oVideo, v ? '1' : '0'); },
    get oVideoOnly() { return flag(K.oVideoOnly, false); }, set oVideoOnly(v) { store.set(K.oVideoOnly, v ? '1' : '0'); },
    get oAudio() { return flag(K.oAudio, true); }, set oAudio(v) { store.set(K.oAudio, v ? '1' : '0'); },
    get oEach() { return flag(K.oEach, false); }, set oEach(v) { store.set(K.oEach, v ? '1' : '0'); },
  };

  // ---------------------------------------------------------------- audio: every voice goes into one mix, and (if asked) into one stream per person
  function audioSources() {
    const r = getRoom(); if (!r) return [];
    const out = [];
    const take = (p) => { for (const pub of p.trackPublications.values()) { const t = pub.track?.mediaStreamTrack; if (t && t.kind === 'audio' && t.readyState === 'live' && !pub.isMuted) out.push({ t, p, mic: pub.source === 'microphone' }); } };
    take(r.localParticipant); for (const p of r.remoteParticipants.values()) take(p);
    return out;
  }
  function personalFor(p) {
    let e = personal.get(p.identity);
    if (!e) {
      const dest = actx.createMediaStreamDestination();
      e = { name: p.name || p.identity, dest, job: newJob('each', e?.name, AUDIO_TYPES, dest.stream) };
      e.job.name = e.name; personal.set(p.identity, e);
      e.job.rec.start(2000);
      if (paused) e.job.rec.pause();
    }
    return e;
  }
  function syncAudio() {
    if (!actx) return;
    const want = new Map(audioSources().map((s) => [s.t, s]));
    for (const [t, f] of feeds) if (!want.has(t)) { try { f.node.disconnect(); } catch { /* gone */ } feeds.delete(t); }
    for (const [t, s] of want) {
      if (feeds.has(t)) continue;
      const node = actx.createMediaStreamSource(new MediaStream([t]));
      node.connect(mix); node.connect(analyser);
      if (prefs.oEach && s.mic) node.connect(personalFor(s.p).dest);
      feeds.set(t, { node });
    }
  }

  // ---------------------------------------------------------------- picture: draw what is on screen
  function tilesOnScreen() {
    return [...document.querySelectorAll('#stage-area .tile')].filter((el) => el.isConnected && !el.closest('[hidden]') && !el.hidden).map((el) => ({
      el, video: el.querySelector('video'), hasVideo: el.classList.contains('has-video'), screen: el.classList.contains('screen'),
      label: (el.querySelector('.label')?.textContent ?? '').replace(/ 🔇$/, '').replace(/ — screen.*$/, ''), avatar: el.querySelector('.avatar'),
    }));
  }
  function cover(src, sw, sh, x, y, w, h, contain) {
    const k = contain ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh), dw = sw * k, dh = sh * k;
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); g.restore();
  }
  function drawTile(t, x, y, w, h, contain = false) {
    g.fillStyle = '#1f2327'; g.fillRect(x, y, w, h);
    const v = t.video;
    if (t.hasVideo && v && v.readyState >= 2 && v.videoWidth) cover(v, v.videoWidth, v.videoHeight, x, y, w, h, contain || t.screen);
    else { // no picture: the same initial or profile picture as on screen
      const r = Math.min(w, h) * 0.22, cx = x + w / 2, cy = y + h / 2, url = (t.avatar?.style.backgroundImage ?? '').slice(5, -2);
      g.save(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
      if (url) { let im = pics.get(url); if (!im) { im = new Image(); im.src = url; pics.set(url, im); } if (im.complete && im.naturalWidth) g.drawImage(im, cx - r, cy - r, r * 2, r * 2); }
      else { g.fillStyle = '#3f454d'; g.fillRect(cx - r, cy - r, r * 2, r * 2); g.fillStyle = '#fff'; g.font = `600 ${r}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t.avatar?.textContent ?? '', cx, cy); }
      g.restore();
    }
    if (prefs.names && t.label) {
      g.font = '600 15px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
      const tw = Math.min(g.measureText(t.label).width + 14, w - 8);
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x + 6, y + h - 28, tw, 22); g.fillStyle = '#fff'; g.fillText(t.label, x + 13, y + h - 17, tw - 12);
    }
  }
  function frame() {
    g.fillStyle = '#111417'; g.fillRect(0, 0, W, H);
    const tiles = tilesOnScreen(), board = getBoardCanvas?.();
    const screens = prefs.share ? tiles.filter((t) => t.screen && t.hasVideo) : [];
    const people = tiles.filter((t) => !t.screen);
    if (board || screens.length) { // a shared whiteboard or screen takes the picture; people go in a strip (or are left out)
      const strip = prefs.side ? people.filter((t) => t.hasVideo).slice(0, 4) : [];
      const mainW = strip.length ? W - 240 : W;
      if (board) cover(board, board.width, board.height, 0, 0, mainW, H, true); else drawTile(screens[0], 0, 0, mainW, H, true);
      strip.forEach((t, i) => drawTile(t, mainW + 8, 8 + i * 140, 224, 126));
    } else {
      const n = Math.max(1, people.length), cols = Math.ceil(Math.sqrt(n * W / H)), rows = Math.ceil(n / cols), cw = W / cols, ch = H / rows;
      people.forEach((t, i) => drawTile(t, (i % cols) * cw + 2, Math.floor(i / cols) * ch + 2, cw - 4, ch - 4));
    }
    if (prefs.time) {
      const s = new Date().toLocaleString(); g.font = '600 14px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'top';
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(W - g.measureText(s).width - 22, 8, g.measureText(s).width + 14, 22); g.fillStyle = '#fff'; g.fillText(s, W - 15, 12);
    }
  }

  // ---------------------------------------------------------------- one MediaRecorder per file
  function newJob(kind, name, types, stream) {
    const mime = pick(types);
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(kind.startsWith('video') ? { videoBitsPerSecond: 3_500_000 } : {}), ...(kind !== 'videoonly' ? { audioBitsPerSecond: 128_000 } : {}) });
    const job = { kind, name, mime: rec.mimeType || mime || 'video/webm', rec, chunks: [], done: null };
    job.done = new Promise((res) => { rec.onstop = () => res(); });
    rec.ondataavailable = (e) => { if (e.data?.size) job.chunks.push(e.data); };
    jobs.push(job);
    return job;
  }

  // ---------------------------------------------------------------- start / pause / stop
  async function start() {
    if (on || saving) return;
    const r = getRoom(); if (!r) return;
    if (typeof MediaRecorder === 'undefined') { toast('This browser cannot record.'); return; }
    if (!prefs.oVideo && !prefs.oVideoOnly && !prefs.oAudio && !prefs.oEach) { toast('Choose at least one kind of file to record (Settings > Recording).'); return; }
    canvas = Object.assign(document.createElement('canvas'), { width: W, height: H }); g = canvas.getContext('2d');
    actx = new AudioContext(); mix = actx.createMediaStreamDestination();
    // silence check: an analyser fed by the same voices as the files (routed to a muted output so the browser keeps it running)
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    const mute = actx.createGain(); mute.gain.value = 0; analyser.connect(mute); mute.connect(actx.destination);
    jobs = []; personal.clear(); feeds.clear(); peak = 0;
    syncAudio(); await actx.resume().catch(() => {});
    const needPicture = prefs.oVideo || prefs.oVideoOnly;
    if (needPicture) { frame(); drawTimer = setInterval(frame, 1000 / FPS); vtrack = canvas.captureStream(FPS).getVideoTracks()[0]; }
    const audioTrack = mix.stream.getAudioTracks()[0];
    if (prefs.oVideo) newJob('video', 'video', VIDEO_TYPES, new MediaStream([vtrack, audioTrack]));
    if (prefs.oVideoOnly) newJob('videoonly', 'video only', SILENT_VIDEO_TYPES, new MediaStream([vtrack]));
    if (prefs.oAudio) newJob('audio', 'audio_only', AUDIO_TYPES, new MediaStream([audioTrack]));
    for (const j of jobs) if (j.rec.state === 'inactive') j.rec.start(2000);
    mixTimer = setInterval(syncAudio, 1000);
    peakTimer = setInterval(() => { const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d); for (const x of d) if (Math.abs(x) > peak) peak = Math.abs(x); }, 200);
    on = true; startedAt = Date.now(); paused = false; pausedTotal = 0;
    try { await r.localParticipant.setAttributes({ rec: '1' }); } catch { /* attribute is only the notice to others */ }
    const mp4 = jobs.every((j) => /mp4/.test(j.mime));
    toast(`Recording to this computer${mp4 ? '' : ' (this browser saves WebM instead of MP4)'}. Everyone in the meeting has been told.`, 'info');
    onChange();
  }
  function pause(p) {
    if (!on) return;
    if (p && !paused) { for (const j of jobs) if (j.rec.state === 'recording') j.rec.pause(); paused = true; pausedAt = Date.now(); }
    else if (!p && paused) { for (const j of jobs) if (j.rec.state === 'paused') j.rec.resume(); paused = false; pausedTotal += Date.now() - pausedAt; }
    getRoom()?.localParticipant.setAttributes({ rec: paused ? '2' : '1' }).catch(() => {});
    onChange();
  }
  async function stop() {
    if (!on) return;
    on = false; saving = true;
    clearInterval(drawTimer); clearInterval(mixTimer); clearInterval(peakTimer);
    const seconds = Math.round(((paused ? pausedAt : Date.now()) - startedAt - pausedTotal) / 1000);
    getRoom()?.localParticipant?.setAttributes({ rec: '' }).catch(() => {});
    onChange();
    toast('Saving the recording…', 'info');
    for (const j of jobs) { if (j.rec.state === 'paused') j.rec.resume(); if (j.rec.state !== 'inactive') j.rec.stop(); }
    await Promise.all(jobs.map((j) => j.done));
    for (const f of feeds.values()) { try { f.node.disconnect(); } catch { /* gone */ } }
    actx?.close().catch(() => {});
    const finished = jobs, silent = peak < 0.003;
    jobs = []; feeds.clear(); personal.clear(); actx = mix = analyser = canvas = g = vtrack = null; paused = false;
    await save(finished, seconds, silent);
    saving = false; onChange();
  }

  // ---------------------------------------------------------------- hand the file(s) to the browser's downloads
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 20_000);
  }
  async function save(finished, seconds, silent) {
    const base = `${safe($('room-title').textContent)} ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
    const files = [], used = new Set();
    for (const j of finished) {
      const blob = new Blob(j.chunks, { type: j.mime });
      if (blob.size < 1500) continue;
      const ext = extOf(j.mime);
      let name = j.kind === 'video' ? `${base}.${ext}` : j.kind === 'videoonly' ? `${base} (video only).${ext}` : j.kind === 'audio' ? `audio_only.${ext}` : `Audio Record/${safe(j.name)}.${ext}`;
      for (let n = 2; used.has(name); n++) name = name.replace(/(\.\w+)$/, ` ${n}$1`);
      used.add(name); files.push({ name, blob });
    }
    if (!files.length) { toast('The recording was empty, so nothing was saved.'); return; }
    const mins = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (files.length === 1) { download(files[0].blob, files[0].name); toast(`Recording saved: ${files[0].name} (${mins}, ${(files[0].blob.size / 1e6).toFixed(1)} MB). Look in your Downloads folder.`, 'info'); }
    else {
      const zip = await makeZip(files);
      download(zip, `${base}.zip`);
      toast(`Recording saved: ${base}.zip with ${files.length} files (${mins}, ${(zip.size / 1e6).toFixed(1)} MB). Look in your Downloads folder.`, 'info');
    }
    if (silent && finished.some((j) => j.kind !== 'videoonly')) toast('No sound was captured: nobody was unmuted while recording. Check that people have their microphone on.');
  }

  return {
    prefs, start, stop, pause,
    get active() { return on; },
    get busy() { return saving; },
    get paused() { return paused; },
    get seconds() { return on ? Math.round(((paused ? pausedAt : Date.now()) - startedAt - pausedTotal) / 1000) : 0; },
    mp4Supported: () => typeof MediaRecorder !== 'undefined' && !!pick(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2']),
    // exposed for tests
    _makeZip: makeZip,
  };
}
