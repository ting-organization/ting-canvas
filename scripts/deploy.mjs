#!/usr/bin/env node
// Deploys the canvas program: builds the deployment transaction and shows what
// it will create. Nothing is sent without --submit. A deployment is permanent:
// its options, prices included, can never change, and a canvas with other
// options is another deployment, with another ContractId.
//
//   node scripts/deploy.mjs                 shows the production deployment
//   node scripts/deploy.mjs --submit        sends it, and waits for a block
//
// Options, with their production defaults:
//   --node URL         https://node1.ting-node.com
//   --coin ID          Daler, 305378d1…
//   --epoch T          1792972800, Monday 26 October 2026 00:00 UTC: week 1 starts
//   --period S         604800, a week
//   --side N           128 pixels square
//   --price DLR        0.0001 for a fresh pixel
//   --auction S        604800, the auction runs through the next week
//   --extension S      3600: a bid in the last hour moves the end an hour on
//   --reserve DLR      0.01, the least first bid
import { hex } from '../web/js/bytes.js';
import * as C from '../web/js/canvas.js';
import { CODE_HASHES } from '../web/js/config.js';
import { deployedId, encodeDeploy, H } from '../web/js/ting.js';
import { Chain, canvasConfig, DEPLOY_BUDGET, PALETTE, read, unhex } from './chain.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const submit = args.includes('--submit');

const chain = await Chain.open(option('node', 'https://node1.ting-node.com'));
const coin = unhex(option('coin', '305378d17f6af84a563d0f8a8455084948aff7330b62b4f2f98a44b82ba113c4'));
const coinInfo = C.decodeCoin(await chain.node.record(coin, C.CONFIG_KEY));
const coinManifest = await chain.node.contract(coin);
if (coinManifest.code_hash !== CODE_HASHES.coin) throw new Error('that coin does not run the reference coin program');
const units = (text) => {
  const v = C.parseAmount(text, coinInfo.decimals);
  if (v == null || v === 0n) throw new Error(`not an amount: ${text}`);
  return v;
};

const options = {
  coin,
  epoch: Number(option('epoch', 1792972800)),
  period: Number(option('period', 604800)),
  side: Number(option('side', 128)),
  price: units(option('price', '0.0001')),
  auction: Number(option('auction', 604800)),
  extension: Number(option('extension', 3600)),
  reserve: units(option('reserve', '0.01')),
};
const code = read('canvas.wasm');
const codeHash = hex(H('code', code));
if (codeHash !== CODE_HASHES.canvas) throw new Error('canvas.wasm is not the program web/js/config.js expects: rebuild, or update CODE_HASHES');
const input = canvasConfig(options);
const tx = encodeDeploy(code, input, DEPLOY_BUDGET);
const id = deployedId(chain.chain, tx);
const amount = (v) => `${C.formatAmount(v, coinInfo.decimals)} ${coinInfo.symbol}`;
const days = (s) => {
  const [n, unit] = s % 86400 ? (s % 3600 ? [s, 'second'] : [s / 3600, 'hour']) : [s / 86400, 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

console.log(`Network     ${chain.chainHex}
Coin        ${coinInfo.name} (${coinInfo.symbol}) ${hex(coin)}
Week 1      ${new Date(options.epoch * 1000).toISOString()}, then every ${days(options.period)}
Canvas      ${options.side} × ${options.side} pixels, ${PALETTE.length} colors
Paint       ${amount(options.price)} a fresh pixel, twice what is on it to paint over, burned
Auction     ${days(options.auction)} after each week; reserve ${amount(options.reserve)}; a late bid extends it to ${days(options.extension)} after itself; the winning bid is burned
Program     canvas.wasm, ${code.length} bytes, CodeHash ${codeHash}
Transaction ${tx.length} bytes
ContractId  ${hex(id)}`);

if (await chain.node.contract(id).catch(() => null)) {
  console.log('\nThis deployment is already on the chain.');
} else if (!submit) {
  console.log('\nNot sent. Run again with --submit to deploy it, for good.');
} else {
  // Production blocks come minutes apart.
  const r = await chain.submit(tx, 1800);
  if (r.status !== 0) throw new Error(`deployment failed: ${r.status_name} ${r.reason}`);
  console.log(`\nDeployed in block ${r.height}.`);
}
console.log(`\nFor the page, in web/js/config.js under this network: canvas: '${hex(id)}',`);
