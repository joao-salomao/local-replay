import { cycleSeconds, selectFilesForWindow } from "../../shared/buffer-window";
import type { ServerMessage } from "../../shared/protocol";
import { WsClient } from "../shared/ws-client";

/**
 * Camera page: continuously records in fixed-length cycles, keeping only the last two finished
 * segments (previous + current) as a rolling buffer, and uploads the slice covering a triggered
 * clip's window on demand.
 *
 * Two invariants make this work, and both are easy to get subtly wrong:
 *
 * 1. Rolling buffer coverage. `files` holds at most 2 segments (previous + current — see
 *    `startCycle`'s `files.slice(-1)`). For any triggered window of length `clipDurationSeconds`
 *    to always be fully covered by just those 2 segments, the cycle length itself must be >=
 *    `clipDurationSeconds` (see `buffer-window.ts#cycleSeconds`) — a shorter cycle could require
 *    a third segment to cover the window, which the buffer doesn't keep.
 *
 * 2. The `cycleGen` generation guard. `MediaRecorder.stop()` is asynchronous — its `onstop` fires
 *    on a later tick, after other code may have already reacted to something (the video track
 *    ending, the tab regaining visibility, another trigger) and started a NEW recording cycle via
 *    `startCycle()`. Each `startCycle()` call closes over its own snapshot (`gen`) of the
 *    module-level `cycleGen` counter; when a recorder's `onstop` finally fires, comparing its
 *    captured `gen` against the current `cycleGen` tells it whether it's still the active cycle
 *    or has been superseded by a newer one in the meantime. A superseded `onstop` must NOT touch
 *    the shared `files` buffer (its segment may not be contiguous with what the new cycle has
 *    already recorded) and must NOT call `startCycle()` itself (that would start a second,
 *    competing cycle alongside the one that already superseded it) — it only still uploads a
 *    pending triggered clip, best-effort, so a "lance" is never silently dropped just because its
 *    capture window raced a recovery.
 *
 * All buffered timestamps (`startMs`/`durationMs`) are in SERVER-clock time (`ws.serverNow()`,
 * see `shared/clock.ts`), not the device's own local clock — that's what makes segments recorded
 * independently by multiple camera devices comparable on one timeline when the server later
 * computes the cut window (`shared/buffer-window.ts#computeCutWindow`).
 */

type BufferedFile = { blob: Blob; mimeType: string; startMs: number; durationMs: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1",
  "video/webm;codecs=h264,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

let ws: WsClient;
let cameraId = "";
let stream: MediaStream;
let mimeType = "";
let clipDurationSeconds = 20;
let bufferCycleMinSeconds = 30;
let recorder: MediaRecorder | null = null;
let files: BufferedFile[] = []; // previous + just-finalized, max 2
let cycleTimer = 0;
let cycleGen = 0;
let pendingRecord: { jobId: string; t: number; windowSec: number } | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let wasHidden = false;
let currentDeviceId: string | null = null;

/**
 * Requests the camera (`deviceId` if switching lenses, else the environment-facing camera) with
 * audio, falling back to video-only if audio fails (some devices/browsers have no working mic, or
 * grant camera and microphone permission independently) — silent video beats no video at all.
 */
async function acquireMedia(deviceId: string | null): Promise<MediaStream> {
  const video = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60 },
  } as MediaTrackConstraints;
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  }
}

/** Reports actual capture resolution/fps to the server and the on-page badge. Called on
 * (re)connect and every 5s thereafter (see bottom of file) since fps/resolution can drift with
 * device heat/throttling — keeping both the control page's badge and this page's own display live. */
function reportStatus(): void {
  const s = stream.getVideoTracks()[0]!.getSettings();
  ws.send({
    type: "cameraStatus",
    width: s.width ?? 0,
    height: s.height ?? 0,
    fps: Math.round(s.frameRate ?? 0),
  });
  $("media-info").textContent =
    `${s.width}×${s.height} @ ${Math.round(s.frameRate ?? 0)}fps (60fps é melhor esforço — varia por aparelho)`;
}

/** Recovers from track death generally (device unplugged, permission revoked mid-session), not
 * just the iOS-specific case `recoverStream` itself is mainly written for. */
function watchTrack(): void {
  stream.getVideoTracks()[0]!.onended = () => void recoverStream();
}

/**
 * iOS Safari kills the stream when backgrounded or on lens switch; recover with a fresh
 * getUserMedia. Tears down the current recorder, timer, and buffer and starts fully clean —
 * including detaching the dying recorder's handlers before stopping it (see the file header's
 * `cycleGen` note for the race this guards against).
 */
async function recoverStream(): Promise<void> {
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null; // detach so the dead recorder cannot restart a cycle on the old stream
    try {
      if (recorder.state === "recording") recorder.stop();
    } catch {
      /* already dead */
    }
    recorder = null;
  }
  clearTimeout(cycleTimer);
  pendingRecord = null; // a triggered clip can't survive stream loss — avoid a later spurious empty upload
  files = [];
  stream.getTracks().forEach((t) => t.stop());
  stream = await acquireMedia(currentDeviceId);
  $<HTMLVideoElement>("preview").srcObject = stream;
  watchTrack();
  reportStatus();
  startCycle();
}

/** Shows the lens/camera picker only when there's an actual choice (2+ video inputs) — hidden
 * entirely on single-camera devices, where it would just be dead UI. */
async function populateCameraSelect(): Promise<void> {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === "videoinput",
  );
  if (cams.length < 2) return;
  const select = $<HTMLSelectElement>("camera-select");
  select.hidden = false;
  select.innerHTML = cams
    .map((c, i) => `<option value="${c.deviceId}">${c.label || `Câmera ${i + 1}`}</option>`)
    .join("");
  const active = stream.getVideoTracks()[0]!.getSettings().deviceId;
  if (active) select.value = active;
  select.onchange = () => {
    currentDeviceId = select.value;
    void recoverStream();
  };
}

/**
 * Starts one recording cycle: a fresh `MediaRecorder` on the current stream, timed to stop itself
 * after `cycleSeconds(...)` and — via `onstop` below — roll the result into the shared `files`
 * buffer and immediately start the next cycle. See the file header for the full `cycleGen`
 * generation-guard rationale; the short version is that `onstop`'s `gen === cycleGen` check tells
 * a (possibly stale, asynchronously-firing) `onstop` whether it's still allowed to touch shared
 * state. Bitrate is bumped for high-framerate capture (60fps needs more bits/frame than 30fps to
 * hold the same visual quality).
 */
function startCycle(): void {
  const gen = ++cycleGen;
  const localChunks: Blob[] = [];
  const startMs = ws.serverNow();
  const settings = stream.getVideoTracks()[0]!.getSettings();
  const rec = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: (settings.frameRate ?? 30) >= 50 ? 12_000_000 : 6_000_000,
  });
  recorder = rec;
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) localChunks.push(e.data);
  };
  rec.onstop = () => {
    const file: BufferedFile = {
      blob: new Blob(localChunks, { type: mimeType }),
      mimeType,
      startMs,
      durationMs: ws.serverNow() - startMs,
    };
    const record = pendingRecord;
    pendingRecord = null;
    if (gen === cycleGen) {
      // We are still the current cycle: append to the shared buffer and roll forward.
      files = [...files.slice(-1), file];
      startCycle();
      if (record) void uploadClip(record, files);
    } else {
      // Superseded by a newer cycle: do NOT touch the shared buffer or start a competing cycle.
      // Still honor a triggered upload (best-effort) so a "lance" is never silently dropped.
      if (record) void uploadClip(record, [...files, file]);
    }
  };
  rec.start(1000);
  clearTimeout(cycleTimer);
  cycleTimer = window.setTimeout(() => {
    if (rec.state === "recording") rec.stop();
  }, cycleSeconds(clipDurationSeconds, bufferCycleMinSeconds) * 1000);
  $("buffer-status").textContent = `Bufferizando últimos ${clipDurationSeconds}s`;
}

/**
 * Uploads exactly the buffered segments overlapping the triggered window (`selectFilesForWindow`
 * — the server does the precise trim, this just avoids sending segments with no overlap at all).
 * Retries up to 3 times with exponential backoff, except on a 404: that means the job was already
 * finalized server-side (`clip-job.ts#uploadDir` returns null once it's not "capturing" anymore),
 * so the window has definitively closed and retrying more would just waste attempts.
 */
async function uploadClip(
  record: { jobId: string; t: number; windowSec: number },
  sourceFiles: BufferedFile[],
): Promise<void> {
  $("buffer-status").textContent = "Enviando lance...";
  const windowStartMs = record.t - record.windowSec * 1000;
  const selected = selectFilesForWindow(sourceFiles, windowStartMs, record.t);
  const form = new FormData();
  form.append("cameraId", cameraId);
  form.append("angleName", localStorage.getItem("angleName") ?? "Camera");
  form.append(
    "filesMeta",
    JSON.stringify(selected.map((f) => ({ startMs: f.startMs, mimeType: f.mimeType }))),
  );
  selected.forEach((f, i) => form.append(`file${i}`, f.blob, `part${i}`));
  let outcome: "ok" | "notFound" | "failed" = "failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/clips/${record.jobId}/upload`, { method: "POST", body: form });
      if (res.ok) {
        outcome = "ok";
        break;
      }
      if (res.status === 404) {
        outcome = "notFound"; // job finalized without us
        break;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  if (outcome === "ok") {
    $("upload-error").textContent = "";
  } else if (outcome === "failed") {
    $("upload-error").textContent = "Falha ao enviar o lance. Verifique o Wi‑Fi.";
  }
  $("buffer-status").textContent = `Bufferizando últimos ${clipDurationSeconds}s`;
}

/**
 * Dispatches one `ServerMessage`. A `clipDurationSeconds` change is applied lazily — it's only
 * consulted when the NEXT cycle is scheduled (inside `startCycle`), so an in-flight cycle finishes
 * on its existing timer rather than being torn down mid-recording; the new duration takes effect
 * at most one cycle late. A `record` trigger only does anything if a recorder is actively
 * recording right now — stopping it early (rather than waiting for its natural cycle boundary)
 * pulls the "current" segment's end closer to the actual trigger moment, tightening buffer
 * coverage of the requested window. If no recorder is recording at that instant (e.g. mid-recovery
 * gap), the trigger is not queued anywhere and is effectively missed.
 */
function handleMessage(msg: ServerMessage): void {
  if (msg.type === "registered") {
    cameraId = msg.cameraId;
    reportStatus();
  }
  if (msg.type === "state") {
    bufferCycleMinSeconds = msg.bufferCycleMinSeconds;
    if (msg.clipDurationSeconds !== clipDurationSeconds) {
      clipDurationSeconds = msg.clipDurationSeconds; // applied on the next cycle restart
      $("buffer-status").textContent = `Bufferizando últimos ${clipDurationSeconds}s`;
    }
  }
  if (msg.type === "record" && recorder?.state === "recording") {
    pendingRecord = msg;
    clearTimeout(cycleTimer);
    recorder.stop();
  }
}

async function keepAwake(): Promise<void> {
  try {
    wakeLock =
      (await (
        navigator as Navigator & {
          wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> };
        }
      ).wakeLock?.request("screen")) ?? null;
  } catch {
    wakeLock = null; // headless/unsupported: keep going
  }
}

// On returning from backgrounded: if the track actually died (the common iOS case), do a full
// recoverStream(); if it survived, still discard the buffer and restart the cycle cleanly rather
// than resuming — stitching footage from before/after an arbitrarily long hidden gap together
// would produce a nonsensical buffered segment.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    wasHidden = true;
    return;
  }
  if (!wasHidden || !stream) return;
  $("hidden-banner").hidden = false;
  void keepAwake();
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState === "ended" || track.muted) {
    void recoverStream(); // iOS dropped the stream while hidden
  } else {
    files = [];
    if (recorder?.state === "recording") recorder.stop();
    else startCycle();
  }
});

$("start").onclick = async () => {
  const name = $<HTMLInputElement>("angle-name").value.trim();
  if (!name) {
    $("camera-error").textContent = "Dê um nome para este ângulo.";
    return;
  }
  localStorage.setItem("angleName", name);
  try {
    stream = await acquireMedia(null);
  } catch (e) {
    $("camera-error").textContent = `Sem acesso à câmera: ${e instanceof Error ? e.message : e}`;
    return;
  }
  mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  $<HTMLVideoElement>("preview").srcObject = stream;
  $("setup").hidden = true;
  $("live").hidden = false;
  await keepAwake();

  ws = new WsClient();
  ws.onStatus = (connected) => {
    $("conn-dot").classList.toggle("on", connected);
    $("conn-text").textContent = connected ? "Conectado" : "Desconectado";
    if (connected) {
      ws.send({ type: "register", role: "camera", name });
      setTimeout(() => startCycle(), 800); // wait for first ntp samples
    }
  };
  ws.onMessage = handleMessage;
  ws.connect();

  watchTrack();
  void populateCameraSelect();
  const portrait = window.matchMedia("(orientation: portrait)");
  const updateOrientHint = () => ($("orient-hint").hidden = !portrait.matches);
  portrait.addEventListener("change", updateOrientHint);
  updateOrientHint();
  setInterval(reportStatus, 5_000); // fps/resolution drift with heat — keep badge and control live
};

$<HTMLInputElement>("angle-name").value = localStorage.getItem("angleName") ?? "";
