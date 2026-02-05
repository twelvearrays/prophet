/**
 * Integer Programming Solver for Frank-Wolfe Arbitrage
 *
 * Pure TypeScript implementation using branch-and-bound for binary IP.
 * For production, consider integrating with GLPK.js or a WebAssembly solver.
 */

import {
  Constraint,
  ConstraintOperator,
  SolverResult,
  SolverStatus,
  Vertex,
} from './types';

// ============================================================================
// SOLVER INTERFACE
// ============================================================================

/**
 * Abstract solver backend interface
 */
export interface SolverBackend {
  /** Solver name */
  readonly name: string;

  /** Check if solver is available */
  readonly isAvailable: boolean;

  /**
   * Find a binary vector satisfying all constraints
   */
  findFeasibleBinaryVector(
    dimension: number,
    constraints: Constraint[],
    fixedValues?: Map<number, number>
  ): SolverResult;

  /**
   * Minimize linear objective over polytope (continuous LP)
   */
  minimizeLinear(
    objective: number[],
    constraints: Constraint[],
    bounds?: { lb: number[]; ub: number[] }
  ): SolverResult;

  /**
   * Quick feasibility check
   */
  checkFeasibility(dimension: number, constraints: Constraint[]): boolean;

  /**
   * Find vertex with specific coordinate fixed
   */
  findVertexWithFixedCoordinate(
    dimension: number,
    constraints: Constraint[],
    index: number,
    value: number
  ): SolverResult;
}

// ============================================================================
// BRANCH AND BOUND SOLVER (Pure TypeScript)
// ============================================================================

/**
 * Simple branch-and-bound solver for binary integer programs.
 * Suitable for small to medium problems (< 50 variables).
 */
export class BranchAndBoundSolver implements SolverBackend {
  private timeout: number;
  private startTime: number = 0;

  constructor(timeoutSeconds: number = 10) {
    this.timeout = timeoutSeconds * 1000;
  }

  get name(): string {
    return 'BranchAndBound';
  }

  get isAvailable(): boolean {
    return true;
  }

  findFeasibleBinaryVector(
    dimension: number,
    constraints: Constraint[],
    fixedValues?: Map<number, number>
  ): SolverResult {
    this.startTime = Date.now();

    // Convert fixed values to partial assignment
    const assignment: (number | null)[] = new Array(dimension).fill(null);
    if (fixedValues) {
      for (const [idx, val] of fixedValues) {
        if (idx >= 0 && idx < dimension) {
          assignment[idx] = val;
        }
      }
    }

    // Try to find feasible solution using DFS
    const solution = this.searchFeasible(assignment, constraints);

    const solveTime = (Date.now() - this.startTime) / 1000;

    if (solution) {
      return {
        status: SolverStatus.FEASIBLE,
        solution,
        solveTime,
      };
    }

    if (Date.now() - this.startTime > this.timeout) {
      return { status: SolverStatus.TIMEOUT, solveTime };
    }

    return { status: SolverStatus.INFEASIBLE, solveTime };
  }

  private searchFeasible(
    assignment: (number | null)[],
    constraints: Constraint[]
  ): number[] | null {
    // Check timeout
    if (Date.now() - this.startTime > this.timeout) {
      return null;
    }

    // Find first unassigned variable
    const unassignedIdx = assignment.findIndex((v) => v === null);

    // If all assigned, check constraints
    if (unassignedIdx === -1) {
      const solution = assignment as number[];
      if (this.satisfiesConstraints(solution, constraints)) {
        return [...solution];
      }
      return null;
    }

    // Early pruning: check if partial assignment can possibly satisfy constraints
    if (!this.canPossiblySatisfy(assignment, constraints)) {
      return null;
    }

    // Try both values (use heuristic: try 0 first for feasibility problems)
    for (const value of [0, 1]) {
      assignment[unassignedIdx] = value;
      const result = this.searchFeasible(assignment, constraints);
      if (result) {
        return result;
      }
      assignment[unassignedIdx] = null;
    }

    return null;
  }

  private satisfiesConstraints(solution: number[], constraints: Constraint[]): boolean {
    for (const constraint of constraints) {
      const lhs = this.computeLHS(solution, constraint.coefficients);
      if (!this.checkOperator(lhs, constraint.operator, constraint.rhs)) {
        return false;
      }
    }
    return true;
  }

  private canPossiblySatisfy(
    assignment: (number | null)[],
    constraints: Constraint[]
  ): boolean {
    // For each constraint, compute min/max possible LHS values
    for (const constraint of constraints) {
      let minLHS = 0;
      let maxLHS = 0;

      for (let i = 0; i < assignment.length; i++) {
        const coef = constraint.coefficients[i] || 0;
        if (assignment[i] !== null) {
          minLHS += coef * assignment[i]!;
          maxLHS += coef * assignment[i]!;
        } else {
          // Variable is free: add min/max possible contribution
          if (coef > 0) {
            // coef * 0 = 0, coef * 1 = coef
            maxLHS += coef;
          } else {
            // coef * 0 = 0, coef * 1 = coef (negative)
            minLHS += coef;
          }
        }
      }

      // Check if constraint can possibly be satisfied
      switch (constraint.operator) {
        case '<=':
          if (minLHS > constraint.rhs) return false;
          break;
        case '>=':
          if (maxLHS < constraint.rhs) return false;
          break;
        case '==':
          if (minLHS > constraint.rhs || maxLHS < constraint.rhs) return false;
          break;
      }
    }

    return true;
  }

  private computeLHS(solution: number[], coefficients: number[]): number {
    let sum = 0;
    const len = Math.min(solution.length, coefficients.length);
    for (let i = 0; i < len; i++) {
      sum += coefficients[i] * solution[i];
    }
    return sum;
  }

  private checkOperator(lhs: number, op: ConstraintOperator, rhs: number): boolean {
    const epsilon = 1e-9;
    switch (op) {
      case '<=':
        return lhs <= rhs + epsilon;
      case '>=':
        return lhs >= rhs - epsilon;
      case '==':
        return Math.abs(lhs - rhs) < epsilon;
    }
  }

  minimizeLinear(
    objective: number[],
    constraints: Constraint[],
    bounds?: { lb: number[]; ub: number[] }
  ): SolverResult {
    this.startTime = Date.now();
    const dimension = objective.length;

    // Use simplex-like greedy approach for continuous LP
    // This is a simplified implementation - for production use a proper LP solver
    const solution = new Array(dimension).fill(0);

    // Default bounds
    const lb = bounds?.lb || new Array(dimension).fill(0);
    const ub = bounds?.ub || new Array(dimension).fill(1);

    // Greedy: set variables to bounds based on objective sign
    for (let i = 0; i < dimension; i++) {
      solution[i] = objective[i] >= 0 ? lb[i] : ub[i];
    }

    // Check feasibility and adjust if needed
    if (!this.satisfiesConstraints(solution, constraints)) {
      // Try to find a feasible solution via simple projection
      const adjusted = this.projectToFeasible(solution, constraints, lb, ub);
      if (adjusted) {
        solution.splice(0, solution.length, ...adjusted);
      } else {
        return {
          status: SolverStatus.INFEASIBLE,
          solveTime: (Date.now() - this.startTime) / 1000,
        };
      }
    }

    const objectiveValue = objective.reduce((sum, c, i) => sum + c * solution[i], 0);

    return {
      status: SolverStatus.OPTIMAL,
      solution,
      objective: objectiveValue,
      solveTime: (Date.now() - this.startTime) / 1000,
    };
  }

  private projectToFeasible(
    x: number[],
    constraints: Constraint[],
    lb: number[],
    ub: number[]
  ): number[] | null {
    // Simple iterative projection
    const solution = [...x];
    const maxIter = 1000;

    for (let iter = 0; iter < maxIter; iter++) {
      let satisfied = true;

      for (const constraint of constraints) {
        const lhs = this.computeLHS(solution, constraint.coefficients);
        let violation = 0;

        switch (constraint.operator) {
          case '<=':
            violation = lhs - constraint.rhs;
            break;
          case '>=':
            violation = constraint.rhs - lhs;
            break;
          case '==':
            violation = lhs - constraint.rhs;
            break;
        }

        if (violation > 1e-9) {
          satisfied = false;
          // Project: adjust variables proportionally
          const norm = constraint.coefficients.reduce((s, c) => s + c * c, 0);
          if (norm > 1e-9) {
            for (let i = 0; i < solution.length; i++) {
              const coef = constraint.coefficients[i] || 0;
              let adjustment: number;

              if (constraint.operator === '<=') {
                adjustment = -violation * coef / norm;
              } else if (constraint.operator === '>=') {
                adjustment = violation * coef / norm;
              } else {
                adjustment = -violation * coef / norm;
              }

              solution[i] = Math.max(lb[i], Math.min(ub[i], solution[i] + adjustment));
            }
          }
        }
      }

      if (satisfied) {
        return solution;
      }
    }

    return null;
  }

  checkFeasibility(dimension: number, constraints: Constraint[]): boolean {
    const result = this.findFeasibleBinaryVector(dimension, constraints);
    return result.status === SolverStatus.FEASIBLE;
  }

  findVertexWithFixedCoordinate(
    dimension: number,
    constraints: Constraint[],
    index: number,
    value: number
  ): SolverResult {
    const fixedValues = new Map<number, number>([[index, value]]);
    return this.findFeasibleBinaryVector(dimension, constraints, fixedValues);
  }
}

// ============================================================================
// SOLVER FACTORY
// ============================================================================

/**
 * Get the best available solver
 */
export function createSolver(timeoutSeconds: number = 10): SolverBackend {
  // For now, use the pure TypeScript solver
  // In production, could check for GLPK.js or WebAssembly solver availability
  return new BranchAndBoundSolver(timeoutSeconds);
}

/**
 * Create a solver with custom configuration
 */
export function createSolverWithConfig(config: {
  timeout?: number;
  preferredBackend?: 'bnb' | 'glpk';
}): SolverBackend {
  const timeout = config.timeout || 10;

  // Always use BnB for now (GLPK would require additional package)
  return new BranchAndBoundSolver(timeout);
}
