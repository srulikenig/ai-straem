import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY !== 'false' && process.stdout.isTTY;

export const logger = pino(
  pretty
    ? { level, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } } }
    : { level },
);

export type Logger = pino.Logger;
