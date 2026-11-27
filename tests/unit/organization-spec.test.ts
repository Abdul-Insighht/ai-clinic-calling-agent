import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileNotificationLabels,
  compileOrganizationPrompt,
  summarizeOrganizationSpec,
} from '../../src/config/organization-compiler.ts';
import { parseOrganizationSpec } from '../../src/models/organization-spec.ts';

describe('Universal Single-Tenant Organization Configuration', () => {
  it('validates and compiles the active CareFirst Medical Clinic config with zero regression', () => {
    const raw = JSON.parse(
      readFileSync(resolve(process.cwd(), 'config/organization.json'), 'utf8'),
    ) as unknown;
    const parsed = parseOrganizationSpec(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const prompt = compileOrganizationPrompt(parsed.data);
    expect(prompt).toContain('CareFirst Medical Clinic');
    expect(prompt).toContain('Main Medical Plaza, City Center');
    expect(prompt).toContain('General Medical Consultation');
    expect(prompt).toContain('Refer to callers as "Patient"');
    expect(prompt).toContain('Do NOT ask for the Patient\'s home address');

    const labels = compileNotificationLabels(parsed.data);
    expect(labels.callerLabel).toBe('Patient');
    expect(labels.locationLabel).toBe('Clinic Location');
    expect(labels.askCallerAddress).toBe(false);
  });

  it('validates the blank universal master template cleanly', () => {
    const raw = JSON.parse(
      readFileSync(resolve(process.cwd(), 'config/organization.template.json'), 'utf8'),
    ) as unknown;
    const parsed = parseOrganizationSpec(raw);
    expect(parsed.success).toBe(true);
  });

  it('adapts to a completely different industry (Auto Workshop) with zero code changes', () => {
    const autoWorkshopConfig = {
      schemaVersion: '1.0',
      organization: {
        name: 'Apex Auto Care & Diagnostics',
        type: 'auto_workshop',
        description:
          'Apex Auto Care provides oil changes, brake servicing, computer engine diagnostics, and AC repair for all sedans and SUVs.',
        location: 'Industrial Area Block 4, Lahore',
        timezone: 'Asia/Karachi',
        serviceAreas: ['Gulberg', 'DHA', 'Model Town'],
      },
      businessHours: {
        monday: '9 AM to 7 PM',
        tuesday: '9 AM to 7 PM',
        wednesday: '9 AM to 7 PM',
        thursday: '9 AM to 7 PM',
        friday: '9 AM to 7 PM',
        saturday: '10 AM to 5 PM',
        sunday: 'Closed',
        afterHoursBehavior: 'capture_callback_lead',
      },
      services: [
        {
          name: 'Full Synthetic Oil Change',
          bookingType: 'service_request',
          durationMinutes: 45,
          priceDisplay: 'PKR 6,500',
          intakeQuestions: ['What is your vehicle make, model, and year?'],
        },
        {
          name: 'Brake Pad & Rotor Inspection',
          bookingType: 'service_request',
          durationMinutes: 60,
          priceDisplay: 'PKR 2,000 inspection fee',
          intakeQuestions: ['Are you hearing squeaking or grinding when braking?'],
        },
      ],
      staff: [
        {
          name: 'Ustad Tariq',
          role: 'Lead Diagnostic Technician',
          assignedServices: ['Brake Pad & Rotor Inspection'],
        },
      ],
      faqs: [
        {
          question: 'Do you service hybrid cars?',
          answer: 'Yes, we service both petrol and hybrid vehicles.',
        },
      ],
      customerInfo: {
        callerLabel: 'Customer',
        locationLabel: 'Workshop Bay',
        bookingUnit: 'Service Slot',
        fulfillmentMode: 'in_person',
        askCallerAddress: false,
      },
      escalationRules: {
        emergencyPolicy:
          'If the vehicle is smoking or leaking fuel, instruct the caller to turn off the engine immediately and call roadside assistance.',
        pricingPolicy: 'Share only listed service fees; parts replacement is quoted after inspection.',
        acceptedPaymentMethods: ['Cash', 'Card', 'JazzCash'],
      },
      aiInstructions: {
        assistantName: 'Zain',
        voice: 'Puck',
        languages: ['English', 'Urdu'],
        defaultLanguage: 'English',
        prohibitedClaims: ['Never quote exact part replacement costs before physical inspection.'],
      },
    };

    const parsed = parseOrganizationSpec(autoWorkshopConfig);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const prompt = compileOrganizationPrompt(parsed.data);
    expect(prompt).toContain('Apex Auto Care & Diagnostics');
    expect(prompt).toContain('Full Synthetic Oil Change');
    expect(prompt).toContain('What is your vehicle make, model, and year?');
    expect(prompt).toContain('Ustad Tariq');
    expect(prompt).toContain('Do you service hybrid cars?');
    expect(prompt).toContain('JazzCash');
    expect(prompt).toContain('Refer to callers as "Customer"');

    const summary = summarizeOrganizationSpec(parsed.data);
    expect(summary.industry).toBe('auto_workshop');
    expect(summary.activeServicesCount).toBe(2);
    expect(summary.staffCount).toBe(1);
    expect(summary.faqsCount).toBe(1);
  });

  it('rejects invalid organization configs with clear field paths', () => {
    const parsed = parseOrganizationSpec({
      schemaVersion: '1.0',
      organization: { name: '', type: 'clinic', description: 'short', location: '', timezone: '' },
      services: [],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors.some((e) => e.startsWith('organization.name'))).toBe(true);
    expect(parsed.errors.some((e) => e.startsWith('services'))).toBe(true);
  });
});
