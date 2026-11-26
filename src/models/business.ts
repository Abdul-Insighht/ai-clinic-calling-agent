export type BusinessHoursMap = {
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
};

export type BusinessHoursEntry = {
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday
  openTime: string | null; // HH:MM:SS
  closeTime: string | null; // HH:MM:SS
  isClosed: boolean;
  displayLabel: string;
};

export type BusinessServiceItem = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  isActive: boolean;
};

export type VerifiedPricingRule = {
  id: string;
  serviceId: string | null;
  label: string;
  pricingType: 'fixed' | 'starting_at' | 'range' | 'estimate_only';
  amountCents: number | null;
  maxAmountCents: number | null;
  currency: string;
  notes: string | null;
  isVerified: boolean;
};

export type ServiceGuidanceItem = {
  serviceName: string;
  intakeQuestions: string[];
};

export type BusinessProfile = {
  id?: string;
  name: string;
  receptionistName: string;
  description: string;
  location: string;
  timezone: string;
  serviceAreas: string[];
  hours: BusinessHoursMap;
  structuredHours?: BusinessHoursEntry[];
  services: string[];
  serviceCatalog?: BusinessServiceItem[];
  serviceGuidance?: ServiceGuidanceItem[];
  pricingRules?: VerifiedPricingRule[];
  emergencyPolicy: string;
  pricingPolicy: string;
  appointmentDurationMinutes: number;
  googleCalendarId?: string | null;
  aiVoice?: string;
  aiModel?: string;
};

export type BusinessContext = {
  businessId: string;
  callId?: string;
  userTurnCount?: number;
};
