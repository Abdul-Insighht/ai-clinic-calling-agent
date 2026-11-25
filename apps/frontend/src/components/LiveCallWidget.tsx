import { Room, RoomEvent, Track } from 'livekit-client';
import { Mic, MicOff, PhoneCall, PhoneOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

type Props = {
  authToken: string;
  businessName: string;
  receptionistName: string;
};

export function LiveCallWidget({ authToken, businessName, receptionistName }: Props) {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected'>('idle');
  const [roomName, setRoomName] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [agentJoined, setAgentJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (roomRef.current) {
        void roomRef.current.disconnect();
        roomRef.current = null;
      }
    };
  }, []);

  async function startCall() {
    setStatus('connecting');
    setError(null);
    setAgentJoined(false);

    try {
      const session = await api.createLiveKitToken(authToken, 'Dashboard Caller');
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
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove());
      });

      room.on(RoomEvent.Disconnected, () => {
        setStatus('idle');
        setRoomName(null);
        setMuted(false);
        setAgentJoined(false);
        if (audioContainerRef.current) {
          audioContainerRef.current.innerHTML = '';
        }
      });

      await room.connect(session.livekitUrl, session.token);
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });

      roomRef.current = room;
      setRoomName(session.roomName);
      setStatus('connected');
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Unable to start browser voice call');
    }
  }

  async function endCall() {
    if (roomRef.current) {
      await roomRef.current.disconnect();
      roomRef.current = null;
    }
    setStatus('idle');
    setRoomName(null);
    setMuted(false);
    setAgentJoined(false);
  }

  async function toggleMute() {
    if (!roomRef.current) return;
    const nextMuted = !muted;
    await roomRef.current.localParticipant.setMicrophoneEnabled(!nextMuted);
    setMuted(nextMuted);
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Live Browser Receptionist Test</h3>
      <p className="muted">
        Connect via WebRTC to speak directly with <strong>{receptionistName}</strong> ({businessName}
        ). Room tokens are minted server-side.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div ref={audioContainerRef} style={{ display: 'none' }} />

      {status !== 'connected' ? (
        <button className="btn" onClick={startCall} disabled={status === 'connecting'}>
          <PhoneCall size={16} style={{ verticalAlign: 'middle', marginRight: 8 }} />
          {status === 'connecting' ? 'Connecting...' : 'Start Voice Call'}
        </button>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <span className="badge badge-ok">
            Connected: {roomName} {agentJoined ? '· Sarah is speaking/listening' : '· Waiting for Sarah...'}
          </span>
          <button className="btn btn-secondary" onClick={toggleMute}>
            {muted ? (
              <>
                <MicOff size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                Unmute Mic
              </>
            ) : (
              <>
                <Mic size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                Mute Mic
              </>
            )}
          </button>
          <button className="btn btn-danger" onClick={endCall}>
            <PhoneOff size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            End Call
          </button>
        </div>
      )}
    </div>
  );
}
