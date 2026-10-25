#!/usr/bin/env node
// A development chain for Ting Canvas, on a node made by `ting init --dev`
// with REST and CORS on, and mining:
//
//   node scripts/devchain.mjs setup   deploys policy-p256, the identity registry,
//                                     a test coin with a faucet, and a canvas
//                                     (--period, --auction, --extension in
//                                     seconds, --side in pixels)
//   node scripts/devchain.mjs canvas  deploys another canvas on the test coin
//   node scripts/devchain.mjs fund <account> <amount>
//                                     sends test coins from the faucet
//   node scripts/devchain.mjs e2e     runs a canvas's whole life with real
//                                     signatures: the page's own P-256 wallets,
//                                     and an identity whose savings account
//                                     schedules and cancels (TCR-1)
//
// --node URL picks the node (http://127.0.0.1:28441), --state FILE where the
// ids and the faucet's key are kept (.devchain.json).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { concat, equal, Reader, utf8, Writer } from '../web/js/bytes.js';
import * as C from '../web/js/canvas.js';
import * as tcr from '../web/js/tcr.js';
import { contractAccount } from '../web/js/ting.js';
import { Wallet } from '../web/js/wallet.js';
import { Chain, canvasConfig, hex, identity, read, unhex } from './chain.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const nodeUrl = option('node', 'http://127.0.0.1:28441');
const statePath = option('state', '.devchain.json');
const [command, ...rest] = args;

const DLR = 100_000_000n;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until the chain's tip is at least `t` in block time, which miners set and is not the clock. */
async function waitForChain(t, what) {
  console.log(`     waiting for ${what}…`);
  for (;;) {
    const tip = await chain.node.block((await chain.node.status()).tip);
    if (tip.timestamp >= t) return;
    await sleep(1000);
  }
}

const chain = await Chain.open(nodeUrl);
if (chain.chainHex !== '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc') {
  throw new Error(`${nodeUrl} is not on the development chain`);
}

function loadState() {
  if (!existsSync(statePath)) throw new Error(`no ${statePath}: run setup first`);
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

async function setup() {
  const policy = await chain.deploy(read('../ting-reference/programs/policy-p256.wasm'), new Uint8Array());
  if (!equal(policy, chain.policy)) throw new Error('policy-p256 is not where the page expects it');
  console.log(`policy-p256  ${hex(policy)}`);
  const registry = await chain.deploy(read('../ting-reference/programs/id-registry.wasm'), new Uint8Array());
  console.log(`id-registry  ${hex(registry)}`);

  const faucet = await Wallet.generate();
  const coinInput = new Writer().u8(1).bytes(utf8('Daler')).bytes(utf8('DLR')).u8(8)
    .u128((1n << 128n) - 1n).u128(0n).u64(0n).u128(0n).put(new Uint8Array(32)) // no cap, rewards or minter
    .u64(1).put(faucet.account(chain.policy)).u128(1_000_000n * DLR).finish();
  const coin = await chain.deploy(read('../ting-reference/programs/coin.wasm'), coinInput, [50_000_000, 66, 16_777_216, 16_777_216]);
  console.log(`coin         ${hex(coin)}   (DLR, 1,000,000 to the faucet)`);
  writeFileSync(statePath, JSON.stringify({ coin: hex(coin), registry: hex(registry), faucet: faucet.jwk }, null, 2));
  await newCanvas();
}

/** A canvas on the test coin, its week 1 open since a minute ago. */
async function newCanvas() {
  const state = loadState();
  const period = Number(option('period', 3600));
  const config = canvasConfig({
    coin: unhex(state.coin),
    epoch: now() - 60,
    period,
    side: Number(option('side', 64)),
    price: DLR / 10_000n,
    auction: Number(option('auction', period / 2)),
    extension: Number(option('extension', 60)),
    reserve: DLR / 100n,
  });
  const target = await chain.deploy(read('canvas.wasm'), config);
  console.log(`canvas       ${hex(target)}   (weeks of ${period} s)`);
  console.log(`\nOpen the page with ?node=${encodeURIComponent(nodeUrl)}&canvas=${hex(target)}`);
}

async function fund(accountHex, amountText) {
  const state = loadState();
  const faucet = (await Wallet.fromJwk(state.faucet)).signer(chain.policy);
  const amount = C.parseAmount(amountText, 8);
  const r = await chain.transfer(faucet, unhex(state.coin), unhex(accountHex), amount);
  if (r.status !== 0) throw new Error(`transfer failed: ${r.reason}`);
  console.log(`sent ${amountText} DLR to ${accountHex} in block ${r.height}`);
}

/**
 * A canvas with weeks of 90 seconds: painted by browser wallets and by an
 * identity's spending account, auctioned, given to the identity's savings
 * account, offered for sale from there after the savings delay, sold, named
 * and given away.
 */
async function e2e() {
  const state = loadState();
  const coin = unhex(state.coin);
  const registry = unhex(state.registry);
  const faucet = (await Wallet.fromJwk(state.faucet)).signer(chain.policy);
  const alice = (await Wallet.generate()).signer(chain.policy);
  const bob = (await Wallet.generate()).signer(chain.policy);
  const SAVINGS_DELAY = 20;
  const carolId = identity(registry, chain.policy, await Wallet.generate(), [0, SAVINGS_DELAY]);
  const [spending, savings] = [carolId.slot(0), carolId.slot(1)];
  const costs = [];
  const check = (label, r, expect = 'success') => {
    const ok = expect === 'success' ? r.status === 0 : r.status === 1 && r.reason === expect;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${r.status ? ` (reverted: ${r.reason})` : ''}`);
    if (!ok) throw new Error(`${label}: expected ${expect}, got status ${r.status} ${r.reason}`);
    if (r.status === 0) costs.push([label, r.used]);
  };
  const assert = (label, condition) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) throw new Error(label);
  };

  check('create carol’s identity: spending, and savings with a 20 s delay', await chain.call(registry, carolId.create));
  for (const [who, signer] of [['alice', alice], ['bob', bob], ['carol’s spending', spending]]) {
    check(`fund ${who}`, await chain.transfer(faucet, coin, signer.account, 10n * DLR));
  }

  const period = 90, auction = 30, extension = 10;
  const config = canvasConfig({ coin, epoch: now() - 2, period, side: 32, price: DLR / 1000n, auction, extension, reserve: DLR / 10n });
  const target = await chain.deploy(read('canvas.wasm'), config);
  const cfg = C.decodeConfig(await chain.node.record(target, C.CONFIG_KEY));
  console.log(`canvas ${hex(target)}, weeks of ${period} s`);
  const listed = tcr.decodeTemplateList(await chain.node.record(target, tcr.TEMPLATES_KEY));
  assert('the program lists its templates, the paint’s with the palette’s names', listed.size === 8
    && Object.values(C.templatesOf(cfg)).every((t) => listed.get(hex(tcr.templateHash(t))) === t)
    && cfg.paintTemplate.includes('enum(white|light gray|gray|black|pink|red|'));
  for (const t of listed.values()) tcr.parseTemplate(t);
  const op = (signer, call, effect) => chain.operate(signer, target, coin, call, effect);
  const signed = (signer, call) => chain.operate(signer, target, coin, call, null);
  const vault = contractAccount(target);
  const week = async () => {
    const values = await chain.node.storage([[target, C.recordKey(1)], ...Array.from({ length: cfg.tiles }, (_, t) => [target, C.tileKey(1, t)])]);
    return { record: C.decodeWeek(values[0]), ...C.decodeTiles(cfg, values.slice(1)) };
  };

  check('week 0 does not exist', await op(alice, C.paintCall(cfg, 0n, [[0, 1, 0]]), C.burnEffect(cfg.price)), 'bad input');
  let w = await week();
  const pixels = C.levelsFor(w.marks, [[0, 5], [1, 8], [33, 12]]);
  check('alice paints 3 fresh pixels', await op(alice, C.paintCall(cfg, 1n, pixels), C.burnEffect(C.priceOf(cfg, pixels))));
  w = await week();
  assert('the pixels are on the canvas', w.colors[0] === 5 && w.colors[1] === 8 && w.colors[33] === 12 && w.marks[0] === 1);
  assert('alice burned 3 prices', (await chain.funds(coin, alice.account)).balance === 10n * DLR - 3n * cfg.price);
  check('bob painting over pixel 0 at its own level is refused', await op(bob, C.paintCall(cfg, 1n, [[0, 3, 0]]), C.burnEffect(cfg.price)), 'price too low');
  const over = C.levelsFor(w.marks, [[0, 3]]);
  check('bob paints over it for twice what is on it', await op(bob, C.paintCall(cfg, 1n, over), C.burnEffect(C.priceOf(cfg, over))));
  const guarded = C.levelsFor(w.marks, [[5, 13]], 2);
  check('carol’s spending account paints a pixel protected ×4', await op(spending, C.paintCall(cfg, 1n, guarded), C.burnEffect(C.priceOf(cfg, guarded))));
  w = await week();
  assert('the week has burned 3 + 2 + 4 prices', w.record.burned === 9n * cfg.price && w.colors[0] === 3 && w.marks[0] === 2 && w.marks[5] === 3);

  const closes = C.closes(cfg, 1);
  check('a bid while painting is refused', await op(alice, C.bidCall(1n), C.transferEffect(vault, cfg.reserve)), 'still painting');
  await waitForChain(closes, 'the canvas to lock');
  check('painting a locked canvas is refused', await op(alice, C.paintCall(cfg, 1n, [[2, 1, 0]]), C.burnEffect(cfg.price)), 'canvas locked');
  check('alice bids the reserve', await op(alice, C.bidCall(1n), C.transferEffect(vault, cfg.reserve)));
  const outbid = C.minimumBid(cfg, (await week()).record);
  check('carol’s spending account outbids by 5%', await op(spending, C.bidCall(1n), C.transferEffect(vault, outbid)));
  assert('alice has her bid back', (await chain.funds(coin, alice.account)).balance === 10n * DLR - 3n * cfg.price);
  assert('the program holds carol’s bid', (await chain.funds(coin, vault)).balance === outbid);

  const ends = (await week()).record.end;
  await waitForChain(ends, 'the auction to end');
  check('alice cannot give away what carol won', await signed(alice, C.giveCall(1n, alice.account)), 'not owner');
  check('carol gives it to her savings account, settling the auction', await signed(spending, C.giveCall(1n, savings.account)));
  w = await week();
  assert('her savings account owns it, her bid burned', w.record.settled && equal(w.record.owner, savings.account) && (await chain.funds(coin, vault)).balance === 0n);

  check('savings cannot pay, so it cannot paint', await signed(savings, C.paintCall(cfg, 1n, [[3, 1, 0]])), 'needs payment');
  check('savings offers it for 1 DLR: scheduled by its delay', await signed(savings, C.listCall(1n, coin, DLR)));
  assert('nothing changes before it runs', (await week()).record.price === 0n);
  check('a run before it is due is refused', await chain.call(target, tcr.runCall(savings.account, 0n)), 'not due');
  check('savings schedules a gift to bob too', await signed(savings, C.giveCall(1n, bob.account)));
  const cancel = await tcr.cancelCall({ signer: savings, chain: chain.chain, program: target, sequences: [1n] });
  check('carol cancels the gift with one signature', await chain.call(target, cancel));
  const scheduled = [], done = [];
  for (const [topic, list] of [[tcr.SCHEDULED, scheduled], [tcr.CANCELLED, done]]) {
    for (const block of (await chain.node.events(target, topic)).items) {
      for (const e of block.events) {
        const r = new Reader(unhex(e.payload_hex));
        r.take(32);
        list.push(topic === tcr.SCHEDULED ? tcr.decodeScheduled(r) : { account: r.id(), sequence: r.u64() });
      }
    }
  }
  assert('the scheduled events name the operations', scheduled.length === 2
    && equal(scheduled[0].head, C.listCall(1n, coin, DLR).head) && equal(scheduled[1].head, C.giveCall(1n, bob.account).head)
    && equal(scheduled[0].account, savings.account));
  const record = await chain.node.record(target, tcr.scheduledKey(savings.account, 0n));
  assert('the scheduled record holds when it runs and what it does', record
    && new Reader(record).u64() === BigInt(scheduled[0].executeAt) && equal(record.subarray(8), scheduled[0].head));
  assert('the cancelled one has no record', !(await chain.node.record(target, tcr.scheduledKey(savings.account, 1n))));
  assert('the cancelled event names the gift', done.length === 1 && done[0].sequence === 1n);

  const due = scheduled[0].executeAt;
  await waitForChain(due, 'the savings delay');
  check('anyone runs the offer once due', await chain.call(target, tcr.runCall(savings.account, 0n)));
  check('the cancelled gift cannot run', await chain.call(target, tcr.runCall(savings.account, 1n)), 'not scheduled');
  assert('it is for sale for 1 DLR', (await week()).record.price === DLR);
  check('alice buys it for 1 DLR', await op(alice, C.buyCall(1n), C.transferEffect(savings.account, DLR)));
  assert('carol’s savings account was paid', (await chain.funds(coin, savings.account)).balance === DLR);
  const before = (await chain.funds(coin, alice.account)).balance;
  const named = await chain.operate(alice, target, coin, C.nameCall(1n, 'First light'), tcr.feeEffect(target), 1000n);
  check('alice names it, approved by a fee payment', named);
  // The fee goes to the block's payout account, or stays when it has none.
  const moved = before - (await chain.funds(coin, alice.account)).balance;
  const zero = concat(unhex('59a929440b7f57a03cad176d225f75a76507f929ccd0248732ce032573ec6dd9'), alice.account, vault, new Uint8Array(16));
  assert('the fee payment moved nothing but the fee: a transfer of 0 to the canvas',
    (moved === 0n || moved === 1000n) && (await chain.funds(coin, vault)).balance === 0n
    && (named.events ?? []).some((e) => e.payload_hex === hex(zero)));
  check('alice gives it to bob', await signed(alice, C.giveCall(1n, bob.account)));
  w = await week();
  assert('bob owns it', equal(w.record.owner, bob.account) && w.record.price === 0n);
  assert('its title is kept', C.decodeTitle(await chain.node.record(target, C.titleKey(1))) === 'First light');

  const events = [];
  for (const block of (await chain.node.events(target, C.eventTopic(1))).items) {
    for (const e of block.events) events.push(C.decodeEvent(unhex(e.payload_hex), cfg.width));
  }
  assert('the first paint event names its pixels', JSON.stringify(events[0].pixels) === JSON.stringify(pixels));
  const kinds = events.map((e) => e.kind).join();
  assert(`the week’s events tell it all: ${kinds}`, kinds === 'paint,paint,paint,bid,bid,settled,given,listed,sold,titled,given');

  console.log('\nWhat each step used, with real signatures:');
  for (const [label, [c, s, d, g]] of costs) {
    console.log(`  ${label.padEnd(62)} ${c.toLocaleString().padStart(11)} C ${String(s).padStart(4)} S ${String(d).padStart(6)} D ${String(g).padStart(6)} G`);
  }
}

if (command === 'setup') await setup();
else if (command === 'canvas') await newCanvas();
else if (command === 'fund') await fund(...rest);
else if (command === 'e2e') await e2e();
else {
  console.error('usage: node scripts/devchain.mjs setup | canvas | fund <account> <amount> | e2e  [--node URL] [--state FILE]');
  process.exit(2);
}
