import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import type { AppointmentRepository } from '../repositories/appointment-repository.ts';
import type { BookingService } from './booking-service.ts';

export class BackgroundSyncWorker {
  private readonly bookingService: BookingService;
  private readonly appointmentRepository: AppointmentRepository;
  private readonly context: BusinessContext;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: {
    bookingService: BookingService;
    appointmentRepository: AppointmentRepository;
    context: BusinessContext;
    intervalMs?: number;
  }) {
    this.bookingService = deps.bookingService;
    this.appointmentRepository = deps.appointmentRepository;
    this.context = deps.context;
    this.intervalMs = deps.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info('background_sync_worker.started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const [syncResult, cleanedHolds] = await Promise.all([
        this.bookingService.reconcilePendingSyncJobs(this.context),
        this.appointmentRepository.cleanupExpiredHolds?.(this.context) ?? Promise.resolve(0),
      ]);

      if (syncResult.synced > 0 || syncResult.failed > 0 || cleanedHolds > 0) {
        logger.info('background_sync_worker.tick_completed', {
          synced: syncResult.synced,
          failed: syncResult.failed,
          cleanedHolds,
        });
      }
    } catch (error) {
      logger.warn('background_sync_worker.tick_failed', { error });
    } finally {
      this.running = false;
    }
  }
}
