import { expect, test, type Page } from "@playwright/test";

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
});
