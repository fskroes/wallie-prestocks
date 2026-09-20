/**
 * The PreStocks data source.
 *
 * Two public endpoints, no auth:
 *   https://prestocks.com/api/prestocks   the 8 live tokens: mint, token price, mark price, supply
 *   https://prestocks.com/api/stats       daily volume and weekly holder series per symbol
 *
 * `fetchImpl` is injectable so every test and the offline demo run from the
 * fixtures in ./fixtures with no network. The shapes below are what the API
 * returned on 2026-09-20 and what the fixtures pin.
 */

export const PRESTOCKS_API = "https://prestocks.com/api/prestocks";
export const PRESTOCKS_STATS = "https://prestocks.com/api/stats";

/** One row of /api/prestocks as the API sends it. */
export interface PreStockRaw {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url: string;
  /** Token-2022 mint on Solana mainnet. Every PreStocks mint starts with "Pre". */
  contract_address: string;
  markPrice: number;
  markValuation: number;
  tokenPrice: number;
  impliedValuation: number;
  supply: number;
}

/** The same row, normalized and with the one derived figure the agent acts on. */
export interface PreStock {
  symbol: string;
  name: string;
  mint: string;
  /** What the token trades at on Solana, USD per token. */
  tokenPrice: number;
  /** What PreStocks marks the underlying share at, USD per token. */
  markPrice: number;
  /** tokenPrice / markPrice − 1. Negative means the token trades at a discount to mark. */
  premium: number;
  supply: number;
  markValuation: number;
  impliedValuation: number;
  url: string;
}

export interface Stats {
  volume: Array<{ date: string } & Record<string, number | string>>;
  holders: Array<{ week: string } & Record<string, number | string>>;
  launchDates: Record<string, string>;
  volumeSymbols: string[];
  holderSymbols: string[];
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Every PreStocks mint is a Token-2022 mint whose address starts with "Pre". */
export function isPreStocksMint(mint: string): boolean {
  return /^Pre[1-9A-HJ-NP-Za-km-z]{29,41}$/.test(mint);
}

export function normalize(raw: PreStockRaw): PreStock {
  if (!isPreStocksMint(raw.contract_address)) throw new Error(`${raw.symbol}: ${raw.contract_address} is not a PreStocks mint`);
  if (!(raw.markPrice > 0)) throw new Error(`${raw.symbol}: mark price must be positive, got ${raw.markPrice}`);
  if (!(raw.tokenPrice > 0)) throw new Error(`${raw.symbol}: token price must be positive, got ${raw.tokenPrice}`);
  return {
    symbol: raw.symbol,
    name: raw.name,
    mint: raw.contract_address,
    tokenPrice: raw.tokenPrice,
    markPrice: raw.markPrice,
    premium: raw.tokenPrice / raw.markPrice - 1,
    supply: raw.supply,
    markValuation: raw.markValuation,
    impliedValuation: raw.impliedValuation,
    url: raw.external_url,
  };
}

export async function fetchPreStocks(fetchImpl: FetchLike = fetch as FetchLike): Promise<PreStock[]> {
  const res = await fetchImpl(PRESTOCKS_API);
  if (!res.ok) throw new Error(`PreStocks API returned HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body) || body.length === 0) throw new Error("PreStocks API returned no tokens");
  return (body as PreStockRaw[]).map(normalize).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function fetchStats(fetchImpl: FetchLike = fetch as FetchLike): Promise<Stats> {
  const res = await fetchImpl(PRESTOCKS_STATS);
  if (!res.ok) throw new Error(`PreStocks stats returned HTTP ${res.status}`);
  const s = (await res.json()) as Stats;
  if (!Array.isArray(s.volume) || !Array.isArray(s.holders)) throw new Error("PreStocks stats has no volume/holders series");
  return s;
}

/** The most recent daily volume and weekly holder count for one symbol, if the series has it. */
export function latestStats(stats: Stats, symbol: string): { volumeUsd?: number; volumeDate?: string; holders?: number; holdersWeek?: string } {
  const v = [...stats.volume].reverse().find((r) => typeof r[symbol] === "number");
  const h = [...stats.holders].reverse().find((r) => typeof r[symbol] === "number");
  return {
    volumeUsd: v ? (v[symbol] as number) : undefined,
    volumeDate: v?.date,
    holders: h ? (h[symbol] as number) : undefined,
    holdersWeek: h?.week,
  };
}

/** A fetch that serves the pinned fixtures, for tests and the offline demo. */
export function fixtureFetch(files: { prestocks: unknown; stats?: unknown }): FetchLike {
  return async (url: string) => {
    const body = url === PRESTOCKS_API ? files.prestocks : url === PRESTOCKS_STATS ? files.stats : undefined;
    if (body === undefined) return { ok: false, status: 404, json: async () => ({ error: "not fixtured" }) };
    return { ok: true, status: 200, json: async () => body };
  };
}
