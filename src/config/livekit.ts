import type { ParsedEnv } from './env.ts';

export type LiveKitConfig = {
  url: string | undefined;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  agentName: string;
  isConfigured: boolean;
};

export function buildLiveKitConfig(env: ParsedEnv): LiveKitConfig {
  return {
    url: env.LIVEKIT_URL,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    agentName: env.LIVEKIT_AGENT_NAME,
    isConfigured: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
  };
}
