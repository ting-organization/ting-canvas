// What the scripts share: a node, its chain, deployments, plain coin transfers,
// identities, and the canvas's calls, all through the web page's own modules,
// so the page's encodings and signatures are the ones exercised.
import { readFileSync } from 'node:fs';
import { concat, framed, fromUtf8, hex, u64, unhex, utf8, Writer } from '../web/js/bytes.js';
import * as canvas from '../web/js/canvas.js';
import { POLICY_P256 } from '../web/js/config.js';
import * as tcr from '../web/js/tcr.js';
import { deployedId, encodeCall, encodeDeploy, H, Node, policyAccount, transactionId } from '../web/js/ting.js';

const root = new URL('..', import.meta.url);
export const read = (path) => new Uint8Array(readFileSync(new URL(path, root)));

/** The canonical deployment budget of the reference programs (Ting wiki: programs). */
export const DEPLOY_BUDGET = [50_000_000, 64, 16_777_216, 16_777_216];
const CALL_BUDGET = [100_000_000, 2048, 2_000_000, 1_000_000];

/** The r/place 2017 sixteen: white first, which every pixel starts as. */
/** The colors, each with the name a wallet shows for it in the paint's template. */
export const PALETTE = [
  ['ffffff', 'white'], ['e4e4e4', 'light gray'], ['888888', 'gray'], ['222222', 'black'],
  ['ffa7d1', 'pink'], ['e50000', 'red'], ['e59500', 'orange'], ['a06a42', 'brown'],
  ['e5d900', 'yellow'], ['94e044', 'lime'], ['02be01', 'green'], ['00d3dd', 'cyan'],
  ['0083c7', 'blue'], ['0000ea', 'dark blue'], ['cf6ee4', 'magenta'], ['820080', 'purple'],
];

/** The canvas deployment input (SPEC.md, deployment). */
export function canvasConfig({ coin, epoch, period, side, price, auction, extension, reserve, palette = PALETTE }) {
  const w = new Writer().u8(1).put(coin).u64(epoch).u64(period).u16(side).u16(side)
    .u128(price).u64(auction).u64(extension).u128(reserve).u8(palette.length);
  for (const [rgb, name] of palette) w.put(unhex(rgb)).bytes(utf8(name));
  return w.finish();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An identity of the reference registry with one P-256 key, `wallet`'s, and a
 * slot for each delay; its slots as TCR-1 signers (wiki: programs/identity).
 */
export function identity(registry, policyP256, wallet, delays, salt = crypto.getRandomValues(new Uint8Array(32))) {
  const w = new Writer().u8(1).u64(1).put(policyP256).bytes(wallet.publicKey)
    .u64(0).u64(0).u64(600).u64(300).u64(delays.length);
  for (const d of delays) w.u64(d);
  const creation = w.put(salt).finish();
  const id = H('app/id-v1/id', creation);
  const slot = (n) => {
    const params = concat(id, u64(n));
    return {
      policy: registry,
      params,
      account: policyAccount(registry, params),
      witness: async (message) => concat(u64(0), framed(await wallet.sign(message))),
    };
  };
  return { id, create: concat(Uint8Array.of(1), creation), slot };
}

export class Chain {
  static async open(url) {
    const chain = new Chain();
    chain.node = new Node(url);
    const status = await chain.node.status();
    chain.chainHex = status.chain_id;
    chain.chain = unhex(status.chain_id);
    chain.policy = unhex(POLICY_P256[chain.chainHex]);
    return chain;
  }

  /**
   * Submits a transaction and returns the receipt of its next occurrence. The
   * same bytes can be included again, as an unsigned run or settle often is,
   * so the occurrences already there are skipped.
   */
  async submit(tx, seconds = 120) {
    const before = await this.node.occurrences(transactionId(this.chain, tx));
    const id = await this.node.submit(tx);
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      const answer = await this.node.transaction(id, before).catch(() => null);
      const seen = answer?.occurrences?.[0];
      if (seen) return { ...seen.receipt, id, height: seen.height, reason: reason(seen.receipt) };
    }
    throw new Error(`transaction ${id} not in a block after ${seconds} s`);
  }

  /** Deploys `code`, or finds the identical deployment already there. */
  async deploy(code, input, budget = DEPLOY_BUDGET) {
    const tx = encodeDeploy(code, input, budget);
    const id = deployedId(this.chain, tx);
    if (await this.node.contract(id).catch(() => null)) return id;
    const r = await this.submit(tx);
    if (r.status !== 0) throw new Error(`deployment failed: ${r.status_name} ${r.reason}`);
    return id;
  }

  async funds(coin, account) {
    return canvas.decodeCoinAccount(await this.node.record(coin, account));
  }

  /** A plain transfer from `signer`, bound to nothing. */
  async transfer(signer, coin, to, amount) {
    const { nonce } = await this.funds(coin, signer.account);
    const action = new Writer().put(canvas.transferEffect(to, amount)).u128(0n).u128(0n).u64(0n).u64(0n).u8(0).finish();
    const message = new Writer().bytes(utf8('app/coin-v1')).put(this.chain).put(coin).put(signer.account)
      .u8(0x10).u64(nonce).put(action).finish();
    const witness = await signer.witness(message);
    const input = new Writer().u8(0x10).u8(0).put(signer.policy).bytes(signer.params).u64(nonce)
      .bytes(witness).put(action).finish();
    return this.submit(encodeCall(coin, input, CALL_BUDGET));
  }

  /** An operation `signer` signs, with its nonce in the canvas, and a payment of `effect` if any. */
  async operate(signer, target, coin, call, effect, fee = 0n) {
    const nonce = decodeNonce(await this.node.record(target, tcr.nonceKey(signer.account)));
    const payment = effect && { coin, coinNonce: (await this.funds(coin, signer.account)).nonce, effect, fee };
    const input = await tcr.signCall({
      signer, chain: this.chain, program: target, nonce, head: call.head, payment,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    return this.call(target, input);
  }

  async call(target, input) {
    return this.submit(encodeCall(target, input, CALL_BUDGET));
  }
}

const decodeNonce = (bytes) => (bytes ? new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true) : 0n);

function reason(receipt) {
  try {
    return fromUtf8(unhex(receipt.result_hex));
  } catch {
    return receipt.result_hex;
  }
}

export { hex, unhex };
