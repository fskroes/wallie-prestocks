/**
 * The paid report server: an x402 `upto` seller that meters premium reports.
 *
 * An agent opens one channel per request with a ceiling, the server charges
 * per report actually produced, and the rest is refunded. A failed fetch
 * charges nothing.
 *
 *   GET /report[?band=0.02]      the premium report for all 8 PreStocks
 *   GET /quote?symbol=X          one line, for an agent that watches one name
 *   GET /health                  free
 *
 * Same shape as wallie-dbc's report server, so a Wallie buyer that knows one
 * knows the other. `fetchImpl` is injectable so tests and the offline demo run
 * from fixtures; `operator` is in-memory for the demo and
 * `createSolanaUptoOperator` for real USDC settlement.
 */
import http from "node:http";
import { Keypair } from "@solana/web3.js";
import {
  InMemoryUptoOperator,
  paymentGate,
  MockChain,
  type Meter,
  type OfferExtraInput,
  type UptoOperator,
  type UptoPaymentEnvelope,
} from "allowance-kit";
import { fetchPreStocks, fetchStats, type FetchLike, type Stats } from "./prestocks.ts";
import { buildReport, type PremiumReport } from "./report.ts";

export interface ReportServerOptions {
  network?: string;
  /** Micro-USD charged per report produced. Default 10_000 = $0.01. */
  perReportMicro?: bigint;
  /** Ceiling a buyer must deposit per request. Default 100_000 = $0.10. */
  ceilingMicro?: bigint;
  payTo?: string;
  operator?: UptoOperator;
  fetchImpl?: FetchLike;
  /** Cache the upstream API for this long so a polling agent does not hammer PreStocks. Default 15 s. */
  cacheMs?: number;
  port?: number;
  host?: string;
}

export interface ReportServer {
  url: string;
  port: number;
  perReportMicro: bigint;
  ceilingMicro: bigint;
  operator: UptoOperator;
  served: number;
  close(): Promise<void>;
}

export function pinnedOperator(): { operator: UptoOperator; base: InMemoryUptoOperator } {
  const base = new InMemoryUptoOperator({ feePayer: randomAddr(), receiverAuthorizer: randomAddr() });
  const blockhash = randomAddr();
  const operator: UptoOperator = {
    offerExtra: async (i: OfferExtraInput) => ({
      ...(await base.offerExtra(i)),
      recentBlockhash: blockhash,
      recentSlot: 200_000_000,
      lastValidBlockHeight: 200_000_150,
    }),
    openDeposit: (e: UptoPaymentEnvelope) => base.openDeposit(e),
    settleClaim: (e: UptoPaymentEnvelope, a: bigint) => base.settleClaim(e, a),
  };
  return { operator, base };
}

export function randomAddr(): string {
  return Keypair.generate().publicKey.toBase58();
}

export async function startReportServer(o: ReportServerOptions = {}): Promise<ReportServer> {
  const network = o.network ?? "solana-devnet";
  const perReportMicro = o.perReportMicro ?? 10_000n;
  const ceilingMicro = o.ceilingMicro ?? 100_000n;
  const operator = o.operator ?? pinnedOperator().operator;
  const fetchImpl = o.fetchImpl ?? (fetch as FetchLike);
  const cacheMs = o.cacheMs ?? 15_000;
  const state = { served: 0 };

  let cached: { at: number; report: PremiumReport } | undefined;
  let stats: Stats | undefined;
  let statsAt = 0;
  async function report(band?: number): Promise<PremiumReport> {
    const now = Date.now();
    if (cached && now - cached.at < cacheMs && (band === undefined || band === cached.report.band)) return cached.report;
    if (!stats || now - statsAt > 10 * 60_000) {
      try {
        stats = await fetchStats(fetchImpl);
        statsAt = now;
      } catch {
        // Volume and holders are decoration. The report stands without them.
      }
    }
    const stocks = await fetchPreStocks(fetchImpl);
    const r = buildReport(stocks, { band, stats });
    cached = { at: now, report: r };
    return r;
  }

  const gate = paymentGate(
    {
      priceMicro: perReportMicro,
      description: "PreStocks premium report: token price vs mark for every PreStock, ranked",
      payTo: o.payTo ?? randomAddr(),
      network,
      facilitator: new MockChain(),
      upto: { ceilingMicro, operator },
    },
    async (req, res, meter?: Meter) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (code: number, body: unknown) => {
        res.statusCode = code;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      };
      try {
        if (url.pathname === "/report") {
          const bandRaw = url.searchParams.get("band");
          const band = bandRaw === null ? undefined : Number(bandRaw);
          if (band !== undefined && !(band >= 0 && band < 1)) return json(400, { error: "band must be in [0,1)" });
          const r = await report(band);
          meter?.charge(perReportMicro);
          state.served += 1;
          return json(200, r);
        }
        if (url.pathname === "/quote") {
          const symbol = url.searchParams.get("symbol")?.toUpperCase();
          if (!symbol) return json(400, { error: "symbol required" });
          const r = await report();
          const line = r.lines.find((l) => l.symbol === symbol);
          if (!line) return json(404, { error: `unknown PreStock ${symbol}`, known: r.lines.map((l) => l.symbol) });
          meter?.charge(perReportMicro);
          state.served += 1;
          return json(200, { fetchedAt: r.fetchedAt, band: r.band, line });
        }
        return json(404, { error: "not found" });
      } catch (e) {
        // Nothing produced, nothing charged: the channel settles at zero and refunds in full.
        return json(502, { error: (e as Error).message });
      }
    },
  );

  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, network, perReportMicro: perReportMicro.toString(), ceilingMicro: ceilingMicro.toString() }));
      return;
    }
    await gate(req, res);
  });
  await gate.ready();
  const host = o.host ?? "127.0.0.1";
  await new Promise<void>((r) => server.listen(o.port ?? 0, host, () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://localhost:${port}`,
    port,
    perReportMicro,
    ceilingMicro,
    operator,
    get served() {
      return state.served;
    },
    close: async () => {
      await gate.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
