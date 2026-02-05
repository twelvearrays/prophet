/**
 * Types for Frank-Wolfe Combinatorial Arbitrage Strategy
 *
 * Based on: Kroer et al. 2016 (arXiv:1606.02825) - Arbitrage-Free Combinatorial Market Making
 * Implementation follows Saguillo et al. 2025 (arXiv:2508.03474)
 */

// ============================================================================
// CORE MATHEMATICAL TYPES
// ============================================================================

/**
 * Represents a vertex of the marginal polytope (binary outcome vector)
 * Each element is 0 or 1, representing whether that outcome occurs
 */
export type Vertex = number[];

/**
 * Represents a point in the marginal polytope (convex combination of vertices)
 * Each element is in [0, 1], representing probability of that outcome
 */
export type MarginalPoint = number[];

/**
 * Constraint operator types
 */
export type ConstraintOperator = '<=' | '>=' | '==';

/**
 * Linear constraint: coefficients · x {<=, >=, ==} rhs
 */
export interface Constraint {
  coefficients: number[];
  operator: ConstraintOperator;
  rhs: number;
}

/**
 * Status of solver result
 */
export enum SolverStatus {
  OPTIMAL = 'OPTIMAL',
  FEASIBLE = 'FEASIBLE',
  INFEASIBLE = 'INFEASIBLE',
  TIMEOUT = 'TIMEOUT',
  ERROR = 'ERROR',
}

/**
 * Result from solver
 */
export interface SolverResult {
  status: SolverStatus;
  solution?: number[];
  objective?: number;
  solveTime: number;
  iterations?: number;
}

// ============================================================================
// MARKET STRUCTURE TYPES
// ============================================================================

/**
 * Security status in a partial outcome
 */
export enum SecurityStatus {
  UNSETTLED = 'UNSETTLED',  // Not yet resolved
  SETTLED_YES = 'SETTLED_YES',  // Resolved to 1
  SETTLED_NO = 'SETTLED_NO',  // Resolved to 0
}

/**
 * Tracks partially settled outcomes during market resolution
 */
export interface PartialOutcome {
  values: Map<number, number>;  // index -> settled value (0 or 1)

  /** Check if a security is settled */
  isSettled(index: number): boolean;

  /** Get settled value (throws if not settled) */
  getValue(index: number): number;

  /** Settle a security */
  settle(index: number, value: 0 | 1): void;

  /** Get all unsettled indices */
  getUnsettledIndices(dimension: number): number[];
}

/**
 * Market state representation for LMSR
 */
export interface MarketState {
  /** Market maker theta (log-odds) parameters */
  theta: number[];

  /** Liquidity parameter (b in LMSR) */
  liquidityParam: number;

  /** Current prices (derived from theta) */
  prices: number[];
}

/**
 * Constraint graph representing market structure
 * Encodes logical relationships between securities
 */
export interface ConstraintGraph {
  /** Dimension of the outcome space */
  dimension: number;

  /** Linear constraints defining the marginal polytope */
  constraints: Constraint[];

  /** Add a constraint that exactly one of the given indices must be 1 */
  addExactlyOneConstraint(indices: number[]): void;

  /** Add implication constraint: if i=1 then j=1 */
  addImplicationConstraint(i: number, j: number): void;

  /** Add mutex constraint: at most one of indices can be 1 */
  addMutexConstraint(indices: number[]): void;
}

// ============================================================================
// ALGORITHM TYPES
// ============================================================================

/**
 * Result from InitFW algorithm (Algorithm 3 in paper)
 */
export interface InitFWResult {
  /** Initial vertex set Z_0 */
  vertices: Vertex[];

  /** Number of vertices found */
  numVertices: number;

  /** Interior point u for barrier method */
  interiorPoint: MarginalPoint;

  /** Partial outcome tracking settled securities */
  sigmaHat: PartialOutcome;

  /** Indices of unsettled securities */
  unsettledIndices: number[];

  /** Computation time */
  computeTime: number;
}

/**
 * Result from Barrier Frank-Wolfe optimization
 */
export interface BarrierFWResult {
  /** Optimal point in marginal polytope */
  muOptimal: MarginalPoint;

  /** Final Frank-Wolfe gap (convergence measure) */
  finalGap: number;

  /** Final Bregman divergence D(mu || theta) */
  finalDivergence: number;

  /** Number of iterations */
  iterations: number;

  /** Vertex set at termination */
  vertices: Vertex[];

  /** Whether algorithm converged */
  converged: boolean;

  /** Computation time */
  computeTime: number;
}

/**
 * Arbitrage opportunity detected
 */
export interface ArbitrageOpportunity {
  /** Market IDs involved */
  marketIds: string[];

  /** Optimal marginal point */
  muOptimal: MarginalPoint;

  /** Bregman divergence (measure of mispricing) */
  divergence: number;

  /** Frank-Wolfe gap at termination */
  gap: number;

  /** Guaranteed profit (lower bound) */
  guaranteedProfit: number;

  /** Recommended trades */
  trades: ArbitrageTrade[];

  /** Should we execute? */
  shouldTrade: boolean;

  /** Reason for decision */
  reason: string;
}

/**
 * Individual trade in arbitrage bundle
 */
export interface ArbitrageTrade {
  /** Market identifier */
  marketId: string;

  /** Token identifier */
  tokenId: string;

  /** Side: buy/sell */
  side: 'buy' | 'sell';

  /** Quantity */
  quantity: number;

  /** Expected price */
  price: number;
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

/**
 * Configuration for arbitrage strategy
 */
export interface ArbitrageConfig {
  /** Frank-Wolfe alpha (fraction of arbitrage to capture, default 0.9) */
  alpha: number;

  /** Minimum divergence to consider trading (default 0.025 = 2.5%) */
  minDivergence: number;

  /** Maximum iterations for Frank-Wolfe */
  maxIterations: number;

  /** Convergence tolerance for gap */
  tolerance: number;

  /** Solver timeout in seconds */
  solverTimeout: number;

  /** Minimum profit after costs to trade */
  minProfitAfterCosts: number;

  /** Estimated execution cost as fraction */
  executionCost: number;

  /** LMSR liquidity parameter (default 100) */
  liquidityParam: number;
}

/**
 * Default configuration
 */
export const DEFAULT_ARBITRAGE_CONFIG: ArbitrageConfig = {
  alpha: 0.9,
  minDivergence: 0.025,
  maxIterations: 100,
  tolerance: 1e-6,
  solverTimeout: 10,
  minProfitAfterCosts: 0.01,
  executionCost: 0.02,
  liquidityParam: 100,
};

// ============================================================================
// HELPER IMPLEMENTATIONS
// ============================================================================

/**
 * Create a new PartialOutcome tracker
 */
export function createPartialOutcome(): PartialOutcome {
  const values = new Map<number, number>();

  return {
    values,

    isSettled(index: number): boolean {
      return values.has(index);
    },

    getValue(index: number): number {
      const val = values.get(index);
      if (val === undefined) {
        throw new Error(`Security ${index} is not settled`);
      }
      return val;
    },

    settle(index: number, value: 0 | 1): void {
      values.set(index, value);
    },

    getUnsettledIndices(dimension: number): number[] {
      const unsettled: number[] = [];
      for (let i = 0; i < dimension; i++) {
        if (!values.has(i)) {
          unsettled.push(i);
        }
      }
      return unsettled;
    },
  };
}

/**
 * Create a new ConstraintGraph
 */
export function createConstraintGraph(dimension: number): ConstraintGraph {
  const constraints: Constraint[] = [];

  return {
    dimension,
    constraints,

    addExactlyOneConstraint(indices: number[]): void {
      // Sum of selected indices == 1
      const coefficients = new Array(dimension).fill(0);
      for (const idx of indices) {
        if (idx >= 0 && idx < dimension) {
          coefficients[idx] = 1;
        }
      }
      constraints.push({ coefficients, operator: '==', rhs: 1 });
    },

    addImplicationConstraint(i: number, j: number): void {
      // x[i] <= x[j] (if i=1 then j must be 1)
      const coefficients = new Array(dimension).fill(0);
      coefficients[i] = 1;
      coefficients[j] = -1;
      constraints.push({ coefficients, operator: '<=', rhs: 0 });
    },

    addMutexConstraint(indices: number[]): void {
      // Sum of selected indices <= 1
      const coefficients = new Array(dimension).fill(0);
      for (const idx of indices) {
        if (idx >= 0 && idx < dimension) {
          coefficients[idx] = 1;
        }
      }
      constraints.push({ coefficients, operator: '<=', rhs: 1 });
    },
  };
}
