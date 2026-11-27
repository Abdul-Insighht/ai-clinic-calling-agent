import { buildReceptionistPrompt } from '../agent/prompt.ts';
import { type OrganizationSpec, toBusinessProfile } from '../models/organization-spec.ts';

export type CompiledNotificationLabels = {
  callerLabel: string;
  locationLabel: string;
  bookingUnit: string;
  organizationName: string;
  defaultLocation: string;
  askCallerAddress: boolean;
};

export function compileNotificationLabels(spec: OrganizationSpec): CompiledNotificationLabels {
  return {
    callerLabel: spec.customerInfo.callerLabel,
    locationLabel: spec.customerInfo.locationLabel,
    bookingUnit: spec.customerInfo.bookingUnit,
    organizationName: spec.organization.name,
    defaultLocation: spec.organization.location,
    askCallerAddress: spec.customerInfo.askCallerAddress,
  };
}

/**
 * Compiles a complete, domain-agnostic system prompt from any validated OrganizationSpec
 * by layering universal sections (terminology, languages, FAQs, staff, payment methods,
 * after-hours rules, and service rules) cleanly on top of buildReceptionistPrompt.
 */
export function compileOrganizationPrompt(spec: OrganizationSpec): string {
  const basePrompt = buildReceptionistPrompt(toBusinessProfile(spec));
  const extraSections: string[] = [];

  extraSections.push(
    `UNIVERSAL ORGANIZATION CONFIGURATION (${spec.organization.type.toUpperCase()}):\n` +
      `- Terminology: Refer to callers as "${spec.customerInfo.callerLabel}", bookings as "${spec.customerInfo.bookingUnit}", and location as "${spec.customerInfo.locationLabel}" (Fulfillment: ${spec.customerInfo.fulfillmentMode}).\n` +
      `- Address rule: ${
        spec.customerInfo.askCallerAddress
          ? `Collect the ${spec.customerInfo.callerLabel}'s ${spec.customerInfo.locationLabel} before booking.`
          : `Do NOT ask for the ${spec.customerInfo.callerLabel}'s home address; use "${spec.organization.location}" as the ${spec.customerInfo.locationLabel}.`
      }\n` +
      `- Supported languages: ${spec.aiInstructions.languages.join(', ')} (default: ${spec.aiInstructions.defaultLanguage}).\n` +
      `- Tone: ${spec.aiInstructions.tone}.\n` +
      `- After-hours behavior: ${spec.businessHours.afterHoursBehavior}.`,
  );

  const servicesWithRules = spec.services.filter(
    (s) =>
      s.isActive &&
      (s.priceDisplay ||
        s.rules?.eligibility ||
        (s.rules?.requirements && s.rules.requirements.length > 0) ||
        (s.rules?.restrictions && s.rules.restrictions.length > 0)),
  );
  if (servicesWithRules.length > 0) {
    const ruleLines = servicesWithRules.map((s) => {
      const parts: string[] = [`${s.name} (${s.bookingType}, ${s.durationMinutes}m)`];
      if (s.priceDisplay) parts.push(`Price: ${s.priceDisplay}`);
      if (s.rules?.eligibility) parts.push(`Eligibility: ${s.rules.eligibility}`);
      if (s.rules?.requirements?.length) parts.push(`Requires: ${s.rules.requirements.join('; ')}`);
      if (s.rules?.restrictions?.length) parts.push(`Restrictions: ${s.rules.restrictions.join('; ')}`);
      return `- ${parts.join(' | ')}`;
    });
    extraSections.push(`SERVICE DETAILS & RULES:\n${ruleLines.join('\n')}`);
  }

  if (spec.staff.length > 0) {
    const staffLines = spec.staff.map((m) => {
      const svcs = m.assignedServices.length > 0 ? ` — ${m.assignedServices.join(', ')}` : '';
      const qual = m.qualifications ? ` (${m.qualifications})` : '';
      return `- ${m.name}, ${m.role}${qual}${svcs}`;
    });
    extraSections.push(`TEAM & SPECIALISTS:\n${staffLines.join('\n')}`);
  }

  if (spec.faqs.length > 0) {
    const faqLines = spec.faqs.map((f) => `- Q: ${f.question}\n  A: ${f.answer}`);
    extraSections.push(`VERIFIED FAQS (use only these approved answers):\n${faqLines.join('\n')}`);
  }

  if (spec.escalationRules.acceptedPaymentMethods.length > 0) {
    extraSections.push(
      `ACCEPTED PAYMENT METHODS: ${spec.escalationRules.acceptedPaymentMethods.join(', ')}.`,
    );
  }

  if (spec.escalationRules.humanTransferTriggers.length > 0) {
    extraSections.push(
      `HUMAN ESCALATION TRIGGERS: ${spec.escalationRules.humanTransferTriggers.join('; ')}.`,
    );
  }

  if (spec.aiInstructions.prohibitedClaims.length > 0) {
    extraSections.push(
      `PROHIBITED CLAIMS:\n${spec.aiInstructions.prohibitedClaims.map((p) => `- ${p}`).join('\n')}`,
    );
  }

  return `${basePrompt}\n\n${extraSections.join('\n\n')}`.trim();
}

export function summarizeOrganizationSpec(spec: OrganizationSpec): Record<string, unknown> {
  const activeServices = spec.services.filter((s) => s.isActive);
  return {
    schemaVersion: spec.schemaVersion,
    organization: spec.organization.name,
    industry: spec.organization.type,
    location: spec.organization.location,
    timezone: spec.organization.timezone,
    assistant: `${spec.aiInstructions.assistantName} (voice: ${spec.aiInstructions.voice}, languages: ${spec.aiInstructions.languages.join(', ')})`,
    terminology: `${spec.customerInfo.callerLabel} / ${spec.customerInfo.bookingUnit} / ${spec.customerInfo.locationLabel} (${spec.customerInfo.fulfillmentMode})`,
    activeServicesCount: activeServices.length,
    services: activeServices.map((s) => `${s.name} (${s.bookingType}, ${s.durationMinutes}m)`),
    staffCount: spec.staff.length,
    faqsCount: spec.faqs.length,
    workflows: {
      booking: spec.bookingRules.allowBooking,
      reschedule: spec.bookingRules.allowReschedule,
      cancel: spec.bookingRules.allowCancel,
      leadCapture: spec.bookingRules.allowLeadCapture,
    },
    communication: spec.communication,
    compiledPromptLength: compileOrganizationPrompt(spec).length,
  };
}
