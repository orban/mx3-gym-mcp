export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(password|passwd|secret|token|cookie|authorization|credential|body)/i;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
  error?: SerializedError;
}

export type LogWriter = (entry: LogEntry) => void;

export interface Logger {
  debug(event: string, message: string, context?: Record<string, unknown>): void;
  info(event: string, message: string, context?: Record<string, unknown>): void;
  warn(event: string, message: string, context?: Record<string, unknown>): void;
  error(event: string, message: string, error?: unknown, context?: Record<string, unknown>): void;
}

interface CreateLoggerOptions {
  level?: LogLevel;
  writer?: LogWriter;
}

function normalizeLevel(level?: string): LogLevel {
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    return level;
  }
  return 'info';
}

function shouldLog(minLevel: LogLevel, level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: 'NonError',
    message: typeof error === 'string' ? error : JSON.stringify(error),
  };
}

function sanitizeValue(key: string, value: unknown, depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;

  if (value instanceof Error) return serializeError(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

  if (depth >= 4) return '[MAX_DEPTH]';

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(key, item, depth + 1));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(obj)) {
      sanitized[childKey] = sanitizeValue(childKey, childValue, depth + 1);
    }
    return sanitized;
  }

  return String(value);
}

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    sanitized[key] = sanitizeValue(key, value);
  }
  return sanitized;
}

function defaultWriter(entry: LogEntry): void {
  console.error(JSON.stringify(entry));
}

export function createLogger(component: string, options: CreateLoggerOptions = {}): Logger {
  const minLevel = options.level ?? normalizeLevel(process.env.LOG_LEVEL);
  const writer = options.writer ?? defaultWriter;

  function emit(level: LogLevel, event: string, message: string, context?: Record<string, unknown>, error?: unknown): void {
    if (!shouldLog(minLevel, level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      event,
      message,
      context: sanitizeContext(context),
    };

    if (error !== undefined) {
      entry.error = serializeError(error);
    }

    writer(entry);
  }

  return {
    debug(event, message, context) {
      emit('debug', event, message, context);
    },
    info(event, message, context) {
      emit('info', event, message, context);
    },
    warn(event, message, context) {
      emit('warn', event, message, context);
    },
    error(event, message, error, context) {
      emit('error', event, message, context, error);
    },
  };
}
