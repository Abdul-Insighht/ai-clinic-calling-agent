import { randomUUID } from 'node:crypto';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import type { BusinessContext } from '../models/business.ts';

export type GenerateRoomTokenInput = {
  context: BusinessContext;
  participantIdentity: string;
  participantName: string;
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  agentName?: string;
};

export type GenerateRoomTokenResult = {
  token: string;
  roomName: string;
  livekitUrl: string;
  roomMetadata: string;
};

export async function generateBusinessRoomToken(
  input: GenerateRoomTokenInput,
): Promise<GenerateRoomTokenResult> {
  const roomName = `receptionist-${randomUUID().slice(0, 8)}`;
  const roomMetadata = JSON.stringify({
    businessId: input.context.businessId,
  });

  const accessToken = new AccessToken(input.apiKey, input.apiSecret, {
    identity: input.participantIdentity,
    name: input.participantName,
    metadata: roomMetadata,
    ttl: '15m',
  });

  accessToken.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  if (input.agentName) {
    accessToken.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: input.agentName,
          metadata: roomMetadata,
        }),
      ],
    });
  }

  const token = await accessToken.toJwt();

  return {
    token,
    roomName,
    livekitUrl: input.livekitUrl,
    roomMetadata,
  };
}
