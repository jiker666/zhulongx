/**
 * One-shot endurance guards for long server sessions (10-hour final: a single
 * stray async throw must never take the process down — the operator gets no
 * second launch). Installs crash-proof logging handlers plus a periodic
 * resource heartbeat for post-mortem from platform logs.
 */

export type GuardsLogger = (line: string) => void;

export interface ProcessGuardsOptions {
  logger?: GuardsLogger;
  /** Heartbeat period; 0 disables the heartbeat. */
  heartbeatMs?: number;
  /** Extra stats folded into each heartbeat line (e.g. run counters). */
  stats?: () => Record<string, string | number>;
}

export function installProcessGuards(options: ProcessGuardsOptions = {}): void {
  const log = options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));
  const heartbeatMs = options.heartbeatMs ?? 600_000;
  const report = () => {
    const parts = [
      `uptime=${Math.round(process.uptime())}s`,
      `rss=${Math.round(process.memoryUsage().rss / 1_048_576)}MB`,
      `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1_048_576)}MB`,
    ];
    for (const [key, value] of Object.entries(options.stats?.() ?? {})) parts.push(`${key}=${value}`);
    return parts.join(" ");
  };
  process.on("uncaughtException", (error) => {
    log(`[guard] uncaughtException survived: ${error.stack ?? error} @ ${report()}`);
  });
  process.on("unhandledRejection", (reason) => {
    log(`[guard] unhandledRejection survived: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)} @ ${report()}`);
  });
  if (heartbeatMs > 0) {
    const timer = setInterval(() => log(`[guard] heartbeat ${report()}`), heartbeatMs);
    timer.unref?.();
  }
}
