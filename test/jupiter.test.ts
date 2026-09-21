import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { buildSwapTx, effectiveMultiplier, executeSwap, fmtToken, outAmountUi, payAmountRaw, payToken, PAY_TOKENS, quoteBuy, replayHttp, tokenUsdPrice, EURC_MAINNET, USDC_MAINNET } from "../src/jupiter.ts";
import { FIXTURE_PAYER, PRICE_EURC, QUOTE_ANTHROPIC, QUOTE_SPACEX, QUOTE_SPACEX_EURC, SWAP_SPACEX } from "./helpers.ts";

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

test("paying in EURC: $5 becomes 4.360445 EURC at Jupiter's price, the quote is checked against the pay mint, the amount and Jupiter's own USD value", async () => {
  const http = replayHttp({ "GET /quote": QUOTE_SPACEX_EURC, "GET /price/v3": PRICE_EURC });
  const q = await quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http, uiMultiplier: 5, payToken: PAY_TOKENS.EURC });
  assert.equal(q.usdcMicro, 5_000_000n, "the ledger figure stays in USD");
  assert.equal(q.pay.symbol, "EURC");
  assert.equal(q.pay.mint, EURC_MAINNET);
  assert.equal(q.pay.amountRaw, 4_360_445n);
  assert.ok(Math.abs(q.pay.usdPrice - 1.14667) < 1e-4, String(q.pay.usdPrice));
  assert.equal(q.outRaw, 8_263_788n);
  assert.ok(q.fillPrice > 120 && q.fillPrice < 122, String(q.fillPrice));
  assert.deepEqual(q.route, ["DefiTuna", "Meteora DLMM"]);
  assert.equal(q.raw.inputMint, EURC_MAINNET);

  // USDC needs no price call and spends exactly the micro-USD.
  const u = await quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http: replayHttp({ "GET /quote": QUOTE_SPACEX }), uiMultiplier: 5 });
  assert.equal(u.pay.symbol, "USDC");
  assert.equal(u.pay.amountRaw, 5_000_000n);
  assert.equal(u.pay.usdPrice, 1);

  // A caller-supplied price is used as is; the amount follows it.
  assert.equal(payAmountRaw(5_000_000n, PAY_TOKENS.EURC, 1.25), 4_000_000n);
  assert.equal(payAmountRaw(5_000_000n, PAY_TOKENS.USDC, 1), 5_000_000n);
  assert.throws(() => payAmountRaw(1n, PAY_TOKENS.EURC, 0), /bad EURC price/);
  assert.throws(() => payToken("USDT"), /unknown pay token/);
  assert.equal(fmtToken(4_360_445n, PAY_TOKENS.EURC), "4.360445 EURC");
});

test("paying in EURC: a stale price is refused when Jupiter's USD value disagrees, and a USDC quote is refused for an EURC buy", async () => {
  // Pretend EURC were $1.00: the same $5 would send 5 EURC, worth $5.73. The fixture quote is
  // for 4.360445 EURC, so the amount check fires first; then hand it a matching in-amount and
  // let the USD-drift check catch it.
  const http = replayHttp({ "GET /quote": QUOTE_SPACEX_EURC });
  await assert.rejects(quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http, payToken: PAY_TOKENS.EURC, payUsdPrice: 1 }), /quoted 4360445 in, asked for 5000000/);
  // Jupiter would value 5 EURC at $5.73; the recording says $5.00 for 4.36 EURC, so forge both fields.
  const drifted = { ...(QUOTE_SPACEX_EURC as object), inAmount: "5000000", swapUsdValue: "5.7333" };
  await assert.rejects(quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http: replayHttp({ "GET /quote": drifted }), payToken: PAY_TOKENS.EURC, payUsdPrice: 1 }), /policy approved \$5.00/);
  // Jupiter's swapUsdValue for the recorded EURC quote is $5.00; at the recorded price the check passes (previous test).
  // An answer for the wrong input mint is refused before any of that.
  await assert.rejects(quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http: replayHttp({ "GET /quote": QUOTE_SPACEX, "GET /price/v3": PRICE_EURC }), payToken: PAY_TOKENS.EURC }), /asked to pay with EURC/);
  // No price, no buy.
  await assert.rejects(quoteBuy({ mint: SPACEX, usdcMicro: 5_000_000n, http: replayHttp({ "GET /price/v3": {} }), payToken: PAY_TOKENS.EURC }), /no USD price/);
  await assert.rejects(tokenUsdPrice(EURC_MAINNET, replayHttp({})), /HTTP 404/);
});
