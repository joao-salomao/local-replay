import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { logger } from "../../src/server/log";

let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalLevel: string | undefined;
let logLines: string[];
let errorLines: string[];

beforeEach(() => {
  originalLog = console.log;
  originalError = console.error;
  originalLevel = process.env.LOG_LEVEL;
  logLines = [];
  errorLines = [];
  console.log = (line: string) => {
    logLines.push(line);
  };
  console.error = (line: string) => {
    errorLines.push(line);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

describe("logger", () => {
  it("at LOG_LEVEL=warn, suppresses debug/info and emits warn/error with scope, level, message, fields", () => {
    process.env.LOG_LEVEL = "warn";
    const log = logger("myscope");

    log.debug("a debug message");
    log.info("an info message");
    expect(logLines).toEqual([]);
    expect(errorLines).toEqual([]);

    log.warn("something odd", { count: 3 });
    expect(logLines).toEqual([]); // warn never goes to stdout
    expect(errorLines).toHaveLength(1);
    const line = errorLines[0]!;
    expect(line).toContain("[myscope]");
    expect(line).toContain("WARN");
    expect(line).toContain("something odd");
    expect(line).toContain("count=3");

    log.error("boom");
    expect(errorLines).toHaveLength(2);
  });

  it("at LOG_LEVEL=silent, suppresses every level", () => {
    process.env.LOG_LEVEL = "silent";
    const log = logger("myscope");

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(logLines).toEqual([]);
    expect(errorLines).toEqual([]);
  });

  it("at LOG_LEVEL=debug, emits debug lines", () => {
    process.env.LOG_LEVEL = "debug";
    const log = logger("myscope");

    log.debug("verbose detail");

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("DEBUG");
    expect(logLines[0]).toContain("verbose detail");
  });

  it("routes debug/info to console.log (stdout) and warn/error to console.error (stderr)", () => {
    process.env.LOG_LEVEL = "debug";
    const log = logger("routing");

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(logLines).toHaveLength(2); // debug + info
    expect(errorLines).toHaveLength(2); // warn + error
  });

  it("falls back to info for an unrecognized LOG_LEVEL value", () => {
    process.env.LOG_LEVEL = "verbose-nonsense";
    const log = logger("fallback");

    log.debug("hidden");
    log.info("shown");

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("shown");
  });

  it("re-reads LOG_LEVEL on every call instead of caching it at creation", () => {
    const log = logger("dynamic");

    process.env.LOG_LEVEL = "silent";
    log.info("hidden while silent");
    expect(logLines).toEqual([]);

    process.env.LOG_LEVEL = "debug";
    log.debug("now visible");
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("now visible");
  });

  it("formats the line as `<iso-ts> <LEVEL padded to 5> [scope] message fields`", () => {
    process.env.LOG_LEVEL = "info";
    const log = logger("fmtscope");

    log.info("hello", { a: 1, b: "x", c: true });

    expect(logLines).toHaveLength(1);
    const line = logLines[0]!;
    const match = line.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.{5}) \[fmtscope\] hello a=1 b=x c=true$/,
    );
    expect(match).not.toBeNull();
    expect(match![2]).toBe("INFO "); // padEnd(5): 4 letters + 1 pad space
    expect(Number.isNaN(new Date(match![1]!).getTime())).toBe(false);
  });

  it("renders no trailing text when fields are omitted", () => {
    process.env.LOG_LEVEL = "info";
    const log = logger("fmt");

    log.info("no fields here");

    expect(logLines).toHaveLength(1);
    expect(logLines[0]!.endsWith("no fields here")).toBe(true);
  });
});
