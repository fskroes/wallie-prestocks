/**
 * The Jupiter swap executor: a stablecoin → a PreStocks token, on Solana mainnet.
 *
 * Three calls to Jupiter's public lite API (no key):
 *   GET  /price/v3        USD price of the pay token (skipped for USDC, which is $1 by definition here)
 *   GET  /swap/v1/quote   route and expected out amount for an exact pay-token amount in
 *   POST /swap/v1/swap    a versioned transaction for that quote, signed here
 *
 * The allowance is denominated in USD, so every amount the agent decides on is
 * `usdcMicro` (micro-USD). The wallet may hold USDC or EURC; `payToken` picks
 * which mint is spent and the USD amount is converted at Jupiter's price. The
 * quote's own `swapUsdValue` is cross-checked against the intended USD so a
 * stale price can never buy 15% more than the policy allowed.
 *
 * PreStocks mints are Token-2022 with a 100 bps transfer fee and a ScaledUiAmount
 * extension. Jupiter's `outAmount` is in raw base units (9 decimals);
 * `outAmountUi` applies the decimals and the multiplier in force so the figure
 * matches what a wallet shows and what the PreStocks API prices. On 2026-09-20
 * SPACEX ran at 5x (a split) and OPENAI at 1.4861347x; ANTHROPIC at 1x.
 *
 * Nothing here touches the allowance. The policy lives in src/agent.ts; this
 * file only knows how to price and land one swap. `http` is injectable so tests
 * replay the fixtures under ./fixtures and never reach the network.
 */
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { isPreStocksMint } from "./prestocks.ts";

export const JUP_API = "https://lite-api.jup.ag/swap/v1";
export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const EURC_MAINNET = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
export const PRESTOCKS_DECIMALS = 9;
export const PRICE_API = "https://lite-api.jup.ag/price/v3";

export interface PayToken {
  symbol: "USDC" | "EURC";
  mint: string;
  decimals: number;
  /** A fixed USD price, when the token is USD by definition. Others are priced live. */
  fixedUsd?: number;
}

export const PAY_TOKENS: Record<PayToken["symbol"], PayToken> = {
  USDC: { symbol: "USDC", mint: USDC_MAINNET, decimals: 6, fixedUsd: 1 },
  EURC: { symbol: "EURC", mint: EURC_MAINNET, decimals: 6 },
};

export function payToken(symbol: string): PayToken {
  const t = PAY_TOKENS[symbol.toUpperCase() as PayToken["symbol"]];
  if (!t) throw new Error(`unknown pay token ${symbol}; known: ${Object.keys(PAY_TOKENS).join(", ")}`);
  return t;
}

/** How far Jupiter's own USD valuation of the swap may sit from the USD the policy approved. */
export const MAX_USD_DRIFT = 0.03;

export interface JupQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string }; percent: number }>;
  contextSlot?: number;
  swapUsdValue?: string;
}

export interface Quote {
  mint: string;
  /** Micro-USD the policy approved. What the allowance ledger records. */
  usdcMicro: bigint;
  /** The token actually spent, and how much of it in base units. */
  pay: { symbol: PayToken["symbol"]; mint: string; amountRaw: bigint; decimals: number; usdPrice: number };
  outRaw: bigint;
  /** Tokens out, in UI units after decimals and the ScaledUiAmount multiplier. */
  outUi: number;
  /** USD paid per UI token at this quote: usdc / outUi. */
  fillPrice: number;
  minOutRaw: bigint;
  priceImpact: number;
  slippageBps: number;
  route: string[];
  raw: JupQuote;
}

export type HttpLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface QuoteOptions {
  mint: string;
  usdcMicro: bigint;
  /** Which stablecoin the wallet spends. Default USDC. */
  payToken?: PayToken;
  /** USD per 1 pay token. Fetched from Jupiter's price API when absent and the token is not USD-fixed. */
  payUsdPrice?: number;
  slippageBps?: number;
  /** ScaledUiAmount multiplier from the mint. 1 unless PreStocks splits a token. */
  uiMultiplier?: number;
  http?: HttpLike;
}

export function outAmountUi(outRaw: bigint, uiMultiplier = 1): number {
  return (Number(outRaw) / 10 ** PRESTOCKS_DECIMALS) * uiMultiplier;
}

/** USD price of a mint from Jupiter's price API. */
export async function tokenUsdPrice(mint: string, http: HttpLike = fetch as unknown as HttpLike): Promise<number> {
  const res = await http(`${PRICE_API}?ids=${mint}`);
  if (!res.ok) throw new Error(`Jupiter price HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { usdPrice?: number } | undefined>;
  const p = Number(body[mint]?.usdPrice);
  if (!(p > 0) || !Number.isFinite(p)) throw new Error(`Jupiter has no USD price for ${mint}`);
  return p;
}

/** Base units of `token` worth `usdcMicro` micro-USD at `usdPrice` USD per token. */
export function payAmountRaw(usdcMicro: bigint, token: PayToken, usdPrice: number): bigint {
  if (!(usdPrice > 0) || !Number.isFinite(usdPrice)) throw new Error(`bad ${token.symbol} price ${usdPrice}`);
  if (token.decimals === 6 && usdPrice === 1) return usdcMicro;
  return BigInt(Math.round((Number(usdcMicro) / 1e6 / usdPrice) * 10 ** token.decimals));
}

export async function quoteBuy(o: QuoteOptions): Promise<Quote> {
  if (!isPreStocksMint(o.mint)) throw new Error(`${o.mint} is not a PreStocks mint; this buyer only buys PreStocks`);
  if (o.usdcMicro <= 0n) throw new Error("usdcMicro must be positive");
  const slippageBps = o.slippageBps ?? 100;
  const http = o.http ?? (fetch as unknown as HttpLike);
  const token = o.payToken ?? PAY_TOKENS.USDC;
  const usdPrice = o.payUsdPrice ?? token.fixedUsd ?? (await tokenUsdPrice(token.mint, http));
  const amountRaw = payAmountRaw(o.usdcMicro, token, usdPrice);
  if (amountRaw <= 0n) throw new Error(`${o.usdcMicro} micro-USD rounds to no ${token.symbol}`);
  const q = new URLSearchParams({ inputMint: token.mint, outputMint: o.mint, amount: amountRaw.toString(), slippageBps: String(slippageBps) });
  const res = await http(`${JUP_API}/quote?${q}`);
  if (!res.ok) throw new Error(`Jupiter quote HTTP ${res.status}`);
  const raw = (await res.json()) as JupQuote & { error?: string };
  if (raw.error) throw new Error(`Jupiter quote: ${raw.error}`);
  if (raw.outputMint !== o.mint) throw new Error(`Jupiter quoted ${raw.outputMint}, asked for ${o.mint}`);
  if (raw.inputMint !== token.mint) throw new Error(`Jupiter quoted a swap from ${raw.inputMint}, asked to pay with ${token.symbol} ${token.mint}`);
  if (BigInt(raw.inAmount) !== amountRaw) throw new Error(`Jupiter quoted ${raw.inAmount} in, asked for ${amountRaw}`);
  // Jupiter values the swap in USD itself. If that disagrees with what the
  // policy approved, the pay-token price is stale or wrong: refuse.
  const usd = Number(o.usdcMicro) / 1e6;
  const jupUsd = Number(raw.swapUsdValue);
  if (Number.isFinite(jupUsd) && jupUsd > 0 && Math.abs(jupUsd - usd) / usd > MAX_USD_DRIFT)
    throw new Error(`Jupiter values this swap at $${jupUsd.toFixed(2)} but the policy approved $${usd.toFixed(2)}; the ${token.symbol} price ${usdPrice} is off by more than ${MAX_USD_DRIFT * 100}%`);
  const outRaw = BigInt(raw.outAmount);
  const outUi = outAmountUi(outRaw, o.uiMultiplier);
  return {
    mint: o.mint,
    usdcMicro: o.usdcMicro,
    pay: { symbol: token.symbol, mint: token.mint, amountRaw, decimals: token.decimals, usdPrice },
    outRaw,
    outUi,
    fillPrice: Number(o.usdcMicro) / 1e6 / outUi,
    minOutRaw: BigInt(raw.otherAmountThreshold),
    priceImpact: Number(raw.priceImpactPct),
    slippageBps,
    route: raw.routePlan.map((r) => r.swapInfo.label),
    raw,
  };
}

export interface SwapOptions {
  quote: Quote;
  payer: Keypair;
  connection: Connection;
  http?: HttpLike;
  /** Skip sending; return the signed transaction bytes. For dry runs. */
  dryRun?: boolean;
}

export interface SwapResult {
  signature?: string;
  slot?: number;
  /** base64 of the signed transaction, for a dry run or for a record. */
  signedTx: string;
  dryRun: boolean;
}

export async function buildSwapTx(quote: Quote, payer: PublicKey, http: HttpLike = fetch as unknown as HttpLike): Promise<VersionedTransaction> {
  const res = await http(`${JUP_API}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userPublicKey: payer.toBase58(),
      quoteResponse: quote.raw,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap HTTP ${res.status}`);
  const body = (await res.json()) as { swapTransaction?: string; error?: string };
  if (!body.swapTransaction) throw new Error(`Jupiter swap: ${body.error ?? "no transaction returned"}`);
  return VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
}

export async function executeSwap(o: SwapOptions): Promise<SwapResult> {
  const tx = await buildSwapTx(o.quote, o.payer.publicKey, o.http);
  tx.sign([o.payer]);
  const signedTx = Buffer.from(tx.serialize()).toString("base64");
  if (o.dryRun) return { signedTx, dryRun: true };
  const signature = await o.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const bh = await o.connection.getLatestBlockhash("confirmed");
  const conf = await o.connection.confirmTransaction({ signature, ...bh }, "confirmed");
  if (conf.value.err) throw new Error(`swap ${signature} failed: ${JSON.stringify(conf.value.err)}`);
  return { signature, slot: conf.context.slot, signedTx, dryRun: false };
}

export interface ScaledUiState {
  multiplier?: string | number;
  newMultiplier?: string | number;
  newMultiplierEffectiveTimestamp?: string | number;
}

/**
 * The multiplier in force now. Token-2022 keeps two: `multiplier` and a
 * scheduled `newMultiplier` that takes effect at a unix timestamp. On
 * 2026-09-20 SPACEX had multiplier 1 and newMultiplier 5 already in effect
 * (a 5-for-1 split), so reading only `multiplier` would understate a fill by 5x.
 */
export function effectiveMultiplier(state: ScaledUiState | undefined, nowSec = Math.floor(Date.now() / 1000)): number {
  if (!state) return 1;
  const cur = Number(state.multiplier ?? 1);
  const next = Number(state.newMultiplier ?? cur);
  const at = Number(state.newMultiplierEffectiveTimestamp ?? 0);
  const m = at > 0 && at <= nowSec ? next : cur;
  return m > 0 && Number.isFinite(m) ? m : 1;
}

/** Read the ScaledUiAmount multiplier off a Token-2022 mint, 1 if the extension is absent. */
export async function uiMultiplier(connection: Connection, mint: string): Promise<number> {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const data = info.value?.data;
  if (!data || !("parsed" in data)) return 1;
  const ext = (data.parsed as { info?: { extensions?: Array<{ extension: string; state?: ScaledUiState }> } }).info?.extensions?.find(
    (e) => e.extension === "scaledUiAmountConfig",
  );
  return effectiveMultiplier(ext?.state);
}

/** Base units of `mint` held by `owner`, summed over its token accounts (Token and Token-2022). */
export async function tokenBalanceRaw(connection: Connection, owner: string, mint: string): Promise<bigint> {
  const r = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  let total = 0n;
  for (const a of r.value) {
    const amt = (a.account.data.parsed as { info?: { tokenAmount?: { amount?: string } } }).info?.tokenAmount?.amount;
    if (amt) total += BigInt(amt);
  }
  return total;
}

export function fmtToken(raw: bigint, token: PayToken): string {
  const s = raw.toString().padStart(token.decimals + 1, "0");
  return `${s.slice(0, -token.decimals)}.${s.slice(-token.decimals)} ${token.symbol}`;
}

/** An http that answers from recorded responses, keyed by "METHOD path-prefix". */
export function replayHttp(map: Record<string, unknown>): HttpLike {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const key = Object.keys(map).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && path.endsWith(p);
    });
    if (!key) return { ok: false, status: 404, json: async () => ({ error: `no fixture for ${method} ${path}` }) };
    return { ok: true, status: 200, json: async () => map[key] };
  };
}
