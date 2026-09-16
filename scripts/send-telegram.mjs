#!/usr/bin/env node
/**
 * Send a Telegram message using TELEGRAM_BOT_TOKEN (env) and chat id file.
 * Never writes the token to disk.
 *
 * Usage:
 *   node scripts/send-telegram.mjs "message text"
 *   echo "message" | node scripts/send-telegram.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHAT_ID_FILE = resolve(ROOT, ".telegram-chat-id");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) die("TELEGRAM_BOT_TOKEN is not set in the environment");

let chatId;
try {
  chatId = readFileSync(CHAT_ID_FILE, "utf8").trim();
} catch {
  die(`Missing chat id file: ${CHAT_ID_FILE}`);
}
if (!/^-?\d+$/.test(chatId)) die("Chat id file must contain only a numeric chat id");

let text = process.argv.slice(2).join(" ").trim();
if (!text && !process.stdin.isTTY) {
  text = readFileSync(0, "utf8").trim();
}
if (!text) die("Usage: node scripts/send-telegram.mjs \"message\"");

const url = `https://api.telegram.org/bot${token}/sendMessage`;
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  }),
});
const data = await res.json();
if (!data.ok) {
  die(`sendMessage failed: ${data.error_code || res.status} ${data.description || ""}`.trim());
}
console.log("sent=ok chat_id=" + chatId);
