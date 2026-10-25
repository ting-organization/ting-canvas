//! The canvas program on Ting's reference VM, paying through the real coin
//! program. Accounts sign through stub policies that approve every message,
//! one at once and one only after a delay, as a savings account does: accounts
//! are told apart by their policy and params, which is all the canvas and the
//! coin see of who signed. The dev-chain run (scripts/devchain.mjs e2e)
//! checks real signatures and identities.
use std::fs;
use ting_core::{
    hash::{hash, hash_parts},
    meter::Resources,
    protocol::{Genesis, Payload, Receipt, Status, Transaction},
    state::State,
    vm::{Context, Runtime, profile},
};

type Id = [u8; 32];

const BUDGET: Resources = Resources([200_000_000, 4096, 4_000_000, 4_000_000]);
const PERIOD: u64 = 1000;
const AUCTION: u64 = 500;
const EXTENSION: u64 = 100;
const PRICE: u128 = 100;
const RESERVE: u128 = 1000;
const SIDE: u16 = 32;
const DELAY: u64 = 100;

const BID: &str = "bid(week:u64): Bid {payment} for the canvas of week {week}";
const LIST: &str = "list(week:u64,price:amount): Offer the canvas of week {week} for sale at {price}";
const UNLIST: &str = "unlist(week:u64): Take the canvas of week {week} off sale";
const BUY: &str = "buy(week:u64): Buy the canvas of week {week} for {payment}";
const GIVE: &str = "give(week:u64,to:account): Give the canvas of week {week} to {to}";
const NAME: &str = "name(week:u64,title:text): Call the canvas of week {week} {title}";
const UNNAME: &str = "unname(week:u64): Remove the name of the canvas of week {week}";

/// The test canvas's palette: its colors' names and their RGB.
const COLORS: [(&str, [u8; 3]); 4] = [("white", [255, 255, 255]), ("black", [0, 0, 0]), ("red", [255, 0, 0]), ("blue", [0, 0, 255])];

/// The paint template the deployment builds from a palette's names.
fn paint_template(names: &[&str]) -> String {
    format!(
        "paint(week:u64,pixels:list(x:u16,y:u16,color:enum({}),doublings:u8)): On the canvas of week {{week}}, paint {{pixels}} pixels, burning {{payment}}",
        names.join("|")
    )
}

fn paint_t() -> String {
    paint_template(&COLORS.map(|(name, _)| name))
}

/// Answers `01` to every policy query, and nothing to its deployment.
const INSTANT_POLICY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\01")
  (func (export "invoke")
    (call $return (i32.const 0)
      (i32.ne (call $input (i32.const 0) (i32.const 0)) (i32.const 0)))))"#;

/// Answers `01 ‖ u64 100`: authorized only 100 seconds ahead.
const DELAYED_POLICY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\01\64\00\00\00\00\00\00\00")
  (func (export "invoke")
    (call $return (i32.const 0)
      (select (i32.const 9) (i32.const 0) (call $input (i32.const 0) (i32.const 0))))))"#;

/// Calls `target(32)` with the rest of its input, so that its own contract
/// account acts: a stand-in for a marketplace or an escrow.
const PROXY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "call" (func $call (param i32 i32 i32 i32 i32) (result i32)))
  (import "ting" "call_result" (func $result (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (import "ting" "revert" (func $revert (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\00\2d\31\01\00\00\00\00\00\02\00\00\00\00\00\00\40\0d\03\00\00\00\00\00\40\0d\03\00\00\00\00\00")
  (func (export "invoke")
    (local $n i32) (local $status i32) (local $r i32)
    (local.set $n (call $input (i32.const 64) (i32.const 4096)))
    (if (i32.eqz (local.get $n)) (then (call $return (i32.const 0) (i32.const 0)) (return)))
    (local.set $status (call $call (i32.const 64) (i32.const 96)
      (i32.sub (local.get $n) (i32.const 32)) (i32.const 0) (i32.const 0)))
    (local.set $r (call $result (i32.const 8192) (i32.const 4096)))
    (if (local.get $status)
      (then (call $revert (i32.const 8192) (local.get $r)))
      (else (call $return (i32.const 8192) (local.get $r))))))"#;

/// Answers `00`: authorizes nothing.
const REFUSING_POLICY: &str = r#"(module
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (func (export "invoke") (call $return (i32.const 0) (i32.const 1))))"#;

fn bytes(b: &[u8]) -> Vec<u8> {
    [&(b.len() as u32).to_le_bytes()[..], b].concat()
}

fn template(text: &str) -> Id {
    hash("app/call-v1/template", text.as_bytes())
}

fn topic(week: u64) -> Id {
    hash("app/canvas-v1/event", &week.to_le_bytes())
}

fn week_key(kind: u8, week: u64) -> Id {
    let mut key = [0; 32];
    key[0] = kind;
    key[1..9].copy_from_slice(&week.to_le_bytes());
    key
}

fn tile_key(week: u64, tile: u16) -> Id {
    let mut key = week_key(1, week);
    key[9..11].copy_from_slice(&tile.to_le_bytes());
    key
}

fn contract_account(owner: &Id) -> Id {
    hash("app/account-v1/contract", owner)
}

fn burn(amount: u128) -> Vec<u8> {
    [&[2][..], &amount.to_le_bytes()].concat()
}

fn transfer(to: &Id, amount: u128) -> Vec<u8> {
    [&[1][..], to, &amount.to_le_bytes()].concat()
}

/// The head of a call: its template's hash and its values.
fn head(text: &str, values: &[&[u8]]) -> Vec<u8> {
    [&template(text)[..], &values.concat()].concat()
}

/// A paint of `(pixel, color, doublings)`, the pixel `y × SIDE + x`.
fn paint_head(week: u64, pixels: &[(u32, u8, u8)]) -> Vec<u8> {
    let mut list = (pixels.len() as u64).to_le_bytes().to_vec();
    for (index, color, doublings) in pixels {
        let (x, y) = ((index % u32::from(SIDE)) as u16, (index / u32::from(SIDE)) as u16);
        list.extend(x.to_le_bytes());
        list.extend(y.to_le_bytes());
        list.extend([*color, *doublings]);
    }
    head(&paint_t(), &[&week.to_le_bytes(), &list])
}

fn run_input(account: &Id, sequence: u64) -> Vec<u8> {
    [hash("app/call-v1/run", b"").to_vec(), account.to_vec(), sequence.to_le_bytes().to_vec()].concat()
}

fn config(coin: &Id, epoch: u64, side: u16) -> Vec<u8> {
    config_with(coin, epoch, side, &COLORS)
}

fn config_with(coin: &Id, epoch: u64, side: u16, colors: &[(&str, [u8; 3])]) -> Vec<u8> {
    let mut c = vec![1];
    c.extend(coin);
    c.extend(epoch.to_le_bytes());
    c.extend(PERIOD.to_le_bytes());
    c.extend(side.to_le_bytes());
    c.extend(side.to_le_bytes());
    c.extend(PRICE.to_le_bytes());
    c.extend(AUCTION.to_le_bytes());
    c.extend(EXTENSION.to_le_bytes());
    c.extend(RESERVE.to_le_bytes());
    c.push(colors.len() as u8);
    for (name, rgb) in colors {
        c.extend(rgb);
        c.extend(bytes(name.as_bytes()));
    }
    c
}

#[track_caller]
fn ok(r: &Receipt) {
    assert_eq!(r.status, Status::Success, "{}", String::from_utf8_lossy(&r.result));
}

#[track_caller]
fn reverts(r: &Receipt, reason: &str) {
    assert_eq!(r.status, Status::Revert, "expected a revert with {reason}");
    assert_eq!(String::from_utf8_lossy(&r.result), reason);
}

/// The week record's fields, in order.
#[derive(Debug, PartialEq, Default)]
struct Week {
    burned: u128,
    paints: u64,
    pixels: u64,
    bid: u128,
    bidder: Id,
    end: u64,
    owner: Id,
    price: u128,
    settled: bool,
}

/// How a test call is made: by which account, with which nonce and deadline,
/// and what it pays, from which account.
struct Act<'a> {
    policy: Id,
    who: &'a [u8],
    nonce: Option<u64>,
    valid_until: u64,
    effect: Option<Vec<u8>>,
    /// The paying account's policy and params, when not the acting account.
    payer: Option<(Id, &'a [u8])>,
    coin: Option<Id>,
    /// What the call carries as the account's witness, empty by default.
    witness: &'a [u8],
}

struct Chain {
    state: State,
    context: Context,
    coin: Id,
    instant: Id,
    delayed: Id,
    canvas: Id,
    epoch: u64,
    fee: u128,
}

impl Chain {
    /// Alice, Bob and Carol hold 1,000,000 each; the canvas opens 10 seconds in.
    fn new() -> Self {
        let g = Genesis::experimental();
        let mut chain = Chain {
            state: State::default(),
            context: Context::from_genesis(&g),
            coin: [0; 32],
            instant: [0; 32],
            delayed: [0; 32],
            canvas: [0; 32],
            epoch: 0,
            fee: 0,
        };
        chain.instant = chain.deploy(wasm(INSTANT_POLICY), Vec::new());
        chain.delayed = chain.deploy(wasm(DELAYED_POLICY), Vec::new());
        let mut coin = vec![1];
        coin.extend(bytes(b"Daler"));
        coin.extend(bytes(b"DLR"));
        coin.push(8);
        coin.extend(u128::MAX.to_le_bytes());
        coin.extend([0; 16 + 8 + 16 + 32]);
        coin.extend(3u64.to_le_bytes());
        for who in [b"alice".as_slice(), b"bob", b"carol"] {
            coin.extend(chain.account(who));
            coin.extend(1_000_000u128.to_le_bytes());
        }
        chain.coin = chain.deploy(read("../../ting-reference/programs/coin.wasm"), coin);
        chain.epoch = chain.context.timestamp + 10;
        chain.canvas = chain.deploy(canvas(), config(&chain.coin, chain.epoch, SIDE));
        chain
    }

    fn run(&mut self, payload: Payload) -> Receipt {
        let runtime = Runtime::new(self.state.clone(), self.context.clone());
        let receipt = runtime.execute(&Transaction { budget: BUDGET, payload }).unwrap();
        // Against an empty reader, the changes list every record that exists.
        let mut state = State::default();
        for change in runtime.state_changes().unwrap().records {
            if change.after.is_some() {
                state.set(change.key, change.after);
            }
        }
        state.commit();
        self.state = state;
        receipt
    }

    fn deploy(&mut self, code: Vec<u8>, input: Vec<u8>) -> Id {
        let r = self.run(Payload::Deploy { code, input });
        ok(&r);
        r.result.try_into().unwrap()
    }

    fn call(&mut self, input: Vec<u8>) -> Receipt {
        self.run(Payload::Call {
            target: self.canvas,
            input,
        })
    }

    /// A later block at `seconds` past the epoch.
    fn at(&mut self, seconds: u64) {
        self.context.height += 1;
        self.context.timestamp = self.epoch + seconds;
    }

    fn storage(&self, contract: Id, key: Id) -> Option<Vec<u8>> {
        Runtime::new(self.state.clone(), self.context.clone()).storage(contract, key)
    }

    fn account(&self, who: &[u8]) -> Id {
        self.account_of(&self.instant, who)
    }

    fn account_of(&self, policy: &Id, who: &[u8]) -> Id {
        hash_parts(
            "app/account-v1/policy",
            &[policy, &(who.len() as u32).to_le_bytes(), who],
        )
    }

    fn coin_record(&self, account: &Id) -> (u128, u64) {
        match self.storage(self.coin, *account) {
            None => (0, 0),
            Some(r) => (
                u128::from_le_bytes(r[..16].try_into().unwrap()),
                u64::from_le_bytes(r[32..40].try_into().unwrap()),
            ),
        }
    }

    fn balance(&self, who: &[u8]) -> u128 {
        self.coin_record(&self.account(who)).0
    }

    fn held(&self) -> u128 {
        self.coin_record(&contract_account(&self.canvas)).0
    }

    fn burned(&self) -> u128 {
        let mut key = [0; 32];
        key[31] = 1;
        let state = self.storage(self.coin, key).unwrap();
        u128::from_le_bytes(state[16..32].try_into().unwrap())
    }

    /// An account's nonce in the canvas (TCR-1).
    fn nonce(&self, account: &Id) -> u64 {
        let key = hash("app/call-v1/nonce", account);
        self.storage(self.canvas, key)
            .map_or(0, |v| u64::from_le_bytes(v.try_into().unwrap()))
    }

    /// The call `act` makes of `head`: signed, and paid when it has an effect.
    fn input(&self, head: &[u8], act: &Act) -> Vec<u8> {
        let account = self.account_of(&act.policy, act.who);
        let nonce = act.nonce.unwrap_or_else(|| self.nonce(&account));
        let operation = hash("app/call-v1/operation", head);
        let chain = Genesis::experimental().chain_id();
        let message = [
            bytes(b"app/call-v1"),
            chain.to_vec(),
            self.canvas.to_vec(),
            account.to_vec(),
            vec![1],
            nonce.to_le_bytes().to_vec(),
            act.valid_until.to_le_bytes().to_vec(),
            operation.to_vec(),
        ]
        .concat();
        let digest = hash("app/sign-v1", &message);
        let mut input = [head, &[0], &act.policy[..], &bytes(act.who), &nonce.to_le_bytes(), &act.valid_until.to_le_bytes(), &bytes(act.witness)].concat();
        match &act.effect {
            None => input.push(0),
            Some(effect) => {
                let (payer_policy, payer) = act.payer.unwrap_or((act.policy, act.who));
                let coin_nonce = self.coin_record(&self.account_of(&payer_policy, payer)).1;
                let mut a = vec![0x10, 0x00];
                a.extend(payer_policy);
                a.extend(bytes(payer));
                a.extend(coin_nonce.to_le_bytes());
                a.extend(bytes(b""));
                a.extend(effect);
                a.extend(self.fee.to_le_bytes());
                a.extend([0; 16 + 8 + 8]);
                a.push(1);
                a.extend(self.canvas);
                a.extend(digest);
                input.push(1);
                input.extend(act.coin.unwrap_or(self.coin));
                input.extend(bytes(&a));
            }
        }
        input
    }

    /// A call by `who`, an account of the instant policy, paying `effect` if any.
    fn act(&mut self, who: &[u8], head: Vec<u8>, effect: Option<Vec<u8>>) -> Receipt {
        let act = Act { policy: self.instant, who, nonce: None, valid_until: 0, effect, payer: None, coin: None, witness: b"" };
        let input = self.input(&head, &act);
        self.call(input)
    }

    fn act_with(&mut self, head: Vec<u8>, act: Act) -> Receipt {
        let input = self.input(&head, &act);
        self.call(input)
    }

    /// A plain transfer from `who`, an account of the instant policy.
    fn fund(&mut self, who: &[u8], to: &Id, amount: u128) {
        let nonce = self.coin_record(&self.account(who)).1;
        let mut a = vec![0x10, 0x00];
        a.extend(self.instant);
        a.extend(bytes(who));
        a.extend(nonce.to_le_bytes());
        a.extend(bytes(b""));
        a.extend(transfer(to, amount));
        a.extend([0; 16 + 16 + 8 + 8 + 1]);
        let coin = self.coin;
        ok(&self.run(Payload::Call { target: coin, input: a }));
    }

    fn amount(&self, value: u128) -> Vec<u8> {
        [&self.coin[..], &value.to_le_bytes()].concat()
    }

    fn paint(&mut self, who: &[u8], week: u64, pixels: &[(u32, u8, u8)], amount: u128) -> Receipt {
        self.act(who, paint_head(week, pixels), Some(burn(amount)))
    }

    fn bid(&mut self, who: &[u8], week: u64, amount: u128) -> Receipt {
        let head = head(BID, &[&week.to_le_bytes()]);
        let vault = contract_account(&self.canvas);
        self.act(who, head, Some(transfer(&vault, amount)))
    }

    fn settle(&mut self, week: u64) -> Receipt {
        self.call([&[3][..], &week.to_le_bytes()].concat())
    }

    fn list_head(&self, week: u64, price: u128) -> Vec<u8> {
        head(LIST, &[&week.to_le_bytes(), &self.amount(price)])
    }

    fn list(&mut self, who: &[u8], week: u64, price: u128) -> Receipt {
        let head = self.list_head(week, price);
        self.act(who, head, None)
    }

    fn buy(&mut self, who: &[u8], week: u64, price: u128, seller: &Id) -> Receipt {
        let head = head(BUY, &[&week.to_le_bytes()]);
        self.act(who, head, Some(transfer(seller, price)))
    }

    fn give(&mut self, who: &[u8], week: u64, to: &Id) -> Receipt {
        self.act(who, head(GIVE, &[&week.to_le_bytes(), to]), None)
    }

    fn title(&mut self, who: &[u8], week: u64, title: &[u8]) -> Receipt {
        self.act(who, head(NAME, &[&week.to_le_bytes(), &bytes(title)]), None)
    }

    /// Week 1 auctioned, won by `who` and settled.
    fn won(&mut self, who: &[u8]) {
        self.at(PERIOD);
        ok(&self.bid(who, 1, RESERVE));
        self.at(PERIOD + AUCTION);
        ok(&self.settle(1));
    }

    fn week(&self, week: u64) -> Week {
        let Some(r) = self.storage(self.canvas, week_key(2, week)) else {
            return Week::default();
        };
        assert_eq!(r.len(), 137);
        let id = |at: usize| -> Id { r[at..at + 32].try_into().unwrap() };
        Week {
            burned: u128::from_le_bytes(r[0..16].try_into().unwrap()),
            paints: u64::from_le_bytes(r[16..24].try_into().unwrap()),
            pixels: u64::from_le_bytes(r[24..32].try_into().unwrap()),
            bid: u128::from_le_bytes(r[32..48].try_into().unwrap()),
            bidder: id(48),
            end: u64::from_le_bytes(r[80..88].try_into().unwrap()),
            owner: id(88),
            price: u128::from_le_bytes(r[120..136].try_into().unwrap()),
            settled: r[136] == 1,
        }
    }

    /// A pixel's color and its mark: 0 never painted, else its level plus 1.
    fn pixel(&self, week: u64, index: u32) -> (u8, u8) {
        let (x, y) = (index % u32::from(SIDE), index / u32::from(SIDE));
        let tile = (y / 16 * (u32::from(SIDE) / 16) + x / 16) as u16;
        let at = (y % 16 * 16 + x % 16) as usize;
        match self.storage(self.canvas, tile_key(week, tile)) {
            None => (0, 0),
            Some(t) => (t[at], t[256 + at]),
        }
    }

    fn scheduled(&self, account: &Id, sequence: u64) -> Option<Vec<u8>> {
        let key = hash_parts("app/call-v1/scheduled", &[account, &sequence.to_le_bytes()]);
        self.storage(self.canvas, key)
    }
}

fn read(path: &str) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn wasm(text: &str) -> Vec<u8> {
    ting_canvas_tools::pack(&wat::parse_str(text).unwrap()).unwrap()
}

fn canvas() -> Vec<u8> {
    let code = read("../canvas.wasm");
    profile::validate(&code).unwrap();
    code
}

fn executed(account: &Id, sequence: u64, head: &[u8]) -> Vec<u8> {
    let mut e = hash("app/call-v1/event/executed", b"").to_vec();
    e.extend(account);
    e.extend(sequence.to_le_bytes());
    e.extend(hash("app/call-v1/operation", head));
    e
}

#[test]
fn deployment_takes_a_valid_configuration_and_lists_the_templates() {
    let mut chain = Chain::new();
    let coin = chain.coin;
    let epoch = chain.epoch;
    let long: Vec<String> = (0..20).map(|i| format!("a color named at length {i:02}")).collect();
    let long: Vec<(&str, [u8; 3])> = long.iter().map(|n| (n.as_str(), [0, 0, 0])).collect();
    for bad in [
        Vec::new(),
        config(&coin, epoch, 20),
        config(&coin, epoch, 0),
        [config(&coin, epoch, SIDE), vec![0]].concat(),
        // Colors are named as an enum's labels may be, once each, and the
        // paint template they make fits TCR-1's 512 bytes.
        config_with(&coin, epoch, SIDE, &[("white", [255; 3]), ("", [0; 3])]),
        config_with(&coin, epoch, SIDE, &[("white", [255; 3]), ("white", [0; 3])]),
        config_with(&coin, epoch, SIDE, &[("white", [255; 3]), ("black|red", [0; 3])]),
        config_with(&coin, epoch, SIDE, &[("white", [255; 3]), (" black", [0; 3])]),
        config_with(&coin, epoch, SIDE, &[("white", [255; 3]), (&"b".repeat(33), [0; 3])]),
        config_with(&coin, epoch, SIDE, &long),
    ] {
        let r = chain.run(Payload::Deploy {
            code: canvas(),
            input: bad,
        });
        reverts(&r, "bad deploy input");
    }
    assert_eq!(chain.storage(chain.canvas, [0; 32]), Some(config(&coin, epoch, SIDE)));
    let paint = paint_t();
    let templates = [paint.as_str(), BID, LIST, UNLIST, BUY, GIVE, NAME, UNNAME];
    let mut listed = (templates.len() as u64).to_le_bytes().to_vec();
    for t in templates {
        listed.extend(bytes(t.as_bytes()));
    }
    let key = hash("app/call-v1/templates", b"");
    assert_eq!(chain.storage(chain.canvas, key), Some(listed));
}

#[test]
fn painting_over_a_pixel_burns_twice_what_is_on_it() {
    let mut chain = Chain::new();
    chain.at(0);
    // Fresh pixels at level 0 burn one price each.
    let r = chain.paint(b"alice", 1, &[(0, 1, 0), (1, 2, 0), (33, 3, 0)], 300);
    ok(&r);
    assert_eq!(chain.balance(b"alice"), 1_000_000 - 300);
    assert_eq!(chain.burned(), 300);
    assert_eq!(chain.pixel(1, 0), (1, 1));
    assert_eq!(chain.pixel(1, 33), (3, 1));
    let alice = chain.account(b"alice");
    let painted = paint_head(1, &[(0, 1, 0), (1, 2, 0), (33, 3, 0)]);
    let ours: Vec<_> = r.events.iter().filter(|e| e.contract == chain.canvas).collect();
    let mut expected = topic(1).to_vec();
    expected.push(1);
    expected.extend(alice);
    expected.extend(300u128.to_le_bytes());
    expected.extend(&painted[40..]);
    assert_eq!(ours[0].payload, expected);
    assert_eq!(ours[1].payload, executed(&alice, 0, &painted));
    assert_eq!(chain.nonce(&alice), 1);

    // Over a level-0 pixel takes level 1: twice the price.
    reverts(&chain.paint(b"bob", 1, &[(0, 3, 0)], 100), "price too low");
    reverts(&chain.paint(b"bob", 1, &[(0, 3, 1)], 199), "underpaid");
    ok(&chain.paint(b"bob", 1, &[(0, 3, 1)], 200));
    assert_eq!(chain.pixel(1, 0), (3, 2));
    // A painter protects a pixel by paying more: level 3 is 8 prices, and
    // painting over it then takes level 4, 16 prices.
    ok(&chain.paint(b"carol", 1, &[(5, 2, 3)], 800));
    reverts(&chain.paint(b"bob", 1, &[(5, 1, 3)], 800), "price too low");
    ok(&chain.paint(b"bob", 1, &[(5, 1, 4)], 1600));
    // Twice in one paint: the second is over the first.
    reverts(&chain.paint(b"bob", 1, &[(16, 1, 0), (16, 2, 0)], 300), "price too low");
    ok(&chain.paint(b"bob", 1, &[(16, 1, 0), (16, 2, 1)], 300));
    assert_eq!(chain.pixel(1, 16), (2, 2));
    // Paying more than the price is allowed, and burned.
    ok(&chain.paint(b"carol", 1, &[(1023, 1, 0)], 500));
    assert_eq!(chain.burned(), 300 + 200 + 800 + 1600 + 300 + 500);
    assert_eq!(
        chain.week(1),
        Week {
            burned: 3700,
            paints: 6,
            pixels: 9,
            ..Week::default()
        }
    );
    reverts(&chain.paint(b"bob", 1, &[(1024, 1, 0)], 100), "bad pixel");
    reverts(&chain.paint(b"bob", 1, &[(6, 4, 0)], 100), "bad color");
    reverts(&chain.paint(b"bob", 1, &[(6, 1, 255)], 100), "bad level");
    reverts(&chain.paint(b"bob", 1, &[(6, 1, 200)], 100), "amount overflow");
    reverts(&chain.paint(b"bob", 1, &[], 100), "bad input");
}

#[test]
fn a_canvas_is_painted_only_in_its_week() {
    let mut chain = Chain::new();
    chain.context.timestamp = chain.epoch - 1;
    reverts(&chain.paint(b"alice", 1, &[(0, 1, 0)], 100), "not open");
    chain.at(PERIOD - 1);
    ok(&chain.paint(b"alice", 1, &[(0, 1, 0)], 100));
    reverts(&chain.paint(b"alice", 2, &[(0, 1, 0)], 100), "not open");
    reverts(&chain.paint(b"alice", 0, &[(0, 1, 0)], 100), "bad input");
    chain.at(PERIOD);
    reverts(&chain.paint(b"alice", 1, &[(0, 2, 1)], 200), "canvas locked");
    ok(&chain.paint(b"alice", 2, &[(0, 2, 0)], 100));
    assert_eq!(chain.pixel(1, 0), (1, 1));
    assert_eq!(chain.pixel(2, 0), (2, 1));
}

#[test]
fn a_signature_and_a_payment_are_each_good_for_one_operation() {
    let mut chain = Chain::new();
    chain.won(b"alice");
    let alice = chain.account(b"alice");
    let instant = chain.instant;
    let by_alice = |nonce: u64| Act { policy: instant, who: b"alice", nonce: Some(nonce), valid_until: 0, effect: None, payer: None, coin: None, witness: b"" };

    // A signed call is good once: the program's nonce.
    let list = chain.list_head(1, 5);
    let input = chain.input(&list, &by_alice(chain.nonce(&alice)));
    ok(&chain.call(input.clone()));
    reverts(&chain.call(input), "bad nonce");
    reverts(&chain.act_with(list.clone(), by_alice(9)), "bad nonce");
    let n = chain.nonce(&alice);
    let now = chain.context.timestamp;
    reverts(&chain.act_with(list.clone(), Act { valid_until: now - 1, ..by_alice(n) }), "expired");
    // A policy that authorizes nothing, for an account that owns the canvas.
    let refusing = chain.deploy(wasm(REFUSING_POLICY), Vec::new());
    let refused = chain.account_of(&refusing, b"alice");
    ok(&chain.give(b"alice", 1, &refused));
    reverts(&chain.act_with(chain.list_head(1, 6), Act { policy: refusing, ..by_alice(0) }), "not authorized");

    // A payment is bound to the digest of the one signed call it pays for.
    chain.at(2 * PERIOD);
    let n = chain.nonce(&alice);
    let paid = |nonce: u64| Act { effect: Some(burn(100)), ..by_alice(nonce) };
    let mine = paint_head(3, &[(1, 1, 0)]);
    let theirs = paint_head(3, &[(2, 1, 0)]);
    let other = chain.input(&theirs, &paid(n));
    reverts(&chain.call([mine.clone(), other[theirs.len()..].to_vec()].concat()), "not bound");
    // From another account than the one that acts.
    reverts(&chain.act_with(mine.clone(), Act { payer: Some((instant, b"bob")), ..paid(n) }), "bad payment");
    // In another coin than the canvas's.
    reverts(&chain.act_with(mine.clone(), Act { coin: Some([7; 32]), ..paid(n) }), "bad coin");
    // A payment from the acting account is its approval: the call carries no witness.
    reverts(&chain.act_with(mine.clone(), Act { witness: b"signature", ..paid(n) }), "bad input");
    // A transfer is not a burn; a paint needs a payment; an owner's call takes
    // none, or a fee payment, a transfer of exactly 0 to the canvas's account.
    let bob = chain.account(b"bob");
    reverts(&chain.act(b"alice", mine.clone(), Some(transfer(&bob, 100))), "bad payment");
    reverts(&chain.act(b"alice", mine.clone(), None), "needs payment");
    let vault = contract_account(&chain.canvas);
    let list = chain.list_head(1, 6);
    reverts(&chain.act(b"alice", list.clone(), Some(transfer(&vault, 1))), "bad payment");
    reverts(&chain.act(b"alice", list.clone(), Some(transfer(&bob, 0))), "bad payment");
    reverts(&chain.act(b"alice", list, Some(burn(0))), "bad payment");
    // An amount in another coin.
    let foreign = head(LIST, &[&1u64.to_le_bytes(), &[7; 32], &6u128.to_le_bytes()]);
    reverts(&chain.act(b"alice", foreign, None), "bad coin");
    // A template the program does not have, and a call cut short.
    let unknown = [hash("app/call-v1/template", b"Paint everything"), [0; 32]].concat();
    reverts(&chain.call(unknown), "bad input");
    reverts(&chain.call(mine), "bad input");
    // None of them paid anything.
    assert_eq!(chain.burned(), RESERVE);
    reverts(&chain.call(vec![0]), "not running");
}

#[test]
fn the_fee_goes_to_the_blocks_producer_and_nothing_else_leaves() {
    let mut chain = Chain::new();
    let miner = chain.account(b"miner");
    chain.context.producer = [b"OCP1".as_slice(), &1u32.to_le_bytes(), &32u32.to_le_bytes(), &miner].concat();
    chain.fee = 7;
    chain.at(0);
    ok(&chain.paint(b"alice", 1, &[(0, 1, 0)], 100));
    assert_eq!(chain.balance(b"alice"), 1_000_000 - 107);
    assert_eq!(chain.balance(b"miner"), 7);
    assert_eq!(chain.burned(), 100);
    assert_eq!(chain.held(), 0);
}

#[test]
fn the_auction_holds_the_best_bid_refunds_the_rest_and_burns_the_winner() {
    let mut chain = Chain::new();
    chain.at(0);
    ok(&chain.paint(b"alice", 1, &[(0, 1, 0)], 100));
    chain.at(PERIOD - 1);
    reverts(&chain.bid(b"alice", 1, RESERVE), "still painting");
    chain.at(PERIOD);
    reverts(&chain.bid(b"alice", 1, RESERVE - 1), "bid too low");
    ok(&chain.bid(b"alice", 1, RESERVE));
    assert_eq!(chain.held(), 1000);
    assert_eq!(chain.balance(b"alice"), 1_000_000 - 100 - 1000);
    let week = chain.week(1);
    assert_eq!((week.bid, week.bidder), (1000, chain.account(b"alice")));
    assert_eq!(week.end, chain.epoch + PERIOD + AUCTION);

    // A new bid is at least 5% higher, and the one it beats goes back.
    reverts(&chain.bid(b"bob", 1, 1049), "bid too low");
    ok(&chain.bid(b"bob", 1, 1050));
    assert_eq!(chain.held(), 1050);
    assert_eq!(chain.balance(b"alice"), 1_000_000 - 100);
    assert_eq!(chain.balance(b"bob"), 1_000_000 - 1050);

    // A bid in the last EXTENSION seconds moves the end.
    chain.at(PERIOD + AUCTION - 50);
    ok(&chain.bid(b"carol", 1, 1200));
    assert_eq!(chain.balance(b"bob"), 1_000_000);
    assert_eq!(chain.week(1).end, chain.epoch + PERIOD + AUCTION + 50);
    chain.at(PERIOD + AUCTION + 49);
    reverts(&chain.settle(1), "not due");

    chain.at(PERIOD + AUCTION + 50);
    reverts(&chain.bid(b"bob", 1, 2000), "auction over");
    ok(&chain.settle(1));
    assert_eq!(chain.held(), 0);
    assert_eq!(chain.burned(), 100 + 1200);
    let week = chain.week(1);
    assert_eq!((week.owner, week.settled, week.bid), (chain.account(b"carol"), true, 1200));
    reverts(&chain.settle(1), "not due");
    reverts(&chain.bid(b"bob", 1, 2000), "auction over");
}

#[test]
fn an_auction_without_bids_waits_for_its_first() {
    let mut chain = Chain::new();
    chain.at(5 * PERIOD);
    reverts(&chain.settle(1), "not due");
    reverts(&chain.list(b"alice", 1, 1), "no owner");
    ok(&chain.bid(b"alice", 1, RESERVE));
    assert_eq!(chain.week(1).end, chain.epoch + 5 * PERIOD + EXTENSION);
    chain.at(5 * PERIOD + EXTENSION);
    ok(&chain.settle(1));
    assert_eq!(chain.week(1).owner, chain.account(b"alice"));
}

#[test]
fn an_owner_lists_sells_gives_and_names_the_canvas() {
    let mut chain = Chain::new();
    chain.at(PERIOD);
    ok(&chain.bid(b"carol", 1, RESERVE));
    chain.at(PERIOD + AUCTION);
    // The owner's first operation settles the auction itself.
    reverts(&chain.list(b"alice", 1, 5000), "not owner");
    reverts(&chain.list(b"carol", 1, 0), "bad price");
    ok(&chain.list(b"carol", 1, 5000));
    assert!(chain.week(1).settled);
    assert_eq!(chain.week(1).price, 5000);
    assert_eq!(chain.held(), 0);

    let (alice, bob, carol) = (chain.account(b"alice"), chain.account(b"bob"), chain.account(b"carol"));
    reverts(&chain.buy(b"bob", 1, 4000, &carol), "price changed");
    reverts(&chain.buy(b"bob", 1, 5000, &alice), "bad payment");
    ok(&chain.buy(b"bob", 1, 5000, &carol));
    assert_eq!(chain.balance(b"carol"), 1_000_000 - RESERVE + 5000);
    assert_eq!(chain.balance(b"bob"), 1_000_000 - 5000);
    let week = chain.week(1);
    assert_eq!((week.owner, week.price), (bob, 0));
    reverts(&chain.buy(b"alice", 1, 5000, &bob), "not for sale");

    ok(&chain.list(b"bob", 1, 9000));
    ok(&chain.act(b"bob", head(UNLIST, &[&1u64.to_le_bytes()]), None));
    assert_eq!(chain.week(1).price, 0);

    reverts(&chain.give(b"carol", 1, &alice), "not owner");
    reverts(&chain.give(b"bob", 1, &[0; 32]), "bad account");
    ok(&chain.give(b"bob", 1, &alice));
    assert_eq!(chain.week(1).owner, alice);

    ok(&chain.title(b"alice", 1, "Sunrise över Ting".as_bytes()));
    assert_eq!(
        chain.storage(chain.canvas, week_key(3, 1)),
        Some("Sunrise över Ting".as_bytes().to_vec())
    );
    reverts(&chain.title(b"alice", 1, &[b'a'; 101]), "bad title");
    reverts(&chain.title(b"alice", 1, &[0xff]), "bad title");
    reverts(&chain.title(b"alice", 1, b""), "bad title");
    ok(&chain.act(b"alice", head(UNNAME, &[&1u64.to_le_bytes()]), None));
    assert_eq!(chain.storage(chain.canvas, week_key(3, 1)), None);
}

#[test]
fn an_owner_operation_is_approved_by_its_fee_payment() {
    let mut chain = Chain::new();
    chain.won(b"alice");
    let miner = chain.account(b"miner");
    chain.context.producer = [b"OCP1".as_slice(), &1u32.to_le_bytes(), &32u32.to_le_bytes(), &miner].concat();
    chain.fee = 7;
    let (alice, vault) = (chain.account(b"alice"), contract_account(&chain.canvas));
    let instant = chain.instant;
    let fee_paid = |nonce: Option<u64>| Act {
        policy: instant,
        who: b"alice",
        nonce,
        valid_until: 0,
        effect: Some(transfer(&vault, 0)),
        payer: None,
        coin: None,
        witness: b"",
    };
    let (before, n) = (chain.balance(b"alice"), chain.nonce(&alice));

    // A transfer of 0 to the canvas's account, carrying the fee, is the
    // approval: no witness, one signature, and the miner is paid.
    let list = chain.list_head(1, 5000);
    let input = chain.input(&list, &fee_paid(None));
    let r = chain.call(input.clone());
    ok(&r);
    assert_eq!(chain.week(1).price, 5000);
    assert_eq!(r.events.last().unwrap().payload, executed(&alice, n, &list));
    assert_eq!((chain.balance(b"alice"), chain.balance(b"miner"), chain.held()), (before - 7, 7, 0));
    assert_eq!(chain.nonce(&alice), n + 1);
    reverts(&chain.call(input), "bad nonce");

    // It comes from the acting account, in the canvas's coin, with no witness
    // beside it; the owner is checked before anything is paid.
    let give = head(GIVE, &[&1u64.to_le_bytes(), &chain.account(b"bob")]);
    reverts(&chain.act_with(give.clone(), Act { payer: Some((instant, b"bob")), ..fee_paid(None) }), "bad payment");
    reverts(&chain.act_with(give.clone(), Act { coin: Some([7; 32]), ..fee_paid(None) }), "bad coin");
    reverts(&chain.act_with(give.clone(), Act { witness: b"signature", ..fee_paid(None) }), "bad input");
    reverts(&chain.act_with(give.clone(), Act { who: b"bob", ..fee_paid(None) }), "not owner");
    assert_eq!(chain.balance(b"alice"), before - 7);

    // An account with a delay cannot make one: the coin refuses its fee and
    // its bound actions, so nothing is scheduled.
    let delayed = chain.delayed;
    let savings = chain.account_of(&delayed, b"alice");
    ok(&chain.act_with(head(GIVE, &[&1u64.to_le_bytes(), &savings]), fee_paid(None)));
    chain.fund(b"alice", &savings, 1000);
    let unlist = head(UNLIST, &[&1u64.to_le_bytes()]);
    reverts(&chain.act_with(unlist.clone(), Act { policy: delayed, ..fee_paid(None) }), "payment: delayed fee");
    chain.fee = 0;
    reverts(&chain.act_with(unlist, Act { policy: delayed, ..fee_paid(None) }), "payment: delayed binding");
    assert_eq!((chain.nonce(&savings), chain.scheduled(&savings, 0)), (0, None));
}

#[test]
fn an_account_with_a_delay_schedules_what_it_does_and_can_cancel_it() {
    let mut chain = Chain::new();
    chain.won(b"carol");
    let delayed = chain.delayed;
    let savings = chain.account_of(&delayed, b"carol-savings");
    ok(&chain.give(b"carol", 1, &savings));
    let by_savings = |nonce: u64, valid_until: u64| Act {
        policy: delayed, who: b"carol-savings", nonce: Some(nonce), valid_until, effect: None, payer: None, coin: None, witness: b"",
    };

    chain.at(PERIOD + AUCTION + 1);
    let now = chain.context.timestamp;

    let list = chain.list_head(1, 5000);
    reverts(&chain.act_with(list.clone(), by_savings(1, 0)), "bad nonce");
    reverts(&chain.act_with(list.clone(), Act { who: b"mallory", ..by_savings(0, 0) }), "not owner");
    reverts(&chain.act_with(list.clone(), by_savings(0, now - 1)), "expired");
    let r = chain.act_with(list.clone(), by_savings(0, now + 60));
    ok(&r);
    // Scheduled, not done: nothing changes before it runs.
    assert_eq!(chain.week(1).price, 0);
    let execute_at = now + DELAY;
    assert_eq!(chain.scheduled(&savings, 0), Some([&execute_at.to_le_bytes()[..], &list].concat()));
    let mut expected = hash("app/call-v1/event/scheduled", b"").to_vec();
    expected.extend(savings);
    expected.extend(0u64.to_le_bytes());
    expected.extend(execute_at.to_le_bytes());
    expected.extend(&list);
    assert_eq!(r.events.last().unwrap().payload, expected);

    reverts(&chain.call(run_input(&savings, 0)), "not due");
    chain.context.timestamp = execute_at;
    let r = chain.call(run_input(&savings, 0));
    ok(&r);
    assert_eq!(chain.week(1).price, 5000);
    assert_eq!(chain.scheduled(&savings, 0), None);
    assert_eq!(r.events.last().unwrap().payload, executed(&savings, 0, &list));
    reverts(&chain.call(run_input(&savings, 0)), "not scheduled");

    // A thief with a key schedules two gifts; one cancel stops both.
    let give = |to: &Id| head(GIVE, &[&1u64.to_le_bytes(), to]);
    let mallory = chain.account(b"mallory");
    ok(&chain.act_with(give(&mallory), by_savings(1, 0)));
    ok(&chain.act_with(give(&mallory), by_savings(2, 0)));
    let cancel = |sequences: &[u64], valid_until: u64| {
        let mut c = hash("app/call-v1/cancel", b"").to_vec();
        c.extend(delayed);
        c.extend(bytes(b"carol-savings"));
        c.extend(valid_until.to_le_bytes());
        c.extend(bytes(b""));
        c.extend((sequences.len() as u64).to_le_bytes());
        for s in sequences {
            c.extend(s.to_le_bytes());
        }
        c
    };
    reverts(&chain.call(cancel(&[2, 1], 0)), "bad input");
    reverts(&chain.call(cancel(&[1, 3], 0)), "not scheduled");
    reverts(&chain.call(cancel(&[0], 0)), "not scheduled");
    reverts(&chain.call(cancel(&[1, 2], execute_at - 1)), "expired");
    let r = chain.call(cancel(&[0, 1, 2], 0));
    ok(&r);
    assert_eq!(r.events.len(), 2);
    assert_eq!(chain.scheduled(&savings, 1), None);
    chain.context.timestamp += DELAY;
    reverts(&chain.call(run_input(&savings, 1)), "not scheduled");
    assert_eq!(chain.week(1).owner, savings);

    // A payment never comes from a delayed account: the coin refuses it, so
    // the account buys nothing, even from itself, coins or not.
    chain.fund(b"carol", &savings, 6000);
    let buy = head(BUY, &[&1u64.to_le_bytes()]);
    reverts(&chain.act_with(buy, Act { effect: Some(transfer(&savings, 5000)), ..by_savings(3, 0) }), "payment: delayed binding");

    // A buyer pays the savings account, at once.
    let alice = chain.balance(b"alice");
    ok(&chain.buy(b"alice", 1, 5000, &savings));
    assert_eq!(chain.coin_record(&savings).0, 6000 + 5000);
    assert_eq!(chain.balance(b"alice"), alice - 5000);
}

#[test]
fn a_delayed_account_cannot_pay() {
    let mut chain = Chain::new();
    chain.at(0);
    let slow = chain.account_of(&chain.delayed.clone(), b"alice");
    chain.fund(b"alice", &slow, 1000);
    let act = Act {
        policy: chain.delayed,
        who: b"alice",
        nonce: None,
        valid_until: 0,
        effect: Some(burn(100)),
        payer: None,
        coin: None,
        witness: b"",
    };
    reverts(&chain.act_with(paint_head(1, &[(0, 1, 0)]), act), "payment: delayed binding");
    assert_eq!(chain.burned(), 0);
}

#[test]
fn a_program_can_own_a_canvas_and_act_for_it() {
    let mut chain = Chain::new();
    chain.won(b"carol");
    let proxy = chain.deploy(wasm(PROXY), Vec::new());
    let list = chain.list_head(1, 42);
    let through = |chain: &mut Chain, call: Vec<u8>| {
        let input = [chain.canvas.to_vec(), call].concat();
        chain.run(Payload::Call { target: proxy, input })
    };
    // `01`: the calling program's account. Not from top level, and not for a
    // canvas it does not own.
    reverts(&chain.call([list.clone(), vec![1, 0]].concat()), "no calling contract");
    reverts(&through(&mut chain, [list.clone(), vec![1, 0]].concat()), "not owner");
    let account = contract_account(&proxy);
    ok(&chain.give(b"carol", 1, &account));
    let r = through(&mut chain, [list.clone(), vec![1, 0]].concat());
    ok(&r);
    assert_eq!(chain.week(1).price, 42);
    assert_eq!(r.events.last().unwrap().payload, executed(&account, 0, &list));
    // It carries no payment, so it does nothing that pays.
    let bid = head(BID, &[&2u64.to_le_bytes()]);
    reverts(&through(&mut chain, [bid, vec![1, 0]].concat()), "needs payment");
    let with_payment = [list, vec![1, 1], chain.coin.to_vec(), bytes(b"")].concat();
    reverts(&through(&mut chain, with_payment), "bad input");
}

#[test]
fn the_week_query_answers_read_only() {
    let mut chain = Chain::new();
    chain.at(0);
    ok(&chain.paint(b"alice", 1, &[(0, 1, 0)], 100));
    let r = chain.call([&[8][..], &1u64.to_le_bytes()].concat());
    ok(&r);
    assert_eq!(r.result.len(), 137);
    assert_eq!(u128::from_le_bytes(r.result[..16].try_into().unwrap()), 100);
}

#[test]
fn costs() {
    let mut chain = Chain::new();
    chain.at(0);
    let show = |what: &str, r: &Receipt| {
        ok(r);
        let [c, s, d, g] = r.used.0;
        println!("{what:<44} {c:>12} C {s:>5} S {d:>7} D {g:>7} G");
    };
    show("paint 1 pixel", &chain.paint(b"alice", 1, &[(0, 1, 0)], 100));
    let row: Vec<(u32, u8, u8)> = (0..32).map(|i| (32 + i, 2, 0)).collect();
    show("paint 32 pixels in 2 tiles", &chain.paint(b"alice", 1, &row, 3200));
    let all: Vec<(u32, u8, u8)> = (0..1024).map(|i| (i, 3, u8::from(i == 0 || (32..64).contains(&i)))).collect();
    show("paint 1,024 pixels, the whole canvas", &chain.paint(b"bob", 1, &all, 991 * 100 + 33 * 200));
    chain.at(PERIOD);
    show("first bid", &chain.bid(b"alice", 1, RESERVE));
    show("outbid, with the refund", &chain.bid(b"bob", 1, 2 * RESERVE));
    chain.at(PERIOD + AUCTION);
    show("settle", &chain.settle(1));
    show("list", &chain.list(b"bob", 1, 5000));
    let vault = contract_account(&chain.canvas);
    show("list, approved by its fee payment", &chain.act(b"bob", chain.list_head(1, 5000), Some(transfer(&vault, 0))));
    let bob = chain.account(b"bob");
    show("buy", &chain.buy(b"carol", 1, 5000, &bob));
    let delayed = chain.delayed;
    let savings = chain.account_of(&delayed, b"s");
    show("give", &chain.give(b"carol", 1, &savings));
    let list = chain.list_head(1, 1);
    let act = Act { policy: delayed, who: b"s", nonce: None, valid_until: 0, effect: None, payer: None, coin: None, witness: b"" };
    show("schedule a listing from a delayed account", &chain.act_with(list, act));
    chain.context.timestamp += DELAY;
    show("run it", &chain.call(run_input(&savings, 0)));
}
