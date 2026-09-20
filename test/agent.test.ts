import { test } from "node:test";
import assert from "node:assert/strict";
import { allowanceRemaining } from "allowance-kit";
import { startReportServer } from "../src/server.ts";
import { DEFAULT_RULES, evaluate, fmtUsd, watchPreStocks, type BuyPolicy } from "../src/agent.ts";
import { buildReport } from "../src/report.ts";
import { fetchPreStocks } from "../src/prestocks.ts";
import { apiWith, buyer, recordedExecutor } from "./helpers.ts";

const BUY_SPACEX: BuyPolicy = { symbols: ["SPACEX"], maxPerTradeUsd: 5, maxTotalUsd: 10, maxPriceImpact: 0.05, maxFillOverMark: 0.1 };

test("watch only: 3 paid reports at $0.01 each from a $0.10 ceiling, the rest refunded, alerts on SPACEX and NEURALINK", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(1);
  try {
    const before = allowanceRemaining(rt);
    const res = await watchPreStocks({ ctx: rt.ctx, serverUrl: server.url, watch: ["SPACEX", "NEURALINK", "ANTHROPIC"], polls: 3 });
    assert.equal(res.polls.length, 3);
    for (const p of res.polls) {
      assert.equal(p.paid.ok, true, p.paid.error ?? p.paid.blockedBy?.detail ?? "");
      assert.equal(p.paid.costMicro, 10_000n);
      assert.equal(p.paid.quotedMicro, 100_000n);
      assert.equal(p.paid.refundMicro, 90_000n);
      assert.ok(p.report);
      assert.equal(p.buys.length, 0);
    }
    const rules = res.polls[0].alerts.map((a) => `${a.rule}:${a.symbol}`).sort();
    assert.deepEqual(rules, ["discount:SPACEX", "premium:NEURALINK"]);
    assert.equal(res.spentMicro, 30_000n);
    assert.equal(res.boughtMicro, 0n);
    assert.equal(server.served, 3);
    assert.equal(before - allowanceRemaining(rt), 30_000n);
    assert.equal(fmtUsd(res.spentMicro), "$0.03");
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("a failed upstream charges nothing", async () => {
  const server = await startReportServer({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  const rt = await buyer(1);
  try {
    const res = await watchPreStocks({ ctx: rt.ctx, serverUrl: server.url, watch: ["SPACEX"], polls: 1 });
    assert.equal(res.polls[0].paid.status, 502);
    assert.equal(res.polls[0].paid.costMicro, 0n);
    assert.equal(server.served, 0);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("the allowance caps the report spend: the agent stops when the ceiling no longer fits", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(0.115);
  try {
    const res = await watchPreStocks({ ctx: rt.ctx, serverUrl: server.url, watch: ["SPACEX"], polls: 10 });
    assert.equal(res.polls.filter((p) => p.paid.ok).length, 2);
    assert.match(res.stoppedBy ?? "", /^policy/);
    assert.equal(res.spentMicro, 20_000n);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("buy: the discount alert on SPACEX becomes one $5 buy, recorded against the same allowance, once per symbol", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(20, { perCallMaxUsd: 5, requireApprovalAboveUsd: 100, windowLimitUsd: 50 });
  const ex = recordedExecutor();
  try {
    const before = allowanceRemaining(rt);
    const res = await watchPreStocks({ ctx: rt.ctx, serverUrl: server.url, watch: ["SPACEX"], polls: 2, buy: BUY_SPACEX, executor: ex });
    const b1 = res.polls[0].buys[0];
    assert.ok(b1, "no buy decision on poll 1");
    assert.equal(b1.allowed, true, b1.reason);
    assert.equal(b1.usdcMicro, 5_000_000n);
    assert.equal(b1.signature, "SIG001");
    assert.equal(b1.recorded, true);
    assert.match(b1.reason, /^bought .* SPACEX at \$/);
    const b2 = res.polls[1].buys[0];
    assert.equal(b2.allowed, false);
    assert.match(b2.reason, /already bought SPACEX/);
    assert.equal(ex.swaps.length, 1);
    assert.equal(res.boughtMicro, 5_000_000n);
    // $0.02 of reports + $5.00 of SPACEX, one ledger.
    assert.equal(before - allowanceRemaining(rt), 5_020_000n);
    const rows = rt.ledger.read().filter((e) => e.t === "payment");
    assert.equal(rows.length, 3);
    const jup = rows.find((e) => e.t === "payment" && e.host === "lite-api.jup.ag");
    assert.ok(jup && jup.t === "payment" && jup.txHash === "SIG001" && jup.amountMicro === "5000000");
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("buy caps: maxTotalUsd splits the last trade, then refuses", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(50, { perCallMaxUsd: 10, requireApprovalAboveUsd: 100, windowLimitUsd: 100 });
  const ex = recordedExecutor();
  try {
    const res = await watchPreStocks({
      ctx: rt.ctx,
      serverUrl: server.url,
      watch: ["SPACEX"],
      polls: 3,
      buy: { ...BUY_SPACEX, maxPerTradeUsd: 6, maxTotalUsd: 8, oncePerSymbol: false },
      executor: ex,
    });
    assert.deepEqual(
      res.polls.map((p) => p.buys[0]?.usdcMicro),
      [6_000_000n, 2_000_000n, 0n],
    );
    assert.equal(res.polls[2].buys[0].allowed, false);
    assert.match(res.polls[2].buys[0].reason, /reached the cap \$8.00/);
    assert.equal(res.boughtMicro, 8_000_000n);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("the Wallie allowance refuses a buy above the per-call cap, and the block is in the ledger", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(20, { perCallMaxUsd: 1, requireApprovalAboveUsd: 100 });
  const ex = recordedExecutor();
  try {
    const res = await watchPreStocks({ ctx: rt.ctx, serverUrl: server.url, watch: ["SPACEX"], polls: 1, buy: BUY_SPACEX, executor: ex });
    const b = res.polls[0].buys[0];
    assert.equal(b.allowed, false);
    assert.match(b.reason, /per_call_cap/);
    assert.equal(ex.swaps.length, 0);
    assert.equal(rt.ledger.read().filter((e) => e.t === "blocked").length, 1);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("the Wallie allowance queues a buy above the approval threshold for a human", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(20, { perCallMaxUsd: 5, requireApprovalAboveUsd: 2 });
  const ex = recordedExecutor();
  try {
    const res = await watchPreStocks({ ctx: rt.ctx, serverUrl: server.url, watch: ["SPACEX"], polls: 1, buy: BUY_SPACEX, executor: ex });
    const b = res.polls[0].buys[0];
    assert.equal(b.allowed, false);
    assert.match(b.reason, /human_approval_required/);
    assert.equal(rt.approvals.list().length, 1);
    assert.equal(ex.swaps.length, 0);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("buy guards: price impact, fill over mark, quote failure, swap failure all release the reservation", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(20, { perCallMaxUsd: 5, requireApprovalAboveUsd: 100, windowLimitUsd: 100 });
  try {
    const run = (executor: ReturnType<typeof recordedExecutor>, policy: Partial<BuyPolicy> = {}) =>
      watchPreStocks({ ctx: rt.ctx, serverUrl: server.url, watch: ["SPACEX"], polls: 1, buy: { ...BUY_SPACEX, ...policy }, executor });

    let r = await run(recordedExecutor({ impact: 0.2 }));
    assert.match(r.polls[0].buys[0].reason, /price impact 20.00% is above 5.00%/);

    // The recorded SPACEX fill is $121/token against a $151 mark. Push the fill over mark + 10%.
    const dear = recordedExecutor();
    const q0 = dear.quote;
    dear.quote = async (m, u) => ({ ...(await q0(m, u)), fillPrice: 170 });
    r = await run(dear, { maxFillOverMark: 0.1 });
    assert.match(r.polls[0].buys[0].reason, /fill \$170\.00 is above \$166\.56 \(mark \+ 10\.0%\)/);

    r = await run(recordedExecutor({ fail: "blockhash expired" }));
    assert.match(r.polls[0].buys[0].reason, /swap failed: blockhash expired/);

    const broken = recordedExecutor();
    broken.quote = async () => { throw new Error("jupiter down"); };
    r = await run(broken);
    assert.match(r.polls[0].buys[0].reason, /quote failed: jupiter down/);

    assert.equal(rt.reservations.list(rt.agentName).length, 0, "a refused buy must not leave a reservation open");
    assert.equal(rt.ledger.read().filter((e) => e.t === "payment" && e.host === "lite-api.jup.ag").length, 0);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("dry run: the policy says yes, nothing is recorded, the symbol still counts as done", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(20, { perCallMaxUsd: 5, requireApprovalAboveUsd: 100, windowLimitUsd: 100 });
  const ex = recordedExecutor({ dryRun: true });
  try {
    const before = allowanceRemaining(rt);
    const res = await watchPreStocks({ ctx: rt.ctx, serverUrl: server.url, watch: ["SPACEX"], polls: 2, buy: BUY_SPACEX, executor: ex });
    assert.equal(res.polls[0].buys[0].allowed, true);
    assert.equal(res.polls[0].buys[0].dryRun, true);
    assert.match(res.polls[0].buys[0].reason, /^dry run: would buy/);
    assert.match(res.polls[1].buys[0].reason, /already bought/);
    assert.equal(res.boughtMicro, 0n);
    assert.equal(before - allowanceRemaining(rt), 20_000n);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("evaluate: discount, premium and crossed rules on moving prices", async () => {
  const base = buildReport(await fetchPreStocks(apiWith()));
  const moved = buildReport(await fetchPreStocks(apiWith({ SPACEX: { tokenPrice: 160 }, ANTHROPIC: { tokenPrice: 1000 } })));
  const a = evaluate(moved, base, ["SPACEX", "ANTHROPIC", "NEURALINK", "NOPE"], DEFAULT_RULES);
  const keys = a.map((x) => `${x.rule}:${x.symbol}`).sort();
  assert.deepEqual(keys, ["crossed:ANTHROPIC", "crossed:SPACEX", "discount:ANTHROPIC", "premium:NEURALINK"]);
  assert.match(a.find((x) => x.rule === "crossed")!.detail, /-22\.\d% → \+5\.\d%/);
});

test("/quote sells one line and /health is free", async () => {
  const server = await startReportServer({ fetchImpl: apiWith() });
  const rt = await buyer(1);
  try {
    const h = (await fetch(`${server.url}/health`).then((r) => r.json())) as { ok: boolean; perReportMicro: string };
    assert.equal(h.ok, true);
    assert.equal(h.perReportMicro, "10000");
    assert.equal((await fetch(`${server.url}/report`)).status, 402);
    const { payingFetch } = await import("allowance-kit");
    const one = await payingFetch(rt.ctx, `${server.url}/quote?symbol=openai`);
    assert.equal(one.ok, true, one.error ?? "");
    assert.equal((one.body as { line: { symbol: string } }).line.symbol, "OPENAI");
    const bad = await payingFetch(rt.ctx, `${server.url}/quote?symbol=TESLA`);
    assert.equal(bad.status, 404);
    assert.equal(bad.costMicro, 0n);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});
