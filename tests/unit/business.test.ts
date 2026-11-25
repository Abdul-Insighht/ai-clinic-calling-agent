import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoBusiness } from '../../src/business/demo-business.ts';
import { NORTHSTAR_BUSINESS_ID } from '../../src/db/seed.ts';
import type { BusinessProfile } from '../../src/models/business.ts';
import { InMemoryBusinessRepository } from '../../src/repositories/business-repository.ts';
import { BusinessService } from '../../src/services/business-service.ts';
import { getBusinessInformationParameters } from '../../src/tools/get-business-information.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

const businessWithPricing: BusinessProfile = {
  ...demoBusiness,
  pricingRules: [
    {
      id: 'rule-verified',
      serviceId: null,
      label: 'Standard diagnostic fee',
      pricingType: 'fixed',
      amountCents: 7900,
      maxAmountCents: null,
      currency: 'USD',
      notes: 'Waived with repair',
      isVerified: true,
    },
    {
      id: 'rule-unverified',
      serviceId: null,
      label: 'Draft replacement estimate',
      pricingType: 'range',
      amountCents: 50000,
      maxAmountCents: 150000,
      currency: 'USD',
      notes: 'Internal draft only',
      isVerified: false,
    },
  ],
};

describe('Phase 3 — Single-business PostgreSQL schema and business service', () => {
  const repository = new InMemoryBusinessRepository([businessWithPricing]);
  const service = new BusinessService(repository);

  it('returns verified business profile for the configured businessId', async () => {
    const info = await service.getVerifiedInformation(
      { businessId: NORTHSTAR_BUSINESS_ID },
      'general',
    );
    expect(info['name']).toBe('NorthStar Heating & Air');
    expect(info['timezone']).toBe('America/Chicago');

    await expect(
      service.getVerifiedInformation({ businessId: '00000000-0000-0000-0000-000000000000' }, 'general'),
    ).rejects.toThrow(/Business profile not found/);
  });

  it('returns only verified pricing rules and filters out unverified drafts', async () => {
    const pricing = await service.getVerifiedInformation(
      { businessId: NORTHSTAR_BUSINESS_ID },
      'pricing',
    );

    const verifiedPricing = pricing['verifiedPricing'] as Array<{ id: string }>;
    expect(verifiedPricing).toHaveLength(1);
    expect(verifiedPricing[0]?.id).toBe('rule-verified');
  });

  it('never accepts businessId as an LLM tool argument', () => {
    const shape = getBusinessInformationParameters.shape;
    expect('businessId' in shape).toBe(false);
    expect('topic' in shape).toBe(true);
  });

  it('defines single-business tables with business_id and overlap exclusion constraint', async () => {
    const schemaSql = await readFile(
      join(repoRoot, 'src', 'db', 'migrations', '001_initial_schema.sql'),
      'utf8',
    );

    const requiredTables = [
      'businesses',
      'users',
      'business_hours',
      'services',
      'service_areas',
      'pricing_rules',
      'appointments',
      'leads',
      'calls',
      'audit_logs',
      'calendar_sync_jobs',
    ];

    for (const table of requiredTables) {
      expect(schemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(schemaSql).not.toContain('CREATE TABLE IF NOT EXISTS tenants');
    expect(schemaSql).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
    expect(schemaSql).toContain('EXCLUDE USING gist');
    expect(schemaSql).toContain('UNIQUE (business_id, idempotency_key)');
  });
});
