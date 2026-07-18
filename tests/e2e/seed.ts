import { mkdirSync, rmSync } from "node:fs";

// Optional dir override (argv[2]) lets playwright.config.ts seed a second, isolated
// data dir for the buffer-resilience spec so it doesn't share clip numbering / job
// history with record-flow.e2e.ts. No arg => ".e2e-data", matching the primary flow.
// Config (password, clip duration) comes from the server's env, set in
// playwright.config.ts's webServer command — there's no config.json to seed anymore.
const dir = process.argv[2] ?? ".e2e-data";

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
