import { fileURLToPath } from 'node:url';
import { type AppConfig, buildAppConfig, loadEnvironmentFiles } from './config/index.ts';
import { logger } from './lib/logger.ts';
import { testGoogleCalendarConnection } from './services/google-calendar-adapter.ts';

export type HealthCheckResult = {
  status: 'ok' | 'degraded';
  nodeVersion: string;
  environment: AppConfig['nodeEnv'];
  checks: {
    livekitConfigured: boolean;
    geminiConfigured: boolean;
    geminiModel: string;
    geminiVoice: string;
    calendarConfigured: boolean;
    calendarCredentialSource: AppConfig['calendar']['credentialSource'];
    calendarConnection?: 'ok' | 'failed' | 'skipped';
    postgresConfigured: boolean;
    redisConfigured: boolean;
  };
};

export async function runHealthCheck(
  options: { checkCalendarConnection?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<HealthCheckResult> {
  const config = buildAppConfig(options.env ?? process.env);

  let calendarConnection: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (options.checkCalendarConnection && config.calendar.isConfigured) {
    try {
      await testGoogleCalendarConnection();
      calendarConnection = 'ok';
    } catch (error) {
      logger.error('health.calendar.failed', { error });
      calendarConnection = 'failed';
    }
  }

  const healthy =
    config.livekit.isConfigured &&
    config.gemini.isConfigured &&
    calendarConnection !== 'failed';

  return {
    status: healthy ? 'ok' : 'degraded',
    nodeVersion: process.version,
    environment: config.nodeEnv,
    checks: {
      livekitConfigured: config.livekit.isConfigured,
      geminiConfigured: config.gemini.isConfigured,
      geminiModel: config.gemini.model,
      geminiVoice: config.gemini.voice,
      calendarConfigured: config.calendar.isConfigured,
      calendarCredentialSource: config.calendar.credentialSource,
      calendarConnection,
      postgresConfigured: config.database.isPostgresConfigured,
      redisConfigured: config.database.isRedisConfigured,
    },
  };
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  loadEnvironmentFiles();
  const checkCalendar = process.argv.includes('--check-calendar');
  const result = await runHealthCheck({ checkCalendarConnection: checkCalendar });
  logger.info('health.check.completed', result);
  if (result.status !== 'ok') {
    process.exitCode = 1;
  }
}
