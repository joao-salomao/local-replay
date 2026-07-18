import { expect, type Page, test } from "@playwright/test";

// Runs against the second webServer entry (its own data dir), isolated from
// record-flow.spec.ts, so this spec's own trigger is a clean "clip #1" regardless
// of file execution order (clip numbering is derived from files already on disk).
test.use({ baseURL: "https://localhost:8544" });

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.fill("#password", "e2e");
  await page.click("#login-form button");
  await expect(page.locator("#roles")).toBeVisible();
}

async function startCamera(page: Page, name: string): Promise<void> {
  await page.goto("/camera");
  await page.fill("#angle-name", name);
  await page.click("#start");
  await expect(page.locator("#conn-text")).toHaveText("Conectado", { timeout: 15_000 });
  await expect(page.locator("#buffer-status")).toContainText("Bufferizando", { timeout: 15_000 });
}

/** Flips document.hidden and fires a real "visibilitychange" event, driving the
 *  camera page's become-hidden / become-visible handler (recoverStream / buffer reset). */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { value: h, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("camera buffer survives repeated visibility churn and still produces a triggered clip", async ({
  context,
  page,
}) => {
  // This is the heaviest spec in the suite: camera setup + 3 rounds of visibility churn
  // (each restarting the MediaRecorder cycle) + a real ffmpeg-processed trigger. The global
  // config timeout (300_000) leaves zero headroom for this spec; bump it here so the
  // 240_000 inner wait for "pronto" below always has slack left for the rest of the flow.
  test.setTimeout(420_000);

  await login(page);
  const cameraPage = page;
  await startCamera(cameraPage, "Fundo");

  const control = await context.newPage();
  await control.goto("/control");
  await expect(control.locator("#cam-count")).toHaveText("1 câmera(s) online", { timeout: 15_000 });

  // Stress the become-hidden → become-visible path 3x: each round resets the shared
  // buffer (files = []) and either stops the in-flight MediaRecorder (onstop restarts
  // the cycle under the generation guard) or starts a fresh cycle directly. Assert the
  // camera comes back to a healthy buffering state every time — no stuck/dead buffer.
  for (let i = 0; i < 3; i++) {
    await setHidden(cameraPage, true);
    await setHidden(cameraPage, false);
    if (i === 0) {
      // #buffer-status always reads "Bufferizando..." while idle, seeded or not — it can't tell
      // us the become-visible handler actually ran. #hidden-banner can: camera.ts only clears
      // its `hidden` attribute inside that handler and never re-hides it, so this proves the
      // recovery branch fired at least once.
      await expect(cameraPage.locator("#hidden-banner")).toBeVisible({ timeout: 5_000 });
    }
    await cameraPage.waitForTimeout(1_500);
    await expect(cameraPage.locator("#buffer-status")).toContainText("Bufferizando", {
      timeout: 15_000,
    });
  }

  await cameraPage.waitForTimeout(2_000);
  await control.click("#record");
  await expect(control.locator("#jobs")).toContainText("Lance #1", { timeout: 10_000 });
  await expect(control.locator("#jobs")).toContainText("pronto", { timeout: 240_000 });

  const gallery = await context.newPage();
  await gallery.goto("/clips");
  await expect(gallery.locator(".clip-card").first()).toContainText("Lance #1", {
    timeout: 15_000,
  });
  await expect(gallery.locator(".clip-card video").first()).toBeVisible();

  // No "Falha ao enviar" surfaced on the camera page after a successful triggered upload.
  await expect(cameraPage.locator("#upload-error")).toHaveText("");
});
