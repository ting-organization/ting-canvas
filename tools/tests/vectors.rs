//! TCR-1's shared test vectors, docs/tcr-1-vectors.json, which the page's
//! JavaScript writes (scripts/tcr-vectors.mjs), rebuilt here from their parts
//! with the reference node's hash: templates, operations, messages, digests,
//! the call bytes of each approval, compressed values, scheduled operations
//! and cancels. The canvas program, deployed with the vectors' configuration,
//! stores the template list they hold.
use miniz_oxide::inflate::{
    TINFLStatus,
    core::{DecompressorOxide, decompress, inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF},
};
use serde_json::Value;
use std::fs;
use ting_core::{
    hash::hash,
    meter::Resources,
    protocol::{Genesis, Payload, Status, Transaction},
    state::State,
    vm::{Context, Runtime},
};

fn vectors() -> Value {
    serde_json::from_str(&fs::read_to_string("../docs/tcr-1-vectors.json").unwrap()).unwrap()
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2) && text.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)), "{text}");
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn field(v: &Value, name: &str) -> Vec<u8> {
    unhex(v[name].as_str().unwrap_or_else(|| panic!("no {name} in {v}")))
}

fn text<'a>(v: &'a Value, name: &str) -> &'a str {
    v[name].as_str().unwrap_or_else(|| panic!("no {name} in {v}"))
}

fn number(v: &Value, name: &str) -> u64 {
    text(v, name).parse().unwrap()
}

fn bytes(b: &[u8]) -> Vec<u8> {
    [&(b.len() as u32).to_le_bytes()[..], b].concat()
}

fn template_hash(template: &str) -> [u8; 32] {
    hash("app/call-v1/template", template.as_bytes())
}

/// `T ‖ values`.
fn head(v: &Value) -> Vec<u8> {
    [&template_hash(text(v, "template"))[..], &field(v, "values")].concat()
}

fn policy_account(policy: &[u8], params: &[u8]) -> [u8; 32] {
    hash("app/account-v1/policy", &[policy, &bytes(params)].concat())
}

fn call_message(chain: &[u8], program: &[u8], account: &[u8], nonce: u64, valid_until: u64, operation: &[u8]) -> Vec<u8> {
    [&bytes(b"app/call-v1")[..], chain, program, account, &[1], &nonce.to_le_bytes(), &valid_until.to_le_bytes(), operation].concat()
}

/// Raw DEFLATE that must end exactly and unpack to at most 65,536 bytes.
fn unpack(packed: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut out = vec![0; 65_537];
    let mut d = DecompressorOxide::new();
    let (status, read, written) = decompress(&mut d, packed, &mut out, 0, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    match status {
        TINFLStatus::Done if written > 65_536 => Err("too long"),
        TINFLStatus::Done if read != packed.len() => Err("bytes after the end"),
        TINFLStatus::Done => {
            out.truncate(written);
            Ok(out)
        }
        TINFLStatus::HasMoreOutput => Err("too long"),
        _ => Err("does not decompress"),
    }
}

fn base64url(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in text.bytes() {
        acc = acc << 6 | ALPHABET.iter().position(|&a| a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    assert_eq!(acc & ((1 << bits) - 1), 0, "bits left over");
    out
}

/// A template list's templates, refusing what is malformed.
fn template_list(list: &[u8]) -> Option<Vec<String>> {
    let count = u64::from_le_bytes(list.get(..8)?.try_into().ok()?);
    let mut at = 8;
    let mut out = Vec::new();
    for _ in 0..count {
        let len = u32::from_le_bytes(list.get(at..at + 4)?.try_into().ok()?) as usize;
        out.push(String::from_utf8(list.get(at + 4..at + 4 + len)?.to_vec()).ok()?);
        at += 4 + len;
    }
    (at == list.len()).then_some(out)
}

#[test]
fn the_fixed_hashes() {
    let v = vectors();
    let account = [0x22; 32];
    let expected = [
        ("H(\"app/call-v1/templates\", \"\")", hash("app/call-v1/templates", b"")),
        ("H(\"app/call-v1/events\", \"\"), reserved", hash("app/call-v1/events", b"")),
        ("H(\"app/call-v1/nonce\", 22…22)", hash("app/call-v1/nonce", &account)),
        ("H(\"app/call-v1/scheduled\", 22…22 ‖ u64 0)", hash("app/call-v1/scheduled", &[&account[..], &0u64.to_le_bytes()].concat())),
        ("H(\"app/call-v1/run\", \"\")", hash("app/call-v1/run", b"")),
        ("H(\"app/call-v1/cancel\", \"\")", hash("app/call-v1/cancel", b"")),
        ("H(\"app/call-v1/event/scheduled\", \"\")", hash("app/call-v1/event/scheduled", b"")),
        ("H(\"app/call-v1/event/executed\", \"\")", hash("app/call-v1/event/executed", b"")),
        ("H(\"app/call-v1/event/cancelled\", \"\")", hash("app/call-v1/event/cancelled", b"")),
    ];
    let tags = v["tags"].as_object().unwrap();
    assert_eq!(tags.len(), expected.len());
    for (name, h) in expected {
        assert_eq!(text(&v["tags"], name), hex(&h), "{name}");
    }
}

#[test]
fn templates_values_and_operations() {
    let v = vectors();
    for t in v["templates"].as_array().unwrap() {
        let template = text(t, "template");
        assert!(template.len() <= 512);
        assert_eq!(field(t, "hex"), template.as_bytes());
        assert_eq!(field(t, "T"), template_hash(template), "{template}");
        assert!(template.starts_with(text(t, "declaration")));
    }
    for t in v["values"].as_array().unwrap() {
        assert_eq!(field(t, "operation"), hash("app/call-v1/operation", &head(t)), "{}", text(t, "name"));
    }
    let chain = field(&v, "chain_id");
    let program = field(&v, "program");
    for o in v["operations"].as_array().unwrap() {
        let operation = hash("app/call-v1/operation", &head(o));
        assert_eq!(field(o, "T"), template_hash(text(o, "template")));
        assert_eq!(field(o, "operation"), operation);
        let message = call_message(&chain, &program, &field(o, "account"), number(o, "nonce"), number(o, "valid_until"), &operation);
        assert_eq!(field(o, "message"), message, "{}", text(o, "name"));
        assert_eq!(field(o, "digest"), hash("app/sign-v1", &message));
    }
}

#[test]
fn the_call_bytes_of_each_approval() {
    let v = vectors();
    let chain = field(&v, "chain_id");
    let program = field(&v, "program");
    let mut kinds = Vec::new();
    for c in v["calls"].as_array().unwrap() {
        let name = text(c, "name");
        let head = head(c);
        let operation = hash("app/call-v1/operation", &head);
        let kind = text(c, "kind");
        kinds.push(kind);
        if kind == "program" {
            let account = hash("app/account-v1/contract", &field(c, "caller"));
            assert_eq!(field(c, "account"), account);
            assert_eq!(field(c, "call"), [&head[..], &[1, 0]].concat(), "{name}");
            let executed = [&hash("app/call-v1/event/executed", b"")[..], &account, &0u64.to_le_bytes(), &operation].concat();
            assert_eq!(field(c, "executed"), executed);
            continue;
        }
        let (policy, params) = (field(c, "policy"), field(c, "params"));
        let account = policy_account(&policy, &params);
        assert_eq!(field(c, "account"), account);
        let (nonce, valid_until) = (number(c, "nonce"), number(c, "valid_until"));
        let message = call_message(&chain, &program, &account, nonce, valid_until, &operation);
        let digest = hash("app/sign-v1", &message);
        assert_eq!(field(c, "message"), message);
        assert_eq!(field(c, "digest"), digest);
        let witness = field(c, "witness");
        let auth = [&[0][..], &policy, &bytes(&params), &nonce.to_le_bytes(), &valid_until.to_le_bytes(), &bytes(&witness)].concat();
        let payments = if kind == "payment" || kind == "fee" {
            // The payment is the approval: no witness of the call's own.
            assert!(witness.is_empty(), "{name}");
            let p = &c["payment"];
            let (coin, coin_nonce) = (field(p, "coin"), number(p, "coin_nonce"));
            let fee: u128 = text(p, "fee").parse().unwrap();
            if kind == "fee" {
                // A transfer of 0 to the program's own account, carrying the fee.
                assert_eq!(field(p, "effect"), fee_effect(&program), "{name}");
                assert!(!text(c, "template").contains("{payment}") && fee > 0);
            }
            let action = [
                &field(p, "effect")[..],
                &fee.to_le_bytes(),
                &0u128.to_le_bytes(),
                &0u64.to_le_bytes(),
                &valid_until.to_le_bytes(),
                &[1],
                &program,
                &digest,
            ]
            .concat();
            assert_eq!(field(p, "action"), action);
            let coin_message = [&bytes(b"app/coin-v1")[..], &chain, &coin, &account, &[0x10], &coin_nonce.to_le_bytes(), &action].concat();
            assert_eq!(field(p, "coin_message"), coin_message);
            assert_eq!(field(p, "coin_digest"), hash("app/sign-v1", &coin_message));
            let coin_input =
                [&[0x10, 0][..], &policy, &bytes(&params), &coin_nonce.to_le_bytes(), &bytes(&field(p, "coin_witness")), &action].concat();
            assert_eq!(field(p, "coin_input"), coin_input);
            [&[1][..], &coin, &bytes(&coin_input)].concat()
        } else {
            vec![0]
        };
        assert_eq!(field(c, "call"), [&head[..], &auth, &payments].concat(), "{name}");
    }
    assert!(["witness", "payment", "fee", "program"].iter().all(|k| kinds.contains(k)));
}

fn fee_effect(program: &[u8]) -> Vec<u8> {
    [&[1][..], &hash("app/account-v1/contract", program), &0u128.to_le_bytes()].concat()
}

struct Take<'a>(&'a [u8]);

impl<'a> Take<'a> {
    fn n(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        if self.0.len() < n {
            return Err("bad input");
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }
    fn u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.n(1)?[0])
    }
    fn u64(&mut self) -> Result<u64, &'static str> {
        Ok(u64::from_le_bytes(self.n(8)?.try_into().unwrap()))
    }
    fn bytes(&mut self) -> Result<&'a [u8], &'static str> {
        let len = u32::from_le_bytes(self.n(4)?.try_into().unwrap()) as usize;
        self.n(len)
    }
}

/// What a program checks of a call with a payment before it calls the coin
/// (TCR-1, payments and fee payments), for a program that takes `coin`.
fn check_paid_call(call: &[u8], template: &str, values: usize, chain: &[u8], program: &[u8], coin: &[u8]) -> Result<(), &'static str> {
    let mut r = Take(call);
    let head = r.n(32 + values)?;
    if r.u8()? != 0 {
        return Err("bad input");
    }
    let (policy, params, nonce, valid_until, witness) = (r.n(32)?, r.bytes()?, r.u64()?, r.u64()?, r.bytes()?);
    let count = r.u8()?;
    if count != 1 {
        return Err("more than one payment");
    }
    let (paid_in, input) = (r.n(32)?, r.bytes()?);
    if !r.0.is_empty() {
        return Err("bad input");
    }
    if paid_in != coin {
        return Err("bad coin");
    }
    let account = policy_account(policy, params);
    let digest = hash("app/sign-v1", &call_message(chain, program, &account, nonce, valid_until, &hash("app/call-v1/operation", head)));
    let mut p = Take(input);
    if p.n(2)? != [0x10, 0] {
        return Err("bad payment");
    }
    let payer = policy_account(p.n(32)?, p.bytes()?);
    p.u64()?;
    p.bytes()?;
    let effect = match p.0.first() {
        Some(1) => p.n(1 + 32 + 16)?,
        Some(2) => p.n(1 + 16)?,
        _ => return Err("bad payment"),
    };
    p.n(16 + 16 + 8 + 8)?;
    if p.u8()? != 1 || p.n(32)? != program || p.n(32)? != digest || !p.0.is_empty() {
        return Err("not bound");
    }
    if payer != account {
        return Err("payer is not the actor");
    }
    if !witness.is_empty() {
        return Err("witness with a payment");
    }
    let amount = u128::from_le_bytes(effect[effect.len() - 16..].try_into().unwrap());
    let fee = effect == fee_effect(program).as_slice();
    match template.contains("{payment}") {
        true if fee || amount == 0 => Err("not the payment its template shows"),
        false if !fee => Err("not a fee payment"),
        _ => Ok(()),
    }
}

#[test]
fn fee_payments_and_the_calls_a_program_refuses() {
    let v = vectors();
    let (chain, program, coin) = (field(&v, "chain_id"), field(&v, "program"), field(&v, "coin"));
    let check = |c: &Value| {
        check_paid_call(&field(c, "call"), text(c, "template"), field(c, "values").len(), &chain, &program, &coin)
    };
    let paid: Vec<&Value> = v["calls"].as_array().unwrap().iter().filter(|c| c.get("payment").is_some()).collect();
    assert_eq!(paid.len(), 3);
    for c in paid {
        assert_eq!(check(c), Ok(()), "{}", text(c, "name"));
    }
    for c in v["refused_calls"].as_array().unwrap() {
        assert_eq!(check(c), Err(text(c, "rule")), "{}", text(c, "name"));
    }
}

#[test]
fn compressed_values() {
    let v = vectors();
    for z in v["zvalues"].as_array().unwrap() {
        let name = text(z, "name");
        let unpacked = unpack(&base64url(text(z, "zvalues")));
        if z.get("refused").is_some() {
            assert!(unpacked.is_err(), "{name}");
        } else if let Some(values) = z.get("values") {
            assert_eq!(hex(&unpacked.unwrap()), values.as_str().unwrap(), "{name}");
        } else {
            assert_eq!(unpacked.unwrap().len() as u64, z["unpacked_length"].as_u64().unwrap(), "{name}");
        }
    }
}

#[test]
fn template_lists() {
    let v = vectors();
    let lists = &v["template_lists"];
    assert_eq!(field(lists, "key"), hash("app/call-v1/templates", b""));
    for l in lists["lists"].as_array().unwrap() {
        let templates: Vec<&str> = l["templates"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
        assert_eq!(template_list(&field(l, "hex")).unwrap(), templates);
    }
    for l in lists["refused"].as_array().unwrap() {
        let parsed = template_list(&field(l, "hex"));
        match text(l, "rule") {
            "malformed" => assert!(parsed.is_none(), "{}", text(l, "name")),
            "each template once" => {
                let parsed = parsed.unwrap();
                assert!(parsed.iter().enumerate().any(|(i, t)| parsed[..i].contains(t)));
            }
            "one declaration per operation name" => {
                let declaration = |t: &str| t[..t.find("): ").unwrap() + 3].to_string();
                let parsed = parsed.unwrap();
                let link = text(l, "link_template");
                let name = &link[..link.find('(').unwrap()];
                assert!(parsed.iter().any(|t| t.starts_with(&format!("{name}(")) && declaration(t) != declaration(link)));
            }
            rule => panic!("a rule this test does not know: {rule}"),
        }
    }
}

#[test]
fn the_canvas_stores_the_vectors_template_list() {
    let v = vectors();
    let context = Context::from_genesis(&Genesis::experimental());
    let runtime = Runtime::new(State::default(), context.clone());
    let payload = Payload::Deploy {
        code: fs::read("../canvas.wasm").unwrap(),
        input: field(&v["canvas"], "deployment"),
    };
    let budget = Resources([200_000_000, 4096, 4_000_000, 4_000_000]);
    let receipt = runtime.execute(&Transaction { budget, payload }).unwrap();
    assert_eq!(receipt.status, Status::Success, "{}", String::from_utf8_lossy(&receipt.result));
    let canvas: [u8; 32] = receipt.result.try_into().unwrap();
    let mut state = State::default();
    for change in runtime.state_changes().unwrap().records {
        if change.after.is_some() {
            state.set(change.key, change.after);
        }
    }
    state.commit();
    let stored = Runtime::new(state, context).storage(canvas, hash("app/call-v1/templates", b"")).unwrap();
    assert_eq!(hex(&stored), text(&v["canvas"], "template_list"));
    assert_eq!(hex(&stored), text(&v["template_lists"]["lists"][2], "hex"));
}

#[test]
fn scheduled_runs_and_cancels() {
    let v = vectors();
    let chain = field(&v, "chain_id");
    let program = field(&v, "program");
    let s = &v["scheduled"];
    let account = policy_account(&field(s, "policy"), &field(s, "params"));
    assert_eq!(field(s, "account"), account);
    let (sequence, execute_at) = (number(s, "sequence").to_le_bytes(), number(s, "execute_at").to_le_bytes());
    let head = head(s);
    assert_eq!(field(s, "key"), hash("app/call-v1/scheduled", &[&account[..], &sequence].concat()));
    assert_eq!(field(s, "record"), [&execute_at[..], &head].concat());
    let scheduled = hash("app/call-v1/event/scheduled", b"");
    assert_eq!(field(s, "event"), [&scheduled[..], &account, &sequence, &execute_at, &head].concat());
    assert_eq!(field(s, "run"), [&hash("app/call-v1/run", b"")[..], &account, &sequence].concat());
    let executed = hash("app/call-v1/event/executed", b"");
    assert_eq!(field(s, "executed"), [&executed[..], &account, &sequence, &hash("app/call-v1/operation", &head)].concat());

    let c = &v["cancel"];
    let (policy, params) = (field(c, "policy"), field(c, "params"));
    let account = policy_account(&policy, &params);
    let valid_until = number(c, "valid_until").to_le_bytes();
    let sequences: Vec<u64> = c["sequences"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().parse().unwrap()).collect();
    let mut tail = (sequences.len() as u64).to_le_bytes().to_vec();
    for s in &sequences {
        tail.extend(s.to_le_bytes());
    }
    let message = [&bytes(b"app/call-v1")[..], &chain, &program, &account, &[2], &valid_until, &tail].concat();
    assert_eq!(field(c, "message"), message);
    assert_eq!(field(c, "digest"), hash("app/sign-v1", &message));
    let input =
        [&hash("app/call-v1/cancel", b"")[..], &policy, &bytes(&params), &valid_until, &bytes(&field(c, "witness")), &tail].concat();
    assert_eq!(field(c, "input"), input);
    let cancelled = hash("app/call-v1/event/cancelled", b"");
    for (event, s) in c["cancelled"].as_array().unwrap().iter().zip(&sequences) {
        assert_eq!(unhex(event.as_str().unwrap()), [&cancelled[..], &account, &s.to_le_bytes()].concat());
    }
}
