import { cycleSeconds, selectFilesForWindow } from "../../shared/buffer-window";
import type { ServerMessage } from "../../shared/protocol";
import { WsClient } from "../shared/ws-client";

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

function watchTrack(): void {
  stream.getVideoTracks()[0]!.onended = () => void recoverStream();
}

/** iOS Safari kills the stream when backgrounded or on lens switch; recover with a fresh getUserMedia. */
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
