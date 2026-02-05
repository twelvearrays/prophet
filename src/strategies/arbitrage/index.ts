/**
 * Frank-Wolfe Combinatorial Arbitrage Strategy
 *
 * Exports all components for arbitrage detection and execution.
 */

// Core types
export * from './types';

// Solver abstraction
export { SolverBackend, BranchAndBoundSolver, createSolver, createSolverWithConfig } from './solver';

// Algorithms
export {
  InitFW,
  BarrierFrankWolfe,
  ProfitCalculator,
  pricesToTheta,
  thetaToPrices,
  computeMispricing,
  computePriceSum,
} from './algorithms';

// Main strategy
export {
  ArbitrageStrategy,
  createArbitrageStrategy,
  MarketGroup,
  ArbitrageEvent,
} from './ArbitrageStrategy';
