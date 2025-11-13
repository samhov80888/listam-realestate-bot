import 'dotenv/config';
import { Telegraf } from 'telegraf';

if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) {
  console.error('❌ Կանխիկ՝ .env-ում BOT_TOKEN/CHAT_ID չկան');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

try {
  await bot.telegram.sendMessage(process.env.CHAT_ID, '✅ Test from listam bot');
  console.log('✅ Test message sent');
} catch (e) {
  console.error('❌ Send failed:', e.message);
}
process.exit(0);
