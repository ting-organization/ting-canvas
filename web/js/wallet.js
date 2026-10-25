// The painting wallet: one P-256 key kept in this browser, an account of the
// reference policy-p256 (Ting wiki: programs/policies). The browser's own
// WebCrypto signs. Its ECDSA hashes what it signs with SHA-256, and Ting's
// signing digest is `H("app/sign-v1", message)`, SHA-256 of a fixed prefix and
// the message: so signing `prefix ‖ message` signs exactly the digest the
// policy checks, and the page needs no cryptography library.
import { concat, hex, unhex } from './bytes.js';
import { hashPrefix, policyAccount } from './ting.js';

const STORE = 'ting-canvas/wallet-v1';
const SIGN_PREFIX = hashPrefix('app/sign-v1');
/** The order of P-256. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };

export const cryptoAvailable = () => Boolean(globalThis.crypto?.subtle);

export class Wallet {
  constructor(privateKey, publicKey, jwk) {
    this.privateKey = privateKey;
    /** 65 bytes, uncompressed: the policy params. */
    this.publicKey = publicKey;
    this.jwk = jwk;
  }

  /** A new key, not kept anywhere yet. */
  static async generate() {
    const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
    return Wallet.fromJwk(await crypto.subtle.exportKey('jwk', pair.privateKey));
  }

  /** A new key, kept in this browser. */
  static async create() {
    const wallet = await Wallet.generate();
    wallet.save();
    return wallet;
  }

  static async fromJwk(jwk) {
    if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
      throw new Error('not a P-256 private key');
    }
    const { kty, crv, x, y, d } = jwk;
    const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d, ext: true }, ALGORITHM, true, ['sign']);
    const verify = await crypto.subtle.importKey('jwk', { kty, crv, x, y, ext: true }, ALGORITHM, true, ['verify']);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', verify));
    return new Wallet(privateKey, publicKey, { kty, crv, x, y, d });
  }

  /** The wallet this browser keeps, if any. */
  static async load() {
    let text = null;
    try {
      text = localStorage.getItem(STORE);
    } catch {
      return null;
    }
    return text ? Wallet.fromJwk(JSON.parse(text)) : null;
  }

  save() {
    localStorage.setItem(STORE, JSON.stringify(this.jwk));
  }

  static forget() {
    localStorage.removeItem(STORE);
  }

  /** A backup to keep: the private key, as JSON. */
  backup() {
    return JSON.stringify({ kind: 'ting-canvas-wallet', version: 1, policy: 'policy-p256', key: this.jwk }, null, 2);
  }

  static async restore(text) {
    const parsed = JSON.parse(text);
    const wallet = await Wallet.fromJwk(parsed.key ?? parsed);
    wallet.save();
    return wallet;
  }

  account(policy) {
    return policyAccount(policy, this.publicKey);
  }

  /** This key as a TCR-1 signer, an account of the P-256 policy `policy`. */
  signer(policy) {
    return { policy, params: this.publicKey, account: this.account(policy), witness: (message) => this.sign(message) };
  }

  /** A low-S signature `r ‖ s` over the message's signing digest. */
  async sign(message) {
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.privateKey, concat(SIGN_PREFIX, message)),
    );
    const s = BigInt('0x' + hex(signature.subarray(32)));
    if (s > N / 2n) signature.set(unhex((N - s).toString(16).padStart(64, '0')), 32);
    return signature;
  }
}
