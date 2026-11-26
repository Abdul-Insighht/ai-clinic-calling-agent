import { ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
// Option A (Commented Backup) — LiveKit Cloud Inference:
// import { inference } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';
import { createReceptionistAgent } from './agent/receptionist.ts';
import { getAppConfig } from './config/index.ts';
import { NORTHSTAR_BUSINESS_ID } from './db/seed.ts';
import { logger } from './lib/logger.ts';
import type { BusinessContext } from './models/business.ts';
import { InMemoryCallRepository, PostgresCallRepository } from './repositories/lead-repository.ts';
import { createDefaultBusinessService } from './services/business-service.ts';
import { warmUpCalendarClient } from './services/google-calendar-adapter.ts';

const config = getAppConfig();
const sharedBusinessService = createDefaultBusinessService();
const sharedCallRepository = config.database.isPostgresConfigured
  ? new PostgresCallRepository()
  : new InMemoryCallRepository();

export default defineAgent({
  entry: async (ctx) => {
    const runtimeConfig = getAppConfig();
    const baseContext: BusinessContext = {
      businessId: NORTHSTAR_BUSINESS_ID,
    };

    const businessService = sharedBusinessService;
    const callRepository = sharedCallRepository;

    // Non-blocking calendar auth warm-up
    void warmUpCalendarClient();

    const startupStart = performance.now();
    let profileLoadMs = 0;

    // Non-blocking call record creation so greeting never waits for DB write
    const sessionContext: BusinessContext = {
      ...baseContext,
      userTurnCount: 0,
    };

    const callRecordPromise = callRepository
      .startCall(baseContext, {
        livekitRoomName: ctx.room.name ?? 'unknown-room',
      })
      .then((record) => {
        sessionContext.callId = record.id;
        return record;
      })
      .catch((err) => {
        logger.error('agent.call_record.start_failed', { error: err });
        return null;
      });

    const business = await businessService.getBusinessProfile(baseContext);
    profileLoadMs = Math.round(performance.now() - startupStart);

    logger.info('agent.startup.spans', {
      businessId: baseContext.businessId,
      profileLoadMs,
      totalStartupMs: Math.round(performance.now() - startupStart),
    });

    // Option B (Active) — Gemini 3.1 Flash Live Preview (Next-Gen Native Audio)
    // Fallback model ID if ever needed: 'gemini-2.5-flash-native-audio-preview-12-2025'
    const model = 'gemini-3.1-flash-live-preview';
    const voiceName = business.aiVoice || runtimeConfig.gemini.voice;

    logger.info('agent.session.starting', {
      businessId: sessionContext.businessId,
      callId: sessionContext.callId ?? 'pending',
      roomName: ctx.room.name,
      pipeline: 'gemini_live_3_1',
      model,
      voice: voiceName,
      environment: runtimeConfig.nodeEnv,
    });

    const session = new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model,
        voice: voiceName,
        temperature: runtimeConfig.gemini.temperature,
        realtimeInputConfig: {
          automaticActivityDetection: {
            silenceDurationMs: 450,
            prefixPaddingMs: 120,
          },
        },
      }),
      turnHandling: {
        turnDetection: 'realtime_llm',
        endpointing: {
          mode: 'fixed',
          minDelay: 200,
          maxDelay: 700,
        },
      },
    });

    /*
    // Option A (Commented Backup) — LiveKit Cloud Inference Studio Pipeline
    const session = new voice.AgentSession({
      stt: 'deepgram/nova-3:en',
      llm: 'openai/gpt-4.1-mini',
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
        language: 'en',
      }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
      },
    });
    */

    let lastUserSpeechEndAt: number | null = null;
    let lastAgentThinkingAt: number | null = null;
    let sessionActive = true;
    let isAgentSpeaking = false;
    let postToolTimer: ReturnType<typeof setTimeout> | null = null;

    const clearPostToolTimer = () => {
      if (postToolTimer) {
        clearTimeout(postToolTimer);
        postToolTimer = null;
      }
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        clearPostToolTimer();
      } else if (ev.oldState === 'speaking' && ev.newState === 'listening') {
        sessionContext.userTurnCount = (sessionContext.userTurnCount ?? 0) + 1;
        lastUserSpeechEndAt = performance.now();
      }
    });

    // Gentle, non-interrupting post-tool safety net ONLY (never kills an active turn or tool!)
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, () => {
      clearPostToolTimer();
      postToolTimer = setTimeout(() => {
        postToolTimer = null;
        if (!sessionActive || isAgentSpeaking) return;
        logger.info('voice.turn.post_tool_nudge', {
          callId: sessionContext.callId ?? 'pending',
        });
        try {
          session.generateReply({
            instructions:
              'The tool just returned its result. Immediately speak the clear answer or confirmation warmly in 1-2 short sentences and ask if they need anything else.',
          });
        } catch {
          // Ignore if session already started speaking
        }
      }, 2500);
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      const now = performance.now();
      isAgentSpeaking = ev.newState === 'speaking';
      if (isAgentSpeaking) {
        clearPostToolTimer();
      }
      if (ev.newState === 'thinking') {
        lastAgentThinkingAt = now;
      } else if (ev.newState === 'speaking' && lastUserSpeechEndAt !== null) {
        logger.info('voice.turn.latency', {
          callId: sessionContext.callId,
          speechEndToThinkingMs:
            lastAgentThinkingAt && lastAgentThinkingAt >= lastUserSpeechEndAt
              ? Math.round(lastAgentThinkingAt - lastUserSpeechEndAt)
              : null,
          thinkingToFirstAudioMs:
            lastAgentThinkingAt && lastAgentThinkingAt >= lastUserSpeechEndAt
              ? Math.round(now - lastAgentThinkingAt)
              : null,
          firstAudioLatencyMs: Math.round(now - lastUserSpeechEndAt),
        });
        lastUserSpeechEndAt = null;
        lastAgentThinkingAt = null;
      }
    });

    session.on(voice.AgentSessionEventTypes.Close, () => {
      sessionActive = false;
      clearPostToolTimer();
    });

    ctx.addShutdownCallback(async () => {
      sessionActive = false;
      clearPostToolTimer();
      const record = await callRecordPromise;
      if (record) {
        await callRepository.completeCall(sessionContext, record.id, 'completed');
      }
      logger.info('agent.session.completed', {
        businessId: sessionContext.businessId,
        callId: record?.id ?? 'unknown',
      });
    });

    await session.start({
      room: ctx.room,
      record: { audio: false },
      inputOptions: {
        // LiveKit Cloud Krisp BVC: strips surrounding voices, fans, and room chatter
        noiseCancellation: BackgroundVoiceCancellation(),
      },
      outputOptions: {
        // Larger 3s audio ring buffer so bursty Gemini speech never drops or skips frames
        queueSizeMs: 3000,
      },
      agent: createReceptionistAgent({
        context: sessionContext,
        business,
        businessService,
        callRepository,
      }),
    });

    await ctx.connect();

    logger.info('agent.session.connected', {
      businessId: sessionContext.businessId,
      callId: sessionContext.callId ?? 'pending',
      roomName: ctx.room.name,
    });

    await session.generateReply({
      instructions: `
        Greet the caller warmly in English as ${business.receptionistName}, the virtual receptionist for ${business.name}.
        Say: "Thank you for calling ${business.name}! This is ${business.receptionistName}, how can I help you today?"
      `,
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: config.livekit.agentName,
    numIdleProcesses: 1,
    initializeProcessTimeout: 30_000,
  }),
);
