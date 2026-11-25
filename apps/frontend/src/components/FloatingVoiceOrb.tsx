import { Room, RoomEvent, Track } from 'livekit-client';
import { Maximize2, Mic, MicOff, PhoneCall, PhoneOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

export type CallStatus = 'idle' | 'connecting' | 'connected';

export type LiveCallSnapshot = {
  status: CallStatus;
  muted: boolean;
  agentJoined: boolean;
  agentSpeaking: boolean;
  userSpeaking: boolean;
  elapsedSec: number;
  error: string | null;
  sessionLogs: string[];
};

export type OrbController = {
  startCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
};

type FloatingVoiceOrbProps = {
  authToken: string;
  businessName: string;
  receptionistName: string;
  inPlayground: boolean;
  onOpenPlayground: () => void;
  controllerRef?: React.MutableRefObject<OrbController | null>;
  onSnapshotChange?: (snapshot: LiveCallSnapshot) => void;
  onCallEnded?: () => void;
};

export function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function nowStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

const WAVE_BARS = [24, 48, 36, 72, 92, 60, 100, 76, 52, 86, 64, 42, 78, 54, 32, 20];

export function VoiceOrbSphere({
  size = 'lg',
  stateClass,
}: {
  size?: 'lg' | 'md' | 'sm';
  stateClass: string;
}) {
  return (
    <div className={`orb-3d-stage orb-size-${size} ${stateClass}`}>
      <span className="orb-aura" />
      <span className="orb-floor-ring floor-1" />
      <span className="orb-floor-ring floor-2" />
      <div className="orb-3d-sphere">
        <svg className="orb-wireframe-svg" viewBox="0 0 200 200" aria-hidden="true">
          <ellipse cx="100" cy="100" rx="88" ry="34" transform="rotate(-24 100 100)" />
          <ellipse cx="100" cy="100" rx="88" ry="48" transform="rotate(18 100 100)" />
          <ellipse cx="100" cy="100" rx="86" ry="22" transform="rotate(52 100 100)" />
          <ellipse cx="100" cy="100" rx="84" ry="62" transform="rotate(-58 100 100)" />
          <ellipse cx="100" cy="100" rx="90" ry="74" transform="rotate(10 100 100)" />
          <circle cx="100" cy="100" r="88" />
        </svg>
        <span className="orb-core-highlight" />
      </div>
    </div>
  );
}

export function AudioWaveform({
  active,
  mode,
}: {
  active: boolean;
  mode: 'agent' | 'user' | 'idle';
}) {
  return (
    <div className={`audio-wave-bars ${active ? 'wave-active' : ''} wave-mode-${mode}`}>
      {WAVE_BARS.map((height, idx) => (
        <span
          key={idx}
          className="audio-wave-bar"
          style={{
            height: `${active ? height : Math.max(14, Math.round(height * 0.25))}%`,
            animationDelay: `${(idx % 6) * 0.11}s`,
          }}
        />
      ))}
    </div>
  );
}

export function FloatingVoiceOrb({
  authToken,
  businessName,
  receptionistName,
  inPlayground,
  onOpenPlayground,
  controllerRef,
  onSnapshotChange,
  onCallEnded,
}: FloatingVoiceOrbProps) {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [muted, setMuted] = useState(false);
  const [agentJoined, setAgentJoined] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionLogs, setSessionLogs] = useState<string[]>([
    '[--:--:--] Waiting for call...',
  ]);

  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

  function pushLog(msg: string) {
    setSessionLogs((prev) => {
      const cleaned = prev.filter((line) => !line.includes('Waiting for call...'));
      return [...cleaned.slice(-14), `[${nowStamp()}] ${msg}`];
    });
  }

  useEffect(() => {
    onSnapshotChange?.({
      status,
      muted,
      agentJoined,
      agentSpeaking,
      userSpeaking,
      elapsedSec,
      error,
      sessionLogs,
    });
  }, [
    status,
    muted,
    agentJoined,
    agentSpeaking,
    userSpeaking,
    elapsedSec,
    error,
    sessionLogs,
    onSnapshotChange,
  ]);

  useEffect(() => {
    if (status !== 'connected') {
      setElapsedSec(0);
      return;
    }
    const timer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    return () => {
      if (roomRef.current) {
        void roomRef.current.disconnect();
        roomRef.current = null;
      }
    };
  }, []);

  async function startCall() {
    if (status !== 'idle') return;
    setStatus('connecting');
    setError(null);
    setAgentJoined(false);
    setAgentSpeaking(false);
    setUserSpeaking(false);
    pushLog(`Requesting LiveKit voice session for ${businessName}...`);

    try {
      const session = await api.createLiveKitToken(authToken, 'Dashboard Caller');
      pushLog(`Room allocated: ${session.roomName}`);

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && audioContainerRef.current) {
          const element = track.attach();
          element.autoplay = true;
          audioContainerRef.current.appendChild(element);
          setAgentJoined(true);
          pushLog(`${receptionistName} audio stream connected.`);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove());
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const localId = room.localParticipant.identity;
        const isLocal = speakers.some((s) => s.identity === localId);
        const isRemote = speakers.some((s) => s.identity !== localId);
        setUserSpeaking(isLocal);
        setAgentSpeaking(isRemote);
      });

      room.on(RoomEvent.Disconnected, () => {
        setStatus('idle');
        setMuted(false);
        setAgentJoined(false);
        setAgentSpeaking(false);
        setUserSpeaking(false);
        pushLog('Call ended. Syncing dashboard...');
        if (audioContainerRef.current) {
          audioContainerRef.current.innerHTML = '';
        }
        onCallEnded?.();
      });

      await room.connect(session.livekitUrl, session.token);
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });

      roomRef.current = room;
      setStatus('connected');
      pushLog('Microphone active. Live WebRTC session established.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start voice call';
      setStatus('idle');
      setError(message);
      pushLog(`Error: ${message}`);
    }
  }

  async function endCall() {
    if (roomRef.current) {
      await roomRef.current.disconnect();
      roomRef.current = null;
    }
    setStatus('idle');
    setMuted(false);
    setAgentJoined(false);
    setAgentSpeaking(false);
    setUserSpeaking(false);
    onCallEnded?.();
  }

  async function toggleMute() {
    if (!roomRef.current) return;
    const nextMuted = !muted;
    await roomRef.current.localParticipant.setMicrophoneEnabled(!nextMuted);
    setMuted(nextMuted);
    pushLog(nextMuted ? 'Microphone muted.' : 'Microphone unmuted.');
  }

  useEffect(() => {
    if (controllerRef) {
      controllerRef.current = {
        startCall: () => void startCall(),
        endCall: () => void endCall(),
        toggleMute: () => void toggleMute(),
      };
    }
  });

  const orbStateClass =
    status === 'connecting'
      ? 'orb-connecting'
      : agentSpeaking
        ? 'orb-speaking'
        : userSpeaking && !muted
          ? 'orb-listening'
          : status === 'connected'
            ? 'orb-connected'
            : 'orb-idle';

  const statusText =
    status === 'connecting'
      ? `Connecting to ${receptionistName}...`
      : muted
        ? 'Microphone Muted'
        : agentSpeaking
          ? `${receptionistName} is speaking`
          : userSpeaking
            ? 'Listening to you...'
            : agentJoined
              ? `${receptionistName} is ready`
              : `Waiting for ${receptionistName}...`;

  return (
    <>
      <div ref={audioContainerRef} style={{ display: 'none' }} />

      {/* Show floating bottom-right orb only when NOT already on Voice Playground */}
      {!inPlayground && status === 'idle' && (
        <div className="floating-orb-launcher">
          {error && <div className="floating-orb-error">{error}</div>}
          <button
            className="floating-orb-fab"
            onClick={() => {
              onOpenPlayground();
              void startCall();
            }}
            title={`Start Call with ${receptionistName}`}
            aria-label={`Start Call with ${receptionistName}`}
          >
            <span className="orb-ring orb-ring-1" />
            <span className="orb-ring orb-ring-2" />
            <span className="orb-core">
              <PhoneCall size={22} />
            </span>
          </button>
          <span className="floating-orb-label">Start Call</span>
        </div>
      )}

      {/* Active Call Floating Mini-Orb Pill while browsing other dashboard tabs */}
      {!inPlayground && status !== 'idle' && (
        <div className={`floating-orb-dock ${orbStateClass}`}>
          <button
            className="floating-orb-expand-hit"
            onClick={onOpenPlayground}
            title="Open Voice Playground"
          >
            <VoiceOrbSphere size="sm" stateClass={orbStateClass} />
            <div className="floating-orb-meta">
              <div className="floating-orb-title">
                <strong>{receptionistName}</strong>
                <span className="floating-orb-timer">{formatTimer(elapsedSec)}</span>
              </div>
              <div className="floating-orb-status">{statusText}</div>
            </div>
          </button>

          <div className="floating-orb-actions">
            <button
              className={`orb-action-btn ${muted ? 'muted-active' : ''}`}
              onClick={() => void toggleMute()}
              disabled={status !== 'connected'}
              title={muted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {muted ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
            <button
              className="orb-action-btn"
              onClick={onOpenPlayground}
              title="Open Voice Playground"
            >
              <Maximize2 size={15} />
            </button>
            <button
              className="orb-action-btn orb-end-btn"
              onClick={() => void endCall()}
              title="End call"
            >
              <PhoneOff size={15} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
