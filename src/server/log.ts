// Tiny leveled logger, no dependencies.
//
// Threshold comes from LOG_LEVEL (default "info"); unknown values fall back to "info".
// "silent" suppresses everything. The env var is read fresh on every call (see `threshold()`)
// so tests can flip LOG_LEVEL at runtime and see the effect immediately.
//
// NEVER log secrets (passwords, tokens, cookies) — that's on the caller. This module
// deliberately only accepts a short message plus flat, primitive fields — no "dump this
// object" convenience — so it's harder to accidentally leak something sensitive.

export type LogFields = Record<string, string | number | boolean>;
export type Logger = {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
};

const LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
type Level = (typeof LEVELS)[number];
type ActiveLevel = Exclude<Level, "silent">;

function threshold(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as Level) : "info";
}

function renderFields(fields?: LogFields): string {
  if (!fields) return "";
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return rendered ? ` ${rendered}` : "";
}

function emit(level: ActiveLevel, scope: string, message: string, fields?: LogFields): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(threshold())) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${renderFields(fields)}`;
  if (level === "debug" || level === "info") console.log(line);
  else console.error(line);
}

export function logger(scope: string): Logger {
  return {
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
  };
}

// Convenience default scope for quick one-off logging; prefer a scoped logger() per module.
export default logger("app");
