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
  usdcMicro: bigint;
  pay: { symbol: PayToken["symbol"]; mint: string; amountRaw: bigint; decimals: number; usdPrice: number };
  outRaw: bigint;
  outUi: number;
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
  payToken?: PayToken;
  payUsdPrice?: number;
  slippageBps?: number;
  uiMultiplier?: number;
  http?: HttpLike;
}

export function outAmountUi(outRaw: bigint, uiMultiplier = 1): number {
  return (Number(outRaw) / 10 ** PRESTOCKS_DECIMALS) * uiMultiplier;
}

export async function tokenUsdPrice(mint: string, http: HttpLike = fetch as unknown as HttpLike): Promise<number> {
  const res = await http(`${PRICE_API}?ids=${mint}`);
  if (!res.ok) throw new Error(`Jupiter price HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { usdPrice?: number } | undefined>;
  const p = Number(body[mint]?.usdPrice);
  if (!(p > 0) || !Number.isFinite(p)) throw new Error(`Jupiter has no USD price for ${mint}`);
  return p;
}

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
  dryRun?: boolean;
}

export interface SwapResult {
  signature?: string;
  slot?: number;
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

export function effectiveMultiplier(state: ScaledUiState | undefined, nowSec = Math.floor(Date.now() / 1000)): number {
  if (!state) return 1;
  const cur = Number(state.multiplier ?? 1);
  const next = Number(state.newMultiplier ?? cur);
  const at = Number(state.newMultiplierEffectiveTimestamp ?? 0);
  const m = at > 0 && at <= nowSec ? next : cur;
  return m > 0 && Number.isFinite(m) ? m : 1;
}

export async function uiMultiplier(connection: Connection, mint: string): Promise<number> {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const data = info.value?.data;
  if (!data || !("parsed" in data)) return 1;
  const ext = (data.parsed as { info?: { extensions?: Array<{ extension: string; state?: ScaledUiState }> } }).info?.extensions?.find(
    (e) => e.extension === "scaledUiAmountConfig",
  );
  return effectiveMultiplier(ext?.state);
}

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
