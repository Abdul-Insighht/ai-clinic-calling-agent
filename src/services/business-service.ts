import { demoBusiness } from '../business/demo-business.ts';
import { getAppConfig } from '../config/index.ts';
import type { BusinessContext, BusinessProfile, VerifiedPricingRule } from '../models/business.ts';
import {
  type BusinessRepository,
  InMemoryBusinessRepository,
  PostgresBusinessRepository,
} from '../repositories/business-repository.ts';

export type BusinessInfoTopic =
  | 'general'
  | 'hours'
  | 'services'
  | 'serviceAreas'
  | 'location'
  | 'pricing'
  | 'emergency';

const PROFILE_CACHE_TTL_MS = 60_000;

export class BusinessService {
  private readonly repository: BusinessRepository;
  private readonly profileCache = new Map<string, { expiresAt: number; profile: BusinessProfile }>();

  constructor(repository: BusinessRepository) {
    this.repository = repository;
  }

  async getBusinessProfile(context: BusinessContext): Promise<BusinessProfile> {
    const cached = this.profileCache.get(context.businessId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.profile;
    }

    const profile = await this.repository.getBusinessProfile(context);
    if (!profile) {
      throw new Error('Business profile not found.');
    }

    this.profileCache.set(context.businessId, {
      expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
      profile,
    });
    return profile;
  }

  invalidateProfileCache(businessId?: string): void {
    if (businessId) {
      this.profileCache.delete(businessId);
    } else {
      this.profileCache.clear();
    }
  }

  async getVerifiedInformation(
    context: BusinessContext,
    topic: BusinessInfoTopic = 'general',
  ): Promise<Record<string, unknown>> {
    const profile = await this.getBusinessProfile(context);
    const verifiedPricing: VerifiedPricingRule[] = (profile.pricingRules ?? []).filter(
      (rule) => rule.isVerified,
    );

    switch (topic) {
      case 'hours':
        return {
          hours: profile.hours,
          timezone: profile.timezone,
        };

      case 'services':
        return {
          services: profile.services,
        };

      case 'serviceAreas':
      case 'location':
        return {
          location: profile.location,
          serviceAreas: profile.serviceAreas,
        };

      case 'pricing':
        return {
          pricingPolicy: profile.pricingPolicy,
          verifiedPricing,
        };

      case 'emergency':
        return {
          emergencyPolicy: profile.emergencyPolicy,
        };

      case 'general':
      default:
        return {
          name: profile.name,
          description: profile.description,
          location: profile.location,
          timezone: profile.timezone,
          serviceAreas: profile.serviceAreas,
          hours: profile.hours,
          services: profile.services,
          pricingPolicy: profile.pricingPolicy,
          verifiedPricing,
          emergencyPolicy: profile.emergencyPolicy,
        };
    }
  }
}

export function createDefaultBusinessService(): BusinessService {
  const config = getAppConfig();
  if (config.database.isPostgresConfigured) {
    return new BusinessService(new PostgresBusinessRepository());
  }

  return new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
}
