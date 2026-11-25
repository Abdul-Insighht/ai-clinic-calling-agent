import { describe, expect, it } from 'vitest';
import { buildReceptionistPrompt } from '../../src/agent/prompt.ts';
import { demoBusiness } from '../../src/business/demo-business.ts';
import type { BusinessProfile } from '../../src/models/business.ts';

describe('Phase 2 — English-only structured receptionist prompt', () => {
  const prompt = buildReceptionistPrompt(demoBusiness);

  it('contains all 11 required structured sections', () => {
    const requiredSections = [
      '1. IDENTITY',
      '2. ENGLISH-ONLY LANGUAGE POLICY',
      '3. CONVERSATION STYLE',
      '4. BUSINESS KNOWLEDGE RULES',
      '5. TOOL USAGE RULES',
      '6. APPOINTMENT AVAILABILITY',
      '7. BOOKING CONFIRMATION',
      '8. PRICING POLICY',
      '9. EMERGENCY HANDLING',
      '10. HUMAN TRANSFER',
      '11. PRIVACY AND SECURITY',
    ];

    for (const section of requiredSections) {
      expect(prompt).toContain(section);
    }
  });

  it('enforces English-only conversations without language switching', () => {
    expect(prompt).toContain('Conduct all conversations in English only.');
    expect(prompt).toContain('Do not attempt translations or switch languages.');
    expect(prompt.toLowerCase()).not.toContain('unless the caller clearly asks to speak another');
  });

  it('preserves critical booking, lead, pricing, and emergency safety rules', () => {
    expect(prompt).toContain('success: true');
    expect(prompt).toContain('Checking availability does NOT reserve a slot.');
    expect(prompt).toContain('Never promise or imply that someone will call');
    expect(prompt).toContain('Never pass placeholder values');
    expect(prompt).toContain('Never invent prices');
    expect(prompt).toContain('gas smell');
  });

  it('dynamically hydrates any tenant business profile', () => {
    const customBusiness: BusinessProfile = {
      name: 'Apex Plumbing Co',
      receptionistName: 'Clara',
      description: 'Residential plumbing and drain services.',
      location: 'Austin, Texas',
      serviceAreas: ['Austin', 'Round Rock'],
      hours: {
        monday: '7 AM to 5 PM',
        tuesday: '7 AM to 5 PM',
        wednesday: '7 AM to 5 PM',
        thursday: '7 AM to 5 PM',
        friday: '7 AM to 5 PM',
        saturday: 'Closed',
        sunday: 'Closed',
      },
      services: ['Leak repair', 'Drain cleaning'],
      emergencyPolicy: 'Shut off main water valve for active flooding.',
      pricingPolicy: 'Provide verified flat-rate diagnostic fee only.',
      appointmentDurationMinutes: 45,
    };

    const customPrompt = buildReceptionistPrompt(customBusiness);
    expect(customPrompt).toContain('Apex Plumbing Co');
    expect(customPrompt).toContain('Clara');
    expect(customPrompt).toContain('Austin, Texas');
    expect(customPrompt).not.toContain('NorthStar Heating & Air');
  });

  it('stays concise compared to the legacy 1000-line prompt', () => {
    expect(prompt.length).toBeLessThan(6500);
    expect(prompt.split('\n').length).toBeLessThan(90);
  });
});
