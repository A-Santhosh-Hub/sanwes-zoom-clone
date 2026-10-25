// Camera background effects (blur / virtual background), run locally with a MediaPipe person-segmentation model.
// The model and the vision engine are served from this app (client/public) so a call never depends on a CDN.
import { BackgroundProcessor, supportsBackgroundProcessors } from '@livekit/track-processors';

export const backgroundsSupported = () => { try { return supportsBackgroundProcessors(); } catch { return false; } };

export const BACKGROUNDS = {
  off: 'No effect',
  blur: 'Blur',
  'blur-strong': 'Strong blur',
  ocean: 'Virtual: Ocean',
  sunset: 'Virtual: Sunset',
  forest: 'Virtual: Forest',
};

const assetPaths = { tasksVisionFileSet: '/mediapipe', modelAssetPath: '/models/selfie_segmenter.tflite' };

// Built-in virtual backgrounds are drawn on a canvas, so nothing needs to be downloaded or licensed.
function drawBackground(kind) {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  const stops = { ocean: ['#0b3d91', '#1ca3c9', '#bfe9f2'], sunset: ['#2b1055', '#d1456b', '#ffb36b'], forest: ['#0b2b1d', '#1f6b3a', '#a8d5a2'] }[kind];
  const grad = g.createLinearGradient(0, 0, 0, 720);
  stops.forEach((col, i) => grad.addColorStop(i / (stops.length - 1), col));
  g.fillStyle = grad; g.fillRect(0, 0, 1280, 720);
  g.globalAlpha = 0.18; g.fillStyle = '#fff';
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(160 + i * 220, 560 + (i % 2) * 60, 220, 0, Math.PI * 2); g.fill(); }
  return c.toDataURL('image/jpeg', 0.9);
}

// Returns a LiveKit track processor, or null for "No effect". GPU first (fast); the caller retries on CPU if the GPU path fails.
export function makeBackground(kind, delegate = 'GPU') {
  if (!BACKGROUNDS[kind] || kind === 'off') return null;
  const common = { assetPaths, segmenterOptions: { delegate } };
  if (kind === 'blur') return BackgroundProcessor({ mode: 'background-blur', blurRadius: 12, ...common });
  if (kind === 'blur-strong') return BackgroundProcessor({ mode: 'background-blur', blurRadius: 30, ...common });
  return BackgroundProcessor({ mode: 'virtual-background', imagePath: drawBackground(kind), ...common });
}
