# Polymarket 15-Minute Crypto Strategy

A TypeScript implementation of a momentum-based trading strategy for Polymarket's 15-minute crypto prediction markets.

## Strategy Overview

The strategy waits for price conviction (price crosses a threshold like 65¢), then scales into a position. If the market reverses, it hedges by buying the opposite side to lock in a small loss instead of a full loss.

**Core Principle**: "I'd rather not lose than win, because wins will come"

### Entry Rules
- Wait for YES price ≥ 65¢ (or NO price ≥ 65¢)
- Scale in: 50% at entry, 30% at 73¢, 20% at 80¢

### Hedge Rules
- If price drops 12 points from entry, buy opposite side
- This locks in a small loss (~12¢/share) instead of full loss (~65¢/share)

### Late Game
- In final 3 minutes, require 85¢+ to enter
- More certainty needed when less time to recover

## Installation

```bash
npm install
```

## Usage

### 1. Run Simulations (Test Strategy)

```bash
npm run simulate
```

This runs 1000 Monte Carlo simulations with different configurations to validate the strategy.

### 2. Test API Connection

```bash
npx ts-node src/test-api.ts
```

Tests connectivity to Polymarket's API.

### 3. Run Paper Trading

```bash
npm run live
```

Connects to Polymarket, finds active 15-min crypto markets, and paper trades using the strategy.

### 4. Run Monitoring Dashboard

```bash
cd dashboard
npm install
npm run dev
```

Opens a React dashboard at http://localhost:5173 showing:
- Real-time price charts with entry/threshold lines
- Position cards for BTC, ETH, SOL markets
- P&L tracking and session state visualization
- Activity feed of all strategy actions

The dashboard runs a simulation by default. To connect to live Polymarket data, integrate the `PolymarketClient` from the parent project.

## Project Structure

```
src/
├── types/
│   └── index.ts           # TypeScript interfaces
├── core/
│   ├── StrategyEngine.ts  # Core strategy logic
│   └── Simulator.ts       # Monte Carlo simulator
├── api/
│   └── PolymarketClient.ts # Polymarket API client
├── utils/
│   └── helpers.ts         # Utility functions
├── index.ts               # Main exports
├── simulate.ts            # Simulation runner
├── live.ts                # Live trading runner
└── test-api.ts            # API test

dashboard/
├── src/
│   ├── components/
│   │   ├── ui/            # shadcn-style primitives
│   │   └── dashboard/     # Trading UI components
│   ├── hooks/
│   │   └── useSimulation.ts  # Simulated price stream
│   └── App.tsx            # Main dashboard
└── package.json
```

## Configuration

### Strategy Parameters

```typescript
const config = {
  positionSize: 30,           // Total $ to deploy per market
  entryThreshold: 0.65,       // Enter when price ≥ 65¢
  scale2Threshold: 0.73,      // Scale at 73¢
  scale3Threshold: 0.80,      // Scale at 80¢
  hedgeDropPoints: 0.12,      // Hedge if price drops 12 points
  allowReentry: false,        // Re-enter after hedge? (risky)
};
```

### Market Simulation Parameters

```typescript
const simConfig = {
  volatility: 0.03,           // Price volatility per tick
  momentumFactor: 0.55,       // Trend continuation strength
  meanReversionFactor: 0.025, // Pull toward 50¢
  driftStrength: 0.008,       // Drift toward extremes
};
```

## API Reference

### StrategyEngine

```typescript
import { StrategyEngine } from './core/StrategyEngine';

const engine = new StrategyEngine({ entryThreshold: 0.65 });

// Start a session
engine.startSession('market-id', 'Market Name', endTimestamp);

// Process price updates
const evaluation = engine.onPriceTick({
  timestamp: Date.now(),
  yesPrice: 0.67,
  noPrice: 0.33,
  yesLiquidity: 100,
  noLiquidity: 100,
});

// Execute if action needed
if (evaluation.action.type !== 'NONE') {
  engine.executeAction(evaluation.action, actualPrice);
}

// Resolve when market ends
const summary = engine.resolve('YES'); // or 'NO'
```

### PolymarketClient

```typescript
import { PolymarketClient } from './api/PolymarketClient';

const client = new PolymarketClient();

// Find crypto markets
const markets = await client.getCryptoMarkets();

// Get current price
const tick = await client.getPriceTick(yesTokenId, noTokenId);

// Poll prices
const stop = client.startPolling(yesTokenId, noTokenId, (tick) => {
  console.log(`YES: ${tick.yesPrice}`);
}, 1000);

// Stop polling
stop();
```

## Breakeven Math

| Entry Price | Win Payout | Loss Cost | Breakeven Win Rate |
|-------------|------------|-----------|-------------------|
| 60¢ | +40¢ | -60¢ | 60% |
| 65¢ | +35¢ | -65¢ | 65% |
| 70¢ | +30¢ | -70¢ | 70% |
| 75¢ | +25¢ | -75¢ | 75% |

With hedging, losses are capped at the hedge drop (e.g., 12¢) instead of the full entry price.

## References

- [Polymarket CLOB API](https://docs.polymarket.com/developers/CLOB/introduction)
- [Polymarket Gamma API](https://docs.polymarket.com/developers/gamma-markets-api/overview)
- [Polymarket WebSocket](https://docs.polymarket.com/developers/CLOB/websocket/wss-overview)

## Disclaimer

This is for educational purposes only. Trading prediction markets involves risk. Only trade with money you can afford to lose.
