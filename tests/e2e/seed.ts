import { mkdirSync, rmSync, writeFileSync } from "node:fs";

// Optional dir override (argv[2]) lets playwright.config.ts seed a second, isolated
// data dir for the buffer-resilience spec so it doesn't share clip numbering / job
// history with record-flow.spec.ts. No arg => ".e2e-data", matching the primary flow.
const dir = process.argv[2] ?? ".e2e-data";

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/config.json`, JSON.stringify({ password: "e2e", clipDurationSeconds: 10 }));
