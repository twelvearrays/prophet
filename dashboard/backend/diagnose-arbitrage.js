/**
 * Arbitrage Diagnostic Script
 *
 * Tests Type 1 and Type 3 scanners against live Polymarket data
 * to understand why every market has been a miss.
 */

import { validateType1Market, validatePriceSum } from './marketValidator.js';
import { FrankWolfeEngine } from './frankWolfe.js';
import { SettlementLagScanner } from './settlementLag.js';
import { ClobClient } from '@polymarket/clob-client';

const GAMMA_API = 'https://gamma-api.polymarket.com';

const clobClient = new ClobClient('https://clob.polymarket.com', 137);

// ── Helpers ──────────────────────────────────────────────────────────────

function extractTokenIds(market) {
  let yesTokenId = '', noTokenId = '';
  if (market.clobTokenIds) {
    try {
      const tokenIds = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
      if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
        yesTokenId = tokenIds[0];
        noTokenId = tokenIds[1];
      }
    } catch (e) {}
  }
  if (!yesTokenId && market.tokens?.length >= 2) {
    const yes = market.tokens.find(t => t.outcome?.toLowerCase() === 'yes');
    const no = market.tokens.find(t => t.outcome?.toLowerCase() === 'no');
    yesTokenId = yes?.token_id || '';
    noTokenId = no?.token_id || '';
  }
  return { yesTokenId, noTokenId };
}

async function getBookPrice(tokenId) {
  try {
    const book = await clobClient.getOrderBook(tokenId);
    const asks = book?.asks || [];
    const bids = book?.bids || [];
    const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => parseFloat(a.price))) : null;
    const bestBid = bids.length > 0 ? Math.max(...bids.map(b => parseFloat(b.price))) : null;
    const liquidity = bids.slice(0, 5).reduce((sum, b) => sum + parseFloat(b.size) * parseFloat(b.price), 0);
    return { bestAsk, bestBid, liquidity };
  } catch (e) {
    return { bestAsk: null, bestBid: null, liquidity: 0 };
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'ArbitrageDiag/1.0' }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── TYPE 1 DIAGNOSTIC ────────────────────────────────────────────────────

async function diagnoseType1() {
  console.log('\n' + '═'.repeat(70));
  console.log('  TYPE 1 DIAGNOSTIC: Multi-Outcome Arbitrage Scanner');
  console.log('═'.repeat(70));

  // Step 1: Fetch events
  console.log('\n[1] Fetching active events from Gamma API...');
  let allEvents = [];
  let offset = 0;
  while (allEvents.length < 100) {
    const url = `${GAMMA_API}/events?active=true&closed=false&limit=50&offset=${offset}`;
    const data = await fetchJson(url);
    if (!Array.isArray(data) || data.length === 0) break;
    allEvents.push(...data);
    offset += 50;
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`    Fetched ${allEvents.length} total events`);

  // Step 2: Filter multi-outcome
  const multiOutcome = allEvents.filter(e => {
    const markets = e.markets || [];
    const active = markets.filter(m => m.active && !m.closed);
    return active.length >= 2;
  });
  console.log(`    Multi-outcome events (2+ active markets): ${multiOutcome.length}`);

  // Step 3: Validate each
  console.log('\n[2] Running market validation on each multi-outcome event...\n');

  const validationResults = { valid: [], temporal: [], independent: [], cumulative: [], other: [] };

  for (const event of multiOutcome) {
    const activeMarkets = (event.markets || []).filter(m => m.active && !m.closed);
    const result = validateType1Market(event, activeMarkets);

    const entry = {
      title: event.title,
      outcomes: activeMarkets.length,
      negRisk: event.negRisk || false,
      validation: result,
    };

    if (result.isValid) {
      validationResults.valid.push(entry);
    } else if (result.type === 'TEMPORAL') {
      validationResults.temporal.push(entry);
    } else if (result.type === 'INDEPENDENT') {
      validationResults.independent.push(entry);
    } else if (result.type === 'CUMULATIVE') {
      validationResults.cumulative.push(entry);
    } else {
      validationResults.other.push(entry);
    }
  }

  console.log('    Validation Summary:');
  console.log(`      VALID:       ${validationResults.valid.length}`);
  console.log(`      Temporal:    ${validationResults.temporal.length} (rejected - deadlines, not mutually exclusive)`);
  console.log(`      Independent: ${validationResults.independent.length} (rejected - unrelated outcomes)`);
  console.log(`      Cumulative:  ${validationResults.cumulative.length} (rejected - threshold/cumulative)`);
  console.log(`      Other:       ${validationResults.other.length} (rejected - other reason)`);

  // Show rejected examples
  if (validationResults.temporal.length > 0) {
    console.log('\n    Sample TEMPORAL rejections:');
    for (const e of validationResults.temporal.slice(0, 3)) {
      console.log(`      - "${e.title}" (${e.outcomes} outcomes) → ${e.validation.reason}`);
    }
  }
  if (validationResults.independent.length > 0) {
    console.log('\n    Sample INDEPENDENT rejections:');
    for (const e of validationResults.independent.slice(0, 3)) {
      console.log(`      - "${e.title}" (${e.outcomes} outcomes) → ${e.validation.reason}`);
    }
  }
  if (validationResults.cumulative.length > 0) {
    console.log('\n    Sample CUMULATIVE rejections:');
    for (const e of validationResults.cumulative.slice(0, 3)) {
      console.log(`      - "${e.title}" (${e.outcomes} outcomes) → ${e.validation.reason}`);
    }
  }

  // Step 4: For valid events, fetch prices and run Frank-Wolfe
  console.log(`\n[3] Fetching live prices for ${validationResults.valid.length} valid events...\n`);

  const fwEngine = new FrankWolfeEngine();
  const priceResults = [];

  for (const entry of validationResults.valid.slice(0, 20)) { // Cap at 20 to avoid rate limits
    const event = allEvents.find(e => e.title === entry.title);
    if (!event) continue;

    const activeMarkets = (event.markets || []).filter(m => m.active && !m.closed);
    const outcomes = [];
    let totalPrice = 0;

    for (const market of activeMarkets) {
      let price = 0.5;
      let liquidity = 0;

      // Try embedded prices first
      if (market.outcomePrices) {
        try {
          const prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices) : market.outcomePrices;
          if (Array.isArray(prices) && prices.length > 0) {
            price = parseFloat(prices[0]) || 0.5;
            liquidity = parseFloat(market.volume || '0') || 0;
          }
        } catch (e) {}
      }

      // Try order book for real prices
      const { yesTokenId } = extractTokenIds(market);
      if (yesTokenId) {
        const bookData = await getBookPrice(yesTokenId);
        if (bookData.bestAsk !== null) {
          price = bookData.bestAsk;
          liquidity = bookData.liquidity;
        }
      }

      outcomes.push({
        id: market.conditionId || market.id,
        title: market.groupItemTitle || market.question,
        price,
        liquidity,
      });
      totalPrice += price;
    }

    // Price sum validation
    const priceValid = validatePriceSum(totalPrice, outcomes.length);

    // Frank-Wolfe analysis
    const fwResult = fwEngine.analyze(outcomes, event);

    priceResults.push({
      title: entry.title,
      negRisk: entry.negRisk,
      numOutcomes: outcomes.length,
      totalPrice,
      mispricing: totalPrice - 1.0,
      absMispricing: Math.abs(totalPrice - 1.0),
      priceSumValid: priceValid.isValid,
      priceSumReason: priceValid.reason || 'ok',
      fwHasArbitrage: fwResult.hasArbitrage,
      fwProfit: fwResult.profitAfterFees || 0,
      fwReason: fwResult.reason || fwResult.reasons?.join('; ') || '',
      minLiquidity: Math.min(...outcomes.map(o => o.liquidity)),
      outcomes: outcomes.map(o => `${o.title}: $${o.price.toFixed(4)} (liq: $${o.liquidity.toFixed(0)})`),
    });

    await new Promise(r => setTimeout(r, 50));
  }

  // Step 5: Report
  console.log('─'.repeat(70));
  console.log('  TYPE 1 RESULTS: Price Analysis');
  console.log('─'.repeat(70));

  // Sort by absolute mispricing
  priceResults.sort((a, b) => b.absMispricing - a.absMispricing);

  for (const r of priceResults) {
    const indicator = r.fwHasArbitrage ? '🎯' : '❌';
    console.log(`\n${indicator} ${r.title}`);
    console.log(`    NegRisk: ${r.negRisk} | Outcomes: ${r.numOutcomes}`);
    console.log(`    Sum: ${r.totalPrice.toFixed(4)} | Mispricing: ${(r.mispricing * 100).toFixed(2)}%`);
    console.log(`    Price sum valid: ${r.priceSumValid} ${!r.priceSumValid ? '(' + r.priceSumReason + ')' : ''}`);
    console.log(`    FW profit after fees: ${(r.fwProfit * 100).toFixed(2)}%`);
    console.log(`    Min liquidity: $${r.minLiquidity.toFixed(0)}`);
    console.log(`    Reason: ${r.fwReason}`);
    if (r.outcomes.length <= 10) {
      for (const o of r.outcomes) {
        console.log(`      - ${o}`);
      }
    } else {
      for (const o of r.outcomes.slice(0, 5)) {
        console.log(`      - ${o}`);
      }
      console.log(`      ... and ${r.outcomes.length - 5} more`);
    }
  }

  const qualifying = priceResults.filter(r => r.fwHasArbitrage);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  TYPE 1 SUMMARY`);
  console.log(`  Total events: ${allEvents.length}`);
  console.log(`  Multi-outcome: ${multiOutcome.length}`);
  console.log(`  Passed validation: ${validationResults.valid.length}`);
  console.log(`  Passed price check: ${priceResults.filter(r => r.priceSumValid).length}`);
  console.log(`  Has arbitrage (FW): ${qualifying.length}`);
  console.log(`${'═'.repeat(70)}\n`);

  return priceResults;
}

// ── TYPE 3 DIAGNOSTIC ────────────────────────────────────────────────────

async function diagnoseType3() {
  console.log('\n' + '═'.repeat(70));
  console.log('  TYPE 3 DIAGNOSTIC: Settlement Lag Scanner');
  console.log('═'.repeat(70));

  // Step 1: Fetch markets
  console.log('\n[1] Fetching markets from Gamma API...');
  let allMarkets = [];
  // Fetch closed markets (settlement lag targets) and active markets
  for (const filter of ['closed=true', 'active=true']) {
    let offset = 0;
    while (allMarkets.length < 300) {
      const url = `${GAMMA_API}/markets?${filter}&order=endDate&ascending=false&limit=100&offset=${offset}`;
      const data = await fetchJson(url);
      if (!Array.isArray(data) || data.length === 0) break;
      allMarkets.push(...data);
      offset += 100;
      await new Promise(r => setTimeout(r, 100));
      if (filter === 'active=true') break; // Only 1 page of active
    }
  }

  // Filter to recent markets (last 90 days by endDate)
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  allMarkets = allMarkets.filter(m => {
    const endDate = m.endDateIso || m.endDate;
    if (!endDate) return true;
    const endTime = new Date(endDate).getTime();
    return !isNaN(endTime) && (now - endTime) < ninetyDaysMs;
  });
  console.log(`    Fetched ${allMarkets.length} recent markets (last 90 days)`);

  // Step 2: Enrich with price data (sample first 100 to avoid rate limits)
  const marketsToScan = allMarkets.slice(0, 150);
  console.log(`\n[2] Enriching ${marketsToScan.length} markets with price data...`);

  let enrichedFromGamma = 0;
  let enrichedFromClob = 0;
  for (const market of marketsToScan) {
    // Primary: Use outcomePrices from Gamma API response
    if (market.outcomePrices) {
      try {
        const prices = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices) : market.outcomePrices;
        if (Array.isArray(prices) && prices.length > 0) {
          market.price = parseFloat(prices[0]) || 0.5;
          market.bestBid = Math.max(0, market.price - 0.02);
          market.bestAsk = Math.min(1, market.price + 0.02);
          enrichedFromGamma++;
        }
      } catch (e) {}
    }

    // Map Gamma fields to scanner-expected fields
    market.endDate = market.endDateIso || market.endDate;
    market.volume24h = parseFloat(market.volume24hr || market.volume || '0');
    market.liquidity = parseFloat(market.liquidityNum || market.liquidity || '0');
    market.settled = market.settled === true || market.settled === 'true';

    // Secondary: Try CLOB order book only for active markets
    if (market.active && !market.closed) {
      const { yesTokenId } = extractTokenIds(market);
      if (yesTokenId) {
        const bookData = await getBookPrice(yesTokenId);
        if (bookData.bestAsk !== null) {
          market.price = bookData.bestAsk;
          market.bestBid = bookData.bestBid;
          market.bestAsk = bookData.bestAsk;
          market.liquidity = bookData.liquidity;
          enrichedFromClob++;
        }
      }
    }

    await new Promise(r => setTimeout(r, 30));
  }
  console.log(`    Enriched: ${enrichedFromGamma} from Gamma prices, ${enrichedFromClob} from CLOB order book`);

  // Step 3: Run settlement lag scanner
  console.log('\n[3] Running settlement lag scanner...\n');

  const scanner = new SettlementLagScanner();
  const opportunities = scanner.scan(marketsToScan);

  console.log(`    Opportunities found: ${opportunities.length}`);

  // Step 4: Also show near-misses (markets that triggered at least 1 signal)
  console.log('\n[4] Detailed signal analysis for all markets...\n');

  let signalCounts = {
    PRICE_VOLUME_DIVERGENCE: 0,
    BOUNDARY_RUSH: 0,
    STALE_PRICE: 0,
    PAST_RESOLUTION: 0,
    EXTREME_SPREAD: 0,
  };

  const nearMisses = [];

  for (const market of marketsToScan) {
    if (market.price === undefined) continue;

    const analysis = scanner.analyzeMarket(market);

    for (const signal of analysis.signals) {
      signalCounts[signal.type]++;
    }

    if (analysis.signals.length >= 1) {
      nearMisses.push({
        question: market.question,
        price: market.price,
        signals: analysis.signals.map(s => `${s.type}: ${s.details.reason}`),
        confidence: analysis.confidence,
        hasOpportunity: analysis.hasOpportunity,
        potentialProfit: analysis.potentialProfit,
        endDate: market.endDate,
        volume24h: market.volume24h,
      });
    }
  }

  console.log('    Signal frequency across all markets:');
  for (const [signal, count] of Object.entries(signalCounts)) {
    console.log(`      ${signal}: ${count} markets`);
  }

  console.log(`\n    Markets with at least 1 signal (near-misses): ${nearMisses.length}`);

  // Sort by confidence
  nearMisses.sort((a, b) => b.confidence - a.confidence);

  for (const nm of nearMisses.slice(0, 15)) {
    const indicator = nm.hasOpportunity ? '🎯' : '⚠️';
    console.log(`\n${indicator} ${nm.question}`);
    console.log(`    Price: $${nm.price?.toFixed(4)} | Confidence: ${nm.confidence} | Profit: ${(nm.potentialProfit * 100).toFixed(1)}%`);
    console.log(`    End date: ${nm.endDate || 'none'} | Volume 24h: $${nm.volume24h?.toFixed(0) || 0}`);
    for (const s of nm.signals) {
      console.log(`    → ${s}`);
    }
  }

  if (opportunities.length > 0) {
    console.log('\n' + '─'.repeat(70));
    console.log('  QUALIFYING OPPORTUNITIES:');
    for (const opp of opportunities) {
      console.log(`\n🎯 ${opp.question}`);
      console.log(`    Price: $${opp.currentPrice?.toFixed(4)} → Expected: $${opp.expectedPrice}`);
      console.log(`    Profit: ${(opp.potentialProfit * 100).toFixed(1)}% | Confidence: ${opp.confidence}`);
      console.log(`    Strategy: ${opp.strategy?.explanation}`);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  TYPE 3 SUMMARY`);
  console.log(`  Total markets fetched: ${allMarkets.length}`);
  console.log(`  Markets with prices: ${marketsToScan.filter(m => m.price !== undefined).length}`);
  console.log(`  Markets with signals: ${nearMisses.length}`);
  console.log(`  Qualifying opportunities: ${opportunities.length}`);
  console.log(`${'═'.repeat(70)}\n`);
}

// ── MAIN ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('Polymarket Arbitrage Diagnostic');
  console.log(`Time: ${new Date().toISOString()}\n`);

  try {
    await diagnoseType1();
  } catch (err) {
    console.error('TYPE 1 FAILED:', err.message);
  }

  try {
    await diagnoseType3();
  } catch (err) {
    console.error('TYPE 3 FAILED:', err.message);
  }

  console.log('\nDiagnostic complete.');
}

main().catch(console.error);
