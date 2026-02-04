/**
 * Lightweight logger for standalone scripts
 * Issue #607 - Local Development Environment
 *
 * This provides consistent logging for db scripts without the full
 * Winston/async_hooks complexity of the main logger.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS = {
  reset: "\u001B[0m",
  dim: "\u001B[2m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  blue: "\u001B[34m",
  cyan: "\u001B[36m",
};

function getMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVELS) {
    return env as LogLevel;
  }
  return "info";
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = formatTimestamp();
  const levelColors: Record<LogLevel, string> = {
    debug: COLORS.dim,
    info: COLORS.green,
    warn: COLORS.yellow,
    error: COLORS.red,
  };

  const color = levelColors[level];
  const levelStr = level.toUpperCase().padEnd(5);

  let output = `${COLORS.dim}${timestamp}${COLORS.reset} ${color}${levelStr}${COLORS.reset} ${message}`;

  if (meta && Object.keys(meta).length > 0) {
    output += ` ${COLORS.cyan}${JSON.stringify(meta)}${COLORS.reset}`;
  }

  return output;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[getMinLevel()];
}

export const scriptLogger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog("debug")) {
      process.stdout.write(formatMessage("debug", message, meta) + "\n");
    }
  },

  info(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog("info")) {
      process.stdout.write(formatMessage("info", message, meta) + "\n");
    }
  },

  warn(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog("warn")) {
      process.stderr.write(formatMessage("warn", message, meta) + "\n");
    }
  },

  error(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog("error")) {
      process.stderr.write(formatMessage("error", message, meta) + "\n");
    }
  },

  /** Log a success message (green checkmark) */
  success(message: string): void {
    process.stdout.write(`${COLORS.green}✓${COLORS.reset} ${message}\n`);
  },

  /** Log a failure message (red X) */
  fail(message: string): void {
    process.stderr.write(`${COLORS.red}✗${COLORS.reset} ${message}\n`);
  },

  /** Log a section header */
  section(title: string): void {
    const line = "=".repeat(50);
    process.stdout.write(`\n${COLORS.cyan}${line}${COLORS.reset}\n`);
    process.stdout.write(`${COLORS.cyan}${title}${COLORS.reset}\n`);
    process.stdout.write(`${COLORS.cyan}${line}${COLORS.reset}\n\n`);
  },
};

export default scriptLogger;
