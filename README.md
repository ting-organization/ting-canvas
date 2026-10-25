# Ting Canvas

One canvas a week on [Ting](https://github.com/ting-organization/ting). Anyone
paints it, pixel by pixel, and every paint burns coins. When the week ends the
canvas locks, and nothing can change it again. Then it is auctioned: the winning
bid is burned too, and the winner owns the canvas for good, to name, give away or
sell.

No one earns from painting: not the painters, not the miners beyond an ordinary
fee, not whoever deployed the program. The coins are destroyed.

It is two pieces:

- **The canvas program** (`program/`, built to `canvas.wasm`): a Ting program that
  keeps the canvases, takes the burns and bids, runs the auctions and records the
  owners. [SPEC.md](SPEC.md) states its rules.
- **The page** (`web/`): a static web client, plain HTML, CSS and JavaScript with
  no build step and no third-party code, that reads the chain from a node and signs
  in the browser, or hands each action to Ting ID as a call link. It can be hosted
  anywhere, GitHub Pages included.

Every action is a call of [TCR-1](../ting-id/TCR-1.md), Ting Call Requests: a
sentence in the program's own words, signed by the account that acts.

## Why it works this way

**Burned, not locked.** Burning makes painting a real cost that nobody collects.
Locking the coins for a time and handing them back later would make painting free
in the long run: whoever has the most coins could repaint everything and get it all
back, and the program would have to hold everyone's coins for years in code that
can never be patched. A burn needs the program to hold nothing.

**Painting over a pixel burns twice what is on it.** A fresh pixel costs the price;
over one painted for 1 price it costs 2, over that 4, and so on. A painter who wants
their work to last can protect it up front: paint at ×4, and anyone painting over
it burns at least ×8. Fights over a pixel get expensive fast, and finished art
costs more to deface than it cost to make.

**Every action is approved, and a payment pays for that one action.** The acting
account approves the operation itself, in the program's words (TCR-1), through its
policy, so any kind of account can play: a key in this browser, a Ting ID identity,
a multisig. An action that moves coins carries a coin payment from that account,
bound to the operation's digest (a *bound action*, wiki: programs/conventions): the
coin runs it only inside that call, and its check of the payment is the approval,
so every call checks one signature. An owner's action, which moves no coins,
carries a *fee payment* instead: a transfer of 0 to the canvas's account that pays
the miner, and approves the action with the same single signature. A program can
own canvases too, acting as its own account, which leaves room for a marketplace
or an escrow built on top.

**The auction is English, with a soft close.** It opens when the canvas locks and
runs for a week, alongside the next canvas. The program holds the highest bid and
returns the one it beats in the same transaction. Each bid must beat the last by
5%, and a bid in the last hour moves the end an hour on, so there is no sniping
before the gavel. An auction that ends without a bid waits for its first. The
winning bid is burned.

**Then it is property.** The winner owns the canvas. They can name it, give it
away, or list it at a price; a buyer pays the owner and becomes the owner in one
transaction, so neither side can cheat the other. Kept in a Ting ID Savings
account, a canvas keeps the account's time lock: whatever its owner does with it
waits for the delay and can be cancelled meanwhile, so a stolen key cannot take it.

**The page trusts nothing it can check.** Before signing it checks the CodeHash of
the canvas program, of its coin and of the signature policy against the code it was
written for, and it refuses a canvas that runs anything else.

## Signing

The wallet panel chooses who signs.

**Ting ID.** Each action becomes a `ting:call` link, as a QR code or a link to open
on the phone, its values compressed as `zvalues` whenever that is shorter. The
paint template names the palette's colors as an enum, so Ting ID shows each
pixel's color by name, and a bid or a purchase shows its amount as the payment
Ting ID checked itself. A link
under 1,000 characters, which scans well off a screen, holds a stroke of about 200
pixels, or about 95 scattered ones, the template with its sixteen color names taking
a third of it; a longer paint is opened on the phone, or signed in this browser. Ting ID shows the action in the program's words and what leaves the
account, signs it with the account the user picks, and submits it; the page finds
the operation in the program's *executed* events, or its *scheduled* one for an
account with a delay. No server is involved. Owner actions carry `from`, so only the
owner's account can sign them; `coin`, so Ting ID can approve them with a fee
payment from Spending; and `delayed=1`, so a Savings account can, with its
signature. Each link
also carries the page's address as `return`: once Ting ID sent the call it offers to
open it, with `#ting-tx=` and the TransactionId, and the page follows that
transaction into a block and shows its week.
`scripts/tcr-wallet.mjs` stands in for Ting ID on a development chain until it
implements TCR-1.

**This browser.** The page keeps one P-256 key in the browser's storage: an account of Ting's
reference `policy-p256`. Ting's signing digest is SHA-256 over a fixed prefix and
the message, and WebCrypto's ECDSA hashes what it signs with SHA-256, so the
browser signs Ting messages with its own built-in cryptography. No library is
involved, and WebCrypto needs a secure origin, which GitHub Pages is.

The account is funded from [Ting ID](https://github.com/ting-organization/ting-id)
with a `ting:pay` link, as a QR code or a link that opens the app. The wallet
panel downloads a backup of the key. It is a hot wallet: whoever holds the key or
the backup controls the account, so it should hold what its owner means to paint
and bid with, no more.

## Layout

| Path | Contents |
|---|---|
| [SPEC.md](SPEC.md) | The program's rules: records, operations, events, errors, costs |
| `program/` | The program, Rust for `wasm32v1-none`, no dependencies, with its own SHA-256 |
| `canvas.wasm` | The program as deployed, packed |
| `tools/` | The packer, and the tests that run the program on Ting's reference VM against the real coin |
| `web/` | The page; `web/js/tcr.js` is TCR-1 on its own, for any program's page |
| `docs/tcr-1-vectors.json` | TCR-1's shared test vectors, written by `scripts/tcr-vectors.mjs` from the page's modules and checked in Rust by `tools/tests/vectors.rs` |
| `scripts/devchain.mjs` | A development chain: deploys everything, funds accounts, runs a canvas's whole life end to end |
| `scripts/tcr-wallet.mjs` | A stand-in for a TCR-1 wallet: reads a `ting:call` link, checks it against the program's template list, and completes it on a development chain |
| `scripts/deploy.mjs` | Shows, and with `--submit` sends, the deployment on a network |
| `scripts/serve.py` | Serves `web/` locally without caching |

`tools/` builds against Ting's reference core, checked out beside this repository
as `../ting-reference`.

## Build and test

```sh
./build.sh
cargo test --release --locked -p ting-canvas-tools
```

`build.sh` compiles the program and packs it into `canvas.wasm`, checked against
Ting's execution profile; it prints the CodeHash, which `web/js/config.js` must
match. The tests deploy the reference coin and the canvas on Ting's reference VM and
go through painting, prices, locking, replays, the auction, settlement and every
owner operation; `vectors.rs` rebuilds every hash, message and call of TCR-1's test
vectors, and `node scripts/tcr-vectors.mjs --check` that the page's modules still
write them.

On macOS, if linking fails with `unknown architecture arm64e.x1-macos`, the
command-line tools' newest SDK is ahead of their linker:
`export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk` (or the
SDK matching the system) fixes it.

## A development chain

A node of its own, with its own ports, beside any other node:

```sh
ting --data-dir dev init --dev --api --control 127.0.0.1:28440 --p2p 127.0.0.1:28442 --api-bind 127.0.0.1:28441
ting --data-dir dev api enable --cors
ting --data-dir dev start
ting --data-dir dev miner start --spacing 2
node scripts/devchain.mjs setup --period 600
```

`setup` deploys the reference P-256 policy and identity registry, a test coin
whose supply goes to a faucet, and a canvas with ten-minute weeks, and prints the
page's address for it. Serve the page with `python3 scripts/serve.py` and open it
with that query string; `node scripts/devchain.mjs fund <account> 5` sends the
page's wallet 5 test coins, and `node scripts/tcr-wallet.mjs '<link>'` completes a
call link the page shows in Ting ID mode. `node scripts/devchain.mjs e2e` runs a
canvas of 90-second weeks through the page's own modules, with real signatures:
browser wallets and an identity paint, bid and win; the identity's Savings account
offers the canvas for sale, which waits for its delay, and cancels a second
operation; then it is sold, named and given away.

## Deploying

```sh
node scripts/deploy.mjs
```

shows the production deployment: Daler, weeks from Monday 26 October 2026 00:00
UTC, 128 × 128 pixels, 16 colors, 0.0001 DLR a fresh pixel, a week-long auction
with a 0.01 DLR reserve and a one-hour soft close. Options change any of these. Run it
again with `--submit` to deploy, then put the ContractId it prints into
`web/js/config.js`.

A deployment is for good. Its prices, size, palette and timing can never change; a
canvas with other options is another deployment, with another ContractId.

## Hosting

`web/` is the whole site. `.github/workflows/pages.yml` publishes it to GitHub
Pages on every push to `master` that changes it (Settings → Pages → Source: GitHub
Actions). Any static host works the same way. The page talks to
`https://node1.ting-node.com` by default, which answers browsers from any origin;
`?node=<url>&canvas=<id>` points it elsewhere.

## Licence

Licensed under either of Apache License, Version 2.0 or MIT license, at your option.
