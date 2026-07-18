import type { CameraInfo, JobStatus, ServerMessage } from "../../shared/protocol";
import { api } from "../shared/api";
import { WsClient } from "../shared/ws-client";

/**
 * Control/remote page: shows connected cameras and recent job statuses over a live WS connection,
 * lets the operator trigger a recording or change the clip duration, and prints a QR code linking
 * back to the site (for joining cameras/other control devices).
 */

type State = {
  cameras: CameraInfo[];
  clipDurationSeconds: number;
  jobs: JobStatus[];
  freeDiskGB?: number | null;
};
const DURATIONS = [10, 20, 30, 45, 60];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

/** Maps a job's lifecycle state (see `protocol.ts#JobState`) to its pt-BR display label. */
function jobLabel(job: JobStatus): string {
  if (job.state === "capturing") return `Lance #${job.clipNumber} — capturando...`;
  if (job.state === "processing") return `Lance #${job.clipNumber} — processando...`;
  if (job.state === "ready") return `Lance #${job.clipNumber} — pronto 🎬 `;
  return `Lance #${job.clipNumber} — erro`;
}

let state: State = { cameras: [], clipDurationSeconds: 20, jobs: [] };

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
      `<button data-d="${d}" class="${d === state.clipDurationSeconds ? "active" : ""}" style="flex:1">${d}s</button>`,
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

const ws = new WsClient();
ws.onStatus = (connected) => {
  $("conn-dot").classList.toggle("on", connected);
  if (connected) ws.send({ type: "register", role: "control" });
};
ws.onMessage = (msg: ServerMessage) => {
  if (msg.type === "state") {
    state = {
      ...state,
      cameras: msg.cameras,
      clipDurationSeconds: msg.clipDurationSeconds,
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
};
ws.connect();

// Initial paint from a plain fetch — WS `state` broadcasts only fire on subsequent changes, so
// without this the page would show nothing until something happens to trigger one.
state = await api<State>("/api/state");
render();
$<HTMLImageElement>("qr").src = `/api/qr.svg?data=${encodeURIComponent(location.origin)}`;
