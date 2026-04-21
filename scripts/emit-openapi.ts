import { loadConfig } from '../src/config/index.js';
import { buildApp } from '../src/app.js';

async function main(): Promise<void> {
  process.env.LOG_LEVEL = 'silent';
  const config = loadConfig({
    ...process.env,
    API_KEYS: process.env.API_KEYS ?? 'doc-emit',
    LOG_LEVEL: 'silent',
  });
  const app = await buildApp(config);
  await app.server.ready();
  const spec = app.server.swagger();
  process.stdout.write(JSON.stringify(spec, null, 2));
  await app.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
