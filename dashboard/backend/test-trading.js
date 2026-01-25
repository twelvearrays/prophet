#!/usr/bin/env node
/**
 * Test script for Polymarket Live Trading
 *
 * Before running:
 * 1. Copy .env.example to .env
 * 2. Fill in your credentials (private key from https://reveal.magic.link/polymarket)
 * 3. Run: node test-trading.js
 *
 * This script will:
 * 1. Initialize the trading client
 * 2. Check your USDC balance
 * 3. Show open orders
 * 4. (Optional) Place a test order
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
};

function log(color, ...args) {
  console.log(color, ...args, COLORS.reset);
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  log(COLORS.cyan, '  Polymarket Live Trading Test');
  console.log('═'.repeat(60) + '\n');

  // Check for credentials - support both naming conventions
  const privateKey = process.env.POLYGON_WALLET_PRIVATE_KEY || process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    log(COLORS.red, '❌ ERROR: Private key not set in .env');
    log(COLORS.dim, '   1. Copy .env.example to .env');
    log(COLORS.dim, '   2. Get your private key from https://reveal.magic.link/polymarket');
    log(COLORS.dim, '   3. Add it to .env as POLYGON_WALLET_PRIVATE_KEY=0x...');
    process.exit(1);
  }

  // Initialize trading client
  log(COLORS.yellow, '🔄 Initializing trading client...');

  try {
    // Let initializeTradingClient read from env directly
    const result = await trading.initializeTradingClient();

    log(COLORS.green, '✅ Trading client initialized!');
    log(COLORS.dim, `   Wallet: ${result.address}`);
    log(COLORS.dim, `   Balance: $${result.balance.toFixed(2)} USDC`);

    // Get detailed balance
    console.log('\n' + '─'.repeat(40));
    log(COLORS.cyan, '💰 Account Balance');
    console.log('─'.repeat(40));

    const balance = await trading.getBalance();
    console.log(`   USDC Balance: $${balance.toFixed(2)}`);

    // Get open orders
    console.log('\n' + '─'.repeat(40));
    log(COLORS.cyan, '📋 Open Orders');
    console.log('─'.repeat(40));

    const orders = await trading.getOpenOrders();
    if (orders.length === 0) {
      log(COLORS.dim, '   No open orders');
    } else {
      for (const order of orders) {
        console.log(`   ${order.side} ${order.size} @ ${order.price} (${order.id?.slice(0, 12)}...)`);
      }
    }

    // Show trading config
    console.log('\n' + '─'.repeat(40));
    log(COLORS.cyan, '⚙️  Trading Configuration');
    console.log('─'.repeat(40));
    console.log(`   Investment per side: $${trading.TRADING_CONFIG.investmentPerSide}`);
    console.log(`   Max position size:   $${trading.TRADING_CONFIG.maxPositionSize}`);
    console.log(`   Max daily loss:      $${trading.TRADING_CONFIG.maxDailyLoss}`);
    console.log(`   Maker bid price:     ${(trading.TRADING_CONFIG.makerBidPrice * 100).toFixed(0)}¢`);
    console.log(`   Maker ask price:     ${(trading.TRADING_CONFIG.makerAskPrice * 100).toFixed(0)}¢`);

    // Test order placement (disabled by default)
    const TEST_ORDER = false;
    if (TEST_ORDER && balance >= 1) {
      console.log('\n' + '─'.repeat(40));
      log(COLORS.yellow, '🧪 Test Order Placement');
      console.log('─'.repeat(40));

      // You would need a valid token ID here
      const testTokenId = 'YOUR_TOKEN_ID_HERE';

      try {
        const order = await trading.placeLimitOrder({
          tokenId: testTokenId,
          side: 'BUY',
          price: 0.01, // Very low price - won't fill
          size: 1,
        });
        log(COLORS.green, `   ✅ Test order placed: ${order.orderId}`);

        // Cancel immediately
        await trading.cancelOrder(order.orderId);
        log(COLORS.green, '   ✅ Test order cancelled');
      } catch (error) {
        log(COLORS.red, `   ❌ Order test failed: ${error.message}`);
      }
    }

    console.log('\n' + '═'.repeat(60));
    log(COLORS.green, '✅ All tests passed! Trading is ready.');
    console.log('═'.repeat(60) + '\n');

  } catch (error) {
    log(COLORS.red, `❌ ERROR: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main().catch(console.error);
