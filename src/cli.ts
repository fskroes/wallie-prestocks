#!/usr/bin/env node
/**
 * wallie-prestocks CLI
 *
 *   report [--band 0.02] [--json]          the premium report, live from prestocks.com
 *   quote <SYMBOL> [--usd 5] [--pay-with USDC|EURC] [--json]   a Jupiter buy quote for one PreStock (read-only)
 *   serve [--port 8402] [--network solana-devnet]   run the paid report server (in-memory settlement)
 *   mints                                  the 8 mints, one per line
 */
import { Connection } from "@solana/web3.js";
import { fetchPreStocks, fetchStats } from "./prestocks.ts";
import { buildReport, renderReport } from "./report.ts";
import { fmtToken, payToken, quoteBuy, uiMultiplier } from "./jupiter.ts";
import { startReportServer } from "./server.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));

async function main(): Promise<void> {
  switch (cmd) {
    case "report": {
      const stocks = await fetchPreStocks();
      const stats = await fetchStats().catch(() => undefined);
      const r = buildReport(stocks, { band: flag("band") ? Number(flag("band")) : undefined, stats });
      console.log(has("json") ? JSON.stringify(r, null, 2) : renderReport(r));
      return;
    }
    case "quote": {
      const sym = positional[0]?.toUpperCase();
      if (!sym) throw new Error("usage: quote <SYMBOL> [--usd 5]");
      const stocks = await fetchPreStocks();
      const s = stocks.find((x) => x.symbol === sym);
      if (!s) throw new Error(`unknown PreStock ${sym}; known: ${stocks.map((x) => x.symbol).join(", ")}`);
      const usd = Number(flag("usd") ?? 5);
      const conn = new Connection(flag("rpc") ?? "https://api.mainnet-beta.solana.com");
      const mult = await uiMultiplier(conn, s.mint);
      const pay = payToken(flag("pay-with") ?? "USDC");
      const q = await quoteBuy({ mint: s.mint, usdcMicro: BigInt(Math.round(usd * 1e6)), uiMultiplier: mult, payToken: pay });
      if (has("json")) console.log(JSON.stringify({ ...q, usdcMicro: q.usdcMicro.toString(), pay: { ...q.pay, amountRaw: q.pay.amountRaw.toString() }, outRaw: q.outRaw.toString(), minOutRaw: q.minOutRaw.toString(), uiMultiplier: mult }, null, 2));
      else {
        console.log(`${sym}  ${s.mint}`);
        console.log(`$${usd} as ${fmtToken(q.pay.amountRaw, pay)}${pay.fixedUsd ? "" : ` at $${q.pay.usdPrice.toFixed(4)}/${pay.symbol}`} → ${q.outUi.toFixed(6)} ${sym}  (fill $${q.fillPrice.toFixed(2)}/token, API token $${s.tokenPrice.toFixed(2)}, mark $${s.markPrice.toFixed(2)})`);
        console.log(`impact ${(q.priceImpact * 100).toFixed(3)}%  slippage ${q.slippageBps} bps  route ${q.route.join(" → ")}  ui multiplier ${mult}`);
      }
      return;
    }
    case "serve": {
      const s = await startReportServer({ port: Number(flag("port") ?? 8402), host: flag("host") ?? "127.0.0.1", network: flag("network") ?? "solana-devnet" });
      console.log(`paid PreStocks report server on ${s.url}  ($${Number(s.perReportMicro) / 1e6} per report, $${Number(s.ceilingMicro) / 1e6} ceiling)`);
      await new Promise(() => undefined);
      return;
    }
    case "mints": {
      for (const s of await fetchPreStocks()) console.log(`${s.symbol.padEnd(11)} ${s.mint}`);
      return;
    }
    default:
      console.log("usage: wallie-prestocks <report|quote|serve|mints> ...");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
