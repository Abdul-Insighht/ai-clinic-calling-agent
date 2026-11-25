import { ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
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

    const model = business.aiModel || runtimeConfig.gemini.model;
    const voiceName = business.aiVoice || runtimeConfig.gemini.voice;

    logger.info('agent.session.starting', {
      businessId: sessionContext.businessId,
      callId: sessionContext.callId ?? 'pending',
      roomName: ctx.room.name,
      model,
      voice: voiceName,
      environment: runtimeConfig.nodeEnv,
    });

    const session = new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model,
        voice: voiceName,
        temperature: runtimeConfig.gemini.temperature,
        thinkingConfig: {
          includeThoughts: runtimeConfig.gemini.includeThoughts,
          thinkingBudget: 0,
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            silenceDurationMs: 400,
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

    let lastUserSpeechEndAt: number | null = null;
    let lastAgentThinkingAt: number | null = null;
    let noResponseTimer: ReturnType<typeof setTimeout> | null = null;
    let waitFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionActive = true;
    let consecutiveRecoveries = 0;
    let isRecoverySpeech = false;
    let isAgentSpeaking = false;
    let spokeSinceSpeechCreated = false;
    let toolRanSinceSpeechCreated = false;

    const clearWaitFollowUpTimer = () => {
      if (waitFollowUpTimer) {
        clearTimeout(waitFollowUpTimer);
        waitFollowUpTimer = null;
      }
    };

    const clearNoResponseTimer = () => {
      clearWaitFollowUpTimer();
      if (noResponseTimer) {
        clearTimeout(noResponseTimer);
        noResponseTimer = null;
      }
    };

    // Gentle non-interrupting follow-up message when a response/tool takes >3.5s
    // (Never calls session.interrupt so in-flight tool calls finish cleanly!)
    const scheduleWaitFollowUp = (delayMs: number) => {
      clearWaitFollowUpTimer();
      waitFollowUpTimer = setTimeout(() => {
        waitFollowUpTimer = null;
        if (!sessionActive || isAgentSpeaking) return;
        logger.info('voice.turn.wait_followup', {
          callId: sessionContext.callId ?? 'pending',
          thresholdMs: delayMs,
        });
        try {
          session.generateReply({
            instructions:
              'Speak one very brief, warm reassurance (4-7 words) while you finish checking, like "One moment, checking that for you now." or "Just a second, almost got that ready."',
          });
        } catch {
          // Ignore if session is busy
        }
      }, delayMs);
    };

    const scheduleNoResponseRecovery = (delayMs: number, reason: string) => {
      if (noResponseTimer) {
        clearTimeout(noResponseTimer);
        noResponseTimer = null;
      }
      noResponseTimer = setTimeout(() => {
        noResponseTimer = null;
        clearWaitFollowUpTimer();
        // NEVER interrupt Sarah if she is actively speaking (prevents mid-confirmation cutoffs)
        if (!sessionActive || isAgentSpeaking) return;
        if (consecutiveRecoveries >= 2) {
          logger.warn('voice.turn.no_response_recovery_capped', {
            callId: sessionContext.callId ?? 'pending',
            reason,
          });
          return;
        }
        consecutiveRecoveries += 1;
        logger.info('voice.turn.no_response_recovery', {
          callId: sessionContext.callId ?? 'pending',
          thresholdMs: delayMs,
          recoveryReason: reason,
          attempt: consecutiveRecoveries,
        });
        try {
          // Force-interrupt any stuck SpeechHandle (e.g. after bookAppointment tool response)
          // so generateReply executes immediately instead of queueing behind a dead handle
          session.interrupt({ force: true });
        } catch {
          // Ignore if nothing to interrupt
        }
        setTimeout(() => {
          if (!sessionActive || isAgentSpeaking) return;
          isRecoverySpeech = true;
          try {
            session.generateReply({
              instructions:
                reason === 'silent_after_tool' || reason === 'silent_after_thinking'
                  ? 'The last action just completed. Immediately confirm the result warmly to the caller in 1-2 clear, steady sentences (mentioning their confirmed appointment, email, and WhatsApp confirmation if booked) and ask if they need anything else.'
                  : 'Politely tell the caller in one short sentence: "Sorry, I didn\'t quite catch that. Could you please repeat?"',
            });
          } catch {
            isRecoverySpeech = false;
          }
        }, 150);
      }, delayMs);
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        consecutiveRecoveries = 0;
        clearNoResponseTimer();
      } else if (ev.oldState === 'speaking' && ev.newState === 'listening') {
        lastUserSpeechEndAt = performance.now();
        consecutiveRecoveries = 0;
        // Stage 1 (3s): Gentle non-interrupting follow-up if Sarah hasn't started speaking yet
        // (Cancelled ONLY on AgentStateChanged('speaking'), NOT SpeechCreated, so tool waits get follow-ups!)
        scheduleWaitFollowUp(3000);
        // Stage 2 (9.5s): Full recovery if completely stalled
        scheduleNoResponseRecovery(9500, 'no_speech_after_user');
      }
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, () => {
      toolRanSinceSpeechCreated = true;
      clearWaitFollowUpTimer();
      // Tool already completed & returned — immediately nudge after 2.5s if Gemini stalls silently
      consecutiveRecoveries = 0;
      scheduleNoResponseRecovery(2500, 'silent_after_tool');
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      const wasRecovery = isRecoverySpeech;
      isRecoverySpeech = false;
      spokeSinceSpeechCreated = false;
      toolRanSinceSpeechCreated = false;

      // Exact event-driven recovery: if LiveKit force-closes a stalled speech handle
      // without any audio or tool execution, immediately recover in 300ms.
      ev.speechHandle.addDoneCallback((sh) => {
        if (!sessionActive || wasRecovery) return;
        if (!sh.interrupted && !spokeSinceSpeechCreated && !toolRanSinceSpeechCreated) {
          scheduleNoResponseRecovery(300, 'silent_speech_closed');
        }
      });

      // Backup 12s safety net: fires ONLY after LiveKit's 10s TTS idle timeout
      // (so it NEVER kills an in-flight tool call, yet guarantees we never sit in 30s silence)
      if (!wasRecovery) {
        scheduleNoResponseRecovery(12_000, 'speech_stalled_after_tts_timeout');
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      const now = performance.now();
      isAgentSpeaking = ev.newState === 'speaking';
      if (ev.newState === 'speaking') {
        spokeSinceSpeechCreated = true;
        consecutiveRecoveries = 0;
        isRecoverySpeech = false;
        clearNoResponseTimer();
      } else if (ev.oldState === 'thinking' && ev.newState === 'listening') {
        // Agent finished thinking without producing audio — recover after 3s
        scheduleNoResponseRecovery(3000, 'silent_after_thinking');
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
      clearNoResponseTimer();
    });

    ctx.addShutdownCallback(async () => {
      sessionActive = false;
      clearNoResponseTimer();
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
        // Larger audio ring buffer so bursty Gemini confirmation speech never drops frames
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
