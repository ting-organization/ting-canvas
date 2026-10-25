#!/usr/bin/env node
// Writes docs/tcr-1-vectors.json, TCR-1's shared test vectors, from the page's
// own modules: templates and their hashes, values and their decoding,
// messages and digests, the call bytes of each kind of approval, compressed
// values, template lists, scheduled operations, cancels and links. Every
// refused vector is checked to be refused here before it is written, and the
// canvas program's tests check the hashes and the canvas's list in Rust.
//
//   node scripts/tcr-vectors.mjs [--check]
//
// With --check it writes nothing, and fails if the file differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { concat, framed, hex, u64, unhex, utf8, Writer } from '../web/js/bytes.js';
import * as C from '../web/js/canvas.js';
import * as tcr from '../web/js/tcr.js';
import { contractAccount, H, policyAccount } from '../web/js/ting.js';
import { canvasConfig } from './chain.mjs';

const path = new URL('../docs/tcr-1-vectors.json', import.meta.url);
const fill = (byte, n = 32) => new Uint8Array(n).fill(byte);

const CHAIN = unhex('15d6549cfacd816f835c632b4c67308d1c63e642f4cbf4049368430670705107');
const PROGRAM = unhex('765a9fa0c02d1ff7bbb1bf47ece78424c3d52627811999c874afa8895b4f7fd5');
const DALER = unhex('305378d17f6af84a563d0f8a8455084948aff7330b62b4f2f98a44b82ba113c4');
const REGISTRY = unhex('1185ab4a07f12fd03e130acfd51211cd9360ec94b89e5f742bbd8f52767714bd');
const DLR = 100_000_000n;
const UNTIL = 1793000000n;
const ID = fill(0x44);
const GIVE = 'give(item:u64,to:account): Give item {item} to {to}';
const BUY = 'buy(item:u64): Buy item {item} for {payment}';
const giveValues = concat(u64(7), fill(0x11));
const buyValues = u64(7);

// ---- Checking what is written --------------------------------------------

const refused = (what, f) => {
  try {
    f();
  } catch (e) {
    return e.message;
  }
  throw new Error(`${what} was accepted`);
};

const refusedAsync = async (what, f) => {
  try {
    await f();
  } catch (e) {
    return e.message;
  }
  throw new Error(`${what} was accepted`);
};

// ---- JSON forms ----------------------------------------------------------

const typeJson = (type) => (type.list ? { list: type.list.map(fieldJson) } : type);
const fieldJson = (f) => ({ name: f.name, type: typeJson(f.type) });
const partJson = (p) => (p.payment ? { payment: true } : p.slot ? { slot: p.slot } : { text: p.text });

function valueJson(type, v) {
  if (type.enum) return v;
  if (type.list) return v.map((item) => Object.fromEntries(type.list.map((f) => [f.name, valueJson(f.type, item[f.name])])));
  if (type === 'amount') return { coin: hex(v.coin), amount: String(v.amount) };
  if (v instanceof Uint8Array) return hex(v);
  if (type === 'text') return v;
  return String(v);
}

function templateVector(name, template) {
  const t = tcr.parseTemplate(template);
  return {
    name,
    template,
    hex: hex(utf8(template)),
    T: hex(tcr.templateHash(template)),
    operation: t.operation,
    declaration: t.declaration,
    fields: t.fields.map(fieldJson),
    sentence: t.sentence.map(partJson),
  };
}

function valuesVector(name, template, values) {
  const d = tcr.decodeValues(template, values);
  return {
    name,
    template,
    values: hex(values),
    decoded: Object.fromEntries(d.template.fields.map((f) => [f.name, valueJson(f.type, d.value[f.name])])),
    operation: hex(tcr.operationHash(tcr.head(template, values))),
  };
}

// ---- Accounts --------------------------------------------------------------

/** A Ting ID slot as a signer whose witness is made up: the vectors fix encodings, not signatures. */
function slot(n, signature) {
  const params = concat(ID, u64(n));
  return {
    policy: REGISTRY,
    params,
    account: policyAccount(REGISTRY, params),
    witness: async () => new Writer().u64(1n).bytes(fill(signature, 64)).finish(),
  };
}
const spending = slot(0, 0x5a);
const savings = slot(1, 0x6b);
const stranger = (() => {
  const params = concat(fill(0x55), u64(0));
  return { policy: REGISTRY, params, account: policyAccount(REGISTRY, params) };
})();
const signerJson = (s) => ({ policy: hex(s.policy), params: hex(s.params), account: hex(s.account) });

// ---- Templates -------------------------------------------------------------

const PALETTE = [
  ['ffffff', 'white'], ['e4e4e4', 'light gray'], ['888888', 'gray'], ['222222', 'black'],
  ['ffa7d1', 'pink'], ['e50000', 'red'], ['e59500', 'orange'], ['a06a42', 'brown'],
  ['e5d900', 'yellow'], ['94e044', 'lime'], ['02be01', 'green'], ['00d3dd', 'cyan'],
  ['0083c7', 'blue'], ['0000ea', 'dark blue'], ['cf6ee4', 'magenta'], ['820080', 'purple'],
];
const canvasDeployment = canvasConfig({
  coin: DALER, epoch: 1793577600, period: 604800, side: 128, price: 1000n,
  auction: 604800, extension: 3600, reserve: DLR / 100n, palette: PALETTE,
});
const canvas = C.decodeConfig(canvasDeployment);
const canvasTemplates = Object.values(C.templatesOf(canvas));
const ALL = 'kinds(a:u8,b:u16,c:u32,d:u64,e:u128,f:amount,g:coin,h:account,i:bytes32,j:time,k:duration,l:text,m:bytes,'
  + 'n:enum(no|yes),o:list(p:u16,q:enum(left|right),r:text)): {a} {b} {c} {d} {e} {f} {g} {h} {i} {j} {k} {l} {m} {n} {o}';
const LONGEST = (() => {
  const head = 'note(text:text): ';
  return head + 'x'.repeat(512 - head.length - '{text}'.length) + '{text}';
})();

const templates = [
  templateVector('give, the example', GIVE),
  templateVector('buy, the example, showing the payment', BUY),
  templateVector('give in German: the same declaration, another sentence', 'give(item:u64,to:account): Gib Gegenstand {item} an {to}'),
  templateVector('no fields, only the payment', 'ping(): Ping, paying {payment}'),
  templateVector('a field shown twice', 'twice(n:u32): {n}, and again {n}'),
  templateVector('every type', ALL),
  templateVector('labels with spaces and letters beyond ASCII', 'pick(c:enum(rouge|bleu clair|vert d’eau)): Choisir {c} — café'),
  templateVector('exactly 512 bytes', LONGEST),
  ...canvasTemplates.map((t) => templateVector(`the canvas: ${tcr.parseTemplate(t).operation}`, t)),
];

const refusedTemplates = [
  ['a field the sentence never shows', 'give(item:u64,to:account): Give item {item}'],
  ['a slot it does not declare', 'give(item:u64): Give item {item} to {to}'],
  ['a slot differing in case', 'give(item:u64): Give item {Item}'],
  ['a field declared twice', 'give(item:u64,item:u8): Give item {item}'],
  ['a field named payment', 'pay(payment:u64): Pay {payment}'],
  ['a list in a list', 'nest(a:list(b:list(c:u8))): {a}'],
  ['an empty list', 'nest(a:list()): {a}'],
  ['a list field declared twice', 'nest(a:list(x:u8,x:u16)): {a}'],
  ['an empty label', 'pick(a:enum(x||y)): {a}'],
  ['a label repeated', 'pick(a:enum(x|x)): {a}'],
  ['a label starting with white space', 'pick(a:enum( x|y)): {a}'],
  ['a label holding a colon', 'pick(a:enum(x:y|z)): {a}'],
  ['a type it does not know', 'count(a:u7): {a}'],
  ['white space in the declaration', 'count(a: u8): {a}'],
  ['an operation name with a capital', 'Give(a:u8): {a}'],
  ['a name of 33 characters', `give(${'a'.repeat(33)}:u8): {${'a'.repeat(33)}}`],
  ['no space after the declaration', 'give(a:u8):{a}'],
  ['no sentence', 'give(a:u8): '],
  ['a brace outside a slot', 'give(a:u8): {a} }'],
  ['an empty slot', 'give(a:u8): {a} {}'],
  ['white space at the start', ' give(a:u8): {a}'],
  ['white space at the end', 'give(a:u8): {a} '],
  ['a line break', 'give(a:u8): {a}\nand more'],
  ['a code point that hides text, U+200B', 'give(a:u8): {a}​'],
  ['a code point that reorders text, U+202E', 'give(a:u8): {a} ‮evil'],
  ['not in Normalization Form C', 'give(a:u8): Café {a}'],
  ['513 bytes', LONGEST.replace('note(', 'notes(')],
].map(([name, template]) => ({ name, template, hex: hex(utf8(template)), refused: refused(name, () => tcr.parseTemplate(template)) }));

// ---- Values ------------------------------------------------------------------

const allValues = new Writer().u8(255).u16(65535).u32(4294967295).u64(18446744073709551615n)
  .u128(340282366920938463463374607431768211455n).put(DALER).u128(25n * DLR).put(DALER).put(fill(0x11)).put(fill(0xab))
  .u64(1793000000n).u64(604800n).bytes(utf8('Première lumière ☀')).bytes(Uint8Array.of(0, 1, 2)).u8(1)
  .u64(2n).u16(3).u8(0).bytes(utf8('')).u16(4).u8(1).bytes(utf8('two'))
  .finish();
const paintValues = C.paintCall(canvas, 1n, [[0, 3, 0], [128 * 5 + 9, 13, 2]]).values;

const values = [
  valuesVector('give item 7 to 11…11', GIVE, giveValues),
  valuesVector('buy item 7: the price is the payment, not a value', BUY, buyValues),
  valuesVector('no values', 'ping(): Ping, paying {payment}', new Uint8Array()),
  valuesVector('every type, at its largest where it has one', ALL, allValues),
  valuesVector('the canvas: paint two pixels, one protected ×4', canvas.paintTemplate, paintValues),
  valuesVector('an empty text', 'name(week:u64,title:text): Call the canvas of week {week} {title}', concat(u64(1), framed(new Uint8Array()))),
];

const NAME = 'name(week:u64,title:text): Call the canvas of week {week} {title}';
const named = (bytes) => concat(u64(1), framed(bytes));
const refusedValues = [
  ['a byte short', GIVE, giveValues.subarray(0, 39)],
  ['a byte after the last field', GIVE, concat(giveValues, Uint8Array.of(0))],
  ['an enum index past its last label', 'pick(c:enum(rouge|bleu clair|vert d’eau)): Choisir {c} — café', Uint8Array.of(3)],
  ['a list count that cannot fit in the bytes left', canvas.paintTemplate, concat(u64(1), u64(1n << 62n), new Uint8Array(6))],
  ['a text that is not UTF-8', NAME, named(Uint8Array.of(0x66, 0xff))],
  ['a text in an overlong UTF-8 form', NAME, named(Uint8Array.of(0xc0, 0xaf))],
  ['a text with U+200B', NAME, named(utf8('First​light'))],
  ['a text not in Normalization Form C', NAME, named(utf8('Café'))],
  ['a text starting with white space', NAME, named(utf8(' First light'))],
  ['a text with a line break', NAME, named(utf8('First\nlight'))],
  ['a text longer than its bytes', NAME, concat(u64(1), Uint8Array.of(9, 0, 0, 0), utf8('First'))],
].map(([name, template, bytes]) => ({ name, template, values: hex(bytes), refused: refused(name, () => tcr.decodeValues(template, bytes)) }));

// ---- Operations, messages, calls --------------------------------------------

function operationVector(name, template, vals, account, nonce, validUntil) {
  const head = tcr.head(template, vals);
  const { message, digest } = tcr.callMessage({ chain: CHAIN, program: PROGRAM, account, nonce, validUntil, head });
  return {
    name, template, values: hex(vals), account: hex(account), nonce: String(nonce), valid_until: String(validUntil),
    T: hex(tcr.templateHash(template)), operation: hex(tcr.operationHash(head)), message: hex(message), digest: hex(digest),
  };
}

const operations = [
  operationVector('give, the example', GIVE, giveValues, fill(0x22), 0n, UNTIL),
  operationVector('buy, the example', BUY, buyValues, fill(0x22), 1n, UNTIL),
  operationVector('the canvas: paint, by a Ting ID’s Spending account', canvas.paintTemplate, paintValues, spending.account, 3n, UNTIL),
];

/** The coin's half of a payment, as tcr.signCall builds it, laid out for reading. */
function paymentParts({ signer, digest, coinNonce, effect, fee, validUntil }) {
  const action = new Writer().put(effect).u128(fee).u128(0n).u64(0n).u64(validUntil).u8(1).put(PROGRAM).put(digest).finish();
  const message = new Writer().bytes(utf8('app/coin-v1')).put(CHAIN).put(DALER).put(signer.account)
    .u8(0x10).u64(coinNonce).put(action).finish();
  return { action, message, digest: H('app/sign-v1', message) };
}

async function callVector(name, kind, template, vals, signer, nonce, pay) {
  const head = tcr.head(template, vals);
  if (kind === 'program') {
    const caller = fill(0x77);
    return {
      name, kind, template, values: hex(vals), caller: hex(caller), account: hex(contractAccount(caller)),
      call: hex(concat(head, Uint8Array.of(1, 0))),
      executed: hex(concat(tcr.EXECUTED, contractAccount(caller), u64(0), tcr.operationHash(head))),
    };
  }
  const { message, digest } = tcr.callMessage({ chain: CHAIN, program: PROGRAM, account: signer.account, nonce, validUntil: UNTIL, head });
  const payment = pay && { coin: DALER, coinNonce: 4n, effect: pay, fee: 100_000n };
  const call = await tcr.signCall({ signer, chain: CHAIN, program: PROGRAM, nonce, validUntil: UNTIL, head, payment });
  const v = {
    name, kind, template, values: hex(vals), ...signerJson(signer), nonce: String(nonce), valid_until: String(UNTIL),
    message: hex(message), digest: hex(digest), witness: hex(payment ? new Uint8Array() : await signer.witness()),
  };
  if (payment) {
    const coin = paymentParts({ signer, digest, coinNonce: payment.coinNonce, effect: pay, fee: payment.fee, validUntil: UNTIL });
    const coinWitness = await signer.witness();
    v.payment = {
      coin: hex(DALER), coin_nonce: String(payment.coinNonce), effect: hex(pay), fee: String(payment.fee),
      action: hex(coin.action), coin_message: hex(coin.message), coin_digest: hex(coin.digest), coin_witness: hex(coinWitness),
      coin_input: hex(new Writer().u8(0x10).u8(0).put(signer.policy).bytes(signer.params).u64(payment.coinNonce)
        .bytes(coinWitness).put(coin.action).finish()),
    };
  }
  v.call = hex(call);
  if (payment && !v.call.endsWith(v.payment.coin_input)) throw new Error(`${name}: the call does not end in its coin input`);
  return v;
}

// The spec's own example values (TCR-1, example).
const SPEC = {
  give: ['136b3686867293c0763efe081477ede6d5b6f4d4c92cbbf3744b9a1932b9b3e8', 'b0ea3fb7ceacdd8246d27aba4b87381b1273b90fe58bb4d917d235ae9d805084', '2af209f9f7928bac0254bcf9e40c60d0f74fdf6f77de71df567c1a0db6450ee3'],
  buy: ['f7b7c40915e60615bd017682423d2b9b680faf3dc52d1748f8969cff8c22b2fe', '806780c812e173d3c30d947e04c8a454a569d6998e1b5a19e92a3f36e95cead3', '65c295a6077b636553d933b06a3c21042cf9b366db00ac6680a924d388bca8e5'],
};
for (const [i, which] of [[0, 'give'], [1, 'buy']]) {
  const o = operations[i];
  if ([o.T, o.operation, o.digest].join() !== SPEC[which].join()) throw new Error(`the ${which} example does not match TCR-1`);
}

const calls = [
  await callVector('give, approved by the witness over digest', 'witness', GIVE, giveValues, spending, 0n, null),
  await callVector('buy, approved by its payment: 25 DLR to 33…33', 'payment', BUY, buyValues, spending, 1n, C.transferEffect(fill(0x33), 25n * DLR)),
  await callVector('the canvas: paint, approved by its burn', 'payment', canvas.paintTemplate, paintValues, spending, 3n, C.burnEffect(5n * 1000n)),
  await callVector('give, approved by its fee payment, which pays the miner', 'fee', GIVE, giveValues, spending, 0n, tcr.feeEffect(PROGRAM)),
  await callVector('give, by the calling program’s account', 'program', GIVE, giveValues),
];

/**
 * A call with a payment, laid out by hand: for calls a program must refuse,
 * each breaking one rule of a fee payment (TCR-1, fee payments).
 */
function handCall({ template = GIVE, vals = giveValues, coin = DALER, effect = tcr.feeEffect(PROGRAM), payer = spending, witness = new Uint8Array(), boundNonce = 0n, count = 1 }) {
  const head = tcr.head(template, vals);
  const { digest } = tcr.callMessage({ chain: CHAIN, program: PROGRAM, account: spending.account, nonce: boundNonce, validUntil: UNTIL, head });
  const action = new Writer().put(effect).u128(100_000n).u128(0n).u64(0n).u64(UNTIL).u8(1).put(PROGRAM).put(digest).finish();
  const coinInput = new Writer().u8(0x10).u8(0).put(payer.policy).bytes(payer.params).u64(4n)
    .bytes(new Writer().u64(1n).bytes(fill(0x5a, 64)).finish()).put(action).finish();
  const w = new Writer().put(head).u8(0).put(spending.policy).bytes(spending.params).u64(0n).u64(UNTIL).bytes(witness).u8(count);
  for (let i = 0; i < count; i++) w.put(coin).bytes(coinInput);
  return hex(w.finish());
}
if (handCall({}) !== calls[3].call) throw new Error('the hand-made fee payment differs from signCall’s');
const refusedCalls = [
  ['a fee payment in a coin the program does not take', 'bad coin', { coin: fill(0x77) }],
  ['a transfer of 1 to the program’s account', 'not a fee payment', { effect: C.transferEffect(contractAccount(PROGRAM), 1n) }],
  ['a transfer of 0 to another account', 'not a fee payment', { effect: C.transferEffect(fill(0x33), 0n) }],
  ['a burn of 0', 'not a fee payment', { effect: C.burnEffect(0n) }],
  ['a fee payment from another account than the acting one', 'payer is not the actor', { payer: stranger }],
  ['a fee payment beside a witness', 'witness with a payment', { witness: new Writer().u64(1n).bytes(fill(0x5a, 64)).finish() }],
  ['a fee payment bound to the same operation with another nonce', 'not bound', { boundNonce: 1n }],
  ['two payments', 'more than one payment', { count: 2 }],
  ['a fee payment for a template that shows {payment}', 'not the payment its template shows', { template: BUY, vals: buyValues }],
].map(([name, rule, o]) => ({ name, rule, template: o.template ?? GIVE, values: hex(o.vals ?? giveValues), call: handCall(o) }));

// ---- Compressed values ---------------------------------------------------------

const packed = await tcr.packValues(giveValues);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const stored = concat(Uint8Array.of(1, giveValues.length, 0, ~giveValues.length & 0xff, 0xff), giveValues);
const zeros = async (n) => b64(await tcr.packValues(new Uint8Array(n)));
const zvalues = [
  { name: 'the give example’s values', zvalues: b64(packed), values: hex(giveValues) },
  { name: 'the same values in a stored block: any DEFLATE stream that ends exactly is good', zvalues: b64(stored), values: hex(giveValues) },
  { name: 'exactly 65,536 zero bytes, the most allowed', zvalues: await zeros(65536), unpacked_length: 65536 },
  { name: '65,537 zero bytes', zvalues: await zeros(65537), refused: 'unpacks past 65,536 bytes' },
  { name: 'a byte after the compressed data', zvalues: b64(concat(packed, Uint8Array.of(0))), refused: 'bytes after the compressed data' },
  { name: 'cut short', zvalues: b64(packed.subarray(0, packed.length - 1)), refused: 'does not end' },
  { name: 'with zlib framing', zvalues: b64(concat(Uint8Array.of(0x78, 0x9c), packed)), refused: 'not raw DEFLATE' },
];
for (const z of zvalues) {
  const bytes = Buffer.from(z.zvalues, 'base64url');
  if (z.refused) await refusedAsync(z.name, () => tcr.unpackValues(bytes));
  else {
    const out = await tcr.unpackValues(bytes);
    if (z.values ? hex(out) !== z.values : out.length !== z.unpacked_length) throw new Error(`${z.name}: unpacked wrong`);
  }
}
if (b64(packed) !== 'Y2eAAEECAAA') throw new Error('the example’s zvalues changed');

// ---- Template lists ------------------------------------------------------------

const listBytes = (texts, count = texts.length) => {
  const w = new Writer().u64(BigInt(count));
  for (const t of texts) w.bytes(typeof t === 'string' ? utf8(t) : t);
  return w.finish();
};
const GERMAN = 'give(item:u64,to:account): Gib Gegenstand {item} an {to}';
const OTHER_GIVE = 'give(item:u64,to:bytes32): Give item {item} to {to}';
const templateLists = {
  key: hex(tcr.TEMPLATES_KEY),
  lists: [
    { name: 'the example program’s list', templates: [GIVE, BUY], hex: hex(listBytes([GIVE, BUY])) },
    { name: 'give in two languages, sharing one declaration', templates: [GIVE, GERMAN, BUY], hex: hex(listBytes([GIVE, GERMAN, BUY])) },
    { name: 'the canvas, deployed with the configuration below', templates: canvasTemplates, hex: hex(listBytes(canvasTemplates)) },
  ],
  refused: [
    { name: 'a count above the templates it holds', hex: hex(listBytes([GIVE, BUY], 3)), rule: 'malformed' },
    { name: 'a byte after the last template', hex: hex(concat(listBytes([GIVE, BUY]), Uint8Array.of(0))), rule: 'malformed' },
    { name: 'a template that is not UTF-8', hex: hex(listBytes([GIVE, Uint8Array.of(0x66, 0xff)])), rule: 'malformed' },
    { name: 'a template listed twice', hex: hex(listBytes([GIVE, GIVE])), rule: 'each template once' },
    {
      name: 'give with two declarations: refused for a link with either',
      hex: hex(listBytes([GIVE, OTHER_GIVE])), link_template: GIVE, rule: 'one declaration per operation name',
    },
  ],
};
for (const l of templateLists.lists) {
  const list = tcr.decodeTemplateList(unhex(l.hex));
  for (const t of l.templates) tcr.checkListed(list, t);
}
for (const l of templateLists.refused) {
  l.refused = refused(l.name, () => tcr.checkListed(tcr.decodeTemplateList(unhex(l.hex)), l.link_template ?? GIVE));
}

// ---- Scheduled, run, cancel ------------------------------------------------------

const executeAt = 1793086400n;
const giveHead = tcr.head(GIVE, giveValues);
const cancelSequences = [1n, 2n];
const cancelTail = new Writer().u64(BigInt(cancelSequences.length));
for (const s of cancelSequences) cancelTail.u64(s);
const tail = cancelTail.finish();
const cancelMessage = new Writer().bytes(utf8('app/call-v1')).put(CHAIN).put(PROGRAM).put(savings.account)
  .u8(2).u64(UNTIL).put(tail).finish();
const cancelInput = await tcr.cancelCall({ signer: savings, chain: CHAIN, program: PROGRAM, validUntil: UNTIL, sequences: cancelSequences });
const scheduled = {
  name: 'give, by a Ting ID’s Savings account, scheduled as its sequence 0',
  template: GIVE, values: hex(giveValues), ...signerJson(savings), sequence: '0', execute_at: String(executeAt),
  key: hex(tcr.scheduledKey(savings.account, 0n)),
  record: hex(concat(u64(executeAt), giveHead)),
  event: hex(concat(tcr.SCHEDULED, savings.account, u64(0), u64(executeAt), giveHead)),
  run: hex(tcr.runCall(savings.account, 0n)),
  executed: hex(concat(tcr.EXECUTED, savings.account, u64(0), tcr.operationHash(giveHead))),
};
const cancel = {
  name: 'the Savings account cancels its sequences 1 and 2',
  ...signerJson(savings), valid_until: String(UNTIL), sequences: cancelSequences.map(String),
  message: hex(cancelMessage), digest: hex(H('app/sign-v1', cancelMessage)), witness: hex(await savings.witness()),
  input: hex(cancelInput),
  cancelled: cancelSequences.map((s) => hex(concat(tcr.CANCELLED, savings.account, u64(s)))),
};

// ---- Links -------------------------------------------------------------------------

const base = (template, rest = '') =>
  `ting:call?net=${hex(CHAIN).slice(0, 8)}&program=${hex(PROGRAM)}&template=${encodeURIComponent(template)}${rest}`;
const giveLink = base(GIVE, `&values=${b64(giveValues)}`);
const buyLink = base(BUY, `&values=${b64(buyValues)}&coin=${hex(DALER)}&to=${'33'.repeat(32)}&amount=25`);
const made = await tcr.callLink({ chainHex: hex(CHAIN), program: PROGRAM, template: GIVE, values: giveValues });
const linkJson = async (name, link) => {
  const f = await tcr.readLink(link);
  const out = { name, link, template: f.template, values: hex(f.valueBytes) };
  for (const k of ['coin', 'burn', 'to', 'amount', 'from', 'delayed', 'return']) if (f[k] != null) out[k] = f[k];
  return out;
};
const links = [
  await linkJson('give, the example', giveLink),
  await linkJson('give, its values compressed, as a page makes it', made),
  await linkJson('buy, the example, paying 25 DLR to 33…33', buyLink),
  await linkJson('give, naming the coin the program takes fee payments in, from 22…22, for accounts with a delay too',
    `${giveLink}&coin=${hex(DALER)}&from=${'22'.repeat(32)}&delayed=1`),
  await linkJson('give from 22…22, for accounts with a delay, back to the page once sent',
    `${giveLink}&from=${'22'.repeat(32)}&delayed=1&return=${encodeURIComponent('https://canvas.example/app/?week=12')}`),
  await linkJson('read without regard to case, a // after the scheme, an unknown field ignored',
    `TING://CALL?NET=${hex(CHAIN).slice(0, 8)}&Program=${hex(PROGRAM)}&TEMPLATE=${encodeURIComponent(GIVE)}&Values=${b64(giveValues)}&note=hello`),
  await linkJson('the canvas: paint, burning, back to a page on the user’s own computer',
    base(canvas.paintTemplate, `&values=${b64(paintValues)}&coin=${hex(DALER)}&burn=0.00005&return=${encodeURIComponent('http://localhost:8765/?canvas=1')}`)),
];
if (!made.includes('&zvalues=')) throw new Error('the page no longer compresses the example');

const refusedLinks = [];
const refuse = async (name, link) => refusedLinks.push({ name, link, refused: await refusedAsync(name, () => tcr.readLink(link)) });
await refuse('values and zvalues both', `${giveLink}&zvalues=${b64(packed)}`);
await refuse('a field given twice', `${giveLink}&values=${b64(giveValues)}`);
await refuse('a template that shows {payment}, without a payment', base(BUY, `&values=${b64(buyValues)}`));
await refuse('a burn for a template that does not show {payment}', `${giveLink}&coin=${hex(DALER)}&burn=1`);
await refuse('a transfer for a template that does not show {payment}', `${giveLink}&coin=${hex(DALER)}&to=${'33'.repeat(32)}&amount=1`);
await refuse('a payment without its coin', base(BUY, `&values=${b64(buyValues)}&burn=1`));
await refuse('a burn and a transfer together', `${buyLink}&burn=1`);
await refuse('a transfer without its amount', base(BUY, `&values=${b64(buyValues)}&coin=${hex(DALER)}&to=${'33'.repeat(32)}`));
await refuse('an amount of 0', base(BUY, `&values=${b64(buyValues)}&coin=${hex(DALER)}&burn=0.000`));
await refuse('an amount with a comma', base(BUY, `&values=${b64(buyValues)}&coin=${hex(DALER)}&burn=1,5`));
await refuse('an amount ending in its dot', base(BUY, `&values=${b64(buyValues)}&coin=${hex(DALER)}&burn=1.`));
await refuse('an amount starting with its dot', base(BUY, `&values=${b64(buyValues)}&coin=${hex(DALER)}&burn=.5`));
await refuse('delayed on a link with a payment', `${buyLink}&delayed=1`);
await refuse('delayed other than 1', `${giveLink}&delayed=true`);
await refuse('a return over http to another computer', `${giveLink}&return=${encodeURIComponent('http://canvas.example/')}`);
await refuse('a return holding a #', `${giveLink}&return=${encodeURIComponent('https://canvas.example/#/week/1')}`);
await refuse('a return that is not an address', `${giveLink}&return=canvas`);
await refuse('a template that does not percent-decode', base(GIVE).replace('%3A', '%E0%A4%A') + `&values=${b64(giveValues)}`);
await refuse('values with bits left over', base(GIVE, `&values=${b64(giveValues).slice(0, -1)}R`));
await refuse('values with padding', base(BUY, `&values=${b64(buyValues)}=&coin=${hex(DALER)}&burn=1`));
await refuse('a net of 7 hex digits', giveLink.replace(`net=${hex(CHAIN).slice(0, 8)}`, `net=${hex(CHAIN).slice(0, 7)}`));
await refuse('a template that breaks the rules', base('give(item:u64,to:account): Give item {item}', `&values=${b64(giveValues)}`));
await refuse('zvalues with a byte after the compressed data', base(GIVE, `&zvalues=${b64(concat(packed, Uint8Array.of(0)))}`));
// The values decode only against the template, which readLink leaves to the wallet.
for (const l of refusedLinks) if (!l.refused) throw new Error(l.name);
refused('values one byte short', () => tcr.decodeValues(GIVE, giveValues.subarray(1)));

// ---- The file ------------------------------------------------------------------------

const tags = Object.fromEntries([
  ['H("app/call-v1/templates", "")', tcr.TEMPLATES_KEY],
  ['H("app/call-v1/events", ""), reserved', H('app/call-v1/events')],
  ['H("app/call-v1/nonce", 22…22)', tcr.nonceKey(fill(0x22))],
  ['H("app/call-v1/scheduled", 22…22 ‖ u64 0)', tcr.scheduledKey(fill(0x22), 0n)],
  ['H("app/call-v1/run", "")', tcr.RUN],
  ['H("app/call-v1/cancel", "")', tcr.CANCEL],
  ['H("app/call-v1/event/scheduled", "")', tcr.SCHEDULED],
  ['H("app/call-v1/event/executed", "")', tcr.EXECUTED],
  ['H("app/call-v1/event/cancelled", "")', tcr.CANCELLED],
].map(([k, v]) => [k, hex(v)]));

const SPEC_TAGS = ['5e5d1a485b7c790dcadf931959467bda642e5f8c3eeee945a96118174c033979', '50207d6c72473695fffef8ac61aa353828d0926461c21a66996ea9ee79779fd1',
  '74a2fd2e9de861c7950a320ae9c7c93ad113aac470fce95024686743a3a2e77f', '5d42b569802462ea7155e42210db5ac79ef8f3f8d5963f986ac4b8f206b266a2',
  '8381accdf4b5f2fda7f3211ce6165cf75c5d2c1c83d9363a6eff54cba06f9ebf', '3f4e28d529bca5fb7098e7de868051f09d317a85db389bdef290706058b1df07',
  '87b120eab58d69a8ae3ace1fbac076394efc796c00464fcd19347c06291d2ec4', '5bc6659722a5f453391ecbdcc33d6226929eab184053f32e7f87863c6d07bcc2',
  'a87b8224d37e671d5a6793b35c1c8c6737e4a1dd7e2feeb683ba197652bc547e'];
if (Object.values(tags).join() !== SPEC_TAGS.join()) throw new Error('the fixed values do not match TCR-1');
if (giveLink !== 'ting:call?net=15d6549c&program=765a9fa0c02d1ff7bbb1bf47ece78424c3d52627811999c874afa8895b4f7fd5&template=give(item%3Au64%2Cto%3Aaccount)%3A%20Give%20item%20%7Bitem%7D%20to%20%7Bto%7D&values=BwAAAAAAAAAREREREREREREREREREREREREREREREREREREREREREQ') {
  throw new Error('the give link does not match TCR-1');
}

const vectors = {
  about: 'Test vectors for TCR-1, Ting Call Requests (TCR-1.md), generated by ting-canvas/scripts/tcr-vectors.mjs from the canvas page’s JavaScript and checked by the canvas program’s Rust tests. Bytes are lowercase hex, base64url where a link carries it; integers in values, nonces and times are decimal strings. Witnesses and signatures are made up: the vectors fix encodings, not keys. An entry with `refused` must be refused; its text is this implementation’s reason, for reading only.',
  chain_id: hex(CHAIN),
  program: hex(PROGRAM),
  coin: hex(DALER),
  id_registry: hex(REGISTRY),
  tags,
  templates,
  refused_templates: refusedTemplates,
  values,
  refused_values: refusedValues,
  operations,
  calls,
  refused_calls: refusedCalls,
  zvalues,
  template_lists: templateLists,
  canvas: {
    about: 'The canvas program’s deployment input with sixteen named colors, and the template list it stores: the paint template names the colors as an enum.',
    deployment: hex(canvasDeployment),
    template_list: hex(listBytes(canvasTemplates)),
  },
  scheduled,
  cancel,
  links,
  refused_links: refusedLinks,
};

const text = `${JSON.stringify(vectors, null, 1)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== text) {
    console.error('docs/tcr-1-vectors.json is not what the page’s modules make');
    process.exit(1);
  }
  console.log('docs/tcr-1-vectors.json matches');
} else {
  writeFileSync(path, text);
  console.log(`wrote docs/tcr-1-vectors.json: ${templates.length} templates, ${refusedTemplates.length} refused, ${values.length} values, ${refusedValues.length} refused, ${calls.length} calls, ${links.length} links, ${refusedLinks.length} refused`);
}
