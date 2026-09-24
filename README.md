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
| Jupiter executor | `src/jupiter.ts` | USDC or EURC → PreStocks quote and swap through Jupiter's lite API. The policy and the ledger stay in USD; an EURC buy is priced at Jupiter's live EURC price and cross-checked against Jupiter's own USD value of the swap. Reads the Token-2022 ScaledUiAmount multiplier off the mint (SPACEX is 5x since a 2026-06 split) so fills price like the API. Dry run signs and never sends. |
| Key loader | `src/keys.ts` | Reads a 64-number JSON array, a base58 secret, or `address=` / `private_key_base58=` lines. Refuses a key that does not derive the address the file claims. |
| Agent | `src/agent.ts` | A Wallie buyer that polls the report, raises `discount / premium / crossed` alerts on a watchlist, and puts every discount alert through a buy policy: per-trade cap, session cap, price impact, fill ceiling against mark, once per symbol. A buy is a payment to `lite-api.jup.ag` as far as the allowance is concerned, so every allowance rail applies. |
| CLI | `src/cli.ts` | `report`, `quote <SYMBOL>`, `serve`, `mints`. |
| Demo | `demo/run.ts` | Live reports, live Jupiter quotes, dry-run buys by default. Writes `web/data.json`. `--offline` uses the pinned fixtures; `--pay-with EURC` spends EURC; `--i-mean-mainnet` does real swaps; `--preflight` checks the key and balances and stops. |
| Web page | `web/index.html` | The board, the recorded run, the ledger, the rails. Static, no build step. |

## Quick start

```sh
npm install --force
npm run typecheck
npm test                                    # 33 tests, all offline, from fixtures/

node src/cli.ts report                      # the premium report, live
node src/cli.ts quote SPACEX --usd 5        # a live Jupiter quote, read-only
node src/cli.ts quote SPACEX --usd 5 --pay-with EURC   # the same $5, spent as EURC
node demo/run.ts --polls 3 --out web/data.json   # live data, dry-run buys
node demo/run.ts --offline                  # no network at all
python3 -m http.server -d web 4173          # open http://localhost:4173
```

Real mainnet buys:

```sh
node demo/run.ts --i-mean-mainnet --key .keys/agent.json --buy SPACEX --usd 5 --polls 1 --pay-with EURC --preflight   # check, send nothing
node demo/run.ts --i-mean-mainnet --key .keys/agent.json --buy SPACEX --usd 5 --polls 1 --pay-with EURC --out web/data.json
```

The key file is a 64-number JSON array, a base58 secret, or `address=…` and `private_key_base58=…` lines; a claimed address that the key does not derive is refused. The wallet needs USDC (or EURC with `--pay-with EURC`) for the buy and at least 0.005 SOL for fees. The script prints the key's address, the policy and the wallet balances, refuses an unfunded wallet, and waits five seconds before the first poll. Buys are irreversible. `--rpc <url>` for anything better than the public endpoint.

Paying in EURC: the allowance, the buy policy and the ledger are in USD. A $5 buy becomes the EURC worth $5 at Jupiter's live price, and the quote is refused if Jupiter's own USD valuation of the swap drifts more than 3% from the $5 the policy approved. The ledger row still says $5.00; the buy record carries the EURC amount and the price used.

## The money trail

One run on 2026-09-24 (`web/data.json`, live data, real mainnet buy paid in EURC):

```
poll 1  paid  escrowed $0.10 → charged $0.01 → refunded $0.09   allowance left $5.49
  ▼ SPACEX      token    $119.07  mark    $147.54   -19.3%  discount
  ▲ OPENAI      token  $1,318.19  mark  $1,023.64   +28.8%  premium
  ⚠ discount: SPACEX trades -19.3% vs mark
  ⚠ premium: OPENAI trades +28.8% vs mark
  ✓ buy SPACEX $5.00: bought 0.0418 SPACEX at $119.53 for 4.395895 EURC via Whirlpool → Meteora DLMM
    https://solscan.io/tx/J3CrbaLTMiFTcBFqqryeXBGapj5jgbNqtzgNLXuVrZrp6Tih7aVkTM4NXqBSPrXDUR7mzpfNFoQsns1cV7XvfZF
```

The pinned `web/data.json` before this was a live-dry-run from 2026-09-20 (real routes and prices, nothing signed); the run above replaced it with the signed mainnet record.

The ledger after the run has one `topup`, two `payment` rows to the report server with `scheme: upto`, deposit and refund columns, and, on a mainnet run, a `payment` row to `lite-api.jup.ag` whose `txHash` is the swap signature. A refused buy is a `blocked` row with the rule that refused it.

## Where it would break

- `effectiveMultiplier` in `src/jupiter.ts` picks `newMultiplier` once its timestamp has passed. If PreStocks schedules a split the agent quotes before the timestamp, `outUi` and `fillPrice` are off by the split ratio until it lands. The fill ceiling against mark then refuses the buy, which is the safe side.
- The PreStocks API `tokenPrice` is an index, not a fill. The buy policy checks Jupiter's actual fill against mark, not against `tokenPrice`.
- PreStocks mints carry a 100 bps transfer fee. Jupiter's `outAmount` is what arrives after the fee. The report does not add the fee back; the fill price already includes it.
- Jupiter's lite API is rate limited and keyless. A `429` is a `quote failed` refusal, and the reservation is released. Bring a paid Jupiter key for anything past a demo.
- With `--pay-with EURC` the allowance's own on-chain USDC check is off (it would refuse every buy from a wallet that holds no USDC); the demo checks the EURC and SOL balances itself before the first poll. The policy rails on the ledger are unchanged.
- The EURC price comes from Jupiter's price API at quote time. A wrong price cannot overspend by more than the 3% drift guard, because Jupiter's `swapUsdValue` is checked against the approved USD.
- `payingFetch` in allowance-kit opens one `upto` channel per report. On a real Solana operator that is one on-chain deposit per poll. Use the in-memory operator for tight polling loops, or poll slowly.
- Payment settlement in the demo is in-memory (`pinnedOperator`, the same pattern as the Wallie MCP demo). Real USDC settlement uses `createSolanaUptoOperator` from allowance-kit; `startReportServer` takes any `UptoOperator`.

## Honest limits

PreStocks tokens give economic exposure to private companies through an SPV and are not available to U.S. persons or other ineligible persons; see [prestocks.com](https://prestocks.com). Nothing here is investment advice. The agent is deterministic and needs no LLM. It buys only `Pre…` mints and nothing else; no other pre-IPO token appears in this repo.

## License

MIT
