// test.js - offline self-test. No network, no real funds: network calls are stubbed.
// Run: npm test

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');

process.env.PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
delete process.env.TG_BOT_TOKEN;
delete process.env.TG_CHAT_ID;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

const bot = require('./bot.js');
bot.init();
const TP = bot.CFG.devTakeProfitPct;
const SL = bot.CFG.devStopLossPct;
const targetMc = 100 * (1 + TP / 100);

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkPos = (mint, entryMc, extra = {}) => ({
  kind: 'dev', mint, symbol: mint, entryMc, lastMc: entryMc,
  openedAt: Date.now(), closing: false, launching: false, ...extra,
});

(async () => {
  console.log('\n[names parsing]');
  const names = bot.parseNames([
    '1. Cool Coin COOL', '2) Other Coin OTH', '2024 Coin YEAR', 'lowercase thing abc',
    'oneword', 'Bad Symbol BAD!', '   ',
  ]);
  ok(names.length === 4, `parsed 4 valid lines (got ${names.length})`);
  ok(names[0].name === 'Cool Coin' && names[0].symbol === 'COOL', 'numbering "1." is stripped');
  ok(names[2].name === '2024 Coin' && names[2].symbol === 'YEAR', 'name starting with digits is kept');
  ok(names[3].symbol === 'ABC', 'symbol is upper-cased');

  console.log('\n[take profit fires once, at the target, and not before]');
  let sells = [];
  bot.ops.sell = async (mint, attempt) => { sells.push({ mint, attempt }); return 'SIG1'; };
  bot.ops.tokenBalance = async () => 1;
  bot.ops.walletBalance = async () => 1.0;
  bot.positions.set('AAA', mkPos('AAA', 100));
  for (const mc of [105, 120, targetMc - 0.1]) bot.onTrade({ mint: 'AAA', marketCapSol: mc });
  ok(sells.length === 0, `no sell below +${TP}%`);
  bot.onTrade({ mint: 'AAA', marketCapSol: targetMc });
  bot.onTrade({ mint: 'AAA', marketCapSol: targetMc * 1.2 });
  bot.onTrade({ mint: 'AAA', marketCapSol: targetMc * 2 });
  ok(sells.length === 1, `exactly one sell at +${TP}% even with more events (got ${sells.length})`);
  await sleep(100);
  ok(!bot.positions.has('AAA'), 'position removed after the sell');

  console.log('\n[stop loss]');
  bot.positions.set('BBB', mkPos('BBB', 100));
  sells = [];
  bot.onTrade({ mint: 'BBB', marketCapSol: 100 * (1 - SL / 100) + 1 });
  ok(sells.length === 0, `no sell just above the -${SL}% stop`);
  bot.onTrade({ mint: 'BBB', marketCapSol: 100 * (1 - SL / 100) - 1 });
  ok(sells.length === 1, `sells once below -${SL}%`);
  await sleep(100);

  console.log('\n[sell retries with higher fee attempts]');
  sells = [];
  let calls = 0;
  bot.ops.sell = async (mint, attempt) => {
    sells.push(attempt);
    if (++calls < 3) throw new Error('slippage exceeded');
    return 'SIG2';
  };
  bot.positions.set('CCC', mkPos('CCC', 100));
  await bot.closePosition(bot.positions.get('CCC'), 'TEST');
  ok(sells.join(',') === '1,2,3', `attempts 1,2,3 then success (got ${sells.join(',')})`);
  ok(!bot.positions.has('CCC'), 'position removed after the third attempt succeeds');

  console.log('\n[late-landing tx is detected through wallet balance]');
  bot.ops.sell = async () => { throw new Error('not confirmed within 15s'); };
  bot.ops.tokenBalance = async () => 0; // tokens already gone: an earlier tx landed
  bot.positions.set('DDD', mkPos('DDD', 100));
  await bot.closePosition(bot.positions.get('DDD'), 'TEST');
  ok(!bot.positions.has('DDD'), 'treated as sold, no false failure');

  console.log('\n[total failure keeps the position and retries later]');
  bot.CFG.sellRoundPauseMs = 0;
  bot.ops.sell = async () => { throw new Error('rpc down'); };
  bot.ops.tokenBalance = async () => 5;
  bot.positions.set('EEE', mkPos('EEE', 100));
  await bot.closePosition(bot.positions.get('EEE'), 'TAKE PROFIT');
  const e = bot.positions.get('EEE');
  ok(e && e.sellIntent === 'TAKE PROFIT' && e.failRounds === 1 && !e.closing, 'position kept with a pending sell');
  sells = [];
  bot.ops.sell = async (m, a) => { sells.push(a); return 'SIG3'; };
  bot.tick();
  await sleep(100);
  ok(sells.length === 1 && !bot.positions.has('EEE'), 'tick() retried the pending sell and it completed');

  console.log('\n[gives up after maxFailedSellRounds]');
  bot.ops.sell = async () => { throw new Error('rpc down'); };
  bot.positions.set('FFF', mkPos('FFF', 100));
  for (let i = 0; i < bot.CFG.maxFailedSellRounds; i++) {
    const p = bot.positions.get('FFF');
    if (!p) break;
    await bot.closePosition(p, 'TAKE PROFIT');
  }
  ok(!bot.positions.has('FFF'), 'position dropped (with an alert) after the final failed round');

  console.log('\n[time limit]');
  sells = [];
  bot.ops.sell = async (m, a) => { sells.push(m); return 'SIG4'; };
  bot.ops.tokenBalance = async () => 1;
  bot.positions.set('GGG', mkPos('GGG', 100, { kind: 'snipe', openedAt: Date.now() - 400000 }));
  bot.positions.set('GGD', mkPos('GGD', 100, { openedAt: Date.now() - (bot.CFG.devMaxHoldSec + 5) * 1000 }));
  bot.positions.set('GGN', mkPos('GGN', 100)); // fresh, must not be sold
  bot.tick();
  await sleep(100);
  ok(sells.includes('GGG'), 'snipe position sold after its max hold time');
  ok(sells.includes('GGD'), `dev position sold after ${bot.CFG.devMaxHoldSec}s hold limit`);
  ok(!sells.includes('GGN'), 'a fresh position is left alone');
  bot.positions.delete('GGN');

  console.log('\n[baseline: first price seen becomes the entry]');
  bot.positions.set('HHH', mkPos('HHH', null));
  bot.onTrade({ mint: 'HHH', marketCapSol: 50 });
  ok(bot.positions.get('HHH').entryMc === 50, 'entry baseline set from first trade');
  sells = [];
  bot.onTrade({ mint: 'HHH', marketCapSol: 50 * (1 + TP / 100) });
  ok(sells.length === 1 && sells[0] === 'HHH', `then sells once +${TP}% from that baseline`);
  await sleep(100);

  console.log('\n[landTx: rebroadcast + confirm]');
  const conn = bot.getConn();
  let sends = 0;
  let polls = 0;
  conn.sendRawTransaction = async () => { sends++; return 'SIGX'; };
  conn.getSignatureStatuses = async () => ({
    value: [++polls >= 4 ? { confirmationStatus: 'confirmed', err: null } : null],
  });
  bot.CFG.rebroadcastMs = 50;
  const fakeTx = { serialize: () => Buffer.from([1, 2, 3]) };
  const sig = await bot.landTx(fakeTx, 5000);
  ok(sig === 'SIGX', 'returns the signature once confirmed');
  ok(sends >= 2, `tx was re-broadcast while waiting (${sends} sends)`);

  conn.getSignatureStatuses = async () => ({ value: [{ confirmationStatus: 'processed', err: { InstructionError: [0, 'Custom'] } }] });
  let threw = false;
  try { await bot.landTx(fakeTx, 2000); } catch (err) { threw = /failed on-chain/.test(err.message); }
  ok(threw, 'on-chain error is surfaced');

  conn.getSignatureStatuses = async () => ({ value: [null] });
  threw = false;
  const t0 = Date.now();
  try { await bot.landTx(fakeTx, 600); } catch (err) { threw = /not confirmed/.test(err.message); }
  ok(threw && Date.now() - t0 < 2000, 'times out cleanly when never confirmed');



  console.log('\n[sell and buy request parameters]');
  const sentBodies = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => { sentBodies.push(JSON.parse(opts.body)); return { status: 500, text: async () => 'stub' }; };
  for (const a of [1, 3, 5]) { try { await bot.sellAllTx('MINT', a); } catch { /* expected */ } }
  try { await bot.buyTx('MINT', 0.033); } catch { /* expected */ }
  global.fetch = origFetch;
  const near = (a, b) => Math.abs(a - b) < 1e-12;
  ok(sentBodies[0].action === 'sell' && sentBodies[0].amount === '100%', 'sells ask for 100% of the balance');
  ok(sentBodies[0].slippage === 25 && near(sentBodies[0].priorityFee, 0.0002), 'sell attempt 1: 25% slippage, 0.0002 SOL fee (your values)');
  ok(sentBodies[1].slippage === 45 && near(sentBodies[1].priorityFee, 0.0006), 'sell attempt 3: 45% slippage, 0.0006 SOL fee');
  ok(sentBodies[2].slippage === 50 && near(sentBodies[2].priorityFee, 0.001), 'sell attempt 5: slippage capped at 50%, 0.001 SOL fee');
  ok(sentBodies[3].action === 'buy' && sentBodies[3].slippage === 15 && near(sentBodies[3].priorityFee, 0.0003) && sentBodies[3].amount === 0.033, 'snipe buy: 15% slippage, 0.0003 SOL fee');

  console.log('\n[balance shown with dollars in brackets]');
  bot.ops.solPrice = async () => 180;
  ok((await bot.fmtBal(0.5)) === '0.5000 SOL ($90.00)', 'format is 0.5000 SOL ($90.00)');
  ok((await bot.fmtBal(10)) === '10.0000 SOL ($1,800.00)', 'thousands separator in the dollar value');
  bot.ops.solPrice = async () => 0;
  ok((await bot.fmtBal(0.5)) === '0.5000 SOL', 'falls back to SOL only when there is no price');
  ok((await bot.fmtBal(null)) === '?', 'unknown balance shows ?');

  console.log('\n[SOL price lookup and fallback]');
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (/coingecko/.test(url)) return { ok: true, json: async () => ({ solana: { usd: 150 } }) };
    throw new Error('blocked');
  };
  bot.resetSolPrice();
  ok((await bot.getSolUsd()) === 150, 'CoinGecko price is used');
  global.fetch = async () => { throw new Error('no network'); };
  ok((await bot.getSolUsd()) === 150, 'cached for 60s, no new network call');
  bot.resetSolPrice();
  global.fetch = async (url) => {
    if (/binance/.test(url)) return { ok: true, json: async () => ({ price: '151.20' }) };
    throw new Error('blocked');
  };
  ok((await bot.getSolUsd()) === 151.2, 'falls back to Binance when CoinGecko fails');
  bot.resetSolPrice();
  global.fetch = async () => { throw new Error('down'); };
  ok((await bot.getSolUsd()) === 0, 'returns 0 when every source fails (balance then shows without $)');
  global.fetch = realFetch;

  console.log('\n[random image pool]');
  const imgServer = http.createServer((req, res) => {
    if (req.url.startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from([137, 80, 78, 71]));
    }
    if (req.url.startsWith('/text')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('not an image');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r2) => imgServer.listen(0, '127.0.0.1', r2));
  const base = `http://127.0.0.1:${imgServer.address().port}`;

  ok(bot.parseUrls('x https://a.com/1.png\nhttp://b.com/2.jpg junk ftp://c.com/3 https://a.com/1.png').length === 2,
    'parseUrls keeps http(s) links and drops junk and duplicates');
  bot.CFG.imageUrls = ['https://x.example/1.png'];
  bot.setImages(['https://x.example/1.png', 'https://y.example/2.png']);
  ok(bot.imagePool().length === 2, 'pool merges built-in and added links without duplicates');

  bot.CFG.imageUrls = [];
  bot.setImages([`${base}/missing`, `${base}/text`, `${base}/ok1.png`]);
  const img = await bot.pickRandomImage();
  ok(img && img.mime === 'image/png' && img.buf.length === 4, 'picks a working image even when other links are broken');
  bot.setImages([`${base}/missing`]);
  ok((await bot.pickRandomImage()) === null, 'returns null when no link works');
  imgServer.close();

  console.log('\n[persistence: local file fallback]');
  bot.setQueue([{ name: 'A Coin', symbol: 'AAA', used: false }]);
  bot.setImages(['https://img.example/a.png']);
  bot.persistImages();
  bot.positions.clear();
  bot.positions.set('M1', mkPos('M1', 100));
  bot.positions.set('M2', mkPos('M2', 200, { kind: 'snipe' }));
  bot.persistPositions();
  bot.persistNames();
  await bot.flush();
  const savedPos = await bot.store.get('positions');
  const savedNames = await bot.store.get('names');
  ok(Array.isArray(savedPos) && savedPos.length === 2, 'positions saved');
  ok(savedNames && savedNames[0].symbol === 'AAA', 'names saved');
  const savedImages = await bot.store.get('images');
  ok(Array.isArray(savedImages) && savedImages[0] === 'https://img.example/a.png', 'image links saved');

  bot.positions.clear();
  bot.ops.tokenBalance = async (m) => (m === 'M1' ? 7 : 0); // M2 already sold while the bot was down
  const r = await bot.restorePositions(savedPos);
  ok(r.restored === 1 && r.dropped === 1, 'restore keeps held tokens and drops already-sold ones');
  ok(bot.positions.has('M1') && !bot.positions.has('M2'), 'only the held position is tracked again');
  ok(bot.positions.get('M1').entryMc === 100, 'entry baseline survives the restart');
  await bot.flush();

  console.log('\n[persistence: Supabase REST (mock server)]');
  const rows = new Map();
  let sawPrefer = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/rest/v1/bot_state' || req.headers.apikey !== 'test-key') {
      res.writeHead(401);
      return res.end('{}');
    }
    if (req.method === 'GET') {
      const k = (u.searchParams.get('key') || '').replace(/^eq\./, '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(rows.has(k) ? [{ value: rows.get(k) }] : []));
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      sawPrefer = req.headers.prefer || '';
      const j = JSON.parse(body);
      rows.set(j.key, j.value);
      res.writeHead(201);
      res.end();
    });
  });
  await new Promise((r2) => server.listen(0, '127.0.0.1', r2));
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_SERVICE_KEY = 'test-key';

  bot.setQueue([{ name: 'Sup Coin', symbol: 'SUP', used: true }]);
  bot.setImages(['https://img.example/sup.png']);
  bot.persistImages();
  bot.persistNames();
  bot.persistPositions();
  await bot.flush();
  ok(rows.size === 3, `three rows upserted: names, images, positions (${rows.size})`);
  ok(/merge-duplicates/.test(sawPrefer), 'uses upsert (merge-duplicates)');
  const n = await bot.store.get('names');
  ok(n && n[0].symbol === 'SUP' && n[0].used === true, 'names read back from Supabase');
  bot.setImages([]);
  const lp = await bot.loadState();
  ok(bot.getImages()[0] === 'https://img.example/sup.png', 'image links restored from Supabase');
  ok(Array.isArray(lp) && lp.length === 1 && lp[0].mint === 'M1', 'loadState returns saved positions and loads names');

  process.env.SUPABASE_SERVICE_KEY = 'wrong';
  threw = false;
  try { await bot.store.get('names'); } catch { threw = true; }
  ok(threw, 'a bad key raises an error (the bot then warns on Telegram)');
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
