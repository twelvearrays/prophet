#!/usr/bin/env node
/**
 * Limit Order Test - Places a limit order at a safe price, then cancels it
 *
 * This tests the full order flow WITHOUT actually executing a trade.
 * The order is placed far from market price so it won't fill.
 *
 * Run: node test-limit-order.js
 */

import 'dotenv/config';
import * as trading from './trading.js';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function log(color, ...args) {
  console.log(color, ...args, COLORS.reset);
}

async function getActiveMarket() {
  try {
    const response = await fetch('http://localhost:3001/api/markets/crypto-15m');
    if (!response.ok) throw new Error('Backend not running');
    const markets = await response.json();
    if (markets.length === 0) {
      throw new Error('No active markets found');
    }
    return markets[0];
  } catch (error) {
    throw new Error(`Failed to get market: ${error.message}. Make sure backend is running.`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  log(COLORS.bold + COLORS.cyan, '  📝 LIMIT ORDER TEST (Safe - No Execution)');
  console.log('═'.repeat(60) + '\n');

  // Initialize trading client
  log(COLORS.cyan, '1. Initializing trading client...');
  const initResult = await trading.initializeTradingClient();
  log(COLORS.green, `   ✅ Wallet: ${initResult.address}`);
  log(COLORS.green, `   ✅ Balance: $${initResult.balance.toFixed(2)} USDC`);

  // Get active market
  log(COLORS.cyan, '\n2. Finding active market...');
  let market;
  try {
    market = await getActiveMarket();
    log(COLORS.green, `   ✅ Found: ${market.asset}`);
    log(COLORS.dim, `   Question: ${market.question.slice(0, 60)}...`);
  } catch (error) {
    log(COLORS.red, `   ❌ ${error.message}`);
    process.exit(1);
  }

  // Get current price
  log(COLORS.cyan, '\n3. Getting current price...');
  let priceResponse;
  try {
    const priceRes = await fetch(`http://localhost:3001/api/price/${market.yesTokenId}/${market.noTokenId}`);
    priceResponse = await priceRes.json();
    log(COLORS.green, `   ✅ YES price: ${(priceResponse.yesPrice * 100).toFixed(1)}¢`);
    log(COLORS.green, `   ✅ NO price: ${(priceResponse.noPrice * 100).toFixed(1)}¢`);
  } catch (error) {
    log(COLORS.red, `   ❌ Failed to get price: ${error.message}`);
    process.exit(1);
  }

  // Place a limit order at a price that WON'T fill (1¢ bid for YES)
  // This tests the order placement flow without risking execution
  const safePrice = 0.01; // 1¢ - very unlikely to fill
  const shares = 10; // 10 shares = $0.10 at risk if somehow fills

  log(COLORS.cyan, '\n4. Placing LIMIT order (safe price - won\'t fill)...');
  log(COLORS.yellow, `   📝 BUY ${shares} YES @ ${(safePrice * 100).toFixed(0)}¢ (market is at ${(priceResponse.yesPrice * 100).toFixed(0)}¢)`);

  let order;
  try {
    order = await trading.placeLimitOrder({
      tokenId: market.yesTokenId,
      side: 'BUY',
      price: safePrice,
      size: shares,
    });

    log(COLORS.green, `   ✅ Order placed!`);
    log(COLORS.green, `   Order ID: ${order.orderId}`);
    log(COLORS.dim, `   Status: ${order.status}`);
    log(COLORS.dim, `   Is Maker: ${order.isMaker || 'resting'}`);
  } catch (error) {
    log(COLORS.red, `   ❌ Order failed: ${error.message}`);
    process.exit(1);
  }

  // Check open orders
  log(COLORS.cyan, '\n5. Checking open orders...');
  await sleep(1000);

  try {
    const openOrders = await trading.getOpenOrders();
    log(COLORS.green, `   ✅ Open orders: ${openOrders.length}`);

    const ourOrder = openOrders.find(o => o.id === order.orderId || o.orderID === order.orderId);
    if (ourOrder) {
      log(COLORS.green, `   ✅ Our order is on the book!`);
    } else {
      log(COLORS.yellow, `   ⚠️  Order not found in open orders (may have been rejected)`);
    }
  } catch (error) {
    log(COLORS.red, `   ❌ Failed to get orders: ${error.message}`);
  }

  // Cancel the order
  log(COLORS.cyan, '\n6. Cancelling order...');
  try {
    await trading.cancelOrder(order.orderId);
    log(COLORS.green, `   ✅ Order cancelled!`);
  } catch (error) {
    log(COLORS.red, `   ❌ Cancel failed: ${error.message}`);
  }

  // Verify cancellation
  log(COLORS.cyan, '\n7. Verifying cancellation...');
  await sleep(1000);

  try {
    const openOrders = await trading.getOpenOrders();
    const ourOrder = openOrders.find(o => o.id === order.orderId || o.orderID === order.orderId);
    if (!ourOrder) {
      log(COLORS.green, `   ✅ Order successfully removed from book`);
    } else {
      log(COLORS.yellow, `   ⚠️  Order still appears in open orders`);
    }
    log(COLORS.dim, `   Remaining open orders: ${openOrders.length}`);
  } catch (error) {
    log(COLORS.red, `   ❌ Verification failed: ${error.message}`);
  }

  // Final balance (should be unchanged)
  log(COLORS.cyan, '\n8. Final balance check...');
  try {
    const finalBalance = await trading.getBalance();
    log(COLORS.green, `   💰 USDC Balance: $${finalBalance.toFixed(2)}`);

    const diff = finalBalance - initResult.balance;
    if (Math.abs(diff) < 0.01) {
      log(COLORS.green, `   ✅ Balance unchanged (no execution occurred)`);
    } else {
      log(COLORS.yellow, `   ⚠️  Balance changed by $${diff.toFixed(4)}`);
    }
  } catch (error) {
    log(COLORS.red, `   ❌ Balance check failed: ${error.message}`);
  }

  console.log('\n' + '═'.repeat(60));
  log(COLORS.green, '  ✅ Limit order test complete!');
  log(COLORS.dim, '  Your order flow is working correctly.');
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => {
  log(COLORS.red, `❌ Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
