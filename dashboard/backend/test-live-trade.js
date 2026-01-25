#!/usr/bin/env node
/**
 * Live Trade Test - Places a real $1 buy and then sells the shares
 *
 * This will use REAL MONEY from your wallet!
 *
 * Run: node test-live-trade.js
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

// Fetch current active market from the backend
async function getActiveMarket() {
  try {
    const response = await fetch('http://localhost:3001/api/markets/crypto-15m');
    if (!response.ok) throw new Error('Backend not running');
    const markets = await response.json();
    if (markets.length === 0) {
      throw new Error('No active markets found');
    }
    return markets[0]; // Return first active market
  } catch (error) {
    throw new Error(`Failed to get market: ${error.message}. Make sure backend is running (npm run dev)`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  log(COLORS.bold + COLORS.yellow, '  ⚠️  LIVE TRADE TEST - REAL MONEY!');
  console.log('═'.repeat(60) + '\n');

  // Initialize trading client
  log(COLORS.cyan, '1. Initializing trading client...');
  const initResult = await trading.initializeTradingClient();
  log(COLORS.green, `   ✅ Wallet: ${initResult.address}`);
  log(COLORS.green, `   ✅ Balance: $${initResult.balance.toFixed(2)} USDC`);

  if (initResult.balance < 2) {
    log(COLORS.red, '   ❌ Insufficient balance for test (need at least $2)');
    process.exit(1);
  }

  // Get active market
  log(COLORS.cyan, '\n2. Finding active market...');
  let market;
  try {
    market = await getActiveMarket();
    log(COLORS.green, `   ✅ Found: ${market.asset}`);
    log(COLORS.dim, `   Question: ${market.question.slice(0, 60)}...`);
    log(COLORS.dim, `   YES Token: ${market.yesTokenId.slice(0, 20)}...`);
    log(COLORS.dim, `   NO Token: ${market.noTokenId.slice(0, 20)}...`);
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

  // Decide which side to buy (buy the cheaper one for better test)
  const buyYes = priceResponse.yesPrice <= priceResponse.noPrice;
  const tokenId = buyYes ? market.yesTokenId : market.noTokenId;
  const side = buyYes ? 'YES' : 'NO';
  const currentPrice = buyYes ? priceResponse.yesPrice : priceResponse.noPrice;

  // Calculate shares for $1
  const buyAmount = 1.00; // $1 test
  const expectedShares = buyAmount / currentPrice;

  log(COLORS.cyan, '\n4. Placing BUY order...');
  log(COLORS.yellow, `   📝 Buying ${side} with $${buyAmount.toFixed(2)} (~${expectedShares.toFixed(2)} shares @ ${(currentPrice * 100).toFixed(1)}¢)`);

  let buyResult;
  try {
    // Place market order (FAK - Fill and Kill)
    buyResult = await trading.placeMarketOrder({
      tokenId,
      side: 'BUY',
      amount: buyAmount,
    });

    log(COLORS.green, `   ✅ Buy order submitted!`);
    console.log(COLORS.dim, '   Response:', JSON.stringify(buyResult, null, 2), COLORS.reset);
  } catch (error) {
    log(COLORS.red, `   ❌ Buy failed: ${error.message}`);
    process.exit(1);
  }

  // Wait for order to settle
  log(COLORS.cyan, '\n5. Waiting for settlement (3 seconds)...');
  await sleep(3000);

  // Check token balance to see how many shares we got
  log(COLORS.cyan, '\n6. Checking token balance...');
  let sharesOwned = 0;
  try {
    sharesOwned = await trading.getTokenBalance(tokenId);
    log(COLORS.green, `   ✅ Shares owned: ${sharesOwned.toFixed(4)} ${side}`);

    if (sharesOwned <= 0) {
      log(COLORS.yellow, `   ⚠️  No shares found - order may not have filled`);
      log(COLORS.dim, `   This can happen if liquidity was too low or price moved`);

      // Check USDC balance
      const newBalance = await trading.getBalance();
      log(COLORS.dim, `   USDC Balance: $${newBalance.toFixed(2)}`);
      process.exit(0);
    }
  } catch (error) {
    log(COLORS.red, `   ❌ Failed to get balance: ${error.message}`);
  }

  // Now sell the shares
  log(COLORS.cyan, '\n7. Placing SELL order...');
  log(COLORS.yellow, `   📝 Selling ${sharesOwned.toFixed(4)} ${side} shares`);

  try {
    // For sell, we need to specify shares (not dollars)
    // Place as market order
    const sellResult = await trading.placeMarketOrder({
      tokenId,
      side: 'SELL',
      amount: sharesOwned, // For SELL, amount is in shares
    });

    log(COLORS.green, `   ✅ Sell order submitted!`);
    console.log(COLORS.dim, '   Response:', JSON.stringify(sellResult, null, 2), COLORS.reset);
  } catch (error) {
    log(COLORS.red, `   ❌ Sell failed: ${error.message}`);
    log(COLORS.yellow, `   ⚠️  You may still have ${sharesOwned.toFixed(4)} ${side} shares!`);
  }

  // Wait and check final balance
  log(COLORS.cyan, '\n8. Final balance check...');
  await sleep(2000);

  try {
    const finalBalance = await trading.getBalance();
    const finalShares = await trading.getTokenBalance(tokenId);

    log(COLORS.green, `   💰 USDC Balance: $${finalBalance.toFixed(2)}`);
    log(COLORS.green, `   📊 ${side} Shares: ${finalShares.toFixed(4)}`);

    const pnl = finalBalance - initResult.balance;
    if (pnl >= 0) {
      log(COLORS.green, `   📈 P&L: +$${pnl.toFixed(4)}`);
    } else {
      log(COLORS.red, `   📉 P&L: -$${Math.abs(pnl).toFixed(4)} (spread + fees)`);
    }
  } catch (error) {
    log(COLORS.red, `   ❌ Balance check failed: ${error.message}`);
  }

  console.log('\n' + '═'.repeat(60));
  log(COLORS.green, '  ✅ Live trade test complete!');
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => {
  log(COLORS.red, `❌ Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
