/** Print every chat this Telegram account can see, with the ID to use
 * in TARGET_CHATS. Run: npm run chats
 */
import readline from "node:readline/promises";

import { TelegramClient } from "telegram";
import { StoreSession } from "telegram/sessions/index.js";

import { config } from "./config.js";

async function main(): Promise<void> {
  const client = new TelegramClient(
    new StoreSession(config.TELEGRAM_SESSION),
    config.TELEGRAM_API_ID,
    config.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await client.start({
    phoneNumber: () => rl.question("Phone number (international format): "),
    password: () => rl.question("2FA password: "),
    phoneCode: () => rl.question("Login code you received: "),
    onError: async (err) => {
      console.error(err);
      return true;
    },
  });
  rl.close();

  console.log(`${"ID".padStart(15)}  NAME`);
  console.log("-".repeat(60));
  for (const dialog of await client.getDialogs()) {
    const kind = dialog.isChannel ? "channel" : dialog.isGroup ? "group" : "dm";
    console.log(`${String(dialog.id).padStart(15)}  [${kind}] ${dialog.title}`);
  }
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
