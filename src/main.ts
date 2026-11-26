import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
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

    const sttModel = 'deepgram/nova-3:en' as const;
    const llmModel = 'openai/gpt-4.1-mini' as const;
    const ttsModel = 'cartesia/sonic-3' as const;
    const ttsVoice = '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc';

    logger.info('agent.session.starting', {
      businessId: sessionContext.businessId,
      callId: sessionContext.callId ?? 'pending',
      roomName: ctx.room.name,
      pipeline: 'livekit_inference',
      stt: sttModel,
      llm: llmModel,
      tts: ttsModel,
      voice: ttsVoice,
      environment: runtimeConfig.nodeEnv,
    });

    const session = new voice.AgentSession({
      stt: sttModel,
      llm: llmModel,
      tts: new inference.TTS({
        model: ttsModel,
        voice: ttsVoice,
        language: 'en',
      }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
      },
    });

    let lastUserSpeechEndAt: number | null = null;
    let lastAgentThinkingAt: number | null = null;

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.oldState === 'speaking' && ev.newState === 'listening') {
        sessionContext.userTurnCount = (sessionContext.userTurnCount ?? 0) + 1;
        lastUserSpeechEndAt = performance.now();
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      const now = performance.now();
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

    ctx.addShutdownCallback(async () => {
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
        // Generous audio ring buffer for smooth, skip-free streaming TTS playback
        queueSizeMs: 1000,
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

    session.say(
      `Thank you for calling ${business.name}! This is ${business.receptionistName}, how can I help you today?`,
      { allowInterruptions: true },
    );
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
