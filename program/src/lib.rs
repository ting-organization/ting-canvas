//! Ting Canvas: one canvas a week, painted by burning a coin, locked for good
//! when its week ends, auctioned in the week after, then owned and traded.
//! SPEC.md states the rules; this file follows it.
//!
//! Every operation is a call of TCR-1, Ting Call Requests: a template of the
//! program's own and its values, approved by the acting account. An account
//! approves through its policy, which the program asks, and whose delay, if it
//! answers with one, schedules the operation. An operation that moves coins
//! carries a coin payment from the acting account, bound to the call's signing
//! digest (wiki: programs/conventions, bound actions): the payment pays for
//! that one operation, and the coin's check of it is the approval. A program
//! acts for its own contract account by calling.
#![no_std]

extern crate alloc;

mod host;
mod sha256;

use alloc::{vec, vec::Vec};
use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32;
use host::fail;
use sha256::{tagged, tagged_const};

// ---- Memory ----------------------------------------------------------------------

/// Memory starts at one page and grows only when a transaction needs more
/// (wiki: applications/writing-programs, keeping it cheap). Nothing is freed:
/// an invocation is short.
struct Bump;

static mut NEXT: usize = 0;
static mut END: usize = 0;

unsafe extern "C" {
    static __heap_base: u8;
}

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe {
            if NEXT == 0 {
                NEXT = &raw const __heap_base as usize;
                END = wasm32::memory_size::<0>() * 65536;
            }
            let start = (NEXT + layout.align() - 1) & !(layout.align() - 1);
            let Some(end) = start.checked_add(layout.size()) else {
                return core::ptr::null_mut();
            };
            if end > END {
                let pages = (end - END).div_ceil(65536);
                if wasm32::memory_grow::<0>(pages) == usize::MAX {
                    return core::ptr::null_mut();
                }
                END += pages * 65536;
            }
            NEXT = end;
            start as *mut u8
        }
    }

    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}

#[global_allocator]
static ALLOCATOR: Bump = Bump;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}

// ---- TCR-1 ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Paint,
    Bid,
    List,
    Unlist,
    Buy,
    Give,
    Name,
    Unname,
}

/// The program's templates (TCR-1): each declares its operation and fields,
/// then says what it does in the words a wallet shows. A call names one by its
/// hash. The paint template names the canvas's colors, so the deployment builds
/// it from its options: these are its two ends.
const PAINT_HEAD: &[u8] = b"paint(week:u64,pixels:list(x:u16,y:u16,color:enum(";
const PAINT_TAIL: &[u8] = b"),doublings:u8)): On the canvas of week {week}, paint {pixels} pixels, burning {payment}";

const TEMPLATES: [(Op, &[u8]); 7] = [
    (Op::Bid, b"bid(week:u64): Bid {payment} for the canvas of week {week}"),
    (Op::List, b"list(week:u64,price:amount): Offer the canvas of week {week} for sale at {price}"),
    (Op::Unlist, b"unlist(week:u64): Take the canvas of week {week} off sale"),
    (Op::Buy, b"buy(week:u64): Buy the canvas of week {week} for {payment}"),
    (Op::Give, b"give(week:u64,to:account): Give the canvas of week {week} to {to}"),
    (Op::Name, b"name(week:u64,title:text): Call the canvas of week {week} {title}"),
    (Op::Unname, b"unname(week:u64): Remove the name of the canvas of week {week}"),
];

const TEMPLATE_HASHES: [[u8; 32]; 7] = {
    let mut out = [[0; 32]; 7];
    let mut i = 0;
    while i < 7 {
        out[i] = tagged_const(b"app/call-v1/template", TEMPLATES[i].1);
        i += 1;
    }
    out
};

/// The longest template, declaration and sentence together (TCR-1).
const TEMPLATE_MAX: usize = 512;
/// The longest name of a color.
const COLOR_NAME_MAX: usize = 32;

const CALL_TAG: &[u8] = b"app/call-v1";
const TAG_OPERATION: &[u8] = b"app/call-v1/operation";
const TAG_NONCE: &[u8] = b"app/call-v1/nonce";
const TAG_SCHEDULED: &[u8] = b"app/call-v1/scheduled";
const TAG_SIGN: &[u8] = b"app/sign-v1";
const RUN: [u8; 32] = tagged_const(b"app/call-v1/run", b"");
const CANCEL: [u8; 32] = tagged_const(b"app/call-v1/cancel", b"");
const SCHEDULED: [u8; 32] = tagged_const(b"app/call-v1/event/scheduled", b"");
const EXECUTED: [u8; 32] = tagged_const(b"app/call-v1/event/executed", b"");
const CANCELLED: [u8; 32] = tagged_const(b"app/call-v1/event/cancelled", b"");
/// The template list: `u64 count ‖ count × Bytes(template)`, for wallets to read.
const TEMPLATES_KEY: [u8; 32] = tagged_const(b"app/call-v1/templates", b"");

// ---- Layout ----------------------------------------------------------------------

const TAG_EVENT: &[u8] = b"app/canvas-v1/event";
const TAG_POLICY: &[u8] = b"app/account-v1/policy";
const TAG_CONTRACT: &[u8] = b"app/account-v1/contract";

const ZERO: [u8; 32] = [0; 32];
const CONFIG_KEY: [u8; 32] = ZERO;
/// Holds the digest of the call that is paying, only while it pays.
const DIGEST_KEY: [u8; 32] = {
    let mut key = ZERO;
    key[0] = 0xff;
    key
};
/// The paint template's hash, which the deployment works out.
const PAINT_KEY: [u8; 32] = {
    let mut key = ZERO;
    key[0] = 4;
    key
};

/// A tile is 16 × 16 pixels: 256 colors, then 256 marks. A mark is 0 for a
/// pixel never painted, else 1 more than the level it was last painted at.
const TILE_BYTES: usize = 512;
const WEEK_BYTES: usize = 137;
const TITLE_MAX: usize = 100;
/// The fixed fields of the configuration, before the palette.
const CONFIG_FIXED: usize = 1 + 32 + 8 + 8 + 2 + 2 + 16 + 8 + 8 + 16;
/// Room for any configuration whose paint template fits.
const CONFIG_MAX: usize = CONFIG_FIXED + 1 + 255 * (3 + 4) + TEMPLATE_MAX;

fn week_key(kind: u8, week: u64) -> [u8; 32] {
    let mut key = ZERO;
    key[0] = kind;
    key[1..9].copy_from_slice(&week.to_le_bytes());
    key
}

fn tile_key(week: u64, tile: u32) -> [u8; 32] {
    let mut key = week_key(1, week);
    key[9..11].copy_from_slice(&(tile as u16).to_le_bytes());
    key
}

fn policy_account(policy: &[u8], params: &[u8]) -> [u8; 32] {
    tagged(TAG_POLICY, &[policy, &(params.len() as u32).to_le_bytes(), params])
}

fn contract_account(owner: &[u8; 32]) -> [u8; 32] {
    tagged(TAG_CONTRACT, &[owner])
}

fn scheduled_key(account: &[u8; 32], sequence: u64) -> [u8; 32] {
    tagged(TAG_SCHEDULED, &[account, &sequence.to_le_bytes()])
}

fn framed(bytes: &[u8]) -> Vec<u8> {
    [&(bytes.len() as u32).to_le_bytes()[..], bytes].concat()
}

// ---- Decoding --------------------------------------------------------------------

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    error: &'static [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8], error: &'static [u8]) -> Self {
        Self { bytes, at: 0, error }
    }

    fn take(&mut self, n: usize) -> &'a [u8] {
        if n > self.bytes.len() - self.at {
            fail(self.error);
        }
        let out = &self.bytes[self.at..self.at + n];
        self.at += n;
        out
    }

    fn array<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0; N];
        out.copy_from_slice(self.take(N));
        out
    }

    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }

    fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.array())
    }

    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.array())
    }

    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.array())
    }

    fn u128(&mut self) -> u128 {
        u128::from_le_bytes(self.array())
    }

    fn bytes(&mut self) -> &'a [u8] {
        let len = self.u32() as usize;
        self.take(len)
    }

    /// `n` items of `size` bytes each.
    fn items(&mut self, n: u64, size: usize) -> &'a [u8] {
        match usize::try_from(n).ok().and_then(|n| n.checked_mul(size)) {
            Some(len) => self.take(len),
            None => fail(self.error),
        }
    }

    fn end(&self) {
        if self.at != self.bytes.len() {
            fail(self.error);
        }
    }
}

// ---- Configuration ------------------------------------------------------------------

struct Config {
    coin: [u8; 32],
    epoch: u64,
    period: u64,
    width: u32,
    height: u32,
    price: u128,
    auction: u64,
    extension: u64,
    reserve: u128,
    colors: u32,
}

impl Config {
    fn parse(bytes: &[u8], error: &'static [u8]) -> Self {
        let mut r = Reader::new(bytes, error);
        if r.u8() != 1 {
            fail(error);
        }
        let config = Config {
            coin: r.array(),
            epoch: r.u64(),
            period: r.u64(),
            width: r.u16().into(),
            height: r.u16().into(),
            price: r.u128(),
            auction: r.u64(),
            extension: r.u64(),
            reserve: r.u128(),
            colors: r.u8().into(),
        };
        for _ in 0..config.colors {
            r.take(3);
            r.bytes();
        }
        r.end();
        let side = |s: u32| s > 0 && s.is_multiple_of(16) && s <= 4096;
        if config.period == 0
            || !side(config.width)
            || !side(config.height)
            || config.price == 0
            || config.reserve == 0
            || config.colors < 2
        {
            fail(error);
        }
        config
    }

    /// The week the timestamp falls in, counting from 1; none before the first.
    fn week_at(&self, now: u64) -> Option<u64> {
        now.checked_sub(self.epoch).map(|t| (t / self.period).saturating_add(1))
    }

    /// When the canvas of `week` locks and its auction opens.
    fn closes(&self, week: u64) -> u64 {
        self.epoch.saturating_add(week.saturating_mul(self.period))
    }
}

/// The paint template of a deployment input, whose palette's names become the
/// colors' labels: each 1 to 32 letters, digits, spaces or hyphens, neither
/// starting nor ending with a space, and no two the same. None when a name
/// breaks that, or the template would be longer than TCR-1 allows.
fn paint_template(input: &[u8]) -> Option<Vec<u8>> {
    let mut r = Reader::new(input, b"bad deploy input");
    r.take(CONFIG_FIXED);
    let colors = r.u8();
    let mut names: Vec<&[u8]> = Vec::new();
    let mut template = PAINT_HEAD.to_vec();
    for i in 0..colors {
        r.take(3);
        let name = r.bytes();
        let fits = |c: &u8| c.is_ascii_alphanumeric() || *c == b' ' || *c == b'-';
        if name.is_empty()
            || name.len() > COLOR_NAME_MAX
            || !name.iter().all(fits)
            || name[0] == b' '
            || name[name.len() - 1] == b' '
            || names.contains(&name)
        {
            return None;
        }
        names.push(name);
        if i > 0 {
            template.push(b'|');
        }
        template.extend_from_slice(name);
    }
    template.extend_from_slice(PAINT_TAIL);
    (template.len() <= TEMPLATE_MAX).then_some(template)
}

// ---- A week's record -----------------------------------------------------------------

#[derive(Default)]
struct Week {
    burned: u128,
    paints: u64,
    pixels: u64,
    bid: u128,
    bidder: [u8; 32],
    /// When the auction ends; 0 until the first bid sets it.
    end: u64,
    owner: [u8; 32],
    price: u128,
    settled: bool,
}

impl Week {
    fn load(week: u64) -> Self {
        let mut buf = [0u8; WEEK_BYTES];
        match host::get_into(&week_key(2, week), &mut buf) {
            None => return Week::default(),
            Some(WEEK_BYTES) => {}
            Some(_) => fail(b"corrupt"),
        }
        let mut r = Reader::new(&buf, b"corrupt");
        Week {
            burned: r.u128(),
            paints: r.u64(),
            pixels: r.u64(),
            bid: r.u128(),
            bidder: r.array(),
            end: r.u64(),
            owner: r.array(),
            price: r.u128(),
            settled: r.u8() == 1,
        }
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(WEEK_BYTES);
        out.extend_from_slice(&self.burned.to_le_bytes());
        out.extend_from_slice(&self.paints.to_le_bytes());
        out.extend_from_slice(&self.pixels.to_le_bytes());
        out.extend_from_slice(&self.bid.to_le_bytes());
        out.extend_from_slice(&self.bidder);
        out.extend_from_slice(&self.end.to_le_bytes());
        out.extend_from_slice(&self.owner);
        out.extend_from_slice(&self.price.to_le_bytes());
        out.push(self.settled.into());
        out
    }

    fn store(&self, week: u64) {
        host::set(&week_key(2, week), &self.encode());
    }

    /// When the auction ends: as scheduled until a bid moves it.
    fn ends(&self, config: &Config, week: u64) -> u64 {
        if self.end != 0 {
            return self.end;
        }
        config.closes(week).saturating_add(config.auction)
    }
}

fn event(week: u64, kind: u8, parts: &[&[u8]]) {
    let mut payload = Vec::new();
    payload.extend_from_slice(&tagged(TAG_EVENT, &[&week.to_le_bytes()]));
    payload.push(kind);
    for part in parts {
        payload.extend_from_slice(part);
    }
    host::emit_event(&payload);
}

fn emit(topic: &[u8; 32], parts: &[&[u8]]) {
    let mut payload = topic.to_vec();
    for part in parts {
        payload.extend_from_slice(part);
    }
    host::emit_event(&payload);
}

// ---- Payments through the coin ---------------------------------------------------------

enum Effect {
    Transfer([u8; 32]),
    Burn,
}

/// A signed coin action, `10 ‖ auth ‖ action`, from a policy account.
struct Payment<'a> {
    raw: &'a [u8],
    payer: [u8; 32],
    effect: Effect,
    amount: u128,
}

/// Decodes a coin action exactly as the coin will, and requires it to be bound
/// to this program and to `digest`.
fn payment<'a>(raw: &'a [u8], me: &[u8; 32], digest: &[u8; 32]) -> Payment<'a> {
    let mut r = Reader::new(raw, b"bad payment");
    if r.u8() != 0x10 || r.u8() != 0x00 {
        fail(b"bad payment");
    }
    let policy = r.take(32);
    let params = r.bytes();
    r.u64();
    r.bytes();
    let effect = match r.u8() {
        1 => Effect::Transfer(r.array()),
        2 => Effect::Burn,
        _ => fail(b"bad payment"),
    };
    let amount = r.u128();
    // fee, tip, not_before and valid_until are the coin's to check
    r.take(16 + 16 + 8 + 8);
    if r.u8() != 1 || r.array::<32>() != *me || r.array::<32>() != *digest {
        fail(b"not bound");
    }
    r.end();
    Payment {
        raw,
        payer: policy_account(policy, params),
        effect,
        amount,
    }
}

/// Runs a payment, answering the coin's query for the digest meanwhile.
fn pay(config: &Config, payment: &Payment, digest: &[u8; 32]) {
    host::set(&DIGEST_KEY, digest);
    let (status, result) = host::call_child(&config.coin, payment.raw, host::ORDINARY);
    host::delete(&DIGEST_KEY);
    if status != 0 {
        fail(&[b"payment: ".as_slice(), &result].concat());
    }
}

/// A coin action of this program's own contract account: no fee, no binding.
fn spend(config: &Config, action: &[&[u8]]) {
    let mut input = vec![0x10, 0x01];
    for part in action {
        input.extend_from_slice(part);
    }
    input.extend_from_slice(&[0; 16 + 16 + 8 + 8 + 1]);
    let (status, result) = host::call_child(&config.coin, &input, host::ORDINARY);
    if status != 0 {
        fail(&[b"coin: ".as_slice(), &result].concat());
    }
}

/// Asks a policy, read-only, whether it authorizes `message`: the delay it
/// requires, 0 for none (wiki: programs/conventions, policy interface).
fn authorize(policy: &[u8; 32], params: &[u8], message: &[u8], witness: &[u8]) -> u64 {
    let input = [framed(params), framed(message), framed(witness)].concat();
    let (status, result) = host::call_child(policy, &input, host::READ_ONLY);
    if status != 0 {
        fail(b"not authorized");
    }
    match result.as_slice() {
        [1] => 0,
        [1, rest @ ..] if rest.len() == 8 => {
            let mut d = [0; 8];
            d.copy_from_slice(rest);
            match u64::from_le_bytes(d) {
                0 => fail(b"not authorized"),
                delay => delay,
            }
        }
        _ => fail(b"not authorized"),
    }
}

fn nonce_of(account: &[u8; 32]) -> ([u8; 32], u64) {
    let key = tagged(TAG_NONCE, &[account]);
    let mut value = [0u8; 8];
    match host::get_into(&key, &mut value) {
        None => (key, 0),
        Some(8) => (key, u64::from_le_bytes(value)),
        Some(_) => fail(b"corrupt"),
    }
}

// ---- Entry ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn invoke() {
    let input = host::read_input();
    if input == [0x00] {
        let mut out = [0u8; 32];
        match host::get_into(&DIGEST_KEY, &mut out) {
            Some(32) => host::finish(&out),
            _ => fail(b"not running"),
        }
    }
    let mut stored = [0u8; CONFIG_MAX];
    let config = match host::get_into(&CONFIG_KEY, &mut stored) {
        None => deploy(&input),
        Some(n) if n <= CONFIG_MAX => Config::parse(&stored[..n], b"corrupt"),
        Some(_) => fail(b"corrupt"),
    };
    let me = host::self_id();
    // Inputs shorter than a hash are the program's own; the rest begin with
    // a template's hash, or TCR-1's run or cancel.
    if input.len() < 32 {
        let mut r = Reader::new(&input, b"bad input");
        let op = r.u8();
        let week = r.u64();
        r.end();
        match op {
            0x03 => settle(&config, week),
            0x08 => host::finish(&Week::load(week).encode()),
            _ => fail(b"bad input"),
        }
    }
    match input[..32].try_into().unwrap() {
        RUN => run(&config, &input),
        CANCEL => cancel(&me, &input),
        _ => call(&config, &me, &input),
    }
}

/// Stores the configuration, and the template list for wallets to read, its
/// paint template built from the palette.
fn deploy(input: &[u8]) -> ! {
    Config::parse(input, b"bad deploy input");
    let Some(paint) = paint_template(input) else {
        fail(b"bad deploy input");
    };
    host::set(&CONFIG_KEY, input);
    host::set(&PAINT_KEY, &tagged(b"app/call-v1/template", &[&paint]));
    let mut list = (TEMPLATES.len() as u64 + 1).to_le_bytes().to_vec();
    list.extend_from_slice(&framed(&paint));
    for (_, text) in TEMPLATES {
        list.extend_from_slice(&framed(text));
    }
    host::set(&TEMPLATES_KEY, &list);
    host::finish(&[])
}

/// One operation's values, decoded as its template declares them.
struct Call<'a> {
    op: Op,
    week: u64,
    /// A listing's price, and the coin it is in.
    coin: [u8; 32],
    amount: u128,
    to: [u8; 32],
    title: &'a [u8],
    /// `count × (u16 x ‖ u16 y ‖ u8 color ‖ u8 doublings)`
    pixels: &'a [u8],
}

impl<'a> Call<'a> {
    /// Reads the template hash and the values after it, in the order the
    /// template declares them.
    fn decode(r: &mut Reader<'a>) -> Self {
        let hash: [u8; 32] = r.array();
        let op = match TEMPLATE_HASHES.iter().position(|t| *t == hash) {
            Some(i) => TEMPLATES[i].0,
            None => {
                let mut paint = [0u8; 32];
                if host::get_into(&PAINT_KEY, &mut paint) != Some(32) {
                    fail(b"corrupt");
                }
                if hash != paint {
                    fail(b"bad input");
                }
                Op::Paint
            }
        };
        let mut call = Call {
            op,
            week: r.u64(),
            coin: ZERO,
            amount: 0,
            to: ZERO,
            title: &[],
            pixels: &[],
        };
        match op {
            Op::Paint => {
                let count = r.u64();
                call.pixels = r.items(count, 6);
            }
            Op::List => {
                call.coin = r.array();
                call.amount = r.u128();
            }
            Op::Give => call.to = r.array(),
            Op::Name => call.title = r.bytes(),
            _ => {}
        }
        call
    }

    /// The operations that move coins, and so carry a payment; the others
    /// take a fee payment or none.
    fn pays(&self) -> bool {
        matches!(self.op, Op::Paint | Op::Bid | Op::Buy)
    }

    /// What the values themselves must satisfy, checked before anything costly.
    fn check(&self, config: &Config) {
        if self.week == 0 {
            fail(b"bad input");
        }
        match self.op {
            Op::List if self.coin != config.coin => fail(b"bad coin"),
            Op::Paint if self.pixels.is_empty() => fail(b"bad input"),
            Op::List if self.amount == 0 => fail(b"bad price"),
            Op::Give if self.to == ZERO => fail(b"bad account"),
            Op::Name
                if self.title.is_empty()
                    || self.title.len() > TITLE_MAX
                    || core::str::from_utf8(self.title).is_err() =>
            {
                fail(b"bad title")
            }
            _ => {}
        }
    }
}

/// `T ‖ values ‖ auth ‖ payment`. `auth` is `00 ‖ policy(32) ‖ Bytes(params) ‖
/// u64 nonce ‖ u64 valid_until ‖ Bytes(witness)` for a policy account, or `01`
/// for the calling program's own account; `payment` is `00`, or `01 ‖ coin(32)
/// ‖ Bytes(coin input)`.
fn call(config: &Config, me: &[u8; 32], input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    let call = Call::decode(&mut r);
    let head = &input[..r.at];
    let operation = tagged(TAG_OPERATION, &[head]);
    let signer = match r.u8() {
        0x00 => Some((r.array::<32>(), r.bytes(), r.u64(), r.u64(), r.bytes())),
        0x01 => None,
        _ => fail(b"bad input"),
    };
    let paid = match r.u8() {
        0x00 => None,
        0x01 => Some((r.array::<32>(), r.bytes())),
        _ => fail(b"bad input"),
    };
    r.end();
    call.check(config);
    let now = host::now();

    let Some((policy, params, nonce, valid_until, witness)) = signer else {
        // A program acting as its own account: no nonce, no deadline, no delay
        // and no payment; it keeps its own rules.
        if paid.is_some() {
            fail(b"bad input");
        }
        let Some(caller) = host::caller() else {
            fail(b"no calling contract");
        };
        if call.pays() {
            fail(b"needs payment");
        }
        let account = contract_account(&caller);
        let prepared = prepare(config, me, &call, &account, None, now);
        finish(config, &call, &account, None, prepared);
        emit(&EXECUTED, &[&account, &0u64.to_le_bytes(), &operation]);
        host::finish(&[]);
    };

    if call.pays() && paid.is_none() {
        fail(b"needs payment");
    }
    if valid_until != 0 && now > valid_until {
        fail(b"expired");
    }
    let account = policy_account(&policy, params);
    let (nonce_key, stored) = nonce_of(&account);
    if nonce != stored {
        fail(b"bad nonce");
    }
    let mut message = framed(CALL_TAG);
    for part in [&host::chain_id()[..], me, &account, &[0x01], &nonce.to_le_bytes(), &valid_until.to_le_bytes(), &operation] {
        message.extend_from_slice(part);
    }
    let digest = tagged(TAG_SIGN, &[&message]);
    // A payment comes from the acting account, and is its approval: the coin
    // checks its signature over a message that holds `digest`. An operation
    // that moves no coins takes a fee payment, a transfer of 0 to the canvas's
    // own account that carries only the fee (TCR-1, fee payments).
    let payment = paid.map(|(coin, raw)| {
        if coin != config.coin {
            fail(b"bad coin");
        }
        let payment = payment(raw, me, &digest);
        if payment.payer != account {
            fail(b"bad payment");
        }
        if !call.pays() && !matches!(payment.effect, Effect::Transfer(to) if to == contract_account(me) && payment.amount == 0) {
            fail(b"bad payment");
        }
        if !witness.is_empty() {
            fail(b"bad input");
        }
        payment
    });

    // What the operation needs, checked before the approval, which costs most.
    let prepared = prepare(config, me, &call, &account, payment.as_ref(), now);

    let delay = match &payment {
        Some(_) => 0,
        None => authorize(&policy, params, &message, witness),
    };
    let Some(next) = nonce.checked_add(1) else {
        fail(b"nonce exhausted");
    };
    host::set(&nonce_key, &next.to_le_bytes());
    if delay > 0 {
        let execute_at = now.saturating_add(delay);
        host::set(&scheduled_key(&account, nonce), &[&execute_at.to_le_bytes()[..], head].concat());
        emit(&SCHEDULED, &[&account, &nonce.to_le_bytes(), &execute_at.to_le_bytes(), head]);
        host::finish(&[]);
    }
    if let Some(payment) = &payment {
        pay(config, payment, &digest);
    }
    finish(config, &call, &account, payment.as_ref(), prepared);
    emit(&EXECUTED, &[&account, &nonce.to_le_bytes(), &operation]);
    host::finish(&[])
}

/// An operation's state, read and checked before it is authorized and done.
enum Prepared {
    Paint { tiles: Vec<u32>, data: Vec<u8> },
    Week(Week),
}

fn prepare(config: &Config, me: &[u8; 32], call: &Call, account: &[u8; 32], payment: Option<&Payment>, now: u64) -> Prepared {
    match call.op {
        Op::Paint => prepare_paint(config, call, payment.unwrap(), now),
        Op::Bid => Prepared::Week(prepare_bid(config, me, call, payment.unwrap(), now)),
        Op::Buy => Prepared::Week(prepare_buy(call, payment.unwrap())),
        _ => Prepared::Week(owned(config, call.week, account)),
    }
}

fn finish(config: &Config, call: &Call, account: &[u8; 32], payment: Option<&Payment>, prepared: Prepared) {
    match (call.op, prepared) {
        (Op::Paint, Prepared::Paint { tiles, data }) => finish_paint(call, payment.unwrap(), &tiles, &data),
        (Op::Bid, Prepared::Week(record)) => finish_bid(config, call, account, payment.unwrap(), record),
        (Op::Buy, Prepared::Week(record)) => finish_buy(call, account, payment.unwrap(), record),
        (_, Prepared::Week(mut record)) => apply(call, &mut record, account),
        _ => fail(b"corrupt"),
    }
}

// ---- Painting --------------------------------------------------------------------

/// A pixel painted at level `l` burned `price × 2^l`; painting over it takes
/// at least level `l + 1`: twice what is on it.
fn prepare_paint(config: &Config, call: &Call, payment: &Payment, now: u64) -> Prepared {
    let week = call.week;
    match config.week_at(now) {
        Some(current) if current == week => {}
        Some(current) if current > week => fail(b"canvas locked"),
        _ => fail(b"not open"),
    }
    if !matches!(payment.effect, Effect::Burn) {
        fail(b"bad payment");
    }
    let tiles_x = config.width / 16;
    let mut slots = vec![u32::MAX; (tiles_x * (config.height / 16)) as usize];
    let mut tiles: Vec<u32> = Vec::new();
    let mut data: Vec<u8> = Vec::new();
    let mut price: u128 = 0;
    for &[x0, x1, y0, y1, color, level] in call.pixels.as_chunks::<6>().0 {
        let (x, y) = (u32::from(u16::from_le_bytes([x0, x1])), u32::from(u16::from_le_bytes([y0, y1])));
        if x >= config.width || y >= config.height {
            fail(b"bad pixel");
        }
        if u32::from(color) >= config.colors {
            fail(b"bad color");
        }
        if level == u8::MAX {
            fail(b"bad level");
        }
        let tile = y / 16 * tiles_x + x / 16;
        let at = (y % 16 * 16 + x % 16) as usize;
        if slots[tile as usize] == u32::MAX {
            slots[tile as usize] = tiles.len() as u32;
            tiles.push(tile);
            let start = data.len();
            data.resize(start + TILE_BYTES, 0);
            match host::get_into(&tile_key(week, tile), &mut data[start..]) {
                None | Some(TILE_BYTES) => {}
                Some(_) => fail(b"corrupt"),
            }
        }
        let base = slots[tile as usize] as usize * TILE_BYTES;
        if level < data[base + 256 + at] {
            fail(b"price too low");
        }
        let cost = 1u128
            .checked_shl(level.into())
            .and_then(|m| config.price.checked_mul(m));
        let Some(total) = cost.and_then(|c| price.checked_add(c)) else {
            fail(b"amount overflow");
        };
        price = total;
        data[base + at] = color;
        data[base + 256 + at] = level + 1;
    }
    if payment.amount < price {
        fail(b"underpaid");
    }
    Prepared::Paint { tiles, data }
}

fn finish_paint(call: &Call, payment: &Payment, tiles: &[u32], data: &[u8]) {
    let week = call.week;
    for (i, tile) in tiles.iter().enumerate() {
        host::set(&tile_key(week, *tile), &data[i * TILE_BYTES..(i + 1) * TILE_BYTES]);
    }
    let count = (call.pixels.len() / 6) as u64;
    let mut record = Week::load(week);
    record.burned = record.burned.saturating_add(payment.amount);
    record.paints = record.paints.saturating_add(1);
    record.pixels = record.pixels.saturating_add(count);
    record.store(week);
    event(week, 1, &[&payment.payer, &payment.amount.to_le_bytes(), &count.to_le_bytes(), call.pixels]);
}

// ---- The auction -----------------------------------------------------------------

/// A bid is its payment: a transfer to the canvas's account, which holds it.
fn prepare_bid(config: &Config, me: &[u8; 32], call: &Call, payment: &Payment, now: u64) -> Week {
    let (week, amount) = (call.week, payment.amount);
    if now < config.closes(week) {
        fail(b"still painting");
    }
    let record = Week::load(week);
    let ends = record.ends(config, week);
    if record.settled || (record.bid > 0 && now >= ends) {
        fail(b"auction over");
    }
    let least = match record.bid {
        0 => config.reserve,
        bid => bid.saturating_add((bid / 20).max(1)),
    };
    if amount < least {
        fail(b"bid too low");
    }
    match payment.effect {
        Effect::Transfer(to) if to == contract_account(me) => {}
        _ => fail(b"bad payment"),
    }
    record
}

fn finish_bid(config: &Config, call: &Call, bidder: &[u8; 32], payment: &Payment, mut record: Week) {
    let week = call.week;
    if record.bid > 0 {
        spend(config, &[&[0x01], &record.bidder, &record.bid.to_le_bytes()]);
    }
    let ends = record.ends(config, week);
    record.bid = payment.amount;
    record.bidder = *bidder;
    record.end = ends.max(host::now().saturating_add(config.extension));
    record.store(week);
    event(week, 2, &[bidder, &payment.amount.to_le_bytes(), &record.end.to_le_bytes()]);
}

/// Settles an auction that is over: burns the winning bid, and the bidder owns
/// the canvas. Whether it did.
fn settle_due(config: &Config, week: u64, record: &mut Week) -> bool {
    if record.settled || record.bid == 0 || host::now() < record.ends(config, week) {
        return false;
    }
    spend(config, &[&[0x02], &record.bid.to_le_bytes()]);
    record.owner = record.bidder;
    record.settled = true;
    event(week, 3, &[&record.owner, &record.bid.to_le_bytes()]);
    true
}

/// `03 ‖ u64 week`
fn settle(config: &Config, week: u64) -> ! {
    let mut record = Week::load(week);
    if !settle_due(config, week, &mut record) {
        fail(b"not due");
    }
    record.store(week);
    host::finish(&[])
}

// ---- Owners ----------------------------------------------------------------------

/// A buy pays the owner the price the canvas is listed at, no other.
fn prepare_buy(call: &Call, payment: &Payment) -> Week {
    let record = Week::load(call.week);
    if record.owner == ZERO || record.price == 0 {
        fail(b"not for sale");
    }
    match payment.effect {
        Effect::Transfer(to) if to == record.owner => {}
        _ => fail(b"bad payment"),
    }
    if payment.amount != record.price {
        fail(b"price changed");
    }
    record
}

fn finish_buy(call: &Call, buyer: &[u8; 32], payment: &Payment, mut record: Week) {
    let seller = record.owner;
    record.owner = *buyer;
    record.price = 0;
    record.store(call.week);
    event(call.week, 5, &[&seller, buyer, &payment.amount.to_le_bytes()]);
}

/// The week's record, its auction settled if it is over, once `account` is
/// shown to own the canvas.
fn owned(config: &Config, week: u64, account: &[u8; 32]) -> Week {
    let mut record = Week::load(week);
    if settle_due(config, week, &mut record) {
        record.store(week);
    }
    if record.owner == ZERO {
        fail(b"no owner");
    }
    if record.owner != *account {
        fail(b"not owner");
    }
    record
}

/// Does an owner's operation, for the owner.
fn apply(call: &Call, record: &mut Week, owner: &[u8; 32]) {
    let week = call.week;
    match call.op {
        Op::List | Op::Unlist => {
            record.price = if call.op == Op::List { call.amount } else { 0 };
            event(week, 4, &[owner, &record.price.to_le_bytes()]);
        }
        Op::Give => {
            record.owner = call.to;
            record.price = 0;
            event(week, 6, &[owner, &call.to]);
        }
        _ => {
            if call.op == Op::Name {
                host::set(&week_key(3, week), call.title);
            } else {
                host::delete(&week_key(3, week));
            }
            event(week, 7, &[owner, &framed(call.title)]);
        }
    }
    record.store(week);
}

// ---- Scheduled operations (TCR-1, now or later) -------------------------------------

/// `RUN ‖ account(32) ‖ u64 sequence`: anyone, once it is due.
fn run(config: &Config, input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    r.take(32);
    let account: [u8; 32] = r.array();
    let sequence = r.u64();
    r.end();
    let key = scheduled_key(&account, sequence);
    let Some(stored) = host::get(&key) else {
        fail(b"not scheduled");
    };
    let mut s = Reader::new(&stored, b"corrupt");
    if host::now() < s.u64() {
        fail(b"not due");
    }
    let operation = tagged(TAG_OPERATION, &[&stored[8..]]);
    let call = Call::decode(&mut s);
    s.end();
    let mut record = owned(config, call.week, &account);
    apply(&call, &mut record, &account);
    host::delete(&key);
    emit(&EXECUTED, &[&account, &sequence.to_le_bytes(), &operation]);
    host::finish(&[])
}

/// `CANCEL ‖ policy(32) ‖ Bytes(params) ‖ u64 valid_until ‖ Bytes(witness) ‖
/// u64 count ‖ count × u64 sequence`: never delayed, never needing a nonce.
fn cancel(me: &[u8; 32], input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    r.take(32);
    let policy: [u8; 32] = r.array();
    let params = r.bytes();
    let valid_until = r.u64();
    let witness = r.bytes();
    let count = r.u64();
    let list = r.items(count, 8);
    r.end();
    let sequences: Vec<u64> = list
        .as_chunks::<8>()
        .0
        .iter()
        .map(|s| u64::from_le_bytes(*s))
        .collect();
    if sequences.windows(2).any(|w| w[0] >= w[1]) {
        fail(b"bad input");
    }
    if valid_until != 0 && host::now() > valid_until {
        fail(b"expired");
    }
    let account = policy_account(&policy, params);
    let (_, nonce) = nonce_of(&account);
    let mut any = false;
    for s in &sequences {
        if *s >= nonce {
            fail(b"not scheduled");
        }
        any |= host::exists(&scheduled_key(&account, *s));
    }
    if !any {
        fail(b"not scheduled");
    }
    let mut message = framed(CALL_TAG);
    for part in [&host::chain_id()[..], me, &account, &[0x02], &valid_until.to_le_bytes(), &count.to_le_bytes(), list] {
        message.extend_from_slice(part);
    }
    authorize(&policy, params, &message, witness);
    for s in sequences {
        let key = scheduled_key(&account, s);
        if host::exists(&key) {
            host::delete(&key);
            emit(&CANCELLED, &[&account, &s.to_le_bytes()]);
        }
    }
    host::finish(&[])
}
