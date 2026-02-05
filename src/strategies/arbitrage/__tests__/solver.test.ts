/**
 * Tests for the IP/LP Solver
 */

import {
  BranchAndBoundSolver,
  createSolver,
} from '../solver';
import {
  Constraint,
  SolverStatus,
  createConstraintGraph,
} from '../types';

describe('BranchAndBoundSolver', () => {
  let solver: BranchAndBoundSolver;

  beforeEach(() => {
    solver = new BranchAndBoundSolver(5);
  });

  describe('findFeasibleBinaryVector', () => {
    it('should find feasible solution for simple constraint', () => {
      // x0 + x1 = 1 (exactly one must be true)
      const constraints: Constraint[] = [
        { coefficients: [1, 1], operator: '==', rhs: 1 },
      ];

      const result = solver.findFeasibleBinaryVector(2, constraints);

      expect(result.status).toBe(SolverStatus.FEASIBLE);
      expect(result.solution).toBeDefined();
      expect(result.solution![0] + result.solution![1]).toBe(1);
    });

    it('should detect infeasible problem', () => {
      // x0 = 1 AND x0 = 0 (contradiction)
      const constraints: Constraint[] = [
        { coefficients: [1], operator: '==', rhs: 1 },
        { coefficients: [1], operator: '==', rhs: 0 },
      ];

      const result = solver.findFeasibleBinaryVector(1, constraints);

      expect(result.status).toBe(SolverStatus.INFEASIBLE);
    });

    it('should respect fixed values', () => {
      const constraints: Constraint[] = [
        { coefficients: [1, 1, 1], operator: '==', rhs: 1 },
      ];

      const fixedValues = new Map<number, number>([[0, 1]]);
      const result = solver.findFeasibleBinaryVector(3, constraints, fixedValues);

      expect(result.status).toBe(SolverStatus.FEASIBLE);
      expect(result.solution).toBeDefined();
      expect(result.solution![0]).toBe(1);
      expect(result.solution![1]).toBe(0);
      expect(result.solution![2]).toBe(0);
    });

    it('should handle multi-outcome market constraints', () => {
      // 3-outcome market: exactly one outcome
      const constraints: Constraint[] = [
        { coefficients: [1, 1, 1], operator: '==', rhs: 1 },
      ];

      const result = solver.findFeasibleBinaryVector(3, constraints);

      expect(result.status).toBe(SolverStatus.FEASIBLE);
      expect(result.solution).toBeDefined();
      const sum = result.solution!.reduce((a, b) => a + b, 0);
      expect(sum).toBe(1);
    });

    it('should handle implication constraints', () => {
      // x0 <= x1 (if x0=1 then x1=1)
      // x0 + x1 <= 2 (at most both)
      const constraints: Constraint[] = [
        { coefficients: [1, -1], operator: '<=', rhs: 0 },
      ];

      const fixedValues = new Map<number, number>([[0, 1]]);
      const result = solver.findFeasibleBinaryVector(2, constraints, fixedValues);

      expect(result.status).toBe(SolverStatus.FEASIBLE);
      expect(result.solution).toBeDefined();
      expect(result.solution![0]).toBe(1);
      expect(result.solution![1]).toBe(1); // Must be 1 due to implication
    });
  });

  describe('checkFeasibility', () => {
    it('should return true for feasible problem', () => {
      const constraints: Constraint[] = [
        { coefficients: [1, 1], operator: '==', rhs: 1 },
      ];

      const result = solver.checkFeasibility(2, constraints);
      expect(result).toBe(true);
    });

    it('should return false for infeasible problem', () => {
      const constraints: Constraint[] = [
        { coefficients: [1], operator: '>=', rhs: 2 }, // x0 >= 2 impossible for binary
      ];

      const result = solver.checkFeasibility(1, constraints);
      expect(result).toBe(false);
    });
  });

  describe('findVertexWithFixedCoordinate', () => {
    it('should find vertex with x[0] = 1', () => {
      const constraints: Constraint[] = [
        { coefficients: [1, 1], operator: '==', rhs: 1 },
      ];

      const result = solver.findVertexWithFixedCoordinate(2, constraints, 0, 1);

      expect(result.status).toBe(SolverStatus.FEASIBLE);
      expect(result.solution![0]).toBe(1);
      expect(result.solution![1]).toBe(0);
    });

    it('should find vertex with x[1] = 1', () => {
      const constraints: Constraint[] = [
        { coefficients: [1, 1], operator: '==', rhs: 1 },
      ];

      const result = solver.findVertexWithFixedCoordinate(2, constraints, 1, 1);

      expect(result.status).toBe(SolverStatus.FEASIBLE);
      expect(result.solution![0]).toBe(0);
      expect(result.solution![1]).toBe(1);
    });
  });

  describe('minimizeLinear', () => {
    it('should minimize simple objective', () => {
      // min x0 + x1 subject to x0 + x1 >= 0.5
      const objective = [1, 1];
      const constraints: Constraint[] = [
        { coefficients: [1, 1], operator: '>=', rhs: 0.5 },
      ];

      const result = solver.minimizeLinear(objective, constraints);

      expect(result.status).toBe(SolverStatus.OPTIMAL);
      expect(result.solution).toBeDefined();
      // Minimum should be at lower bound
    });
  });
});

describe('createSolver', () => {
  it('should create a working solver', () => {
    const solver = createSolver(5);
    expect(solver.name).toBe('BranchAndBound');
    expect(solver.isAvailable).toBe(true);
  });
});
