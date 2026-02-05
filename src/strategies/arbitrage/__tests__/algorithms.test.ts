/**
 * Tests for Frank-Wolfe Algorithms
 */

import {
  InitFW,
  BarrierFrankWolfe,
  ProfitCalculator,
  pricesToTheta,
  thetaToPrices,
  computeMispricing,
  computePriceSum,
} from '../algorithms';
import { createSolver } from '../solver';
import {
  createConstraintGraph,
  createPartialOutcome,
  DEFAULT_ARBITRAGE_CONFIG,
} from '../types';

describe('Mathematical Utilities', () => {
  describe('pricesToTheta and thetaToPrices', () => {
    it('should be inverse operations (approximately)', () => {
      const prices = [0.4, 0.6];
      const b = 100;

      const theta = pricesToTheta(prices, b);
      const recovered = thetaToPrices(theta, b);

      expect(recovered[0]).toBeCloseTo(prices[0], 2);
      expect(recovered[1]).toBeCloseTo(prices[1], 2);
    });

    it('should handle edge prices', () => {
      const prices = [0.1, 0.9];
      const b = 100;

      const theta = pricesToTheta(prices, b);
      const recovered = thetaToPrices(theta, b);

      expect(recovered[0]).toBeCloseTo(prices[0], 1);
      expect(recovered[1]).toBeCloseTo(prices[1], 1);
    });
  });

  describe('computeMispricing', () => {
    it('should return 0 for arbitrage-free prices', () => {
      const prices = [0.4, 0.6];
      expect(computeMispricing(prices)).toBeCloseTo(0, 5);
    });

    it('should detect overpricing', () => {
      const prices = [0.55, 0.55]; // Sum = 1.10
      expect(computeMispricing(prices)).toBeCloseTo(0.1, 5);
    });

    it('should detect underpricing', () => {
      const prices = [0.45, 0.45]; // Sum = 0.90
      expect(computeMispricing(prices)).toBeCloseTo(0.1, 5);
    });
  });

  describe('computePriceSum', () => {
    it('should sum prices correctly', () => {
      expect(computePriceSum([0.3, 0.7])).toBeCloseTo(1.0, 5);
      expect(computePriceSum([0.4, 0.3, 0.3])).toBeCloseTo(1.0, 5);
    });
  });
});

describe('InitFW', () => {
  const solver = createSolver(5);
  const initFW = new InitFW(solver);

  describe('initialize', () => {
    it('should initialize for binary market', () => {
      const constraintGraph = createConstraintGraph(2);
      constraintGraph.addExactlyOneConstraint([0, 1]);

      const result = initFW.initialize(2, constraintGraph);

      expect(result.numVertices).toBeGreaterThan(0);
      expect(result.vertices.length).toBe(result.numVertices);
      expect(result.interiorPoint.length).toBe(2);

      // Interior point should be in (0, 1)
      for (const val of result.interiorPoint) {
        expect(val).toBeGreaterThan(0);
        expect(val).toBeLessThan(1);
      }
    });

    it('should find both vertices for binary market', () => {
      const constraintGraph = createConstraintGraph(2);
      constraintGraph.addExactlyOneConstraint([0, 1]);

      const result = initFW.initialize(2, constraintGraph);

      // Should have [1,0] and [0,1] vertices
      expect(result.numVertices).toBe(2);

      const hasVertex10 = result.vertices.some(
        (v) => v[0] === 1 && v[1] === 0
      );
      const hasVertex01 = result.vertices.some(
        (v) => v[0] === 0 && v[1] === 1
      );

      expect(hasVertex10).toBe(true);
      expect(hasVertex01).toBe(true);
    });

    it('should handle 3-outcome market', () => {
      const constraintGraph = createConstraintGraph(3);
      constraintGraph.addExactlyOneConstraint([0, 1, 2]);

      const result = initFW.initialize(3, constraintGraph);

      expect(result.numVertices).toBeGreaterThanOrEqual(3);
      expect(result.interiorPoint.length).toBe(3);
    });

    it('should handle partial outcomes', () => {
      const constraintGraph = createConstraintGraph(3);
      constraintGraph.addExactlyOneConstraint([0, 1, 2]);

      const partial = createPartialOutcome();
      partial.settle(0, 0); // First outcome settled to 0

      const result = initFW.initialize(3, constraintGraph, partial);

      expect(result.unsettledIndices).not.toContain(0);
      expect(result.sigmaHat.isSettled(0)).toBe(true);
      expect(result.sigmaHat.getValue(0)).toBe(0);
    });

    it('should handle implication constraints', () => {
      const constraintGraph = createConstraintGraph(4);
      // Two markets: [0,1] and [2,3]
      constraintGraph.addExactlyOneConstraint([0, 1]);
      constraintGraph.addExactlyOneConstraint([2, 3]);
      // Implication: if 2=1 then 0=1
      constraintGraph.addImplicationConstraint(2, 0);

      const result = initFW.initialize(4, constraintGraph);

      expect(result.numVertices).toBeGreaterThan(0);
    });
  });
});

describe('BarrierFrankWolfe', () => {
  const solver = createSolver(5);
  const config = { ...DEFAULT_ARBITRAGE_CONFIG, maxIterations: 50 };

  describe('optimize', () => {
    it('should optimize binary market with no arbitrage', () => {
      const constraintGraph = createConstraintGraph(2);
      constraintGraph.addExactlyOneConstraint([0, 1]);

      const initFW = new InitFW(solver);
      const initResult = initFW.initialize(2, constraintGraph);

      // Arbitrage-free prices (sum to 1)
      const prices = [0.6, 0.4];
      const theta = pricesToTheta(prices, 100);

      const bfw = new BarrierFrankWolfe(solver, config);
      const result = bfw.optimize(theta, initResult, constraintGraph, 100);

      expect(result.iterations).toBeGreaterThanOrEqual(0);
      expect(result.muOptimal.length).toBe(2);

      // Optimal mu should be close to prices for arb-free market
      expect(result.finalDivergence).toBeLessThan(0.1);
    });

    it('should detect arbitrage in mispriced market', () => {
      const constraintGraph = createConstraintGraph(2);
      constraintGraph.addExactlyOneConstraint([0, 1]);

      const initFW = new InitFW(solver);
      const initResult = initFW.initialize(2, constraintGraph);

      // Mispriced: sum = 1.08 (8% overpriced)
      const prices = [0.55, 0.53];
      const theta = pricesToTheta(prices, 100);

      const bfw = new BarrierFrankWolfe(solver, config);
      const result = bfw.optimize(theta, initResult, constraintGraph, 100);

      expect(result.iterations).toBeGreaterThan(0);
      expect(result.finalDivergence).toBeGreaterThan(0);
    });

    it('should converge for 3-outcome market', () => {
      const constraintGraph = createConstraintGraph(3);
      constraintGraph.addExactlyOneConstraint([0, 1, 2]);

      const initFW = new InitFW(solver);
      const initResult = initFW.initialize(3, constraintGraph);

      const prices = [0.4, 0.35, 0.33]; // Sum = 1.08
      const theta = pricesToTheta(prices, 100);

      const bfw = new BarrierFrankWolfe(solver, config);
      const result = bfw.optimize(theta, initResult, constraintGraph, 100);

      expect(result.muOptimal.length).toBe(3);
      expect(result.iterations).toBeGreaterThan(0);
    });
  });
});

describe('ProfitCalculator', () => {
  describe('computeGuaranteedProfit', () => {
    it('should compute profit lower bound', () => {
      const calc = new ProfitCalculator();

      // Divergence 5%, gap 0.5% = 4.5% guaranteed profit
      const profit = calc.computeGuaranteedProfit(0.05, 0.005);
      expect(profit).toBeCloseTo(0.045, 5);
    });

    it('should return 0 for negative profit', () => {
      const calc = new ProfitCalculator();

      // Gap > divergence
      const profit = calc.computeGuaranteedProfit(0.01, 0.02);
      expect(profit).toBe(0);
    });
  });

  describe('checkAlphaExtraction', () => {
    it('should return true when alpha fraction captured', () => {
      const calc = new ProfitCalculator({ alpha: 0.9 });

      // Gap = 5% of divergence (so 95% captured, > 90% threshold)
      const result = calc.checkAlphaExtraction(0.10, 0.005);
      expect(result).toBe(true);
    });

    it('should return false when alpha not captured', () => {
      const calc = new ProfitCalculator({ alpha: 0.9 });

      // Gap = 20% of divergence (only 80% captured)
      const result = calc.checkAlphaExtraction(0.10, 0.02);
      expect(result).toBe(false);
    });
  });

  describe('checkNearArbFree', () => {
    it('should return true for small divergence', () => {
      const calc = new ProfitCalculator({ minDivergence: 0.025 });

      expect(calc.checkNearArbFree(0.01)).toBe(true);
      expect(calc.checkNearArbFree(0.02)).toBe(true);
    });

    it('should return false for large divergence', () => {
      const calc = new ProfitCalculator({ minDivergence: 0.025 });

      expect(calc.checkNearArbFree(0.05)).toBe(false);
      expect(calc.checkNearArbFree(0.10)).toBe(false);
    });
  });

  describe('shouldTrade', () => {
    const calc = new ProfitCalculator({
      alpha: 0.9,
      minDivergence: 0.025,
      minProfitAfterCosts: 0.01,
    });

    it('should approve profitable trade', () => {
      // divergence=0.08, gap=0.004 (5% of divergence, well under 10% threshold)
      // profit = 0.08 - 0.004 = 0.076
      // profit after costs = 0.076 - 0.02 = 0.056 > 0.01
      const result = calc.shouldTrade(0.08, 0.004, 0.02);

      expect(result.shouldTrade).toBe(true);
      expect(result.reason.toLowerCase()).toContain('approved');
    });

    it('should reject near arb-free', () => {
      const result = calc.shouldTrade(0.02, 0.001, 0.01);

      expect(result.shouldTrade).toBe(false);
      expect(result.reason.toLowerCase()).toContain('arbitrage-free');
    });

    it('should reject when alpha not met', () => {
      const result = calc.shouldTrade(0.10, 0.05, 0.01);

      expect(result.shouldTrade).toBe(false);
      expect(result.reason.toLowerCase()).toContain('threshold');
    });

    it('should reject when profit after costs too low', () => {
      const result = calc.shouldTrade(0.03, 0.001, 0.025);

      expect(result.shouldTrade).toBe(false);
      // Profit = 0.029, cost = 0.025, net = 0.004 < 0.01
    });
  });
});
