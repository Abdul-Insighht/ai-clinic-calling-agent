import { getDbPool } from '../db/client.ts';
import { getAppConfig } from '../config/index.ts';

type ToolSample = {
  tool: string;
  durationMs: number;
  success: boolean;
  timestamp: number;
};

const MAX_SAMPLES = 200;
const samples: ToolSample[] = [];

export function recordToolMetric(tool: string, durationMs: number, success: boolean): void {
  samples.push({
    tool,
    durationMs: Math.max(0, Math.round(durationMs)),
    success,
    timestamp: Date.now(),
  });
  if (samples.length > MAX_SAMPLES) {
    samples.shift();
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export type PerformanceMetricsSnapshot = {
  sampleCount: number;
  avgToolDurationMs: number | null;
  p50ToolDurationMs: number | null;
  p95ToolDurationMs: number | null;
  toolSuccessRate: number | null;
  dbPool: {
    total: number;
    idle: number;
    waiting: number;
  } | null;
};

export function getPerformanceMetrics(): PerformanceMetricsSnapshot {
  const durations = samples.map((s) => s.durationMs);
  const successCount = samples.filter((s) => s.success).length;
  const avg =
    durations.length > 0
      ? Math.round(durations.reduce((acc, v) => acc + v, 0) / durations.length)
      : null;

  let dbPool: PerformanceMetricsSnapshot['dbPool'] = null;
  if (getAppConfig().database.isPostgresConfigured) {
    const pool = getDbPool();
    dbPool = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  }

  return {
    sampleCount: samples.length,
    avgToolDurationMs: avg,
    p50ToolDurationMs: percentile(durations, 50),
    p95ToolDurationMs: percentile(durations, 95),
    toolSuccessRate:
      samples.length > 0 ? Math.round((successCount / samples.length) * 1000) / 10 : null,
    dbPool,
  };
}
