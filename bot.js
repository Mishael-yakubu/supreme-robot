// bot.js - pump.fun launcher bot (live execution)
//
// What it does
//   - You start each launch from Telegram (or turn on /autopilot for a list).
//     The bot creates the token with a dev buy, then sells 100% automatically
//     the moment your profit target is reached.
//   - It also manages tokens you launch yourself from this same wallet on pump.fun.
//   - Open positions and your names list are saved (Supabase, or local files if
//     Supabase is not configured) and restored after a restart.
//   - /autopilot on advances the /names queue at autoIntervalSec while previous
//     coins keep selling on their own rules (no manual /next needed).
//
// Telegram commands (only TG_CHAT_ID is accepted)
//   /launch [Name SYMBOL] [image-url]   (attach a photo to use it as the image)
//   /image <url>                        set the default image (or photo + caption /image)
//   /names                              then the list on following lines: "1. Cool Coin COOL"
//   /list  /next [n]  /clearnames
//   /addimages  (then public image links, one per line)  /images  /clearimages
//   /image off                          clear the default image
//   /autopilot on|off                   auto-advance the names list at intervals
//   /settings                           show buy sizes, sniping, auto-pilot config
//   /status  /balance  /sellall  /help
//
// Env vars
//   PRIVATE_KEY           base58 secret key of a DEDICATED wallet
//   RPC_URL               your RPC (Helius/QuickNode). The public RPC is too slow for this.
//   TG_BOT_TOKEN          from @BotFather
//   TG_CHAT_ID            your Telegram id; only this chat can control the bot
//   SUPABASE_URL          optional, e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  optional, server-side secret key (never commit it)
//   SNIPE_OTHERS          optional, set to true to turn on sniping other launches (off by default)
//   DEV_BUY_SOL           optional, SOL spent on each of your launches (default 0.06)
//   SNIPE_BUY_SOL         optional, SOL per snipe buy (default 0.033)
//   SNIPE_BUY_USD         optional, dollar size per snipe; overrides SNIPE_BUY_SOL when set
//   AUTO_PILOT            optional, set to true to start auto-pilot on boot (still needs a /names list)
//   AUTO_INTERVAL_SEC     optional, seconds between auto launches (default 90)
//   AUTO_MAX_CONCURRENT   optional, soft open-position limit while auto-pilot runs (default 5)
//
// Setup: npm install   |   Run: npm start   |   Self-test: npm test

'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const bs58 = require('bs58');
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');

const CFG = {
  wsUrl: 'wss://pumpportal.fun/api/data',
  tradeUrl: 'https://pumpportal.fun/api/trade-local',
  ipfsUrl: 'https://pump.fun/api/ipfs',
  rpc: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // ---- fees and slippage ----
  slippagePct: 25,               // launches
  priorityFeeSol: 0.0002,        // launches
  snipeBuySlippagePct: 15,       // snipe buys: tighter, less sandwich exposure
  snipeBuyPriorityFeeSol: 0.0003,
  // Sells: these are the FIRST attempt. Each retry raises both so a failing exit still lands.
  sellSlippagePct: 30,           // retry n uses base + step*(n-1), capped at max
  sellSlippageStepPct: 10,
  sellSlippageMaxPct: 55,
  sellPriorityFeeSol: 0.0003,    // retry n uses base * n
  sellRetries: 6,                // attempts per sell round
  sellConfirmTimeoutMs: 10000,   // low fees can land slowly
  buyConfirmTimeoutMs: 15000,
  createConfirmTimeoutMs: 30000,
  rebroadcastMs: 1000,           // re-send the same signed tx until it lands
  maxFailedSellRounds: 5,        // rounds of retries before giving up (dev)
  sellRoundPauseMs: 6000,
  // Snipe exits are more aggressive — pump.fun snipes move fast and need looser slippage
  snipeSellSlippagePct: 40,
  snipeSellSlippageStepPct: 10,
  snipeSellSlippageMaxPct: 65,
  snipeSellPriorityFeeSol: 0.0006,
  snipeSellRetries: 8,
  snipeSellConfirmTimeoutMs: 12000,
  snipeMaxFailedSellRounds: 12,  // keep hammering; do not give up quickly on snipes
  snipeSellRoundPauseMs: 4000,

  // ---- default token (plain /launch) ----
  token: {
    name: 'My Token',
    symbol: 'MTK',
    description: '',
    twitter: '',
    telegram: '',
    website: '',
  },
  imagePath: './token.png',
  maxImageBytes: 5 * 1024 * 1024,
  // Public image links the bot picks from at random when a launch has no image of its own.
  // An image attached to /launch or set with /image always wins. Add more with /addimages.
  // Only use images you have the right to use.
  imageUrls: ['https://picsum.photos/512'],
  devBuySol: Math.max(0.001, Number(process.env.DEV_BUY_SOL) || 0.06),

  // ---- launch control ----
  launchOnStart: false,
  maxLaunchesPerRun: 3,
  launchCooldownSec: 60,

  // ---- auto-pilot (list mode) ----
  // When on, the bot pulls the next unused name from the /names queue automatically.
  // Sells of previous tokens continue independently; only one create runs at a time.
  // Override via env: AUTO_PILOT, AUTO_INTERVAL_SEC, AUTO_MAX_CONCURRENT
  autoPilot: process.env.AUTO_PILOT === 'true',
  autoIntervalSec: Math.max(1, Number(process.env.AUTO_INTERVAL_SEC) || 90),
  autoMaxConcurrent: Math.max(1, Number(process.env.AUTO_MAX_CONCURRENT) || 5),

  // ---- sell rules for your launches ----
  devTakeProfitPct: 50,   // total fees are roughly 3% round trip, keep this well above that
  devStopLossPct: 35,     // 0 = disabled
  devMaxHoldSec: 300,     // sell after 5 min if the target is not hit (0 = disabled)

  // ---- sniping other launches (OFF) ----
  // OFF by default. To turn on, set env SNIPE_OTHERS=true and restart the bot.
  snipeOthers: process.env.SNIPE_OTHERS === 'true',
  minDevBuySol: 1,
  maxDevBuySol: 10,
  // SNIPE_BUY_USD (dollars) wins over SNIPE_BUY_SOL when set; converted at buy time via live SOL price
  buySol: Math.max(0.001, Number(process.env.SNIPE_BUY_SOL) || 0.033),
  snipeBuyUsd: process.env.SNIPE_BUY_USD ? Math.max(0.5, Number(process.env.SNIPE_BUY_USD)) : 0,
  snipeTakeProfitPct: 50,
  snipeStopLossPct: 25,
  snipeMaxHoldSec: 180,
  maxOpenSnipes: 5,
  maxSessionLossSol: 0.3,
};

// ---------- state ----------

let kp, wallet, conn;
let TG_TOKEN, TG_CHAT;
let ws;
let wsLastMsgAt = 0;
let startBalance = 0;
let halted = false;
let launching = false;
let launches = 0;
let lastLaunchAt = 0;
let defaultImage = null;
let shuttingDown = false;
let storeWarned = false;
let queue = []; // names list: [{ name, symbol, used }]
let images = []; // image links added from Telegram
let autoPilot = false; // runtime flag; seeded from CFG.autoPilot after state load
let autoTimer = null;

const positions = new Map(); // mint -> position
const pending = new Set();   // snipe buys in flight
const saveChains = { names: Promise.resolve(), positions: Promise.resolve(), images: Promise.resolve(), runtime: Promise.resolve() };

const now = () => Date.now();
const sol = (n, d = 4) => Number(n).toFixed(d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scan = (sig) => `https://solscan.io/tx/${sig}`;

function init() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error('Set PRIVATE_KEY env var (base58). Use a dedicated wallet.');
  }
  try {
    kp = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
  } catch {
    throw new Error('PRIVATE_KEY is not a valid base58 secret key');
  }
  wallet = kp.publicKey.toBase58();
  conn = new Connection(CFG.rpc, 'confirmed');
  TG_TOKEN = process.env.TG_BOT_TOKEN;
  TG_CHAT = process.env.TG_CHAT_ID;
  for (const k of ['devTakeProfitPct', 'devBuySol', 'sellRetries']) {
    if (!Number.isFinite(CFG[k]) || CFG[k] <= 0) throw new Error(`CFG.${k} must be a positive number`);
  }
}

// ---------- persistence (Supabase, or local files as a fallback) ----------

const supa = () => ({
  url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  key: process.env.SUPABASE_SERVICE_KEY || '',
});
const usingSupabase = () => !!(supa().url && supa().key);

function supaHeaders(extra = {}) {
  const { key } = supa();
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`; // legacy JWT-style keys
  return h;
}

const stateFile = (key) => path.join(process.env.STATE_DIR || '.', `state-${key}.json`);

const store = {
  async get(key) {
    if (usingSupabase()) {
      const k = `${wallet}:${key}`;
      const res = await fetch(
        `${supa().url}/rest/v1/bot_state?key=eq.${encodeURIComponent(k)}&select=value`,
        { headers: supaHeaders() }
      );
      if (!res.ok) throw new Error(`supabase get ${res.status}: ${await res.text()}`);
      const rows = await res.json();
      return rows.length ? rows[0].value : null;
    }
    try { return JSON.parse(fs.readFileSync(stateFile(key), 'utf8')); } catch { return null; }
  },
  async set(key, value) {
    if (usingSupabase()) {
      const res = await fetch(`${supa().url}/rest/v1/bot_state?on_conflict=key`, {
        method: 'POST',
        headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ key: `${wallet}:${key}`, value, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(`supabase set ${res.status}: ${await res.text()}`);
      return;
    }
    fs.writeFileSync(stateFile(key), JSON.stringify(value, null, 2));
  },
};

// saves run one after another, and each one snapshots the latest state when its turn comes
function queueSave(key, snapshot) {
  saveChains[key] = saveChains[key]
    .then(() => store.set(key, snapshot()))
    .then(() => { storeWarned = false; })
    .catch((e) => {
      console.log(`[store] saving ${key} failed: ${e.message}`);
      if (!storeWarned) {
        storeWarned = true;
        tg(`WARNING: could not save ${key}: ${e.message}`);
      }
    });
  return saveChains[key];
}

const persistPositions = () =>
  queueSave('positions', () =>
    [...positions.values()].map((p) => ({
      mint: p.mint, symbol: p.symbol, kind: p.kind, entryMc: p.entryMc, openedAt: p.openedAt,
    }))
  );
const persistNames = () => queueSave('names', () => queue);
const persistImages = () => queueSave('images', () => images);
const persistRuntime = () =>
  queueSave('runtime', () => ({
    devBuySol: CFG.devBuySol,
    devTakeProfitPct: CFG.devTakeProfitPct,
    devStopLossPct: CFG.devStopLossPct,
    snipeOthers: CFG.snipeOthers,
    buySol: CFG.buySol,
    snipeBuyUsd: CFG.snipeBuyUsd,
  }));


async function loadState() {
  let saved = [];
  try {
    const n = await store.get('names');
    queue = Array.isArray(n) ? n : [];
  } catch (e) {
    tg(`WARNING: could not load names list: ${e.message}`);
  }
  try {
    const im = await store.get('images');
    images = Array.isArray(im) ? im : [];
  } catch (e) {
    tg(`WARNING: could not load image links: ${e.message}`);
  }
  try {
    const s = await store.get('positions');
    saved = Array.isArray(s) ? s : [];
  } catch (e) {
    tg(`WARNING: could not load open positions: ${e.message}. Check the wallet manually.`);
  }
  try {
    const rt = await store.get('runtime');
    if (rt && typeof rt === 'object') {
      if (Number.isFinite(rt.devBuySol) && rt.devBuySol > 0) CFG.devBuySol = rt.devBuySol;
      if (Number.isFinite(rt.devTakeProfitPct) && rt.devTakeProfitPct > 0) CFG.devTakeProfitPct = rt.devTakeProfitPct;
      if (Number.isFinite(rt.devStopLossPct) && rt.devStopLossPct >= 0) CFG.devStopLossPct = rt.devStopLossPct;
      if (typeof rt.snipeOthers === 'boolean') CFG.snipeOthers = rt.snipeOthers;
      if (Number.isFinite(rt.buySol) && rt.buySol > 0) CFG.buySol = rt.buySol;
      if (Number.isFinite(rt.snipeBuyUsd) && rt.snipeBuyUsd >= 0) CFG.snipeBuyUsd = rt.snipeBuyUsd;
    }
  } catch (e) {
    console.log('[store] runtime load failed:', e.message);
  }
  return saved;
}

// bring saved positions back, dropping any whose tokens are already gone from the wallet
async function restorePositions(saved) {
  let restored = 0;
  let dropped = 0;
  for (const s of saved) {
    if (!s || !s.mint) continue;
    try {
      if ((await ops.tokenBalance(s.mint)) <= 0) { dropped++; continue; }
    } catch (e) {
      console.log(`[restore] balance check failed for ${s.mint}, keeping it: ${e.message}`);
    }
    positions.set(s.mint, {
      kind: s.kind || 'dev', mint: s.mint, symbol: s.symbol || s.mint.slice(0, 4),
      entryMc: s.entryMc ?? null, lastMc: s.entryMc || 0,
      openedAt: s.openedAt || now(), closing: false, launching: false,
    });
    restored++;
  }
  if (saved.length) {
    await persistPositions();
    tg(`Restored ${restored} open position(s) after restart${dropped ? `, dropped ${dropped} already sold` : ''}`);
  }
  return { restored, dropped };
}

// ---------- names queue ----------

function validNameSymbol(name, symbol) {
  if (!name || name.length > 32) return 'Name must be 1-32 characters';
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) return 'Symbol must be 1-10 letters/numbers';
  return null;
}

function parseNameSymbol(tokens) {
  if (tokens.length < 2) return null;
  return { name: tokens.slice(0, -1).join(' '), symbol: tokens[tokens.length - 1].toUpperCase() };
}

// accepts "1. Cool Coin COOL", "2) Other OTH", or just "Name SYMBOL"
function parseNames(lines) {
  const out = [];
  for (const line of lines) {
    const t = line.trim().replace(/^\d+\s*[.)\-:]\s*/, '');
    if (!t) continue;
    const ns = parseNameSymbol(t.split(/\s+/));
    if (!ns || validNameSymbol(ns.name, ns.symbol)) continue;
    out.push({ ...ns, used: false });
  }
  return out;
}

// ---------- auto-pilot ----------

async function tryAutoNext() {
  if (!autoPilot || shuttingDown || launching) return;
  if (launches >= CFG.maxLaunchesPerRun) {
    stopAutoPilot();
    tg(`Auto-pilot stopped: launch cap reached (${CFG.maxLaunchesPerRun} per run). Restart or raise maxLaunchesPerRun.`);
    return;
  }

  const idx = queue.findIndex((q) => !q.used);
  if (idx === -1) {
    stopAutoPilot();
    tg('Auto-pilot finished: no more unused names in the list.');
    return;
  }

  // respect existing cooldown
  const wait = CFG.launchCooldownSec - (now() - lastLaunchAt) / 1000;
  if (lastLaunchAt && wait > 0) return;

  // soft concurrent-open limit
  const open = [...positions.values()].filter((p) => !p.closing && !p.launching).length;
  if (open >= (CFG.autoMaxConcurrent || 999)) return;

  const entry = queue[idx];
  try {
    const ok = await launchToken({ name: entry.name, symbol: entry.symbol });
    if (ok) {
      entry.used = true;
      await persistNames();
      tg(`Auto-pilot launched ${entry.symbol} (${idx + 1}/${queue.length}) — remaining unused: ${queue.filter((q) => !q.used).length}`);
    }
  } catch (e) {
    console.log('[auto] launch error:', e.message);
    tg(`Auto-pilot launch failed for ${entry.symbol}: ${e.message}`);
  }
}

function startAutoPilot() {
  if (autoTimer) return;
  autoPilot = true;
  const intervalMs = Math.max((CFG.autoIntervalSec || CFG.launchCooldownSec), CFG.launchCooldownSec) * 1000;
  autoTimer = setInterval(() => {
    tryAutoNext().catch((e) => console.log('[auto]', e.message));
  }, intervalMs);
  // fire once soon so the first coin starts without waiting a full interval
  setTimeout(() => tryAutoNext().catch(() => {}), 1500);
}

function stopAutoPilot() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  autoPilot = false;
}

// ---------- images ----------

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed (${res.status})`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw new Error('that URL is not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > CFG.maxImageBytes) throw new Error('image is larger than 5MB');
  return { buf, mime: type, filename: `token.${type.split('/')[1] || 'png'}` };
}

async function telegramPhoto(fileId) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
  const j = await r.json();
  if (!j.ok) throw new Error('could not get photo from Telegram');
  const res = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${j.result.file_path}`);
  if (!res.ok) throw new Error('photo download failed');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > CFG.maxImageBytes) throw new Error('image is larger than 5MB');
  return { buf, mime: 'image/jpeg', filename: 'token.jpg' };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function loadImageFile() {
  const ext = path.extname(CFG.imagePath).toLowerCase();
  if (!MIME[ext]) throw new Error('imagePath must be png, jpg, gif or webp');
  if (!fs.existsSync(CFG.imagePath)) {
    throw new Error('no image: attach a photo, give an image URL, use /image, or add the file at CFG.imagePath');
  }
  return { buf: fs.readFileSync(CFG.imagePath), mime: MIME[ext], filename: path.basename(CFG.imagePath) };
}

// ---------- random image pool ----------

const imagePool = () => [...new Set([...CFG.imageUrls, ...images])];

function parseUrls(text) {
  const out = [];
  for (const tok of String(text).split(/\s+/)) {
    if (!/^https?:\/\/\S+$/i.test(tok)) continue;
    try { new URL(tok); } catch { continue; }
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

function shuffled(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

// random-image services return a different picture per request; add a cache-buster so it really is
function withBust(u) {
  try {
    const x = new URL(u);
    if (x.hostname.endsWith('picsum.photos')) x.searchParams.set('random', String(Math.random()).slice(2));
    return x.toString();
  } catch { return u; }
}

// picks a random link from the pool; tries up to 3 different ones if a link is broken
async function pickRandomImage() {
  for (const url of shuffled(imagePool()).slice(0, 3)) {
    try { return await fetchImage(withBust(url)); }
    catch (e) { console.log(`[image] ${url} failed: ${e.message}`); }
  }
  return null;
}

// ---------- telegram ----------

// Persistent bottom reply keyboard (always visible after first message)
// style: success=green, primary=blue, danger=red (Bot API 9.4+ / clients after Feb 2026)
const MAIN_KEYBOARD = {
  keyboard: [
    [
      { text: '/status', style: 'primary' },
      { text: '/balance', style: 'primary' },
      { text: '/settings', style: 'primary' },
    ],
    [
      { text: '/next', style: 'success' },
      { text: '/list', style: 'success' },
      { text: '/sellall', style: 'danger' },
    ],
    [
      { text: '/autopilot on', style: 'success' },
      { text: '/autopilot off', style: 'danger' },
      { text: '/help', style: 'primary' },
    ],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

// Inline buttons under the message — green for actions, blue for info, red for sell/stop
const INLINE_MENU = {
  inline_keyboard: [
    [
      { text: '📊 Status', callback_data: 'cmd:/status', style: 'primary' },
      { text: '💰 Balance', callback_data: 'cmd:/balance', style: 'primary' },
      { text: '⚙️ Settings', callback_data: 'cmd:/settings', style: 'primary' },
    ],
    [
      { text: '▶️ Next', callback_data: 'cmd:/next', style: 'success' },
      { text: '📋 List', callback_data: 'cmd:/list', style: 'success' },
      { text: '💸 Sell all', callback_data: 'cmd:/sellall', style: 'danger' },
    ],
    [
      { text: '🤖 Autopilot ON', callback_data: 'cmd:/autopilot on', style: 'success' },
      { text: '⏹ Autopilot OFF', callback_data: 'cmd:/autopilot off', style: 'danger' },
    ],
  ],
};

function settingsKeyboard() {
  const sn = CFG.snipeOthers;
  return {
    inline_keyboard: [
      [
        { text: `Dev buy: ${CFG.devBuySol} SOL`, callback_data: 'cfg:noop' },
      ],
      [
        { text: '0.03', callback_data: 'cfg:devBuy:0.03', style: 'success' },
        { text: '0.05', callback_data: 'cfg:devBuy:0.05', style: 'success' },
        { text: '0.08', callback_data: 'cfg:devBuy:0.08', style: 'success' },
        { text: '0.1', callback_data: 'cfg:devBuy:0.1', style: 'success' },
      ],
      [
        { text: `TP: +${CFG.devTakeProfitPct}%`, callback_data: 'cfg:noop' },
      ],
      [
        { text: '30%', callback_data: 'cfg:tp:30', style: 'primary' },
        { text: '50%', callback_data: 'cfg:tp:50', style: 'primary' },
        { text: '80%', callback_data: 'cfg:tp:80', style: 'primary' },
        { text: '100%', callback_data: 'cfg:tp:100', style: 'primary' },
      ],
      [
        { text: `SL: ${CFG.devStopLossPct > 0 ? '-' + CFG.devStopLossPct + '%' : 'off'}`, callback_data: 'cfg:noop' },
      ],
      [
        { text: 'Off', callback_data: 'cfg:sl:0', style: 'danger' },
        { text: '20%', callback_data: 'cfg:sl:20', style: 'danger' },
        { text: '35%', callback_data: 'cfg:sl:35', style: 'danger' },
        { text: '50%', callback_data: 'cfg:sl:50', style: 'danger' },
      ],
      [
        { text: sn ? '🟢 Snipe: ON' : '🔴 Snipe: OFF', callback_data: 'cfg:snipe:toggle', style: sn ? 'success' : 'danger' },
      ],
      [
        { text: 'Snipe $3', callback_data: 'cfg:snipeUsd:3', style: 'success' },
        { text: 'Snipe $5', callback_data: 'cfg:snipeUsd:5', style: 'success' },
        { text: 'Snipe $10', callback_data: 'cfg:snipeUsd:10', style: 'success' },
      ],
      [
        { text: '📊 Status', callback_data: 'cmd:/status', style: 'primary' },
        { text: '💰 Balance', callback_data: 'cmd:/balance', style: 'primary' },
      ],
    ],
  };
}

async function settingsText() {
  const price = await ops.solPrice();
  let snipeLine;
  if (CFG.snipeBuyUsd > 0) {
    const est = price > 0 ? (CFG.snipeBuyUsd / price) : null;
    snipeLine = `snipe size: $${CFG.snipeBuyUsd} USD` + (est ? ` (~${sol(est)} SOL)` : '');
  } else {
    snipeLine = `snipe size: ${CFG.buySol} SOL` + (price > 0 ? ` (~$${(CFG.buySol * price).toFixed(2)})` : '');
  }
  return (
    `⚙️ Settings (tap to change)\n` +
    `dev buy: ${CFG.devBuySol} SOL` + (price > 0 ? ` (~$${(CFG.devBuySol * price).toFixed(2)})` : '') + `\n` +
    `TP +${CFG.devTakeProfitPct}% | SL ${CFG.devStopLossPct > 0 ? '-' + CFG.devStopLossPct + '%' : 'off'} | max hold ${CFG.devMaxHoldSec || 'off'}s\n` +
    `sniping: ${CFG.snipeOthers ? 'ON' : 'OFF'} | ${snipeLine}\n` +
    `auto-pilot: ${autoPilot ? 'ON' : 'OFF'} | interval ${CFG.autoIntervalSec}s | soft limit ${CFG.autoMaxConcurrent}\n` +
    `launch cap: ${launches}/${CFG.maxLaunchesPerRun} | cooldown ${CFG.launchCooldownSec}s\n` +
    `Changes save automatically and survive restart.`
  );
}

async function applyConfig(data) {
  // data like cfg:devBuy:0.05 | cfg:tp:50 | cfg:sl:0 | cfg:snipe:toggle | cfg:snipeUsd:5
  const parts = data.split(':');
  if (parts[0] !== 'cfg' || parts.length < 2) return null;
  const key = parts[1];
  const val = parts[2];

  if (key === 'noop') return 'ok';

  if (key === 'devBuy') {
    const n = Number(val);
    if (!(n > 0)) return null;
    CFG.devBuySol = n;
    await persistRuntime();
    return `Dev buy set to ${n} SOL`;
  }
  if (key === 'tp') {
    const n = Number(val);
    if (!(n > 0)) return null;
    CFG.devTakeProfitPct = n;
    await persistRuntime();
    return `Take profit set to +${n}%`;
  }
  if (key === 'sl') {
    const n = Number(val);
    if (!(n >= 0)) return null;
    CFG.devStopLossPct = n;
    await persistRuntime();
    return n === 0 ? 'Stop loss disabled' : `Stop loss set to -${n}%`;
  }
  if (key === 'snipe' && val === 'toggle') {
    CFG.snipeOthers = !CFG.snipeOthers;
    await persistRuntime();
    return `Sniping ${CFG.snipeOthers ? 'ON' : 'OFF'}`;
  }
  if (key === 'snipeUsd') {
    const n = Number(val);
    if (!(n > 0)) return null;
    CFG.snipeBuyUsd = n;
    await persistRuntime();
    return `Snipe size set to $${n}`;
  }
  return null;
}

async function editSettingsMessage(chatId, messageId) {
  if (!TG_TOKEN) return;
  try {
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text: await settingsText(),
      reply_markup: settingsKeyboard(),
      disable_web_page_preview: true,
    };
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.log('[tg] editSettings failed:', res.status, await res.text());
  } catch (e) {
    console.log('[tg] editSettings failed:', e.message);
  }
}

// withKeyboard: true  → bottom reply keyboard
// withInline: true    → inline buttons under this message
async function tg(text, withKeyboard = true, withInline = false) {
  console.log(String(text).replace(/\n/g, ' | '));
  if (!TG_TOKEN || !TG_CHAT) return;
  for (let i = 0; i < text.length; i += 3900) {
    const payload = {
      chat_id: TG_CHAT,
      text: text.slice(i, i + 3900),
      disable_web_page_preview: true,
    };
    if (i === 0) {
      if (withInline) payload.reply_markup = INLINE_MENU;
      else if (withKeyboard) payload.reply_markup = MAIN_KEYBOARD;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text();
        console.log('[tg] send failed:', res.status, body);
      }
    } catch (e) {
      console.log('[tg] send failed:', e.message);
    }
  }
}

async function tgAnswerCallback(id, notice = '') {
  if (!TG_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, text: notice, show_alert: false }),
    });
  } catch (e) {
    console.log('[tg] answerCallback failed:', e.message);
  }
}

async function tgPoll() {
  let offset = 0;
  // skip anything sent while the bot was down so an old /launch can never fire on startup
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=-1`);
    const j = await r.json();
    if (j.ok && j.result && j.result.length) offset = j.result[j.result.length - 1].update_id + 1;
  } catch { /* ignore */ }

  let conflictWarned = false;
  while (!shuttingDown) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${offset}`);
      const j = await r.json();
      if (!j.ok) {
        if (j.error_code === 409 && !conflictWarned) {
          conflictWarned = true;
          console.log('[tg] 409: another instance is polling this bot token (old deploy still running?)');
        }
        await sleep(3000);
        continue;
      }
      for (const u of j.result || []) {
        offset = u.update_id + 1;

        // Inline button taps
        if (u.callback_query) {
          const cq = u.callback_query;
          if (!cq.message || String(cq.message.chat.id) !== String(TG_CHAT)) continue;
          const data = (cq.data || '').trim();
          if (data.startsWith('cfg:')) {
            const notice = await applyConfig(data);
            await tgAnswerCallback(cq.id, notice || '');
            if (notice && notice !== 'ok') {
              await editSettingsMessage(cq.message.chat.id, cq.message.message_id);
            }
          } else if (data.startsWith('cmd:')) {
            await tgAnswerCallback(cq.id);
            handleCommand(data.slice(4), null).catch((e) => tg(`Command error: ${e.message}`));
          } else {
            await tgAnswerCallback(cq.id);
          }
          continue;
        }

        const m = u.message;
        if (!m || String(m.chat.id) !== String(TG_CHAT)) continue;
        if (Date.now() / 1000 - m.date > 120) continue; // ignore stale messages
        const text = (m.text || m.caption || '').trim();
        if (!text.startsWith('/')) continue;
        const photoId = m.photo && m.photo.length ? m.photo[m.photo.length - 1].file_id : null;
        handleCommand(text, photoId).catch((e) => tg(`Command error: ${e.message}`));
      }
    } catch {
      await sleep(3000);
    }
  }
}

async function handleCommand(text, photoId) {
  const lines = text.split('\n');
  const [raw, ...rest] = lines[0].split(/\s+/);
  const args = rest.filter(Boolean);
  const cmd = raw.toLowerCase().split('@')[0];

  switch (cmd) {
    case '/launch': {
      const tokens = [...args];
      let image = null;
      if (tokens.length && /^https?:\/\//i.test(tokens[tokens.length - 1])) {
        image = await fetchImage(tokens.pop());
      } else if (photoId) {
        image = await telegramPhoto(photoId);
      }
      let overrides = {};
      if (tokens.length) {
        const ns = parseNameSymbol(tokens);
        if (!ns) return tg('Usage: /launch Name SYMBOL [image-url]');
        const err = validNameSymbol(ns.name, ns.symbol);
        if (err) return tg(err);
        overrides = ns;
      }
      if (image) overrides.image = image;
      await launchToken(overrides);
      return;
    }

    case '/image': {
      if (args[0] && args[0].toLowerCase() === 'off') {
        defaultImage = null;
        return tg('Default image cleared. Launches without their own image use the random image pool.');
      }
      let image = null;
      if (args[0] && /^https?:\/\//i.test(args[0])) image = await fetchImage(args[0]);
      else if (photoId) image = await telegramPhoto(photoId);
      else return tg('Usage: /image <url>  (or send a photo with the caption /image)');
      defaultImage = image;
      return tg('Default image set. It is used for launches that do not include their own image.');
    }

    case '/addimages': {
      const urls = parseUrls(`${lines.slice(1).join('\n')} ${args.join(' ')}`);
      if (!urls.length) return tg('Send /addimages, then one public image link per line (https://...)');
      const before = images.length;
      for (const u of urls) if (!images.includes(u) && !CFG.imageUrls.includes(u)) images.push(u);
      await persistImages();
      return tg(`Added ${images.length - before} new link(s). ${imagePool().length} in the random pool.`);
    }

    case '/images': {
      const pool = imagePool();
      return tg(pool.length ? `Random image pool (${pool.length}):\n${pool.join('\n')}` : 'No image links yet. Use /addimages.');
    }

    case '/clearimages':
      images = [];
      await persistImages();
      return tg(`Your added links are cleared. ${imagePool().length} built-in link(s) remain.`);

    case '/names': {
      const items = parseNames([...lines.slice(1), ...(args.length ? [args.join(' ')] : [])]);
      if (!items.length) {
        return tg('Send /names, then one per line:\n1. Cool Coin COOL\n2. Other Coin OTH\n(the last word on each line is the symbol)');
      }
      queue = items;
      await persistNames();
      return tg(`Saved ${queue.length} names. Use /next or /autopilot on to launch. /list to view.`);
    }

    case '/list': {
      if (!queue.length) return tg('Names list is empty. Use /names to load it.');
      return tg(queue.map((q, i) => `${i + 1}. ${q.name} (${q.symbol})${q.used ? ' [done]' : ''}`).join('\n'));
    }

    case '/clearnames': {
      queue = [];
      await persistNames();
      const wasAuto = autoPilot;
      if (wasAuto) stopAutoPilot();
      return tg('Names list cleared' + (wasAuto ? ' (auto-pilot stopped)' : ''));
    }

    case '/autopilot': {
      const arg = (args[0] || '').toLowerCase();
      if (arg === 'on' || arg === 'start') {
        if (!queue.length) return tg('Load a list with /names first.');
        const remaining = queue.filter((q) => !q.used).length;
        if (!remaining) return tg('All names in the list are already used. Load a fresh list with /names.');
        startAutoPilot();
        return tg(
          `Auto-pilot ON\ninterval ${Math.max(CFG.autoIntervalSec || CFG.launchCooldownSec, CFG.launchCooldownSec)}s\n` +
            `remaining unused: ${remaining}\nmax concurrent open: ${CFG.autoMaxConcurrent}\n` +
            `session launch cap: ${CFG.maxLaunchesPerRun}`
        );
      }
      if (arg === 'off' || arg === 'stop') {
        const was = autoPilot;
        stopAutoPilot();
        return tg(was ? 'Auto-pilot OFF.' : 'Auto-pilot was already off.');
      }
      const remaining = queue.filter((q) => !q.used).length;
      return tg(
        `Auto-pilot is ${autoPilot ? 'ON' : 'OFF'}\n` +
          `remaining unused: ${remaining} | launches this run: ${launches}/${CFG.maxLaunchesPerRun}\n` +
          `Use /autopilot on  or  /autopilot off`
      );
    }

    case '/next': {
      if (!queue.length) return tg('Names list is empty. Use /names to load it.');
      let idx;
      if (args[0]) {
        idx = parseInt(args[0], 10) - 1;
        if (!(idx >= 0 && idx < queue.length)) return tg('No such number in the list');
        if (queue[idx].used) return tg('That one is already launched');
      } else {
        idx = queue.findIndex((q) => !q.used);
        if (idx === -1) return tg('All names in the list are used');
      }
      const entry = queue[idx];
      let image = null;
      if (photoId) image = await telegramPhoto(photoId);
      else if (args[1] && /^https?:\/\//i.test(args[1])) image = await fetchImage(args[1]);
      const ok = await launchToken({ name: entry.name, symbol: entry.symbol, ...(image ? { image } : {}) });
      if (ok) {
        entry.used = true;
        await persistNames();
      }
      return;
    }

    case '/settings': {
      const msg = await settingsText();
      // Direct send with settings keyboard (green/blue/red styles)
      if (TG_TOKEN && TG_CHAT) {
        try {
          await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: TG_CHAT,
              text: msg,
              reply_markup: settingsKeyboard(),
              disable_web_page_preview: true,
            }),
          });
        } catch (e) {
          console.log('[tg] settings send failed:', e.message);
        }
      } else {
        console.log(msg.replace(/\n/g, ' | '));
      }
      // also refresh bottom keyboard
      return tg('Settings panel above ↑', true, false);
    }

    case '/status': {
      const remaining = queue.filter((q) => !q.used).length;
      const header =
        `Auto-pilot: ${autoPilot ? 'ON' : 'OFF'} | launches ${launches}/${CFG.maxLaunchesPerRun} | names left ${remaining}\n`;
      if (!positions.size) return tg(header + 'No open positions', true);
      const out = [...positions.values()].map((p) => {
        const chg = p.entryMc ? ((p.lastMc / p.entryMc - 1) * 100).toFixed(1) + '%' : 'n/a';
        const tags = `${p.launching ? ' [launching]' : ''}${p.sellIntent ? ' [sell pending]' : ''}`;
        return `${p.symbol} (${p.kind}) ${chg} / target +${limits(p).tp}%${tags}`;
      });
      return tg(header + `Open positions:\n${out.join('\n')}`, true);
    }

    case '/balance': {
      const b = await ops.walletBalance();
      return tg(`Wallet ${wallet}\n${await fmtBal(b)}`, true);
    }

    case '/sellall': {
      const all = [...positions.values()].filter((p) => !p.launching && !p.closing);
      if (!all.length) return tg('Nothing to sell');
      tg(`Selling ${all.length} position(s)`);
      all.forEach((p) => { p.failRounds = 0; closePosition(p, 'MANUAL /sellall'); });
      return;
    }

    default:
      return tg(
        'Commands:\n/launch [Name SYMBOL] [image-url]\n/image <url> | /image off\n/addimages (links on next lines)\n/images\n/clearimages\n/names (list on next lines)\n/list\n/next [n]\n/clearnames\n/autopilot on|off\n/settings\n/status\n/balance\n/sellall\n\nUse the buttons below or the menu at the bottom.',
        true,
        true
      );
  }
}

// ---------- execution ----------

// send the signed tx, keep re-broadcasting it, and poll until it is confirmed
async function landTx(tx, timeoutMs) {
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const started = now();
  let lastSend = now();
  while (now() - started < timeoutMs) {
    await sleep(250);
    let st = null;
    try { st = (await conn.getSignatureStatuses([sig])).value[0]; } catch { /* keep polling */ }
    if (st) {
      if (st.err) throw new Error(`tx failed on-chain: ${JSON.stringify(st.err)} (${sig})`);
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return sig;
    }
    if (now() - lastSend >= CFG.rebroadcastMs) {
      lastSend = now();
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
  }
  throw new Error(`not confirmed within ${Math.round(timeoutMs / 1000)}s (${sig})`);
}

async function send(extra, extraSigners = [], timeoutMs = CFG.buyConfirmTimeoutMs) {
  const res = await fetch(CFG.tradeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: wallet,
      slippage: CFG.slippagePct,
      priorityFee: CFG.priorityFeeSol,
      pool: 'auto',
      ...extra,
    }),
  });
  if (res.status !== 200) throw new Error(`trade-local ${res.status}: ${await res.text()}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  tx.sign([...extraSigners, kp]);
  return landTx(tx, timeoutMs);
}

const buyTx = (mint, amountSol) =>
  send({
    action: 'buy', mint, amount: amountSol, denominatedInSol: 'true',
    slippage: CFG.snipeBuySlippagePct,
    priorityFee: CFG.snipeBuyPriorityFeeSol,
  });

// sells use a looser slippage and a higher priority fee that grows with each attempt
// kind: 'dev' | 'snipe' — snipes use more aggressive params
function sellParams(kind, attempt = 1) {
  const snipe = kind === 'snipe';
  const baseSlip = snipe ? CFG.snipeSellSlippagePct : CFG.sellSlippagePct;
  const stepSlip = snipe ? CFG.snipeSellSlippageStepPct : CFG.sellSlippageStepPct;
  const maxSlip = snipe ? CFG.snipeSellSlippageMaxPct : CFG.sellSlippageMaxPct;
  const baseFee = snipe ? CFG.snipeSellPriorityFeeSol : CFG.sellPriorityFeeSol;
  const timeout = snipe ? CFG.snipeSellConfirmTimeoutMs : CFG.sellConfirmTimeoutMs;
  return {
    slippage: Math.min(baseSlip + stepSlip * (attempt - 1), maxSlip),
    priorityFee: baseFee * attempt,
    timeoutMs: timeout,
  };
}

const sellAllTx = (mint, attempt = 1, kind = 'dev') => {
  const p = sellParams(kind, attempt);
  return send(
    {
      action: 'sell', mint, amount: '100%', denominatedInSol: 'false',
      slippage: p.slippage,
      priorityFee: p.priorityFee,
    },
    [],
    p.timeoutMs
  );
};

async function getBalance() {
  return (await conn.getBalance(kp.publicKey)) / 1e9;
}

let solPriceCache = { price: 0, at: 0 };

// SOL/USD from CoinGecko, falling back to Binance; cached for 60s, last known price if both fail
async function getSolUsd() {
  if (solPriceCache.price && now() - solPriceCache.at < 60000) return solPriceCache.price;
  const sources = [
    async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(`coingecko ${r.status}`);
      return Number((await r.json()).solana.usd);
    },
    async () => {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(`binance ${r.status}`);
      return Number((await r.json()).price);
    },
  ];
  for (const src of sources) {
    try {
      const price = await src();
      if (price > 0) { solPriceCache = { price, at: now() }; return price; }
    } catch { /* try the next source */ }
  }
  return solPriceCache.price; // 0 if we never had one
}

// "0.5200 SOL ($93.60)"; just "0.5200 SOL" if no price is available
async function fmtBal(bal) {
  if (bal === null || bal === undefined) return '?';
  const usd = await ops.solPrice();
  if (!(usd > 0)) return `${sol(bal)} SOL`;
  const dollars = (bal * usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sol(bal)} SOL ($${dollars})`;
}

// Resolve snipe size: SNIPE_BUY_USD (live SOL price) wins over SNIPE_BUY_SOL / CFG.buySol
async function getSnipeBuySol() {
  if (CFG.snipeBuyUsd > 0) {
    const price = await ops.solPrice();
    if (!(price > 0)) throw new Error('cannot convert SNIPE_BUY_USD: SOL price unavailable');
    const amount = CFG.snipeBuyUsd / price;
    if (amount < 0.001) throw new Error(`SNIPE_BUY_USD $${CFG.snipeBuyUsd} is too small at current SOL price`);
    return amount;
  }
  return CFG.buySol;
}

async function tokenBalance(mint) {
  const res = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(mint) });
  let total = 0;
  for (const a of res.value) total += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0);
  return total;
}

// indirection so the self-test can replace the network calls
const ops = {
  sell: (mint, attempt, kind) => sellAllTx(mint, attempt, kind),
  tokenBalance: (mint) => tokenBalance(mint),
  walletBalance: () => getBalance(),
  solPrice: () => getSolUsd(),
};

async function checkSessionLoss() {
  try {
    const bal = await ops.walletBalance();
    const drawdown = startBalance - bal;
    if (CFG.snipeOthers && drawdown >= CFG.maxSessionLossSol && !halted) {
      halted = true;
      tg(`HALT: session loss limit hit (${sol(drawdown)} SOL). No new snipes. Balance ${await fmtBal(bal)}`);
    }
    return bal;
  } catch (e) {
    console.log('[wallet] balance check failed:', e.message);
    return null;
  }
}

// ---------- token launch ----------

async function uploadMetadata(tok) {
  const img = tok.image || defaultImage || (await pickRandomImage()) || loadImageFile();

  const form = new FormData();
  form.append('file', new Blob([img.buf], { type: img.mime }), img.filename);
  form.append('name', tok.name);
  form.append('symbol', tok.symbol);
  form.append('description', tok.description || '');
  if (tok.twitter) form.append('twitter', tok.twitter);
  if (tok.telegram) form.append('telegram', tok.telegram);
  if (tok.website) form.append('website', tok.website);
  form.append('showName', 'true');

  const res = await fetch(CFG.ipfsUrl, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`metadata upload ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (!j.metadataUri) throw new Error('metadata upload returned no uri');
  return j.metadataUri;
}

// returns true if the token was created
async function launchToken(overrides = {}) {
  if (shuttingDown) { tg('Bot is shutting down, launch refused'); return false; }
  if (launching) { tg('A launch is already in progress'); return false; }
  if (launches >= CFG.maxLaunchesPerRun) {
    tg(`Launch cap reached (${CFG.maxLaunchesPerRun} per run). Restart the bot to reset.`);
    return false;
  }
  const wait = CFG.launchCooldownSec - (now() - lastLaunchAt) / 1000;
  if (lastLaunchAt && wait > 0) { tg(`Cooldown: wait ${Math.ceil(wait)}s`); return false; }

  launching = true;
  const tok = { ...CFG.token, ...overrides };
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey.toBase58();

  try {
    const bal = await ops.walletBalance();
    // dev buy plus about 0.02 SOL headroom for account rent and network/priority fees
    if (bal < CFG.devBuySol + 0.02) {
      throw new Error(`balance ${sol(bal)} SOL too low for dev buy ${CFG.devBuySol} + fees`);
    }
    await tg(`Launching ${tok.symbol} (${tok.name})\ndev buy ${CFG.devBuySol} SOL\nsell at +${CFG.devTakeProfitPct}% / stop ${CFG.devStopLossPct > 0 ? '-' + CFG.devStopLossPct + '%' : 'off'}`);

    const uri = await uploadMetadata(tok);

    // register and save BEFORE sending so a crash mid-launch can still be recovered
    const p = {
      kind: 'dev', mint, symbol: tok.symbol,
      entryMc: null, lastMc: 0,
      openedAt: now(), closing: false, launching: true,
    };
    positions.set(mint, p);
    persistPositions();
    sendWs({ method: 'subscribeTokenTrade', keys: [mint] });

    let sig = null;
    try {
      sig = await send(
        {
          action: 'create',
          tokenMetadata: { name: tok.name, symbol: tok.symbol, uri },
          mint,
          denominatedInSol: 'true',
          amount: CFG.devBuySol,
          pool: 'pump',
        },
        [mintKp],
        CFG.createConfirmTimeoutMs
      );
    } catch (e) {
      // slow confirmation is not a failed launch: if the tokens are in the wallet, keep tracking
      let landed = false;
      try { landed = (await ops.tokenBalance(mint)) > 0; } catch { /* ignore */ }
      if (!landed) {
        positions.delete(mint);
        persistPositions();
        sendWs({ method: 'unsubscribeTokenTrade', keys: [mint] });
        throw new Error(`${e.message}\nIf the tx may have landed, check mint ${mint}`);
      }
      tg(`Create confirmation was slow but the token exists, tracking it\n${mint}`);
    }

    launches++;
    lastLaunchAt = now();
    p.launching = false;
    p.openedAt = now();
    persistPositions();
    tg(`LAUNCHED ${tok.symbol}\nmint ${mint}\nhttps://pump.fun/coin/${mint}\n${sig ? scan(sig) : ''}`);
    return true;
  } catch (e) {
    tg(`LAUNCH FAILED\n${e.message}`);
    return false;
  } finally {
    launching = false;
  }
}

// ---------- entries ----------

function onOwnLaunch(t) {
  const mc = Number(t.marketCapSol || 0);
  if (!mc) return;
  const existing = positions.get(t.mint);

  if (existing) {
    if (existing.entryMc === null) {
      existing.entryMc = mc;
      existing.lastMc = mc;
      persistPositions();
      console.log(`[baseline] ${existing.symbol} start mc ${sol(mc, 1)} SOL`);
    }
    return;
  }

  // launched from this wallet outside the bot (pump.fun site/app), or a late-landing create
  positions.set(t.mint, {
    kind: 'dev', mint: t.mint, symbol: t.symbol,
    entryMc: mc, lastMc: mc, openedAt: now(), closing: false, launching: false,
  });
  persistPositions();
  sendWs({ method: 'subscribeTokenTrade', keys: [t.mint] });
  tg(`DEV LAUNCH detected\n${t.symbol}\nstart mc ${sol(mc, 1)} SOL\nauto-sell at +${CFG.devTakeProfitPct}%\n${t.mint}`);
}

async function onOtherLaunch(t) {
  const dev = Number(t.solAmount || 0);
  if (halted || shuttingDown) return;
  if (dev < CFG.minDevBuySol || dev > CFG.maxDevBuySol) return;
  if (!t.marketCapSol) return;
  if (positions.size + pending.size >= CFG.maxOpenSnipes) return;
  if (positions.has(t.mint) || pending.has(t.mint)) return;

  pending.add(t.mint);
  try {
    const snipeSol = await getSnipeBuySol();
    const sig = await buyTx(t.mint, snipeSol);
    // entryMc null → first post-buy trade becomes the TP/SL baseline (more accurate than create-event mc)
    positions.set(t.mint, {
      kind: 'snipe', mint: t.mint, symbol: t.symbol,
      entryMc: null, lastMc: Number(t.marketCapSol) || 0,
      openedAt: now(), closing: false, launching: false,
    });
    persistPositions();
    sendWs({ method: 'subscribeTokenTrade', keys: [t.mint] });
    const usdNote = CFG.snipeBuyUsd > 0 ? ` (~$${CFG.snipeBuyUsd})` : '';
    tg(`SNIPE BUY ${t.symbol}\n${sol(snipeSol)} SOL${usdNote} @ mc ${sol(t.marketCapSol, 1)}\n${scan(sig)}`);
  } catch (e) {
    tg(`SNIPE BUY FAILED ${t.symbol}\n${e.message}`);
  } finally {
    pending.delete(t.mint);
  }
}

function onNewToken(t) {
  if (t.traderPublicKey === wallet) return onOwnLaunch(t);
  if (CFG.snipeOthers) return onOtherLaunch(t);
}

// ---------- exits ----------

function limits(p) {
  return p.kind === 'dev'
    ? { tp: CFG.devTakeProfitPct, sl: CFG.devStopLossPct, hold: CFG.devMaxHoldSec }
    : { tp: CFG.snipeTakeProfitPct, sl: CFG.snipeStopLossPct, hold: CFG.snipeMaxHoldSec };
}

function onTrade(t) {
  const p = positions.get(t.mint);
  if (!p || p.closing || p.launching || p.sellIntent || !t.marketCapSol) return;
  const mc = Number(t.marketCapSol);

  if (p.entryMc === null) {      // no baseline yet: the first price we see becomes it
    p.entryMc = mc;
    p.lastMc = mc;
    persistPositions();
    return;
  }

  p.lastMc = mc;
  const chg = (mc / p.entryMc - 1) * 100;
  const L = limits(p);

  if (chg >= L.tp - 1e-9) closePosition(p, `TAKE PROFIT ${sol(chg, 1)}%`);
  else if (L.sl > 0 && chg <= -L.sl) closePosition(p, `STOP LOSS ${sol(chg, 1)}%`);
}

async function finishSell(p, reason, sig, t0) {
  positions.delete(p.mint);
  sendWs({ method: 'unsubscribeTokenTrade', keys: [p.mint] });
  persistPositions();
  const secs = ((now() - t0) / 1000).toFixed(1);
  const held = Math.round((now() - p.openedAt) / 1000);
  const bal = await checkSessionLoss();
  tg(
    `SOLD ${p.symbol} (${p.kind})\n${reason}\nsell took ${secs}s, held ${held}s\n` +
      `wallet ${await fmtBal(bal)}\n${sig ? scan(sig) : '(confirmed by wallet balance)'}`
  );
}

async function closePosition(p, reason) {
  if (p.closing || positions.get(p.mint) !== p) return;
  p.closing = true;
  p.sellIntent = null;
  const t0 = now();
  const isSnipe = p.kind === 'snipe';
  const retries = isSnipe ? CFG.snipeSellRetries : CFG.sellRetries;
  const maxRounds = isSnipe ? CFG.snipeMaxFailedSellRounds : CFG.maxFailedSellRounds;
  const pauseMs = isSnipe ? CFG.snipeSellRoundPauseMs : CFG.sellRoundPauseMs;
  tg(`${reason}: selling ${p.symbol} (${p.kind}) now`); // not awaited — sell must not wait on Telegram

  // already flat?
  try {
    if ((await ops.tokenBalance(p.mint)) <= 0) return finishSell(p, reason, null, t0);
  } catch { /* continue into sell attempts */ }

  for (let i = 1; i <= retries; i++) {
    try {
      const sig = await ops.sell(p.mint, i, p.kind);
      // confirm tokens actually left the wallet (slow land / partial)
      await sleep(400);
      try {
        if ((await ops.tokenBalance(p.mint)) <= 0) return finishSell(p, reason, sig, t0);
        console.log(`[SELL] ${p.symbol} tx landed but balance still > 0, retrying`);
      } catch {
        return finishSell(p, reason, sig, t0); // assume sold if balance check fails after success
      }
    } catch (e) {
      console.log(`[SELL FAIL ${i}/${retries}] ${p.symbol} (${p.kind}): ${e.message}`);
      try {
        if ((await ops.tokenBalance(p.mint)) <= 0) return finishSell(p, reason, null, t0);
      } catch { /* RPC hiccup, keep retrying */ }
      await sleep(isSnipe ? 200 : 300);
    }
  }

  p.failRounds = (p.failRounds || 0) + 1;
  if (p.failRounds >= maxRounds) {
    // last-ditch: one more max-slippage attempt before giving up
    try {
      const sig = await ops.sell(p.mint, retries + 2, p.kind);
      await sleep(500);
      if ((await ops.tokenBalance(p.mint)) <= 0) return finishSell(p, reason + ' (last ditch)', sig, t0);
    } catch (e) {
      console.log(`[SELL LAST DITCH FAIL] ${p.symbol}: ${e.message}`);
      try {
        if ((await ops.tokenBalance(p.mint)) <= 0) return finishSell(p, reason, null, t0);
      } catch { /* ignore */ }
    }
    positions.delete(p.mint);
    sendWs({ method: 'unsubscribeTokenTrade', keys: [p.mint] });
    persistPositions();
    tg(`SELL FAILED, giving up on ${p.symbol} after ${p.failRounds} rounds\nSell it manually NOW\n${p.mint}`);
  } else {
    p.closing = false;
    p.sellIntent = reason;
    p.retryAfter = now() + pauseMs;
    tg(`SELL FAILED for ${p.symbol} (round ${p.failRounds}/${maxRounds}), retrying in ${pauseMs / 1000}s`);
  }
}

// runs every few seconds: time limits, TP/SL from last known mc, and retries for failed sells
function tick() {
  for (const p of [...positions.values()]) {
    if (p.closing || p.launching) continue;

    // queued retry after a failed sell round
    if (p.sellIntent) {
      if (now() >= (p.retryAfter || 0)) closePosition(p, p.sellIntent);
      continue;
    }

    const L = limits(p);

    // max hold timer
    if (L.hold > 0 && (now() - p.openedAt) / 1000 >= L.hold) {
      closePosition(p, 'TIME LIMIT');
      continue;
    }

    // backup TP/SL using last known market cap (in case WS trade events were missed)
    if (p.entryMc && p.lastMc) {
      const chg = (p.lastMc / p.entryMc - 1) * 100;
      if (chg >= L.tp - 1e-9) closePosition(p, `TAKE PROFIT ${sol(chg, 1)}% (tick)`);
      else if (L.sl > 0 && chg <= -L.sl) closePosition(p, `STOP LOSS ${sol(chg, 1)}% (tick)`);
    }
  }
}

// ---------- websocket ----------

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(CFG.wsUrl);

  ws.on('open', () => {
    console.log('[ws] connected');
    wsLastMsgAt = now();
    sendWs({ method: 'subscribeNewToken' });
    const keys = [...positions.keys()];
    if (keys.length) sendWs({ method: 'subscribeTokenTrade', keys });
  });

  ws.on('message', (raw) => {
    wsLastMsgAt = now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || !msg.mint) return;
    if (msg.txType === 'create') onNewToken(msg);
    else if (positions.has(msg.mint)) onTrade(msg);
  });

  ws.on('close', () => {
    console.log('[ws] closed, reconnecting in 2s');
    if (!shuttingDown) setTimeout(connect, 2000);
  });

  ws.on('error', (e) => console.log('[ws] error:', e.message));
}

// a silently dead socket would mean missed sells, so force a reconnect if it goes quiet
function watchdog() {
  if (ws && ws.readyState === WebSocket.OPEN && now() - wsLastMsgAt > 30000) {
    console.log('[ws] silent for 30s, reconnecting');
    ws.terminate();
  }
}

function resubscribe() {
  const keys = [...positions.keys()];
  if (keys.length) sendWs({ method: 'subscribeTokenTrade', keys });
}

// ---------- start / stop ----------

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAutoPilot();
  await tg(`Bot stopping (${signal}). ${positions.size} open position(s) are saved and will be restored on restart.`);
  const deadline = now() + 8000; // give an in-flight sell a few seconds to finish
  while ([...positions.values()].some((p) => p.closing) && now() < deadline) await sleep(200);
  await Promise.allSettled([saveChains.positions, saveChains.names, saveChains.images, saveChains.runtime]);
  process.exit(0);
}

async function main() {
  init();
  process.on('unhandledRejection', (e) => console.log('[unhandledRejection]', (e && e.message) || e));
  process.on('uncaughtException', (e) => console.log('[uncaughtException]', (e && e.message) || e));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  startBalance = await getBalance();
  const saved = await loadState();
  await restorePositions(saved);

  connect();
  setInterval(tick, 3000);
  setInterval(watchdog, 10000);
  setInterval(resubscribe, 60000);

  const warns = [];
  if (!process.env.RPC_URL) warns.push('RPC_URL not set: the public RPC is too slow for reliable exits');
  if (!usingSupabase()) warns.push('Supabase not configured: state is saved to local files and will be lost on redeploy');
  if (CFG.devTakeProfitPct < 6) warns.push('devTakeProfitPct is below ~6%: fees can turn that into a loss');
  if (!TG_TOKEN || !TG_CHAT) warns.push('Telegram not configured: no alerts and no remote control');

  const unusedNames = queue.filter((q) => !q.used).length;
  const snipeSizeNote = CFG.snipeBuyUsd > 0
    ? `$${CFG.snipeBuyUsd}/snipe`
    : `${CFG.buySol} SOL/snipe`;
  await tg(
    `Bot started\nwallet ${wallet}\nbalance ${await fmtBal(startBalance)}\n` +
      `dev buy ${CFG.devBuySol} SOL | sell at +${CFG.devTakeProfitPct}% / stop ${CFG.devStopLossPct > 0 ? '-' + CFG.devStopLossPct + '%' : 'off'} | storage ${usingSupabase() ? 'Supabase' : 'local files'}\n` +
      `open positions ${positions.size} | names unused ${unusedNames} | image links ${imagePool().length}\n` +
      `sniping: ${CFG.snipeOthers ? 'ON (' + snipeSizeNote + ')' : 'OFF'}\n` +
      `auto-pilot: interval ${CFG.autoIntervalSec}s | soft limit ${CFG.autoMaxConcurrent} concurrent | boot ${CFG.autoPilot ? 'ON' : 'OFF'}` +
      (warns.length ? `\n\nWarnings:\n- ${warns.join('\n- ')}` : '') +
      `\n\nTap the buttons below or send /help`,
    true
  );

  if (TG_TOKEN && TG_CHAT) tgPoll();
  if (CFG.launchOnStart) {
    await sleep(2500);
    launchToken();
  }
  // Auto-start from env AUTO_PILOT=true if a names list already has unused entries
  if (CFG.autoPilot && unusedNames > 0) {
    startAutoPilot();
    tg(`Auto-pilot started from env (AUTO_PILOT=true). Remaining: ${unusedNames}`);
  } else if (CFG.autoPilot && unusedNames === 0) {
    tg('AUTO_PILOT=true but names list is empty/all used. Load /names then /autopilot on.');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
} else {
  module.exports = {
    CFG, init, positions, ops, store, sellAllTx, buyTx, parseNames, validNameSymbol, landTx, tick,
    fmtBal, getSolUsd, resetSolPrice: () => { solPriceCache = { price: 0, at: 0 }; },
    pickRandomImage, parseUrls, imagePool, setImages: (a) => { images = a; }, getImages: () => images,
    onTrade, onOwnLaunch, closePosition, persistPositions, persistNames, persistImages, restorePositions,
    loadState, getConn: () => conn, getQueue: () => queue, setQueue: (q) => { queue = q; },
    flush: () => Promise.all([saveChains.positions, saveChains.names, saveChains.images, saveChains.runtime]),
  };
}
