import { getConfig } from '@/config/index.js';
import { buildApp } from '@/app.js';

async function main(): Promise<void> {
  const config = getConfig();
  const app = await buildApp(config);

  const onSignal = async (signal: string): Promise<void> => {
    app.server.log.info({ signal }, 'received signal');
    try {
      await app.shutdown();
      process.exit(0);
    } catch (err) {
      app.server.log.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void onSignal('SIGTERM'));
  process.on('SIGINT', () => void onSignal('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.server.log.error({ reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    app.server.log.error({ err }, 'uncaughtException');
    process.exit(1);
  });

  // Eager browser warm-up so the first request doesn't pay Chromium launch.
  await app.pool.start();
  await app.server.listen({ host: config.HOST, port: config.PORT });
  app.server.log.info(`HTML→PDF service listening on http://${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  console.error('boot failed', err);
  process.exit(1);
});
