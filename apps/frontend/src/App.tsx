import {
  Activity,
  AudioLines,
  BarChart3,
  BookOpen,
  Bot,
  Calendar,
  CalendarCheck2,
  ChevronDown,
  ChevronUp,
  History,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  Pause,
  Phone,
  PhoneCall,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Users,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioWaveform,
  FloatingVoiceOrb,
  formatTimer,
  type LiveCallSnapshot,
  type OrbController,
  VoiceOrbSphere,
} from './components/FloatingVoiceOrb';
import {
  api,
  type AuthUser,
  type AvailableSlot,
  type BookedAppointmentItem,
  type BusinessProfile,
  type CallLogItem,
  type LeadItem,
  type PerformanceMetrics,
} from './services/api';

type Section =
  | 'overview'
  | 'agents'
  | 'appointments'
  | 'leads'
  | 'knowledge'
  | 'playground'
  | 'outbound'
  | 'calls'
  | 'analytics'
  | 'channels'
  | 'policies'
  | 'team';

type ChannelSettings = {
  inboundPhone: string;
  outboundCallerId: string;
  transferPhone: string;
  whatsappNumber: string;
  autoWhatsappConfirm: boolean;
  autoWhatsappReminder: boolean;
  whatsappTemplate: string;
};

type OutboundCampaign = {
  id: string;
  name: string;
  type: 'Appointment Reminder' | 'Lead Follow-up' | 'Missed Call Callback' | 'Customer Feedback';
  status: 'active' | 'paused' | 'scheduled';
  totalTargets: number;
  completedCalls: number;
  connectedRate: number;
  scheduleWindow: string;
  scriptPreview: string;
};

const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = {
  inboundPhone: '+1 (555) 234-5678',
  outboundCallerId: '+1 (555) 234-5679',
  transferPhone: '+1 (555) 987-6543',
  whatsappNumber: '+1 (555) 234-5678',
  autoWhatsappConfirm: true,
  autoWhatsappReminder: true,
  whatsappTemplate:
    'Hi {{customer_name}}, your appointment with {{business_name}} is confirmed for {{date}} at {{time}}. Reply RESCHEDULE if you need any changes.',
};

const DEFAULT_CAMPAIGNS: OutboundCampaign[] = [
  {
    id: 'cmp-reminders',
    name: '24-Hour Appointment Confirmations',
    type: 'Appointment Reminder',
    status: 'active',
    totalTargets: 28,
    completedCalls: 21,
    connectedRate: 86,
    scheduleWindow: 'Daily · 09:00 AM – 06:00 PM',
    scriptPreview:
      'Hi, this is Sarah calling to confirm your upcoming appointment tomorrow. Does that time still work for you?',
  },
  {
    id: 'cmp-leads',
    name: 'New Website Lead Follow-Up',
    type: 'Lead Follow-up',
    status: 'active',
    totalTargets: 15,
    completedCalls: 9,
    connectedRate: 74,
    scheduleWindow: 'Instant · Within 2 mins of lead capture',
    scriptPreview:
      'Hi, thanks for reaching out! I am calling to answer your questions and find a convenient slot for your service.',
  },
  {
    id: 'cmp-missed',
    name: 'After-Hours Missed Call Recovery',
    type: 'Missed Call Callback',
    status: 'paused',
    totalTargets: 12,
    completedCalls: 12,
    connectedRate: 92,
    scheduleWindow: 'Next Business Day · 08:30 AM',
    scriptPreview:
      'Hello! We saw we missed your call earlier and wanted to follow up right away to help you schedule.',
  },
];

const VOICE_OPTIONS = ['Puck', 'Aoede', 'Charon', 'Fenrir', 'Kore'];

function formatDateTime(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timeZone || undefined,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function readStoredAuth(): { token: string | null; user: AuthUser | null } {
  try {
    const token = sessionStorage.getItem('voxdesk_token') ?? sessionStorage.getItem('aibitsol_token');
    const rawUser =
      sessionStorage.getItem('voxdesk_user') ?? sessionStorage.getItem('aibitsol_user');
    if (token && rawUser) {
      return { token, user: JSON.parse(rawUser) as AuthUser };
    }
  } catch {
    // Ignore malformed sessionStorage
  }
  return { token: null, user: null };
}

export function App() {
  const initialAuth = readStoredAuth();
  const [token, setToken] = useState<string | null>(initialAuth.token);
  const [user, setUser] = useState<AuthUser | null>(initialAuth.user);
  const [section, setSection] = useState<Section>('overview');
  const [email, setEmail] = useState('admin@northstar.example');
  const [password, setPassword] = useState('NorthStarAdmin123!');
  const [loginError, setLoginError] = useState<string | null>(null);

  const [business, setBusiness] = useState<BusinessProfile | null>(null);
  const [appointments, setAppointments] = useState<BookedAppointmentItem[]>([]);
  const [calls, setCalls] = useState<CallLogItem[]>([]);
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [team, setTeam] = useState<AuthUser[]>([]);
  const [healthStatus, setHealthStatus] = useState<string>('checking');
  const [perfMetrics, setPerfMetrics] = useState<PerformanceMetrics | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Voice Playground & Orb state
  const orbControllerRef = useRef<OrbController | null>(null);
  const [callMode, setCallMode] = useState<'inbound' | 'outbound'>('inbound');
  const [outboundTestNumber, setOutboundTestNumber] = useState('+1 (555) 019-2834');
  const [showDebug, setShowDebug] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('default');
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micRafRef = useRef<number | null>(null);

  const [callSnap, setCallSnap] = useState<LiveCallSnapshot>({
    status: 'idle',
    muted: false,
    agentJoined: false,
    agentSpeaking: false,
    userSpeaking: false,
    elapsedSec: 0,
    error: null,
    sessionLogs: ['[--:--:--] Waiting for call...'],
  });

  // Editable Knowledge Base / Profile / Policies state
  const [profileForm, setProfileForm] = useState<{
    name: string;
    receptionistName: string;
    location: string;
    timezone: string;
    description: string;
    serviceAreasText: string;
    pricingPolicy: string;
    emergencyPolicy: string;
    aiVoice: string;
    hours: Record<string, string>;
  } | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Channels & Outbound Campaigns local workspace config
  const [channelSettings, setChannelSettings] = useState<ChannelSettings>(DEFAULT_CHANNEL_SETTINGS);
  const [channelSaved, setChannelSaved] = useState(false);
  const [campaigns, setCampaigns] = useState<OutboundCampaign[]>(DEFAULT_CAMPAIGNS);
  const [newCampaignName, setNewCampaignName] = useState('');
  const [newCampaignType, setNewCampaignType] =
    useState<OutboundCampaign['type']>('Appointment Reminder');
  const [callFilter, setCallFilter] = useState<'all' | 'inbound' | 'outbound'>('all');

  useEffect(() => {
    if (!user) return;
    try {
      const savedCh = localStorage.getItem(`voxdesk_channels_${user.businessId}`);
      if (savedCh) {
        setChannelSettings({
          ...DEFAULT_CHANNEL_SETTINGS,
          ...(JSON.parse(savedCh) as Partial<ChannelSettings>),
        });
      }
      const savedCmp = localStorage.getItem(`voxdesk_campaigns_${user.businessId}`);
      if (savedCmp) {
        setCampaigns(JSON.parse(savedCmp) as OutboundCampaign[]);
      }
    } catch {
      // Ignore storage parse errors
    }
  }, [user]);

  const stopMicTest = useCallback(() => {
    if (micRafRef.current != null) {
      cancelAnimationFrame(micRafRef.current);
      micRafRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    setMicTesting(false);
    setMicLevel(0);
  }, []);

  useEffect(() => {
    return () => stopMicTest();
  }, [stopMicTest]);

  async function handleToggleMicTest() {
    if (micTesting) {
      stopMicTest();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicId !== 'default' ? { deviceId: { exact: selectedMicId } } : true,
      });
      micStreamRef.current = stream;
      setMicTesting(true);

      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(devices.filter((d) => d.kind === 'audioinput'));

      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (!micStreamRef.current) {
          void audioCtx.close();
          return;
        }
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setMicLevel(Math.min(100, Math.round(avg * 2.2)));
        micRafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setMicTesting(false);
    }
  }

  const syncProfileForm = useCallback((biz: BusinessProfile) => {
    setProfileForm({
      name: biz.name,
      receptionistName: biz.receptionistName,
      location: biz.location,
      timezone: biz.timezone,
      description: biz.description,
      serviceAreasText: biz.serviceAreas.join(', '),
      pricingPolicy: biz.pricingPolicy,
      emergencyPolicy: biz.emergencyPolicy,
      aiVoice: biz.aiVoice ?? 'Puck',
      hours: { ...biz.hours },
    });
  }, []);

  const loadDashboard = useCallback(async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      const [bizRes, apptsRes, callsRes, availRes, leadsRes, healthRes, metricsRes] =
        await Promise.allSettled([
          api.getBusiness(token),
          api.getAppointments(token),
          api.getCalls(token),
          api.getAvailability(token),
          api.getLeads(token),
          api.getHealth(),
          api.getPerformanceMetrics(token),
        ]);

      if (bizRes.status === 'fulfilled' && bizRes.value.business) {
        setBusiness(bizRes.value.business);
        syncProfileForm(bizRes.value.business);
      }
      if (apptsRes.status === 'fulfilled') {
        setAppointments(
          Array.isArray(apptsRes.value.appointments) ? apptsRes.value.appointments : [],
        );
      }
      if (callsRes.status === 'fulfilled') {
        setCalls(Array.isArray(callsRes.value.calls) ? callsRes.value.calls : []);
      }
      if (availRes.status === 'fulfilled') {
        setSlots(Array.isArray(availRes.value.availableSlots) ? availRes.value.availableSlots : []);
      }
      if (leadsRes.status === 'fulfilled') {
        setLeads(Array.isArray(leadsRes.value.leads) ? leadsRes.value.leads : []);
      }
      if (healthRes.status === 'fulfilled') {
        setHealthStatus(healthRes.value.status ?? 'ok');
      } else if (bizRes.status === 'fulfilled' && apptsRes.status === 'fulfilled') {
        setHealthStatus('ok');
      } else {
        setHealthStatus('degraded');
      }
      if (metricsRes.status === 'fulfilled') {
        setPerfMetrics(metricsRes.value.metrics ?? null);
      }

      if (user?.role === 'owner' || user?.role === 'admin') {
        try {
          const teamRes = await api.getTeam(token);
          setTeam(Array.isArray(teamRes.members) ? teamRes.members : []);
        } catch {
          // Ignore team fetch errors
        }
      }
    } finally {
      setRefreshing(false);
    }
  }, [token, user?.role, syncProfileForm]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoginError(null);
    try {
      const result = await api.login(email, password);
      sessionStorage.setItem('voxdesk_token', result.accessToken);
      sessionStorage.setItem('voxdesk_user', JSON.stringify(result.user));
      setToken(result.accessToken);
      setUser(result.user);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  function handleLogout() {
    sessionStorage.removeItem('voxdesk_token');
    sessionStorage.removeItem('voxdesk_user');
    sessionStorage.removeItem('aibitsol_token');
    sessionStorage.removeItem('aibitsol_user');
    setToken(null);
    setUser(null);
  }

  async function handleSaveBusiness(e: FormEvent) {
    e.preventDefault();
    if (!token || !profileForm) return;
    setSavingProfile(true);
    setSaveMessage(null);
    setSaveError(null);
    try {
      const res = await api.updateBusiness(token, {
        name: profileForm.name.trim(),
        receptionistName: profileForm.receptionistName.trim(),
        location: profileForm.location.trim(),
        timezone: profileForm.timezone.trim(),
        description: profileForm.description.trim(),
        serviceAreas: profileForm.serviceAreasText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        pricingPolicy: profileForm.pricingPolicy.trim(),
        emergencyPolicy: profileForm.emergencyPolicy.trim(),
        aiVoice: profileForm.aiVoice,
        hours: profileForm.hours,
      });
      setBusiness(res.business);
      syncProfileForm(res.business);
      setSaveMessage('Changes saved and synced to your live AI Voice Agent.');
      window.setTimeout(() => setSaveMessage(null), 4000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setSavingProfile(false);
    }
  }

  function handleSaveChannels(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    localStorage.setItem(`voxdesk_channels_${user.businessId}`, JSON.stringify(channelSettings));
    setChannelSaved(true);
    window.setTimeout(() => setChannelSaved(false), 3500);
  }

  function updateCampaigns(next: OutboundCampaign[]) {
    setCampaigns(next);
    if (user) {
      localStorage.setItem(`voxdesk_campaigns_${user.businessId}`, JSON.stringify(next));
    }
  }

  function handleCreateCampaign(e: FormEvent) {
    e.preventDefault();
    if (!newCampaignName.trim()) return;
    const created: OutboundCampaign = {
      id: `cmp-${Date.now()}`,
      name: newCampaignName.trim(),
      type: newCampaignType,
      status: 'scheduled',
      totalTargets: Math.max(leads.length, appointments.length, 5),
      completedCalls: 0,
      connectedRate: 0,
      scheduleWindow: 'Business Hours · Auto-Dial',
      scriptPreview: `Hi, this is ${business?.receptionistName ?? 'Sarah'} calling from ${business?.name ?? 'your team'} regarding your ${newCampaignType.toLowerCase()}.`,
    };
    updateCampaigns([created, ...campaigns]);
    setNewCampaignName('');
  }

  function toggleCampaignStatus(id: string) {
    updateCampaigns(
      campaigns.map((c) =>
        c.id === id ? { ...c, status: c.status === 'active' ? 'paused' : 'active' } : c,
      ),
    );
  }

  const canEdit = user?.role === 'owner' || user?.role === 'admin';

  if (!token || !user) {
    return (
      <div className="login-shell">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="login-brand">
            <div className="brand-mark">
              <Sparkles size={18} />
            </div>
            <div>
              <div className="brand-title">VoxDesk AI</div>
              <div className="brand-sub">Enterprise Voice Calling Command Center</div>
            </div>
          </div>
          <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
            Sign in to manage inbound & outbound AI voice agents, bookings, leads, and channels.
          </p>
          {loginError && <div className="error-box">{loginError}</div>}
          <label className="field-label">Work Email</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label className="field-label">Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="btn" style={{ width: '100%', marginTop: 6 }} type="submit">
            Sign In to VoxDesk AI
          </button>
        </form>
      </div>
    );
  }

  const initials = user.fullName
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const orbStateClass =
    callSnap.status === 'connecting'
      ? 'orb-connecting'
      : callSnap.agentSpeaking
        ? 'orb-speaking'
        : callSnap.userSpeaking && !callSnap.muted
          ? 'orb-listening'
          : callSnap.status === 'connected'
            ? 'orb-connected'
            : 'orb-idle';

  const waveMode = callSnap.agentSpeaking
    ? 'agent'
    : callSnap.userSpeaking && !callSnap.muted
      ? 'user'
      : 'idle';

  const activeCampaignsCount = campaigns.filter((c) => c.status === 'active').length;
  const filteredCalls = calls.filter((c) => {
    if (callFilter === 'all') return true;
    const isOutbound = c.roomName.toLowerCase().includes('outbound');
    return callFilter === 'outbound' ? isOutbound : !isOutbound;
  });

  const sectionTitleMap: Record<Section, string> = {
    overview: business?.name ?? 'Command Center',
    agents: 'Voice Agents & Personas',
    appointments: 'Appointments & Schedule',
    leads: 'Leads & Contacts',
    knowledge: 'Knowledge Base & Hours',
    playground: 'Voice Playground',
    outbound: 'Outbound Campaigns',
    calls: 'Call Logs & Replay',
    analytics: 'Voice Analytics',
    channels: 'Channel Activation',
    policies: 'Policies & Guardrails',
    team: 'Team & Permissions',
  };

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <div>
            <div className="brand-title">VoxDesk AI</div>
            <div className="brand-sub">Voice Calling Platform</div>
          </div>
        </div>

        <div className="nav-group-label">Workspace</div>
        <button
          className={`nav-btn ${section === 'overview' ? 'active' : ''}`}
          onClick={() => setSection('overview')}
        >
          <LayoutDashboard size={16} /> Dashboard
        </button>
        <button
          className={`nav-btn ${section === 'agents' ? 'active' : ''}`}
          onClick={() => setSection('agents')}
        >
          <Bot size={16} /> Voice Agents
          <span className="nav-count">2</span>
        </button>
        <button
          className={`nav-btn ${section === 'appointments' ? 'active' : ''}`}
          onClick={() => setSection('appointments')}
        >
          <Calendar size={16} /> Appointments
          <span className="nav-count">{appointments.length}</span>
        </button>
        <button
          className={`nav-btn ${section === 'leads' ? 'active' : ''}`}
          onClick={() => setSection('leads')}
        >
          <UserCheck size={16} /> Leads & Contacts
          <span className="nav-count">{leads.length}</span>
        </button>
        <button
          className={`nav-btn ${section === 'knowledge' ? 'active' : ''}`}
          onClick={() => setSection('knowledge')}
        >
          <BookOpen size={16} /> Knowledge Base
        </button>

        <div className="nav-group-label">Runtime</div>
        <button
          className={`nav-btn ${section === 'playground' ? 'active' : ''}`}
          onClick={() => setSection('playground')}
        >
          <AudioLines size={16} /> Voice Playground
        </button>
        <button
          className={`nav-btn ${section === 'outbound' ? 'active' : ''}`}
          onClick={() => setSection('outbound')}
        >
          <PhoneOutgoing size={16} /> Outbound Campaigns
          <span className="nav-count">{activeCampaignsCount}</span>
        </button>
        <button
          className={`nav-btn ${section === 'calls' ? 'active' : ''}`}
          onClick={() => setSection('calls')}
        >
          <History size={16} /> Call Logs & Replay
          <span className="nav-count">{calls.length}</span>
        </button>
        <button
          className={`nav-btn ${section === 'analytics' ? 'active' : ''}`}
          onClick={() => setSection('analytics')}
        >
          <BarChart3 size={16} /> Voice Analytics
        </button>

        <div className="nav-group-label">Governance</div>
        <button
          className={`nav-btn ${section === 'channels' ? 'active' : ''}`}
          onClick={() => setSection('channels')}
        >
          <MessageSquare size={16} /> Channel Activation
        </button>
        <button
          className={`nav-btn ${section === 'policies' ? 'active' : ''}`}
          onClick={() => setSection('policies')}
        >
          <ShieldCheck size={16} /> Policies & Guardrails
        </button>
        <button
          className={`nav-btn ${section === 'team' ? 'active' : ''}`}
          onClick={() => setSection('team')}
        >
          <Users size={16} /> Team & Permissions
        </button>

        <div className="sidebar-footer">
          <div className="sidebar-status-card">
            <span className={`status-dot ${healthStatus === 'ok' ? '' : 'danger'}`} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Voice AI Active</div>
              <div className="muted" style={{ fontSize: 11 }}>
                Inbound & Outbound · 24/7
              </div>
            </div>
          </div>

          <div className="user-pill">
            <div className="user-avatar">{initials}</div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {user.fullName}
              </div>
              <div className="muted" style={{ fontSize: 11.5, textTransform: 'capitalize' }}>
                {user.role}
              </div>
            </div>
          </div>
          <button className="nav-btn" onClick={handleLogout}>
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1 className="topbar-title">{sectionTitleMap[section]}</h1>
            <div className="muted" style={{ marginTop: 4 }}>
              {business?.name ?? 'Organization Workspace'} · {business?.location ?? 'Global'} ·{' '}
              {business?.timezone ?? 'UTC'}
            </div>
          </div>
          <div className="topbar-actions">
            <span
              className={`badge ${healthStatus === 'degraded' ? 'badge-danger' : 'badge-ok'}`}
            >
              <span className={`status-dot ${healthStatus === 'degraded' ? 'danger' : ''}`} />
              {healthStatus === 'degraded'
                ? 'Degraded'
                : healthStatus === 'checking'
                  ? 'Connecting...'
                  : 'Live · Today'}
            </span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void loadDashboard()}
              disabled={refreshing}
            >
              <RefreshCw size={14} /> {refreshing ? 'Syncing...' : 'Refresh'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                setSection('playground');
                if (callSnap.status === 'idle') {
                  orbControllerRef.current?.startCall();
                }
              }}
            >
              <PhoneCall size={14} />
              {callSnap.status === 'idle'
                ? 'Start Call'
                : callSnap.status === 'connecting'
                  ? 'Connecting...'
                  : `Live · ${formatTimer(callSnap.elapsedSec)}`}
            </button>
          </div>
        </header>

        {/* =======================================================
            1. DASHBOARD OVERVIEW (COMMAND CENTER)
           ======================================================= */}
        {section === 'overview' && (
          <>
            <div className="kpi-grid">
              <div className="card card-hover">
                <div className="kpi-top">
                  <span className="kpi-icon">
                    <Phone size={16} />
                  </span>
                  <span className="badge badge-ok">Inbound + Outbound</span>
                </div>
                <div className="kpi-label">TOTAL CALL SESSIONS</div>
                <div className="kpi-value">{calls.length}</div>
                <div className="muted">{activeCampaignsCount} outbound campaigns active</div>
              </div>

              <div className="card card-hover">
                <div className="kpi-top">
                  <span className="kpi-icon">
                    <CalendarCheck2 size={16} />
                  </span>
                  <span className="badge badge-ok">Synced</span>
                </div>
                <div className="kpi-label">BOOKED APPOINTMENTS</div>
                <div className="kpi-value">{appointments.length}</div>
                <div className="muted">PostgreSQL + Calendar outbox</div>
              </div>

              <div className="card card-hover">
                <div className="kpi-top">
                  <span className="kpi-icon">
                    <UserCheck size={16} />
                  </span>
                  <span className="badge badge-accent">
                    {perfMetrics?.toolSuccessRate != null
                      ? `${perfMetrics.toolSuccessRate}%`
                      : '100%'}
                  </span>
                </div>
                <div className="kpi-label">CAPTURED LEADS</div>
                <div className="kpi-value">{leads.length}</div>
                <div className="muted">{slots.length} upcoming open slots</div>
              </div>

              <div className="card card-hover">
                <div className="kpi-top">
                  <span className="kpi-icon">
                    <Activity size={16} />
                  </span>
                  <span className="badge badge-ok">Low Latency</span>
                </div>
                <div className="kpi-label">AVG TOOL RESPONSE</div>
                <div className="kpi-value">
                  {perfMetrics?.avgToolDurationMs != null
                    ? `${(perfMetrics.avgToolDurationMs / 1000).toFixed(2)}s`
                    : '—'}
                </div>
                <div className="muted">
                  P95:{' '}
                  {perfMetrics?.p95ToolDurationMs != null
                    ? `${(perfMetrics.p95ToolDurationMs / 1000).toFixed(2)}s`
                    : '—'}
                </div>
              </div>
            </div>

            <div className="two-col-grid">
              <div className="card monitor-card">
                <div className="card-header">
                  <div>
                    <h3>Active Call Monitor</h3>
                    <div className="muted">
                      {business?.receptionistName ?? 'Sarah'} · Voice: {business?.aiVoice ?? 'Puck'}
                    </div>
                  </div>
                  <span
                    className={`badge ${
                      callSnap.status === 'connected' ? 'badge-danger' : 'badge-accent'
                    }`}
                  >
                    <span
                      className={`status-dot ${
                        callSnap.status === 'connected' ? 'danger' : 'accent'
                      }`}
                    />
                    {callSnap.status === 'connected' ? 'Live' : 'Ready'}
                  </span>
                </div>

                <div className="monitor-wave-box">
                  <AudioWaveform
                    active={
                      callSnap.status === 'connected' &&
                      (callSnap.agentSpeaking || (callSnap.userSpeaking && !callSnap.muted))
                    }
                    mode={waveMode}
                  />
                </div>

                <div className="monitor-footer">
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                      {callSnap.status === 'connected'
                        ? `${business?.receptionistName ?? 'Sarah'} · ${callMode === 'inbound' ? 'Inbound' : 'Outbound'} Live`
                        : `${business?.receptionistName ?? 'Sarah'} is standing by`}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {callSnap.status === 'connected'
                        ? `Duration ${formatTimer(callSnap.elapsedSec)}`
                        : 'Click Start Call to launch Voice Playground'}
                    </div>
                  </div>
                  <button
                    className="btn btn-bright"
                    onClick={() => {
                      setSection('playground');
                      if (callSnap.status === 'idle') {
                        orbControllerRef.current?.startCall();
                      }
                    }}
                  >
                    <PhoneCall size={15} />
                    {callSnap.status === 'idle' ? 'Start Call' : 'Open Playground'}
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h3>AI Line & Pipeline Status</h3>
                    <div className="muted">Inbound reception & outbound automation</div>
                  </div>
                  <span className="badge badge-ok">Operational</span>
                </div>

                <div className="status-lines">
                  <div className="status-line-row">
                    <div className="status-line-left">
                      <span className="status-dot" />
                      <span>Inbound Receptionist Line</span>
                    </div>
                    <span className="muted">{channelSettings.inboundPhone}</span>
                  </div>
                  <div className="status-line-row">
                    <div className="status-line-left">
                      <span className="status-dot" />
                      <span>Outbound Follow-up Dialer</span>
                    </div>
                    <span className="muted">{activeCampaignsCount} active campaigns</span>
                  </div>
                  <div className="status-line-row">
                    <div className="status-line-left">
                      <span className="status-dot accent" />
                      <span>Google Calendar Outbox</span>
                    </div>
                    <span className="muted">15s background sync</span>
                  </div>
                  <div className="status-line-row">
                    <div className="status-line-left">
                      <span className="status-dot accent" />
                      <span>WhatsApp Confirmations</span>
                    </div>
                    <span className="muted">
                      {channelSettings.autoWhatsappConfirm ? 'Enabled' : 'Paused'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3>Recent Booked Appointments</h3>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setSection('appointments')}
                >
                  View All
                </button>
              </div>
              {appointments.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No appointments booked yet. Click Start Call to test a live booking!
                </p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Booking ID</th>
                        <th>Customer</th>
                        <th>Phone</th>
                        <th>Date & Time</th>
                        <th>Reason</th>
                        <th>Calendar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {appointments.slice(0, 5).map((appt) => (
                        <tr key={appt.id}>
                          <td>
                            <span className="badge badge-accent" style={{ fontFamily: 'monospace' }}>
                              {appt.bookingCode || `BK${appt.id.slice(0, 6).toUpperCase()}`}
                            </span>
                          </td>
                          <td>
                            <strong>{appt.customerName}</strong>
                            {appt.address && (
                              <div className="muted" style={{ fontSize: 12 }}>
                                {appt.address}
                              </div>
                            )}
                          </td>
                          <td>{appt.phoneE164}</td>
                          <td>{formatDateTime(appt.startsAt, appt.timezone)}</td>
                          <td>{appt.reason}</td>
                          <td>
                            <span
                              className={`badge ${appt.googleEventId ? 'badge-ok' : 'badge-accent'}`}
                            >
                              {appt.googleEventId ? 'Synced' : 'Local DB'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* =======================================================
            2. VOICE AGENTS & PERSONAS
           ======================================================= */}
        {section === 'agents' && (
          <>
            <div className="agent-cards-grid">
              <div className="card card-hover">
                <div className="agent-card-top">
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div className="agent-avatar">
                      <PhoneIncoming size={18} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>
                        {business?.receptionistName ?? 'Sarah'} · Inbound Receptionist
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Answers 24/7 calls · Books slots · Captures leads
                      </div>
                    </div>
                  </div>
                  <span className="badge badge-ok">Active</span>
                </div>
                <div className="pill-list" style={{ marginBottom: 14 }}>
                  <span className="badge">Voice: {business?.aiVoice ?? 'Puck'}</span>
                  <span className="badge">English (US)</span>
                  <span className="badge">Gemini Native Audio</span>
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setCallMode('inbound');
                    setSection('playground');
                  }}
                >
                  <AudioLines size={14} /> Test in Playground
                </button>
              </div>

              <div className="card card-hover">
                <div className="agent-card-top">
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div className="agent-avatar">
                      <PhoneOutgoing size={18} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>
                        {business?.receptionistName ?? 'Sarah'} · Outbound Follow-Up
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Appointment reminders · Missed-call & lead callbacks
                      </div>
                    </div>
                  </div>
                  <span className="badge badge-accent">{activeCampaignsCount} Campaigns</span>
                </div>
                <div className="pill-list" style={{ marginBottom: 14 }}>
                  <span className="badge">Voice: {business?.aiVoice ?? 'Puck'}</span>
                  <span className="badge">SIP Outbound Ready</span>
                  <span className="badge">Auto-Retry</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setCallMode('outbound');
                      setSection('playground');
                    }}
                  >
                    <PhoneOutgoing size={14} /> Test Outbound
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSection('outbound')}
                  >
                    Manage Campaigns
                  </button>
                </div>
              </div>
            </div>

            {profileForm && (
              <form className="card" onSubmit={handleSaveBusiness}>
                <div className="card-header">
                  <div>
                    <h3>Voice & Persona Settings</h3>
                    <div className="muted">
                      Updates sync directly to your live LiveKit AI agent worker
                    </div>
                  </div>
                  {canEdit && (
                    <button className="btn btn-sm" type="submit" disabled={savingProfile}>
                      <Save size={14} /> {savingProfile ? 'Saving...' : 'Save Agent Settings'}
                    </button>
                  )}
                </div>
                {saveMessage && <div className="success-box">{saveMessage}</div>}
                {saveError && <div className="error-box">{saveError}</div>}

                <div className="form-grid">
                  <div>
                    <label className="field-label">Agent Persona Name</label>
                    <input
                      className="input"
                      value={profileForm.receptionistName}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setProfileForm({ ...profileForm, receptionistName: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className="field-label">Voice Profile</label>
                    <select
                      className="select"
                      value={profileForm.aiVoice}
                      disabled={!canEdit}
                      onChange={(e) => setProfileForm({ ...profileForm, aiVoice: e.target.value })}
                    >
                      {VOICE_OPTIONS.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </form>
            )}
          </>
        )}

        {/* =======================================================
            3. VOICE PLAYGROUND (EXACT SPLIT STUDIO LIKE IMAGE)
           ======================================================= */}
        {section === 'playground' && (
          <div className="playground-grid">
            <div className="playground-config-card">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <h3 style={{ margin: 0 }}>Voice Agent</h3>
                <div className="seg-tabs">
                  <button
                    type="button"
                    className={`seg-tab ${callMode === 'inbound' ? 'active' : ''}`}
                    onClick={() => setCallMode('inbound')}
                  >
                    Inbound
                  </button>
                  <button
                    type="button"
                    className={`seg-tab ${callMode === 'outbound' ? 'active' : ''}`}
                    onClick={() => setCallMode('outbound')}
                  >
                    Outbound
                  </button>
                </div>
              </div>
              <div className="muted" style={{ marginBottom: 16 }}>
                Real-time voice — wired to LiveKit WebRTC & Gemini Native Audio
              </div>

              {callSnap.error && <div className="error-box">{callSnap.error}</div>}
              {saveMessage && <div className="success-box">{saveMessage}</div>}

              {callMode === 'outbound' && (
                <>
                  <label className="field-label">Target Phone Number (Outbound Test)</label>
                  <input
                    className="input"
                    value={outboundTestNumber}
                    onChange={(e) => setOutboundTestNumber(e.target.value)}
                    placeholder="+1 (555) 019-2834"
                  />
                </>
              )}

              <label className="field-label">Agent</label>
              <input
                className="input"
                value={profileForm?.receptionistName ?? business?.receptionistName ?? 'Sarah'}
                disabled={!canEdit || !profileForm}
                onChange={(e) =>
                  profileForm &&
                  setProfileForm({ ...profileForm, receptionistName: e.target.value })
                }
              />

              <label className="field-label">Language</label>
              <select className="select" value="en-US" disabled>
                <option value="en-US">English (US) — Phase 1</option>
              </select>

              <label className="field-label">Voice</label>
              <select
                className="select"
                value={profileForm?.aiVoice ?? business?.aiVoice ?? 'Puck'}
                disabled={!canEdit || !profileForm}
                onChange={(e) =>
                  profileForm && setProfileForm({ ...profileForm, aiVoice: e.target.value })
                }
              >
                {VOICE_OPTIONS.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice} (Gemini Native)
                  </option>
                ))}
              </select>

              <label className="field-label">Microphone</label>
              <select
                className="select"
                value={selectedMicId}
                onChange={(e) => setSelectedMicId(e.target.value)}
              >
                <option value="default">System default</option>
                {micDevices.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
              </select>

              <div className="mic-test-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void handleToggleMicTest()}
                >
                  <Mic size={13} /> {micTesting ? 'Stop Test' : 'Test Mic'}
                </button>
                <div className="mic-meter-track">
                  <div className="mic-meter-fill" style={{ width: `${micLevel}%` }} />
                </div>
              </div>

              <label className="field-label">Experience Mode</label>
              <div className="input" style={{ marginBottom: 14, color: 'var(--muted)' }}>
                Voice Only — Native Audio, no avatar
              </div>

              {canEdit && profileForm && (
                <button
                  className="btn btn-secondary btn-sm"
                  style={{ width: '100%', marginBottom: 14 }}
                  disabled={savingProfile}
                  onClick={(e) => void handleSaveBusiness(e)}
                >
                  <Save size={14} /> {savingProfile ? 'Saving...' : 'Save Voice Settings'}
                </button>
              )}

              <div className="session-log-box">
                <div className="session-log-title">SESSION LOG</div>
                <div className="session-log-lines">
                  {callSnap.sessionLogs.slice(-6).map((line, idx) => (
                    <div key={idx}>{line}</div>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="debug-toggle"
                onClick={() => setShowDebug((prev) => !prev)}
              >
                <span>VOICE SESSION DEBUG</span>
                {showDebug ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              {showDebug && (
                <div className="session-log-box" style={{ marginTop: 8 }}>
                  <div className="session-log-lines">
                    <div>Mode: {callMode}</div>
                    <div>Model: {business?.aiModel ?? 'gemini-2.5-flash-native-audio'}</div>
                    <div>Agent Joined: {callSnap.agentJoined ? 'Yes' : 'No'}</div>
                    <div>Muted: {callSnap.muted ? 'Yes' : 'No'}</div>
                  </div>
                </div>
              )}
            </div>

            <div className="playground-stage-card">
              <div className="playground-stage-top">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>
                    {business?.receptionistName ?? 'Sarah'} ·{' '}
                    {callMode === 'inbound' ? 'Inbound Receptionist' : 'Outbound Caller'}
                  </div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {callMode === 'outbound'
                      ? `Dialing ${outboundTestNumber} · `
                      : 'English (US) · '}
                    Voice: {business?.aiVoice ?? 'Puck'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {callSnap.status === 'connected' ? 'Active session' : 'No active session'}
                  </div>
                  <div
                    style={{
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: 'var(--accent)',
                    }}
                  >
                    {formatTimer(callSnap.elapsedSec)}
                  </div>
                </div>
              </div>

              <div className="playground-stage-center">
                <span className={`badge ${callSnap.status === 'connected' ? 'badge-ok' : ''}`}>
                  <span
                    className={`status-dot ${callSnap.status === 'connected' ? '' : 'accent'}`}
                  />
                  {callSnap.status === 'idle'
                    ? 'Ready'
                    : callSnap.status === 'connecting'
                      ? 'Connecting...'
                      : callSnap.muted
                        ? 'Microphone Muted'
                        : callSnap.agentSpeaking
                          ? `${business?.receptionistName ?? 'Sarah'} Speaking`
                          : callSnap.userSpeaking
                            ? 'Listening to you...'
                            : 'Listening'}
                </span>

                <VoiceOrbSphere size="lg" stateClass={orbStateClass} />

                <div style={{ width: '100%', maxWidth: 260 }}>
                  <AudioWaveform
                    active={
                      callSnap.status === 'connected' &&
                      (callSnap.agentSpeaking || (callSnap.userSpeaking && !callSnap.muted))
                    }
                    mode={waveMode}
                  />
                </div>
              </div>

              <div>
                <div className="playground-stage-controls">
                  <button
                    className={`orb-action-btn ${callSnap.muted ? 'muted-active' : ''}`}
                    disabled={callSnap.status !== 'connected'}
                    onClick={() => orbControllerRef.current?.toggleMute()}
                    title={callSnap.muted ? 'Unmute' : 'Mute'}
                  >
                    {callSnap.muted ? <MicOff size={16} /> : <Mic size={16} />}
                  </button>

                  {callSnap.status === 'idle' ? (
                    <button
                      className="btn-start-call-pill"
                      onClick={() => {
                        stopMicTest();
                        orbControllerRef.current?.startCall();
                      }}
                    >
                      <Mic size={16} /> Start Call
                    </button>
                  ) : (
                    <button
                      className="btn-end-call-pill"
                      onClick={() => orbControllerRef.current?.endCall()}
                    >
                      <PhoneOff size={16} /> End Call
                    </button>
                  )}
                </div>

                <div className="playground-stage-footer">
                  State: <strong>{callSnap.status}</strong> · Session{' '}
                  <strong>{formatTimer(callSnap.elapsedSec)}</strong>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* =======================================================
            4. OUTBOUND CAMPAIGNS (ONGOING / OUTGOING CALLING)
           ======================================================= */}
        {section === 'outbound' && (
          <>
            <div className="kpi-grid">
              <div className="card">
                <div className="kpi-label">ACTIVE CAMPAIGNS</div>
                <div className="kpi-value">{activeCampaignsCount}</div>
                <div className="muted">Automated outbound dialers</div>
              </div>
              <div className="card">
                <div className="kpi-label">OUTBOUND CALLS QUEUED</div>
                <div className="kpi-value">
                  {campaigns.reduce((acc, c) => acc + (c.totalTargets - c.completedCalls), 0)}
                </div>
                <div className="muted">Scheduled within working hours</div>
              </div>
              <div className="card">
                <div className="kpi-label">COMPLETED DIALS</div>
                <div className="kpi-value">
                  {campaigns.reduce((acc, c) => acc + c.completedCalls, 0)}
                </div>
                <div className="muted">Answered & logged automatically</div>
              </div>
              <div className="card">
                <div className="kpi-label">OUTBOUND CALLER ID</div>
                <div className="kpi-value" style={{ fontSize: 20 }}>
                  {channelSettings.outboundCallerId}
                </div>
                <div className="muted">LiveKit SIP Trunk Ready</div>
              </div>
            </div>

            <form className="card" style={{ marginBottom: 20 }} onSubmit={handleCreateCampaign}>
              <div className="card-header">
                <div>
                  <h3>Launch New Outbound Campaign</h3>
                  <div className="muted">
                    Schedule AI reminder calls, lead follow-ups, or missed-call callbacks
                  </div>
                </div>
              </div>
              <div className="form-grid" style={{ alignItems: 'end' }}>
                <div>
                  <label className="field-label">Campaign Name</label>
                  <input
                    className="input"
                    style={{ marginBottom: 0 }}
                    value={newCampaignName}
                    onChange={(e) => setNewCampaignName(e.target.value)}
                    placeholder="e.g. Tomorrow HVAC Appointment Reminders"
                    required
                  />
                </div>
                <div>
                  <label className="field-label">Campaign Goal</label>
                  <select
                    className="select"
                    style={{ marginBottom: 0 }}
                    value={newCampaignType}
                    onChange={(e) =>
                      setNewCampaignType(e.target.value as OutboundCampaign['type'])
                    }
                  >
                    <option value="Appointment Reminder">Appointment Reminder</option>
                    <option value="Lead Follow-up">Lead Follow-up</option>
                    <option value="Missed Call Callback">Missed Call Callback</option>
                    <option value="Customer Feedback">Customer Feedback</option>
                  </select>
                </div>
                <div>
                  <button className="btn" type="submit" style={{ width: '100%' }}>
                    <Plus size={15} /> Create Campaign
                  </button>
                </div>
              </div>
            </form>

            <div className="agent-cards-grid">
              {campaigns.map((cmp) => {
                const pct =
                  cmp.totalTargets > 0
                    ? Math.round((cmp.completedCalls / cmp.totalTargets) * 100)
                    : 0;
                return (
                  <div className="card card-hover" key={cmp.id}>
                    <div className="agent-card-top">
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{cmp.name}</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                          {cmp.type} · {cmp.scheduleWindow}
                        </div>
                      </div>
                      <span
                        className={`badge ${
                          cmp.status === 'active'
                            ? 'badge-ok'
                            : cmp.status === 'scheduled'
                              ? 'badge-accent'
                              : ''
                        }`}
                      >
                        {cmp.status}
                      </span>
                    </div>

                    <p className="muted" style={{ fontSize: 12.5, margin: '8px 0 12px' }}>
                      “{cmp.scriptPreview}”
                    </p>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 12,
                        color: 'var(--muted)',
                      }}
                    >
                      <span>
                        Progress: {cmp.completedCalls}/{cmp.totalTargets} calls ({pct}%)
                      </span>
                      <span>Connect rate: {cmp.connectedRate}%</span>
                    </div>
                    <div className="progress-track">
                      <div
                        className={`progress-fill ${cmp.status === 'active' ? 'ok' : ''}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => toggleCampaignStatus(cmp.id)}
                      >
                        {cmp.status === 'active' ? (
                          <>
                            <Pause size={13} /> Pause
                          </>
                        ) : (
                          <>
                            <Play size={13} /> Activate
                          </>
                        )}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setCallMode('outbound');
                          setSection('playground');
                        }}
                      >
                        <PhoneForwarded size={13} /> Test Call
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* =======================================================
            5. APPOINTMENTS
           ======================================================= */}
        {section === 'appointments' && (
          <>
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <div>
                  <h3>Booked Appointments</h3>
                  <div className="muted">
                    Confirmed bookings stored in PostgreSQL and synced via Google Calendar outbox.
                  </div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void loadDashboard()}
                  disabled={refreshing}
                >
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>
              {appointments.length === 0 ? (
                <p className="muted">No booked appointments yet.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Booking ID</th>
                        <th>Customer</th>
                        <th>Phone</th>
                        <th>Address</th>
                        <th>Scheduled Time</th>
                        <th>Reason</th>
                        <th>Status</th>
                        <th>Calendar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {appointments.map((appt) => (
                        <tr key={appt.id}>
                          <td>
                            <span className="badge badge-accent" style={{ fontFamily: 'monospace' }}>
                              {appt.bookingCode || `BK${appt.id.slice(0, 6).toUpperCase()}`}
                            </span>
                          </td>
                          <td>
                            <strong>{appt.customerName}</strong>
                            {appt.customerEmail && (
                              <div className="muted" style={{ fontSize: 12 }}>
                                {appt.customerEmail}
                              </div>
                            )}
                          </td>
                          <td>{appt.phoneE164}</td>
                          <td>{appt.address || <span className="muted">—</span>}</td>
                          <td>{formatDateTime(appt.startsAt, appt.timezone)}</td>
                          <td>{appt.reason}</td>
                          <td>
                            <span className="badge badge-ok">{appt.status}</span>
                          </td>
                          <td>
                            <span
                              className={`badge ${appt.googleEventId ? 'badge-ok' : 'badge-accent'}`}
                            >
                              {appt.googleEventId ? 'Synced' : 'Queued / Local'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <h3>Upcoming Open Slots</h3>
                  <div className="muted">
                    Live availability window for {business?.timezone ?? 'UTC'}
                  </div>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Day</th>
                      <th>Window</th>
                      <th>Timezone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slots.map((slot) => (
                      <tr key={slot.slotId}>
                        <td>{slot.date}</td>
                        <td>{slot.day}</td>
                        <td>
                          {slot.startTime} – {slot.endTime}
                        </td>
                        <td>{slot.timezone}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* =======================================================
            6. LEADS & CONTACTS
           ======================================================= */}
        {section === 'leads' && (
          <div className="card">
            <div className="card-header">
              <div>
                <h3>Captured Leads & Contacts</h3>
                <div className="muted">
                  Trigger instant outbound follow-up calls directly from captured leads
                </div>
              </div>
            </div>
            {leads.length === 0 ? (
              <p className="muted">No leads captured yet for this business.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Location</th>
                      <th>Preferred Time</th>
                      <th>Reason</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead) => (
                      <tr key={lead.id}>
                        <td>
                          <strong>{lead.customerName}</strong>
                        </td>
                        <td>{lead.phoneE164}</td>
                        <td>{lead.location || <span className="muted">—</span>}</td>
                        <td>{lead.preferredTime || <span className="muted">—</span>}</td>
                        <td>{lead.reason}</td>
                        <td>
                          <span className="badge badge-accent">{lead.status}</span>
                        </td>
                        <td>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setOutboundTestNumber(lead.phoneE164);
                              setCallMode('outbound');
                              setSection('playground');
                            }}
                          >
                            <PhoneOutgoing size={13} /> Call Back
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* =======================================================
            7. CALL LOGS & REPLAY
           ======================================================= */}
        {section === 'calls' && (
          <div className="card">
            <div className="card-header">
              <div>
                <h3>Call Logs & Session History</h3>
                <div className="muted">Filter inbound and outbound voice sessions</div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div className="seg-tabs">
                  <button
                    type="button"
                    className={`seg-tab ${callFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setCallFilter('all')}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`seg-tab ${callFilter === 'inbound' ? 'active' : ''}`}
                    onClick={() => setCallFilter('inbound')}
                  >
                    Inbound
                  </button>
                  <button
                    type="button"
                    className={`seg-tab ${callFilter === 'outbound' ? 'active' : ''}`}
                    onClick={() => setCallFilter('outbound')}
                  >
                    Outbound
                  </button>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void loadDashboard()}
                  disabled={refreshing}
                >
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>
            </div>
            {filteredCalls.length === 0 ? (
              <p className="muted">No call sessions match this filter yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Direction</th>
                      <th>Room / Session</th>
                      <th>Status</th>
                      <th>Started At</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCalls.map((call) => {
                      const isOutbound = call.roomName.toLowerCase().includes('outbound');
                      return (
                        <tr key={call.id}>
                          <td>
                            <span className="badge">
                              {isOutbound ? (
                                <>
                                  <PhoneOutgoing size={12} /> Outbound
                                </>
                              ) : (
                                <>
                                  <PhoneIncoming size={12} /> Inbound
                                </>
                              )}
                            </span>
                          </td>
                          <td>
                            <code style={{ color: 'var(--accent)', fontSize: 12.5 }}>
                              {call.roomName}
                            </code>
                          </td>
                          <td>
                            <span
                              className={`badge ${
                                call.status === 'completed' || call.status === 'active'
                                  ? 'badge-ok'
                                  : ''
                              }`}
                            >
                              {call.status}
                            </span>
                          </td>
                          <td>{formatDateTime(call.startedAt, business?.timezone)}</td>
                          <td>{formatDuration(call.durationSeconds)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* =======================================================
            8. VOICE ANALYTICS
           ======================================================= */}
        {section === 'analytics' && (
          <>
            <div className="kpi-grid">
              <div className="card">
                <div className="kpi-label">AVG TOOL LATENCY</div>
                <div className="kpi-value">
                  {perfMetrics?.avgToolDurationMs != null
                    ? `${(perfMetrics.avgToolDurationMs / 1000).toFixed(2)}s`
                    : '—'}
                </div>
                <div className="muted">
                  P50:{' '}
                  {perfMetrics?.p50ToolDurationMs != null
                    ? `${perfMetrics.p50ToolDurationMs}ms`
                    : '—'}
                </div>
              </div>
              <div className="card">
                <div className="kpi-label">P95 TOOL LATENCY</div>
                <div className="kpi-value">
                  {perfMetrics?.p95ToolDurationMs != null
                    ? `${(perfMetrics.p95ToolDurationMs / 1000).toFixed(2)}s`
                    : '—'}
                </div>
                <div className="muted">Samples: {perfMetrics?.sampleCount ?? 0}</div>
              </div>
              <div className="card">
                <div className="kpi-label">TOOL SUCCESS RATE</div>
                <div className="kpi-value">
                  {perfMetrics?.toolSuccessRate != null ? `${perfMetrics.toolSuccessRate}%` : '—'}
                </div>
                <div className="muted">Zero double-booking violations</div>
              </div>
              <div className="card">
                <div className="kpi-label">BOOKING CONVERSION</div>
                <div className="kpi-value">
                  {calls.length > 0
                    ? `${Math.min(100, Math.round((appointments.length / calls.length) * 100))}%`
                    : '—'}
                </div>
                <div className="muted">
                  {appointments.length} bookings from {calls.length} calls
                </div>
              </div>
            </div>

            <div className="two-col-grid">
              <div className="card">
                <h3 style={{ marginTop: 0 }}>Infrastructure Health</h3>
                <div className="status-lines">
                  <div className="status-line-row">
                    <span>PostgreSQL Connection Pool</span>
                    <strong>
                      {perfMetrics?.dbPool
                        ? `${perfMetrics.dbPool.total} active / ${perfMetrics.dbPool.idle} idle`
                        : 'Healthy'}
                    </strong>
                  </div>
                  <div className="status-line-row">
                    <span>Google Calendar Sync Worker</span>
                    <span className="badge badge-ok">15s Interval</span>
                  </div>
                  <div className="status-line-row">
                    <span>Voice Runtime Engine</span>
                    <span className="badge badge-accent">LiveKit Cloud WebRTC</span>
                  </div>
                </div>
              </div>

              <div className="card">
                <h3 style={{ marginTop: 0 }}>Call Outcome Breakdown</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>Appointments Booked</span>
                      <strong>{appointments.length}</strong>
                    </div>
                    <div className="progress-track">
                      <div
                        className="progress-fill ok"
                        style={{
                          width: `${calls.length > 0 ? Math.min(100, Math.round((appointments.length / Math.max(calls.length, 1)) * 100)) : 20}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>Leads & Callback Requests</span>
                      <strong>{leads.length}</strong>
                    </div>
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{
                          width: `${calls.length > 0 ? Math.min(100, Math.round((leads.length / Math.max(calls.length, 1)) * 100)) : 15}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* =======================================================
            9. KNOWLEDGE BASE (PROFILE, HOURS & SERVICES)
           ======================================================= */}
        {section === 'knowledge' && profileForm && business && (
          <form className="card" onSubmit={handleSaveBusiness}>
            <div className="card-header">
              <div>
                <h3>Business Knowledge Base & Operating Hours</h3>
                <div className="muted">
                  Everything your AI voice agent knows — synced live to PostgreSQL
                </div>
              </div>
              {canEdit && (
                <button className="btn btn-sm" type="submit" disabled={savingProfile}>
                  <Save size={14} /> {savingProfile ? 'Saving...' : 'Save Knowledge Base'}
                </button>
              )}
            </div>

            {saveMessage && <div className="success-box">{saveMessage}</div>}
            {saveError && <div className="error-box">{saveError}</div>}

            <div className="form-grid">
              <div>
                <label className="field-label">Organization Name</label>
                <input
                  className="input"
                  value={profileForm.name}
                  disabled={!canEdit}
                  onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                />
              </div>
              <div>
                <label className="field-label">Location</label>
                <input
                  className="input"
                  value={profileForm.location}
                  disabled={!canEdit}
                  onChange={(e) => setProfileForm({ ...profileForm, location: e.target.value })}
                />
              </div>
              <div>
                <label className="field-label">Timezone (IANA)</label>
                <input
                  className="input"
                  value={profileForm.timezone}
                  disabled={!canEdit}
                  onChange={(e) => setProfileForm({ ...profileForm, timezone: e.target.value })}
                />
              </div>
              <div>
                <label className="field-label">Service Areas (comma-separated)</label>
                <input
                  className="input"
                  value={profileForm.serviceAreasText}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setProfileForm({ ...profileForm, serviceAreasText: e.target.value })
                  }
                />
              </div>
            </div>

            <label className="field-label">Business Description</label>
            <textarea
              className="textarea"
              value={profileForm.description}
              disabled={!canEdit}
              onChange={(e) => setProfileForm({ ...profileForm, description: e.target.value })}
            />

            <div className="field-label">Active Services</div>
            <div className="pill-list">
              {business.services.map((svc) => (
                <span className="service-pill" key={svc}>
                  {svc}
                </span>
              ))}
            </div>

            <h4 style={{ margin: '12px 0 10px' }}>Weekly Operating Hours</h4>
            <div className="form-grid">
              {Object.entries(profileForm.hours).map(([day, value]) => (
                <div key={day}>
                  <label className="field-label" style={{ textTransform: 'capitalize' }}>
                    {day}
                  </label>
                  <input
                    className="input"
                    value={value}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setProfileForm({
                        ...profileForm,
                        hours: { ...profileForm.hours, [day]: e.target.value },
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </form>
        )}

        {/* =======================================================
            10. CHANNEL ACTIVATION (PHONE SIP + WHATSAPP)
           ======================================================= */}
        {section === 'channels' && (
          <form onSubmit={handleSaveChannels}>
            {channelSaved && (
              <div className="success-box">
                Telephony & WhatsApp channel settings saved for this organization.
              </div>
            )}
            <div className="two-col-grid">
              <div className="card">
                <div className="card-header">
                  <h3>Phone & SIP Trunking</h3>
                  <span className="badge badge-accent">LiveKit SIP Ready</span>
                </div>
                <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
                  Configure inbound reception numbers, outbound caller ID, and human transfer lines
                  via Twilio or Telnyx SIP trunks.
                </p>
                <label className="field-label">Inbound Business Number (E.164)</label>
                <input
                  className="input"
                  value={channelSettings.inboundPhone}
                  onChange={(e) =>
                    setChannelSettings({ ...channelSettings, inboundPhone: e.target.value })
                  }
                />
                <label className="field-label">Outbound Campaign Caller ID</label>
                <input
                  className="input"
                  value={channelSettings.outboundCallerId}
                  onChange={(e) =>
                    setChannelSettings({ ...channelSettings, outboundCallerId: e.target.value })
                  }
                />
                <label className="field-label">Human Escalation / Transfer Number</label>
                <input
                  className="input"
                  value={channelSettings.transferPhone}
                  onChange={(e) =>
                    setChannelSettings({ ...channelSettings, transferPhone: e.target.value })
                  }
                />
              </div>

              <div className="card">
                <div className="card-header">
                  <h3>WhatsApp Automation</h3>
                  <span className="badge badge-ok">Meta Cloud API Ready</span>
                </div>
                <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
                  Automatically send instant WhatsApp confirmations and reminders right after an AI
                  call books an appointment.
                </p>
                <label className="field-label">WhatsApp Business Number</label>
                <input
                  className="input"
                  value={channelSettings.whatsappNumber}
                  onChange={(e) =>
                    setChannelSettings({ ...channelSettings, whatsappNumber: e.target.value })
                  }
                />

                <div className="toggle-row">
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>Auto-Booking Confirmation</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Send WhatsApp receipt immediately when a call books a slot
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`toggle-switch ${channelSettings.autoWhatsappConfirm ? 'on' : ''}`}
                    onClick={() =>
                      setChannelSettings({
                        ...channelSettings,
                        autoWhatsappConfirm: !channelSettings.autoWhatsappConfirm,
                      })
                    }
                    aria-label="Toggle auto booking confirmation"
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>

                <div className="toggle-row">
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>1-Hour Reminder Message</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Reduce no-shows with automated appointment reminders
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`toggle-switch ${channelSettings.autoWhatsappReminder ? 'on' : ''}`}
                    onClick={() =>
                      setChannelSettings({
                        ...channelSettings,
                        autoWhatsappReminder: !channelSettings.autoWhatsappReminder,
                      })
                    }
                    aria-label="Toggle reminder message"
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>

                <label className="field-label">Confirmation Message Template</label>
                <textarea
                  className="textarea"
                  value={channelSettings.whatsappTemplate}
                  onChange={(e) =>
                    setChannelSettings({ ...channelSettings, whatsappTemplate: e.target.value })
                  }
                />
              </div>
            </div>

            <button className="btn" type="submit">
              <Save size={15} /> Save Channel Configuration
            </button>
          </form>
        )}

        {/* =======================================================
            11. POLICIES & GUARDRAILS
           ======================================================= */}
        {section === 'policies' && profileForm && (
          <form className="card" onSubmit={handleSaveBusiness}>
            <div className="card-header">
              <div>
                <h3>Policies & AI Guardrails</h3>
                <div className="muted">
                  Strict rules enforced on every inbound and outbound conversation
                </div>
              </div>
              {canEdit && (
                <button className="btn btn-sm" type="submit" disabled={savingProfile}>
                  <Save size={14} /> {savingProfile ? 'Saving...' : 'Save Policies'}
                </button>
              )}
            </div>

            {saveMessage && <div className="success-box">{saveMessage}</div>}
            {saveError && <div className="error-box">{saveError}</div>}

            <div className="two-col-grid" style={{ marginBottom: 16 }}>
              <div className="toggle-row" style={{ marginBottom: 0 }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>Double-Booking Prevention</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    PostgreSQL atomic slot locking enforced on every booking
                  </div>
                </div>
                <span className="badge badge-ok">Enforced</span>
              </div>
              <div className="toggle-row" style={{ marginBottom: 0 }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>Language Guardrail</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    English-only polite enforcement (Phase 1 release)
                  </div>
                </div>
                <span className="badge badge-accent">Strict</span>
              </div>
            </div>

            <label className="field-label">Pricing & Quoting Policy</label>
            <textarea
              className="textarea"
              value={profileForm.pricingPolicy}
              disabled={!canEdit}
              onChange={(e) => setProfileForm({ ...profileForm, pricingPolicy: e.target.value })}
            />

            <label className="field-label">Emergency & Escalation Policy</label>
            <textarea
              className="textarea"
              value={profileForm.emergencyPolicy}
              disabled={!canEdit}
              onChange={(e) => setProfileForm({ ...profileForm, emergencyPolicy: e.target.value })}
            />
          </form>
        )}

        {/* =======================================================
            12. TEAM & PERMISSIONS
           ======================================================= */}
        {section === 'team' && (
          <div className="card">
            <div className="card-header">
              <div>
                <h3>Team & Permissions</h3>
                <div className="muted">Role-based access control for your organization</div>
              </div>
            </div>
            {user.role === 'staff' ? (
              <p className="muted">
                Only organization owners and admins can view or manage team members.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((member) => (
                      <tr key={member.id}>
                        <td>
                          <strong>{member.fullName}</strong>
                        </td>
                        <td>{member.email}</td>
                        <td>
                          <span className="badge badge-accent" style={{ textTransform: 'capitalize' }}>
                            {member.role}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>

      <FloatingVoiceOrb
        authToken={token}
        businessName={business?.name ?? 'Your Business'}
        receptionistName={business?.receptionistName ?? 'Sarah'}
        inPlayground={section === 'playground'}
        onOpenPlayground={() => setSection('playground')}
        controllerRef={orbControllerRef}
        onSnapshotChange={setCallSnap}
        onCallEnded={() => void loadDashboard()}
      />
    </div>
  );
}
