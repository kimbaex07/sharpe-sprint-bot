// Dip-recovery scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most pump.fun curves bleed after their first push, then bounce as fresh buyers step in.
// This bot buys the bounce, not the push and not the falling knife: it enters only after the
// price has pulled back at least `dipPct` from its recent window high AND recovered at least
// `bouncePct` from the window low, while short-window net flow is positive, several distinct
// buyers are active, buys dominate the window's volume, and the price is trending up from the
// flow window's start. Stakes are small and scaled down when the curve's recent range is wide
// (volatility-aware sizing); exits scale out half at +10% so a winner that retraces still books
// a gain, then take-profit, stop-loss, trailing stop, max hold, big-sell and fade exits — all
// ratio-based (value/cost), so they survive a scale-out — and total exposure is capped so the
// equity curve stays smooth; the contest ranks hourly Sharpe, not wildest PnL.
//
// A pace keeper relaxes the dip threshold (never below `minDipPct`) when the count of distinct
// coins traded lags the elapsed share of a 6-hour window, so the bot still clears the
// 20-distinct-mint guardrail on quiet stretches instead of sitting idle.
//
// Deterministic by construction: no clock, no randomness, iteration only over insertion-ordered
// maps fed by the batch stream. All money math in SOL (float) for decisions; wire amounts are
// converted to integer lamports at the last step.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback window for the dip / range statistics, in slots. */
  window: number;
  /** Short window for the flow / bounce confirmation, in slots. */
  flowWindow: number;
  /** Entry: price must be at least this far below the window high. */
  dipPct: number;
  /** Loosest dip the pace keeper may relax to. */
  minDipPct: number;
  /** Entry: price must be at least this far above the window low (bounce confirmed). */
  bouncePct: number;
  /** Entry: net buy SOL (buys minus sells) over the flow window must exceed this. */
  minFlowSol: number;
  /** Entry: distinct buying wallets in the flow window. */
  minBuyers: number;
  /** Entry: the window's high/low range must be at most this share of the high. */
  maxRangePct: number;
  /** Long lookback for the uptrend filter, in slots. */
  longWindow: number;
  /** Entry: price now must be at least this far above the price at the long window's start. */
  minLongUp: number;
  /** Entry: net buy SOL over the long window must exceed this. */
  minLongFlowSol: number;
  /** Entry: price now must be at least this far above the price at the flow window's start. */
  trendUp: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Base stake per position (SOL), before volatility scaling. */
  baseStakeSol: number;
  /** Smallest stake worth sending (SOL). */
  minStakeSol: number;
  /** Volatility scaling: stake factor = clamp(refRange / range, 0.5, 1.0). */
  refRange: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits, as shares of cost / peak value. */
  takeProfit: number;
  /** Scale out: sell half the position once its value reaches cost * (1 + scaleOut). */
  scaleOut: number;
  stopLoss: number;
  trailArm: number;
  trail: number;
  /** Exit when net SOL over the flow window falls below this (negative). */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Pace keeper: distinct coins to reach by the end of the window. */
  targetCoins: number;
  /** Pace keeper: seconds of the window the pace is measured against (6h final window). */
  paceSecs: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 120,
  flowWindow: 45,
  longWindow: 240,
  minLongUp: 0.2,
  minLongFlowSol: 1.5,
  dipPct: 0.05,
  minDipPct: 0.03,
  bouncePct: 0.05,
  minFlowSol: 0.8,
  minBuyers: 6,
  maxRangePct: 0.5,
  minBuyShare: 0.7,
  trendUp: 0.03,
  lastSellSol: 1,
  minRqSol: 2,
  maxRqSol: 100,
  minAge: 120,
  baseStakeSol: 0.08,
  minStakeSol: 0.02,
  refRange: 0.25,
  buySlipBps: 500,
  takeProfit: 0.3,
  scaleOut: 0.07,
  stopLoss: 0.04,
  trailArm: 0.12,
  trail: 0.05,
  fadeNetSol: -2,
  bigSellSol: 2,
  maxHold: 600,
  cooldown: 60,
  maxEntries: 3,
  maxExposureSol: 1.5,
  targetCoins: 40,
  paceSecs: 21_600,
};

const LAMPORTS = 1e9;
/** Curve fee taken on sells (protocol 95 bps + creator 30 bps). */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  /** Best value/cost ratio seen (ratio-based, so it survives a scale-out). */
  peakRatio: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Half the position already sold at the scale-out level. */
  scaledOut: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  /** Entry-filter rejection counts (stderr diagnostics only; never affect decisions). */
  const rejects: Record<string, number> = {};
  const reject = (why: string): void => {
    rejects[why] = (rejects[why] ?? 0) + 1;
  };
  const keep = Math.max(p.window, p.longWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Window statistics for a tape at slot `now`: high, low, last price, net flow, buyers. */
  const windowStats = (t: Tape, now: number) => {
    const from = now - p.window;
    const flowFrom = now - p.flowWindow;
    const longFrom = now - p.longWindow;
    let high = 0;
    let low = Number.POSITIVE_INFINITY;
    let last = 0;
    let flow = 0;
    let buyVol = 0;
    let sellVol = 0;
    let flowStartPrice = -1;
    let longStartPrice = -1;
    let longFlow = 0;
    const buyers = new Set<string>();
    let lastSell = 0;
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        // Trades older than the entry window still anchor the long lookback.
        if (tr.slot > longFrom) {
          if (longStartPrice < 0) longStartPrice = tr.price;
          longFlow += tr.buy ? tr.sol : -tr.sol;
        }
        continue;
      }
      if (tr.price > high) high = tr.price;
      if (tr.price < low) low = tr.price;
      last = tr.price;
      if (tr.slot <= flowFrom) {
        flowStartPrice = tr.price;
        if (tr.slot > longFrom) {
          if (longStartPrice < 0) longStartPrice = tr.price;
          longFlow += tr.buy ? tr.sol : -tr.sol;
        }
        continue;
      }
      flow += tr.buy ? tr.sol : -tr.sol;
      if (tr.slot > longFrom) longFlow += tr.buy ? tr.sol : -tr.sol;
      if (longStartPrice < 0) longStartPrice = tr.price;
      if (tr.buy) {
        buyVol += tr.sol;
        buyers.add(tr.user);
      } else sellVol += tr.sol;
      if (!tr.buy) lastSell = tr.sol;
    }
    if (low === Number.POSITIVE_INFINITY) low = 0;
    if (flowStartPrice < 0) flowStartPrice = last;
    if (longStartPrice < 0) longStartPrice = last;
    const vol = buyVol + sellVol;
    return { high, low, last, flow, buyers: buyers.size, lastSell, buyShare: vol > 0 ? buyVol / vol : 0, flowStartPrice, longStartPrice, longFlow };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        h.lastValue = value;
        const ratio = cost > 0 ? value / cost : 0;
        if (ratio > h.peakRatio) h.peakRatio = ratio;
        // Scale out: bank half once the position is up scaleOut, so a winner that
        // retraces to the stop still books a gain instead of a loss.
        if (!h.scaledOut && !h.exiting && ratio >= 1 + p.scaleOut && !pendingByMint.has(mint)) {
          const half = BigInt(pos.token_amount) / 2n;
          if (half > 0n && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.scaledOut = true;
          }
          continue;
        }
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && ratio >= 1 + p.takeProfit) exit = true;
        if (!exit && ratio <= 1 - p.stopLoss) exit = true;
        if (!exit && h.peakRatio >= 1 + p.trailArm && ratio <= h.peakRatio * (1 - p.trail)) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && windowStats(t, now).flow < p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Pace keeper: relax the dip threshold when distinct coins lag the elapsed share.
      let dipPct = p.dipPct;
      if (firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const wantCoins = Math.ceil(p.targetCoins * pace);
        if (myCoins.size < wantCoins) {
          const lag = wantCoins - myCoins.size;
          dipPct = Math.max(p.minDipPct, p.dipPct - 0.01 * lag);
        }
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) { reject('no-curve'); continue; }
        if (held.has(mint) || pendingByMint.has(mint)) { reject('held-or-pending'); continue; }
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) { reject('entries-or-cooldown'); continue; }
        if (t.created === null || now - t.created < p.minAge) { reject('too-young'); continue; }
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) { reject('reserves'); continue; }
        const s = windowStats(t, now);
        if (s.high <= 0 || s.low <= 0 || s.last <= 0) { reject('no-price'); continue; }
        const range = (s.high - s.low) / s.high;
        if (range > p.maxRangePct) { reject('range'); continue; }
        // Dip from the window high, with a bounce off the window low.
        if (s.last > s.high * (1 - dipPct)) { reject('no-dip'); continue; }
        if (s.last < s.low * (1 + p.bouncePct)) { reject('no-bounce'); continue; }
        if (s.flow < p.minFlowSol) { reject('flow'); continue; }
        if (s.buyers < p.minBuyers) { reject('buyers'); continue; }
        if (s.buyShare < p.minBuyShare) { reject('buy-share'); continue; }
        if (s.last < s.flowStartPrice * (1 + p.trendUp)) { reject('trend'); continue; }
        // Dip inside an uptrend only: the curve must be up over the long window, with
        // net SOL flowing in over that window — not a dead curve bouncing.
        if (s.last < s.longStartPrice * (1 + p.minLongUp)) { reject('long-up'); continue; }
        if (s.longFlow < p.minLongFlowSol) { reject('long-flow'); continue; }
        if (s.lastSell >= p.lastSellSol) { reject('last-sell'); continue; }
        // Volatility-aware sizing: wide recent range -> smaller stake.
        const volFactor = Math.min(1, Math.max(0.5, p.refRange / Math.max(range, 0.05)));
        let amount = p.baseStakeSol * volFactor;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        amount = Math.min(amount, capSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minStakeSol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        rejects['entered'] = (rejects['entered'] ?? 0) + 1;
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakRatio: 0, invested: amount, exiting: false, filled: false, scaledOut: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      }
      return orders;
    },
    onDone() {
      const top = Object.entries(rejects).sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.error(`[sharpe-sprint-bot] entry diagnostics: ${top.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    },
  };
}
