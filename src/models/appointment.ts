export type AppointmentStatus =
  | 'pending'
  | 'pending_calendar_sync'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export type BusyInterval = {
  startsAt: string;
  endsAt: string;
};

export type AvailableSlot = {
  slotId: string;
  date: string;
  day: string;
  startTime: string;
  endTime: string;
  label: string;
  start: string;
  end: string;
  timezone: string;
  expiresAt: string;
};

export type AvailabilityHoldRecord = {
  slotToken: string;
  businessId: string;
  serviceId: string | null;
  resourceId: string;
  label: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type AppointmentRecord = {
  id: string;
  businessId: string;
  serviceId: string | null;
  callId: string | null;
  resourceId: string;
  customerName: string;
  phoneE164: string;
  customerEmail?: string | null;
  address?: string | null;
  reason: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  label: string;
  status: AppointmentStatus;
  idempotencyKey: string;
  googleEventId: string | null;
  createdAt: string;
};

export type CalendarSyncJobRecord = {
  id: string;
  businessId: string;
  appointmentId: string;
  operation: 'create' | 'update' | 'cancel';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  lastError: string | null;
  nextRetryAt: string;
};

export type ReserveSlotInput = {
  slotToken: string;
  customerName: string;
  phoneE164: string;
  customerEmail?: string | null;
  address?: string | null;
  reason: string;
  idempotencyKey: string;
  nowIso?: string;
};

export type ReserveSlotResult =
  | {
      success: true;
      idempotentReplay: boolean;
      appointment: AppointmentRecord;
    }
  | {
      success: false;
      error: 'SLOT_NOT_FOUND' | 'SLOT_EXPIRED' | 'SLOT_UNAVAILABLE';
      message: string;
    };
