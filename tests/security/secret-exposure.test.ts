import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, redactValue } from '../../src/lib/logger.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('Phase 0 — Security hygiene and PII redaction', () => {
  it('excludes secrets and credential files in .dockerignore', async () => {
    const content = await readFile(join(repoRoot, '.dockerignore'), 'utf8');
    const lines = content.split(/\r?\n/).map((line) => line.trim());

    expect(lines).toContain('.env');
    expect(lines).toContain('.env.*');
    expect(lines).toContain('!.env.example');
    expect(lines).toContain('credentials/');
    expect(lines).toContain('**/credentials/');
    expect(lines).toContain('*.pem');
    expect(lines).toContain('*.key');
    expect(lines).toContain('*service-account*.json');
  });

  it('excludes secrets and credential files in .gitignore', async () => {
    const content = await readFile(join(repoRoot, '.gitignore'), 'utf8');
    const lines = content.split(/\r?\n/).map((line) => line.trim());

    expect(lines).toContain('.env');
    expect(lines).toContain('.env.*');
    expect(lines).toContain('!.env.example');
    expect(lines).toContain('credentials/');
    expect(lines).toContain('*.pem');
    expect(lines).toContain('*.key');
    expect(lines).toContain('*service-account*.json');
  });

  it('keeps .env.example free of secret values', async () => {
    const content = await readFile(join(repoRoot, '.env.example'), 'utf8');
    const secretKeys = [
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'GOOGLE_API_KEY',
      'GOOGLE_CALENDAR_CLIENT_EMAIL',
      'GOOGLE_CALENDAR_PRIVATE_KEY',
      'GOOGLE_CALENDAR_CREDENTIALS_JSON',
      'GOOGLE_CALENDAR_CREDENTIALS_PATH',
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
    ];

    for (const key of secretKeys) {
      const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
      expect(match, `Expected ${key} in .env.example`).not.toBeNull();
      expect(match?.[1]?.trim()).toBe('');
    }
  });

  it('redacts customer PII and secrets in structured logs', () => {
    const output: string[] = [];
    const testLogger = createLogger({
      level: 'debug',
      sink: (line) => output.push(line),
      errorSink: (line) => output.push(line),
    });

    testLogger.info('test.pii', {
      customerName: 'Jane Doe',
      phone: '+1 (214) 555-0199',
      reason: 'AC stopped cooling',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
      safeSlotId: 'slot-12345',
    });

    expect(output).toHaveLength(1);
    const line = output[0] ?? '';
    expect(line).not.toContain('Jane Doe');
    expect(line).not.toContain('555-0199');
    expect(line).not.toContain('AC stopped cooling');
    expect(line).not.toContain('abc123');
    expect(line).toContain('slot-12345');

    const scrubbed = redactValue('Call customer at 214-555-0199');
    expect(scrubbed).toBe('Call customer at [REDACTED]');
  });

  it('has no raw console.log or console.error calls in tool handlers', async () => {
    const toolsDir = join(repoRoot, 'src', 'tools');
    const files = await readdir(toolsDir);
    const tsFiles = files.filter((file) => file.endsWith('.ts'));

    expect(tsFiles.length).toBeGreaterThan(0);

    for (const file of tsFiles) {
      const content = await readFile(join(toolsDir, file), 'utf8');
      expect(content, `${file} should use structured logger instead of console.*`).not.toMatch(
        /\bconsole\.(log|error|warn|info|debug)\s*\(/,
      );
    }
  });
});
