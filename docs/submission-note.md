# Stocklana submission: PreStocks bounty addendum

Entry: Wallie (AllowanceKit). Main-track project is the tokenized-stock monitor and the x402 `upto` payment rail. This repo is the PreStocks bounty part of the same single entry.

## One sentence

An agent that watches the 8 PreStocks tokens, pays a cent per premium report over an x402 `upto` channel, and buys a token on Jupiter when it trades under its PreStocks mark, with the report and the buy drawn from one allowance.

## Originality of the PreStocks use

- Data: `https://prestocks.com/api/prestocks` and `/api/stats` are the only price sources. Token price, mark price, supply, valuations, volume, holders.
- Decision and execution under a spending limit, not a dashboard. Allowance rails from allowance-kit (host allowlist, per-call cap, velocity, budget, approval threshold, kill switch) plus a buy policy (per-trade, per-session, price impact, fill ceiling against mark). Every refusal is a logged reason.
- Trading: the executor buys the actual PreStocks Token-2022 mints (`Pre…`) through Jupiter, paying USDC or EURC, reading the ScaledUiAmount multiplier from the mint so the fill matches the API's per-token price after the SPACEX split.
- Exclusivity: the executor refuses any mint that is not a PreStocks mint. No other pre-IPO token is integrated or tradeable through this repo.
- Against the other entries seen on 2026-09-20 (prestocks-pulse, prestocks-terminal are data layers and dashboards), this one has the agent decide and execute under a limit. The same allowance pays for the data and the stock.

## Technical soundness

- 33 offline tests from pinned 2026-09-20/21 fixtures of both PreStocks endpoints and Jupiter price, quote and swap responses (USDC and EURC).
- `effectiveMultiplier` reads the scheduled ScaledUiAmount split from the mint, so a SPACEX fill prints at the post-split price, not 5x high. The fill ceiling against mark is the safe fallback if a split is quoted before its timestamp lands.
- Paying in EURC: the allowance, buy policy and ledger stay in USD. A $5 buy becomes the EURC worth $5 at Jupiter's live price, refused if that valuation drifts more than 3% from the approved $5.
- Depends on `allowance-kit@0.7.1`; no web3.js v1 leaks into AllowanceKit, this repo owns the Solana buy dependency.

## Mainnet proof

Real buy on Solana mainnet, 2026-09-24, paid in EURC from the funded agent wallet, one poll, `--pay-with EURC`. SPACEX read $119.07 against a $147.54 PreStocks mark, -19.3%. The discount rule fired, the buy policy approved it, and the fill was 0.041831 SPACEX at $119.53 for 4.395895 EURC ($5.00 at Jupiter's live EURC price) via Whirlpool then Meteora DLMM, price impact 3.5% under the 5% cap. One allowance paid for both: the report cost $0.01 over the x402 `upto` channel ($0.10 escrowed, $0.09 refunded); the $5.00 buy drew from the same $10.50 allowance, $5.49 left after.

- Swap tx: https://solscan.io/tx/J3CrbaLTMiFTcBFqqryeXBGapj5jgbNqtzgNLXuVrZrp6Tih7aVkTM4NXqBSPrXDUR7mzpfNFoQsns1cV7XvfZF
- Agent wallet: `FhzduRUsSK4SKZEekUZmVo6Xp95zyyhniu1hZ3ASoUba`
- Recorded in `web/data.json` (`mode: mainnet`, `payToken: EURC`); the `lite-api.jup.ag` ledger row carries the signature as its `txHash`.

## Life after the hackathon

- The report server is an x402 seller. Any agent with `allowance-kit` can buy reports today.
- The buy path is one policy object away from a standing "buy the dip under mark" agent with a monthly allowance and email or Telegram alerts through Wallie's notify channel.
- A sell path is the mirror of `quoteBuy` with the mints swapped.

## Links

- Repo: https://github.com/fskroes/wallie-prestocks
- Live page: https://www.onewallie.com/prestocks.html (GitHub Pages mirror: https://fskroes.github.io/wallie-prestocks/)
- Launch/run record: `web/data.json`
- AllowanceKit: https://www.npmjs.com/package/allowance-kit
