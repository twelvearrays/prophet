/**
 * Frank-Wolfe Algorithm Implementation for Combinatorial Arbitrage
 *
 * Based on: Kroer et al. 2016 (arXiv:1606.02825)
 * Implementation follows: Saguillo et al. 2025 (arXiv:2508.03474)
 *
 * Key algorithms:
 * - InitFW (Algorithm 3): Initialize vertex set and interior point
 * - Barrier Frank-Wolfe: Optimize with adaptive contraction
 */

import {
  Vertex,
  MarginalPoint,
  Constraint,
  ConstraintGraph,
  PartialOutcome,
  InitFWResult,
  BarrierFWResult,
  ArbitrageConfig,
  DEFAULT_ARBITRAGE_CONFIG,
  SolverStatus,
  createPartialOutcome,
} from './types';
import { SolverBackend } from './solver';

// ============================================================================
// MATHEMATICAL UTILITIES
// ============================================================================

/**
 * Log-sum-exp (numerically stable)
 */
function logSumExp(x: number[]): number {
  if (x.length === 0) return -Infinity;
  const max = Math.max(...x);
  if (!isFinite(max)) return max;
  return max + Math.log(x.reduce((sum, xi) => sum + Math.exp(xi - max), 0));
}

/**
 * Softmax function (numerically stable)
 */
function softmax(x: number[]): number[] {
  const max = Math.max(...x);
  const exps = x.map((xi) => Math.exp(xi - max));
  const sum = exps.reduce((s, e) => s + e, 0);
  return exps.map((e) => e / sum);
}

/**
 * Compute LMSR cost function: C(theta) = b * log(sum(exp(theta_i / b)))
 */
function lmsrCost(theta: number[], b: number): number {
  const scaled = theta.map((t) => t / b);
  return b * logSumExp(scaled);
}

/**
 * Compute LMSR gradient: nabla C(theta) = softmax(theta / b)
 */
function lmsrGradient(theta: number[], b: number): number[] {
  const scaled = theta.map((t) => t / b);
  return softmax(scaled);
}

/**
 * Compute Bregman divergence: D_C(mu || theta) = C*(mu) - C*(theta) - <nabla C*(theta), mu - theta>
 * For LMSR: D(mu || theta) = sum(mu_i * log(mu_i / p_i)) where p_i = softmax(theta/b)
 */
function bregmanDivergence(mu: number[], theta: number[], b: number): number {
  const p = lmsrGradient(theta, b);
  let divergence = 0;
  for (let i = 0; i < mu.length; i++) {
    if (mu[i] > 1e-10) {
      divergence += mu[i] * Math.log(mu[i] / Math.max(p[i], 1e-10));
    }
  }
  return divergence;
}

/**
 * Dot product
 */
function dot(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Vector subtraction
 */
function subtract(a: number[], b: number[]): number[] {
  return a.map((ai, i) => ai - (b[i] || 0));
}

/**
 * Vector addition
 */
function add(a: number[], b: number[]): number[] {
  return a.map((ai, i) => ai + (b[i] || 0));
}

/**
 * Scalar multiplication
 */
function scale(a: number[], s: number): number[] {
  return a.map((ai) => ai * s);
}

/**
 * L2 norm
 */
function norm(a: number[]): number {
  return Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
}

/**
 * Convex combination: (1 - alpha) * a + alpha * b
 */
function convexCombination(a: number[], b: number[], alpha: number): number[] {
  return a.map((ai, i) => (1 - alpha) * ai + alpha * (b[i] || 0));
}

// ============================================================================
// INIT-FW ALGORITHM (Algorithm 3)
// ============================================================================

/**
 * InitFW: Initialize vertex set and interior point for Barrier Frank-Wolfe
 *
 * This implements Algorithm 3 from Kroer et al. 2016:
 * 1. For each dimension i, try to find vertices with x[i] = 0 and x[i] = 1
 * 2. Build vertex set Z_0 from discovered vertices
 * 3. Compute interior point u as average of vertices
 * 4. Track settled securities (those forced to 0 or 1)
 */
export class InitFW {
  private solver: SolverBackend;

  constructor(solver: SolverBackend) {
    this.solver = solver;
  }

  /**
   * Run InitFW algorithm
   */
  initialize(
    dimension: number,
    constraintGraph: ConstraintGraph,
    partialOutcome?: PartialOutcome
  ): InitFWResult {
    const startTime = Date.now();
    const vertices: Vertex[] = [];
    const sigmaHat = partialOutcome || createPartialOutcome();

    // For each dimension, try to find vertices with x[i] = 0 and x[i] = 1
    for (let i = 0; i < dimension; i++) {
      // Skip if already settled
      if (sigmaHat.isSettled(i)) {
        continue;
      }

      // Try x[i] = 0
      const result0 = this.solver.findVertexWithFixedCoordinate(
        dimension,
        constraintGraph.constraints,
        i,
        0
      );

      // Try x[i] = 1
      const result1 = this.solver.findVertexWithFixedCoordinate(
        dimension,
        constraintGraph.constraints,
        i,
        1
      );

      // Check if security is forced to a specific value
      if (result0.status === SolverStatus.INFEASIBLE && result1.status !== SolverStatus.INFEASIBLE) {
        // Security must be 1
        sigmaHat.settle(i, 1);
      } else if (result1.status === SolverStatus.INFEASIBLE && result0.status !== SolverStatus.INFEASIBLE) {
        // Security must be 0
        sigmaHat.settle(i, 0);
      }

      // Add valid vertices to set (deduplicated)
      if (result0.status === SolverStatus.FEASIBLE && result0.solution) {
        this.addVertexIfNew(vertices, result0.solution);
      }
      if (result1.status === SolverStatus.FEASIBLE && result1.solution) {
        this.addVertexIfNew(vertices, result1.solution);
      }
    }

    // Ensure we have at least one vertex
    if (vertices.length === 0) {
      // Try to find any feasible vertex
      const result = this.solver.findFeasibleBinaryVector(dimension, constraintGraph.constraints);
      if (result.status === SolverStatus.FEASIBLE && result.solution) {
        vertices.push(result.solution);
      }
    }

    // Compute interior point as average of vertices
    let interiorPoint: MarginalPoint;
    if (vertices.length > 0) {
      interiorPoint = new Array(dimension).fill(0);
      for (const vertex of vertices) {
        for (let i = 0; i < dimension; i++) {
          interiorPoint[i] += vertex[i] / vertices.length;
        }
      }
    } else {
      // Fallback: use uniform distribution clamped to [0.1, 0.9]
      interiorPoint = new Array(dimension).fill(0.5);
    }

    // Get unsettled indices
    const unsettledIndices = sigmaHat.getUnsettledIndices(dimension);

    return {
      vertices,
      numVertices: vertices.length,
      interiorPoint,
      sigmaHat,
      unsettledIndices,
      computeTime: (Date.now() - startTime) / 1000,
    };
  }

  private addVertexIfNew(vertices: Vertex[], candidate: number[]): void {
    // Round to binary
    const vertex = candidate.map((v) => (v > 0.5 ? 1 : 0));

    // Check for duplicates
    const isDuplicate = vertices.some((v) =>
      v.every((vi, i) => vi === vertex[i])
    );

    if (!isDuplicate) {
      vertices.push(vertex);
    }
  }
}

// ============================================================================
// BARRIER FRANK-WOLFE ALGORITHM
// ============================================================================

/**
 * Barrier Frank-Wolfe with adaptive contraction
 *
 * Optimizes: min_mu D(mu || theta) s.t. mu in conv(Z)
 *
 * Uses barrier to stay in interior and handles gradient explosion
 * near boundary of marginal polytope.
 */
export class BarrierFrankWolfe {
  private solver: SolverBackend;
  private config: ArbitrageConfig;

  constructor(solver: SolverBackend, config?: Partial<ArbitrageConfig>) {
    this.solver = solver;
    this.config = { ...DEFAULT_ARBITRAGE_CONFIG, ...config };
  }

  /**
   * Run Barrier Frank-Wolfe optimization
   */
  optimize(
    theta: number[],
    initResult: InitFWResult,
    constraintGraph: ConstraintGraph,
    liquidityParam?: number
  ): BarrierFWResult {
    const startTime = Date.now();
    const b = liquidityParam || this.config.liquidityParam;
    const dimension = theta.length;

    // Initialize mu at interior point
    let mu = [...initResult.interiorPoint];
    let vertices = [...initResult.vertices];

    // Ensure mu is strictly interior (for log-barrier)
    mu = mu.map((m) => Math.max(0.01, Math.min(0.99, m)));

    let converged = false;
    let iteration = 0;
    let finalGap = Infinity;
    let finalDivergence = Infinity;

    // Frank-Wolfe iterations
    while (iteration < this.config.maxIterations) {
      // Compute gradient: nabla_mu D(mu || theta) = log(mu) - log(p) + 1
      // where p = softmax(theta/b)
      const p = lmsrGradient(theta, b);
      const gradient = mu.map((mi, i) => {
        const safeM = Math.max(mi, 1e-10);
        const safeP = Math.max(p[i], 1e-10);
        return Math.log(safeM) - Math.log(safeP);
      });

      // Linear minimization oracle: find vertex minimizing <gradient, v>
      const lmoResult = this.linearMinimizationOracle(
        gradient,
        vertices,
        dimension,
        constraintGraph.constraints
      );

      if (!lmoResult.vertex) {
        break;
      }

      const v = lmoResult.vertex;

      // Compute Frank-Wolfe gap
      const direction = subtract(v, mu);
      const gap = -dot(gradient, direction);
      finalGap = gap;

      // Check convergence
      if (gap < this.config.tolerance) {
        converged = true;
        break;
      }

      // Add vertex to active set if new
      this.addVertexIfNew(vertices, v);

      // Line search with barrier (prevent leaving interior)
      const stepSize = this.lineSearchWithBarrier(mu, v, theta, b);

      // Update mu
      mu = convexCombination(mu, v, stepSize);

      // Ensure mu stays in interior
      mu = mu.map((m) => Math.max(0.01, Math.min(0.99, m)));

      // Check alpha-extraction stopping criterion
      finalDivergence = bregmanDivergence(mu, theta, b);
      if (gap / finalDivergence < (1 - this.config.alpha)) {
        // We've captured alpha fraction of the arbitrage
        converged = true;
        break;
      }

      iteration++;
    }

    // Final divergence computation
    finalDivergence = bregmanDivergence(mu, theta, b);

    return {
      muOptimal: mu,
      finalGap,
      finalDivergence,
      iterations: iteration,
      vertices,
      converged,
      computeTime: (Date.now() - startTime) / 1000,
    };
  }

  private linearMinimizationOracle(
    gradient: number[],
    vertices: Vertex[],
    dimension: number,
    constraints: Constraint[]
  ): { vertex: Vertex | null; objectiveValue: number } {
    // First, check existing vertices
    let bestVertex: Vertex | null = null;
    let bestValue = Infinity;

    for (const v of vertices) {
      const value = dot(gradient, v);
      if (value < bestValue) {
        bestValue = value;
        bestVertex = v;
      }
    }

    // Try to find a better vertex via IP
    const result = this.solver.minimizeLinear(gradient, constraints, {
      lb: new Array(dimension).fill(0),
      ub: new Array(dimension).fill(1),
    });

    if (result.status === SolverStatus.OPTIMAL && result.solution) {
      // Round to binary
      const binaryVertex = result.solution.map((v) => (v > 0.5 ? 1 : 0));
      const value = dot(gradient, binaryVertex);

      if (value < bestValue) {
        bestValue = value;
        bestVertex = binaryVertex;
      }
    }

    return { vertex: bestVertex, objectiveValue: bestValue };
  }

  private lineSearchWithBarrier(
    mu: MarginalPoint,
    v: Vertex,
    theta: number[],
    b: number
  ): number {
    // Golden section search for optimal step size
    const phi = (1 + Math.sqrt(5)) / 2;
    let a = 0;
    let d = 1;
    let c = d - (d - a) / phi;
    let e = a + (d - a) / phi;

    const objective = (alpha: number): number => {
      const muNew = convexCombination(mu, v, alpha);
      // Add barrier to prevent leaving interior
      for (const m of muNew) {
        if (m <= 0 || m >= 1) {
          return Infinity;
        }
      }
      return bregmanDivergence(muNew, theta, b);
    };

    let fc = objective(c);
    let fe = objective(e);

    const maxIter = 50;
    const tol = 1e-6;

    for (let i = 0; i < maxIter && d - a > tol; i++) {
      if (fc < fe) {
        d = e;
        e = c;
        fe = fc;
        c = d - (d - a) / phi;
        fc = objective(c);
      } else {
        a = c;
        c = e;
        fc = fe;
        e = a + (d - a) / phi;
        fe = objective(e);
      }
    }

    // Return midpoint, but cap at 0.5 for stability
    return Math.min((a + d) / 2, 0.5);
  }

  private addVertexIfNew(vertices: Vertex[], candidate: number[]): void {
    const vertex = candidate.map((v) => (v > 0.5 ? 1 : 0));
    const isDuplicate = vertices.some((v) => v.every((vi, i) => vi === vertex[i]));
    if (!isDuplicate) {
      vertices.push(vertex);
    }
  }
}

// ============================================================================
// PROFIT CALCULATOR
// ============================================================================

/**
 * Calculate profit guarantees and make trade decisions
 */
export class ProfitCalculator {
  private config: ArbitrageConfig;

  constructor(config?: Partial<ArbitrageConfig>) {
    this.config = { ...DEFAULT_ARBITRAGE_CONFIG, ...config };
  }

  /**
   * Compute guaranteed profit lower bound
   * Proposition 4.1: Profit >= D(mu_hat || theta) - g(mu_hat)
   */
  computeGuaranteedProfit(divergence: number, gap: number): number {
    return Math.max(0, divergence - gap);
  }

  /**
   * Check if we've extracted alpha fraction of arbitrage
   */
  checkAlphaExtraction(divergence: number, gap: number): boolean {
    if (divergence <= 0) return true;
    return gap / divergence <= (1 - this.config.alpha);
  }

  /**
   * Check if market is near arbitrage-free
   */
  checkNearArbFree(divergence: number): boolean {
    return divergence < this.config.minDivergence;
  }

  /**
   * Make final trade decision
   */
  shouldTrade(
    divergence: number,
    gap: number,
    executionCost: number
  ): { shouldTrade: boolean; reason: string } {
    // Check if near arbitrage-free
    if (this.checkNearArbFree(divergence)) {
      return {
        shouldTrade: false,
        reason: `Near arbitrage-free: divergence ${(divergence * 100).toFixed(2)}% < threshold ${(this.config.minDivergence * 100).toFixed(2)}%`,
      };
    }

    // Check alpha extraction
    if (!this.checkAlphaExtraction(divergence, gap)) {
      return {
        shouldTrade: false,
        reason: `Alpha threshold not met: gap/divergence = ${((gap / divergence) * 100).toFixed(2)}% > ${((1 - this.config.alpha) * 100).toFixed(2)}%`,
      };
    }

    // Check profit after costs
    const guaranteedProfit = this.computeGuaranteedProfit(divergence, gap);
    const profitAfterCosts = guaranteedProfit - executionCost;

    if (profitAfterCosts < this.config.minProfitAfterCosts) {
      return {
        shouldTrade: false,
        reason: `Insufficient profit after costs: ${(profitAfterCosts * 100).toFixed(2)}% < ${(this.config.minProfitAfterCosts * 100).toFixed(2)}%`,
      };
    }

    return {
      shouldTrade: true,
      reason: `Trade approved: guaranteed profit ${(guaranteedProfit * 100).toFixed(2)}%, after costs ${(profitAfterCosts * 100).toFixed(2)}%`,
    };
  }
}

// ============================================================================
// LMSR UTILITIES
// ============================================================================

/**
 * Convert prices to LMSR theta (log-odds)
 */
export function pricesToTheta(prices: number[], b: number = 100): number[] {
  // For LMSR: p_i = exp(theta_i / b) / sum(exp(theta_j / b))
  // So theta_i = b * log(p_i) + constant
  // We can use theta_i = b * log(p_i) since the constant cancels in softmax
  return prices.map((p) => b * Math.log(Math.max(p, 1e-10)));
}

/**
 * Convert LMSR theta to prices
 */
export function thetaToPrices(theta: number[], b: number = 100): number[] {
  return lmsrGradient(theta, b);
}

/**
 * Compute sum of prices (should be 1 for arbitrage-free)
 */
export function computePriceSum(prices: number[]): number {
  return prices.reduce((sum, p) => sum + p, 0);
}

/**
 * Compute mispricing as deviation from arbitrage-free
 */
export function computeMispricing(prices: number[]): number {
  return Math.abs(computePriceSum(prices) - 1);
}
