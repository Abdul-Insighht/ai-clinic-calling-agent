import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { loadEnvironmentFiles } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import { closeDbPool, getDbPool } from './client.ts';

const migrationsDir = resolve(import.meta.dirname, 'migrations');

export async function runMigrations(targetPool: Pool = getDbPool()): Promise<string[]> {
  const client = await targetPool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS aibitsol');
    await client.query('SET search_path TO aibitsol, public');
    await client.query(`
      CREATE TABLE IF NOT EXISTS aibitsol.schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const existing = await client.query<{ filename: string }>(
      'SELECT filename FROM aibitsol.schema_migrations',
    );
    const appliedSet = new Set(existing.rows.map((row) => row.filename));

    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      if (appliedSet.has(file)) {
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO aibitsol.schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedNow.push(file);
        logger.info('db.migration.applied', { file });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return appliedNow;
  } finally {
    client.release();
  }
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  loadEnvironmentFiles();
  try {
    const applied = await runMigrations();
    logger.info('db.migrations.completed', { appliedCount: applied.length, applied });
  } finally {
    await closeDbPool();
  }
}
