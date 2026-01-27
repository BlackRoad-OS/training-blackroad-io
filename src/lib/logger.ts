/**
 * ⬛⬜🛣️ BlackRoad OS - Logging Utility
 */

import type { LogLevel, LogEntry, Env } from '../types';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: LogLevel;
  private context: Record<string, unknown>;

  constructor(level: LogLevel = 'info', context: Record<string, unknown> = {}) {
    this.level = level;
    this.context = context;
  }

  static fromEnv(env: Env): Logger {
    const level = (env.LOG_LEVEL as LogLevel) || 'info';
    return new Logger(level, { environment: env.ENVIRONMENT });
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.context, ...context });
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatEntry(level: LogLevel, message: string, extra?: Record<string, unknown>): LogEntry {
    return {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: { ...this.context, ...extra },
    };
  }

  private output(entry: LogEntry): void {
    const formatted = JSON.stringify({
      ...entry,
      msg: entry.message,
    });

    switch (entry.level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      this.output(this.formatEntry('debug', message, extra));
    }
  }

  info(message: string, extra?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      this.output(this.formatEntry('info', message, extra));
    }
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      this.output(this.formatEntry('warn', message, extra));
    }
  }

  error(message: string, error?: Error | unknown, extra?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      const entry = this.formatEntry('error', message, extra);
      if (error instanceof Error) {
        entry.error = error;
        entry.context = {
          ...entry.context,
          errorName: error.name,
          errorMessage: error.message,
          stack: error.stack,
        };
      } else if (error) {
        entry.context = { ...entry.context, error };
      }
      this.output(entry);
    }
  }
}

export const createLogger = (env: Env): Logger => Logger.fromEnv(env);
