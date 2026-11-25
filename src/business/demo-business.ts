import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import type { BusinessProfile } from '../models/business.ts';

export const demoBusiness: BusinessProfile = {
  id: NORTHSTAR_BUSINESS_ID,
  name: 'NorthStar Heating & Air',

  receptionistName: 'Sarah',

  description:
    'NorthStar Heating & Air provides residential HVAC repair, maintenance, and installation services.',

  location: 'Dallas, Texas',
  timezone: 'America/Chicago',

  serviceAreas: ['Dallas', 'Plano', 'Frisco', 'Richardson', 'McKinney'],

  hours: {
    monday: '8 AM to 6 PM',
    tuesday: '8 AM to 6 PM',
    wednesday: '8 AM to 6 PM',
    thursday: '8 AM to 6 PM',
    friday: '8 AM to 6 PM',
    saturday: '9 AM to 2 PM',
    sunday: 'Closed',
  },

  services: [
    'Air conditioning repair',
    'Heating repair',
    'HVAC maintenance',
    'AC installation',
    'Furnace installation',
    'Indoor air quality services',
  ],

  emergencyPolicy:
    'For potentially dangerous situations such as a gas smell, instruct the caller to leave the property and contact the appropriate emergency service or gas utility. Do not attempt technical diagnosis.',

  pricingPolicy:
    'Do not invent pricing. Explain that final pricing depends on diagnosis and a technician can provide an estimate.',

  appointmentDurationMinutes: 60,
};
