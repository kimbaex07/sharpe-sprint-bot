// sharpe-sprint-bot: a dip-recovery scalper for the pump.fun Sharpe Sprint.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/makefun-bot.ts.
// Diagnostics go to stderr only — stdout carries protocol replies.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone(state, done) {
    strategy.onDone?.(state, done);
    console.error(
      `[sharpe-sprint-bot] done: ${done.reason} after seq ${state.seq}; ` +
        `cash=${state.cash} lamports, positions=${state.positions.size}`,
    );
  },
});
