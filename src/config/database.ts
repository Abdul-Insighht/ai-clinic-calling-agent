import type { ParsedEnv } from './env.ts';

export type DatabaseConfig = {
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  isPostgresConfigured: boolean;
  isRedisConfigured: boolean;
};

export function buildDatabaseConfig(env: ParsedEnv): DatabaseConfig {
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    isPostgresConfigured: Boolean(env.DATABASE_URL),
    isRedisConfigured: Boolean(env.REDIS_URL),
  };
}
