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
  jobs: JobStatus[];
  freeDiskGB?: number | null;
};
const DURATIONS = [10, 20, 30, 45, 60];

/** Maps a job's lifecycle state (see `protocol.ts#JobState`) to its pt-BR display label. */
function jobLabel(job: JobStatus): string {
  if (job.state === "capturing") return `Lance #${job.clipNumber} — capturando...`;
  if (job.state === "processing") return `Lance #${job.clipNumber} — processando...`;
  if (job.state === "ready") return `Lance #${job.clipNumber} — pronto 🎬 `;
  return `Lance #${job.clipNumber} — erro`;
}

let state: State = { cameras: [], clipDurationSeconds: 20, audioSourceName: null, jobs: [] };

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
        `<li>${c.online ? "🟢" : "🔴"} ${esc(c.name)} — ${c.width}×${c.height}@${c.fps}fps</li>`,
    )
    .join("");
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
$<HTMLDetailsElement>("log-section").addEventListener("toggle", () => {
  const section = $<HTMLDetailsElement>("log-section");
  if (!section.open) return;
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
});

$("log-clear").onclick = () => {
  // Clears only this page's view/local state — the server-side ring buffer (`/api/logs`) is left
  // alone, so reopening a fresh control page still sees the real history.
  logEntries = [];
  seenLogSeq.clear();
  $("log-view").innerHTML = "";
};

$("log-level").onchange = () => renderLogs();
