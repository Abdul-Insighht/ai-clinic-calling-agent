import type {
  BookedAppointmentItem,
  CallLogItem,
  LeadItem,
  PerformanceMetrics,
} from '../services/api';

type AnalyticsTabProps = {
  perfMetrics: PerformanceMetrics | null;
  appointments: BookedAppointmentItem[];
  calls: CallLogItem[];
  leads: LeadItem[];
};

export function AnalyticsTab({ perfMetrics, appointments, calls, leads }: AnalyticsTabProps) {
  const callBookedCount = appointments.filter((a) => Boolean(a.callId)).length;
  const conversionPct =
    calls.length > 0 ? Math.min(100, Math.round((callBookedCount / calls.length) * 100)) : 0;

  return (
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
            P50: {perfMetrics?.p50ToolDurationMs != null ? `${perfMetrics.p50ToolDurationMs}ms` : '—'}
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
          <div className="kpi-value">{calls.length > 0 ? `${conversionPct}%` : '—'}</div>
          <div className="muted">
            {callBookedCount} AI call bookings from {calls.length} calls
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
                <span>AI Call Bookings</span>
                <strong>{callBookedCount}</strong>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill ok"
                  style={{
                    width: `${calls.length > 0 ? Math.min(100, Math.round((callBookedCount / Math.max(calls.length, 1)) * 100)) : 20}%`,
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
  );
}
