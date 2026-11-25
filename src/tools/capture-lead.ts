import { tool } from '@livekit/agents';
import { z } from 'zod';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import type { BusinessContext } from '../models/business.ts';
import { createDefaultLeadService, type LeadService } from '../services/lead-service.ts';

export const captureLeadParameters = z.object({
  name: z
    .string()
    .describe('The caller name exactly as confirmed by the caller. Never use a placeholder.'),
  phone: z
    .string()
    .describe(
      'The caller phone number exactly as confirmed by the caller. Never use unknown or another placeholder.',
    ),
  reason: z.string().describe('A short summary of why the caller contacted the business.'),
  location: z
    .string()
    .optional()
    .describe('The caller city, ZIP code, or service location if provided.'),
  preferredTime: z
    .string()
    .optional()
    .describe('The caller preferred appointment time if provided before lead capture.'),
});

export function createCaptureLeadTool(
  context: BusinessContext,
  leadService: LeadService = createDefaultLeadService(),
) {
  return tool({
    name: 'captureLead',

    description: `
      Save a new customer lead only after caller name, phone number, and reason
      for the call have been collected. Never send placeholder values such as
      unknown, not provided, N/A, or none.
      This tool only saves lead details; it does not book an appointment or guarantee a callback.
      Never tell the caller their details were saved unless this tool returns success: true.
    `,

    parameters: captureLeadParameters,

    execute: async ({ name, phone, reason, location, preferredTime }) => {
      return leadService.captureLead(context, {
        name,
        phone,
        reason,
        ...(location ? { location } : {}),
        ...(preferredTime ? { preferredTime } : {}),
      });
    },
  });
}

export const captureLead = createCaptureLeadTool({
  businessId: NORTHSTAR_BUSINESS_ID,
});
