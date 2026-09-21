# Stocklana submission note: PreStocks bounty

Addendum to the Wallie Stocklana entry. The entry is one project (Wallie) with three bounty-specific pieces: the Solana x402 rail in AllowanceKit, the Meteora DBC exit report in wallie-dbc, and this repo for the PreStocks bounty. The portal allows one submission per team; this addendum is added to that submission by editing it, not by a second entry.

## What the PreStocks piece is

A Wallie agent that watches the 8 PreStocks tokens, pays a cent per premium report over an x402 `upto` channel, and buys a token on Jupiter when it trades under its PreStocks mark, all inside one allowance. The report and the buy share one ledger.

## Why it is a use of PreStocks

- Data: `https://prestocks.com/api/prestocks` and `/api/stats` are the only price sources. Token price, mark price, supply, valuations, volume, holders.
- Trading: the executor buys the actual PreStocks Token-2022 mints (`Pre…`) through Jupiter, paying in USDC or EURC, reading the ScaledUiAmount multiplier from the mint so the fill matches the API's per-token price after the SPACEX split.
- Exclusivity: the executor refuses any mint that is not a PreStocks mint. No other pre-IPO token is integrated, referenced, or tradeable through this repo.

## What is different from the other PreStocks entries

The public entries seen on 2026-09-20 (prestocks-pulse, prestocks-terminal) are data layers and dashboards with Jupiter quote links. This one has the agent decide and execute under a spending limit: allowance rails from allowance-kit (host allowlist, per-call cap, velocity, budget, approval threshold, kill switch) plus a buy policy (per-trade, per-session, price impact, fill ceiling against mark). Every refusal is a logged reason. The same allowance pays for the data and the stock.

## Evidence

- 33 offline tests from pinned 2026-09-20/21 fixtures of both PreStocks endpoints and Jupiter price, quote and swap responses (USDC and EURC).
- `web/data.json`: a recorded run with live PreStocks data and live Jupiter routes, dry-run buys.
- Mainnet buy: see the "Mainnet proof" section below once the owner runs it.
- CLI `quote SPACEX` live on 2026-09-20: $5 → 0.041210 SPACEX at $121.33, Meteora DLMM, impact 2.7%, ui multiplier 5.

## Life after the hackathon

- The report server is an x402 seller any `allowance-kit` agent can buy from today.
- The buy path is one policy object away from a standing "buy the dip under mark" agent with a monthly allowance and email or Telegram alerts through Wallie's notify channel.
- A sell path is the mirror of `quoteBuy` with the mints swapped.

## Links

- Repo: https://github.com/fskroes/wallie-prestocks
- Live page: https://www.onewallie.com/prestocks.html (mirror: https://fskroes.github.io/wallie-prestocks/)
- AllowanceKit: https://github.com/fskroes/AllowanceKit, npm `allowance-kit`
- PreStocks API: https://prestocks.com/api/prestocks
