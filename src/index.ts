import { Store } from './db/store.js';
import { Bot, createClient } from './discord/bot.js';
import { startDashboard } from './dashboard/server.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const store = new Store(env.DATABASE_PATH);
const client = createClient(env.BOT_STATUS);
const bot = new Bot(client, store, env.DEV_GUILD_ID);
bot.attach();

const dashboard = startDashboard(bot, env);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[bot] ${signal} received, shutting down`);
  bot.service.automation.stop();
  dashboard?.close();
  await client.destroy();
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => console.error('[bot] unhandled rejection:', error));

await client.login(env.DISCORD_TOKEN);
