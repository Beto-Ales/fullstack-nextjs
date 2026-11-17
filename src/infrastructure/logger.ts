import "server-only";

import { getEnvironment } from "@/src/infrastructure/env";

type LogLevel = "debug" | "info" | "warn" | "error";

const severityOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(currentLevel: LogLevel, incomingLevel: LogLevel): boolean {
  return severityOrder[incomingLevel] >= severityOrder[currentLevel];
}

function writeLog(level: LogLevel, message: string, metadata?: Record<string, unknown>) {
  const payload = {
    level,
    message,
    metadata,
    timestamp: new Date().toISOString(),
  };
  const content = JSON.stringify(payload);

  if (level === "debug" || level === "info") {
    console.info(content);
    return;
  }

  if (level === "warn") {
    console.warn(content);
    return;
  }

  console.error(content);
}

export const logger = {
  debug(message: string, metadata?: Record<string, unknown>) {
    const { LOG_LEVEL } = getEnvironment();
    if (shouldLog(LOG_LEVEL, "debug")) {
      writeLog("debug", message, metadata);
    }
  },
  info(message: string, metadata?: Record<string, unknown>) {
    const { LOG_LEVEL } = getEnvironment();
    if (shouldLog(LOG_LEVEL, "info")) {
      writeLog("info", message, metadata);
    }
  },
  warn(message: string, metadata?: Record<string, unknown>) {
    const { LOG_LEVEL } = getEnvironment();
    if (shouldLog(LOG_LEVEL, "warn")) {
      writeLog("warn", message, metadata);
    }
  },
  error(message: string, metadata?: Record<string, unknown>) {
    const { LOG_LEVEL } = getEnvironment();
    if (shouldLog(LOG_LEVEL, "error")) {
      writeLog("error", message, metadata);
    }
  },
};

