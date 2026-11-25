import { tool } from '@livekit/agents';
import { z } from 'zod';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import {
  type BusinessInfoTopic,
  type BusinessService,
  createDefaultBusinessService,
} from '../services/business-service.ts';

export const getBusinessInformationParameters = z.object({
  topic: z
    .enum(['general', 'hours', 'services', 'serviceAreas', 'location', 'pricing', 'emergency'])
    .optional()
    .describe('The type of business information the caller is asking about.'),
});

export function createGetBusinessInformationTool(
  context: BusinessContext,
  businessService: BusinessService = createDefaultBusinessService(),
) {
  return tool({
    name: 'getBusinessInformation',

    description: `
      Get verified business information for the business.

      Use this tool when the caller asks for factual information about the business,
      including business name, location, service areas, hours, services offered,
      verified pricing, pricing policy, or emergency policy.

      Do not invent services, hours, locations, prices, or policies that are not
      returned by this tool. This tool only provides business information.
    `,

    parameters: getBusinessInformationParameters,

    execute: async ({ topic }) => {
      const resolvedTopic: BusinessInfoTopic = topic ?? 'general';
      logger.info('business.info.requested', {
        businessId: context.businessId,
        topic: resolvedTopic,
      });

      try {
        const information = await businessService.getVerifiedInformation(context, resolvedTopic);

        return {
          success: true,
          topic: resolvedTopic,
          information,
          message: 'Verified business information was retrieved successfully.',
        };
      } catch (error) {
        logger.error('business.info.failed', {
          businessId: context.businessId,
          topic: resolvedTopic,
          error,
        });

        return {
          success: false,
          topic: resolvedTopic,
          information: null,
          message:
            'Verified business information could not be retrieved right now. Do not invent business details.',
        };
      }
    },
  });
}

export const getBusinessInformation = createGetBusinessInformationTool({
  businessId: NORTHSTAR_BUSINESS_ID,
});
