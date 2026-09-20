import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { buildSwapTx, effectiveMultiplier, executeSwap, outAmountUi, quoteBuy, replayHttp, USDC_MAINNET } from "../src/jupiter.ts";
import { FIXTURE_PAYER, QUOTE_ANTHROPIC, QUOTE_SPACEX, SWAP_SPACEX } from "./helpers.ts";

const ANTHROPIC = "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw";
const SPACEX = "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh";

test("a recorded $5 ANTHROPIC quote: 0.004789 tokens at 1x, fill $1044 vs API token $1035.77 and mark $1034.99", async () => {
  const q = await quoteBuy({ mint: ANTHROPIC, usdcMicro: 5_000_000n, http: replayHttp({ "GET /quote": QUOTE_ANTHROPIC }) });
  assert.equal(q.outRaw, 4_788_752n);
  assert.equal(q.outUi, 0.004788752);
  assert.ok(q.fillPrice > 1043 && q.fillPrice < 1045, String(q.fillPrice));
  assert.ok(q.priceImpact < 0.01);
  assert.deepEqual(q.route, ["AlphaQ", "GoonFi V2", "Manifest"]);
  assert.equal(q.minOutRaw, 4_740_865n);
  assert.equal(q.raw.inputMint, USDC_MAINNET);
});

test("a recorded $5 SPACEX quote through Meteora DLMM: at the 5x multiplier the fill is $121, near the API's $118 and 20% under the $151 mark", async () => {
  const q = await quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http: replayHttp({ "GET /quote": QUOTE_SPACEX }), uiMultiplier: 5 });
  assert.equal(q.outRaw, 8_242_026n);
  assert.deepEqual(q.route, ["Meteora DLMM"]);
  assert.ok(Math.abs(q.outUi - 0.04121013) < 1e-9, String(q.outUi));
  assert.ok(q.fillPrice > 121 && q.fillPrice < 122, String(q.fillPrice));
  // Read at 1x by mistake, the same fill would print as $606: the multiplier is not optional.
  const naive = await quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http: replayHttp({ "GET /quote": QUOTE_SPACEX }) });
  assert.ok(naive.fillPrice > 600 && naive.fillPrice < 610);
});

test("ScaledUiAmount: the scheduled multiplier wins once its timestamp has passed", () => {
  // SPACEX mint state on 2026-09-20: multiplier 1, newMultiplier 5, effective 1781065800 (2026-06-07).
  const spacex = { multiplier: "1", newMultiplier: "5", newMultiplierEffectiveTimestamp: 1781065800 };
  assert.equal(effectiveMultiplier(spacex, 1789934384), 5);
  assert.equal(effectiveMultiplier(spacex, 1781065799), 1);
  // OPENAI: 1.4861347 effective 1784305800.
  assert.equal(effectiveMultiplier({ multiplier: "1", newMultiplier: "1.4861347", newMultiplierEffectiveTimestamp: 1784305800 }, 1789934384), 1.4861347);
  // ANTHROPIC: no scheduled change.
  assert.equal(effectiveMultiplier({ multiplier: "1", newMultiplier: "1", newMultiplierEffectiveTimestamp: 0 }, 1789934384), 1);
  assert.equal(effectiveMultiplier(undefined), 1);
  assert.equal(effectiveMultiplier({ multiplier: "0" }), 1);
  assert.equal(outAmountUi(8_242_026n), 0.008242026);
});

test("quoteBuy refuses non-PreStocks mints, zero amounts, a mismatched route and an API error", async () => {
  await assert.rejects(quoteBuy({ mint: USDC_MAINNET, usdcMicro: 1n }), /only buys PreStocks/);
  await assert.rejects(quoteBuy({ mint: ANTHROPIC, usdcMicro: 0n }), /positive/);
  await assert.rejects(quoteBuy({ mint: SPACEX, usdcMicro: 1n, http: replayHttp({ "GET /quote": QUOTE_ANTHROPIC }) }), /quoted Pren1/);
  await assert.rejects(quoteBuy({ mint: SPACEX, usdcMicro: 1n, http: replayHttp({ "GET /quote": { error: "no route" } }) }), /no route/);
  await assert.rejects(quoteBuy({ mint: SPACEX, usdcMicro: 1n, http: replayHttp({}) }), /HTTP 404/);
});

test("buildSwapTx deserializes Jupiter's versioned transaction; executeSwap dry-run signs it and sends nothing", async () => {
  const http = replayHttp({ "GET /quote": QUOTE_SPACEX, "POST /swap": SWAP_SPACEX });
  const q = await quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http, uiMultiplier: 5 });
  const tx = await buildSwapTx(q, FIXTURE_PAYER.publicKey, http);
  assert.ok(tx instanceof VersionedTransaction);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), FIXTURE_PAYER.publicKey.toBase58());

  let sent = 0;
  const connection = { sendRawTransaction: async () => { sent++; return "x"; } } as never;
  const r = await executeSwap({ quote: q, payer: FIXTURE_PAYER, connection, http, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(sent, 0);
  const signed = VersionedTransaction.deserialize(Buffer.from(r.signedTx, "base64"));
  assert.equal(signed.signatures.length, 1);
  assert.ok(signed.signatures[0].some((b) => b !== 0), "the dry run must produce a real signature");

  // A key that is not the fee payer cannot sign this transaction.
  await assert.rejects(executeSwap({ quote: q, payer: Keypair.generate(), connection, http, dryRun: true }), /non signer key/);
});

test("executeSwap sends, confirms, and surfaces an on-chain error", async () => {
  const http = replayHttp({ "GET /quote": QUOTE_SPACEX, "POST /swap": SWAP_SPACEX });
  const q = await quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http, uiMultiplier: 5 });
  const ok = {
    sendRawTransaction: async () => "SIGOK",
    getLatestBlockhash: async () => ({ blockhash: "b", lastValidBlockHeight: 1 }),
    confirmTransaction: async () => ({ context: { slot: 42 }, value: { err: null } }),
  } as never;
  const r = await executeSwap({ quote: q, payer: FIXTURE_PAYER, connection: ok, http });
  assert.equal(r.signature, "SIGOK");
  assert.equal(r.slot, 42);
  assert.equal(r.dryRun, false);

  const bad = { ...(ok as object), confirmTransaction: async () => ({ context: { slot: 43 }, value: { err: { InstructionError: [3, "Custom"] } } }) } as never;
  await assert.rejects(executeSwap({ quote: q, payer: FIXTURE_PAYER, connection: bad, http }), /swap SIGOK failed/);
});

test("Jupiter swap without a transaction is an error", async () => {
  const http = replayHttp({ "GET /quote": QUOTE_SPACEX, "POST /swap": { error: "rate limited" } });
  const q = await quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http });
  await assert.rejects(buildSwapTx(q, FIXTURE_PAYER.publicKey, http), /rate limited/);
});
