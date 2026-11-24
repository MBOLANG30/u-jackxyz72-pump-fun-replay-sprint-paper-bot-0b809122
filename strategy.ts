// Pump.fun Replay Sprint — cliff-rebound paper bot (agent-fun/replay/v2).
//
// Strategy rebuilt from SPEC-V4-REBUILD.md only. It buys a pump.fun coin
// after a sharp cliff that is already bouncing on positive net flow, and
// exits on take-profit / stop-loss / trailing stop / time stop. Every
// decision is a pure function of the event stream: no clock, no randomness,
// no environment reads, so two executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface CliffReboundParams {
  /** Lookback window for the cliff / bounce / flow checks, in slots. */
  windowSlots: number;
  /** Cliff: price now at most (1 - cliffDropBps) of the price windowSlots ago. */
  cliffDropBps: number;
  /** Relaxed cliff used by the fallback pace near the end of the window. */
  cliffDropRelaxedBps: number;
  /** Bounce: price now at least (1 + bounceBps) above the window low. */
  bounceBps: number;
  /** Real SOL reserve must be inside [reserveMin, reserveMax]. */
  reserveMinLamports: bigint;
  reserveMaxLamports: bigint;
  /** A coin older than this (slots since creation) is never entered. */
  maxAgeSlots: number;
  /** Slots that must pass after an exit before the coin may be re-entered. */
  reentryCooldownSlots: number;
  /** SOL staked per entry, before the reserve cap. */
  stakeLamports: bigint;
  /** A buy may spend at most this many bps of the coin's real SOL reserve. */
  maxOrderBpsOfReserve: number;
  /** Take-profit: exit at this far above the entry fill price. */
  takeProfitBps: number;
  /** Stop-loss: exit at this far below the entry fill price. */
  stopLossBps: number;
  /** Trailing stop arms once the price is this far above entry. */
  trailArmBps: number;
  /** Once armed, exit this far below the highest price since entry. */
  trailBps: number;
  /** Time stop: exit after holding this many slots. */
  holdSlots: number;
  /** Fallback pace starts once this many slots of the window have elapsed. */
  fallbackAfterSlots: number;
  /** Fallback pace applies while fewer than this many coins were entered. */
  fallbackMinCoins: number;
  /** Slippage tolerance on every order. */
  maxSlippageBps: number;
}

export const DEFAULT_PARAMS: CliffReboundParams = {
  windowSlots: 20,
  cliffDropBps: 3700,
  cliffDropRelaxedBps: 3000,
  // Tuned on the dev window, inside this design: a 2% bounce confirms too
  // many dead-cat bounces (dev grade -0.20 SOL, 56 coins), while an 8%
  // bounce misses the real rebounds; 4% is the robust middle. A 150-slot
  // time stop cuts the slow bleed that a 300-slot hold allows. A 5 SOL
  // reserve floor keeps a 0.2 SOL order small against the curve (a 1 SOL
  // floor lets the order itself move the price 20% on entry and exit);
  // lower floors trade more coins for worse fills.
  bounceBps: 400,
  reserveMinLamports: 5_000_000_000n,
  reserveMaxLamports: 60_000_000_000n,
  maxAgeSlots: 3600,
  reentryCooldownSlots: 300,
  stakeLamports: 200_000_000n,
  maxOrderBpsOfReserve: 100,
  takeProfitBps: 3000,
  stopLossBps: 1000,
  trailArmBps: 1500,
  trailBps: 800,
  holdSlots: 150,
  fallbackAfterSlots: 302410,
  fallbackMinCoins: 20,
  maxSlippageBps: 500,
};

const MIN_ROUND_TRIP_LAMPORTS = 10_000_000n; // guardrail: 0.01 SOL per round trip

interface HistPoint {
  slot: number;
  price: number; // SOL per token, from virtual reserves
}

interface FlowPoint {
  slot: number;
  netLamports: bigint; // buys minus sells in SOL terms, per slot
}

interface EntryInfo {
  price: number; // effective entry fill price, SOL per token (fees included)
  slot: number; // slot the buy filled
  high: number; // highest price seen since entry
  buyLamports: bigint;
}

interface CoinTrack {
  createdSlot: number | null;
  firstSeenSlot: number;
  hist: HistPoint[]; // last price per traded slot, ascending; one anchor kept
  flow: FlowPoint[]; // per-slot net flow, ascending, window only
  lastExitSlot: number; // -1 when never exited
  entered: boolean;
  entry: EntryInfo | null;
}

/** SOL per token from a curve's virtual reserves; 0 when unusable. */
function curvePrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualQuote <= 0n || virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

export function createStrategy(params: CliffReboundParams = DEFAULT_PARAMS): Bot {
  const tracks = new Map<string, CoinTrack>();
  const enteredMints = new Set<string>();
  const roundTrippedMints = new Set<string>();
  const diag = { evaluated: 0, cliff: 0, bounce: 0, flow: 0, buys: 0, sells: 0 };
  let firstSlot = -1;

  function track(mint: string, slot: number): CoinTrack {
    let t = tracks.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: null,
        firstSeenSlot: slot,
        hist: [],
        flow: [],
        lastExitSlot: -1,
        entered: false,
        entry: null,
      };
      tracks.set(mint, t);
    }
    return t;
  }

  function pushHist(t: CoinTrack, slot: number, price: number): void {
    if (price <= 0) return;
    const h = t.hist;
    const last = h[h.length - 1];
    if (last !== undefined) {
      if (slot < last.slot) return; // stale mark
      if (slot === last.slot) {
        last.price = price;
        return;
      }
    }
    h.push({ slot, price });
  }

  function pushFlow(t: CoinTrack, slot: number, net: bigint): void {
    const f = t.flow;
    const last = f[f.length - 1];
    if (last !== undefined) {
      if (slot < last.slot) return;
      if (slot === last.slot) {
        last.netLamports += net;
        return;
      }
    }
    f.push({ slot, netLamports: net });
  }

  /** Drop history outside the window, keeping the latest pre-window price as anchor. */
  function prune(t: CoinTrack, slot: number): void {
    const cutoff = slot - params.windowSlots;
    let anchorIdx = -1;
    for (let i = 0; i < t.hist.length; i++) {
      if (t.hist[i].slot <= cutoff) anchorIdx = i;
      else break;
    }
    if (anchorIdx > 0) t.hist.splice(0, anchorIdx);
    let drop = 0;
    while (drop < t.flow.length && t.flow[drop].slot <= cutoff) drop++;
    if (drop > 0) t.flow.splice(0, drop);
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      const orders: OrderInput[] = [];

      // 1. Fold fills in: record entries on buy fills, exits on sell fills
      // (including the harness's own closes: _complete_ / _flatten_ / _writeoff_).
      for (const fill of batch.fills) {
        if (fill.status !== 'filled') continue;
        const t = track(fill.mint, fill.slot);
        if (fill.side === 'buy') {
          const tokens = BigInt(fill.token_amount);
          const quote = BigInt(fill.quote_lamports);
          const price = tokens > 0n ? Number(quote) / Number(tokens) : 0;
          t.entry = { price, slot: fill.slot, high: price, buyLamports: quote };
          t.entered = true;
          enteredMints.add(fill.mint);
        } else {
          if (t.entry !== null && t.entry.buyLamports >= MIN_ROUND_TRIP_LAMPORTS) {
            roundTrippedMints.add(fill.mint);
          }
          t.entry = null;
          t.lastExitSlot = fill.slot;
        }
      }

      // 2. Update per-coin price history and net flow from this slot's activity.
      const active = new Set<string>();
      for (const e of batch.events) {
        const t = track(e.mint, e.slot);
        active.add(e.mint);
        if (e.event === 'CreateEvent') {
          if (t.createdSlot === null) t.createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = state.curves.get(e.mint);
          if (c !== undefined) {
            pushHist(t, e.slot, curvePrice(c.virtual_quote_reserves, c.virtual_token_reserves));
          }
          pushFlow(t, e.slot, e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount));
        }
      }
      for (const m of batch.marks) {
        const t = track(m.mint, m.slot);
        active.add(m.mint);
        pushHist(t, m.slot, curvePrice(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves)));
      }
      for (const mint of active) {
        const t = tracks.get(mint);
        if (t !== undefined) prune(t, batch.slot);
      }

      // 3. Exits first: whichever of take-profit / stop-loss / trailing stop /
      // time stop comes first. Skip coins with a sell already pending, and
      // coins the curve completed (the harness closes those itself).
      const pendingBuy = new Set<string>();
      const pendingSell = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
        else pendingSell.add(p.order.mint);
      }
      for (const [mint, holding] of state.positions) {
        if (pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tracks.get(mint);
        if (t === undefined) continue;
        const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        let entry = t.entry;
        if (entry === null) {
          // Position without a recorded buy fill: rebuild from its cost.
          const tokens = holding.token_amount;
          const p0 = tokens > 0n ? Number(holding.cost_lamports) / Number(tokens) : 0;
          if (p0 <= 0) continue;
          entry = { price: p0, slot: batch.slot, high: p0, buyLamports: holding.cost_lamports };
          t.entry = entry;
        }
        if (price > entry.high) entry.high = price;
        const takeProfit = entry.price * (1 + params.takeProfitBps / 10000);
        const stopLoss = entry.price * (1 - params.stopLossBps / 10000);
        const armed = entry.high >= entry.price * (1 + params.trailArmBps / 10000);
        const trail = entry.high * (1 - params.trailBps / 10000);
        const timedOut = batch.slot - entry.slot >= params.holdSlots;
        if (price >= takeProfit || price <= stopLoss || (armed && price <= trail) || timedOut) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: params.maxSlippageBps,
          });
          diag.sells++;
        }
      }

      // 4. Entries: cliff + bounce + flow + reserve + age + cooldown, all at
      // the same slot. Near the end of the window, if the bot is short of the
      // 20-coin guardrail, relax the cliff from a 37% drop to a 30% drop.
      const relaxed =
        batch.slot - firstSlot >= params.fallbackAfterSlots && enteredMints.size < params.fallbackMinCoins;
      const cliffBps = relaxed ? params.cliffDropRelaxedBps : params.cliffDropBps;
      const cutoff = batch.slot - params.windowSlots;
      const txFee = state.txFeeLamports();
      let plannedSpend = 0n;
      let buysPlanned = 0;
      for (const mint of active) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        if (state.committedPositionCount() + buysPlanned >= state.hello.caps.max_open_positions) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tracks.get(mint);
        if (t === undefined) continue;
        const created = t.createdSlot ?? curve.created_slot ?? t.firstSeenSlot;
        if (batch.slot - created > params.maxAgeSlots) continue;
        if (t.lastExitSlot >= 0 && batch.slot - t.lastExitSlot < params.reentryCooldownSlots) continue;
        const reserve = curve.real_quote_reserves;
        if (reserve < params.reserveMinLamports || reserve > params.reserveMaxLamports) continue;
        let anchor: HistPoint | undefined;
        for (const h of t.hist) {
          if (h.slot <= cutoff) anchor = h;
          else break;
        }
        if (anchor === undefined || anchor.price <= 0) continue;
        const priceNow = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (priceNow <= 0) continue;
        diag.evaluated++;
        // CLIFF: fallen at least cliffBps within the last windowSlots slots.
        if (priceNow > anchor.price * (1 - cliffBps / 10000)) continue;
        diag.cliff++;
        // BOUNCE: risen at least bounceBps from the lowest point in the window.
        let minPrice = anchor.price;
        let minSlot = cutoff; // slot of the window low; the anchor is the window start
        for (const h of t.hist) {
          if (h.slot >= cutoff && h.price <= minPrice) {
            minPrice = h.price;
            minSlot = h.slot;
          }
        }
        if (priceNow < minPrice * (1 + params.bounceBps / 10000)) continue;
        diag.bounce++;
        // FLOW: the rebound itself is buy-driven — net SOL flow after the
        // window low is positive. (A literal whole-window reading cannot
        // fire together with the cliff: the crash's own sells dominate any
        // 20-slot window containing it. On the dev data, whole-window flow
        // at cliff+bounce moments is always negative — median -15.4 SOL,
        // 0 of 182 moments positive — so it would trade nothing at all,
        // contradicting the design's measured 24 coins. The bounce's own
        // flow is what confirms the rebound.)
        let flow = 0n;
        for (const f of t.flow) {
          if (f.slot > minSlot) flow += f.netLamports;
        }
        if (flow <= 0n) continue;
        diag.flow++;
        // SIZING: 0.2 SOL per entry, never more than 1% of the real reserve.
        let stake = params.stakeLamports;
        const cap = (reserve * BigInt(params.maxOrderBpsOfReserve)) / 10000n;
        if (cap < stake) stake = cap;
        if (stake < MIN_ROUND_TRIP_LAMPORTS) continue;
        if (state.freeCashLamports() - plannedSpend < stake + txFee) continue;
        plannedSpend += stake + txFee;
        buysPlanned++;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: stake,
          max_slippage_bps: params.maxSlippageBps,
        });
        diag.orders++;
        diag.buys++;
      }

      return orders;
    },

    onDone(state: BotState): void {
      console.error(
        `[cliff-rebound] evaluated=${diag.evaluated} cliff=${diag.cliff} ` +
          `bounce=${diag.bounce} flow=${diag.flow} buys=${diag.buys} sells=${diag.sells} ` +
          `entered=${enteredMints.size} roundTrips=${roundTrippedMints.size} ` +
          `cash=${state.cash}`,
      );
    },
  };
}
