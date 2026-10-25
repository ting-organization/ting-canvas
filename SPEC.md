# The canvas program

One canvas a period, a week on the production network. Anyone paints it while its
week runs, and every paint burns coins: a fresh pixel costs the price, and painting
over a pixel costs at least twice what was burned for it. When the week ends the
canvas locks and never changes again. It is then auctioned; the winning bid is
burned too, and the winner owns the canvas, which they can name, give away or sell.

The program is an ordinary Ting program, `canvas.wasm`, built from `program/`. Its
behavior is fixed by its bytes: this page describes them, and the tests in
`tools/tests/canvas.rs` hold them to it. Like every installed program it never
changes ([upgrades through programs](https://node1.ting-node.com/wiki/applications/upgrades)).

Its operations are calls of **TCR-1, Ting Call Requests** (`ting-id/TCR-1.md`):
each is a template of the program's own, which declares its fields and gives the
sentence that shows them, and its values, approved by the acting account. An
operation that moves coins carries a coin payment from that account, tied to it,
which is also its approval. A wallet that speaks TCR-1, such
as Ting ID, does them from a `ting:call` link; the page in `web/` does them with its
own wallet too. This page states what the canvas adds to TCR-1, and the choices
TCR-1 leaves to a program.

In the formats below, integers are little-endian and fixed width, `Bytes(x)` is
`u32(len(x)) ‖ x`, `‖` is concatenation and `H` is Ting's domain-separated hash, as
in the Ting wiki's [conventions](https://node1.ting-node.com/wiki/programs/conventions).
Errors are the exact ASCII bytes the program reverts with.

## Deployment

The deployment input is the configuration, which the program stores at the zero key
and never changes:

```text
u8 version = 1
coin(32)              the coin it is paid in, the only one it accepts
u64 epoch             when week 1 opens, a block timestamp
u64 period            the length of a week, in seconds, > 0
u16 width, u16 height multiples of 16, from 16 to 4096
u128 price            a fresh pixel's paint, > 0
u64 auction           how long an auction runs after its week
u64 extension         how far a bid pushes an auction's end past itself
u128 reserve          the least first bid, > 0
u8 colors             2 to 255
colors × (u8 r ‖ u8 g ‖ u8 b ‖ Bytes(name))   the palette; color 0 is the canvas's ground
```

A color's name is what a wallet shows for it: 1 to 32 bytes of ASCII letters,
digits, spaces and hyphens, with no space at either end, and no two colors share
one. The names become the labels of the paint template's `color` enum, which must
fit TCR-1's 512 bytes: sixteen names of ordinary length do, two hundred do not.

Any other input reverts `bad deploy input`, empty input included. The deployment
also stores the program's templates, for wallets to read
([templates](#templates)).

## Time

Block timestamps decide every time:

```text
week(t)    = (t − epoch) / period + 1            for t ≥ epoch; weeks count from 1
closes(w)  = epoch + w × period                 when week w locks and its auction opens
ends(w)    = closes(w) + auction                until a first bid sets it
```

A canvas can be painted only while its week is the current one. The auction runs
from `closes(w)`. Every accepted bid moves the end to `max(end, now + extension)`, so
a bid in the last `extension` seconds always leaves time to answer it. An auction
whose end passes without a bid stays open for its first bid, which then has
`extension` seconds to be outbid.

## Records

| Key | Value |
|---|---|
| `00…00` | The configuration |
| `ff ‖ 00…` | The signing digest of the call that is paying, only while it pays |
| `01 ‖ u64 week ‖ u16 tile ‖ 00…` | A tile of 16 × 16 pixels: 256 colors, then 256 marks |
| `02 ‖ u64 week ‖ 00…` | The week: `u128 burned ‖ u64 paints ‖ u64 pixels ‖ u128 bid ‖ bidder(32) ‖ u64 end ‖ owner(32) ‖ u128 price ‖ u8 settled`, 137 bytes |
| `03 ‖ u64 week ‖ 00…` | The owner's title, UTF-8, at most 100 bytes |
| `H("app/call-v1/templates", "")` | The template list (TCR-1): `u64 count ‖ count × Bytes(template)` |
| `H("app/call-v1/nonce", account)` | An account's nonce in the program, `u64` (TCR-1) |
| `H("app/call-v1/scheduled", account ‖ u64 sequence)` | A scheduled operation (TCR-1): `u64 execute_at ‖ T ‖ values` |

Keys are 32 bytes, zero-padded. An absent tile is all color 0, never painted; an
absent week is all zero. Tiles are numbered row by row, `tile = (y / 16) ×
(width / 16) + x / 16`, and a pixel within its tile is `(y % 16) × 16 + x % 16`. A
pixel's **mark** is 0 when it was never painted, and else 1 more than the level it
was last painted at. `burned` counts what painting burned, `bid` and `bidder` the
highest bid, `end` the auction's end once a bid set it, `price` what the owner asks,
0 for not for sale.

## Templates

| Template | Pays |
|---|---|
| `paint(week:u64,pixels:list(x:u16,y:u16,color:enum(white\|…),doublings:u8)): On the canvas of week {week}, paint {pixels} pixels, burning {payment}` | A burn |
| `bid(week:u64): Bid {payment} for the canvas of week {week}` | A transfer to the canvas's account |
| `list(week:u64,price:amount): Offer the canvas of week {week} for sale at {price}` | Nothing, or a fee payment |
| `unlist(week:u64): Take the canvas of week {week} off sale` | Nothing, or a fee payment |
| `buy(week:u64): Buy the canvas of week {week} for {payment}` | A transfer of the price to the owner |
| `give(week:u64,to:account): Give the canvas of week {week} to {to}` | Nothing, or a fee payment |
| `name(week:u64,title:text): Call the canvas of week {week} {title}` | Nothing, or a fee payment |
| `unname(week:u64): Remove the name of the canvas of week {week}` | Nothing, or a fee payment |

The paint template's enum holds the palette's names, in order, joined by `|`, so a
wallet shows each pixel's color by name; the deployment builds it, and the template
list holds it first, then the others in the table's order. A pixel is
`u16 x ‖ u16 y ‖ u8 color ‖ u8 doublings`, after the list's `u64 count`. `list`'s
`price` is an `amount`, `coin(32) ‖ u128`, and its coin must be the canvas's
(`bad coin`). The canvas's account is its contract account,
`H("app/account-v1/contract", canvas)`, which holds the highest bid.

Every template's first field is the week, which counts from 1: week 0 reverts
`bad input`. A bid's and a buy's amount is not among the values: it is the
payment's, which the sentence shows as `{payment}`.

The operations that pay need a payment (`needs payment`), and the others take none
or a [fee payment](#calls) (`bad payment` for any other). A payment must be in the canvas's coin (`bad coin`), from the acting
account itself, and of the effect the table says (`bad payment`); a paint's burn
may be more than its price, and all of it is burned.

## Calls

Every call follows TCR-1's *what the program does*. Who may act:

- **A policy account**, `auth = 00 ‖ policy ‖ Bytes(params) ‖ u64 nonce ‖ u64
  valid_until ‖ Bytes(witness)`. With a payment, or an owner's fee payment, the
  payment is the approval and the witness is empty (`bad input` otherwise); the
  program asks no policy, and the coin checks the payment. Without one, the program
  asks the policy for the witness over the call's digest, and its answer may
  schedule the operation.
- **A program, as its own contract account**, `auth = 01`, when it calls the
  canvas (`no calling contract` at top level). It carries no payment (`bad input`),
  so it does only what an owner does (`needs payment` for the rest). A marketplace
  or an escrow can hold canvases this way.

**Fee payments.** List, unlist, give, name and unname move no coins, and take either
no payment or a fee payment: `01 ‖ H("app/account-v1/contract", canvas) ‖ u128 0`, a
transfer of 0 to the canvas's account from the acting account, in the canvas's coin,
which carries only the fee (TCR-1, fee payments). It approves the operation and pays
the miner with one signature, where a witness and a fee paid in a batch take two. Any
other payment for these operations reverts `bad payment`. An account with a delay
cannot make one, the coin refusing its fee (`payment: delayed fee`) and its bound
actions (`payment: delayed binding`), so an operation with a fee payment is never
scheduled.

The canvas refuses a payment from anyone but the acting account, which TCR-1 allows
a program to. It checks the operation's own conditions, which read the canvas and
cost little, before the approval, which costs most, as TCR-1 lets a program: a call
that would fail on them fails before its signature is checked.

### Paint

The week must be the current one: an earlier one reverts `canvas locked`, a later
one or any before the epoch `not open`. There must be at least one pixel
(`bad input`), each within the canvas (`bad pixel`), of a palette color
(`bad color`) and with fewer than 255 doublings (`bad level`). A pixel painted
with `d` doublings, at level `d`, burns `price × 2^d`. Its level must be at least
its mark: any level on a fresh pixel, and over a pixel painted at level `l`, at
least `l + 1`, twice what is on it (`price too low`). Pixels are taken in order, so
a pixel painted twice in one paint pays twice what the first time put on it. The
burn must cover the sum (`underpaid`; `amount overflow` when it cannot be counted).
Painting at a higher level than the least protects a pixel: whoever paints over it
pays twice that.

### Bid, settle

A bid needs its week to have closed (`still painting`), an auction not yet settled
nor past its end with a bid on it (`auction over`), and an amount of at least the
reserve or, over a bid, at least `bid + max(bid / 20, 1)` (`bid too low`); the
amount is the payment's, a transfer to the canvas's account. The program returns
the bid it beat to its bidder, from the canvas's account, and records the new one.

`03 ‖ u64 week` settles an auction past its end with a bid on it, not yet settled
(`not due` otherwise): it burns the bid from the canvas's account, and the bidder
becomes the owner. Anyone may settle, and every owner operation settles first when
it is due.

### Owners

List, unlist, give, name and unname need an owner (`no owner`) who is the acting
account (`not owner`). A listing names a price above 0 (`bad price`), a gift any
account but zero (`bad account`) and takes the canvas off sale, and a title is valid
UTF-8 of 1 to 100 bytes (`bad title`); unname clears it. The program does not check
TOCS-1's text rules, which a title must also keep for a wallet to show it: the page
and a TCR-1 wallet refuse a title that breaks them, and the page does not show one
it finds on chain.

A buy needs the canvas listed (`not for sale`) and a payment of exactly its price
(`price changed`), to the owner (`bad payment`). The buyer becomes the owner and the canvas
leaves the market. A seller who gives the canvas away or changes its price first
makes a waiting purchase fail before it pays anything.

### Accounts with a delay

The canvas holds what accounts own, so it schedules (TCR-1, *now or later*): an
owner operation from an account whose policy answers with a delay, such as a Ting ID
Savings account, is stored and takes effect only after the delay, unless it is
cancelled first. Such an account cannot pay: the coin refuses its tied payment
(`payment: delayed binding`), so it neither paints, bids nor buys. Before
scheduling, the program checks that the account owns the canvas, so nobody
schedules for what is not theirs; when the operation runs, it checks again.

## Other inputs

| Input | |
|---|---|
| `00` | The digest of the call that is paying; `not running` otherwise. The coin's query |
| `03 ‖ u64 week` | Settles an auction that is over |
| `08 ‖ u64 week` | Returns the week's 137-byte record; safe read-only |
| `H("app/call-v1/run", "") ‖ account ‖ u64 sequence` | Runs a scheduled operation (TCR-1) |
| `H("app/call-v1/cancel", "") ‖ …` | Cancels scheduled operations (TCR-1) |

An input shorter than 32 bytes is one of the program's own; any longer one starts
with a template's hash, or with the run's or the cancel's.

## Events

The canvas emits TCR-1's *scheduled*, *executed* and *cancelled*, and events of its
own, whose payload starts with the week's topic and a kind:

```text
topic = H("app/canvas-v1/event", u64 week)
```

so a page reads a week's whole history with one filtered query, as the node's
`/v1/events?contract=…&topic=…` allows.

| Kind | After the topic and the kind byte |
|---|---|
| `01` paint | `painter(32) ‖ u128 burned ‖ u64 count ‖ count × (u16 x ‖ u16 y ‖ u8 color ‖ u8 doublings)` |
| `02` bid | `bidder(32) ‖ u128 amount ‖ u64 end` |
| `03` settled | `owner(32) ‖ u128 amount burned` |
| `04` listed | `owner(32) ‖ u128 price`, 0 when taken off sale |
| `05` sold | `seller(32) ‖ buyer(32) ‖ u128 price` |
| `06` given | `from(32) ‖ to(32)` |
| `07` titled | `owner(32) ‖ Bytes(title)`, empty when removed |

Replaying a week's paint events from a blank canvas reproduces its pixels.

## Costs

With P-256 signatures, measured on a development chain; the signature checks are
most of it.

| Operation | C | S |
|---|---:|---:|
| Paint, a few pixels in one tile | 21.1 million | 31 |
| Paint, each further pixel | about 2,500 | |
| Paint, each further tile | about 10,000 | 2 |
| Bid | 21.1 million | 28 |
| Buy | 21.1 million | 28 |
| List, give or name | 19.4 million | 11 to 13 |
| List, give or name, approved by a fee payment | 21.1 million | 30 |
| Schedule an operation, from a Savings account of Ting ID | 20.8 million | 16 |
| Run a scheduled operation, unsigned | 1.7 million | 10 |
| Settle, unsigned | 2.9 million | 15 |

Every call checks one signature: the payment's when it pays, the call's when it does
not. A plain coin transfer with the same key costs 19.1 million C. At the production
network's 450 million C a block, about 21 paints or 23 owner operations fit in a
block.
