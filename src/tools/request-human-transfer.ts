import { tool } from '@livekit/agents';
import { z } from 'zod';
import { getAppConfig } from '../config/index.ts';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import {
  type CallRepository,
  InMemoryCallRepository,
  PostgresCallRepository,
} from '../repositories/lead-repository.ts';

export const requestHumanTransferParameters = z.object({
  reason: z
    .string()
    .optional()
    .describe('A short reason why the caller wants to speak with a human, if known.'),
});

export function createRequestHumanTransferTool(
  context: BusinessContext,
  callRepository?: CallRepository,
) {
  return tool({
    name: 'requestHumanTransfer',

    description: `
      Handle a caller request to speak with a human representative.
      Live transfer is currently unavailable. Never pretend a transfer happened.
      If transferAvailable is false, explain briefly and offer to save contact details via captureLead.
      Never promise someone will call back unless a verified system confirms it.
    `,

    parameters: requestHumanTransferParameters,

    execute: async ({ reason }) => {
      logger.info('human_transfer.requested', {
        businessId: context.businessId,
        hasReason: Boolean(reason),
        transferAvailable: false,
      });

      if (callRepository) {
        try {
          await callRepository.recordHumanTransferRequest(context, reason ?? null);
        } catch (error) {
          logger.warn('human_transfer.audit_failed', {
            businessId: context.businessId,
            error,
          });
        }
      }

      return {
        success: false,
        transferAvailable: false,
        transferred: false,
        reason: reason ?? null,
        canCaptureLead: true,
        message:
          'Live human transfer is not currently available. Do not pretend a transfer occurred. You may offer to save the caller contact details for the team.',
      };
    },
  });
}

function createDefaultCallRepository(): CallRepository {
  return getAppConfig().database.isPostgresConfigured
    ? new PostgresCallRepository()
    : new InMemoryCallRepository();
}

export const requestHumanTransfer = createRequestHumanTransferTool(
  { businessId: NORTHSTAR_BUSINESS_ID },
  createDefaultCallRepository(),
);
