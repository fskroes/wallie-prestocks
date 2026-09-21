/**
 * Load a Solana signing key from a file, in any of the shapes people actually have:
 *
 *   [12,34,…]                       a 64-number JSON array (solana-keygen)
 *   5Kd3…                           a base58 64-byte secret (Phantom / Backpack export)
 *   private_key_base58=5Kd3…        key=value lines (any label with "private" or "secret");
 *                                   an `address=` line is checked against the key
 *
 * A 32-byte value is taken as a seed. Any other length is refused. If the file
 * names an address and the key derives a different one, that is an error: the
 * wrong key must never sign a swap.
 */
import fs from "node:fs";
import { Keypair } from "@solana/web3.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: "${c}"`);
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** Any label that contains one of these words names the secret; `private_key_base58`, `secretKey`, `PRIVATE=` all match. */
const SECRET_WORDS = ["private", "secret"];
const ADDRESS_WORDS = ["address", "public", "pubkey"];
const labelFor = (m: Map<string, string>, words: string[]) => [...m.keys()].find((k) => words.some((w) => k.includes(w)));

/** key=value lines → a map with lower-cased keys. Lines without `=` are ignored. */
function kv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0 || line.startsWith("#")) continue;
    m.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return m;
}

function bytesOf(value: string): Uint8Array {
  const t = value.trim();
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as unknown;
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("a JSON key must be an array of byte values 0–255");
    return Uint8Array.from(arr as number[]);
  }
  return base58Decode(t);
}

export interface ParsedKey {
  keypair: Keypair;
  /** The address the file claimed, if any. Always equal to keypair.publicKey when returned. */
  claimedAddress?: string;
  form: "json-array" | "base58" | "key=value";
}

export function parseKeyFile(text: string): ParsedKey {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("the key file is empty");
  let secret: string;
  let form: ParsedKey["form"];
  let claimedAddress: string | undefined;
  if (trimmed.startsWith("[")) {
    secret = trimmed;
    form = "json-array";
  } else if (trimmed.includes("=")) {
    const m = kv(trimmed);
    const k = labelFor(m, SECRET_WORDS);
    if (!k) throw new Error(`no private key line; expected a label containing "private" or "secret", such as private_key_base58=…`);
    secret = m.get(k)!;
    form = "key=value";
    const a = labelFor(m, ADDRESS_WORDS);
    if (a) claimedAddress = m.get(a);
  } else {
    if (/\s/.test(trimmed)) throw new Error("a base58 key must be one token; got whitespace inside");
    secret = trimmed;
    form = "base58";
  }
  const bytes = bytesOf(secret);
  let keypair: Keypair;
  if (bytes.length === 64) keypair = Keypair.fromSecretKey(bytes);
  else if (bytes.length === 32) keypair = Keypair.fromSeed(bytes);
  else throw new Error(`the key decodes to ${bytes.length} bytes; expected a 64-byte secret key or a 32-byte seed`);
  if (claimedAddress && claimedAddress !== keypair.publicKey.toBase58())
    throw new Error(`the key file says address ${claimedAddress} but the private key derives ${keypair.publicKey.toBase58()}; refusing to sign with a key that does not match`);
  return { keypair, claimedAddress, form };
}

export function loadKeypair(file: string): ParsedKey {
  return parseKeyFile(fs.readFileSync(file, "utf8"));
}
