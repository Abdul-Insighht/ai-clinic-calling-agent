export type AuthUser = {
  id: string;
  businessId: string;
  email: string;
  fullName: string;
  role: 'owner' | 'admin' | 'staff';
};

export type BusinessProfile = {
  name: string;
  receptionistName: string;
  description: string;
  location: string;
  timezone: string;
  serviceAreas: string[];
  hours: Record<string, string>;
  services: string[];
  emergencyPolicy: string;
  pricingPolicy: string;
  aiVoice?: string;
  aiModel?: string;
};

export type AvailableSlot = {
  slotId: string;
  date: string;
  day: string;
  startTime: string;
  endTime: string;
  label: string;
  timezone: string;
};

export type BookedAppointmentItem = {
  id: string;
  bookingCode?: string;
  callId?: string | null;
  customerName: string;
  phoneE164: string;
  customerEmail?: string | null;
  address?: string | null;
  reason: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  googleEventId: string | null;
  createdAt: string;
};

export type CallLogItem = {
  id: string;
  roomName: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
};

export type LeadItem = {
  id: string;
  customerName: string;
  phoneE164: string;
  reason: string;
  location: string | null;
  preferredTime: string | null;
  status: string;
  createdAt: string;
};

export type LiveKitTokenResponse = {
  token: string;
  roomName: string;
  livekitUrl: string;
};

export type PerformanceMetrics = {
  sampleCount: number;
  avgToolDurationMs: number | null;
  p50ToolDurationMs: number | null;
  p95ToolDurationMs: number | null;
  toolSuccessRate: number | null;
  dbPool: {
    total: number;
    idle: number;
    waiting: number;
  } | null;
};

const API_BASE_URL = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(
  /\/+$/,
  '',
);

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ accessToken: string; user: AuthUser }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  getHealth: () => request<{ status: string }>('/health/ready'),

  getBusiness: (token: string) =>
    request<{ business: BusinessProfile }>('/api/v1/business', {}, token),

  updateBusiness: (token: string, updates: Partial<BusinessProfile>) =>
    request<{ business: BusinessProfile }>(
      '/api/v1/business',
      {
        method: 'PATCH',
        body: JSON.stringify(updates),
      },
      token,
    ),

  getAppointments: (token: string) =>
    request<{ appointments: BookedAppointmentItem[] }>('/api/v1/appointments', {}, token),

  cancelAppointment: (token: string, appointmentId: string) =>
    request<{ appointment: BookedAppointmentItem }>(
      `/api/v1/appointments/${encodeURIComponent(appointmentId)}/cancel`,
      { method: 'POST' },
      token,
    ),

  getCalls: (token: string) => request<{ calls: CallLogItem[] }>('/api/v1/calls', {}, token),

  getAvailability: (token: string, requestedDay?: string) =>
    request<{ availableSlots: AvailableSlot[]; timeZone: string }>(
      `/api/v1/appointments/availability${requestedDay ? `?requestedDay=${encodeURIComponent(requestedDay)}` : ''}`,
      {},
      token,
    ),

  getLeads: (token: string) => request<{ leads: LeadItem[] }>('/api/v1/leads', {}, token),

  getTeam: (token: string) => request<{ members: AuthUser[] }>('/api/v1/team', {}, token),

  getPerformanceMetrics: (token: string) =>
    request<{ metrics: PerformanceMetrics }>('/api/v1/metrics/performance', {}, token),

  createLiveKitToken: (token: string, participantName?: string) =>
    request<LiveKitTokenResponse>(
      '/api/v1/livekit/token',
      {
        method: 'POST',
        body: JSON.stringify({ participantName }),
      },
      token,
    ),
};
