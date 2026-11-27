import { ExternalLink, X } from 'lucide-react';
import type { BookedAppointmentItem, CallLogItem } from '../services/api';

type CallDetailDrawerProps = {
  call: CallLogItem;
  linkedAppt?: BookedAppointmentItem;
  timezone?: string;
  formatDateTime: (iso: string, tz?: string) => string;
  formatDuration: (seconds: number | null) => string;
  onClose: () => void;
};

export function CallDetailDrawer({
  call,
  linkedAppt,
  timezone,
  formatDateTime,
  formatDuration,
  onClose,
}: CallDetailDrawerProps) {
  const isOutbound = call.roomName.toLowerCase().includes('outbound');
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 94vw)',
          height: '100%',
          background: 'var(--bg-card, #111827)',
          borderLeft: '1px solid var(--border, #1f2937)',
          padding: 24,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>Call Session Details</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              {call.id}
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose} title="Close drawer">
            <X size={15} />
          </button>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <div className="status-lines">
            <div className="status-line-row">
              <span>Direction</span>
              <span className="badge">{isOutbound ? 'Outbound' : 'Inbound'}</span>
            </div>
            <div className="status-line-row">
              <span>Room / Session</span>
              <code style={{ color: 'var(--accent)', fontSize: 12 }}>{call.roomName}</code>
            </div>
            <div className="status-line-row">
              <span>Status</span>
              <span className="badge badge-ok">{call.status}</span>
            </div>
            <div className="status-line-row">
              <span>Started At</span>
              <span>{formatDateTime(call.startedAt, timezone)}</span>
            </div>
            <div className="status-line-row">
              <span>Ended At</span>
              <span>{call.endedAt ? formatDateTime(call.endedAt, timezone) : 'Active'}</span>
            </div>
            <div className="status-line-row">
              <span>Duration</span>
              <strong>{formatDuration(call.durationSeconds)}</strong>
            </div>
          </div>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>Linked Appointment</h4>
          {linkedAppt ? (
            <div className="status-lines">
              <div className="status-line-row">
                <span>Booking ID</span>
                <span className="badge badge-accent" style={{ fontFamily: 'monospace' }}>
                  {linkedAppt.bookingCode || `BK${linkedAppt.id.slice(0, 6).toUpperCase()}`}
                </span>
              </div>
              <div className="status-line-row">
                <span>Patient</span>
                <strong>{linkedAppt.customerName}</strong>
              </div>
              <div className="status-line-row">
                <span>Phone</span>
                <span>{linkedAppt.phoneE164}</span>
              </div>
              {linkedAppt.customerEmail && (
                <div className="status-line-row">
                  <span>Email</span>
                  <span>{linkedAppt.customerEmail}</span>
                </div>
              )}
              <div className="status-line-row">
                <span>Clinic Location</span>
                <span>{linkedAppt.address || '—'}</span>
              </div>
              <div className="status-line-row">
                <span>Reason</span>
                <span>{linkedAppt.reason}</span>
              </div>
              <div className="status-line-row">
                <span>Scheduled Time</span>
                <span>{formatDateTime(linkedAppt.startsAt, linkedAppt.timezone)}</span>
              </div>
              <div className="status-line-row">
                <span>Status</span>
                <span
                  className={`badge ${linkedAppt.status === 'cancelled' ? 'badge-danger' : 'badge-ok'}`}
                >
                  {linkedAppt.status}
                </span>
              </div>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No appointment was created during this call (general inquiry, lookup, or
              reschedule/cancel check).
            </p>
          )}
        </div>

        <div className="card" style={{ margin: 0 }}>
          <h4 style={{ marginTop: 0, marginBottom: 8 }}>Audio & Turn-by-Turn Transcript</h4>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            Full WebRTC audio traces, turn latencies, and live transcripts are archived in LiveKit
            Cloud Agent Observability.
          </p>
          <a
            href="https://cloud.livekit.io/projects/d_ai-receptionist-jrmem2uy/agents/CA_8zh49ZVULXCL"
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <ExternalLink size={14} /> Open LiveKit Observability
          </a>
        </div>
      </div>
    </div>
  );
}
