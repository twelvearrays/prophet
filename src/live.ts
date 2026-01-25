import { StrategyEngine } from './core/StrategyEngine';
import { PolymarketClient, CryptoMarket } from './api/PolymarketClient';
import { StrategyEvent, PriceTick, StrategyConfig } from './types';
import { formatPrice, formatPnL } from './utils/helpers';

// ============================================================================
// LIVE TRADING RUNNER (PAPER MODE)
// ============================================================================
// Connects to Polymarket and runs the strategy in paper trading mode.
// Run with: npx ts-node src/live.ts
// ============================================================================

interface LiveRunnerConfig {
  strategy: Partial<StrategyConfig>;
  pollIntervalMs: number;
  paperMode: boolean;
  symbols: string[];  // e.g., ['BTC', 'ETH']
}

const DEFAULT_RUNNER_CONFIG: LiveRunnerConfig = {
  strategy: {},
  pollIntervalMs: 2000,
  paperMode: true,
  symbols: ['BTC'],
};

class LiveRunner {
  private client: PolymarketClient;
  private config: LiveRunnerConfig;
  private activeEngines: Map<string, StrategyEngine> = new Map();
  private stopFunctions: Map<string, () => void> = new Map();
  private sessionStats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalPnL: 0,
  };

  constructor(config: Partial<LiveRunnerConfig> = {}) {
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...config };
    this.client = new PolymarketClient();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting Polymarket Strategy Runner');
    console.log('='.repeat(60));
    console.log(`Mode: ${this.config.paperMode ? '📝 PAPER TRADING' : '💰 LIVE TRADING'}`);
    console.log(`Symbols: ${this.config.symbols.join(', ')}`);
    console.log(`Poll interval: ${this.config.pollIntervalMs}ms`);
    console.log('='.repeat(60));
    console.log('');

    // Find active markets
    await this.discoverMarkets();

    // Keep running
    console.log('\n👀 Watching for markets... (Ctrl+C to stop)\n');

    // Refresh markets every 5 minutes
    setInterval(() => this.discoverMarkets(), 5 * 60 * 1000);
  }

  private async discoverMarkets(): Promise<void> {
    try {
      console.log('🔍 Searching for active crypto markets...');
      const markets = await this.client.getCryptoMarkets();

      // Filter by symbols we care about
      const relevantMarkets = markets.filter(m =>
        this.config.symbols.includes(m.symbol)
      );

      console.log(`   Found ${relevantMarkets.length} relevant markets`);

      for (const market of relevantMarkets) {
        const timeToEnd = market.endTime.getTime() - Date.now();
        const minutesToEnd = timeToEnd / 60000;

        // Only trade markets with 3-15 minutes remaining
        if (minutesToEnd > 3 && minutesToEnd < 15) {
          if (!this.activeEngines.has(market.conditionId)) {
            this.startTracking(market);
          }
        }
      }
    } catch (error) {
      console.error('❌ Failed to discover markets:', error);
    }
  }

  private startTracking(market: CryptoMarket): void {
    console.log(`\n📊 Starting to track: ${market.question}`);
    console.log(`   End time: ${market.endTime.toLocaleTimeString()}`);
    console.log(`   Condition ID: ${market.conditionId}`);

    // Create strategy engine
    const engine = new StrategyEngine(this.config.strategy);

    // Subscribe to events
    engine.onEvent((event) => this.handleEvent(event, market));

    // Start session
    engine.startSession(
      market.conditionId,
      market.question,
      market.endTime.getTime()
    );

    this.activeEngines.set(market.conditionId, engine);

    // Start polling prices
    const stopPolling = this.client.startPolling(
      market.yesTokenId,
      market.noTokenId,
      (tick) => this.handleTick(market.conditionId, tick),
      this.config.pollIntervalMs
    );

    this.stopFunctions.set(market.conditionId, stopPolling);

    // Set timeout for resolution
    const timeToEnd = market.endTime.getTime() - Date.now();
    setTimeout(() => this.resolveMarket(market), timeToEnd + 5000);
  }

  private handleTick(conditionId: string, tick: PriceTick): void {
    const engine = this.activeEngines.get(conditionId);
    if (!engine) return;

    const evaluation = engine.onPriceTick(tick);

    // Log current state periodically
    const session = engine.getSession();
    if (session && Math.random() < 0.1) {  // 10% of ticks
      const timeRemaining = (session.endTime - Date.now()) / 60000;
      console.log(
        `   [${session.marketName.slice(0, 40)}...] ` +
        `YES: ${formatPrice(tick.yesPrice)} | ` +
        `State: ${session.state} | ` +
        `Time: ${timeRemaining.toFixed(1)}m`
      );
    }

    // Execute action if needed
    if (evaluation.action.type !== 'NONE' && evaluation.action.type !== 'CLOSE') {
      if (this.config.paperMode) {
        // Paper trade - just record it
        const price = 'price' in evaluation.action ? evaluation.action.price : 0;
        engine.executeAction(evaluation.action, price);
      } else {
        // TODO: Real trading - would need to place orders via API
        console.log('⚠️ Live trading not implemented yet');
      }
    }
  }

  private handleEvent(event: StrategyEvent, market: CryptoMarket): void {
    switch (event.type) {
      case 'SESSION_START':
        console.log(`   ▶️ Session started for ${market.symbol}`);
        break;

      case 'ACTION_TAKEN':
        const action = event.action;
        if (action.type === 'ENTER') {
          console.log(
            `   🎯 ENTRY: ${action.side} at ${formatPrice(action.price)} ` +
            `($${action.amount.toFixed(2)})`
          );
        } else if (action.type === 'SCALE') {
          console.log(
            `   📈 SCALE ${action.scaleLevel}: ${action.side} at ${formatPrice(action.price)}`
          );
        } else if (action.type === 'HEDGE') {
          console.log(
            `   🛡️ HEDGE: ${action.side} ${action.shares.toFixed(2)} shares ` +
            `at ${formatPrice(action.price)}`
          );
        }
        break;

      case 'HEDGE_TRIGGERED':
        console.log(
          `   ⚠️ Hedge triggered! Locked loss: ${formatPnL(-event.hedgedPair.lockedLoss)}`
        );
        break;

      case 'SESSION_RESOLVED':
        const summary = event.summary;
        this.sessionStats.totalTrades++;
        this.sessionStats.totalPnL += summary.pnl;
        if (summary.won) this.sessionStats.wins++;
        else if (summary.pnl < 0) this.sessionStats.losses++;

        console.log(`\n   ✅ RESOLVED: ${summary.resolution} wins`);
        if (summary.didTrade) {
          console.log(`   P&L: ${formatPnL(summary.pnl)} (${summary.pnlPercent.toFixed(1)}%)`);
          console.log(`   Entry: ${summary.entrySide} at ${formatPrice(summary.entryPrice || 0)}`);
          if (summary.wasHedged) console.log(`   (Hedged ${summary.hedgeCount}x)`);
        } else {
          console.log('   No trade taken');
        }

        console.log(`\n   📊 Session Stats: ${this.sessionStats.wins}W/${this.sessionStats.losses}L ` +
          `| Total P&L: ${formatPnL(this.sessionStats.totalPnL)}`);
        break;

      case 'ERROR':
        console.error(`   ❌ Error: ${event.error.message}`);
        break;
    }
  }

  private async resolveMarket(market: CryptoMarket): Promise<void> {
    const engine = this.activeEngines.get(market.conditionId);
    if (!engine) return;

    console.log(`\n⏰ Market ending: ${market.question}`);

    // Stop polling
    const stopPolling = this.stopFunctions.get(market.conditionId);
    if (stopPolling) {
      stopPolling();
      this.stopFunctions.delete(market.conditionId);
    }

    try {
      // Get final price to determine winner
      const finalTick = await this.client.getPriceTick(
        market.yesTokenId,
        market.noTokenId
      );

      const winner = finalTick.yesPrice > 0.5 ? 'YES' : 'NO';
      engine.resolve(winner);
    } catch (error) {
      console.error('Failed to resolve market:', error);
      // Assume YES wins if we can't get final price
      engine.resolve('YES');
    }

    // Cleanup
    this.activeEngines.delete(market.conditionId);
  }

  stop(): void {
    console.log('\n🛑 Stopping runner...');

    // Stop all polling
    for (const stop of this.stopFunctions.values()) {
      stop();
    }

    // Disconnect client
    this.client.disconnect();

    console.log('Done.');
  }
}

// Main
async function main() {
  const runner = new LiveRunner({
    paperMode: true,
    symbols: ['BTC', 'ETH'],
    pollIntervalMs: 2000,
    strategy: {
      positionSize: 30,
      entryThreshold: 0.65,
      hedgeDropPoints: 0.12,
    },
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    runner.stop();
    process.exit(0);
  });

  await runner.start();
}

main().catch(console.error);
