import type { LogEntry } from "@shared/protocol";

// Tiny leveled logger, no runtime dependencies (the only import above is type-only, erased at
// compile time).
//
// Threshold comes from LOG_LEVEL (default "info"); unknown values fall back to "info".
// "silent" suppresses everything. The env var is read fresh on every call (see `threshold()`)
// so tests can flip LOG_LEVEL at runtime and see the effect immediately.
//
// NEVER log secrets (passwords, tokens, cookies) — that's on the caller. This module
// deliberately only accepts a short message plus flat, primitive fields — no "dump this
// object" convenience — so it's harder to accidentally leak something sensitive.
//
// Sinks (`addLogSink`) let other modules observe every emitted line as a structured `LogEntry` —
// used by `server/index.ts` to feed the control page's live log viewer (backlog buffer + WS
// stream). A sink only ever sees lines that already passed the LOG_LEVEL threshold, so it
// automatically inherits the same filtering (in particular, `silent` means no sink calls at all).

/** Flat, primitive-only structured fields attached to a log line — see the file header for why
 * this is deliberately not "pass any object". */
export type LogFields = Record<string, string | number | boolean>;
export type Logger = {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
};

// Array order encodes severity ranking, least to most severe (plus the "silent" sentinel last):
// threshold filtering in `emit` is just an `indexOf` comparison against this order.
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

// Process-wide monotonic counter backing `LogEntry.seq` — lets clients (the control page) dedupe
// a line that arrives via both the WS stream and the `/api/logs` backlog fetch.
let seq = 0;
const sinks = new Set<(entry: LogEntry) => void>();

/**
 * Registers a sink invoked with a `LogEntry` for every line that passes the LOG_LEVEL threshold
 * (see the file header). Returns a disposer that removes it — callers that spin up many short-
 * lived app instances (tests, mainly) MUST call it once they're done, or sinks pile up across
 * instances and each subsequent log call gets slower and leaks into unrelated tests.
 */
export function addLogSink(fn: (entry: LogEntry) => void): () => void {
  sinks.add(fn);
  return () => {
    sinks.delete(fn);
  };
}

function emit(level: ActiveLevel, scope: string, message: string, fields?: LogFields): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(threshold())) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${renderFields(fields)}`;
  if (level === "debug" || level === "info") console.log(line);
  else console.error(line);
  const entry: LogEntry = { seq: ++seq, ts, level, scope, message, fields };
  for (const sink of sinks) sink(entry);
}

/** Creates a `Logger` that tags every line with `scope` (e.g. the module name) — see the file
 * header for the level threshold, formatting, and no-secrets rules that apply to every call. */
export function logger(scope: string): Logger {
  return {
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
  };
}
