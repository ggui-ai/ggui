/**
 * Minimal structured logger for the OSS server.
 *
 * Hosted closed-runtime code typically uses pino for CloudWatch-shaped
 * logs; the OSS server ships with a zero-dep console emitter by default.
 * Operators who want structured log ingestion can pass their own
 * `Logger` object on `createGguiServer({ logger })`.
 */

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Optional; most call sites never touch debug. */
  debug?(event: string, fields?: Record<string, unknown>): void;
  /** Create a child logger with bound fields. */
  child(fields: Record<string, unknown>): Logger;
}

/**
 * JSON-line logger. One `console.log` per event, level-tagged. Quiet
 * unless called — no banners, no colors, no timestamps at boot.
 */
export function createConsoleLogger(bound: Record<string, unknown> = {}): Logger {
  const emit = (
    level: 'info' | 'warn' | 'error' | 'debug',
    event: string,
    fields: Record<string, unknown> | undefined,
  ): void => {
    const record: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      event,
      ...bound,
      ...fields,
    };
    const line = JSON.stringify(record);
    // The whole point of this module is to emit structured log lines
    // to stdout/stderr — console is the correct primitive here. Hosts
    // that want pino / winston / custom sinks pass their own `Logger`
    // via `createGguiServer({ logger })`.
    // eslint-disable-next-line no-console
    if (level === 'error') console.error(line);
    // eslint-disable-next-line no-console
    else console.log(line);
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    child: (fields) => createConsoleLogger({ ...bound, ...fields }),
  };
}
