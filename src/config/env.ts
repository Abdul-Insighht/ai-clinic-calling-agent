import dotenv from 'dotenv';
import { z } from 'zod';

let envLoaded = false;

export function loadEnvironmentFiles(): void {
  if (envLoaded) {
    return;
  }
  dotenv.config({ path: '.env.local' });
  dotenv.config();
  envLoaded = true;
}

const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');
const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']).default('info');

const rawEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,

  LIVEKIT_URL: z.string().trim().optional(),
  LIVEKIT_API_KEY: z.string().trim().optional(),
  LIVEKIT_API_SECRET: z.string().trim().optional(),
  LIVEKIT_AGENT_NAME: z.string().trim().min(1).default('ai-receptionist'),

  GOOGLE_API_KEY: z.string().trim().optional(),
  GEMINI_LIVE_MODEL: z
    .string()
    .trim()
    .min(1)
    .default('gemini-2.5-flash-native-audio-preview-12-2025'),
  GEMINI_VOICE: z
    .enum(['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'])
    .default('Puck'),
  GEMINI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.8),

  GOOGLE_CALENDAR_ID: z.string().trim().optional(),
  GOOGLE_CALENDAR_TIME_ZONE: z.string().trim().min(1).default('America/Chicago'),
  GOOGLE_CALENDAR_CLIENT_EMAIL: z.string().trim().optional(),
  GOOGLE_CALENDAR_PRIVATE_KEY: z.string().trim().optional(),
  GOOGLE_CALENDAR_CREDENTIALS_JSON: z.string().trim().optional(),
  GOOGLE_CALENDAR_CREDENTIALS_PATH: z.string().trim().optional(),

  DATABASE_URL: z.string().trim().optional(),
  REDIS_URL: z.string().trim().optional(),

  JWT_ACCESS_SECRET: z.string().trim().optional(),
  JWT_REFRESH_SECRET: z.string().trim().optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().trim().optional(),
  OTEL_SERVICE_NAME: z.string().trim().min(1).default('aibitsol-ai-receptionist'),
});

export type ParsedEnv = z.infer<typeof rawEnvSchema>;

function normalizeEmptyToUndefined(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    normalized[key] = value === '' ? undefined : value;
  }
  return normalized;
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): ParsedEnv {
  const parsed = rawEnvSchema.safeParse(normalizeEmptyToUndefined(source));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export function validateProductionEnv(env: ParsedEnv): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }

  const missing: string[] = [];
  if (!env.LIVEKIT_URL) missing.push('LIVEKIT_URL');
  if (!env.LIVEKIT_API_KEY) missing.push('LIVEKIT_API_KEY');
  if (!env.LIVEKIT_API_SECRET) missing.push('LIVEKIT_API_SECRET');
  if (!env.GOOGLE_API_KEY) missing.push('GOOGLE_API_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(', ')}`,
    );
  }
}
