// pump-launcher-bot-v2.js
// You trigger every launch from Telegram. The bot creates the token with a dev buy,
// then sells 100% automatically on your profit / stop / time rules.
//
// Telegram commands (only your TG_CHAT_ID is accepted):
//   /launch                          launch the default token in CFG.token
//   /launch Name SYMBOL              launch with this name/symbol
//   /launch Name SYMBOL <image-url>  ...and this image URL
//   (attach a photo with the /launch caption to use that photo)
//   /image <url>  (or photo + caption /image)   set the default image
//   /names                           then, on the following lines, your list for the day:
//                                      1. Cool Coin COOL
//                                      2. Other Coin OTH
//   /list                            show the list and what is done
//   /next [n]                        launch the next unused name (or number n)
//   /clearnames   /status   /sellall
//
// Setup:  npm i ws @solana/web3.js bs58@5     (Node 18+)
// Env:    PRIVATE_KEY, RPC_URL, TG_BOT_TOKEN, TG_CHAT_ID
// Run:    node pump-launcher-bot-v2.js

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const bs58 = require('bs58');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');

if (!process.env.PRIVATE_KEY) {
  console.error('Set PRIVATE_KEY env var (base58). Use a dedicated wallet.');
  process.exit(1);
}

const CFG = {
  wsUrl: 'wss://pumpportal.fun/api/data',
  tradeUrl: 'https://pumpportal.fun/api/trade-local',
  ipfsUrl: 'https://pump.fun/api/ipfs',
  rpc: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // ---- FEES / SLIPPAGE (lowered to keep costs down) ----
  slippagePct: 25,              // used for sells and launches so they reliably land
  snipeBuySlippagePct: 15,      // tighter on snipe buys (less sandwich exposure)
  priorityFeeSol: 0.0002,       // launches and sells (was 0.001)
  snipeBuyPriorityFeeSol: 0.0003, // snipe buys only; too low and you land late
  sellRetries: 5,

  // ---- DEFAULT TOKEN (used by plain /launch) ----
  token: {
    name: 'My Token',
    symbol: 'MTK',
    description: '',   // shared by every launch
    twitter: '',
    telegram: '',
    website: '',
  },
  imagePath: './token.png',  // fallback image if none is given via Telegram
  maxImageBytes: 5 * 1024 * 1024,
  namesFile: './names.json', // keeps your daily list across restarts
  devBuySol: 0.06,           // SOL spent on the dev buy of every launch

  // ---- LAUNCH CONTROL ----
  launchOnStart: false,
  maxLaunchesPerRun: 3,
  launchCooldownSec: 60,

  // ---- SELL RULES FOR YOUR LAUNCHES ----
  devTakeProfitPct: 50,      // keep above ~5% or fees eat the profit
  devStopLossPct: 35,        // 0 = disabled
  devMaxHoldSec: 300,        // sell after 5 min if target not hit (0 = disabled)

  // ---- SNIPING OTHER LAUNCHES ----
  // OFF by default. To turn on, set env SNIPE_OTHERS=true and restart the bot.
  snipeOthers: process.env.SNIPE_OTHERS === 'true',
  minDevBuySol: 1,
  maxDevBuySol: 10,
  buySol: 0.033,             // ~ $5 at $150/SOL. Recalculate from the current SOL price.
  snipeTakeProfitPct: 50,
  snipeStopLossPct: 25,
  snipeMaxHoldSec: 180,
  maxOpenSnipes: 5,
  maxSessionLossSol: 0.3,
};

const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;

const kp = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const conn = new Connection(CFG.rpc, 'confirmed');
const wallet = kp.publicKey.toBase58();

const positions = new Map(); // mint -> position
const pending = new Set();
let ws;
let startBalance = 0;
let halted = false;
let launching = false;
let launches = 0;
let lastLaunchAt = 0;
let defaultImage = null;     // set via /image
let queue = [];              // [{name, symbol, used}]

const now = () => Date.now();
const sol = (n, d = 4) => Number(n).toFixed(d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scan = (sig) => `https://solscan.io/tx/${sig}`;

// ---------- names queue ----------
function loadQueue() {
  try { queue = JSON.parse(fs.readFileSync(CFG.namesFile, 'utf8')); } catch { queue = []; }
}
function saveQueue() {
  try { fs.writeFileSync(CFG.namesFile, JSON.stringify(queue, null, 2)); } catch (e) {
    console.log('[names] save failed:', e.message);
  }
}
function validNameSymbol(name, symbol) {
  if (!name || name.length > 32) return 'Name must be 1-32 characters';
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) return 'Symbol must be 1-10 letters/numbers';
  return null;
}
function parseNameSymbol(tokens) {
  if (tokens.length < 2) return null;
  return { name: tokens.slice(0, -1).join(' '), symbol: tokens[tokens.length - 1].toUpperCase() };
}
function parseNames(lines) {
  const out = [];
  for (const line of lines) {
    const t = line.trim().replace(/^\d+\s*[.)\-:]?\s*/, '');
    if (!t) continue;
    const ns = parseNameSymbol(t.split(/\s+/));
    if (!ns) continue;
    if (validNameSymbol(ns.name, ns.symbol)) continue;
    out.push({ ...ns, used: false });
  }
  return out;
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

// ---------- telegram ----------
async function tg(text) {
  console.log(text.replace(/\n/g, ' | '));
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.log('[tg] send failed:', e.message);
  }
}

async function tgPoll() {
  let offset = 0;
  while (true) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${offset}`);
      const j = await r.json();
      for (const u of j.result || []) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || String(m.chat.id) !== String(TG_CHAT)) continue;
        const text = (m.text || m.caption || '').trim();
        if (!text.startsWith('/')) continue;
        const photoId = m.photo && m.photo.length ? m.photo[m.photo.length - 1].file_id : null;
        handleCommand(text, photoId).catch((e) => tg(`Command error: ${e.message}`));
      }
    } catch (e) {
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
      let image = null;
      if (args[0] && /^https?:\/\//i.test(args[0])) image = await fetchImage(args[0]);
      else if (photoId) image = await telegramPhoto(photoId);
      else return tg('Usage: /image <url>  (or send a photo with the caption /image)');
      defaultImage = image;
      return tg('Default image set. It will be used for launches that do not include their own image.');
    }

    case '/names': {
      const items = parseNames([...lines.slice(1), ...(args.length ? [args.join(' ')] : [])]);
      if (!items.length) {
        return tg('Send /names and then one per line:\n1. Cool Coin COOL\n2. Other Coin OTH\n(last word on each line is the symbol)');
      }
      queue = items;
      saveQueue();
      return tg(`Saved ${queue.length} names. Use /next to launch the next one, /list to view.`);
    }

    case '/list': {
      if (!queue.length) return tg('Names list is empty. Use /names to load it.');
      return tg(queue.map((q, i) => `${i + 1}. ${q.name} (${q.symbol})${q.used ? ' [done]' : ''}`).join('\n'));
    }

    case '/clearnames':
      queue = [];
      saveQueue();
      return tg('Names list cleared');

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
        saveQueue();
      }
      return;
    }

    case '/status': {
      if (!positions.size) return tg('No open positions');
      const out = [...positions.values()].map((p) => {
        const chg = p.entryMc ? ((p.lastMc / p.entryMc - 1) * 100).toFixed(1) + '%' : 'n/a';
        return `${p.symbol} (${p.kind}) ${chg}`;
      });
      return tg(`Open positions:\n${out.join('\n')}`);
    }

    case '/sellall': {
      const all = [...positions.values()].filter((p) => !p.launching);
      if (!all.length) return tg('Nothing to sell');
      tg(`Selling ${all.length} position(s)`);
      all.forEach((p) => closePosition(p, 'MANUAL /sellall'));
      return;
    }

    default:
      return tg(
        'Commands:\n/launch [Name SYMBOL] [image-url]\n/image <url>\n/names (list on next lines)\n/list\n/next [n]\n/clearnames\n/status\n/sellall'
      );
  }
}

// ---------- execution ----------
async function send(extra, extraSigners = []) {
  const res = await fetch(CFG.tradeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: wallet,
      slippage: CFG.slippagePct,
      priorityFee: CFG.priorityFeeSol,
      pool: 'auto',
      ...extra, // per-action overrides (slippage / priorityFee) win over the defaults above
    }),
  });
  if (res.status !== 200) throw new Error(`trade-local ${res.status}: ${await res.text()}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  tx.sign([...extraSigners, kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) throw new Error(`tx failed on-chain: ${JSON.stringify(conf.value.err)} (${sig})`);
  return sig;
}

const buyTx = (mint, amountSol) =>
  send({
    action: 'buy', mint, amount: amountSol, denominatedInSol: 'true',
    slippage: CFG.snipeBuySlippagePct,
    priorityFee: CFG.snipeBuyPriorityFeeSol,
  });

const sellAllTx = (mint) =>
  send({ action: 'sell', mint, amount: '100%', denominatedInSol: 'false' });

async function getBalance() {
  return (await conn.getBalance(kp.publicKey)) / 1e9;
}

async function checkSessionLoss() {
  try {
    const bal = await getBalance();
    const drawdown = startBalance - bal;
    if (CFG.snipeOthers && drawdown >= CFG.maxSessionLossSol && !halted) {
      halted = true;
      tg(`HALT: session loss limit hit (${sol(drawdown)} SOL). No new snipes. Balance ${sol(bal)} SOL`);
    }
    return bal;
  } catch (e) {
    console.log('[wallet] balance check failed:', e.message);
    return null;
  }
}

// ---------- token launch ----------
async function uploadMetadata(tok) {
  const img = tok.image || defaultImage || loadImageFile();
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
    const bal = await getBalance();
    // dev buy + ~0.02 SOL headroom for account rent and network/priority fees
    if (bal < CFG.devBuySol + 0.02) {
      throw new Error(`balance ${sol(bal)} SOL too low for dev buy ${CFG.devBuySol} + fees`);
    }
    await tg(`Launching ${tok.symbol} (${tok.name})\ndev buy ${CFG.devBuySol} SOL\nsell at +${CFG.devTakeProfitPct}% / stop -${CFG.devStopLossPct}%`);

    const uri = await uploadMetadata(tok);

    const p = {
      kind: 'dev', mint, symbol: tok.symbol,
      entryMc: null, lastMc: 0,
      openedAt: now(), closing: false, launching: true,
    };
    positions.set(mint, p);
    sendWs({ method: 'subscribeTokenTrade', keys: [mint] });

    let sig;
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
        [mintKp]
      );
    } catch (e) {
      positions.delete(mint);
      sendWs({ method: 'unsubscribeTokenTrade', keys: [mint] });
      throw new Error(`${e.message}\nIf the tx may have landed, check mint ${mint}`);
    }

    launches++;
    lastLaunchAt = now();
    p.launching = false;
    p.openedAt = now();
    tg(`LAUNCHED ${tok.symbol}\nmint ${mint}\nhttps://pump.fun/coin/${mint}\n${scan(sig)}`);
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
      console.log(`[baseline] ${existing.symbol} start mc ${sol(mc, 1)} SOL`);
    }
    return;
  }
  // launched manually from the same wallet (pump.fun site/app)
  positions.set(t.mint, {
    kind: 'dev', mint: t.mint, symbol: t.symbol,
    entryMc: mc, lastMc: mc, openedAt: now(), closing: false, launching: false,
  });
  sendWs({ method: 'subscribeTokenTrade', keys: [t.mint] });
  tg(`DEV LAUNCH detected (manual)\n${t.symbol}\nstart mc ${sol(mc, 1)} SOL\nauto-sell at +${CFG.devTakeProfitPct}%\n${t.mint}`);
}

async function onOtherLaunch(t) {
  const dev = Number(t.solAmount || 0);
  if (halted) return;
  if (dev < CFG.minDevBuySol || dev > CFG.maxDevBuySol) return;
  if (!t.marketCapSol) return;
  if (positions.size + pending.size >= CFG.maxOpenSnipes) return;
  if (positions.has(t.mint) || pending.has(t.mint)) return;

  pending.add(t.mint);
  try {
    const sig = await buyTx(t.mint, CFG.buySol);
    positions.set(t.mint, {
      kind: 'snipe', mint: t.mint, symbol: t.symbol,
      entryMc: Number(t.marketCapSol), lastMc: Number(t.marketCapSol),
      openedAt: now(), closing: false, launching: false,
    });
    sendWs({ method: 'subscribeTokenTrade', keys: [t.mint] });
    tg(`SNIPE BUY ${t.symbol}\n${CFG.buySol} SOL @ mc ${sol(t.marketCapSol, 1)}\n${scan(sig)}`);
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
  if (!p || p.closing || p.launching || !t.marketCapSol) return;
  const mc = Number(t.marketCapSol);
  if (p.entryMc === null) {
    p.entryMc = mc;
    p.lastMc = mc;
    return;
  }
  p.lastMc = mc;
  const chg = (mc / p.entryMc - 1) * 100;
  const L = limits(p);
  if (chg >= L.tp) closePosition(p, `TAKE PROFIT ${sol(chg, 1)}%`);
  else if (L.sl > 0 && chg <= -L.sl) closePosition(p, `STOP LOSS ${sol(chg, 1)}%`);
}

async function closePosition(p, reason) {
  if (p.closing) return;
  p.closing = true;
  for (let i = 1; i <= CFG.sellRetries; i++) {
    try {
      const sig = await sellAllTx(p.mint);
      const heldSec = Math.round((now() - p.openedAt) / 1000);
      positions.delete(p.mint);
      sendWs({ method: 'unsubscribeTokenTrade', keys: [p.mint] });
      const bal = await checkSessionLoss();
      tg(
        `SOLD ${p.symbol} (${p.kind})\n${reason}\nheld ${heldSec}s\n` +
          `wallet ${bal === null ? '?' : sol(bal)} SOL\n${scan(sig)}`
      );
      return;
    } catch (e) {
      console.log(`[SELL FAIL ${i}/${CFG.sellRetries}] ${p.symbol}: ${e.message}`);
      await sleep(1000);
    }
  }
  positions.delete(p.mint);
  tg(`SELL FAILED after ${CFG.sellRetries} tries: ${p.symbol}\nSell manually NOW\n${p.mint}`);
}

setInterval(() => {
  for (const p of positions.values()) {
    const { hold } = limits(p);
    if (hold > 0 && !p.closing && !p.launching && (now() - p.openedAt) / 1000 >= hold) {
      closePosition(p, 'TIME LIMIT');
    }
  }
}, 3000);

// ---------- websocket ----------
function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(CFG.wsUrl);
  ws.on('open', () => {
    console.log('[ws] connected');
    sendWs({ method: 'subscribeNewToken' });
    const keys = [...positions.keys()];
    if (keys.length) sendWs({ method: 'subscribeTokenTrade', keys });
  });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || !msg.mint) return;
    if (msg.txType === 'create') onNewToken(msg);
    else if (positions.has(msg.mint)) onTrade(msg);
  });
  ws.on('close', () => {
    console.log('[ws] closed, reconnecting in 2s');
    setTimeout(connect, 2000);
  });
  ws.on('error', (e) => console.log('[ws] error:', e.message));
}

// ---------- start ----------
(async () => {
  loadQueue();
  startBalance = await getBalance();
  connect();
  await tg(
    `Bot started\nwallet ${wallet}\nbalance ${sol(startBalance)} SOL\n` +
      `dev buy ${CFG.devBuySol} SOL | sell at +${CFG.devTakeProfitPct}% / stop -${CFG.devStopLossPct}%\n` +
      `sniping: ${CFG.snipeOthers ? 'ON (' + CFG.buySol + ' SOL per buy)' : 'OFF'}\n` +
      `names in list: ${queue.filter((q) => !q.used).length} unused\nSend /help for commands`
  );
  if (TG_TOKEN && TG_CHAT) tgPoll();
  if (CFG.launchOnStart) {
    await sleep(2500);
    launchToken();
  }
})();
