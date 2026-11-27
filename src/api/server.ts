import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getAppConfig, loadEnvironmentFiles } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import {
  type AppointmentRepository,
  InMemoryAppointmentRepository,
  PostgresAppointmentRepository,
} from '../repositories/appointment-repository.ts';
import {
  InMemoryLeadRepository,
  type LeadRepository,
  PostgresLeadRepository,
} from '../repositories/lead-repository.ts';
import { getDbPool } from '../db/client.ts';
import { AvailabilityService } from '../services/availability-service.ts';
import { BackgroundSyncWorker } from '../services/background-sync-worker.ts';
import { BookingService } from '../services/booking-service.ts';
import {
  type BusinessService,
  createDefaultBusinessService,
} from '../services/business-service.ts';
import { type CalendarAdapter, GoogleCalendarAdapter } from '../services/google-calendar-adapter.ts';
import { LeadService } from '../services/lead-service.ts';
import { getPerformanceMetrics, recordToolMetric } from '../services/metrics-service.ts';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import {
  type AuthClaims,
  InMemoryUserRepository,
  PostgresUserRepository,
  type UserRepository,
  type UserRole,
  createDemoUsers,
  signJwt,
  verifyJwt,
  verifyPassword,
} from './auth.ts';
import { generateBusinessRoomToken } from './livekit-tokens.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthClaims;
  }
}

export type ApiServerDeps = {
  jwtSecret?: string;
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  userRepository?: UserRepository;
  businessService?: BusinessService;
  appointmentRepository?: AppointmentRepository;
  leadRepository?: LeadRepository;
  calendarAdapter?: CalendarAdapter;
};

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const livekitTokenBodySchema = z.object({
  participantName: z.string().min(1).max(100).optional(),
});

const availabilityQuerySchema = z.object({
  requestedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  requestedDay: z.string().optional(),
  serviceName: z.string().optional(),
  timePreference: z.enum(['morning', 'afternoon']).optional(),
});

const bookBodySchema = z.object({
  slotId: z.string().min(1),
  customerName: z.string().min(1),
  phone: z.string().min(7),
  address: z.string().optional(),
  reason: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

function getBusinessContext(req: FastifyRequest): BusinessContext {
  if (!req.auth) {
    throw new Error('Missing authenticated context.');
  }
  return {
    businessId: req.auth.businessId,
  };
}

function requireRole(allowed: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    if (!allowed.includes(req.auth.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Insufficient permissions.' });
    }
  };
}

export async function buildApiServer(deps: ApiServerDeps = {}): Promise<FastifyInstance> {
  const config = getAppConfig();
  const isPostgres = config.database.isPostgresConfigured;

  const jwtSecret =
    deps.jwtSecret ??
    process.env['JWT_ACCESS_SECRET'] ??
    (config.nodeEnv === 'production' ? '' : 'dev-insecure-jwt-secret-change-in-prod');

  if (!jwtSecret) {
    throw new Error('Missing required JWT_ACCESS_SECRET in production.');
  }

  const userRepository =
    deps.userRepository ??
    (isPostgres ? new PostgresUserRepository() : new InMemoryUserRepository(createDemoUsers()));
  const businessService = deps.businessService ?? createDefaultBusinessService();
  const appointmentRepository =
    deps.appointmentRepository ??
    (isPostgres ? new PostgresAppointmentRepository() : new InMemoryAppointmentRepository());
  const leadRepository =
    deps.leadRepository ??
    (isPostgres ? new PostgresLeadRepository() : new InMemoryLeadRepository());
  const calendarAdapter = deps.calendarAdapter ?? new GoogleCalendarAdapter();

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
  const leadService = new LeadService(leadRepository);

  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as { statusCode?: number; name?: string; message?: string } | null;
    logger.error('api.route.error', {
      method: req.method,
      url: req.url,
      error: err?.message ?? String(error),
    });
    const status =
      err?.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    return reply.code(status).send({
      error: err?.name || 'INTERNAL_SERVER_ERROR',
      message: err?.message || 'An unexpected error occurred',
    });
  });

  // Health endpoints (public)
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => ({
    status: 'ok',
    postgresConfigured: config.database.isPostgresConfigured,
    redisConfigured: config.database.isRedisConfigured,
  }));

  // Authentication endpoint
  app.post(
    '/api/v1/auth/login',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_CREDENTIALS_FORMAT' });
      }

      const user = await userRepository.findByEmail(parsed.data.email);
      if (!user || !user.isActive || !verifyPassword(parsed.data.password, user.passwordHash)) {
        return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
      }

      const accessToken = signJwt(
        {
          sub: user.id,
          businessId: user.businessId,
          email: user.email,
          role: user.role,
        },
        jwtSecret,
        3600,
      );

      logger.info('auth.login.succeeded', {
        userId: user.id,
        businessId: user.businessId,
        role: user.role,
      });

      return {
        accessToken,
        user: {
          id: user.id,
          businessId: user.businessId,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
        },
      };
    },
  );

  // Protected /api/v1 routes
  await app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', async (req, reply) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      }
      const token = authHeader.slice('Bearer '.length).trim();
      const claims = verifyJwt(token, jwtSecret);
      if (!claims) {
        return reply.code(401).send({ error: 'INVALID_OR_EXPIRED_TOKEN' });
      }
      req.auth = claims;
    });

    protectedRoutes.get('/api/v1/auth/me', async (req) => ({
      user: req.auth,
    }));

    protectedRoutes.post(
      '/api/v1/livekit/token',
      {
        config: {
          rateLimit: { max: 30, timeWindow: '1 minute' },
        },
      },
      async (req, reply) => {
        const parsed = livekitTokenBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: 'INVALID_REQUEST' });
        }

        const context = getBusinessContext(req);
        const livekitUrl = deps.livekitUrl ?? config.livekit.url;
        const apiKey = deps.livekitApiKey ?? config.livekit.apiKey;
        const apiSecret = deps.livekitApiSecret ?? config.livekit.apiSecret;

        if (!livekitUrl || !apiKey || !apiSecret) {
          return reply.code(503).send({ error: 'LIVEKIT_NOT_CONFIGURED' });
        }

        return generateBusinessRoomToken({
          context,
          participantIdentity: req.auth!.sub,
          participantName: parsed.data.participantName ?? req.auth!.email,
          livekitUrl,
          apiKey,
          apiSecret,
          agentName: config.livekit.agentName,
        });
      },
    );

    protectedRoutes.get('/api/v1/business', async (req) => {
      const context = getBusinessContext(req);
      const profile = await businessService.getBusinessProfile(context);
      return { business: profile };
    });

    protectedRoutes.patch(
      '/api/v1/business',
      { preHandler: requireRole(['owner', 'admin']) },
      async (req, reply) => {
        const schema = z.object({
          name: z.string().min(1).optional(),
          receptionistName: z.string().min(1).optional(),
          description: z.string().min(1).optional(),
          location: z.string().min(1).optional(),
          timezone: z.string().min(1).optional(),
          pricingPolicy: z.string().min(1).optional(),
          emergencyPolicy: z.string().min(1).optional(),
          aiVoice: z.string().min(1).optional(),
          aiModel: z.string().min(1).optional(),
          services: z.array(z.string().min(1)).optional(),
          hours: z.record(z.string(), z.string().min(1)).optional(),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'INVALID_BUSINESS_UPDATE' });
        }

        const context = getBusinessContext(req);
        if (config.database.isPostgresConfigured) {
          const d = parsed.data;
          const pool = getDbPool();
          await pool.query(
            `
            UPDATE aibitsol.businesses
            SET name = COALESCE($2, name),
                receptionist_name = COALESCE($3, receptionist_name),
                description = COALESCE($4, description),
                location = COALESCE($5, location),
                timezone = COALESCE($6, timezone),
                pricing_policy = COALESCE($7, pricing_policy),
                emergency_policy = COALESCE($8, emergency_policy),
                ai_voice = COALESCE($9, ai_voice),
                ai_model = COALESCE($10, ai_model),
                updated_at = NOW()
            WHERE id = $1
            `,
            [
              context.businessId,
              d.name ?? null,
              d.receptionistName ?? null,
              d.description ?? null,
              d.location ?? null,
              d.timezone ?? null,
              d.pricingPolicy ?? null,
              d.emergencyPolicy ?? null,
              d.aiVoice ?? null,
              d.aiModel ?? null,
            ],
          );

          if (d.services) {
            const cleanServices = [...new Set(d.services.map((s) => s.trim()).filter(Boolean))];
            await pool.query(
              `UPDATE aibitsol.services SET is_active = FALSE WHERE business_id = $1`,
              [context.businessId],
            );
            for (const svcName of cleanServices) {
              await pool.query(
                `
                INSERT INTO aibitsol.services (business_id, name, duration_minutes, is_active)
                VALUES ($1, $2, 60, TRUE)
                ON CONFLICT (business_id, name) DO UPDATE SET is_active = TRUE
                `,
                [context.businessId, svcName],
              );
            }
          }

          if (d.hours) {
            const dayNameToIndex: Record<string, number> = {
              sunday: 0,
              monday: 1,
              tuesday: 2,
              wednesday: 3,
              thursday: 4,
              friday: 5,
              saturday: 6,
            };
            for (const [dayKey, labelRaw] of Object.entries(d.hours)) {
              const dayIndex = dayNameToIndex[dayKey.toLowerCase()];
              if (dayIndex === undefined) continue;
              const label = labelRaw.trim();
              const isClosed = /^closed$/i.test(label);
              await pool.query(
                `
                UPDATE aibitsol.business_hours
                SET display_label = $3,
                    is_closed = $4
                WHERE business_id = $1 AND day_of_week = $2
                `,
                [context.businessId, dayIndex, label, isClosed],
              );
            }
          }

          businessService.invalidateProfileCache(context.businessId);
        }

        const updated = await businessService.getBusinessProfile(context);
        return { business: updated };
      },
    );

    protectedRoutes.get('/api/v1/appointments', async (req) => {
      const context = getBusinessContext(req);
      const appointments = appointmentRepository.listAppointments
        ? await appointmentRepository.listAppointments(context, 50)
        : [];
      return { appointments };
    });

    protectedRoutes.post('/api/v1/appointments/:id/cancel', async (req, reply) => {
      const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'INVALID_APPOINTMENT_ID' });
      }
      const context = getBusinessContext(req);
      const cancelled = appointmentRepository.cancelAppointment
        ? await appointmentRepository.cancelAppointment(context, params.data.id)
        : null;
      if (!cancelled) {
        return reply.code(404).send({ error: 'APPOINTMENT_NOT_FOUND' });
      }
      return { appointment: cancelled };
    });

    protectedRoutes.post('/api/v1/appointments/:id/reschedule', async (req, reply) => {
      const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
      const body = z.object({ slotId: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'INVALID_RESCHEDULE_INPUT' });
      }
      const context = getBusinessContext(req);
      if (!appointmentRepository.rescheduleAppointment) {
        return reply.code(501).send({ error: 'RESCHEDULE_UNSUPPORTED' });
      }
      const result = await appointmentRepository.rescheduleAppointment(
        context,
        params.data.id,
        body.data.slotId,
      );
      if (!result.success) {
        const status = result.error === 'APPOINTMENT_NOT_FOUND' ? 404 : 409;
        return reply.code(status).send({ error: result.error, message: result.message });
      }
      return { appointment: result.appointment };
    });

    // Workspace settings persistence (Channels & Outbound Campaigns) in PostgreSQL JSONB
    const memoryWorkspaceSettings = new Map<string, unknown>();
    let workspaceTableReady = false;
    const ensureWorkspaceTable = async () => {
      if (workspaceTableReady || !config.database.isPostgresConfigured) return;
      await getDbPool().query(`
        CREATE TABLE IF NOT EXISTS aibitsol.workspace_settings (
          business_id UUID NOT NULL,
          setting_key TEXT NOT NULL,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (business_id, setting_key)
        )
      `);
      workspaceTableReady = true;
    };

    const readWorkspaceSetting = async (businessId: string, key: string): Promise<unknown> => {
      if (!config.database.isPostgresConfigured) {
        return memoryWorkspaceSettings.get(`${businessId}:${key}`) ?? null;
      }
      await ensureWorkspaceTable();
      const res = await getDbPool().query<{ payload: unknown }>(
        `SELECT payload FROM aibitsol.workspace_settings WHERE business_id = $1 AND setting_key = $2`,
        [businessId, key],
      );
      return res.rows[0]?.payload ?? null;
    };

    const writeWorkspaceSetting = async (
      businessId: string,
      key: string,
      payload: unknown,
    ): Promise<void> => {
      if (!config.database.isPostgresConfigured) {
        memoryWorkspaceSettings.set(`${businessId}:${key}`, payload);
        return;
      }
      await ensureWorkspaceTable();
      await getDbPool().query(
        `
        INSERT INTO aibitsol.workspace_settings (business_id, setting_key, payload, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (business_id, setting_key)
        DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
        `,
        [businessId, key, JSON.stringify(payload)],
      );
    };

    protectedRoutes.get('/api/v1/workspace/channels', async (req) => {
      const context = getBusinessContext(req);
      const channels = await readWorkspaceSetting(context.businessId, 'channels');
      return { channels };
    });

    protectedRoutes.put('/api/v1/workspace/channels', async (req, reply) => {
      const schema = z.object({
        inboundPhone: z.string(),
        outboundCallerId: z.string(),
        transferPhone: z.string(),
        whatsappNumber: z.string(),
        autoWhatsappConfirm: z.boolean(),
        autoWhatsappReminder: z.boolean(),
        whatsappTemplate: z.string(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_CHANNELS_PAYLOAD' });
      }
      const context = getBusinessContext(req);
      await writeWorkspaceSetting(context.businessId, 'channels', parsed.data);
      return { channels: parsed.data };
    });

    protectedRoutes.get('/api/v1/workspace/campaigns', async (req) => {
      const context = getBusinessContext(req);
      const campaigns = await readWorkspaceSetting(context.businessId, 'campaigns');
      return { campaigns: Array.isArray(campaigns) ? campaigns : null };
    });

    protectedRoutes.put('/api/v1/workspace/campaigns', async (req, reply) => {
      const schema = z.object({
        campaigns: z.array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            type: z.enum([
              'Appointment Reminder',
              'Lead Follow-up',
              'Missed Call Callback',
              'Patient Feedback',
            ]),
            status: z.enum(['active', 'paused', 'scheduled']),
            totalTargets: z.number().int().min(0),
            completedCalls: z.number().int().min(0),
            connectedRate: z.number().min(0).max(100),
            scheduleWindow: z.string(),
            scriptPreview: z.string(),
          }),
        ),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_CAMPAIGNS_PAYLOAD' });
      }
      const context = getBusinessContext(req);
      await writeWorkspaceSetting(context.businessId, 'campaigns', parsed.data.campaigns);
      return { campaigns: parsed.data.campaigns };
    });

    protectedRoutes.get('/api/v1/calls', async (req) => {
      const context = getBusinessContext(req);
      if (!config.database.isPostgresConfigured) {
        return { calls: [] };
      }
      const res = await getDbPool().query<{
        id: string;
        livekit_room_name: string;
        status: string;
        started_at: Date;
        ended_at: Date | null;
        duration_seconds: number | null;
      }>(
        `
        SELECT id, livekit_room_name, status, started_at, ended_at, duration_seconds
        FROM aibitsol.calls
        WHERE business_id = $1
        ORDER BY started_at DESC
        LIMIT 30
        `,
        [context.businessId],
      );
      return {
        calls: res.rows.map((r) => ({
          id: r.id,
          roomName: r.livekit_room_name,
          status: r.status,
          startedAt: r.started_at.toISOString(),
          endedAt: r.ended_at ? r.ended_at.toISOString() : null,
          durationSeconds: r.duration_seconds,
        })),
      };
    });

    protectedRoutes.get('/api/v1/appointments/availability', async (req, reply) => {
      const parsed = availabilityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_QUERY' });
      }
      const context = getBusinessContext(req);
      const startedAt = performance.now();
      try {
        const result = await availabilityService.getAvailableSlots(context, {
          ...(parsed.data.requestedDate ? { requestedDate: parsed.data.requestedDate } : {}),
          ...(parsed.data.requestedDay ? { requestedDay: parsed.data.requestedDay } : {}),
          ...(parsed.data.serviceName ? { serviceName: parsed.data.serviceName } : {}),
          ...(parsed.data.timePreference ? { timePreference: parsed.data.timePreference } : {}),
        });
        recordToolMetric('api.availability', performance.now() - startedAt, true);
        return result;
      } catch (err) {
        recordToolMetric('api.availability', performance.now() - startedAt, false);
        throw err;
      }
    });

    protectedRoutes.get('/api/v1/metrics/performance', async () => {
      return { metrics: getPerformanceMetrics() };
    });

    protectedRoutes.post('/api/v1/appointments', async (req, reply) => {
      const parsed = bookBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_BOOKING_REQUEST' });
      }
      const context = getBusinessContext(req);
      const { address, ...rest } = parsed.data;
      const result = await bookingService.bookAppointment(context, {
        ...rest,
        address: address ?? null,
      });
      if (!result.success) {
        const status = result.error === 'SLOT_NOT_FOUND' ? 404 : 409;
        return reply.code(status).send(result);
      }
      return reply.code(201).send(result);
    });

    protectedRoutes.get('/api/v1/leads', async (req) => {
      const context = getBusinessContext(req);
      const leads = await leadRepository.listLeads(context);
      return { leads };
    });

    protectedRoutes.post('/api/v1/leads', async (req, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().min(7),
        reason: z.string().min(1),
        location: z.string().optional(),
        preferredTime: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_LEAD_REQUEST' });
      }
      const context = getBusinessContext(req);
      const result = await leadService.captureLead(context, {
        name: parsed.data.name,
        phone: parsed.data.phone,
        reason: parsed.data.reason,
        ...(parsed.data.location ? { location: parsed.data.location } : {}),
        ...(parsed.data.preferredTime ? { preferredTime: parsed.data.preferredTime } : {}),
      });
      if (!result.success) {
        return reply.code(400).send(result);
      }
      return reply.code(201).send(result);
    });

    protectedRoutes.get(
      '/api/v1/team',
      { preHandler: requireRole(['owner', 'admin']) },
      async (req) => {
        const context = getBusinessContext(req);
        const members = await userRepository.listByBusiness(context.businessId);
        return { members };
      },
    );
  });

  return app;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  loadEnvironmentFiles();
  const app = await buildApiServer();
  const port = Number(process.env['PORT'] ?? process.env['API_PORT'] ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });

  const cfg = getAppConfig();
  if (cfg.database.isPostgresConfigured) {
    const repo = new PostgresAppointmentRepository();
    const syncBookingService = new BookingService({
      businessService: createDefaultBusinessService(),
      appointmentRepository: repo,
      calendarAdapter: new GoogleCalendarAdapter(),
    });
    const worker = new BackgroundSyncWorker({
      bookingService: syncBookingService,
      appointmentRepository: repo,
      context: { businessId: NORTHSTAR_BUSINESS_ID },
      intervalMs: 15_000,
    });
    worker.start();
  }

  logger.info('api.server.started', { port });
}
