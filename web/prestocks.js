/* prestocks.js — renders the PreStocks premium report page from a data.json produced by demo/run.ts.
   Shared verbatim by web/index.html in this repo and /prestocks.html on onewallie.com (assets/prestocks.js).
   Every figure on the page comes from the data file; nothing is typed by hand. */
(async () => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const usd = (n, d = 2) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (n, d = 1) => (n >= 0 ? "+" : "") + (n * 100).toFixed(d) + "%";
  const micro = (s) => "$" + (Number(s) / 1e6).toFixed(2);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const src = document.currentScript?.dataset.src || "data.json";

  let live;
  try {
    live = await fetch(src).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  } catch {
    const el = $("#data-error"); if (el) el.hidden = false;
    return;
  }

  const first = live.polls.find((p) => p.report);
  const R = first?.report;
  if (!R) return;

  // ---- the table: every PreStock, ranked ----
  const cls = (s) => (s === "discount" ? "disc" : s === "premium" ? "prem" : "");
  $("#board tbody").innerHTML = R.ranked.map((sym) => {
    const l = R.lines.find((x) => x.symbol === sym);
    const flag = l.signal === "discount" ? "▼" : l.signal === "premium" ? "▲" : "·";
    const watched = live.watch.includes(sym);
    return `<tr class="${cls(l.signal)}${watched ? " watched" : ""}">
      <td class="flag">${flag}</td>
      <td class="sym">${esc(l.symbol)}<span class="name">${esc(l.name.replace(" PreStocks", ""))}</span></td>
      <td class="num">${usd(l.tokenPrice)}</td>
      <td class="num">${usd(l.markPrice)}</td>
      <td class="num prem-cell">${pct(l.premium)}</td>
      <td class="num">${l.holders ? l.holders.toLocaleString("en-US") : "—"}</td>
      <td class="num">${l.volumeUsd ? usd(l.volumeUsd, 0) : "—"}</td>
      <td class="mint"><a href="https://solscan.io/token/${esc(l.mint)}" target="_blank" rel="noopener">${esc(l.mint.slice(0, 6))}…${esc(l.mint.slice(-4))}</a></td>
    </tr>`;
  }).join("");
  $("#board-when").textContent = `prestocks.com/api/prestocks · ${new Date(R.fetchedAt).toUTCString()} · band ±${(R.band * 100).toFixed(0)}%`;
  if (R.cheapest && R.dearest) {
    $("#cheapest").innerHTML = `<b>${esc(R.cheapest.symbol)}</b> ${pct(R.cheapest.premium)}`;
    $("#dearest").innerHTML = `<b>${esc(R.dearest.symbol)}</b> ${pct(R.dearest.premium)}`;
  }

  // ---- the run: polls, alerts, buy decisions, money ----
  const alertCls = (rule) => ({ discount: "ok", premium: "warn", crossed: "lock" })[rule] || "warn";
  $("#run-head").innerHTML =
    `mode <b>${esc(live.mode)}</b> · agent <span class="addr">${esc(live.agent)}</span><br>` +
    `watch ${live.watch.map(esc).join(", ")} · buy ${live.policy.symbols.length ? live.policy.symbols.map(esc).join(", ") : "none"} when ≥ ${(live.policy.buyBelowDiscount * 100).toFixed(0)}% below mark<br>` +
    `rails ${usd(live.policy.maxPerTradeUsd)} per trade · ${usd(live.policy.maxTotalUsd)} total · impact ≤ ${(live.policy.maxPriceImpact * 100).toFixed(0)}% · fill ≤ mark + ${(live.policy.maxFillOverMark * 100).toFixed(0)}% · allowance ${usd(live.policy.allowanceUsd)}`;
  $("#timeline").innerHTML = live.polls.map((p) => {
    const alerts = p.alerts.map((a) => `<span class="alert ${alertCls(a.rule)}">${esc(a.rule)}: ${esc(a.detail)}</span>`).join("");
    const buys = p.buys.map((b) => {
      const link = b.signature ? ` <a href="https://solscan.io/tx/${esc(b.signature)}" target="_blank" rel="noopener">${esc(b.signature.slice(0, 16))}… on Solscan</a>` : "";
      const q = b.quote ? ` <span class="q">quote ${b.quote.outUi.toFixed(4)} ${esc(b.symbol)} @ ${usd(b.quote.fillPrice)} · impact ${(b.quote.priceImpact * 100).toFixed(2)}% · ${b.quote.route.map(esc).join(" → ")}</span>` : "";
      return `<div class="buy ${b.allowed ? "yes" : "no"}"><b>${b.allowed ? "✓" : "✗"} buy ${esc(b.symbol)} ${micro(b.usdcMicro)}</b> ${esc(b.reason)}${link}${q}</div>`;
    }).join("");
    return `<div class="poll"><div class="money"><b>poll ${p.n}</b><br><span class="esc">escrow ${micro(p.quotedMicro)}</span><br><span class="chg">charged ${micro(p.costMicro)}</span><br><span class="ref">refund ${micro(p.refundMicro)}</span></div><div>${p.ok ? alerts || '<span class="alert">no alerts on the watchlist</span>' : `<span class="alert bad">blocked: ${esc(p.reason || "policy")}</span>`}${buys}</div></div>`;
  }).join("");
  const mainnetBuys = live.polls.flatMap((p) => p.buys).filter((b) => b.signature);
  $("#run-total").innerHTML =
    `${live.polls.length} reports · report spend <b>${micro(live.spentMicro)}</b> · PreStocks bought <b>${micro(live.boughtMicro)}</b>` +
    (mainnetBuys.length ? ` · ${mainnetBuys.length} real swap${mainnetBuys.length > 1 ? "s" : ""} on Solana mainnet` : live.mode === "mainnet" ? "" : " · buys were dry runs against live Jupiter quotes") +
    (live.stoppedBy ? ` · stopped by ${esc(live.stoppedBy)}` : "");

  // ---- the ledger: one audit trail for reports and buys ----
  if (live.ledger && $("#ledger")) {
    $("#ledger").textContent = live.ledger.map((e) => {
      const t = e.at.slice(11, 19);
      if (e.t === "topup") return `${t}  topup     +${micro(e.amountMicro)}  ${e.source}`;
      if (e.t === "payment") return `${t}  payment   -${micro(e.amountMicro)}  ${e.host}${e.scheme === "upto" ? `  (escrow ${micro(e.depositMicro)}, refund ${micro(e.refundMicro)})` : ""}  ${e.txHash.slice(0, 12)}…`;
      if (e.t === "blocked") return `${t}  blocked   ${micro(e.attemptedMicro)}  ${e.host}  ${e.rule}`;
      return `${t}  ${e.t}`;
    }).join("\n");
  }
})();
