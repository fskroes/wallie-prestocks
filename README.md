# wallie-prestocks

**Buy the discount. Never past the allowance.**

[PreStocks](https://prestocks.com) tokenizes pre-IPO shares (SpaceX, OpenAI, Anthropic, Anduril, Figure AI, Kalshi, Neuralink, Polymarket) on Solana and publishes a mark price next to each token price. This repo gives a [Wallie](https://github.com/fskroes/AllowanceKit) agent two things: a paid premium report it buys per poll over x402, and a buy path on Jupiter that fires when a watched token trades under its mark. Every cent of data and every dollar of stock comes out of one allowance the agent cannot exceed, and both land in the same audit ledger.

Built for the Stocklana hackathon, PreStocks bounty. Companion to [AllowanceKit / Wallie](https://github.com/fskroes/AllowanceKit) (npm `allowance-kit`), which supplies the allowance rails and the x402 `upto` payment channel. Sibling of [wallie-dbc](https://github.com/fskroes/wallie-dbc), the Meteora DBC entry, which uses the same report-server shape.

Live page: https://www.onewallie.com/prestocks.html (mirror: https://fskroes.github.io/wallie-prestocks/).

## What it does

| Piece | File | What |
| --- | --- | --- |
| PreStocks reader | `src/prestocks.ts` | Fetches `/api/prestocks` (8 tokens, mint, token price, mark price, supply) and `/api/stats` (volume, holders). Refuses anything that is not a `Pre…` mint. Pure apart from the fetch, which is injectable. |
| Premium report | `src/report.ts` | Per token: premium = token ÷ mark − 1, spread, a `discount / fair / premium` signal on a ±2% band, ranked. Pure. |
| Paid report server | `src/server.ts` | An x402 `upto` seller. $0.10 ceiling per call, $0.01 charged per report, the rest refunded. A failed upstream charges nothing. `/report`, `/quote?symbol=`, `/health`. |
| Jupiter executor | `src/jupiter.ts` | USDC → PreStocks quote and swap through Jupiter's lite API. Reads the Token-2022 ScaledUiAmount multiplier off the mint (SPACEX is 5x since a 2026-06 split) so fills price like the API. Dry run signs and never sends. |
| Agent | `src/agent.ts` | A Wallie buyer that polls the report, raises `discount / premium / crossed` alerts on a watchlist, and puts every discount alert through a buy policy: per-trade cap, session cap, price impact, fill ceiling against mark, once per symbol. A buy is a payment to `lite-api.jup.ag` as far as the allowance is concerned, so every allowance rail applies. |
| CLI | `src/cli.ts` | `report`, `quote <SYMBOL>`, `serve`, `mints`. |
| Demo | `demo/run.ts` | Live reports, live Jupiter quotes, dry-run buys by default. Writes `web/data.json`. `--offline` uses the pinned fixtures; `--i-mean-mainnet` does real swaps. |
| Web page | `web/index.html` | The board, the recorded run, the ledger, the rails. Static, no build step. |

## Quick start

```sh
npm install --force
npm run typecheck
npm test                                    # 26 tests, all offline, from fixtures/

node src/cli.ts report                      # the premium report, live
node src/cli.ts quote SPACEX --usd 5        # a live Jupiter quote, read-only
node demo/run.ts --polls 3 --out web/data.json   # live data, dry-run buys
node demo/run.ts --offline                  # no network at all
python3 -m http.server -d web 4173          # open http://localhost:4173
```

Real mainnet buys:

```sh
node demo/run.ts --i-mean-mainnet --key .keys/agent.json --buy SPACEX --usd 5 --polls 1 --rpc <url> --out web/data.json
```

The key file is a 64-byte JSON array. The wallet needs USDC for the buy and a little SOL for fees. The script prints the policy and the wallet balance and waits five seconds before the first poll. Buys are irreversible.

## The money trail

One run on 2026-09-20 (`web/data.json`, live data, dry-run buys):

```
poll 1  paid  escrowed $0.10 → charged $0.01 → refunded $0.09   allowance left $10.49
  ▼ SPACEX      token    $118.00  mark    $153.86   -23.3%  discount
  ▲ OPENAI      token  $1,127.29  mark    $996.02   +13.2%  premium
  ⚠ discount: SPACEX trades -23.3% vs mark
  ⚠ premium: OPENAI trades +13.2% vs mark
  ✓ buy SPACEX $5.00: dry run: would buy 0.0412 SPACEX at $121.33 via Meteora DLMM
poll 2  ...
  ✗ buy SPACEX $0.00: already bought SPACEX this session
```

The ledger after the run has one `topup`, two `payment` rows to the report server with `scheme: upto`, deposit and refund columns, and, on a mainnet run, a `payment` row to `lite-api.jup.ag` whose `txHash` is the swap signature. A refused buy is a `blocked` row with the rule that refused it.

## Where it would break

- `effectiveMultiplier` in `src/jupiter.ts` picks `newMultiplier` once its timestamp has passed. If PreStocks schedules a split the agent quotes before the timestamp, `outUi` and `fillPrice` are off by the split ratio until it lands. The fill ceiling against mark then refuses the buy, which is the safe side.
- The PreStocks API `tokenPrice` is an index, not a fill. The buy policy checks Jupiter's actual fill against mark, not against `tokenPrice`.
- PreStocks mints carry a 100 bps transfer fee. Jupiter's `outAmount` is what arrives after the fee. The report does not add the fee back; the fill price already includes it.
- Jupiter's lite API is rate limited and keyless. A `429` is a `quote failed` refusal, and the reservation is released. Bring a paid Jupiter key for anything past a demo.
- `payingFetch` in allowance-kit opens one `upto` channel per report. On a real Solana operator that is one on-chain deposit per poll. Use the in-memory operator for tight polling loops, or poll slowly.
- Payment settlement in the demo is in-memory (`pinnedOperator`, the same pattern as the Wallie MCP demo). Real USDC settlement uses `createSolanaUptoOperator` from allowance-kit; `startReportServer` takes any `UptoOperator`.

## Honest limits

PreStocks tokens give economic exposure to private companies through an SPV and are not available to U.S. persons or other ineligible persons; see [prestocks.com](https://prestocks.com). Nothing here is investment advice. The agent is deterministic and needs no LLM. It buys only `Pre…` mints and nothing else; no other pre-IPO token appears in this repo.

## License

MIT
