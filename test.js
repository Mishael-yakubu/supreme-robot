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
delete process.env.SNIPE_MIN_MC_USD;
delete process.env.SNIPE_MAX_MC_USD;

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
const near = (a, b) => Math.abs(a - b) < 1e-12;
const mkPos = (mint, entryMc, extra = {}) => ({
  kind: 'dev', mint, symbol: mint, entryMc, lastMc: entryMc,
  openedAt: Date.now(), closing: false, launching: false, ...extra,
});

// wallet model: tokens are held until a sell "lands" and sets the balance to 0
const holdings = {};
bot.ops.tokenBalance = async (m) => (m in holdings ? holdings[m] : 1);
bot.ops.walletBalance = async () => 1.0;
bot.ops.solPrice = async () => 150;
let sells = [];
const sellLands = async (m, attempt, kind) => { sells.push({ m, attempt, kind }); holdings[m] = 0; return 'SIG'; };

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

  console.log('\n[take profit fires automatically, once, at the target]');
  bot.ops.sell = sellLands;
  bot.positions.set('AAA', mkPos('AAA', 100));
  for (const mc of [105, 120, targetMc - 0.1]) bot.onTrade({ mint: 'AAA', marketCapSol: mc });
  await sleep(100);
  ok(sells.length === 0, `no sell below +${TP}%`);
  bot.onTrade({ mint: 'AAA', marketCapSol: targetMc });
  bot.onTrade({ mint: 'AAA', marketCapSol: targetMc * 1.2 });
  bot.onTrade({ mint: 'AAA', marketCapSol: targetMc * 2 });
  await sleep(1000);
  ok(sells.length === 1, `exactly one sell at +${TP}% even with more events (got ${sells.length})`);
  ok(!bot.positions.has('AAA'), 'position removed after the sell');

  console.log('\n[stop loss fires automatically]');
  sells = [];
  bot.positions.set('BBB', mkPos('BBB', 100));
  bot.onTrade({ mint: 'BBB', marketCapSol: 100 * (1 - SL / 100) + 1 });
  await sleep(100);
  ok(sells.length === 0, `no sell just above the -${SL}% stop`);
  bot.onTrade({ mint: 'BBB', marketCapSol: 100 * (1 - SL / 100) - 1 });
  await sleep(1000);
  ok(sells.length === 1 && !bot.positions.has('BBB'), `sells once below -${SL}% and the position closes`);

  console.log('\n[sell retries]');
  sells = [];
  let calls = 0;
  bot.ops.sell = async (m, attempt, kind) => {
    sells.push({ attempt });
    if (++calls < 3) throw new Error('slippage exceeded');
    holdings[m] = 0;
    return 'SIG2';
  };
  bot.positions.set('CCC', mkPos('CCC', 100));
  await bot.closePosition(bot.positions.get('CCC'), 'TEST');
  ok(sells.map((x) => x.attempt).join(',') === '1,2,3', `attempts 1,2,3 then success (got ${sells.map((x) => x.attempt).join(',')})`);
  ok(!bot.positions.has('CCC'), 'position removed after the third attempt succeeds');

  console.log('\n[tx landed late: detected through the wallet balance]');
  bot.ops.sell = async (m) => { holdings[m] = 0; throw new Error('not confirmed within 10s'); };
  bot.positions.set('DDD', mkPos('DDD', 100));
  await bot.closePosition(bot.positions.get('DDD'), 'TEST');
  ok(!bot.positions.has('DDD'), 'treated as sold, no false failure');

  console.log('\n[already flat: no sell is sent]');
  sells = [];
  bot.ops.sell = sellLands;
  holdings.FLAT = 0;
  bot.positions.set('FLAT', mkPos('FLAT', 100));
  await bot.closePosition(bot.positions.get('FLAT'), 'TEST');
  ok(sells.length === 0 && !bot.positions.has('FLAT'), 'position closed without sending a sell');

  console.log('\n[tx confirmed but tokens still in wallet: sells again]');
  sells = [];
  let landed = 0;
  bot.ops.sell = async (m, attempt) => { sells.push(attempt); if (++landed >= 2) holdings[m] = 0; return 'SIG3'; };
  bot.positions.set('PART', mkPos('PART', 100));
  await bot.closePosition(bot.positions.get('PART'), 'TEST');
  ok(sells.length === 2 && !bot.positions.has('PART'), 'second sell sent when balance was still above zero');

  console.log('\n[total failure keeps the position and retries later]');
  bot.CFG.sellRetries = 2;
  bot.CFG.sellRoundPauseMs = 0;
  bot.ops.sell = async () => { throw new Error('rpc down'); };
  bot.positions.set('EEE', mkPos('EEE', 100));
  await bot.closePosition(bot.positions.get('EEE'), 'TAKE PROFIT');
  const e = bot.positions.get('EEE');
  ok(e && e.sellIntent === 'TAKE PROFIT' && e.failRounds === 1 && !e.closing, 'position kept with a pending sell');
  sells = [];
  bot.ops.sell = sellLands;
  bot.tick();
  await sleep(1000);
  ok(sells.length === 1 && !bot.positions.has('EEE'), 'tick() retried the pending sell and it completed');

  console.log('\n[gives up after maxFailedSellRounds, with an alert]');
  bot.CFG.sellRetries = 1;
  bot.ops.sell = async () => { throw new Error('rpc down'); };
  bot.positions.set('FFF', mkPos('FFF', 100));
  for (let i = 0; i < bot.CFG.maxFailedSellRounds; i++) {
    const p = bot.positions.get('FFF');
    if (!p) break;
    await bot.closePosition(p, 'TAKE PROFIT');
  }
  ok(!bot.positions.has('FFF'), 'position dropped after the final failed round');
  bot.CFG.sellRetries = 6;

  console.log('\n[time limits and the tick backup]]'.replace(']]', ']'));
  sells = [];
  bot.ops.sell = sellLands;
  ok(bot.CFG.snipeMaxHoldSec === 90, 'snipe hold limit defaults to 90s');
  bot.positions.set('SNOLD', mkPos('SNOLD', 100, { kind: 'snipe', openedAt: Date.now() - 91000 }));
  bot.positions.set('SNNEW', mkPos('SNNEW', 100, { kind: 'snipe', openedAt: Date.now() - 80000 }));
  bot.positions.set('GGD', mkPos('GGD', 100, { openedAt: Date.now() - (bot.CFG.devMaxHoldSec + 5) * 1000 }));
  bot.positions.set('GGN', mkPos('GGN', 100));
  bot.positions.set('MISSED', mkPos('MISSED', 100, { lastMc: targetMc + 1 })); // price update seen, trade event missed
  bot.tick();
  await sleep(1000);
  const sold = sells.map((x) => x.m);
  ok(sold.includes('SNOLD'), 'snipe older than 90s is sold');
  ok(!sold.includes('SNNEW'), 'snipe at 80s is left alone');
  ok(sold.includes('GGD'), `dev position sold after the ${bot.CFG.devMaxHoldSec}s hold limit`);
  ok(!sold.includes('GGN'), 'a fresh dev position is left alone');
  ok(sold.includes('MISSED'), 'tick() sells on take profit from the last known price');
  bot.positions.delete('SNNEW');
  bot.positions.delete('GGN');

  console.log('\n[baseline: first price seen becomes the entry]');
  sells = [];
  bot.positions.set('HHH', mkPos('HHH', null));
  bot.onTrade({ mint: 'HHH', marketCapSol: 50 });
  ok(bot.positions.get('HHH').entryMc === 50, 'entry baseline set from first trade');
  bot.onTrade({ mint: 'HHH', marketCapSol: 50 * (1 + TP / 100) });
  await sleep(1000);
  ok(sells.length === 1 && sells[0].m === 'HHH', `then sells once +${TP}% from that baseline`);

  console.log('\n[sell parameters: dev vs snipe, escalating on retries]');
  const d1 = bot.sellParams('dev', 1), d3 = bot.sellParams('dev', 3), d5 = bot.sellParams('dev', 5);
  ok(d1.slippage === 30 && near(d1.priorityFee, 0.0003), 'dev attempt 1: 30% slippage, 0.0003 SOL fee');
  ok(d3.slippage === 50 && near(d3.priorityFee, 0.0009), 'dev attempt 3: 50% slippage, 0.0009 SOL fee');
  ok(d5.slippage === 55 && near(d5.priorityFee, 0.0015), 'dev attempt 5: slippage capped at 55%');
  const s1 = bot.sellParams('snipe', 1), s4 = bot.sellParams('snipe', 4);
  ok(s1.slippage === 40 && near(s1.priorityFee, 0.0006), 'snipe attempt 1: 40% slippage, 0.0006 SOL fee');
  ok(s4.slippage === 65, 'snipe attempt 4: slippage capped at 65%');

  console.log('\n[request bodies sent to the trade API]');
  const sentBodies = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => { sentBodies.push(JSON.parse(opts.body)); return { status: 500, text: async () => 'stub' }; };
  try { await bot.sellAllTx('MINT', 1, 'dev'); } catch { /* expected */ }
  try { await bot.sellAllTx('MINT', 1, 'snipe'); } catch { /* expected */ }
  try { await bot.buyTx('MINT', 0.033); } catch { /* expected */ }
  global.fetch = origFetch;
  ok(sentBodies[0].action === 'sell' && sentBodies[0].amount === '100%', 'sells ask for 100% of the balance');
  ok(sentBodies[0].slippage === 30 && sentBodies[1].slippage === 40, 'dev and snipe sells use their own slippage');
  ok(sentBodies[2].action === 'buy' && sentBodies[2].slippage === 15 && near(sentBodies[2].priorityFee, 0.0003), 'snipe buy: 15% slippage, 0.0003 SOL fee');

  console.log('\n[snipe market-cap filter]');
  ok(bot.CFG.snipeMinMcUsd === 4000, 'default minimum market cap is $4,000');
  bot.ops.solPrice = async () => 150;
  ok((await bot.snipeMcCheck(28)).ok === true, '28 SOL x $150 = $4,200 passes');
  const low = await bot.snipeMcCheck(20);
  ok(low.ok === false && /below/.test(low.reason), '20 SOL x $150 = $3,000 is rejected');
  bot.CFG.snipeMaxMcUsd = 5000;
  ok((await bot.snipeMcCheck(40)).ok === false, 'a maximum can be set: $6,000 is rejected at a $5,000 cap');
  bot.CFG.snipeMaxMcUsd = 0;
  bot.ops.solPrice = async () => 0;
  const noPrice = await bot.snipeMcCheck(28);
  ok(noPrice.ok === false && /unavailable/.test(noPrice.reason), 'fails closed when the SOL price is unknown');
  bot.CFG.snipeMinMcUsd = 0;
  ok((await bot.snipeMcCheck(5)).ok === true, 'filter off: everything passes, no price needed');
  bot.CFG.snipeMinMcUsd = 4000;

  console.log('\n[snipe entry applies the filter]');
  bot.ops.solPrice = async () => 150;
  const bought = [];
  bot.ops.buy = async (m, amt) => { bought.push({ m, amt }); return 'BUYSIG'; };
  bot.CFG.snipeOthers = true;
  const launch = (mint, mc, devBuy) => bot.onNewToken({ txType: 'create', mint, symbol: mint, solAmount: devBuy, marketCapSol: mc, traderPublicKey: 'someone-else' });
  await launch('SN1', 28, 2);
  await launch('SN2', 20, 2);   // mc too low
  await launch('SN3', 28, 0.5); // dev buy too small
  bot.CFG.snipeOthers = false;
  await launch('SN4', 28, 2);   // sniping off
  ok(bought.length === 1 && bought[0].m === 'SN1', 'only the launch that passes both filters is bought');
  ok(bot.positions.get('SN1') && bot.positions.get('SN1').kind === 'snipe', 'the bought coin is tracked as a snipe');
  bot.positions.delete('SN1');

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

  console.log('\n[balance shown with dollars in brackets]');
  bot.ops.solPrice = async () => 180;
  ok((await bot.fmtBal(0.5)) === '0.5000 SOL ($90.00)', 'format is 0.5000 SOL ($90.00)');
  bot.ops.solPrice = async () => 0;
  ok((await bot.fmtBal(0.5)) === '0.5000 SOL', 'falls back to SOL only when there is no price');
  ok((await bot.fmtBal(null)) === '?', 'unknown balance shows ?');

  console.log('\n[SOL price lookup and fallback]');
  global.fetch = async (url) => {
    if (/coingecko/.test(url)) return { ok: true, json: async () => ({ solana: { usd: 150 } }) };
    throw new Error('blocked');
  };
  bot.resetSolPrice();
  ok((await bot.getSolUsd()) === 150, 'CoinGecko price is used');
  bot.resetSolPrice();
  global.fetch = async (url) => {
    if (/binance/.test(url)) return { ok: true, json: async () => ({ price: '151.20' }) };
    throw new Error('blocked');
  };
  ok((await bot.getSolUsd()) === 151.2, 'falls back to Binance when CoinGecko fails');
  bot.resetSolPrice();
  global.fetch = async () => { throw new Error('down'); };
  ok((await bot.getSolUsd()) === 0, 'returns 0 when every source fails');
  global.fetch = origFetch;

  console.log('\n[random image pool]');
  const imgServer = http.createServer((req, res) => {
    if (req.url.startsWith('/ok')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from([137, 80, 78, 71])); }
    if (req.url.startsWith('/text')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('not an image'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r2) => imgServer.listen(0, '127.0.0.1', r2));
  const base = `http://127.0.0.1:${imgServer.address().port}`;
  ok(bot.parseUrls('x https://a.com/1.png\nhttp://b.com/2.jpg junk ftp://c.com/3 https://a.com/1.png').length === 2, 'parseUrls keeps http(s) links, drops junk and duplicates');
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
  bot.positions.clear();
  bot.positions.set('M1', mkPos('M1', 100));
  bot.positions.set('M2', mkPos('M2', 200, { kind: 'snipe' }));
  bot.CFG.snipeMinMcUsd = 5000;
  bot.persistPositions(); bot.persistNames(); bot.persistImages(); bot.persistRuntime();
  await bot.flush();
  const savedPos = await bot.store.get('positions');
  ok(Array.isArray(savedPos) && savedPos.length === 2, 'positions saved');
  ok((await bot.store.get('names'))[0].symbol === 'AAA', 'names saved');
  ok((await bot.store.get('images'))[0] === 'https://img.example/a.png', 'image links saved');
  bot.CFG.snipeMinMcUsd = 1;
  await bot.loadState();
  ok(bot.CFG.snipeMinMcUsd === 5000, 'market-cap filter setting survives a restart');
  bot.positions.clear();
  bot.ops.tokenBalance = async (m) => (m === 'M1' ? 7 : 0);
  const r = await bot.restorePositions(savedPos);
  ok(r.restored === 1 && r.dropped === 1, 'restore keeps held tokens and drops already-sold ones');
  ok(bot.positions.get('M1').entryMc === 100, 'entry baseline survives the restart');
  await bot.flush();

  console.log('\n[persistence: Supabase REST (mock server)]');
  const rows = new Map();
  let sawPrefer = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/rest/v1/bot_state' || req.headers.apikey !== 'test-key') { res.writeHead(401); return res.end('{}'); }
    if (req.method === 'GET') {
      const k = (u.searchParams.get('key') || '').replace(/^eq\./, '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(rows.has(k) ? [{ value: rows.get(k) }] : []));
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { sawPrefer = req.headers.prefer || ''; const j = JSON.parse(body); rows.set(j.key, j.value); res.writeHead(201); res.end(); });
  });
  await new Promise((r2) => server.listen(0, '127.0.0.1', r2));
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  bot.positions.set('M1', mkPos('M1', 100));
  bot.setQueue([{ name: 'Sup Coin', symbol: 'SUP', used: true }]);
  bot.setImages(['https://img.example/sup.png']);
  bot.persistImages(); bot.persistNames(); bot.persistPositions(); bot.persistRuntime();
  await bot.flush();
  ok(rows.size === 4, `four rows upserted: names, images, positions, runtime (${rows.size})`);
  ok(/merge-duplicates/.test(sawPrefer), 'uses upsert (merge-duplicates)');
  bot.setImages([]);
  const lp = await bot.loadState();
  ok(Array.isArray(lp) && lp.length === 1 && lp[0].mint === 'M1', 'loadState returns saved positions');
  ok(bot.getImages()[0] === 'https://img.example/sup.png', 'image links restored from Supabase');
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
