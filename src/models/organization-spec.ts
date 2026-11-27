import { z } from 'zod';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import type { BusinessHoursMap, BusinessProfile, ServiceGuidanceItem } from './business.ts';

export const bookingTypeSchema = z.enum([
  'appointment',
  'consultation',
  'service_request',
  'room_reservation',
  'rental',
  'class_enrollment',
  'custom',
]);

export const fulfillmentModeSchema = z.enum(['in_person', 'on_site', 'virtual', 'hybrid']);

export const afterHoursBehaviorSchema = z.enum([
  'book_next_available',
  'capture_callback_lead',
  'inform_hours_only',
]);

export const serviceRuleSchema = z
  .object({
    eligibility: z.string().optional(),
    requirements: z.array(z.string().min(1)).optional(),
    restrictions: z.array(z.string().min(1)).optional(),
  })
  .optional();

export const organizationServiceSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1, 'Service name is required'),
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  bookingType: bookingTypeSchema.default('appointment'),
  durationMinutes: z.number().int().min(5).max(1440).default(60),
  priceDisplay: z.string().min(1).optional(),
  isActive: z.boolean().default(true),
  intakeQuestions: z.array(z.string().min(1)).default([]),
  requiredCallerFields: z.array(z.string().min(1)).default(['fullName', 'phone', 'email']),
  rules: serviceRuleSchema,
});

export const staffMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  qualifications: z.string().optional(),
  assignedServices: z.array(z.string().min(1)).default([]),
});

export const faqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  category: z.string().optional(),
});

export const businessHoursSpecSchema = z.object({
  monday: z.string().min(1),
  tuesday: z.string().min(1),
  wednesday: z.string().min(1),
  thursday: z.string().min(1),
  friday: z.string().min(1),
  saturday: z.string().min(1),
  sunday: z.string().min(1),
  holidays: z.array(z.string().min(1)).default([]),
  afterHoursBehavior: afterHoursBehaviorSchema.default('book_next_available'),
});

export const organizationSpecSchema = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),

  // 1. Organization Profile
  organization: z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(2, 'Organization name is required'),
    type: z.string().min(2, 'Organization type/industry is required'),
    description: z.string().min(10, 'Organization description must be at least 10 characters'),
    location: z.string().min(2, 'Primary location/address is required'),
    timezone: z.string().min(3, 'Valid IANA timezone is required (e.g. Asia/Karachi)'),
    contactPhone: z.string().optional(),
    contactEmail: z.string().email().optional().or(z.literal('')),
    website: z.string().optional(),
    serviceAreas: z.array(z.string().min(1)).min(1, 'At least one service area/branch is required'),
  }),

  // 2. Business Hours (+ holidays & after-hours behavior)
  businessHours: businessHoursSpecSchema,

  // 3 & 4. Services Catalogue + Service Rules
  services: z
    .array(organizationServiceSchema)
    .min(1, 'At least one active service must be configured'),

  // 5. Staff & Team (optional)
  staff: z.array(staffMemberSchema).default([]),

  // 6. Availability (optional)
  availability: z
    .object({
      defaultDurationMinutes: z.number().int().min(5).max(1440).default(60),
      breaks: z.array(z.string().min(1)).default([]),
      blockedDates: z.array(z.string().min(1)).default([]),
    })
    .default({
      defaultDurationMinutes: 60,
      breaks: [],
      blockedDates: [],
    }),

  // 7. Booking Rules
  bookingRules: z
    .object({
      allowBooking: z.boolean().default(true),
      allowReschedule: z.boolean().default(true),
      allowCancel: z.boolean().default(true),
      allowLeadCapture: z.boolean().default(true),
      minAdvanceNoticeMinutes: z.number().int().min(0).default(30),
      requireReadbackConfirmation: z.boolean().default(true),
    })
    .default({
      allowBooking: true,
      allowReschedule: true,
      allowCancel: true,
      allowLeadCapture: true,
      minAdvanceNoticeMinutes: 30,
      requireReadbackConfirmation: true,
    }),

  // 8. FAQs (optional)
  faqs: z.array(faqItemSchema).default([]),

  // 9. Customer / Caller Information & Domain Terminology
  customerInfo: z.object({
    callerLabel: z.string().min(1).default('Client'),
    locationLabel: z.string().min(1).default('Location'),
    bookingUnit: z.string().min(1).default('Appointment'),
    fulfillmentMode: fulfillmentModeSchema.default('in_person'),
    askCallerAddress: z.boolean().default(false),
    requiredFields: z.array(z.string().min(1)).default(['fullName', 'phone', 'email']),
  }),

  // 10. Escalation & Policies
  escalationRules: z.object({
    emergencyPolicy: z.string().min(10, 'Emergency or escalation policy is required'),
    pricingPolicy: z.string().min(10, 'Pricing policy is required'),
    humanTransferTriggers: z.array(z.string().min(1)).default([]),
    transferPhone: z.string().optional(),
    acceptedPaymentMethods: z.array(z.string().min(1)).default([]),
  }),

  // 11. Communication Preferences
  communication: z
    .object({
      emailConfirmation: z.boolean().default(true),
      whatsappConfirmation: z.boolean().default(true),
      phoneCallback: z.boolean().default(true),
    })
    .default({
      emailConfirmation: true,
      whatsappConfirmation: true,
      phoneCallback: true,
    }),

  // 12. AI Instructions
  aiInstructions: z.object({
    assistantName: z.string().min(1, 'Assistant name is required'),
    voice: z.string().min(1).default('Puck'),
    tone: z.string().min(3).default('warm, concise, and professional'),
    languages: z.array(z.string().min(1)).min(1).default(['English']),
    defaultLanguage: z.string().min(1).default('English'),
    greeting: z.string().min(5).optional(),
    prohibitedClaims: z.array(z.string().min(1)).default([]),
  }),
});

export type OrganizationSpec = z.infer<typeof organizationSpecSchema>;

export function parseOrganizationSpec(raw: unknown):
  | { success: true; data: OrganizationSpec }
  | { success: false; errors: string[] } {
  const result = organizationSpecSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
    return `${path}: ${issue.message}`;
  });
  return { success: false, errors };
}

export function toBusinessProfile(spec: OrganizationSpec): BusinessProfile {
  const activeServices = spec.services.filter((s) => s.isActive);
  const hours: BusinessHoursMap = {
    monday: spec.businessHours.monday,
    tuesday: spec.businessHours.tuesday,
    wednesday: spec.businessHours.wednesday,
    thursday: spec.businessHours.thursday,
    friday: spec.businessHours.friday,
    saturday: spec.businessHours.saturday,
    sunday: spec.businessHours.sunday,
  };

  const serviceGuidance: ServiceGuidanceItem[] = activeServices
    .filter((s) => s.intakeQuestions.length > 0)
    .map((s) => ({
      serviceName: s.name,
      intakeQuestions: s.intakeQuestions,
    }));

  return {
    id: spec.organization.id ?? NORTHSTAR_BUSINESS_ID,
    name: spec.organization.name,
    receptionistName: spec.aiInstructions.assistantName,
    description: spec.organization.description,
    location: spec.organization.location,
    timezone: spec.organization.timezone,
    serviceAreas: spec.organization.serviceAreas,
    hours,
    services: activeServices.map((s) => s.name),
    serviceGuidance,
    emergencyPolicy: spec.escalationRules.emergencyPolicy,
    pricingPolicy: spec.escalationRules.pricingPolicy,
    appointmentDurationMinutes: spec.availability.defaultDurationMinutes,
    aiVoice: spec.aiInstructions.voice,
  };
}
