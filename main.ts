// Pump.fun Replay Sprint — cliff-rebound paper bot (agent-fun/replay/v2).
// Entrypoint: the grader runs `node /bot/main.ts`. The strategy lives in
// strategy.ts; the wire protocol lives in the kit's vendored shim.
// The strategy is a pure function of the event stream (no clock, no
// randomness), so the two grading executions agree byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
