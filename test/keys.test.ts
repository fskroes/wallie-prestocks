import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { base58Decode, base58Encode, loadKeypair, parseKeyFile } from "../src/keys.ts";
import { FIXTURE_PAYER } from "./helpers.ts";

const secret58 = base58Encode(FIXTURE_PAYER.secretKey);
const addr = FIXTURE_PAYER.publicKey.toBase58();

test("base58 round-trips, keeps leading zero bytes, refuses the ambiguous letters", () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 255, 128, 7]);
  assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  assert.equal(base58Encode(Uint8Array.from([0])), "1");
  assert.deepEqual(base58Decode(secret58), FIXTURE_PAYER.secretKey);
  assert.throws(() => base58Decode("0OIl"), /not base58/);
});

test("parseKeyFile reads a 64-number JSON array, a bare base58 secret, a 32-byte seed, and key=value lines", () => {
  const json = parseKeyFile(JSON.stringify(Array.from(FIXTURE_PAYER.secretKey)));
  assert.equal(json.form, "json-array");
  assert.equal(json.keypair.publicKey.toBase58(), addr);

  const bare = parseKeyFile(`${secret58}\n`);
  assert.equal(bare.form, "base58");
  assert.equal(bare.keypair.publicKey.toBase58(), addr);

  const seed = parseKeyFile(base58Encode(Buffer.alloc(32, 7)));
  assert.equal(seed.keypair.publicKey.toBase58(), addr, "a 32-byte value is a seed");

  const kv = parseKeyFile(`address=${addr}\nprivate=${secret58}\n\n`);
  assert.equal(kv.form, "key=value");
  assert.equal(kv.claimedAddress, addr);
  assert.equal(kv.keypair.publicKey.toBase58(), addr);
  // Quotes, CRLF, comments and other spellings of the key names are fine.
  const messy = parseKeyFile(`# my wallet\r\nPublicKey = "${addr}"\r\nsecret_key='${secret58}'\r\n`);
  assert.equal(messy.keypair.publicKey.toBase58(), addr);
  // The label only has to contain "private" or "secret": a wallet export's own naming works.
  const exported = parseKeyFile(`address=${addr}\nprivate_key_base58=${secret58}\n`);
  assert.equal(exported.claimedAddress, addr);
  assert.equal(exported.keypair.publicKey.toBase58(), addr);
});

test("parseKeyFile refuses a key that does not match the address the file claims, and every bad shape", () => {
  const other = Keypair.generate().publicKey.toBase58();
  assert.throws(() => parseKeyFile(`address=${other}\nprivate=${secret58}`), /does not match/);
  assert.throws(() => parseKeyFile(""), /empty/);
  assert.throws(() => parseKeyFile("address=" + addr), /no private key line/);
  assert.throws(() => parseKeyFile(base58Encode(Buffer.alloc(40, 1))), /40 bytes/);
  assert.throws(() => parseKeyFile("[1,2,3]"), /3 bytes/);
  assert.throws(() => parseKeyFile("[1,300]"), /0–255/);
  assert.throws(() => parseKeyFile(`${secret58} ${secret58}`), /whitespace/);
});

test("loadKeypair reads the file from disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-prestocks-keys-"));
  const file = path.join(dir, "agent.json");
  fs.writeFileSync(file, `address=${addr}\nprivate=${secret58}\n`);
  assert.equal(loadKeypair(file).keypair.publicKey.toBase58(), addr);
  assert.throws(() => loadKeypair(path.join(dir, "missing")), /ENOENT/);
});
