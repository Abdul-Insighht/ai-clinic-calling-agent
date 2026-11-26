import { Agent } from '@livekit/agents';
import { demoBusiness } from '../business/demo-business.ts';
import { getAppConfig } from '../config/index.ts';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import type { BusinessContext, BusinessProfile } from '../models/business.ts';
import {
  type AppointmentRepository,
  InMemoryAppointmentRepository,
  PostgresAppointmentRepository,
} from '../repositories/appointment-repository.ts';
import {
  type CallRepository,
  InMemoryCallRepository,
  PostgresCallRepository,
} from '../repositories/lead-repository.ts';
import { AvailabilityService } from '../services/availability-service.ts';
import { BookingService } from '../services/booking-service.ts';
import {
  type BusinessService,
  createDefaultBusinessService,
} from '../services/business-service.ts';
import { type CalendarAdapter, GoogleCalendarAdapter } from '../services/google-calendar-adapter.ts';
import { createDefaultLeadService, type LeadService } from '../services/lead-service.ts';
import { createBookAppointmentTool } from '../tools/book-appointment.ts';
import { createCaptureLeadTool } from '../tools/capture-lead.ts';
import { createGetAppointmentDetailsTool } from '../tools/get-appointment-details.ts';
import { createGetAvailableAppointmentsTool } from '../tools/get-available-appointments.ts';
import { createGetBusinessInformationTool } from '../tools/get-business-information.ts';
import { createRequestHumanTransferTool } from '../tools/request-human-transfer.ts';
import { createUpdateAppointmentTool } from '../tools/update-appointment.ts';
import { buildReceptionistPrompt } from './prompt.ts';

export type ReceptionistAgentOptions = {
  context?: BusinessContext;
  business?: BusinessProfile;
  businessService?: BusinessService;
  appointmentRepository?: AppointmentRepository;
  calendarAdapter?: CalendarAdapter;
  leadService?: LeadService;
  callRepository?: CallRepository;
};

const sharedCalendarAdapter = new GoogleCalendarAdapter();

export function createReceptionistAgent(options: ReceptionistAgentOptions = {}) {
  const appConfig = getAppConfig();
  const isProd = appConfig.nodeEnv === 'production';

  if (isProd && (!options.business || !options.context)) {
    throw new Error('Production receptionist requires explicit business profile and context.');
  }

  const context: BusinessContext = options.context ?? {
    businessId: NORTHSTAR_BUSINESS_ID,
  };
  const business = options.business ?? demoBusiness;
  const businessService = options.businessService ?? createDefaultBusinessService();
  const isPostgres = appConfig.database.isPostgresConfigured;

  if (isProd && !isPostgres) {
    throw new Error('PostgreSQL must be configured in production.');
  }

  const appointmentRepository =
    options.appointmentRepository ??
    (isPostgres ? new PostgresAppointmentRepository() : new InMemoryAppointmentRepository());
  const calendarAdapter = options.calendarAdapter ?? sharedCalendarAdapter;
  const leadService = options.leadService ?? createDefaultLeadService();
  const callRepository =
    options.callRepository ??
    (isPostgres ? new PostgresCallRepository() : new InMemoryCallRepository());

  const availabilityService = new AvailabilityService({
    businessService,
    appointmentRepository,
    calendarAdapter,
  });

  const bookingService = new BookingService({
    businessService,
    appointmentRepository,
    calendarAdapter,
  });

  return Agent.create({
    instructions: buildReceptionistPrompt(business),

    tools: [
      createGetBusinessInformationTool(context, businessService),
      createCaptureLeadTool(context, leadService),
      createGetAvailableAppointmentsTool(context, availabilityService),
      createBookAppointmentTool(context, bookingService),
      createGetAppointmentDetailsTool(context, bookingService),
      createUpdateAppointmentTool(context, bookingService),
      createRequestHumanTransferTool(context, callRepository),
    ],
  });
}
