# sharpe-sprint-bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/kimbaex07/sharpe-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/kimbaex07/sharpe-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition on make.fun. It trades on a 6-hour pump.fun replay and is ranked by hourly Sharpe ratio, so it is built for a smooth equity curve: many small trades, tight exits, strict drawdown control.

## Strategy: volatility-aware dip-recovery scalper

Most pump.fun curves bleed after their first push, then bounce as fresh buyers step in. The bot buys the bounce — not the push, and not the falling knife:

- **Entry — a pullback inside an uptrend:** the price has pulled back at least 5% from its 120-slot window high **and** recovered at least 5% from the window low, while the curve is still up at least 20% over a 240-slot lookback with net SOL flowing in (≥ 1.5 SOL). Short-window flow must be positive (≥ 0.8 SOL over 45 slots) with at least 6 distinct buyers, buys dominating volume (≥ 70%), and the price trending up from the flow window's start. Curves with a wild recent range (> 50% high/low), a fresh large sell, age under 120 slots, or real reserves outside 2–100 SOL are skipped.
- **Sizing:** a small base stake of 0.08 SOL per position, scaled down when the curve's recent range is wide (volatility-aware), capped at 1% of real reserves and 1.5 SOL total exposure across at most 5 open positions.
- **Exits (ratio-based, so they survive a scale-out):** sell half at +7% so a winner that retraces still books a gain; take-profit +30% on the rest, stop-loss −4%, trailing stop 5% once up 12%, max hold 600 slots, plus big-sell (≥ 2 SOL single sell) and flow-fade exits.
- **Pace keeper:** the dip threshold relaxes (never below 3%) when distinct coins traded lag the elapsed share of the 6-hour window, so the bot clears the 20-distinct-mint guardrail even on quiet stretches.
- **Deterministic:** no clock, no randomness, no network — the two grader executions produce byte-identical action logs.

## Dev grade (kit dev window, `grade-local --driver process`)

- Net PnL: −0.0047 SOL (essentially breakeven; −0.05% on 10 SOL capital)
- Sharpe (hourly): −0.015
- Win rate: 34.5%, 87 round trips, 59 distinct mints
- Max drawdown: 0.85% (guardrail: 50%)

The bot was tuned across ten local grades (v1 −0.62 SOL → v9 −0.005 SOL); the guardrails are met with wide margin on the dev window. The final window is fresh data, so dev numbers are a guide, not a forecast — and the stress check says so plainly: on 20 rebuilt copies of the dev window the bot lost money on all 20 (median −0.24 SOL, p10 −0.36, p90 −0.09), so the near-breakeven dev score leans on this window's particular coins and the strategy has no proven positive edge on a fresh window.

## Files

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts` (Node 22+).
- `strategy.ts` — the strategy (parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `LICENSE` — MIT.

## Grade locally

From the unpacked kit directory:

```bash
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree
```

(`--driver docker` is the server's sandbox; `process` runs the same grade on this machine when Docker is unavailable. Add `--stress 20` for the rebuilt-window spread. The bundle/transcripts are supplied at submit time by the parent agent.)
