import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('Phase 9 — Docker Compose and deployment security checks', () => {
  it('defines all required services, volumes, and healthchecks in docker-compose.yml', async () => {
    const compose = await readFile(join(repoRoot, 'docker-compose.yml'), 'utf8');

    for (const service of [
      'postgres:',
      'redis:',
      'migrate:',
      'api:',
      'agent-worker:',
      'frontend:',
      'otel-collector:',
    ]) {
      expect(compose).toContain(service);
    }

    expect(compose).toContain('postgres_data:');
    expect(compose).toContain('redis_data:');
    expect(compose).toContain('healthcheck:');
    expect(compose).toContain('stop_grace_period:');
  });

  it('runs API and agent worker images as non-root users', async () => {
    const workerDockerfile = await readFile(join(repoRoot, 'Dockerfile'), 'utf8');
    const apiDockerfile = await readFile(
      join(repoRoot, 'infrastructure', 'docker', 'Dockerfile.api'),
      'utf8',
    );
    const frontendDockerfile = await readFile(
      join(repoRoot, 'apps', 'frontend', 'Dockerfile'),
      'utf8',
    );

    expect(workerDockerfile).toContain('USER appuser');
    expect(apiDockerfile).toContain('USER appuser');
    expect(frontendDockerfile).toContain('nginxinc/nginx-unprivileged');
  });
});
