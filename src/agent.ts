/**
 * The Wallie PreStocks agent. Two layers, one allowance:
 *
 *   watch   pay for premium reports over x402 `upto`, raise alerts on rules
 *   buy     when a rule fires, buy the token on Jupiter, inside a buy policy
 *
 * The report spend and the buy spend draw from the same Wallie allowance, so
 * the total the agent can move is one number the operator set. The buy policy
 * adds four limits on top of the allowance rails:
 *
 *   maxPerTradeUsd      one swap never exceeds this
 *   maxTotalUsd         the sum of all fills in this session never exceeds this
 *   maxPriceImpact      Jupiter's quoted impact must be below this
 *   maxFillOverMark     the fill price must be at most (1 + this) × mark
 *
 * A buy is a real, irreversible swap. `execute` is injectable so tests and
 * the offline demo show the policy deciding without touching mainnet. The
 * live executor is in src/jupiter.ts and the demo only wires it in with
 * `--i-mean-mainnet`.
 *
 * Alert rules (all from the report, all explainable in one line):
 *   discount    a watched symbol trades at or below −minDiscount of mark
 *   premium     a watched symbol trades at or above +maxPremium of mark
 *   crossed     a watched symbol's sign flipped since the last poll
 */
import { payingFetch, type PaidResult, type PayContext } from "allowance-kit";
import type { Line, PremiumReport } from "./report.ts";
import { fmtToken, type Quote } from "./jupiter.ts";

export interface WatchRules {
  /** Alert when premium ≤ −minDiscount. 0.03 = 3% below mark. */
  minDiscount: number;
  /** Alert when premium ≥ maxPremium. */
  maxPremium: number;
}

export const DEFAULT_RULES: WatchRules = { minDiscount: 0.03, maxPremium: 0.1 };

export interface BuyPolicy {
  /** Symbols the agent may buy. Empty means none: watch only. */
  symbols: string[];
  /** Buy when premium ≤ −buyBelowDiscount. Defaults to rules.minDiscount. */
  buyBelowDiscount?: number;
  maxPerTradeUsd: number;
  maxTotalUsd: number;
  maxPriceImpact: number;
  maxFillOverMark: number;
  /** At most one buy per symbol per session. Default true. */
  oncePerSymbol?: boolean;
}

export interface Alert {
  rule: "discount" | "premium" | "crossed";
  symbol: string;
  detail: string;
  at: string;
  line: Line;
}

export interface BuyDecision {
  symbol: string;
  mint: string;
  /** Micro-USD the policy approved and the ledger records. */
  usdcMicro: bigint;
  /** What the wallet actually spent: USDC or EURC, base units, and the USD price used. */
  pay?: Quote["pay"];
  /** Why it did or did not go ahead, in one line. */
  reason: string;
  allowed: boolean;
  quote?: Quote;
  signature?: string;
  slot?: number;
  dryRun?: boolean;
  /** The ledger row id when the fill was recorded against the allowance. */
  recorded?: boolean;
}

export interface Poll {
  n: number;
  paid: PaidResult<PremiumReport>;
  report?: PremiumReport;
  alerts: Alert[];
  buys: BuyDecision[];
  spentMicro: bigint;
  /** USDC moved into PreStocks so far, micro. */
  boughtMicro: bigint;
}

export interface Executor {
  quote(mint: string, usdcMicro: bigint): Promise<Quote>;
  swap(quote: Quote): Promise<{ signature?: string; slot?: number; dryRun: boolean }>;
}

export interface WatchOptions {
  ctx: PayContext;
  serverUrl: string;
  watch: string[];
  polls: number;
  rules?: Partial<WatchRules>;
  buy?: BuyPolicy;
  executor?: Executor;
  onPoll?: (p: Poll) => void | boolean;
  between?: (n: number) => void | Promise<void>;
  intervalMs?: number;
  band?: number;
}

export function evaluate(r: PremiumReport, prev: PremiumReport | undefined, watch: string[], rules: WatchRules, at = r.fetchedAt): Alert[] {
  const out: Alert[] = [];
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  for (const sym of watch) {
    const line = r.lines.find((l) => l.symbol === sym);
    if (!line) continue;
    if (line.premium <= -rules.minDiscount) out.push({ rule: "discount", symbol: sym, detail: `${sym} trades ${pct(line.premium)} vs mark (token $${line.tokenPrice.toFixed(2)}, mark $${line.markPrice.toFixed(2)})`, at, line });
    if (line.premium >= rules.maxPremium) out.push({ rule: "premium", symbol: sym, detail: `${sym} trades ${pct(line.premium)} vs mark (token $${line.tokenPrice.toFixed(2)}, mark $${line.markPrice.toFixed(2)})`, at, line });
    const before = prev?.lines.find((l) => l.symbol === sym);
    if (before && Math.sign(before.premium) !== Math.sign(line.premium) && before.premium !== 0)
      out.push({ rule: "crossed", symbol: sym, detail: `${sym} crossed mark: ${pct(before.premium)} → ${pct(line.premium)}`, at, line });
  }
  return out;
}

const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`;

/**
 * Decide and, if allowed, execute one buy for a line that fired `discount`.
 * Every refusal is a returned decision, never a throw, so the poll record
 * shows why nothing happened.
 */
export async function decideBuy(o: {
  ctx: PayContext;
  serverUrl: string;
  line: Line;
  policy: BuyPolicy;
  executor: Executor;
  boughtMicro: bigint;
  boughtSymbols: Set<string>;
}): Promise<BuyDecision> {
  const { line, policy } = o;
  const base = { symbol: line.symbol, mint: line.mint, allowed: false as boolean };
  const threshold = policy.buyBelowDiscount ?? DEFAULT_RULES.minDiscount;
  if (!policy.symbols.includes(line.symbol)) return { ...base, usdcMicro: 0n, reason: `${line.symbol} is not in the buy list [${policy.symbols.join(", ")}]` };
  if (line.premium > -threshold) return { ...base, usdcMicro: 0n, reason: `discount ${(line.premium * 100).toFixed(1)}% is shallower than −${(threshold * 100).toFixed(1)}%` };
  if ((policy.oncePerSymbol ?? true) && o.boughtSymbols.has(line.symbol)) return { ...base, usdcMicro: 0n, reason: `already bought ${line.symbol} this session` };

  const perTrade = BigInt(Math.round(policy.maxPerTradeUsd * 1e6));
  const total = BigInt(Math.round(policy.maxTotalUsd * 1e6));
  const room = total - o.boughtMicro;
  if (room <= 0n) return { ...base, usdcMicro: 0n, reason: `buy total ${usd(o.boughtMicro)} has reached the cap ${usd(total)}` };
  const usdcMicro = room < perTrade ? room : perTrade;

  // The allowance rails see a buy as a payment to Jupiter: host allowlist,
  // per-call cap, velocity, budget, approval threshold, all apply. The URL is
  // the swap endpoint, so the ledger reads plainly.
  const url = "https://lite-api.jup.ag/swap/v1/swap";
  const auth = await o.ctx.authorize(usdcMicro, url, "exact");
  if (!auth.allowed) {
    await o.ctx.recordBlocked(url, "lite-api.jup.ag", auth.rule, auth.detail, usdcMicro);
    return { ...base, usdcMicro, reason: `allowance: ${auth.rule} (${auth.detail})` };
  }
  const release = () => o.ctx.releaseReservation?.(auth.reservationId ?? "");

  let quote: Quote;
  try {
    quote = await o.executor.quote(line.mint, usdcMicro);
  } catch (e) {
    await release();
    return { ...base, usdcMicro, reason: `quote failed: ${(e as Error).message}` };
  }
  if (quote.priceImpact > policy.maxPriceImpact) {
    await release();
    return { ...base, usdcMicro, quote, reason: `price impact ${(quote.priceImpact * 100).toFixed(2)}% is above ${(policy.maxPriceImpact * 100).toFixed(2)}%` };
  }
  const ceiling = line.markPrice * (1 + policy.maxFillOverMark);
  if (quote.fillPrice > ceiling) {
    await release();
    return { ...base, usdcMicro, quote, reason: `fill $${quote.fillPrice.toFixed(2)} is above ${usd(BigInt(Math.round(ceiling * 1e6)))} (mark + ${(policy.maxFillOverMark * 100).toFixed(1)}%)` };
  }

  // The ledger is in USD. When the wallet pays in EURC the row still says $5.00;
  // the decision carries the EURC amount so the page can show both.
  const spent = quote.pay.symbol === "USDC" ? "" : ` for ${fmtToken(quote.pay.amountRaw, quote.pay)}`;
  try {
    const r = await o.executor.swap(quote);
    if (!r.dryRun && r.signature) {
      await o.ctx.recordPayment(url, "lite-api.jup.ag", usdcMicro, r.signature, auth.reservationId);
    } else {
      await release();
    }
    return {
      ...base,
      allowed: true,
      usdcMicro,
      pay: quote.pay,
      quote,
      signature: r.signature,
      slot: r.slot,
      dryRun: r.dryRun,
      recorded: !r.dryRun && !!r.signature,
      reason: r.dryRun
        ? `dry run: would buy ${quote.outUi.toFixed(4)} ${line.symbol} at $${quote.fillPrice.toFixed(2)}${spent} via ${quote.route.join(" → ")}`
        : `bought ${quote.outUi.toFixed(4)} ${line.symbol} at $${quote.fillPrice.toFixed(2)}${spent} via ${quote.route.join(" → ")}`,
    };
  } catch (e) {
    await release();
    return { ...base, usdcMicro, pay: quote.pay, quote, reason: `swap failed: ${(e as Error).message}` };
  }
}

export async function watchPreStocks(o: WatchOptions): Promise<{ polls: Poll[]; spentMicro: bigint; boughtMicro: bigint; stoppedBy?: string }> {
  const rules = { ...DEFAULT_RULES, ...o.rules };
  const polls: Poll[] = [];
  let spent = 0n;
  let bought = 0n;
  const boughtSymbols = new Set<string>();
  let prev: PremiumReport | undefined;
  let stoppedBy: string | undefined;
  const q = new URLSearchParams();
  if (o.band !== undefined) q.set("band", String(o.band));
  const url = `${o.serverUrl}/report${q.size ? `?${q}` : ""}`;

  for (let n = 1; n <= o.polls; n++) {
    const paid = (await payingFetch(o.ctx, url)) as PaidResult<PremiumReport>;
    spent += paid.costMicro;
    let alerts: Alert[] = [];
    const buys: BuyDecision[] = [];
    let report: PremiumReport | undefined;
    if (paid.ok && paid.body) {
      report = paid.body;
      alerts = evaluate(report, prev, o.watch, rules);
      prev = report;
      if (o.buy && o.executor) {
        for (const a of alerts.filter((x) => x.rule === "discount")) {
          const d = await decideBuy({ ctx: o.ctx, serverUrl: o.serverUrl, line: a.line, policy: o.buy, executor: o.executor, boughtMicro: bought, boughtSymbols });
          buys.push(d);
          if (d.allowed && d.recorded) {
            bought += d.usdcMicro;
            boughtSymbols.add(d.symbol);
          } else if (d.allowed && d.dryRun) {
            boughtSymbols.add(d.symbol);
          }
        }
      }
    }
    const poll: Poll = { n, paid, report, alerts, buys, spentMicro: spent, boughtMicro: bought };
    polls.push(poll);
    if (o.onPoll?.(poll) === false) {
      stoppedBy = "caller";
      break;
    }
    if (!paid.ok && paid.blockedBy) {
      stoppedBy = `policy: ${paid.blockedBy.rule} (${paid.blockedBy.detail})`;
      break;
    }
    if (n < o.polls) {
      await o.between?.(n);
      if (o.intervalMs) await new Promise((r) => setTimeout(r, o.intervalMs));
    }
  }
  return { polls, spentMicro: spent, boughtMicro: bought, stoppedBy };
}

export function fmtUsd(micro: bigint): string {
  const s = micro.toString().padStart(7, "0");
  return `$${s.slice(0, -6)}.${s.slice(-6, -4)}${s.slice(-4) === "0000" ? "" : s.slice(-4)}`;
}
