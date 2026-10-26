// Ting Canvas, the page: reads the chain through one node, and does the
// canvas's operations as TCR-1 call links, which Ting ID, or any wallet that
// reads them, signs and submits. The page holds no key and no coins.
import { equal, hex, Reader, unhex } from './bytes.js';
import {
  auctionEnds, bidCall, buyCall, closes, CONFIG_KEY, decodeCoin,
  decodeConfig, decodeEvent, decodeTiles, decodeTitle, decodeWeek, eventTopic, formatAmount, giveCall,
  levelCost, levelsFor, linkAmount, listCall, minimumBid, nameCall, opens, ownerOf, paintCall,
  parseAmount, priceOf, recordKey, settleInput, stage, templatesOf, tileKey, TITLE_MAX, titleKey,
  unlistCall, unnameCall, weekAt, weekOfCall,
} from './canvas.js';
import { CODE_HASHES, DEFAULT_NODE, MAX_DRAFT, NETWORKS } from './config.js';
import { css, imageOf, Painter } from './painter.js';
import { qrSvg } from './qr.js';
import {
  callLink, CANCELLED, checkListed, decodeCancelled, decodeExecuted, decodeScheduled, decodeTemplateList,
  decodeValues, EXECUTED, operationHash, runCall, SCHEDULED, TEMPLATES_KEY, textProblem,
} from './tcr.js';
import { contractAccount, encodeCall, idOf, Node, NodeError, transactionId } from './ting.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const now = () => Math.floor(Date.now() / 1000);

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const app = {
  node: null,
  chain: null,
  chainHex: '',
  network: null,
  canvas: null,
  config: null,
  /** The program's template list: each template's hash, in hex, to its text. */
  templates: null,
  coin: null,
  /** Accounts the user linked, in hex: public addresses only, to show what is theirs. */
  accounts: new Set(),
  /** What the current view does every second, when the wallet changes, and when it goes away. */
  tick: null,
  onAccounts: null,
  leave: null,
};

// ---- Formatting ------------------------------------------------------------

const amount = (v, max) => `${formatAmount(v, app.coin.decimals, max)} ${esc(app.coin.symbol)}`;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const date = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function who(account) {
  if (!account) return '—';
  const text = hex(account);
  const mine = isMine(account);
  return `<span class="account${mine ? ' mine' : ''}" title="${text}">${mine ? 'you' : `${text.slice(0, 6)}…${text.slice(-4)}`}</span>`;
}

/** A field's value as a wallet shows it (TCR-1, field types). */
function shown(type, v) {
  if (type.enum) return esc(v.label);
  if (type.list) return v.length.toLocaleString();
  if (type === 'amount') return equal(v.coin, app.config.coin) ? amount(v.amount) : `${v.amount} of the coin ${esc(hex(v.coin).slice(0, 8))}…`;
  if (type === 'account') return who(v);
  if (type === 'text') return `“${esc(v)}”`;
  if (type === 'time') return esc(date(v));
  if (type === 'duration') return esc(duration(v));
  if (type === 'bytes') return `${v.length.toLocaleString()} bytes`;
  if (v instanceof Uint8Array) return esc(hex(v));
  return esc(String(v));
}

/** An operation in its template's words, each slot shown as a wallet would, `{payment}` as `paid`. */
function sentence(template, values, paid) {
  let decoded;
  try {
    decoded = decodeValues(template, values);
  } catch {
    return `An operation this page cannot show: <code>${esc(hex(values))}</code>`;
  }
  return decoded.parts.map((p) => {
    if (p.payment) return paid == null ? 'its payment' : amount(paid);
    return p.slot ? shown(p.type, p.value) : esc(p.text);
  }).join('');
}

/** A title from the chain, or none when it breaks the text rules: nothing checks it there. */
const shownTitle = (title) => (title && !textProblem(title) ? title : '');

function toast(message, kind = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---- Reading the chain -----------------------------------------------------

async function loadWeek(week) {
  const { config } = app;
  const reads = [[app.canvas, recordKey(week)], [app.canvas, titleKey(week)]];
  for (let t = 0; t < config.tiles; t++) reads.push([app.canvas, tileKey(week, t)]);
  const values = await app.node.storage(reads);
  return {
    record: decodeWeek(values[0]),
    title: decodeTitle(values[1]),
    ...decodeTiles(config, values.slice(2)),
  };
}

/** Pages of a program's events of one topic, from height `from`, each with its block's height and time. */
async function loadTopic(topic, from = 1, decode) {
  const out = [];
  for (;;) {
    const page = await app.node.events(app.canvas, topic, from, 100);
    for (const block of page.items) {
      for (const e of block.events) {
        try {
          const r = new Reader(unhex(e.payload_hex));
          r.take(32);
          out.push({ ...decode(r, e), height: block.height, time: block.timestamp });
        } catch {
          // not one this page reads
        }
      }
    }
    if (!page.items.length || page.next > page.height) return out;
    from = page.next;
  }
}

/** Every event of a week, oldest first. */
const loadEvents = (week) =>
  loadTopic(eventTopic(week), 1, (r, e) => decodeEvent(unhex(e.payload_hex), app.config.width));

/** The operations scheduled for a week and still waiting: not run, not cancelled. */
async function loadScheduled(week) {
  const [scheduled, executed, cancelled] = await Promise.all([
    loadTopic(SCHEDULED, 1, decodeScheduled),
    loadTopic(EXECUTED, 1, decodeExecuted),
    loadTopic(CANCELLED, 1, decodeCancelled),
  ]);
  const done = new Set([...executed, ...cancelled].map((e) => `${hex(e.account)}/${e.sequence}`));
  const ours = new Set(Object.values(templatesOf(app.config)));
  return scheduled
    .map((s) => ({ ...s, template: app.templates.get(hex(s.t)) }))
    .filter((s) => {
      if (!ours.has(s.template) || done.has(`${hex(s.account)}/${s.sequence}`)) return false;
      try {
        return weekOfCall(s.values) === BigInt(week);
      } catch {
        return false;
      }
    });
}

// ---- Doing things ----------------------------------------------------------

/**
 * Submits an unsigned input, a run or a settle, which needs no wallet, and
 * follows it into a block. It gets a budget of its own each time: the same
 * bytes would be the same transaction as an earlier try that failed (TCR-1,
 * running), and may be in blocks already.
 */
async function send(input, { label, done }) {
  const b = [100_000_000 + Math.floor(Math.random() * 1_000_000), 1024, 400_000 + 3 * input.length, 300_000];
  const tx = encodeCall(app.canvas, input, b);
  const before = await app.node.occurrences(transactionId(app.chain, tx));
  let id;
  try {
    id = await app.node.submit(tx);
  } catch (e) {
    toast(`${esc(label)}: ${esc(e.message)}`, 'error');
    return false;
  }
  follow(id, before, label, done);
  return true;
}

/** Follows a transaction the page knows by id: into the node's pool, then into a block. */
async function follow(id, before, label, done) {
  const note = toast(`${esc(label)}: waiting for it to arrive…`, 'info', 600_000);
  const started = Date.now();
  const end = (message, kind, ok) => {
    note.remove();
    toast(message, kind, 10_000);
    done?.(ok);
  };
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    let answer;
    try {
      answer = await app.node.transaction(id, before);
    } catch (e) {
      if (!(e instanceof NodeError) || e.status !== 404 || Date.now() - started > 120_000) {
        return end(`${esc(label)}: the node no longer has it`, 'error', false);
      }
      continue;
    }
    const seen = answer.occurrences?.[0];
    if (seen) {
      const r = seen.receipt;
      if (r.status === 0) return end(`${esc(label)}: done, in block ${seen.height}`, 'success', true);
      let reason = r.status_name;
      try { reason = new TextDecoder('utf-8', { fatal: true }).decode(unhex(r.result_hex)) || reason; } catch { /* binary result */ }
      return end(`${esc(label)} failed: ${esc(reason)}`, 'error', false);
    }
    if (answer.pending) note.innerHTML = `${esc(label)}: received. It is being confirmed, which usually takes a minute or two.`;
    if (Date.now() - started > 20 * 60_000) return end(`${esc(label)}: still not confirmed after 20 minutes`, 'error', false);
  }
}

/**
 * Does an operation: `call` from canvas.js, `pay` as `{ burn }` or `{ to, amount }`
 * or none, and for an owner's operation `from` and `delayed`. It goes to Ting
 * ID, or any wallet that reads TCR-1 call links, as a link with the canvas's
 * coin, so that an operation without a payment can take a fee payment. The page
 * watches the program's events until it is done, or scheduled for an account
 * with a delay, and then calls `done(true)`; `done(false)` when the dialog is
 * closed first.
 */
async function perform({ call, pay, label, from, delayed, done }) {
  const decimals = app.coin.decimals;
  const link = await callLink({
    chainHex: app.chainHex, program: app.canvas, template: call.template, values: call.values, coin: app.config.coin,
    burn: pay?.burn != null ? linkAmount(pay.burn, decimals) : null,
    to: pay?.to, amount: pay?.to ? linkAmount(pay.amount, decimals) : null,
    from, delayed, returnTo: location.origin + location.pathname + location.search,
  });
  const dialog = $('#call-dialog');
  let qr = null;
  try { qr = qrSvg(link); } catch { /* too long for a QR code */ }
  $('.dialog-body', dialog).innerHTML = `<h2>${esc(label)} with Ting ID</h2>
    <p class="call-sentence">${sentence(call.template, call.values, pay?.burn ?? pay?.amount)}</p>
    <p class="hint">${pay ? `Ting ID shows what leaves your account: ${pay.burn != null ? `${amount(pay.burn)} burned` : `${amount(pay.amount)} to ${who(pay.to)}`}, and the fee.` : 'Nothing leaves your account but the fee.'}</p>
    <div class="pay">
      ${qr ? `<button class="qr" aria-label="Show the QR code full screen">${qr}</button>` : '<p class="hint">Too long for a QR code: open it on the phone that has Ting ID.</p>'}
      <div>
        <p class="hint">Scan it with Ting ID, or open it on the phone.${!qr ? '' : link.length > 1000 ? ' It is long: if the phone cannot read it, click the code to show it full screen.' : ' Click the code to show it full screen.'}</p>
        <div class="row"><a class="button primary" href="${esc(link)}">Open in Ting ID</a><button id="copy-call">Copy link</button></div>
        <p class="hint" id="call-status">Waiting for you to approve it in Ting ID…</p>
      </div>
    </div>`;
  $('#copy-call', dialog).onclick = () => copy(link, 'Call link copied');
  // Full screen gives a long link's small modules the most pixels; Escape or a click shrinks it again.
  const code = $('.qr', dialog);
  if (code) code.onclick = () => code.classList.toggle('full');
  dialog.oncancel = (e) => {
    if (!code?.classList.contains('full')) return;
    e.preventDefault();
    code.classList.remove('full');
  };
  if (!dialog.open) dialog.showModal();
  const start = (await app.node.status()).height;
  watchCall(dialog, call, label, start, done);
  return true;
}

/**
 * Looks for the operation in the program's events until it is done, or the
 * dialog is closed; and in the node's pool, to say when Ting ID has sent it.
 */
async function watchCall(dialog, call, label, start, done) {
  const operation = hex(operationHash(call.head));
  const head = hex(call.head);
  const token = (dialog.watching = {});
  const read = new Set();
  let sent = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    if (dialog.watching !== token) return;
    if (!dialog.open) return done?.(false);
    try {
      const executed = (await loadTopic(EXECUTED, start, decodeExecuted)).find((e) => hex(e.operation) === operation);
      if (executed) {
        dialog.close();
        toast(`${esc(label)}: done, in block ${executed.height}`, 'success', 10_000);
        return done?.(true);
      }
      const scheduled = await loadTopic(SCHEDULED, start, decodeScheduled);
      const mine = scheduled.find((s) => hex(s.head) === head);
      const status = $('#call-status', dialog);
      if (mine) {
        status.innerHTML = `Scheduled by ${who(mine.account)}: it takes effect ${esc(date(mine.executeAt))}, and can be cancelled until then.`;
      } else if (!sent && (await pooled(call.head, read))) {
        sent = true;
        status.textContent = 'Ting ID sent it. It is being confirmed, which usually takes a minute or two.';
      }
    } catch { /* the next look tries again */ }
  }
}

/**
 * Whether a call of the operation `head` waits in the node's pool. The wallet
 * made the transaction, so the page knows no id: it reads each pooled
 * transaction once, noting it in `read`, and looks at what it asks the canvas.
 */
async function pooled(head, read) {
  for (const { id } of (await app.node.mempool()).items) {
    if (read.has(id)) continue;
    try {
      const input = canvasInput((await app.node.transaction(id)).pending_transaction?.hex);
      read.add(id);
      if (input && equal(input.subarray(0, head.length), head)) return true;
    } catch { /* in a block already, or out of reach; the next look tries again */ }
  }
  return false;
}

// ---- Routing ---------------------------------------------------------------

function route() {
  app.leave?.();
  app.leave = null;
  app.tick = null;
  app.onAccounts = null;
  const [, view, arg] = location.hash.split('/');
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (view || 'paint')));
  const main = $('#view');
  main.className = '';
  if (view === 'gallery') return renderGallery(main);
  if (view === 'week' && /^\d+$/.test(arg ?? '')) return renderWeek(main, Number(arg));
  if (view === 'about') return renderAbout(main);
  return renderPaint(main);
}

// ---- Paint -----------------------------------------------------------------

const PROTECTION = [
  [0, 'None: the least it costs'],
  [1, '×2'],
  [2, '×4'],
  [3, '×8'],
  [4, '×16'],
];

function renderPaint(main) {
  const { config } = app;
  const week = weekAt(config, now());
  if (week < 1) {
    main.innerHTML = `<section class="notice"><h1>The first canvas opens ${esc(date(config.epoch))}</h1>
      <p>in <b id="countdown">${duration(config.epoch - now())}</b>.</p></section>`;
    app.tick = () => {
      if (now() >= config.epoch) return route();
      $('#countdown').textContent = duration(config.epoch - now());
    };
    return;
  }
  main.className = 'paint';
  main.innerHTML = `
    <section class="stage-wrap">
      <div class="stage" id="stage"></div>
      <div class="toolbar" role="toolbar" aria-label="Painting tools">
        <div class="palette" id="palette"></div>
        <div class="tools">
          <button data-tool="brush" class="active" title="Brush (B)" aria-label="Brush">${icon('brush')}</button>
          <button data-tool="erase" title="Remove from draft (E)" aria-label="Remove from draft">${icon('erase')}</button>
          <button data-tool="pick" title="Pick a color (I)" aria-label="Pick a color">${icon('pick')}</button>
          <button data-tool="pan" title="Move (H, or hold space)" aria-label="Move">${icon('pan')}</button>
          <span class="sep"></span>
          <button id="zoom-out" title="Zoom out" aria-label="Zoom out">${icon('minus')}</button>
          <button id="zoom-in" title="Zoom in" aria-label="Zoom in">${icon('plus')}</button>
          <button id="zoom-fit" title="Fit" aria-label="Fit">${icon('fit')}</button>
        </div>
      </div>
      <div class="hover" id="hover" hidden></div>
    </section>
    <aside class="side">
      <div class="card">
        <div class="eyebrow">Week ${week} · ${esc(day(opens(config, week)))} – ${esc(day(closes(config, week)))}</div>
        <h1 id="title">This week’s canvas</h1>
        <p class="closes">Locks for good in <b id="countdown">…</b></p>
        <dl class="stats">
          <div><dt>Burned</dt><dd id="burned">…</dd></div>
          <div><dt>Paints</dt><dd id="paints">…</dd></div>
          <div><dt>Pixels painted</dt><dd id="pixels">…</dd></div>
        </dl>
      </div>
      <div class="card draft">
        <h2>Your draft</h2>
        <p class="muted">Paint on the canvas. Nothing is sent until you press Paint.</p>
        <label class="field"><span>Protect your pixels</span>
          <select id="protect">${PROTECTION.map(([v, text]) => `<option value="${v}">${text}</option>`).join('')}</select>
        </label>
        <dl class="lines">
          <div><dt>Pixels</dt><dd id="draft-count">0</dd></div>
          <div><dt>Burns</dt><dd id="draft-price">—</dd></div>
        </dl>
        <div class="row">
          <button class="primary" id="paint" disabled>Paint</button>
          <button id="clear" disabled>Clear</button>
        </div>
        <p class="hint" id="draft-hint"></p>
      </div>
      <div class="card">
        <h2>Activity</h2>
        <ol class="activity" id="activity"><li class="muted">Loading…</li></ol>
      </div>
    </aside>`;

  let data = null;
  const marks = () => data.marks;
  const boost = () => Number($('#protect').value);

  const painter = new Painter($('#stage'), config, {
    editable: true,
    maxDraft: MAX_DRAFT,
    onDraft: () => updateDraft(),
    onHover: (index) => {
      const el = $('#hover');
      if (index == null || !data) return (el.hidden = true);
      const x = index % config.width, y = Math.floor(index / config.width);
      const mark = marks()[index];
      el.hidden = false;
      el.innerHTML = mark === 0
        ? `${x}, ${y} · never painted · ${amount(config.price)} to paint`
        : `${x}, ${y} · painted for ${amount(levelCost(config, mark - 1))} · ${amount(levelCost(config, mark))} to paint over`;
    },
    onPick: (color) => selectColor(color),
    onLimit: () => toast(`One paint holds at most ${MAX_DRAFT} pixels.`, 'info', 3000),
  });

  const palette = $('#palette');
  palette.innerHTML = config.palette.map((rgb, i) =>
    `<button class="swatch" data-color="${i}" style="--c:${css(rgb)}" title="Color ${i + 1}" aria-label="Color ${i + 1}"></button>`).join('');
  const selectColor = (i) => {
    painter.color = i;
    $$('.swatch', palette).forEach((b) => b.classList.toggle('active', Number(b.dataset.color) === i));
    if (painter.tool !== 'brush') selectTool('brush');
  };
  const selectTool = (tool) => {
    painter.tool = tool;
    $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    $('#stage').dataset.tool = tool;
  };
  palette.addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (b) selectColor(Number(b.dataset.color));
  });
  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => selectTool(b.dataset.tool)));
  $('#zoom-in').onclick = () => painter.zoomAt(1.5);
  $('#zoom-out').onclick = () => painter.zoomAt(1 / 1.5);
  $('#zoom-fit').onclick = () => painter.fit();
  $('#protect').onchange = () => updateDraft();
  selectColor(painter.color);
  selectTool('brush');

  const keys = (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.code === 'Space') { painter.spaceHeld = e.type === 'keydown'; e.preventDefault(); return; }
    if (e.type !== 'keydown') return;
    const k = e.key.toLowerCase();
    if (k === 'b') selectTool('brush');
    else if (k === 'e') selectTool('erase');
    else if (k === 'i') selectTool('pick');
    else if (k === 'h') selectTool('pan');
    else if (/^[1-9]$/.test(k) && Number(k) <= config.palette.length) selectColor(Number(k) - 1);
    else if ((e.metaKey || e.ctrlKey) && k === 'z' && painter.draft.size) {
      painter.draft.delete([...painter.draft.keys()].pop());
      painter.render();
      updateDraft();
    }
  };
  window.addEventListener('keydown', keys);
  window.addEventListener('keyup', keys);

  const draftPixels = () => (data ? levelsFor(marks(), [...painter.draft], boost()) : []);
  const updateDraft = () => {
    const pixels = draftPixels();
    const price = priceOf(config, pixels);
    $('#draft-count').textContent = pixels.length.toLocaleString();
    $('#draft-price').innerHTML = pixels.length ? amount(price) : '—';
    $('#clear').disabled = !pixels.length;
    const hint = $('#draft-hint');
    const button = $('#paint');
    button.disabled = !pixels.length;
    hint.innerHTML = '';
    if (!pixels.length) {
      button.textContent = 'Paint';
      return;
    }
    const over = pixels.filter(([index]) => marks()[index] > 0).length;
    const next = levelCost(config, boost() + 1);
    hint.innerHTML = `${over ? `${plural(over, 'pixel')} of it paint over others’ work, for twice what is on them. ` : ''}`
      + `Painting over your fresh pixels will then cost at least ${amount(next)} each.`;
    button.textContent = `Paint ${plural(pixels.length, 'pixel')} with Ting ID`;
  };

  $('#clear').onclick = () => painter.clearDraft();
  $('#paint').onclick = async () => {
    const pixels = draftPixels();
    const price = priceOf(config, pixels);
    if (weekAt(config, now() + 30) !== week) {
      return toast('This canvas locks in less than a minute: a paint sent now would likely arrive too late.', 'error');
    }
    // The draft stays until the paint is on chain: a link the wallet never
    // signs, or a dialog closed, leaves it as it was.
    const painted = (ok) => {
      if (ok) {
        for (const [index, color] of pixels) if (painter.draft.get(index) === color) painter.draft.delete(index);
        painter.render();
      }
      refresh();
    };
    try {
      await perform({
        call: paintCall(config, BigInt(week), pixels), pay: { burn: price },
        label: `Painting ${plural(pixels.length, 'pixel')}`, done: painted,
      });
    } catch (e) {
      toast(esc(e.message), 'error');
    }
  };

  const refresh = async () => {
    try {
      const fresh = await loadWeek(week);
      data = fresh;
      painter.setPixels(fresh.colors, fresh.marks);
      $('#burned').innerHTML = amount(fresh.record.burned, 4);
      $('#paints').textContent = fresh.record.paints.toLocaleString();
      $('#pixels').textContent = fresh.record.pixels.toLocaleString();
      if (shownTitle(fresh.title)) $('#title').textContent = shownTitle(fresh.title);
      updateDraft();
      renderActivity(await loadEvents(week));
    } catch (e) {
      toast(`Reading the canvas: ${esc(e.message)}`, 'error');
    }
  };
  const renderActivity = (events) => {
    const list = events.filter((e) => e.kind === 'paint').slice(-12).reverse();
    $('#activity').innerHTML = list.length
      ? list.map((e) => `<li>${who(e.account)} painted ${plural(e.pixels.length, 'pixel')}, burning ${amount(e.amount, 4)}<time>${esc(duration(now() - e.time))} ago</time></li>`).join('')
      : '<li class="muted">No paint yet. Be the first.</li>';
  };

  refresh();
  const poll = setInterval(refresh, 15_000);
  app.tick = () => {
    if (weekAt(config, now()) !== week) return route();
    $('#countdown').textContent = duration(closes(config, week) - now());
  };
  app.tick();
  app.onAccounts = refresh;
  app.leave = () => {
    clearInterval(poll);
    painter.destroy();
    window.removeEventListener('keydown', keys);
    window.removeEventListener('keyup', keys);
  };
}

// ---- Gallery ---------------------------------------------------------------

const STAGES = {
  painting: 'Being painted',
  auction: 'Auction open',
  waiting: 'Waiting for a first bid',
  won: 'Won, to settle',
  owned: 'Owned',
};

async function renderGallery(main) {
  const { config } = app;
  const current = weekAt(config, now());
  main.className = 'gallery';
  if (current < 1) {
    main.innerHTML = `<section class="notice"><h1>No canvas yet</h1><p>The first opens ${esc(date(config.epoch))}.</p></section>`;
    return;
  }
  const weeks = [];
  for (let w = current; w >= 1 && weeks.length < 60; w--) weeks.push(w);
  main.innerHTML = `<header class="page-head"><h1>Gallery</h1><p class="muted">Every week’s canvas, locked for good when its week ended.</p></header>
    <div class="grid">${weeks.map((w) => `
      <a class="tile" href="#/week/${w}" data-week="${w}">
        <div class="thumb"><canvas width="${config.width}" height="${config.height}"></canvas></div>
        <div class="tile-body">
          <div class="eyebrow">Week ${w} · ${esc(day(opens(config, w)))}</div>
          <div class="tile-title">…</div>
          <div class="tile-meta muted"></div>
        </div>
      </a>`).join('')}</div>`;
  let gone = false;
  app.leave = () => { gone = true; };
  app.onAccounts = () => renderGallery(main);
  for (const w of weeks) {
    if (gone) return;
    const el = $(`[data-week="${w}"]`, main);
    try {
      const data = await loadWeek(w);
      imageOf(config, data.colors, $('canvas', el));
      const s = stage(config, w, data.record, now());
      $('.tile-title', el).textContent = shownTitle(data.title) || (w === current ? 'This week’s canvas' : `Week ${w}`);
      let meta = STAGES[s];
      if (s === 'auction' && data.record.bid > 0n) meta += ` · ${amount(data.record.bid, 4)}`;
      if (s === 'owned' && data.record.price > 0n) meta = `For sale · ${amount(data.record.price, 4)}`;
      const yours = isMine(ownerOf(config, w, data.record, now())) ? '<span class="badge yours">Yours</span> ' : '';
      $('.tile-meta', el).innerHTML = `${yours}<span class="badge ${s}">${meta}</span> ${amount(data.record.burned, 4)} burned`;
    } catch (e) {
      $('.tile-meta', el).textContent = e.message;
    }
  }
}

// ---- One week --------------------------------------------------------------

async function renderWeek(main, week) {
  const { config } = app;
  main.className = 'week';
  if (week < 1 || week > weekAt(config, now())) {
    main.innerHTML = `<section class="notice"><h1>No canvas for week ${week}</h1><p>Weeks count from 1; week ${weekAt(config, now()) || 1} is the latest.</p></section>`;
    return;
  }
  main.innerHTML = `<section class="notice"><p class="muted">Loading week ${week}…</p></section>`;
  let data, events = [], waiting = [];
  try {
    data = await loadWeek(week);
  } catch (e) {
    main.innerHTML = `<section class="notice"><h1>Cannot read week ${week}</h1><p>${esc(e.message)}</p></section>`;
    return;
  }
  const coin = app.config.coin;
  const vault = contractAccount(app.canvas);

  const draw = () => {
    const open = Boolean($('#owner-tools[open]', main));
    const { record, title } = data;
    const t = now();
    const s = stage(config, week, record, t);
    const owner = ownerOf(config, week, record, t);
    const mine = isMine(owner);
    const ends = auctionEnds(config, week, record);
    main.innerHTML = `
      <section class="art">
        <div class="frame"><canvas id="art" width="${config.width}" height="${config.height}"></canvas></div>
        <div class="row">
          <button id="replay">${icon('play')} Replay</button>
          <button id="download">${icon('download')} PNG</button>
          ${s === 'painting' ? '<a class="button primary" href="#/">Paint on it</a>' : ''}
        </div>
      </section>
      <aside class="side">
        <div class="card">
          <div class="eyebrow">Week ${week} · ${esc(day(opens(config, week)))} – ${esc(day(closes(config, week)))}</div>
          <h1>${esc(shownTitle(title) || `Week ${week}`)}</h1>
          <span class="badge ${s}">${STAGES[s]}</span>
          <dl class="stats">
            <div><dt>Burned painting it</dt><dd>${amount(record.burned, 4)}</dd></div>
            <div><dt>Paints</dt><dd>${record.paints.toLocaleString()}</dd></div>
            <div><dt>Pixels painted</dt><dd>${record.pixels.toLocaleString()}</dd></div>
          </dl>
        </div>
        <div class="card" id="market">${market(s, record, ends, owner, mine, t)}</div>
        ${owner ? ownerTools(record, title, mine, open) : ''}
        ${waiting.length ? scheduledCard(t) : ''}
        <div class="card"><h2>History</h2><ol class="activity" id="history"><li class="muted">Loading…</li></ol></div>
      </aside>`;
    imageOf(config, data.colors, $('#art'));
    $('#download').onclick = () => {
      const big = document.createElement('canvas');
      const k = Math.max(1, Math.floor(1024 / config.width));
      big.width = config.width * k;
      big.height = config.height * k;
      const ctx = big.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage($('#art'), 0, 0, big.width, big.height);
      const a = document.createElement('a');
      a.download = `ting-canvas-week-${week}.png`;
      a.href = big.toDataURL('image/png');
      a.click();
    };
    $('#replay').onclick = () => replay();
    wire(record, owner);
    renderHistory();
  };

  const market = (s, record, ends, owner, mine, t) => {
    const reserve = amount(config.reserve);
    switch (s) {
      case 'painting':
        return `<h2>Auction</h2><p>Opens when the canvas locks, in <b data-count="${closes(config, week)}">${duration(closes(config, week) - t)}</b>, and runs for ${duration(config.auction)}. The winning bid is burned.</p>`;
      case 'auction':
      case 'waiting': {
        const least = minimumBid(config, record);
        const head = record.bid > 0n
          ? `<dl class="lines"><div><dt>Highest bid</dt><dd>${amount(record.bid)}</dd></div><div><dt>Bidder</dt><dd>${who(record.bidder)}</dd></div><div><dt>Ends in</dt><dd><b data-count="${ends}">${duration(ends - t)}</b></dd></div></dl>`
          : s === 'waiting'
            ? `<p>The auction ended without a bid. The first bid of at least ${reserve} wins unless outbid within ${duration(config.extension)}.</p>`
            : `<p>No bids yet. The reserve is ${reserve}. Ends in <b data-count="${ends}">${duration(ends - t)}</b>.</p>`;
        return `<h2>Auction</h2>${head}
          <form class="row" id="bid-form">
            <label class="field"><span>Your bid (${esc(app.coin.symbol)})</span><input id="bid" inputmode="decimal" autocomplete="off" placeholder="${formatAmount(least, app.coin.decimals)}"></label>
            <button class="primary">Bid</button>
          </form>
          <p class="hint">At least ${amount(least)}. Your bid is held by the program and comes back if someone outbids you; a bid in the last ${duration(config.extension)} extends the auction. The winning bid is burned.</p>`;
      }
      case 'won':
        return `<h2>Auction over</h2><p>${who(record.bidder)} won with ${amount(record.bid)}. Settling burns the bid and hands over the canvas; anyone can settle, and the winner’s first owner action settles it too.</p>
          <button id="settle">Settle now</button>`;
      default: {
        const sale = record.price > 0n
          ? `<p>For sale for <b>${amount(record.price)}</b>, paid to the owner.</p>${mine ? '' : `<button class="primary" id="buy">Buy for ${amount(record.price)}</button>`}`
          : '<p class="muted">Not for sale.</p>';
        return `<h2>Owner</h2><p>${who(owner)}${record.bid > 0n ? ` · won at auction for ${amount(record.bid)}` : ''}</p>${sale}`;
      }
    }
  };

  const ownerTools = (record, title, mine, open) => {
    const forms = `
      <form class="row" id="list-form">
        <label class="field"><span>Sell for (${esc(app.coin.symbol)})</span><input id="list-price" inputmode="decimal" autocomplete="off" value="${record.price > 0n ? formatAmount(record.price, app.coin.decimals) : ''}"></label>
        <button>${record.price > 0n ? 'Change price' : 'List'}</button>
      </form>
      ${record.price > 0n ? '<button id="unlist">Take off sale</button>' : ''}
      <form class="row" id="title-form">
        <label class="field"><span>Title</span><input id="title-input" maxlength="${TITLE_MAX}" value="${esc(title)}"></label>
        <button>${title ? 'Rename' : 'Name it'}</button>
      </form>
      ${title ? '<button id="unname">Remove the name</button>' : ''}
      <form class="row" id="give-form">
        <label class="field"><span>Give to account</span><input id="give-to" class="mono" autocomplete="off" placeholder="64 hex digits"></label>
        <button>Give</button>
      </form>`;
    const hint = '<p class="hint">Each action becomes a call link that only the owner’s account can sign. From a Savings account it takes effect after the account’s delay, and can be cancelled until then.</p>';
    return mine
      ? `<div class="card"><h2>You own this canvas</h2>${hint}${forms}</div>`
      : `<div class="card"><details id="owner-tools"${open ? ' open' : ''}><summary><b>Own it? Act from Ting ID</b></summary>
          ${hint}${forms}</details></div>`;
  };

  const scheduledCard = (t) => `<div class="card"><h2>Scheduled</h2><ol class="activity">${waiting.map((s, i) => {
    const due = t >= s.executeAt;
    return `<li>${sentence(s.template, s.values)}<time>by ${who(s.account)} · ${due ? 'due now' : `takes effect in <b data-count="${s.executeAt}">${duration(s.executeAt - t)}</b>`}</time>
      ${due ? `<button data-run="${i}">Run it</button>` : ''}</li>`;
  }).join('')}</ol><p class="hint">Operations of accounts with a delay wait, and their owners can cancel them. Once due, anyone can run them.</p></div>`;

  const reload = async () => {
    [data, waiting] = await Promise.all([loadWeek(week), loadScheduled(week).catch(() => waiting)]);
    events = await loadEvents(week).catch(() => events);
    draw();
  };

  const wire = (record, owner) => {
    const decimals = app.coin.decimals;
    const after = { done: (ok) => ok && reload() };
    const owned = { from: owner, delayed: true, ...after };
    $('#bid-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = parseAmount($('#bid').value, decimals);
      const least = minimumBid(config, record);
      if (value == null || value < least) return toast(`Bid at least ${amount(least)}.`, 'error');
      guard(() => perform({
        call: bidCall(BigInt(week)), pay: { to: vault, amount: value },
        label: `Bidding ${formatAmount(value, decimals)} ${app.coin.symbol}`, ...after,
      }));
    });
    const settle = $('#settle');
    if (settle) settle.onclick = () => guard(() => send(settleInput(BigInt(week)), { label: 'Settling the auction', ...after }));
    const buy = $('#buy');
    if (buy) {
      buy.onclick = () => guard(() => perform({
        call: buyCall(BigInt(week)), pay: { to: record.owner, amount: record.price },
        label: `Buying week ${week}`, ...after,
      }));
    }
    $('#list-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const price = parseAmount($('#list-price').value, decimals);
      if (price == null || price === 0n) return toast('Enter a price.', 'error');
      guard(() => perform({ call: listCall(BigInt(week), coin, price), label: 'Listing', ...owned }));
    });
    const unlist = $('#unlist');
    if (unlist) unlist.onclick = () => guard(() => perform({ call: unlistCall(BigInt(week)), label: 'Taking off sale', ...owned }));
    $('#title-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = $('#title-input').value.trim().normalize('NFC');
      if (!title) return toast('Enter a title.', 'error');
      const problem = textProblem(title);
      if (problem) return toast(`That title cannot be used: ${esc(problem)}.`, 'error');
      if (new TextEncoder().encode(title).length > TITLE_MAX) return toast(`A title is at most ${TITLE_MAX} bytes.`, 'error');
      guard(() => perform({ call: nameCall(BigInt(week), title), label: 'Naming the canvas', ...owned }));
    });
    const unname = $('#unname');
    if (unname) unname.onclick = () => guard(() => perform({ call: unnameCall(BigInt(week)), label: 'Removing the name', ...owned }));
    $('#give-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const to = idOf($('#give-to').value);
      if (!to || to.every((b) => b === 0)) return toast('An account is 64 hex digits.', 'error');
      if (!confirm(`Give week ${week} to ${hex(to)}? Only that account can give it back.`)) return;
      guard(() => perform({ call: giveCall(BigInt(week), to), label: 'Giving the canvas', ...owned }));
    });
    $$('[data-run]', main).forEach((b) => {
      const s = waiting[Number(b.dataset.run)];
      b.onclick = () => guard(() => send(runCall(s.account, s.sequence), { label: 'Running a scheduled operation', ...after }));
    });
  };

  const renderHistory = () => {
    const el = $('#history');
    if (!el) return;
    const text = (e) => {
      switch (e.kind) {
        case 'paint': return `${who(e.account)} painted ${plural(e.pixels.length, 'pixel')}, burning ${amount(e.amount, 4)}`;
        case 'bid': return `${who(e.account)} bid ${amount(e.amount)}`;
        case 'settled': return `${who(e.account)} won it for ${amount(e.amount)}, burned`;
        case 'listed': return e.amount > 0n ? `${who(e.account)} listed it for ${amount(e.amount)}` : `${who(e.account)} took it off sale`;
        case 'sold': return `${who(e.account)} bought it from ${who(e.from)} for ${amount(e.amount)}`;
        case 'given': return `${who(e.from)} gave it to ${who(e.account)}`;
        case 'titled': return !e.title ? `${who(e.account)} removed its name`
          : shownTitle(e.title) ? `${who(e.account)} named it “${esc(e.title)}”` : `${who(e.account)} gave it a name this page cannot show`;
        default: return 'Something unknown';
      }
    };
    el.innerHTML = events.length
      ? events.slice().reverse().slice(0, 50).map((e) => `<li>${text(e)}<time>${esc(date(e.time))}</time></li>`).join('')
      : '<li class="muted">Nothing yet.</li>';
  };

  let playing = null;
  const replay = () => {
    const paints = events.filter((e) => e.kind === 'paint');
    if (!paints.length) return toast('Nothing to replay yet.', 'info', 3000);
    cancelAnimationFrame(playing);
    const colors = new Uint8Array(config.width * config.height);
    const canvas = $('#art');
    const total = paints.reduce((n, e) => n + e.pixels.length, 0);
    const per = Math.max(1, Math.ceil(total / 600));
    let p = 0, q = 0;
    const step = () => {
      for (let n = 0; n < per && p < paints.length; n++) {
        const [index, color] = paints[p].pixels[q++];
        colors[index] = color;
        if (q >= paints[p].pixels.length) { p++; q = 0; }
      }
      imageOf(config, colors, canvas);
      if (p < paints.length) playing = requestAnimationFrame(step);
      else imageOf(config, data.colors, canvas);
    };
    step();
  };

  draw();
  reload().catch(() => {});
  const poll = setInterval(async () => {
    if ($('input:focus', main)) return;
    try {
      const fresh = await loadWeek(week);
      const pending = await loadScheduled(week).catch(() => waiting);
      const changed = hex(fresh.record.bidder) !== hex(data.record.bidder) || fresh.record.bid !== data.record.bid
        || fresh.record.settled !== data.record.settled || hex(fresh.record.owner) !== hex(data.record.owner)
        || fresh.record.price !== data.record.price || fresh.record.pixels !== data.record.pixels || fresh.title !== data.title
        || pending.length !== waiting.length;
      const s = stage(config, week, fresh.record, now());
      const due = waiting.some((w) => w.executeAt <= now() && w.executeAt > now() - 15);
      if (changed || due || s !== stage(config, week, data.record, now() - 15)) {
        data = fresh;
        waiting = pending;
        events = await loadEvents(week);
        draw();
      }
    } catch { /* the next poll tries again */ }
  }, 15_000);
  app.tick = () => {
    $$('[data-count]', main).forEach((el) => (el.textContent = duration(Number(el.dataset.count) - now())));
  };
  app.onAccounts = () => draw();
  app.leave = () => {
    clearInterval(poll);
    cancelAnimationFrame(playing);
  };
}

async function guard(action) {
  try {
    await action();
  } catch (e) {
    toast(esc(e.message), 'error');
  }
}

// ---- About -----------------------------------------------------------------

function renderAbout(main) {
  const { config } = app;
  main.className = 'about';
  main.innerHTML = `<article class="prose">
    <h1>How Ting Canvas works</h1>
    <p>Every ${duration(config.period)} a new ${config.width} × ${config.height} canvas opens on the
    <a href="https://node1.ting-node.com/wiki">Ting</a> chain. Anyone can paint it, pixel by pixel. When the week is over it locks,
    and nothing can change it again.</p>
    <h2>Painting burns coins</h2>
    <p>A fresh pixel costs ${amount(config.price)}. Painting over one costs twice what was paid for it: ${amount(config.price * 2n)}
    over a fresh paint, then ${amount(config.price * 4n)}, and so on. You can also protect your own pixels by paying
    more up front: paint at ×4 and anyone painting over you burns at least ×8. The coins are burned, not paid to anyone:
    no one, not even whoever deployed the canvas, earns from painting.</p>
    <h2>Then it is auctioned</h2>
    <p>When a canvas locks, an auction for it runs for ${duration(config.auction)}. Bids start at ${amount(config.reserve)}
    and each must beat the last by 5%. The program holds the highest bid and returns the one it beats. A bid in the last
    ${duration(config.extension)} extends the auction, so it cannot be sniped. The winning bid is burned too.
    An auction that ends without a bid waits for its first.</p>
    <h2>And owned for good</h2>
    <p>The winner owns the canvas. An owner can name it, give it away, or list it for sale; a buyer pays the owner and
    becomes the owner, in one transaction. Kept in a Ting ID Savings account, a canvas moves only after the account’s
    delay, and its owner can cancel anything a stolen key tries in the meantime.</p>
    <h2>Signing</h2>
    <p>Every action is a Ting Call Request (TCR-1): a sentence in the program’s own words, signed by the account that
    acts. The page holds no key and no coins. It hands each action to Ting ID, or any wallet that reads Ting call
    links, as a link or a QR code, and watches the chain for the result.</p>
    <h2>Trust nothing, check everything</h2>
    <p>The page reads the chain through <code>${esc(app.node.base)}</code> and checks the code of what it makes calls for:
    the canvas program <code>${esc(hex(app.canvas))}</code> and its coin <code>${esc(hex(app.config.coin))}</code>, each
    against the CodeHash it was written for. The program’s rules are in its specification,
    <code>SPEC.md</code>, beside its source.</p>
  </article>`;
}

// ---- Signing ---------------------------------------------------------------

/** What signs here: Ting ID, or any wallet that reads TCR-1 call links; and the accounts the user linked. */
function openSigning() {
  const dialog = $('#sign-dialog');
  const body = $('.dialog-body', dialog);
  const linked = [...app.accounts];
  body.innerHTML = `<h2>Signing with Ting ID</h2>
    <p>This page holds no key and no coins. Each action becomes a Ting call link, shown as a QR code to scan with
    Ting ID or a link to open on the phone. Ting ID shows the action in the program’s words and what leaves your
    account, signs it with the account you choose, and submits it. The page then finds it on the chain.</p>
    <p class="hint">Any wallet that reads Ting call links (TCR-1) does the same.</p>
    <h3>Your accounts</h3>
    <p class="hint">The page shows these as you, with the canvases they own. It keeps only their addresses, in this
    browser; a call Ting ID sends back to this page links the account that made it.</p>
    <ul class="linked">${linked.map((a) => `<li><code title="${a}">${a.slice(0, 10)}…${a.slice(-8)}</code><button data-unlink="${a}">Remove</button></li>`).join('')
      || '<li class="muted">None yet.</li>'}</ul>
    <form class="row" id="link-form">
      <label class="field"><span>Add an account</span><input id="link-account" class="mono" autocomplete="off" placeholder="64 hex digits"></label>
      <button>Add</button>
    </form>`;
  $('#link-form', body).addEventListener('submit', (e) => {
    e.preventDefault();
    const account = idOf($('#link-account', body).value);
    if (!account) return toast('An account is 64 hex digits.', 'error');
    linkAccount(account, true);
    openSigning();
  });
  $$('[data-unlink]', body).forEach((b) => (b.onclick = () => { linkAccount(unhex(b.dataset.unlink), false); openSigning(); }));
  if (!dialog.open) dialog.showModal();
}

// ---- Your accounts -----------------------------------------------------------

const ACCOUNTS = 'ting-canvas/accounts';

function loadAccounts() {
  try {
    const list = JSON.parse(localStorage.getItem(ACCOUNTS) ?? '[]');
    app.accounts = new Set(list.filter((a) => /^[0-9a-f]{64}$/.test(a)));
  } catch {
    app.accounts = new Set();
  }
}

/** Links or unlinks an account, and shows the change wherever the view shows accounts. */
function linkAccount(account, linked) {
  const text = hex(account);
  if (linked) app.accounts.add(text);
  else app.accounts.delete(text);
  try {
    localStorage.setItem(ACCOUNTS, JSON.stringify([...app.accounts]));
  } catch { /* kept for this visit only */ }
  app.onAccounts?.();
}

const isMine = (account) => Boolean(account) && app.accounts.has(hex(account));

/** The account a call to the canvas acted for, from its receipt's *executed* or *scheduled* event, or null. */
function actorOf(receipt) {
  for (const e of receipt?.events ?? []) {
    if (e.contract !== hex(app.canvas)) continue;
    const payload = unhex(e.payload_hex);
    if (payload.length >= 64 && (equal(payload.subarray(0, 32), EXECUTED) || equal(payload.subarray(0, 32), SCHEDULED))) {
      return payload.slice(32, 64);
    }
  }
  return null;
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'success', 2500);
  } catch {
    toast('Copying is not allowed here', 'error', 2500);
  }
}

// ---- Icons -----------------------------------------------------------------

function icon(name) {
  const paths = {
    brush: '<path d="M14 4l6 6-8.5 8.5a3 3 0 01-2.1.9H4v-5.4a3 3 0 01.9-2.1z"/><path d="M12 6l6 6"/>',
    erase: '<path d="M7 21h13"/><path d="M5.5 15.5l9-9a2 2 0 012.8 0l1.2 1.2a2 2 0 010 2.8L11 18H8z"/>',
    pick: '<path d="M14.5 5.5l4 4"/><path d="M17 3a2.1 2.1 0 013 3l-2 2-3-3z"/><path d="M15 8l-9 9-2 4 4-2 9-9"/>',
    pan: '<path d="M12 3v18M3 12h18M12 3l-3 3m3-3l3 3M12 21l-3-3m3 3l3-3M3 12l3-3m-3 3l3 3m15-3l-3-3m3 3l-3 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12.5h2M3 9.5h18"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

// ---- Start -----------------------------------------------------------------

function fatal(title, detail) {
  $('#view').innerHTML = `<section class="notice"><h1>${esc(title)}</h1><p>${detail}</p></section>`;
}

async function boot() {
  const query = new URLSearchParams(location.search);
  app.node = new Node(query.get('node') || DEFAULT_NODE);
  let status;
  try {
    status = await app.node.status();
  } catch (e) {
    return fatal('Cannot reach the node', `${esc(app.node.base)}: ${esc(e.message)}`);
  }
  app.chainHex = status.chain_id;
  app.chain = unhex(status.chain_id);
  app.network = NETWORKS[app.chainHex] ?? { name: status.network, canvas: '' };
  $('#network').textContent = app.network.name;
  app.canvas = idOf(query.get('canvas') || app.network.canvas);
  if (!app.canvas) {
    return fatal('No canvas on this network yet', `The canvas program is not deployed on ${esc(app.network.name)}, or this page does not know where. Add <code>?canvas=&lt;ContractId&gt;</code> to the address.`);
  }
  try {
    const [canvas, configBytes] = await Promise.all([app.node.contract(app.canvas), app.node.record(app.canvas, CONFIG_KEY)]);
    if (canvas.code_hash !== CODE_HASHES.canvas) {
      return fatal('This canvas runs other code', `The contract runs code <code>${esc(canvas.code_hash)}</code>, not the canvas program this page was written for. The page makes no calls for it.`);
    }
    app.config = decodeConfig(configBytes);
    app.templates = decodeTemplateList(await app.node.record(app.canvas, TEMPLATES_KEY));
    try {
      for (const t of Object.values(templatesOf(app.config))) checkListed(app.templates, t);
    } catch (e) {
      return fatal('This canvas lists other operations', `Its template list does not hold the operations this page makes: ${esc(e.message)}.`);
    }
    const [coin, coinConfig] = await Promise.all([app.node.contract(app.config.coin), app.node.record(app.config.coin, CONFIG_KEY)]);
    if (coin.code_hash !== CODE_HASHES.coin) return fatal('The canvas pays in an unknown coin', 'Its coin does not run the reference coin program.');
    app.coin = decodeCoin(coinConfig);
  } catch (e) {
    return fatal('Cannot read the canvas', esc(e.message));
  }
  loadAccounts();
  const chip = $('#sign-chip');
  chip.innerHTML = `${icon('wallet')} Ting ID`;
  chip.onclick = openSigning;
  for (const id of ['sign', 'call']) {
    const dialog = $(`#${id}-dialog`);
    $('.close', dialog).onclick = () => dialog.close();
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }
  setInterval(() => app.tick?.(), 1000);
  window.addEventListener('hashchange', arrive);
  arrive();
}

/** Routes, or takes a call back from Ting ID: the link's `return` opened with `#ting-tx=` (TCR-1, the link). */
function arrive() {
  const m = location.hash.match(/^#ting-tx=([0-9a-fA-F]{64})$/);
  if (!m) return route();
  const id = m[1].toLowerCase();
  history.replaceState(null, '', location.pathname + location.search);
  const label = 'Your call from Ting ID';
  follow(id, 0, label, async (ok) => {
    try {
      const seen = (await app.node.transaction(id)).occurrences?.[0];
      // The wallet sent this transaction here: the account it acted for is the user's.
      const actor = ok && actorOf(seen?.receipt);
      if (actor && !isMine(actor)) {
        linkAccount(actor, true);
        toast(`Linked your account <code>${hex(actor).slice(0, 6)}…${hex(actor).slice(-4)}</code>: the page shows what it owns.`, 'success', 8000);
      }
      const week = weekOfTransaction(seen?.hex);
      if (week) location.hash = week === weekAt(app.config, now()) ? '#/' : `#/week/${week}`;
    } catch { /* stay on the page */ }
  });
  route();
}

/** The week a transaction's call to the canvas names, or null. */
/** The input of a transaction that calls the canvas, or null. */
function canvasInput(txHex) {
  if (!txHex) return null;
  const r = new Reader(unhex(txHex));
  if (r.u8() !== 1 || r.u8() !== 0) return null;
  for (let i = 0; i < 4; i++) r.u64();
  return equal(r.id(), app.canvas) ? r.bytes() : null;
}

function weekOfTransaction(txHex) {
  const input = canvasInput(txHex);
  if (!input || input.length < 40 || !app.templates.has(hex(input.subarray(0, 32)))) return null;
  return Number(weekOfCall(input.subarray(32)));
}

boot();
