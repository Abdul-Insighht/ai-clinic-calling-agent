import { type CalendarConfig, buildCalendarConfig } from './calendar.ts';
import { type DatabaseConfig, buildDatabaseConfig } from './database.ts';
import { type ParsedEnv, loadEnvironmentFiles, parseEnv, validateProductionEnv } from './env.ts';
import { type GeminiConfig, buildGeminiConfig } from './gemini.ts';
import { type LiveKitConfig, buildLiveKitConfig } from './livekit.ts';

export type AppConfig = {
  nodeEnv: ParsedEnv['NODE_ENV'];
  logLevel: ParsedEnv['LOG_LEVEL'];
  livekit: LiveKitConfig;
  gemini: GeminiConfig;
  database: DatabaseConfig;
  calendar: CalendarConfig;
};

export function buildAppConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = parseEnv(source);
  validateProductionEnv(env);

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    livekit: buildLiveKitConfig(env),
    gemini: buildGeminiConfig(env),
    database: buildDatabaseConfig(env),
    calendar: buildCalendarConfig(env),
  };
}

let cachedConfig: AppConfig | null = null;

export function getAppConfig(): AppConfig {
  if (!cachedConfig) {
    loadEnvironmentFiles();
    cachedConfig = buildAppConfig(process.env);
  }
  return cachedConfig;
}

export function resetAppConfigCache(): void {
  cachedConfig = null;
}

export { loadEnvironmentFiles };
export type { CalendarConfig, DatabaseConfig, GeminiConfig, LiveKitConfig, ParsedEnv };
