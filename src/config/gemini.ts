import type { ParsedEnv } from './env.ts';

export const SUPPORTED_GEMINI_VOICES = [
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr',
] as const;

export type GeminiVoice = (typeof SUPPORTED_GEMINI_VOICES)[number];

export type GeminiConfig = {
  apiKey: string | undefined;
  model: string;
  voice: GeminiVoice;
  temperature: number;
  includeThoughts: boolean;
  isConfigured: boolean;
};

export function buildGeminiConfig(env: ParsedEnv): GeminiConfig {
  return {
    apiKey: env.GOOGLE_API_KEY,
    model: env.GEMINI_LIVE_MODEL,
    voice: env.GEMINI_VOICE,
    temperature: env.GEMINI_TEMPERATURE,
    includeThoughts: false,
    isConfigured: Boolean(env.GOOGLE_API_KEY),
  };
}
