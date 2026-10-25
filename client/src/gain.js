// Volume boost with a limiter for shared sound (e.g. a quiet VLC video). LiveKit TrackProcessor, same shape as noise.js.
// source -> gain (+dB) -> limiter -> processed track. The limiter stops the boosted peaks from clipping/distorting.
export function createGainProcessor(db) {
  let ctx, source, gain, limiter, dest;

  const build = async ({ track }) => {
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    source = ctx.createMediaStreamSource(new MediaStream([track]));
    gain = ctx.createGain();
    gain.gain.value = 10 ** (db / 20);
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    source.connect(gain).connect(limiter).connect(dest);
    processor.processedTrack = dest.stream.getAudioTracks()[0];
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  };

  const teardown = async () => {
    try { source?.disconnect(); gain?.disconnect(); limiter?.disconnect(); } catch { /* already gone */ }
    processor.processedTrack = undefined;
    const c = ctx; ctx = source = gain = limiter = dest = undefined;
    await c?.close().catch(() => {});
  };

  const processor = {
    name: `share-gain-${db}db`,
    processedTrack: undefined,
    init: build,
    restart: async (opts) => { await teardown(); await build(opts); },
    destroy: teardown,
  };
  return processor;
}
