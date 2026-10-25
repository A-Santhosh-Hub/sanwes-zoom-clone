// AI noise suppression for the microphone, run locally in the browser (RNNoise, BSD-licensed, via an AudioWorklet).
// mic track -> RNNoise worklet -> processed track, which LiveKit publishes instead of the raw mic.
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

let wasmBinary; // loaded once, reused across restarts

// Implements LiveKit's TrackProcessor interface (LocalAudioTrack.setProcessor).
export function createNoiseProcessor() {
  let ctx, source, node, dest;

  const build = async ({ track }) => {
    wasmBinary ??= await loadRnnoise({ url: wasmUrl, simdUrl });
    // RNNoise is trained for 48 kHz audio, so use our own context at that rate.
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    source = ctx.createMediaStreamSource(new MediaStream([track]));
    dest = ctx.createMediaStreamDestination();
    source.connect(node);
    node.connect(dest);
    processor.processedTrack = dest.stream.getAudioTracks()[0];
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  };

  const teardown = async () => {
    try { source?.disconnect(); node?.disconnect(); node?.destroy(); } catch { /* already gone */ }
    processor.processedTrack = undefined;
    const c = ctx; ctx = source = node = dest = undefined;
    await c?.close().catch(() => {});
  };

  const processor = {
    name: 'rnnoise-noise-suppression',
    processedTrack: undefined,
    init: build,
    restart: async (opts) => { await teardown(); await build(opts); },
    destroy: teardown,
  };
  return processor;
}
