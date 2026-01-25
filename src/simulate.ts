import { StrategyEngine } from './core/StrategyEngine';
import { Simulator, SimulationStats } from './core/Simulator';
import { DEFAULT_STRATEGY_CONFIG } from './types';

// ============================================================================
// SIMULATION RUNNER
// ============================================================================
// Run this with: npx ts-node src/simulate.ts
// ============================================================================

function printStats(stats: SimulationStats, label: string = 'Results'): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label}`);
  console.log('='.repeat(60));

  console.log(`\n📊 TRADE ACTIVITY`);
  console.log(`   Total simulations: ${stats.totalSimulations}`);
  console.log(`   Traded: ${stats.traded} (${stats.entryRate.toFixed(1)}%)`);
  console.log(`   No entry: ${stats.noTrade}`);

  console.log(`\n🎯 WIN/LOSS`);
  console.log(`   Wins: ${stats.wins}`);
  console.log(`   Losses: ${stats.losses}`);
  console.log(`   Breakeven: ${stats.breakeven}`);
  console.log(`   Win Rate: ${stats.winRate.toFixed(1)}%`);

  console.log(`\n💰 P&L`);
  console.log(`   Total P&L: $${stats.totalPnL.toFixed(2)}`);
  console.log(`   Avg P&L: $${stats.avgPnL.toFixed(2)}`);
  console.log(`   Median P&L: $${stats.medianPnL.toFixed(2)}`);
  console.log(`   Std Dev: $${stats.stdDev.toFixed(2)}`);
  console.log(`   Sharpe: ${stats.sharpe.toFixed(2)}`);

  console.log(`\n📈 PERCENTILES`);
  console.log(`   5th (worst):  $${stats.percentile5.toFixed(2)}`);
  console.log(`   25th:         $${stats.percentile25.toFixed(2)}`);
  console.log(`   50th (median): $${stats.medianPnL.toFixed(2)}`);
  console.log(`   75th:         $${stats.percentile75.toFixed(2)}`);
  console.log(`   95th (best):  $${stats.percentile95.toFixed(2)}`);

  console.log(`\n🛡️ HEDGE ANALYSIS`);
  console.log(`   Unhedged trades: ${stats.unhedgedCount}`);
  console.log(`     Win rate: ${stats.unhedgedWinRate.toFixed(1)}%`);
  console.log(`     Avg P&L: $${stats.unhedgedAvgPnL.toFixed(2)}`);
  console.log(`   Hedged trades: ${stats.hedgedCount}`);
  console.log(`     Win rate: ${stats.hedgedWinRate.toFixed(1)}%`);
  console.log(`     Avg P&L: $${stats.hedgedAvgPnL.toFixed(2)}`);

  console.log(`\n${'='.repeat(60)}\n`);
}

async function main() {
  console.log('🎲 Polymarket Strategy Simulator');
  console.log('================================\n');

  const simulator = new Simulator();
  const numSimulations = 1000;

  console.log(`Running ${numSimulations} simulations...\n`);

  // Run with default config
  const { stats: defaultStats } = simulator.runMany(
    () => new StrategyEngine(),
    numSimulations,
    (completed, total) => {
      if (completed % 200 === 0) {
        console.log(`  Progress: ${completed}/${total}`);
      }
    }
  );

  printStats(defaultStats, 'DEFAULT CONFIG (65¢ entry, 12pt hedge)');

  // Try a more conservative config
  console.log('Running with conservative config (70¢ entry)...\n');
  const { stats: conservativeStats } = simulator.runMany(
    () => new StrategyEngine({
      entryThreshold: 0.70,
      hedgeDropPoints: 0.10,
    }),
    numSimulations
  );

  printStats(conservativeStats, 'CONSERVATIVE CONFIG (70¢ entry, 10pt hedge)');

  // Try a more aggressive config
  console.log('Running with aggressive config (60¢ entry)...\n');
  const { stats: aggressiveStats } = simulator.runMany(
    () => new StrategyEngine({
      entryThreshold: 0.60,
      hedgeDropPoints: 0.15,
    }),
    numSimulations
  );

  printStats(aggressiveStats, 'AGGRESSIVE CONFIG (60¢ entry, 15pt hedge)');

  // Summary comparison
  console.log('\n📋 COMPARISON SUMMARY');
  console.log('━'.repeat(70));
  console.log('Config              | Entry Rate | Win Rate | Avg P&L | Sharpe');
  console.log('━'.repeat(70));
  console.log(`Default (65¢)       | ${defaultStats.entryRate.toFixed(1).padStart(9)}% | ${defaultStats.winRate.toFixed(1).padStart(7)}% | $${defaultStats.avgPnL.toFixed(2).padStart(6)} | ${defaultStats.sharpe.toFixed(2)}`);
  console.log(`Conservative (70¢)  | ${conservativeStats.entryRate.toFixed(1).padStart(9)}% | ${conservativeStats.winRate.toFixed(1).padStart(7)}% | $${conservativeStats.avgPnL.toFixed(2).padStart(6)} | ${conservativeStats.sharpe.toFixed(2)}`);
  console.log(`Aggressive (60¢)    | ${aggressiveStats.entryRate.toFixed(1).padStart(9)}% | ${aggressiveStats.winRate.toFixed(1).padStart(7)}% | $${aggressiveStats.avgPnL.toFixed(2).padStart(6)} | ${aggressiveStats.sharpe.toFixed(2)}`);
  console.log('━'.repeat(70));
}

main().catch(console.error);
