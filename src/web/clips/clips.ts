import { api } from "../shared/api";

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

async function load(): Promise<void> {
  const clips = await api<ClipEntry[]>("/api/clips");
  const ready = clips.filter((c) => c.state !== "processing");
  $("empty").hidden = ready.length > 0;
  $("list").innerHTML = ready.map(card).join("");
  wireShareButtons();
  const state = await api<{ freeDiskGB: number | null }>("/api/state");
  if (state.freeDiskGB !== null && state.freeDiskGB < 5) {
    $("disk-banner").hidden = false;
    $("disk-banner").textContent =
      `⚠️ Pouco espaço em disco (${state.freeDiskGB.toFixed(1)} GB livres)`;
  }
}

await load();
setInterval(load, 10_000);
