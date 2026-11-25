import { Pool, type PoolClient } from 'pg';
import { getAppConfig } from '../config/index.ts';
import { logger } from '../lib/logger.ts';

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (!pool) {
    const { databaseUrl } = getAppConfig().database;
    if (!databaseUrl) {
      throw new Error('Missing required environment variable: DATABASE_URL');
    }

    pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err) => {
      logger.warn('db.pool.idle_client_error', { error: err.message });
    });
  }

  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    const currentPool = pool;
    pool = null;
    await currentPool.end();
  }
}

export async function withReadClient<T>(
  operation: (client: PoolClient) => Promise<T>,
  targetPool: Pool = getDbPool(),
): Promise<T> {
  const client = await targetPool.connect();
  try {
    await client.query('SET search_path TO aibitsol, public');
    return await operation(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
  targetPool: Pool = getDbPool(),
): Promise<T> {
  const client = await targetPool.connect();
  let transactionStarted = false;
  let releaseError: Error | undefined;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SET LOCAL search_path TO aibitsol, public');
    const result = await operation(client);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        logger.error('db.transaction.rollback_failed', {
          error: releaseError.message,
        });
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
