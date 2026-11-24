import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { createLiveAgent, topUp, type LiveAgentRuntime } from "allowance-kit";
import { fixtureFetch, type PreStockRaw } from "../src/prestocks.ts";
import type { Executor } from "../src/agent.ts";
import type { Quote } from "../src/jupiter.ts";
import { quoteBuy, replayHttp } from "../src/jupiter.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
export const FIXTURES = path.join(here, "..", "fixtures");
export const loadJson = <T = unknown>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as T;

export const PRESTOCKS = loadJson<PreStockRaw[]>("prestocks-2026-09-20.json");
export const STATS = loadJson("stats-2026-09-20.json");
export const QUOTE_ANTHROPIC = loadJson("quote-anthropic-5usd.json");
export const QUOTE_SPACEX = loadJson("quote-spacex-5usd.json");
export const QUOTE_SPACEX_EURC = loadJson("quote-spacex-5usd-eurc.json");
export const PRICE_EURC = loadJson("price-eurc-2026-09-21.json");
export const SWAP_SPACEX = loadJson("swap-spacex-5usd.json");

export const FIXTURE_PAYER = Keypair.fromSeed(Buffer.alloc(32, 7));

export function solanaKeyJson(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  return JSON.stringify(Array.from(Buffer.concat([seed, pub])));
}

export async function buyer(usd: number, policy: Record<string, unknown> = {}, network = "solana-devnet"): Promise<LiveAgentRuntime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-prestocks-"));
  const rt = await createLiveAgent({
    stateDir: dir,
    privateKey: solanaKeyJson(),
    network,
    rpcUrl: "http://127.0.0.1:1",
    checkOnChainBalance: false,
    preferScheme: "upto",
  });
  rt.policyStore.save({ allowHostSuffixes: ["localhost", "lite-api.jup.ag"], totalBudgetUsd: usd, windowLimitUsd: usd, ...policy });
  topUp(rt, usd);
  return rt;
}

export function apiWith(overrides: Record<string, Partial<PreStockRaw>> = {}) {
  const rows = PRESTOCKS.map((r) => ({ ...r, ...(overrides[r.symbol] ?? {}) }));
  return fixtureFetch({ prestocks: rows, stats: STATS });
}

export function recordedExecutor(opts: { dryRun?: boolean; fail?: string; impact?: number } = {}): Executor & { swaps: Quote[] } {
  const http = replayHttp({ "GET /quote": QUOTE_SPACEX, "POST /swap": SWAP_SPACEX });
  const swaps: Quote[] = [];
  return {
    swaps,
    quote: async (mint, usdcMicro) => {
      const raw = QUOTE_SPACEX as { outputMint: string };
      const q = await quoteBuy({ mint: raw.outputMint, usdcMicro: 5_000_000n, http, uiMultiplier: 5 });
      const scaled = { ...q, mint, usdcMicro, priceImpact: opts.impact ?? q.priceImpact };
      if (usdcMicro !== q.usdcMicro) {
        const k = Number(usdcMicro) / Number(q.usdcMicro);
        scaled.outRaw = BigInt(Math.round(Number(q.outRaw) * k));
        scaled.outUi = q.outUi * k;
        scaled.pay = { ...q.pay, amountRaw: BigInt(Math.round(Number(q.pay.amountRaw) * k)) };
      }
      return scaled;
    },
    swap: async (q) => {
      if (opts.fail) throw new Error(opts.fail);
      swaps.push(q);
      if (opts.dryRun) return { dryRun: true };
      return { signature: "SIG" + swaps.length.toString().padStart(3, "0"), slot: 448_830_000 + swaps.length, dryRun: false };
    },
  };
}
