import { describe, expect, it } from 'vitest';
import { buildAppConfig } from '../../src/config/index.ts';
import { runHealthCheck } from '../../src/health.ts';

describe('Phase 1 — Centralized configuration and health checks', () => {
  it('loads safe defaults in development and test environments', () => {
    const config = buildAppConfig({ NODE_ENV: 'test' });

    expect(config.nodeEnv).toBe('test');
    expect(config.gemini.model).toBe('gemini-2.5-flash-native-audio-preview-12-2025');
    expect(config.gemini.voice).toBe('Puck');
    expect(config.livekit.agentName).toBe('ai-receptionist');
    expect(config.calendar.timeZone).toBe('America/Chicago');
    expect(config.calendar.credentialSource).toBe('none');
  });

  it('fails fast in production when required credentials are missing', () => {
    expect(() =>
      buildAppConfig({
        NODE_ENV: 'production',
      }),
    ).toThrow(/Missing required production environment variables/);
  });

  it('accepts valid production configuration and detects env_pair calendar source', () => {
    const config = buildAppConfig({
      NODE_ENV: 'production',
      LIVEKIT_URL: 'wss://example.livekit.cloud',
      LIVEKIT_API_KEY: 'lk-key',
      LIVEKIT_API_SECRET: 'lk-secret',
      GOOGLE_API_KEY: 'google-key',
      GOOGLE_CALENDAR_ID: 'primary',
      GOOGLE_CALENDAR_CLIENT_EMAIL: 'svc@example.iam.gserviceaccount.com',
      GOOGLE_CALENDAR_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    });

    expect(config.livekit.isConfigured).toBe(true);
    expect(config.gemini.isConfigured).toBe(true);
    expect(config.calendar.isConfigured).toBe(true);
    expect(config.calendar.credentialSource).toBe('env_pair');
  });

  it('reports health status without leaking secret values', async () => {
    const result = await runHealthCheck({
      env: {
        NODE_ENV: 'test',
        LIVEKIT_URL: 'wss://example.livekit.cloud',
        LIVEKIT_API_KEY: 'super-secret-lk-key',
        LIVEKIT_API_SECRET: 'super-secret-lk-secret',
        GOOGLE_API_KEY: 'super-secret-google-key',
      },
    });

    expect(result.status).toBe('ok');
    expect(result.checks.livekitConfigured).toBe(true);
    expect(result.checks.geminiConfigured).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret-lk-key');
    expect(serialized).not.toContain('super-secret-lk-secret');
    expect(serialized).not.toContain('super-secret-google-key');
  });
});
