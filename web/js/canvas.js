// The canvas program's records, calls and events, and the coin actions that
// pay for them (SPEC.md; Ting wiki: programs/coin).
import { concat, framed, fromUtf8, Reader, u128, u64, utf8, Writer } from './bytes.js';
import { H } from './ting.js';
import { head } from './tcr.js';

export const TILE = 16;
export const WEEK_BYTES = 137;
export const TITLE_MAX = 100;

/** The program's templates (TCR-1) but the paint's, which names the palette's colors. */
export const TEMPLATES = {
  bid: 'bid(week:u64): Bid {payment} for the canvas of week {week}',
  list: 'list(week:u64,price:amount): Offer the canvas of week {week} for sale at {price}',
  unlist: 'unlist(week:u64): Take the canvas of week {week} off sale',
  buy: 'buy(week:u64): Buy the canvas of week {week} for {payment}',
  give: 'give(week:u64,to:account): Give the canvas of week {week} to {to}',
  name: 'name(week:u64,title:text): Call the canvas of week {week} {title}',
  unname: 'unname(week:u64): Remove the name of the canvas of week {week}',
};

/** The paint's template, as the program builds it from its colors' names. */
export const paintTemplate = (names) =>
  `paint(week:u64,pixels:list(x:u16,y:u16,color:enum(${names.join('|')}),doublings:u8)): ` +
  'On the canvas of week {week}, paint {pixels} pixels, burning {payment}';

/** A canvas's templates, by operation. */
export const templatesOf = (config) => ({ paint: config.paintTemplate, ...TEMPLATES });

/** The operations an owner does, which an account with a delay may schedule. */
export const OWNER_CALLS = ['list', 'unlist', 'give', 'name', 'unname'];

// ---- Records ---------------------------------------------------------------

export const CONFIG_KEY = new Uint8Array(32);

export function weekKey(kind, week) {
  const key = new Uint8Array(32);
  key[0] = kind;
  key.set(u64(week), 1);
  return key;
}

export const recordKey = (week) => weekKey(2, week);
export const titleKey = (week) => weekKey(3, week);

export function tileKey(week, tile) {
  const key = weekKey(1, week);
  key[9] = tile & 0xff;
  key[10] = tile >> 8;
  return key;
}

export function decodeConfig(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== 1) throw new Error('unknown canvas version');
  const config = {
    coin: r.id(),
    epoch: Number(r.u64()),
    period: Number(r.u64()),
    width: r.u16(),
    height: r.u16(),
    price: r.u128(),
    auction: Number(r.u64()),
    extension: Number(r.u64()),
    reserve: r.u128(),
    palette: [],
    names: [],
  };
  const colors = r.u8();
  for (let i = 0; i < colors; i++) {
    config.palette.push([r.u8(), r.u8(), r.u8()]);
    config.names.push(fromUtf8(r.bytes()));
  }
  r.end();
  config.paintTemplate = paintTemplate(config.names);
  config.tilesX = config.width / TILE;
  config.tiles = config.tilesX * (config.height / TILE);
  return config;
}

export function decodeWeek(bytes) {
  if (!bytes) {
    return { burned: 0n, paints: 0n, pixels: 0n, bid: 0n, bidder: new Uint8Array(32), end: 0, owner: new Uint8Array(32), price: 0n, settled: false };
  }
  const r = new Reader(bytes);
  const week = {
    burned: r.u128(),
    paints: r.u64(),
    pixels: r.u64(),
    bid: r.u128(),
    bidder: r.id(),
    end: Number(r.u64()),
    owner: r.id(),
    price: r.u128(),
    settled: r.u8() === 1,
  };
  r.end();
  return week;
}

export function decodeTitle(bytes) {
  try {
    return bytes ? fromUtf8(bytes) : '';
  } catch {
    return '';
  }
}

/**
 * The colors and marks of a week's canvas from its tile records, in order. A
 * mark is 0 for a pixel never painted, else 1 more than the level it was
 * last painted at.
 */
export function decodeTiles(config, values) {
  const colors = new Uint8Array(config.width * config.height);
  const marks = new Uint8Array(config.width * config.height);
  values.forEach((tile, t) => {
    if (!tile || tile.length !== 512) return;
    const x0 = (t % config.tilesX) * TILE, y0 = Math.floor(t / config.tilesX) * TILE;
    for (let i = 0; i < 256; i++) {
      const at = (y0 + (i >> 4)) * config.width + x0 + (i & 15);
      colors[at] = tile[i];
      marks[at] = tile[256 + i];
    }
  });
  return { colors, marks };
}

// ---- Prices ----------------------------------------------------------------

/** What a paint at `level` burns for one pixel: the price × 2^level. */
export const levelCost = (config, level) => config.price << BigInt(level);

/** The least level a pixel takes: twice what is on it, or the price on a fresh one. */
export const leastLevel = (mark) => mark;

/**
 * `[index, color, level]` for a draft of `[index, color]` pairs: each pixel at
 * the least level it may take, plus `boost` doublings to protect it.
 */
export function levelsFor(marks, draft, boost = 0) {
  const after = new Map();
  return draft.map(([index, color]) => {
    const level = Math.min(254, leastLevel(after.get(index) ?? marks[index]) + boost);
    after.set(index, level + 1);
    return [index, color, level];
  });
}

export const priceOf = (config, pixels) => pixels.reduce((sum, [, , level]) => sum + levelCost(config, level), 0n);

// ---- Time ------------------------------------------------------------------

/** The week a timestamp falls in, counted from 1, or 0 before the first. */
export const weekAt = (config, now) => (now < config.epoch ? 0 : Math.floor((now - config.epoch) / config.period) + 1);
export const opens = (config, week) => config.epoch + (week - 1) * config.period;
export const closes = (config, week) => config.epoch + week * config.period;
export const auctionEnds = (config, week, record) => record.end || closes(config, week) + config.auction;

/**
 * Where a week stands: `painting`, `auction` (bids taken), `waiting` (the
 * auction ended without a bid and takes the first), `won` (over, the winner
 * not yet settled) or `owned`.
 */
export function stage(config, week, record, now) {
  if (now < closes(config, week)) return 'painting';
  if (record.settled) return 'owned';
  if (now < auctionEnds(config, week, record)) return 'auction';
  return record.bid > 0n ? 'won' : 'waiting';
}

/** Who owns the canvas, a winner whose auction is over included. */
export function ownerOf(config, week, record, now) {
  const s = stage(config, week, record, now);
  if (s === 'owned') return record.owner;
  if (s === 'won') return record.bidder;
  return null;
}

export const minimumBid = (config, record) =>
  record.bid === 0n ? config.reserve : record.bid + (record.bid / 20n > 0n ? record.bid / 20n : 1n);

// ---- Calls -----------------------------------------------------------------

function call(kind, values, template = TEMPLATES[kind]) {
  return { kind, template, values, head: head(template, values) };
}

/** Paints `[index, color, level]` pixels, `index = y × width + x`; a pixel's `doublings` is its level. */
export function paintCall(config, week, pixels) {
  const w = new Writer().u64(week).u64(pixels.length);
  for (const [index, color, level] of pixels) w.u16(index % config.width).u16(Math.floor(index / config.width)).u8(color).u8(level);
  return call('paint', w.finish(), config.paintTemplate);
}

/** A bid and a buy name only the week: their amount is the payment's. */
export const bidCall = (week) => call('bid', u64(week));
export const listCall = (week, coin, price) => call('list', concat(u64(week), coin, u128(price)));
export const unlistCall = (week) => call('unlist', u64(week));
export const buyCall = (week) => call('buy', u64(week));
export const giveCall = (week, to) => call('give', concat(u64(week), to));
export const nameCall = (week, title) => call('name', concat(u64(week), framed(utf8(title))));
export const unnameCall = (week) => call('unname', u64(week));

/** The week a call's values name, their first field in every template. */
export const weekOfCall = (values) => new Reader(values).u64();

export const settleInput = (week) => new Writer().u8(3).u64(week).finish();
export const eventTopic = (week) => H('app/canvas-v1/event', u64(week));

const KINDS = ['', 'paint', 'bid', 'settled', 'listed', 'sold', 'given', 'titled'];

/** An event of the canvas's own; a paint's pixels as `[index, color, level]` on a canvas `width` wide. */
export function decodeEvent(payload, width) {
  const r = new Reader(payload);
  r.take(32);
  const kind = KINDS[r.u8()] ?? 'unknown';
  const e = { kind };
  switch (kind) {
    case 'paint': {
      e.account = r.id();
      e.amount = r.u128();
      const n = Number(r.u64());
      e.pixels = [];
      for (let i = 0; i < n; i++) {
        const x = r.u16(), y = r.u16();
        e.pixels.push([y * width + x, r.u8(), r.u8()]);
      }
      break;
    }
    case 'bid':
      e.account = r.id(); e.amount = r.u128(); e.end = Number(r.u64());
      break;
    case 'settled':
    case 'listed':
      e.account = r.id(); e.amount = r.u128();
      break;
    case 'sold':
      e.from = r.id(); e.account = r.id(); e.amount = r.u128();
      break;
    case 'given':
      e.from = r.id(); e.account = r.id();
      break;
    case 'titled':
      e.account = r.id(); e.title = decodeTitle(r.bytes());
      break;
  }
  return e;
}

// ---- The coin ----------------------------------------------------------------

export function decodeCoin(bytes) {
  const r = new Reader(bytes);
  r.u8();
  const name = fromUtf8(r.bytes()), symbol = fromUtf8(r.bytes()), decimals = r.u8();
  return { name, symbol, decimals };
}

/** `balance u128 ‖ locked u128 ‖ nonce u64`; absent is all zero. */
export function decodeCoinAccount(bytes) {
  if (!bytes) return { balance: 0n, locked: 0n, nonce: 0n, available: 0n };
  const r = new Reader(bytes);
  const balance = r.u128(), locked = r.u128(), nonce = r.u64();
  return { balance, locked, nonce, available: balance - locked };
}

export const burnEffect = (amount) => concat(Uint8Array.of(2), u128(amount));
export const transferEffect = (to, amount) => concat(Uint8Array.of(1), to, u128(amount));

// ---- Amounts ---------------------------------------------------------------

export function formatAmount(amount, decimals, maxFraction = decimals) {
  const negative = amount < 0n;
  const v = negative ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const fraction = (v % unit).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  const text = whole.toLocaleString('en-US') + (fraction ? '.' + fraction : '');
  return (negative ? '−' : '') + text;
}

/** An amount as a call link writes it: decimal with a dot, no grouping. */
export const linkAmount = (amount, decimals) => formatAmount(amount, decimals).replace(/,/g, '');

/** Base units of a decimal amount such as `12.5`, or null. */
export function parseAmount(text, decimals) {
  const m = String(text).trim().replace(/[,_\s]/g, '').match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (m[1] === '' && !m[2])) return null;
  if ((m[2] ?? '').length > decimals) return null;
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}
