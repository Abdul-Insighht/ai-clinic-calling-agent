import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scenariosDir = resolve(import.meta.dirname, '../scenarios');

describe('Phase 7 & 10 — Receptionist simulation scenario suite', () => {
  it('contains all 10 required scenario suites including interruption coverage', async () => {
    const files = await readdir(scenariosDir);
    const expectedFiles = [
      'greeting.yaml',
      'business-information.yaml',
      'pricing.yaml',
      'availability.yaml',
      'booking-success.yaml',
      'booking-failure.yaml',
      'duplicate-booking.yaml',
      'human-request.yaml',
      'interruption.yaml',
      'privacy.yaml',
    ];

    for (const file of expectedFiles) {
      expect(files).toContain(file);
      const content = await readFile(join(scenariosDir, file), 'utf8');
      expect(content).toContain('scenarios:');
      expect(content).toContain('agent_expectations:');
    }
  });
});
