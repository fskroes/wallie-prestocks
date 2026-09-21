/**
 * The demo, end to end:
 *
 *   1. start the paid report server (x402 upto, in-memory settlement, live PreStocks API)
 *   2. a Wallie agent with an allowance polls the premium report
 *   3. every discount alert on a watched symbol goes through the buy policy
 *   4. the agent prints the report, the alerts, every buy decision, and the money trail
 *
 * Default: reports are live from prestocks.com, buys are DRY RUNS against live
 * Jupiter quotes (real routes, real prices, nothing signed or sent). The report
 * payments settle in-memory, exactly as the Wallie MCP demo does it.
 *
 *   node demo/run.ts [--polls 3] [--watch SPACEX,OPENAI] [--buy SPACEX] [--usd 5] [--out web/data.json]
 *
 * Real mainnet buys need all of: --i-mean-mainnet, --key <file>, a funded wallet
 * (USDC or EURC, plus a little SOL), and --rpc for anything better than the public
 * endpoint. The key file is a 64-number JSON array, a base58 secret, or
 * `private=<base58>` lines (an `address=` line is checked against the key).
 * `--pay-with EURC` spends EURC at Jupiter's live price; the allowance and the
 * ledger stay in USD. The script prints the policy and the wallet and waits 5 s.
 *
 *   node demo/run.ts --i-mean-mainnet --key .keys/agent.json --buy SPACEX --usd 5 --polls 1 --pay-with EURC
 *
 * Add --preflight to stop right after the wallet check: the key, the balances and
 * the policy are printed and nothing is polled, signed or sent.
 *
 * Offline (no network at all): --offline serves the 2026-09-20 fixtures.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { allowanceRemaining, createLiveAgent, topUp } from "allowance-kit";
import { startReportServer } from "../src/server.ts";
import { fmtUsd, watchPreStocks, type BuyPolicy, type Executor, type Poll } from "../src/agent.ts";
import { renderReport } from "../src/report.ts";
import { executeSwap, fmtToken, payToken, quoteBuy, tokenBalanceRaw, uiMultiplier, replayHttp, type PayToken } from "../src/jupiter.ts";
import { fixtureFetch } from "../src/prestocks.ts";
import { loadKeypair } from "../src/keys.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (n: string) => args.includes(`--${n}`);

const POLLS = Number(flag("polls") ?? 3);
const WATCH = (flag("watch") ?? "SPACEX,OPENAI,ANTHROPIC").split(",").map((s) => s.trim().toUpperCase());
const BUY = (flag("buy") ?? "SPACEX").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const USD = Number(flag("usd") ?? 5);
const ALLOWANCE = Number(flag("allowance") ?? USD * 2 + 0.5);
const OUT = flag("out");
const MAINNET = has("i-mean-mainnet");
const OFFLINE = has("offline");
const RPC = flag("rpc") ?? "https://api.mainnet-beta.solana.com";
const INTERVAL = Number(flag("interval") ?? (MAINNET ? 20_000 : 3_000));
const PAY: PayToken = payToken(flag("pay-with") ?? "USDC");

const here = path.dirname(new URL(import.meta.url).pathname);
const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(here, "..", "fixtures", n), "utf8")) as unknown;

function solanaKeyJson(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  return JSON.stringify(Array.from(Buffer.concat([seed, pub])));
}

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(76));

function liveExecutor(payer: Keypair | undefined, connection: Connection, dryRun: boolean): Executor {
  const http = OFFLINE
    ? replayHttp({
        "GET /quote": fixture(PAY.symbol === "EURC" ? "quote-spacex-5usd-eurc.json" : "quote-spacex-5usd.json"),
        "GET /price/v3": fixture("price-eurc-2026-09-21.json"),
        "POST /swap": fixture("swap-spacex-5usd.json"),
      })
    : undefined;
  return {
    quote: async (mint, usdcMicro) => quoteBuy({ mint, usdcMicro, uiMultiplier: OFFLINE ? 5 : await uiMultiplier(connection, mint), http, payToken: PAY }),
    swap: async (quote) => {
      if (dryRun || !payer) return { dryRun: true };
      return executeSwap({ quote, payer, connection });
    },
  };
}

async function main(): Promise<void> {
  rule();
  line(`  wallie-prestocks demo  ${OFFLINE ? "OFFLINE fixtures 2026-09-20" : "live prestocks.com + Jupiter"}  ${MAINNET ? "MAINNET BUYS" : "dry-run buys"}`);
  rule();

  let payer: Keypair | undefined;
  if (MAINNET) {
    const keyFile = flag("key");
    if (!keyFile) throw new Error("--i-mean-mainnet needs --key <file: 64-number JSON array, base58 secret, or private=<base58> lines>");
    const k = loadKeypair(keyFile);
    payer = k.keypair;
    line(`  key       ${keyFile} (${k.form}) → ${payer.publicKey.toBase58()}`);
  }
  const connection = new Connection(RPC, "confirmed");

  // The buyer refuses an offer from another chain, so the seller must sit on the
  // agent's network. Settlement stays in-memory either way (pinnedOperator).
  const server = await startReportServer({ network: MAINNET ? "solana" : "solana-devnet", fetchImpl: OFFLINE ? fixtureFetch({ prestocks: fixture("prestocks-2026-09-20.json"), stats: fixture("stats-2026-09-20.json") }) : undefined });
  line(`  server    ${server.url}  ${fmtUsd(server.perReportMicro)} per report, ${fmtUsd(server.ceilingMicro)} ceiling per call`);

  const dir = flag("state") ?? fs.mkdtempSync(path.join(os.tmpdir(), "wallie-prestocks-demo-"));
  const rt = await createLiveAgent({
    stateDir: dir,
    agentName: "prestocks-agent",
    privateKey: payer ? JSON.stringify(Array.from(payer.secretKey)) : solanaKeyJson(),
    network: MAINNET ? "solana" : "solana-devnet",
    rpcUrl: MAINNET ? RPC : "http://127.0.0.1:1",
    // The allowance's own on-chain check reads USDC. When the wallet pays in
    // EURC that check would refuse every buy, so the balance is checked below instead.
    checkOnChainBalance: MAINNET && PAY.symbol === "USDC",
    preferScheme: "upto",
  });
  rt.policyStore.save({
    allowHostSuffixes: ["localhost", "lite-api.jup.ag"],
    totalBudgetUsd: ALLOWANCE,
    perCallMaxUsd: USD,
    windowLimitUsd: ALLOWANCE,
    requireApprovalAboveUsd: USD + 0.01,
  });
  topUp(rt, ALLOWANCE);
  const policy: BuyPolicy = { symbols: BUY, maxPerTradeUsd: USD, maxTotalUsd: USD * BUY.length, maxPriceImpact: 0.05, maxFillOverMark: 0.1, buyBelowDiscount: Number(flag("discount") ?? 0.03) };
  line(`  agent     ${rt.address}  allowance ${fmtUsd(allowanceRemaining(rt))}  state ${dir}`);
  line(`  watch     ${WATCH.join(", ")}    buy ${BUY.length ? BUY.join(", ") : "none"} when ≥ ${(policy.buyBelowDiscount! * 100).toFixed(0)}% below mark`);
  line(`  buy rails ${fmtUsd(BigInt(USD * 1e6))} per trade, ${fmtUsd(BigInt(policy.maxTotalUsd * 1e6))} total, impact ≤ 5%, fill ≤ mark + 10%, paid in ${PAY.symbol}`);
  if (MAINNET && payer) {
    const owner = payer.publicKey.toBase58();
    const [bal, lamports] = await Promise.all([tokenBalanceRaw(connection, owner, PAY.mint), connection.getBalance(payer.publicKey)]);
    const need = BigInt(Math.round(USD * 1e6));
    line(`  wallet    ${fmtToken(bal, PAY)}, ${(lamports / 1e9).toFixed(4)} SOL on mainnet.  REAL SWAPS in 5 s.  Ctrl-C to stop.`);
    if (PAY.fixedUsd && bal < need) throw new Error(`the wallet holds ${fmtToken(bal, PAY)}; a ${fmtUsd(need)} buy needs more. Fund ${owner} or lower --usd.`);
    if (!PAY.fixedUsd && bal === 0n) throw new Error(`the wallet holds no ${PAY.symbol}. Fund ${owner} or pick --pay-with USDC.`);
    if (lamports < 5_000_000) throw new Error(`the wallet holds ${(lamports / 1e9).toFixed(4)} SOL; keep at least 0.005 SOL for fees and token accounts.`);
    if (has("preflight")) {
      line(`  preflight only: key, balances and policy check out. Drop --preflight to trade.`);
      rt.stopHeartbeat?.();
      await server.close();
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  const executor = liveExecutor(payer, connection, !MAINNET);

  try {
    const res = await watchPreStocks({
      ctx: rt.ctx,
      serverUrl: server.url,
      watch: WATCH,
      polls: POLLS,
      buy: BUY.length ? policy : undefined,
      executor,
      intervalMs: POLLS > 1 ? INTERVAL : 0,
      onPoll: (p: Poll) => {
        line("");
        line(`  poll ${p.n}  ${p.paid.ok ? "paid" : "blocked"}  escrowed ${fmtUsd(p.paid.quotedMicro)} → charged ${fmtUsd(p.paid.costMicro)} → refunded ${fmtUsd(p.paid.refundMicro ?? 0n)}   allowance left ${fmtUsd(allowanceRemaining(rt))}`);
        if (p.report) for (const l of renderReport(p.report).split("\n")) line(`    ${l}`);
        for (const a of p.alerts) line(`    ⚠ ${a.rule}: ${a.detail}`);
        for (const b of p.buys) line(`    ${b.allowed ? "✓" : "✗"} buy ${b.symbol} ${fmtUsd(b.usdcMicro)}: ${b.reason}${b.signature ? `  https://solscan.io/tx/${b.signature}` : ""}`);
        if (!p.paid.ok) line(`    ${p.paid.blockedBy?.detail ?? p.paid.error}`);
        return undefined;
      },
    });
    line("");
    rule();
    line(`  ${res.polls.length} polls, reports ${fmtUsd(res.spentMicro)}, bought ${fmtUsd(res.boughtMicro)} of PreStocks, allowance left ${fmtUsd(allowanceRemaining(rt))}${res.stoppedBy ? `, stopped by ${res.stoppedBy}` : ""}`);
    line(`  every report cost ${fmtUsd(server.perReportMicro)}; every unused cent of the ${fmtUsd(server.ceilingMicro)} escrow came back; every buy went through the same allowance`);
    rule();
    if (OUT) {
      const data = {
        generatedAt: new Date().toISOString(),
        mode: OFFLINE ? "offline" : MAINNET ? "mainnet" : "live-dry-run",
        agent: rt.address,
        watch: WATCH,
        policy: { ...policy, allowanceUsd: ALLOWANCE },
        payToken: PAY.symbol,
        perReportMicro: server.perReportMicro.toString(),
        ceilingMicro: server.ceilingMicro.toString(),
        polls: res.polls.map((p) => ({
          n: p.n,
          ok: p.paid.ok,
          quotedMicro: p.paid.quotedMicro.toString(),
          costMicro: p.paid.costMicro.toString(),
          refundMicro: (p.paid.refundMicro ?? 0n).toString(),
          report: p.report,
          alerts: p.alerts.map((a) => ({ rule: a.rule, symbol: a.symbol, detail: a.detail, at: a.at })),
          buys: p.buys.map((b) => ({
            symbol: b.symbol,
            mint: b.mint,
            usdcMicro: b.usdcMicro.toString(),
            pay: b.pay ? { symbol: b.pay.symbol, mint: b.pay.mint, amountRaw: b.pay.amountRaw.toString(), decimals: b.pay.decimals, usdPrice: b.pay.usdPrice } : undefined,
            allowed: b.allowed,
            reason: b.reason,
            signature: b.signature,
            slot: b.slot,
            dryRun: b.dryRun,
            quote: b.quote ? { outUi: b.quote.outUi, fillPrice: b.quote.fillPrice, priceImpact: b.quote.priceImpact, route: b.quote.route } : undefined,
          })),
          spentMicro: p.spentMicro.toString(),
          boughtMicro: p.boughtMicro.toString(),
        })),
        spentMicro: res.spentMicro.toString(),
        boughtMicro: res.boughtMicro.toString(),
        stoppedBy: res.stoppedBy,
        ledger: rt.ledger.read(),
      };
      fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
      line(`  wrote ${OUT}`);
    }
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
