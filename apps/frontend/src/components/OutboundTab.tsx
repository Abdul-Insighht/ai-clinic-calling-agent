import { Pause, PhoneForwarded, Play, Plus } from 'lucide-react';
import type { FormEvent } from 'react';
import type { OutboundCampaign } from '../services/api';

type OutboundTabProps = {
  campaigns: OutboundCampaign[];
  activeCampaignsCount: number;
  outboundCallerId: string;
  newCampaignName: string;
  newCampaignType: OutboundCampaign['type'];
  onChangeName: (v: string) => void;
  onChangeType: (v: OutboundCampaign['type']) => void;
  onCreateCampaign: (e: FormEvent) => void;
  onToggleStatus: (id: string) => void;
  onTestCall: () => void;
};

export function OutboundTab({
  campaigns,
  activeCampaignsCount,
  outboundCallerId,
  newCampaignName,
  newCampaignType,
  onChangeName,
  onChangeType,
  onCreateCampaign,
  onToggleStatus,
  onTestCall,
}: OutboundTabProps) {
  return (
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
            {outboundCallerId}
          </div>
          <div className="muted">LiveKit SIP Trunk Ready</div>
        </div>
      </div>

      <form className="card" style={{ marginBottom: 20 }} onSubmit={onCreateCampaign}>
        <div className="card-header">
          <div>
            <h3>Launch New Outbound Campaign</h3>
            <div className="muted">
              Schedule AI reminder calls, patient follow-ups, or missed-call callbacks
            </div>
          </div>
          <span className="badge badge-ok">PostgreSQL Synced</span>
        </div>
        <div className="form-grid" style={{ alignItems: 'end' }}>
          <div>
            <label className="field-label">Campaign Name</label>
            <input
              className="input"
              style={{ marginBottom: 0 }}
              value={newCampaignName}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="e.g. Tomorrow Clinic Appointment Reminders"
              required
            />
          </div>
          <div>
            <label className="field-label">Campaign Goal</label>
            <select
              className="select"
              style={{ marginBottom: 0 }}
              value={newCampaignType}
              onChange={(e) => onChangeType(e.target.value as OutboundCampaign['type'])}
            >
              <option value="Appointment Reminder">Appointment Reminder</option>
              <option value="Lead Follow-up">Lead Follow-up</option>
              <option value="Missed Call Callback">Missed Call Callback</option>
              <option value="Patient Feedback">Patient Feedback</option>
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
            cmp.totalTargets > 0 ? Math.round((cmp.completedCalls / cmp.totalTargets) * 100) : 0;
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
                  onClick={() => onToggleStatus(cmp.id)}
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
                <button className="btn btn-sm" onClick={onTestCall}>
                  <PhoneForwarded size={13} /> Test Call
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
