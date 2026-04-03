import { inspect } from 'util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

type LogSink = (level: LogLevel, line: string) => void;

const REDACTED_KEYS = [
  'authorization',
  'cookie',
  'cookies',
  'password',
  'token',
  'secret',
  'body',
  'set-cookie',
];

const defaultSink: LogSink = (level, line) => {
  if (level === 'error' || level === 'warn') {
    console.error(line);
    return;
  }
  console.log(line);
};

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause === undefined ? undefined : serializeValue(error.cause),
    };
  }

  return {
    type: typeof error,
    value: serializeValue(error),
  };
}

function redactValue(key: string, value: unknown): unknown {
  if (REDACTED_KEYS.includes(key.toLowerCase())) {
    return '[REDACTED]';
  }
  return value;
}

function serializeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry, seen));
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    result[key] = serializeValue(redactValue(key, entry), seen);
  }
  return result;
}

function safeStringify(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(serializeValue(entry));
  } catch (error) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'Failed to serialize log entry',
      event: 'logger.serialize_failure',
      error: inspect(error, { breakLength: Infinity }),
      fallback: inspect(entry, { depth: 5, breakLength: Infinity }),
    });
  }
}

export function createLogger(sink: LogSink = defaultSink): Logger {
  const write = (level: LogLevel, message: string, context: LogContext = {}) => {
    const serializedContext = serializeValue(context);
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(serializedContext && typeof serializedContext === 'object' && !Array.isArray(serializedContext)
        ? serializedContext
        : { context: serializedContext }),
    };
    sink(level, safeStringify(entry));
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
}

export const logger = createLogger();
