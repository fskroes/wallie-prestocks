import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPreStocks, fetchStats, isPreStocksMint, latestStats, normalize, fixtureFetch, PRESTOCKS_API } from "../src/prestocks.ts";
import { buildReport, renderReport, signalFor } from "../src/report.ts";
import { PRESTOCKS, STATS, apiWith } from "./helpers.ts";

test("the 2026-09-20 API fixture has 8 PreStocks, all on Pre… Token-2022 mints", async () => {
  const stocks = await fetchPreStocks(apiWith());
  assert.equal(stocks.length, 8);
  assert.deepEqual(
    stocks.map((s) => s.symbol),
    ["ANDURIL", "ANTHROPIC", "FIGUREAI", "KALSHI", "NEURALINK", "OPENAI", "POLYMARKET", "SPACEX"],
  );
  for (const s of stocks) {
    assert.ok(isPreStocksMint(s.mint), s.mint);
    assert.ok(s.tokenPrice > 0 && s.markPrice > 0);
  }
  const anthropic = stocks.find((s) => s.symbol === "ANTHROPIC")!;
  assert.equal(anthropic.mint, "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw");
});

test("premium is token/mark − 1: SPACEX was 22% below mark, NEURALINK 26% above", async () => {
  const stocks = await fetchPreStocks(apiWith());
  const by = (s: string) => stocks.find((x) => x.symbol === s)!;
  assert.ok(by("SPACEX").premium < -0.2 && by("SPACEX").premium > -0.25, String(by("SPACEX").premium));
  assert.ok(by("NEURALINK").premium > 0.25 && by("NEURALINK").premium < 0.27, String(by("NEURALINK").premium));
  assert.ok(Math.abs(by("ANTHROPIC").premium) < 0.002);
});

test("normalize refuses a non-PreStocks mint and bad prices", () => {
  const row = PRESTOCKS[0];
  assert.throws(() => normalize({ ...row, contract_address: "So11111111111111111111111111111111111111112" }), /not a PreStocks mint/);
  assert.throws(() => normalize({ ...row, markPrice: 0 }), /mark price/);
  assert.throws(() => normalize({ ...row, tokenPrice: -1 }), /token price/);
  assert.ok(!isPreStocksMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
  assert.ok(!isPreStocksMint("Pre"));
});

test("an empty or failed API is an error, not an empty report", async () => {
  await assert.rejects(fetchPreStocks(fixtureFetch({ prestocks: [] })), /no tokens/);
  await assert.rejects(fetchPreStocks(async () => ({ ok: false, status: 503, json: async () => ({}) })), /HTTP 503/);
  await assert.rejects(fetchPreStocks(fixtureFetch({ prestocks: {} })), /no tokens/);
});

test("stats: the latest volume and holder figures per symbol", async () => {
  const stats = await fetchStats(apiWith());
  const a = latestStats(stats, "ANTHROPIC");
  assert.ok((a.volumeUsd ?? 0) > 0);
  assert.ok((a.holders ?? 0) > 60_000, String(a.holders));
  assert.equal(a.holdersWeek, "2026-09-10");
  const none = latestStats(stats, "NOPE");
  assert.equal(none.volumeUsd, undefined);
  assert.equal(none.holders, undefined);
});

test("report: ranked from deepest discount to highest premium, with signals on a ±2% band", async () => {
  const stocks = await fetchPreStocks(apiWith());
  const stats = await fetchStats(apiWith());
  const r = buildReport(stocks, { stats, fetchedAt: "2026-09-20T00:00:00.000Z" });
  assert.equal(r.ranked[0], "SPACEX");
  assert.equal(r.ranked[r.ranked.length - 1], "NEURALINK");
  assert.equal(r.cheapest?.symbol, "SPACEX");
  assert.equal(r.dearest?.symbol, "NEURALINK");
  assert.equal(r.cheapest?.signal, "discount");
  assert.equal(r.dearest?.signal, "premium");
  assert.equal(r.lines.find((l) => l.symbol === "ANTHROPIC")?.signal, "fair");
  assert.ok((r.lines.find((l) => l.symbol === "ANTHROPIC")?.holders ?? 0) > 0);
  const text = renderReport(r);
  assert.match(text, /^PreStocks premium report  2026-09-20/);
  assert.match(text, /▼ SPACEX/);
  assert.match(text, /▲ NEURALINK/);
  assert.equal(text.split("\n").length, 9);
});

test("signal band edges", () => {
  assert.equal(signalFor(-0.02, 0.02), "discount");
  assert.equal(signalFor(-0.019, 0.02), "fair");
  assert.equal(signalFor(0.02, 0.02), "premium");
  assert.equal(signalFor(0, 0.02), "fair");
});

test("fixtureFetch only answers the two PreStocks URLs", async () => {
  const f = fixtureFetch({ prestocks: PRESTOCKS, stats: STATS });
  assert.equal((await f(PRESTOCKS_API)).ok, true);
  assert.equal((await f("https://prestocks.com/api/other")).status, 404);
});
