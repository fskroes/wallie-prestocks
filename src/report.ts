/**
 * The premium report: one line per PreStock that says whether the token is
 * cheap or dear against its mark, and by how much.
 *
 *   premium      tokenPrice / markPrice − 1
 *   discount     the same number, sign flipped, when negative
 *   signal       "discount" | "fair" | "premium" against a band
 *   spreadUsd    tokenPrice − markPrice, per token
 *
 * Pure. Every input comes from `fetchPreStocks`; the executable price on
 * Jupiter is a separate figure the buyer checks at trade time (src/jupiter.ts),
 * because the API's tokenPrice is an index, not a fill.
 */
import type { PreStock, Stats } from "./prestocks.ts";
import { latestStats } from "./prestocks.ts";

export type Signal = "discount" | "fair" | "premium";

export interface Line {
  symbol: string;
  name: string;
  mint: string;
  tokenPrice: number;
  markPrice: number;
  premium: number;
  spreadUsd: number;
  signal: Signal;
  supply: number;
  markValuation: number;
  volumeUsd?: number;
  holders?: number;
}

export interface PremiumReport {
  fetchedAt: string;
  /** The band that separates "fair" from a signal, as a fraction (0.02 = 2%). */
  band: number;
  lines: Line[];
  /** Symbols sorted from deepest discount to highest premium. */
  ranked: string[];
  cheapest?: Line;
  dearest?: Line;
}

export const DEFAULT_BAND = 0.02;

export function signalFor(premium: number, band: number): Signal {
  if (premium <= -band) return "discount";
  if (premium >= band) return "premium";
  return "fair";
}

export function buildReport(stocks: PreStock[], opts: { band?: number; stats?: Stats; fetchedAt?: string } = {}): PremiumReport {
  const band = opts.band ?? DEFAULT_BAND;
  const lines: Line[] = stocks.map((s) => {
    const st = opts.stats ? latestStats(opts.stats, s.symbol) : {};
    return {
      symbol: s.symbol,
      name: s.name,
      mint: s.mint,
      tokenPrice: s.tokenPrice,
      markPrice: s.markPrice,
      premium: s.premium,
      spreadUsd: s.tokenPrice - s.markPrice,
      signal: signalFor(s.premium, band),
      supply: s.supply,
      markValuation: s.markValuation,
      volumeUsd: st.volumeUsd,
      holders: st.holders,
    };
  });
  const ranked = [...lines].sort((a, b) => a.premium - b.premium).map((l) => l.symbol);
  const by = (sym: string | undefined) => lines.find((l) => l.symbol === sym);
  return {
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
    band,
    lines,
    ranked,
    cheapest: by(ranked[0]),
    dearest: by(ranked[ranked.length - 1]),
  };
}

export const pct = (n: number, d = 1): string => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
export const usd = (n: number, d = 2): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

export function renderReport(r: PremiumReport): string {
  const w = Math.max(...r.lines.map((l) => l.symbol.length), 6);
  const rows = r.ranked.map((sym) => {
    const l = r.lines.find((x) => x.symbol === sym)!;
    const flag = l.signal === "discount" ? "▼" : l.signal === "premium" ? "▲" : " ";
    return `${flag} ${l.symbol.padEnd(w)}  token ${usd(l.tokenPrice).padStart(10)}  mark ${usd(l.markPrice).padStart(10)}  ${pct(l.premium).padStart(7)}  ${l.signal}`;
  });
  return [`PreStocks premium report  ${r.fetchedAt}  band ±${(r.band * 100).toFixed(1)}%`, ...rows].join("\n");
}
