import { api } from "../shared/api";

/**
 * Clips gallery page: polls `/api/clips` + `/api/state` every 10s and renders a card per
 * non-processing clip (video preview, download links, a share button, and a QR code to the file).
 */

type ClipEntry = {
  clipNumber: number;
  createdAt: number;
  state: "processing" | "ready" | "error";
  cameras: { name: string; slug: string }[];
  outputs: { combined: string | null; angles: Record<string, string> };
  errors: string[];
  dir: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const time = (ms: number) =>
  new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

let lastSignature = "";

/**
 * Renders one clip's card, or `""` if there's nothing playable at all (caller filters these out).
 * Prefers the combined multi-angle video; falls back to whichever single angle succeeded when
 * `combined` is missing (e.g. only one angle came through, or the combine step itself failed).
 */
function card(clip: ClipEntry): string {
  const nameBySlug = new Map(clip.cameras.map((c) => [c.slug, c.name]));
  const src = clip.outputs.combined ?? Object.values(clip.outputs.angles)[0];
  if (!src) return "";
  const video = `/files/${clip.dir}/${src}`;
  const downloads = [
    clip.outputs.combined
      ? `<a class="dl" href="/files/${clip.dir}/${clip.outputs.combined}" download>⬇️ Combinado</a>`
      : "",
    ...Object.entries(clip.outputs.angles).map(
      ([slug, file]) =>
        `<a class="dl" href="/files/${clip.dir}/${file}" download>⬇️ ${esc(nameBySlug.get(slug) ?? slug)}</a>`,
    ),
  ].join("");
  const partial =
    clip.errors.length > 0 ? ' <span class="muted">(processado parcialmente)</span>' : "";
  return `<div class="card clip-card">
    <p><strong>Lance #${clip.clipNumber}</strong> — ${time(clip.createdAt)}${partial}</p>
    <video controls preload="metadata" src="${video}"></video>
    <p>${downloads}</p>
    <button class="share-btn" data-file="${video}" data-name="lance-${String(clip.clipNumber).padStart(3, "0")}.mp4">📤 Compartilhar</button>
    <img alt="QR" style="width:96px;background:#fff;border-radius:6px;margin-top:8px" src="/api/qr.svg?data=${encodeURIComponent(location.origin + video)}" />
  </div>`;
}

/**
 * Wires the Web Share API onto every rendered `.share-btn`, called after each `.innerHTML` swap
 * since that destroys any previously-attached handlers along with the old nodes.
 *
 * Hidden entirely where `navigator.share` doesn't exist (desktop browsers) — the plain download
 * links already cover that case. Where it does exist, fetches the video into a real `File` (not
 * just a link) so `canShare({files})` can push it into apps like WhatsApp for a native "send
 * video" experience; falls back to a plain download if file-based sharing isn't permitted.
 */
function wireShareButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".share-btn").forEach((btn) => {
    if (!("share" in navigator)) {
      btn.hidden = true; // desktop browsers: downloads links cover it
      return;
    }
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const blob = await (await fetch(btn.dataset.file!)).blob();
        const file = new File([blob], btn.dataset.name!, { type: "video/mp4" });
        const nav = navigator as Navigator & { canShare?(data: { files: File[] }): boolean };
        if (nav.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file] } as ShareData); // native share sheet (WhatsApp etc.)
        } else {
          location.href = btn.dataset.file!;
        }
      } catch {
        /* user cancelled the share sheet */
      } finally {
        btn.disabled = false;
      }
    };
  });
}

/**
 * Polled every 10s (see bottom of file). Re-renders the clip list's `.innerHTML` only when a
 * cheap signature of the relevant fields (number/state/outputs per clip) actually changed —
 * rebuilding the DOM unconditionally on every poll would reset each `<video>`'s playback
 * position and re-trigger thumbnail loads even when nothing changed. The disk-space banner is
 * updated unconditionally on every poll instead, since free space can drift independently of the
 * clip list.
 */
async function load(): Promise<void> {
  const clips = await api<ClipEntry[]>("/api/clips");
  const ready = clips.filter((c) => c.state !== "processing");
  const cards = ready.map(card).filter((html) => html !== "");
  const signature = JSON.stringify(
    ready.map((c) => [
      c.clipNumber,
      c.state,
      c.outputs.combined,
      Object.keys(c.outputs.angles).length,
    ]),
  );
  if (signature !== lastSignature) {
    lastSignature = signature;
    $("empty").hidden = cards.length > 0;
    $("list").innerHTML = cards.join("");
    wireShareButtons();
  }
  const state = await api<{ freeDiskGB: number | null }>("/api/state");
  const low = typeof state.freeDiskGB === "number" && state.freeDiskGB < 5;
  $("disk-banner").hidden = !low;
  if (low) {
    $("disk-banner").textContent =
      `⚠️ Pouco espaço em disco (${state.freeDiskGB!.toFixed(1)} GB livres)`;
  }
}

await load();
setInterval(load, 10_000);
