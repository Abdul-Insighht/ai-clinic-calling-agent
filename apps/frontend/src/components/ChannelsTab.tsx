import { Save } from 'lucide-react';
import type { FormEvent } from 'react';
import type { ChannelSettings } from '../services/api';

type ChannelsTabProps = {
  channelSettings: ChannelSettings;
  channelSaved: boolean;
  onChange: (next: ChannelSettings) => void;
  onSubmit: (e: FormEvent) => void;
};

export function ChannelsTab({
  channelSettings,
  channelSaved,
  onChange,
  onSubmit,
}: ChannelsTabProps) {
  return (
    <form onSubmit={onSubmit}>
      {channelSaved && (
        <div className="success-box">
          Telephony & WhatsApp channel settings saved and synced to PostgreSQL.
        </div>
      )}
      <div className="two-col-grid">
        <div className="card">
          <div className="card-header">
            <h3>Phone & SIP Trunking</h3>
            <span className="badge badge-accent">LiveKit SIP Ready</span>
          </div>
          <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
            Configure inbound reception numbers, outbound caller ID, and human transfer lines via
            Twilio or Telnyx SIP trunks.
          </p>
          <label className="field-label">Inbound Business Number (E.164)</label>
          <input
            className="input"
            value={channelSettings.inboundPhone}
            onChange={(e) => onChange({ ...channelSettings, inboundPhone: e.target.value })}
          />
          <label className="field-label">Outbound Campaign Caller ID</label>
          <input
            className="input"
            value={channelSettings.outboundCallerId}
            onChange={(e) => onChange({ ...channelSettings, outboundCallerId: e.target.value })}
          />
          <label className="field-label">Human Escalation / Transfer Number</label>
          <input
            className="input"
            value={channelSettings.transferPhone}
            onChange={(e) => onChange({ ...channelSettings, transferPhone: e.target.value })}
          />
        </div>

        <div className="card">
          <div className="card-header">
            <h3>WhatsApp Automation</h3>
            <span className="badge badge-ok">Meta Cloud API Ready</span>
          </div>
          <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
            Automatically send instant WhatsApp confirmations and reminders right after an AI call
            books an appointment.
          </p>
          <label className="field-label">WhatsApp Business Number</label>
          <input
            className="input"
            value={channelSettings.whatsappNumber}
            onChange={(e) => onChange({ ...channelSettings, whatsappNumber: e.target.value })}
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
                onChange({
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
                onChange({
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
            onChange={(e) => onChange({ ...channelSettings, whatsappTemplate: e.target.value })}
          />
        </div>
      </div>

      <button className="btn" type="submit">
        <Save size={15} /> Save Channel Configuration
      </button>
    </form>
  );
}
