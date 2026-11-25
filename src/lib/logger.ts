const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'customername',
  'name',
  'phone',
  'phone_e164',
  'phonenumber',
  'email',
  'reason',
  'location',
  'preferredtime',
  'address',
  'password',
  'passwordhash',
  'password_hash',
  'authorization',
  'cookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'client_email',
]);

const PEM_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PHONE_LIKE_PATTERN = /(?<!\w)(?:\+?\d[\d\s().-]{6,}\d)(?!\w)/g;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function sanitizeString(value: string): string {
  return value.replace(PEM_KEY_PATTERN, REDACTED).replace(PHONE_LIKE_PATTERN, REDACTED);
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[MAX_DEPTH]';
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = redactValue(entry, depth + 1);
      }
    }
    return result;
  }

  return String(value);
}

export type LogSink = (line: string) => void;

export type LoggerOptions = {
  level?: LogLevel;
  sink?: LogSink;
  errorSink?: LogSink;
};

function resolveDefaultLevel(): LogLevel {
  const raw = process.env['LOG_LEVEL']?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

export function createLogger(options: LoggerOptions = {}) {
  const minPriority = LOG_LEVEL_PRIORITY[options.level ?? resolveDefaultLevel()];
  const sink: LogSink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const errorSink: LogSink = options.errorSink ?? ((line) => process.stderr.write(`${line}\n`));

  function write(level: LogLevel, event: string, context?: Record<string, unknown>) {
    if (LOG_LEVEL_PRIORITY[level] < minPriority) {
      return;
    }

    const payload: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      event: sanitizeString(event),
    };

    if (context) {
      payload['context'] = redactValue(context);
    }

    const serialized = JSON.stringify(payload);
    if (level === 'error' || level === 'warn') {
      errorSink(serialized);
    } else {
      sink(serialized);
    }
  }

  return {
    debug: (event: string, context?: Record<string, unknown>) => write('debug', event, context),
    info: (event: string, context?: Record<string, unknown>) => write('info', event, context),
    warn: (event: string, context?: Record<string, unknown>) => write('warn', event, context),
    error: (event: string, context?: Record<string, unknown>) => write('error', event, context),
  };
}

export const logger = createLogger();
