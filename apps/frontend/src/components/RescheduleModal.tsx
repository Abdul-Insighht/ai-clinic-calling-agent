import { CalendarClock, X } from 'lucide-react';
import type { AvailableSlot, BookedAppointmentItem } from '../services/api';

type RescheduleModalProps = {
  target: BookedAppointmentItem;
  day: string;
  slots: AvailableSlot[];
  selectedSlotId: string;
  loadingSlots: boolean;
  rescheduling: boolean;
  error: string | null;
  formatDateTime: (iso: string, tz?: string) => string;
  onChangeDay: (day: string) => void;
  onSelectSlot: (slotId: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function RescheduleModal({
  target,
  day,
  slots,
  selectedSlotId,
  loadingSlots,
  rescheduling,
  error,
  formatDateTime,
  onChangeDay,
  onSelectSlot,
  onConfirm,
  onClose,
}: RescheduleModalProps) {
  return (
    <div
      onClick={() => !rescheduling && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 'min(480px, 96vw)', margin: 0 }}
      >
        <div className="card-header">
          <div>
            <h3 style={{ margin: 0 }}>Reschedule Appointment</h3>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {target.bookingCode || `BK${target.id.slice(0, 6).toUpperCase()}`} ·{' '}
              {target.customerName}
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" disabled={rescheduling} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Current slot: <strong>{formatDateTime(target.startsAt, target.timezone)}</strong>
        </div>

        {error && <div className="error-box">{error}</div>}

        <label className="field-label">Filter Day (optional)</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <select
            className="select"
            style={{ marginBottom: 0 }}
            value={day}
            onChange={(e) => onChangeDay(e.target.value)}
          >
            <option value="">Next available days</option>
            <option value="today">Today</option>
            <option value="tomorrow">Tomorrow</option>
            <option value="monday">Monday</option>
            <option value="tuesday">Tuesday</option>
            <option value="wednesday">Wednesday</option>
            <option value="thursday">Thursday</option>
            <option value="friday">Friday</option>
            <option value="saturday">Saturday</option>
          </select>
        </div>

        <label className="field-label">Select New Open Slot</label>
        {loadingSlots ? (
          <p className="muted">Loading live open slots...</p>
        ) : slots.length === 0 ? (
          <p className="muted">No open slots available for this day. Try another day.</p>
        ) : (
          <select
            className="select"
            value={selectedSlotId}
            onChange={(e) => onSelectSlot(e.target.value)}
          >
            {slots.map((slot) => (
              <option key={slot.slotId} value={slot.slotId}>
                {slot.day} {slot.date} · {slot.startTime} – {slot.endTime}
              </option>
            ))}
          </select>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn btn-secondary btn-sm" disabled={rescheduling} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-sm"
            disabled={rescheduling || !selectedSlotId || loadingSlots}
            onClick={onConfirm}
          >
            <CalendarClock size={14} /> {rescheduling ? 'Rescheduling...' : 'Confirm Reschedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
