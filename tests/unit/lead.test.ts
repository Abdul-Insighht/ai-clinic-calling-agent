import { describe, expect, it } from 'vitest';
import { NORTHSTAR_BUSINESS_ID } from '../../src/db/seed.ts';
import {
  InMemoryLeadRepository,
  type LeadRepository,
} from '../../src/repositories/lead-repository.ts';
import { LeadService } from '../../src/services/lead-service.ts';
import { captureLeadParameters } from '../../src/tools/capture-lead.ts';

const northstarContext = {
  businessId: NORTHSTAR_BUSINESS_ID,
  callId: 'call-lead-1',
};

describe('Phase 5 — Persistent lead capture', () => {
  it('persists valid leads with normalized phone and deduplicates repeat calls within 24h', async () => {
    const repository = new InMemoryLeadRepository();
    const service = new LeadService(repository);

    const first = await service.captureLead(northstarContext, {
      name: 'Daniel Brooks',
      phone: '(214) 555-0199',
      reason: 'AC blowing warm air',
      location: 'Plano',
    });

    expect(first.success).toBe(true);
    if (first.success) {
      expect(first.deduplicated).toBe(false);
    }

    const second = await service.captureLead(northstarContext, {
      name: 'Daniel Brooks',
      phone: '214-555-0199',
      reason: 'AC blowing warm air - urgent',
      preferredTime: 'Tomorrow morning',
    });

    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.deduplicated).toBe(true);
      expect(second.leadId).toBe(first.leadId);
    }

    const northstarLeads = await repository.listLeads(northstarContext);
    expect(northstarLeads).toHaveLength(1);
    expect(northstarLeads[0]?.phoneE164).toBe('+12145550199');
    expect(northstarLeads[0]?.location).toBe('Plano');
    expect(northstarLeads[0]?.preferredTime).toBe('Tomorrow morning');
  });

  it('rejects placeholders and short phone numbers', async () => {
    const service = new LeadService(new InMemoryLeadRepository());

    const badName = await service.captureLead(northstarContext, {
      name: 'unknown',
      phone: '2145550199',
      reason: 'Need quote',
    });
    expect(badName.success).toBe(false);
    expect(!badName.success && badName.error).toBe('INVALID_NAME');

    const shortPhone = await service.captureLead(northstarContext, {
      name: 'Sara',
      phone: '12345',
      reason: 'Need quote',
    });
    expect(shortPhone.success).toBe(false);
    expect(!shortPhone.success && shortPhone.error).toBe('INVALID_PHONE');
  });

  it('never returns false success when database persistence fails', async () => {
    const failingRepo: LeadRepository = {
      async upsertLead() {
        throw new Error('PostgreSQL connection refused');
      },
      async listLeads() {
        return [];
      },
    };

    const service = new LeadService(failingRepo);
    const result = await service.captureLead(northstarContext, {
      name: 'Chris Lee',
      phone: '214-555-0188',
      reason: 'Furnace repair',
    });

    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBe('STORAGE_ERROR');
  });

  it('never exposes businessId in captureLead LLM tool parameters', () => {
    const shape = captureLeadParameters.shape;
    expect('businessId' in shape).toBe(false);
    expect('name' in shape).toBe(true);
    expect('phone' in shape).toBe(true);
    expect('reason' in shape).toBe(true);
  });
});
