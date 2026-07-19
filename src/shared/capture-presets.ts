/**
 * Predefined capture resolution/fps options the control page offers and the server validates
 * against — the common 16:9 modes phone cameras generally support, from 1080p down to 360p so an
 * operator can dial the capture down for weak or overheating devices. Shared so the `/control`
 * dropdown (`web/control/control.ts`) and the server-side validation (`config.ts#setCapture`) can't
 * drift apart.
 */
export type CapturePreset = { label: string; width: number; height: number; fps: number };

export const CAPTURE_PRESETS: CapturePreset[] = [
  { label: "1080p · 60fps", width: 1920, height: 1080, fps: 60 },
  { label: "1080p · 30fps", width: 1920, height: 1080, fps: 30 },
  { label: "720p · 60fps", width: 1280, height: 720, fps: 60 },
  { label: "720p · 30fps", width: 1280, height: 720, fps: 30 },
  { label: "480p · 30fps", width: 854, height: 480, fps: 30 },
  { label: "360p · 30fps", width: 640, height: 360, fps: 30 },
];

/** True iff `(width, height, fps)` exactly matches one of the presets — the server only accepts a
 * capture change that lands on a known preset. */
export function isCapturePreset(width: number, height: number, fps: number): boolean {
  return CAPTURE_PRESETS.some((p) => p.width === width && p.height === height && p.fps === fps);
}
