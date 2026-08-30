import { config } from './config.js';
import { logger } from './logger.js';
import { startServer } from './server.js';

const server = startServer();

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  // Do not hang forever on calls that are still up.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
process.on('uncaughtException', (err) => logger.fatal({ err }, 'uncaught exception'));

logger.info({ mode: config.mode, model: config.mode === 'bot' ? config.gemini.model : null }, 'ai-straem started');
