export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'closed';

export type LeadRecord = {
  id: string;
  businessId: string;
  callId: string | null;
  customerName: string;
  phoneE164: string;
  reason: string;
  location: string | null;
  preferredTime: string | null;
  status: LeadStatus;
  consentGiven: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateLeadPersistenceInput = {
  customerName: string;
  phoneE164: string;
  reason: string;
  location?: string | null;
  preferredTime?: string | null;
  consentGiven?: boolean;
};

export type CallStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export type CallRecord = {
  id: string;
  businessId: string;
  livekitRoomName: string;
  livekitRoomSid: string | null;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
};
