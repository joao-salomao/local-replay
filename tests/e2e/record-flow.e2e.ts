import { expect, type Page, test } from "@playwright/test";

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

test("record flow: 2 cameras + control → clip in gallery", async ({ context, page }) => {
  await login(page);
  const cam1 = page;
  await startCamera(cam1, "Fundo");

  const cam2 = await context.newPage();
  await startCamera(cam2, "Lateral");

  const control = await context.newPage();
  await control.goto("/control");
  await expect(control.locator("#cam-count")).toHaveText("2 câmera(s) online", { timeout: 15_000 });

  // "10" is active from the seeded config; clicking "20" must move the active state (proves the POST + WS re-render works)
  await expect(control.locator('#durations button[data-d="10"]')).toHaveClass(/active/);
  await control.click('#durations button[data-d="20"]');
  await expect(control.locator('#durations button[data-d="20"]')).toHaveClass(/active/);
  await expect(control.locator('#durations button[data-d="10"]')).not.toHaveClass(/active/);
  // set it back to 10s so the triggered clip uses a short window that the buffered seconds can cover
  await control.click('#durations button[data-d="10"]');
  await expect(control.locator('#durations button[data-d="10"]')).toHaveClass(/active/);

  await control.waitForTimeout(12_000); // let the buffers accumulate > windowSec
  await control.click("#record");
  await expect(control.locator("#jobs")).toContainText("Lance #1", { timeout: 10_000 });
  await expect(control.locator("#jobs")).toContainText("pronto", { timeout: 240_000 });

  const gallery = await context.newPage();
  await gallery.goto("/clips");
  await expect(gallery.locator(".clip-card").first()).toContainText("Lance #1", {
    timeout: 15_000,
  });
  await expect(gallery.locator(".clip-card video").first()).toBeVisible();

  const combined = await gallery.request.get(
    gallery.url().replace("/clips", "") +
      (await gallery.locator(".clip-card a.dl").first().getAttribute("href")),
  );
  expect(combined.status()).toBe(200);
  expect(Number(combined.headers()["content-length"] ?? "1")).toBeGreaterThan(100_000);

  // The camera page can call a play on its own — no /control needed. Only the job's creation and
  // its cam1 upload are asserted here, not the full encode: the pipeline itself is already proven
  // by Lance #1 above, and waiting out a second ffmpeg run would double an already multi-minute test.
  await cam1.click("#cam-record");
  // Proves the POST reaches the server and creates a job — kept separate from the assertion below
  // so a missing job (vs. a missing upload) fails with a cleaner, more specific message.
  await expect(control.locator("#jobs")).toContainText("Lance #2", { timeout: 10_000 });
  // Proves the load-bearing claim this feature depends on: the `record` broadcast comes back to the
  // *triggering* camera (cam1), which is subscribed to TOPIC_CAMERAS like any other camera, and its
  // own handleMessage path stops the in-flight recorder and uploads. "Lance #2" alone doesn't prove
  // this — it only proves the trigger reached the server, not that cam1 ever received the broadcast
  // back. `finalize()` only advances the job past "capturing" once every expected camera (both cam1
  // and cam2) has delivered its upload, so seeing "processando" here is only possible if cam1's
  // upload actually landed. 15s is comfortably below the 30s fallback upload timeout, so a pass
  // here cannot be explained by the timeout silently finalizing the job without cam1's angle.
  await expect(control.locator("#jobs")).toContainText("Lance #2 — processando", {
    timeout: 15_000,
  });
});
