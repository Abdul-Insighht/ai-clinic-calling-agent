import { getAppConfig } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import {
  InMemoryLeadRepository,
  type LeadRepository,
  PostgresLeadRepository,
} from '../repositories/lead-repository.ts';
import { normalizePhoneNumber } from './booking-service.ts';

const INVALID_PLACEHOLDERS = new Set([
  '',
  'unknown',
  'not known',
  'not provided',
  'none',
  'n/a',
  'na',
  'null',
  'undefined',
]);

function isInvalidPlaceholder(value: string): boolean {
  return INVALID_PLACEHOLDERS.has(value.trim().toLowerCase());
}

export type CaptureLeadInput = {
  name: string;
  phone: string;
  reason: string;
  location?: string;
  preferredTime?: string;
  consentGiven?: boolean;
};

export type CaptureLeadResult =
  | {
    success: true;
    leadId: string;
    deduplicated: boolean;
    message: string;
  }
  | {
    success: false;
    error: 'INVALID_NAME' | 'INVALID_PHONE' | 'INVALID_REASON' | 'STORAGE_ERROR';
    message: string;
  };

export class LeadService {
  private readonly repository: LeadRepository;

  constructor(repository: LeadRepository) {
    this.repository = repository;
  }

  async captureLead(context: BusinessContext, input: CaptureLeadInput): Promise<CaptureLeadResult> {
    if (isInvalidPlaceholder(input.name)) {
      logger.warn('lead.capture.rejected', {
        businessId: context.businessId,
        error: 'INVALID_NAME',
      });
      return {
        success: false,
        error: 'INVALID_NAME',
        message: 'The caller name has not been properly provided or confirmed.',
      };
    }

    if (isInvalidPlaceholder(input.phone)) {
      logger.warn('lead.capture.rejected', {
        businessId: context.businessId,
        error: 'INVALID_PHONE',
      });
      return {
        success: false,
        error: 'INVALID_PHONE',
        message: 'The caller phone number has not been properly provided or confirmed.',
      };
    }

    const phoneE164 = normalizePhoneNumber(input.phone);
    if (!phoneE164) {
      logger.warn('lead.capture.rejected', {
        businessId: context.businessId,
        error: 'PHONE_TOO_SHORT',
      });
      return {
        success: false,
        error: 'INVALID_PHONE',
        message:
          'The caller phone number appears incomplete. Ask the caller to provide and confirm the complete number.',
      };
    }

    if (isInvalidPlaceholder(input.reason)) {
      logger.warn('lead.capture.rejected', {
        businessId: context.businessId,
        error: 'INVALID_REASON',
      });
      return {
        success: false,
        error: 'INVALID_REASON',
        message: 'The reason for the call has not been properly collected.',
      };
    }

    try {
      const { lead, deduplicated } = await this.repository.upsertLead(context, {
        customerName: input.name.trim(),
        phoneE164,
        reason: input.reason.trim(),
        location: input.location?.trim() || null,
        preferredTime: input.preferredTime?.trim() || null,
        consentGiven: input.consentGiven ?? true,
      });

      logger.info('lead.capture.succeeded', {
        businessId: context.businessId,
        leadId: lead.id,
        deduplicated,
        hasLocation: Boolean(lead.location),
        hasPreferredTime: Boolean(lead.preferredTime),
      });

      return {
        success: true,
        leadId: lead.id,
        deduplicated,
        message: 'Lead information was saved successfully. No additional action is implied.',
      };
    } catch (error) {
      logger.error('lead.capture.storage_failed', {
        businessId: context.businessId,
        error,
      });

      return {
        success: false,
        error: 'STORAGE_ERROR',
        message:
          'The caller details could not be saved right now. Do not tell the caller their details were saved.',
      };
    }
  }
}

export function createDefaultLeadService(): LeadService {
  const config = getAppConfig();
  return new LeadService(
    config.database.isPostgresConfigured
      ? new PostgresLeadRepository()
      : new InMemoryLeadRepository(),
  );
}
