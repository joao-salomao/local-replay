import { CAPTURE_PRESETS } from "@shared/capture-presets";
import type { CameraInfo, JobStatus, LogEntry, ServerMessage } from "@shared/protocol";
import { api } from "@web/shared/api";
import { $ } from "@web/shared/dom-helpers";
import { esc } from "@web/shared/esc";
import { WsClient } from "@web/shared/ws-client";

/**
 * Control/remote page: shows connected cameras and recent job statuses over a live WS connection,
 * lets the operator trigger a recording or change the clip duration, and prints a QR code linking
 * back to the site (for joining cameras/other control devices).
 */

type State = {
  cameras: CameraInfo[];
  clipDurationSeconds: number;
  audioSourceName: string | null;
  bufferMarginSeconds: number;
  uploadTimeoutSeconds: number;
  capture: { width: number; height: number; fps: number };
  jobs: JobStatus[];
  freeDiskGB?: number | null;
};
const DURATIONS = [10, 20, 30, 45, 60];
const BUFFER_MARGIN_OPTIONS = [0, 3, 5, 10, 15];
const UPLOAD_TIMEOUT_OPTIONS = [30, 45, 60, 90, 120, 180];

/** Builds `<option>`s for a seconds-valued picker: the preset list, plus — if the current server
 * value isn't one of them (e.g. an env-set value) — a selected option for it so the picker still
 * reflects reality. Values are plain integers, so no escaping is needed (see the capture preset). */
function secondsSelect(options: number[], current: number): string {
  const custom = options.includes(current)
    ? ""
    : `<option value="${current}" selected>${current}s</option>`;
  return `${custom}${options
    .map((n) => `<option value="${n}"${n === current ? " selected" : ""}>${n}s</option>`)
    .join("")}`;
}

/** Maps a job's lifecycle state (see `protocol.ts#JobState`) to its pt-BR display label. */
function jobLabel(job: JobStatus): string {
  if (job.state === "capturing") return `Lance #${job.clipNumber} — capturando...`;
  if (job.state === "processing") return `Lance #${job.clipNumber} — processando...`;
  if (job.state === "ready") return `Lance #${job.clipNumber} — pronto 🎬 `;
  return `Lance #${job.clipNumber} — erro`;
}

let state: State = {
  cameras: [],
  clipDurationSeconds: 20,
  audioSourceName: null,
  bufferMarginSeconds: 5,
  uploadTimeoutSeconds: 30,
  capture: { width: 1920, height: 1080, fps: 60 },
  jobs: [],
};

/**
 * Full unconditional re-render from `state`. Unlike the clips gallery's polling loop (which
 * diffs a signature to avoid pointless DOM rebuilds), this page's `state` only changes on actual
 * server-pushed WS events (`state`/`jobUpdate`), so every call here already corresponds to a real
 * change — there's no "nothing changed, skip the rebuild" case to guard against.
 */
function render(): void {
  const online = state.cameras.filter((c) => c.online);
  const low = typeof state.freeDiskGB === "number" && state.freeDiskGB < 5;
  $("disk-banner").hidden = !low;
  if (low) {
    $("disk-banner").textContent =
      `⚠️ Pouco espaço em disco (${state.freeDiskGB!.toFixed(1)} GB livres)`;
  }
  $("cam-count").textContent = `${online.length} câmera(s) online`;
  $("cam-hint").hidden = online.length > 0;
  $<HTMLButtonElement>("record").disabled = online.length === 0;
  $("cam-list").innerHTML = state.cameras
    .map(
      (c) =>
        `<li><span>${c.online ? "🟢" : "🔴"} ${esc(c.name)}${c.deviceLabel ? ` · ${esc(c.deviceLabel)}` : ""} — ${c.width}×${c.height}@${c.fps}fps</span><button type="button" class="cam-remove" data-remove="${esc(c.id)}" title="Remover câmera" aria-label="Remover câmera">✕</button></li>`,
    )
    .join("");
  $("cam-list")
    .querySelectorAll<HTMLButtonElement>("button[data-remove]")
    .forEach((b) => {
      b.addEventListener("click", async () => {
        const id = b.dataset.remove!;
        const cam = state.cameras.find((c) => c.id === id);
        if (
          !window.confirm(
            `Remover a câmera "${cam?.name ?? ""}"? O aparelho volta pra tela de escolha.`,
          )
        )
          return;
        await api(`/api/cameras/${id}/remove`, { method: "POST" });
      });
    });
  $("durations").innerHTML = DURATIONS.map(
    (d) =>
      `<button type="button" data-d="${d}" class="${d === state.clipDurationSeconds ? "active" : ""}">${d}s</button>`,
  ).join("");
  $("durations")
    .querySelectorAll("button")
    .forEach((b) => {
      b.addEventListener("click", async () => {
        await api("/api/config/clip-duration", {
          method: "POST",
          body: JSON.stringify({ seconds: Number(b.dataset.d) }),
        });
      });
    });
  // Audio-source options: the online cameras, plus — if the saved choice is a camera that's
  // currently offline — that name too (so the selection stays visible), plus the "automatic" default.
  const audioNames = [...new Set(state.cameras.filter((c) => c.online).map((c) => c.name))];
  if (state.audioSourceName && !audioNames.includes(state.audioSourceName)) {
    audioNames.push(state.audioSourceName);
  }
  $("audio-source").innerHTML = `<option value="">Automática (1ª câmera)</option>${audioNames
    .map(
      (n) =>
        `<option value="${esc(n)}"${n === state.audioSourceName ? " selected" : ""}>${esc(n)}</option>`,
    )
    .join("")}`;
  // Capture preset: the current server setting is selected; changing it makes connected cameras
  // re-acquire at the new resolution/fps (see camera.ts). If the env value isn't one of the presets,
  // it's shown as a disabled "Atual" option so the picker still reflects reality.
  const curCap = `${state.capture.width}x${state.capture.height}x${state.capture.fps}`;
  const presetOpts = CAPTURE_PRESETS.map(
    (p) =>
      `<option value="${p.width}x${p.height}x${p.fps}"${`${p.width}x${p.height}x${p.fps}` === curCap ? " selected" : ""}>${esc(p.label)}</option>`,
  ).join("");
  const customOpt = CAPTURE_PRESETS.some((p) => `${p.width}x${p.height}x${p.fps}` === curCap)
    ? ""
    : `<option value="${curCap}" selected disabled>Atual (${state.capture.width}×${state.capture.height}@${state.capture.fps})</option>`;
  $("capture-preset").innerHTML = customOpt + presetOpts;
  // Extra buffer (camera-side) and upload timeout (server-side) — the two knobs against slow uploads.
  $("buffer-margin").innerHTML = secondsSelect(BUFFER_MARGIN_OPTIONS, state.bufferMarginSeconds);
  $("upload-timeout").innerHTML = secondsSelect(UPLOAD_TIMEOUT_OPTIONS, state.uploadTimeoutSeconds);
  $("jobs").innerHTML = state.jobs
    .slice(0, 5)
    .map(
      (j) =>
        `<li>${jobLabel(j)}${j.state === "ready" ? '<a class="dl" href="/clips">ver na galeria</a>' : ""}</li>`,
    )
    .join("");
}

$("record").onclick = async () => {
  $("record-error").textContent = "";
  try {
    await api("/api/record", { method: "POST" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro";
    $("record-error").textContent = msg === "cooldown" ? "Aguarde um instante entre lances" : msg;
  }
};

// Wired once — the <select> element itself persists across renders; only its <option>s are rebuilt
// in render(). An empty value means automatic (the first camera's audio).
$<HTMLSelectElement>("audio-source").onchange = async (e) => {
  const name = (e.target as HTMLSelectElement).value || null;
  await api("/api/config/audio-source", { method: "POST", body: JSON.stringify({ name }) });
};

// Wired once (see the audio-source note). Value is "WIDTHxHEIGHTxFPS" — split it back into the
// numbers the server expects.
$<HTMLSelectElement>("capture-preset").onchange = async (e) => {
  const [width, height, fps] = (e.target as HTMLSelectElement).value.split("x").map(Number);
  await api("/api/config/capture", {
    method: "POST",
    body: JSON.stringify({ width, height, fps }),
  });
};

// Wired once (see the audio-source note). Both are plain integer-seconds settings the server persists.
$<HTMLSelectElement>("buffer-margin").onchange = async (e) => {
  const seconds = Number((e.target as HTMLSelectElement).value);
  await api("/api/config/buffer-margin", { method: "POST", body: JSON.stringify({ seconds }) });
};

$<HTMLSelectElement>("upload-timeout").onchange = async (e) => {
  const seconds = Number((e.target as HTMLSelectElement).value);
  await api("/api/config/upload-timeout", { method: "POST", body: JSON.stringify({ seconds }) });
};

const ws = new WsClient({
  onStatus: (connected) => {
    $("conn-dot").classList.toggle("on", connected);
    if (connected) ws.send({ type: "register", role: "control" });
  },
  onMessage: (msg: ServerMessage) => {
    if (msg.type === "state") {
      state = {
        ...state,
        cameras: msg.cameras,
        clipDurationSeconds: msg.clipDurationSeconds,
        audioSourceName: msg.audioSourceName,
        bufferMarginSeconds: msg.bufferMarginSeconds,
        uploadTimeoutSeconds: msg.uploadTimeoutSeconds,
        capture: msg.capture,
        jobs: msg.jobs,
        freeDiskGB: msg.freeDiskGB,
      };
      render();
    }
    if (msg.type === "jobUpdate") {
      // Replace-or-insert by jobId, then re-sort and cap at 20 — mirrors the server's own
      // JobManager.recent[] cap (clip-job.ts) so this list matches server-side retention, and
      // re-sorts because a jobUpdate for an older (e.g. slower-finalizing) job can arrive after a
      // newer job's own update.
      const rest = state.jobs.filter((j) => j.jobId !== msg.job.jobId);
      state.jobs = [msg.job, ...rest].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
      render();
    }
    if (msg.type === "log") {
      if (addLogEntries([msg.entry]) && $<HTMLDetailsElement>("log-section").open) renderLogs();
    }
  },
});
ws.connect();

// Initial paint from a plain fetch — WS `state` broadcasts only fire on subsequent changes, so
// without this the page would show nothing until something happens to trigger one.
state = await api<State>("/api/state");
render();
$<HTMLImageElement>("qr").src = `/api/qr.svg?data=${encodeURIComponent(location.origin)}`;

/**
 * Live server-log viewer (collapsible `<details id="log-section">`): entries stream in one at a
 * time over the WS `log` message (see `ws.onMessage` above) and are merged with the `/api/logs`
 * backlog fetched the first time the section is opened. Kept deliberately separate from `state`/
 * `render()` above — this is an independent, append-only stream rather than a periodically
 * replaced snapshot.
 */
const LOG_MAX = 500;
const LEVEL_RANK: Record<LogEntry["level"], number> = { debug: 0, info: 1, warn: 2, error: 3 };

let logEntries: LogEntry[] = [];
const seenLogSeq = new Set<number>();
let logBacklogLoaded = false;

/** Formats one entry as an escaped HTML line. `scope`/`message`/`fields` all come from the server
 * but ultimately carry operator-entered text (e.g. a camera's angle name lands in log fields like
 * `{name: "..."}`) — exactly the same XSS risk as the camera list in `render()` above, so every
 * part is run through `esc()`. Nothing here is trusted. */
function logLineHtml(e: LogEntry): string {
  const time = esc(e.ts.slice(11, 19)); // HH:MM:SS out of the ISO timestamp
  const fields = e.fields
    ? ` ${Object.entries(e.fields)
        .map(([k, v]) => `${esc(k)}=${esc(String(v))}`)
        .join(" ")}`
    : "";
  return `<div class="log-line ${esc(e.level)}">${time} ${esc(e.level.toUpperCase())} [${esc(e.scope)}] ${esc(e.message)}${fields}</div>`;
}

/**
 * Re-renders `#log-view` from `logEntries`, filtered by `#log-level` and capped to the last 500
 * visible lines. Auto-scrolls to the bottom only if the view was already scrolled near the bottom
 * *before* this render — so an operator who scrolled up to read history doesn't get yanked back
 * down by a new incoming line (the check has to happen before the `innerHTML` swap below, since
 * that resets `scrollTop`).
 */
function renderLogs(): void {
  const view = $("log-view");
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  const filter = $<HTMLSelectElement>("log-level").value as "all" | LogEntry["level"];
  const threshold = filter === "all" ? -1 : LEVEL_RANK[filter];
  const visible = logEntries.filter((e) => LEVEL_RANK[e.level] >= threshold).slice(-LOG_MAX);
  view.innerHTML = visible.map(logLineHtml).join("");
  if (nearBottom) view.scrollTop = view.scrollHeight;
}

/**
 * Merges `entries` into `logEntries`, deduped by `seq` (a line can otherwise arrive twice — once
 * live over the WS, once again via the backlog fetch), keeps them sorted by `seq`, and caps at
 * `LOG_MAX`. Shared by both the one-at-a-time WS branch and the bulk backlog merge below. Returns
 * whether anything was actually added, so callers can skip a pointless re-render.
 */
function addLogEntries(entries: LogEntry[]): boolean {
  let added = false;
  for (const e of entries) {
    if (seenLogSeq.has(e.seq)) continue;
    seenLogSeq.add(e.seq);
    logEntries.push(e);
    added = true;
  }
  if (added) {
    logEntries.sort((a, b) => a.seq - b.seq);
    if (logEntries.length > LOG_MAX) {
      for (const e of logEntries.slice(0, logEntries.length - LOG_MAX)) seenLogSeq.delete(e.seq);
      logEntries = logEntries.slice(-LOG_MAX);
    }
  }
  return added;
}

// Backlog fetch happens once, the first time the section is opened (guarded by `logBacklogLoaded`)
// — but every subsequent open re-renders from the current in-memory `logEntries` regardless, since
// WS `log` messages that arrived while the section was collapsed were still merged into
// `logEntries` above (see `ws.onMessage`), just not painted into the (hidden) DOM at the time.
function openLogSection(): void {
  if (!logBacklogLoaded) {
    logBacklogLoaded = true;
    void (async () => {
      const backlog = await api<LogEntry[]>("/api/logs");
      addLogEntries(backlog);
      renderLogs();
    })();
  } else {
    renderLogs();
  }
}

$<HTMLDetailsElement>("log-section").addEventListener("toggle", () => {
  if ($<HTMLDetailsElement>("log-section").open) openLogSection();
});
// The section starts expanded (index.html has `open`), so load its backlog now — the `toggle`
// event doesn't fire for the initial open state, only on a later user collapse/expand.
if ($<HTMLDetailsElement>("log-section").open) openLogSection();

$("log-clear").onclick = () => {
  // Clears only this page's view/local state — the server-side ring buffer (`/api/logs`) is left
  // alone, so reopening a fresh control page still sees the real history.
  logEntries = [];
  seenLogSeq.clear();
  $("log-view").innerHTML = "";
};

$("log-level").onchange = () => renderLogs();
