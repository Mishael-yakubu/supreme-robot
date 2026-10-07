# supreme-robot

Telegram-controlled pump.fun launcher bot. You start each launch from Telegram; the bot
sells 100% automatically when your profit target is hit. Live execution, signs locally.

## Setup
1. `npm install`
2. Run `supabase.sql` once in the Supabase SQL editor.
3. Set these environment variables (Railway: service > Variables). Never commit them.

| Variable | What |
|---|---|
| `PRIVATE_KEY` | base58 secret key of a dedicated wallet |
| `RPC_URL` | Helius/QuickNode URL |
| `TG_BOT_TOKEN` | from @BotFather |
| `TG_CHAT_ID` | your Telegram id (only this chat can control the bot) |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | server-side secret key |
| `SNIPE_OTHERS` | optional; `true` turns on sniping other launches (off by default) |

4. `npm start` (Railway: start command `npm start`). `npm test` runs the offline self-test.

## Telegram commands
`/launch [Name SYMBOL] [image-url]` (attach a photo to use it) | `/image <url>` | `/image off` |
`/addimages` + public image links on following lines | `/images` | `/clearimages` |
`/names` + list on following lines (`1. Cool Coin COOL`) | `/list` | `/next [n]` |
`/clearnames` | `/status` | `/balance` (SOL plus dollar value) | `/sellall`

## Images
A launch uses the first of: an image attached to `/launch` or given as a link, the default
set with `/image`, a random link from the pool (built-in list in `CFG.imageUrls` plus links
added with `/addimages`), then the file at `CFG.imagePath`. Use images you have the right to use.

## Launching a list of names
`/names` loads the list (saved in Supabase). Each coin is still started by you with `/next`
(or `/launch`). The bot never advances through the list by itself. Launches are capped at
`maxLaunchesPerRun` (3) with a `launchCooldownSec` (60s) gap, and each coin sells on its own rules.

## Settings
Edit the `CFG` block at the top of `bot.js`: dev buy size, profit target, stop loss, hold limit,
slippage and priority fees, launch cap and cooldown. Sell slippage and fee in `CFG` are the first
attempt; every retry raises both (slippage +10% up to 50%, fee x attempt number).
