import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Optional dir override (argv[2]) lets playwright.config.ts seed a second, isolated
// data dir for the buffer-resilience spec so it doesn't share clip numbering / job
// history with record-flow.e2e.ts. No arg => ".e2e-data", matching the primary flow.
const dir = process.argv[2] ?? ".e2e-data";

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// Clip duration is a UI-managed setting (no env) — record-flow.e2e.ts asserts the selector starts
// on 10s, so seed that here via config.json, which the server reads on boot. Password/secret still
// come from the webServer env (see playwright.config.ts).
writeFileSync(join(dir, "config.json"), JSON.stringify({ clipDurationSeconds: 10 }));
