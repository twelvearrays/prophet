// Live Trading Module for Polymarket
// Uses @polymarket/clob-client for authenticated trading
// Based on official examples: https://github.com/Polymarket/clob-client/tree/main/examples

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

// ============================================================================
// CONFIGURATION
// ============================================================================

const TRADING_CONFIG = {
  // Position sizing (in USDC)
  investmentPerSide: 10,      // $10 per side for dual-entry
  maxPositionSize: 50,        // Max $50 per position
  maxDailyLoss: 100,          // Stop trading if down $100

  // Maker order prices for dual-entry
  makerBidPrice: 0.46,        // Bid at 46¢
  makerAskPrice: 0.54,        // Also bid at 54¢

  // Polymarket CLOB settings
  host: 'https://clob.polymarket.com',
  chainId: 137, // Polygon mainnet

  // Order tracking
  orderCheckIntervalMs: 1000, // Check order status every 1s
};

// ============================================================================
// TRADING CLIENT SETUP
// ============================================================================

let tradingClient = null;
let isInitialized = false;
let wallet = null;
let apiCreds = null;

// Active orders by market: conditionId -> { orders: [], state: 'ENTERING' | 'WAITING_LOSER' | etc }
const activePositions = new Map();

// Daily P&L tracking
let dailyPnl = 0;
let dailyStartTime = Date.now();

/**
 * Initialize the trading client with API credentials
 *
 * Signature types:
 *   0 = EOA (MetaMask, hardware wallets)
 *   1 = Magic/Email wallet
 *   2 = Browser wallet proxy (for web deposits)
 *
 * @param {Object} credentials - { privateKey, apiKey?, apiSecret?, passphrase?, signatureType?, funder? }
 */
export async function initializeTradingClient(credentials = {}) {
  // Support both naming conventions from .env
  const privateKey = credentials.privateKey
    || process.env.POLYGON_WALLET_PRIVATE_KEY
    || process.env.POLYMARKET_PRIVATE_KEY;

  const funder = credentials.funder
    || process.env.POLYMARKET_PROXY
    || process.env.POLYMARKET_FUNDER;

  // Signature type 2 = browser wallet proxy (when using POLYMARKET_PROXY)
  const signatureType = credentials.signatureType
    ?? (funder ? 2 : 1);

  const {
    apiKey,
    apiSecret,
    passphrase,
  } = credentials;

  if (!privateKey) {
    throw new Error('Missing required credential: privateKey');
  }

  console.log('[TRADING] Initializing authenticated CLOB client...');

  try {
    // Create wallet from private key
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    wallet = new Wallet(pk);
    console.log('[TRADING] Wallet address:', wallet.address);

    // If API credentials are provided, use them directly
    if (apiKey && apiSecret) {
      apiCreds = {
        key: apiKey,
        secret: apiSecret,
        passphrase: passphrase || '',
      };
      console.log('[TRADING] Using provided API credentials');
    } else {
      // Otherwise, derive credentials from the private key
      console.log('[TRADING] Deriving API credentials from private key...');
      const tempClient = new ClobClient(TRADING_CONFIG.host, TRADING_CONFIG.chainId, wallet);
      apiCreds = await tempClient.createOrDeriveApiKey();
      console.log('[TRADING] API key derived:', apiCreds.key?.slice(0, 8) + '...');
    }

    // Create the authenticated client with credentials
    tradingClient = new ClobClient(
      TRADING_CONFIG.host,
      TRADING_CONFIG.chainId,
      wallet,
      apiCreds,
      signatureType,
      funder
    );

    // Test connection by checking balance
    const balance = await getBalance();
    console.log('[TRADING] USDC Balance:', balance);

    isInitialized = true;
    console.log('[TRADING] Client initialized successfully');

    return {
      success: true,
      address: wallet.address,
      balance,
      apiKey: apiCreds.key?.slice(0, 8) + '...'
    };
  } catch (error) {
    console.error('[TRADING] Initialization failed:', error.message);
    throw error;
  }
}

/**
 * Check if trading is enabled
 */
export function isTradingEnabled() {
  return isInitialized && tradingClient !== null;
}

/**
 * Get the wallet address
 */
export function getWalletAddress() {
  return wallet?.address || null;
}

// ============================================================================
// ACCOUNT INFO
// ============================================================================

/**
 * Get USDC balance (collateral)
 * Balance is returned in micro-units (divide by 1e6 for actual USDC)
 */
export async function getBalance() {
  if (!tradingClient) throw new Error('Trading client not initialized');

  try {
    // Get collateral balance
    const result = await tradingClient.getBalanceAllowance({
      asset_type: 'COLLATERAL',
    });

    if (result && typeof result.balance !== 'undefined') {
      // Convert from micro-units
      const balance = parseFloat(result.balance) / 1_000_000;
      return balance;
    }

    return 0;
  } catch (error) {
    console.error('[TRADING] Error getting balance:', error.message);
    throw error;
  }
}

/**
 * Get token balance (conditional token - YES or NO shares)
 */
export async function getTokenBalance(tokenId) {
  if (!tradingClient) throw new Error('Trading client not initialized');

  try {
    const result = await tradingClient.getBalanceAllowance({
      asset_type: 'CONDITIONAL',
      token_id: tokenId,
    });

    if (result && typeof result.balance !== 'undefined') {
      // Convert from micro-units to shares
      return parseFloat(result.balance) / 1_000_000;
    }

    return 0;
  } catch (error) {
    console.error('[TRADING] Error getting token balance:', error.message);
    return 0;
  }
}

/**
 * Get open orders
 */
export async function getOpenOrders() {
  if (!tradingClient) throw new Error('Trading client not initialized');

  try {
    const orders = await tradingClient.getOpenOrders();
    return orders || [];
  } catch (error) {
    console.error('[TRADING] Error getting open orders:', error.message);
    throw error;
  }
}

/**
 * Get order by ID
 */
export async function getOrder(orderId) {
  if (!tradingClient) throw new Error('Trading client not initialized');

  try {
    const order = await tradingClient.getOrder(orderId);
    return order;
  } catch (error) {
    console.error('[TRADING] Error getting order:', error.message);
    return null;
  }
}

// ============================================================================
// ORDER PLACEMENT
// ============================================================================

/**
 * Place a limit order (maker order with post_only=true)
 *
 * @param {Object} params - { tokenId, side, price, size, tickSize?, negRisk? }
 * @returns {Object} Order response with orderId
 */
export async function placeLimitOrder({ tokenId, side, price, size, tickSize = '0.01', negRisk = true }) {
  if (!tradingClient) throw new Error('Trading client not initialized');

  // Safety checks
  const orderValue = size * price;
  if (orderValue > TRADING_CONFIG.maxPositionSize) {
    throw new Error(`Order size $${orderValue.toFixed(2)} exceeds max position size $${TRADING_CONFIG.maxPositionSize}`);
  }

  // Check daily loss limit
  if (dailyPnl < -TRADING_CONFIG.maxDailyLoss) {
    throw new Error(`Daily loss limit reached: $${dailyPnl.toFixed(2)}`);
  }

  const orderSide = side.toUpperCase() === 'BUY' ? Side.BUY : Side.SELL;
  console.log(`[TRADING] Placing ${side} limit order: ${size.toFixed(2)} shares @ ${(price * 100).toFixed(1)}¢`);

  try {
    // Create the order
    const order = await tradingClient.createOrder({
      tokenID: tokenId,
      price: price,
      side: orderSide,
      size: size,
    });

    // Post with GTC (Good Till Cancelled) and post_only=true for maker rebates
    // postOrder(order, orderType, deferExec, postOnly)
    const response = await tradingClient.postOrder(order, OrderType.GTC, false, true);

    const orderId = response?.orderID || response?.id || response?.order_id;
    console.log(`[TRADING] Order placed: ${orderId}`);

    // Check if we got maker or taker
    const isTaker = response?.takingAmount && response.takingAmount !== '0';
    const isMaker = response?.makingAmount && response.makingAmount !== '0';
    const role = isTaker ? 'TAKER' : (isMaker ? 'MAKER' : 'RESTING');
    console.log(`[TRADING] Order role: ${role}`);

    return {
      orderId,
      tokenId,
      side,
      price,
      size,
      status: response?.status || 'OPEN',
      isTaker,
      isMaker,
      timestamp: Date.now(),
      response,
    };
  } catch (error) {
    console.error('[TRADING] Order placement failed:', error.message);
    throw error;
  }
}

/**
 * Place a market order (for quick exits)
 * Uses FAK (Fill and Kill) - fills what it can, cancels rest
 *
 * @param {Object} params - { tokenId, side, amount, tickSize? }
 */
export async function placeMarketOrder({ tokenId, side, amount, tickSize = '0.01' }) {
  if (!tradingClient) throw new Error('Trading client not initialized');

  const orderSide = side.toUpperCase() === 'BUY' ? Side.BUY : Side.SELL;
  console.log(`[TRADING] Placing ${side} market order: $${amount.toFixed(2)}`);

  try {
    // Create market order
    const order = await tradingClient.createMarketOrder({
      tokenID: tokenId,
      amount: amount,
      side: orderSide,
      orderType: OrderType.FAK, // Fill and Kill - partial fills OK
    });

    // Post the order
    const response = await tradingClient.postOrder(order, OrderType.FAK);

    console.log(`[TRADING] Market order executed:`, response);
    return response;
  } catch (error) {
    console.error('[TRADING] Market order failed:', error.message);
    throw error;
  }
}

/**
 * Cancel an order
 */
export async function cancelOrder(orderId) {
  if (!tradingClient) throw new Error('Trading client not initialized');

  console.log(`[TRADING] Cancelling order: ${orderId}`);

  try {
    const response = await tradingClient.cancelOrder({ orderID: orderId });
    console.log(`[TRADING] Order cancelled: ${orderId}`);
    return response;
  } catch (error) {
    console.error('[TRADING] Cancel failed:', error.message);
    throw error;
  }
}

/**
 * Cancel all orders
 */
export async function cancelAllOrders() {
  if (!tradingClient) throw new Error('Trading client not initialized');

  console.log(`[TRADING] Cancelling all orders...`);

  try {
    const response = await tradingClient.cancelAll();
    const cancelled = response?.canceled || [];
    console.log(`[TRADING] Cancelled ${cancelled.length} orders`);
    return cancelled;
  } catch (error) {
    console.error('[TRADING] Cancel all failed:', error.message);
    throw error;
  }
}

/**
 * Cancel orders for a specific market
 */
export async function cancelMarketOrders(marketId) {
  if (!tradingClient) throw new Error('Trading client not initialized');

  console.log(`[TRADING] Cancelling orders for market: ${marketId.slice(0, 12)}...`);

  try {
    const openOrders = await getOpenOrders();
    const marketOrders = openOrders.filter(o =>
      o.asset_id === marketId || o.token_id?.includes(marketId)
    );

    if (marketOrders.length === 0) {
      console.log('[TRADING] No orders to cancel for this market');
      return [];
    }

    const orderIds = marketOrders.map(o => o.id || o.orderID);
    const response = await tradingClient.cancelOrders(orderIds);
    console.log(`[TRADING] Cancelled ${orderIds.length} orders for market`);
    return response;
  } catch (error) {
    console.error('[TRADING] Cancel market orders failed:', error.message);
    throw error;
  }
}

// ============================================================================
// DUAL-ENTRY STRATEGY EXECUTION
// ============================================================================

/**
 * Place maker orders for dual-entry strategy
 * Places 4 limit orders: YES@46¢, YES@54¢, NO@46¢, NO@54¢
 * All orders are post_only=true for maker rebates
 */
export async function placeDualEntryOrders({ yesTokenId, noTokenId, marketId, tickSize = '0.01', negRisk = true }) {
  if (!tradingClient) throw new Error('Trading client not initialized');

  console.log(`[TRADING] Placing dual-entry maker orders for market ${marketId.slice(0, 8)}...`);

  const investment = TRADING_CONFIG.investmentPerSide;
  const bidPrice = TRADING_CONFIG.makerBidPrice;
  const askPrice = TRADING_CONFIG.makerAskPrice;

  const orders = [];

  try {
    // YES @ 46¢ - buy if YES drops to 46¢
    const yes46 = await placeLimitOrder({
      tokenId: yesTokenId,
      side: 'BUY',
      price: bidPrice,
      size: investment / bidPrice,
      tickSize,
      negRisk,
    });
    orders.push({ ...yes46, label: 'YES@46¢' });

    // YES @ 54¢ - buy if YES rises to 54¢ (betting on momentum)
    const yes54 = await placeLimitOrder({
      tokenId: yesTokenId,
      side: 'BUY',
      price: askPrice,
      size: investment / askPrice,
      tickSize,
      negRisk,
    });
    orders.push({ ...yes54, label: 'YES@54¢' });

    // NO @ 46¢ - buy if NO drops to 46¢
    const no46 = await placeLimitOrder({
      tokenId: noTokenId,
      side: 'BUY',
      price: bidPrice,
      size: investment / bidPrice,
      tickSize,
      negRisk,
    });
    orders.push({ ...no46, label: 'NO@46¢' });

    // NO @ 54¢ - buy if NO rises to 54¢
    const no54 = await placeLimitOrder({
      tokenId: noTokenId,
      side: 'BUY',
      price: askPrice,
      size: investment / askPrice,
      tickSize,
      negRisk,
    });
    orders.push({ ...no54, label: 'NO@54¢' });

    // Track position
    activePositions.set(marketId, {
      orders,
      yesTokenId,
      noTokenId,
      state: 'ENTERING',
      filledYes: null,
      filledNo: null,
      entryTime: Date.now(),
    });

    console.log(`[TRADING] Placed 4 dual-entry orders for ${marketId.slice(0, 8)}`);

    return { success: true, orders };
  } catch (error) {
    console.error('[TRADING] Dual-entry order placement failed:', error.message);

    // Cancel any orders that were placed
    for (const order of orders) {
      try {
        await cancelOrder(order.orderId);
      } catch (e) {
        console.error('[TRADING] Failed to cancel order:', e.message);
      }
    }

    throw error;
  }
}

/**
 * Check order fills and update position state
 */
export async function checkOrderFills(marketId) {
  if (!tradingClient) return null;

  const position = activePositions.get(marketId);
  if (!position) return null;

  try {
    const openOrders = await getOpenOrders();
    const openOrderIds = new Set(openOrders.map(o => o.id || o.orderID));

    // Check which orders are no longer open (i.e., filled or cancelled)
    let filledYes = position.filledYes;
    let filledNo = position.filledNo;

    for (const order of position.orders) {
      if (!openOrderIds.has(order.orderId) && order.status === 'OPEN') {
        // Order is no longer open - check if it was filled
        const orderDetails = await getOrder(order.orderId);

        if (orderDetails?.status === 'MATCHED' || orderDetails?.status === 'FILLED') {
          order.status = 'FILLED';
          console.log(`[TRADING] Order filled: ${order.label} @ ${(order.price * 100).toFixed(1)}¢`);

          if (order.tokenId === position.yesTokenId && !filledYes) {
            filledYes = order;
          }
          if (order.tokenId === position.noTokenId && !filledNo) {
            filledNo = order;
          }
        } else if (orderDetails?.status === 'CANCELLED') {
          order.status = 'CANCELLED';
        }
      }
    }

    position.filledYes = filledYes;
    position.filledNo = filledNo;

    // Check if both sides filled
    if (filledYes && filledNo && position.state === 'ENTERING') {
      console.log(`[TRADING] Both sides filled! Cancelling remaining orders...`);

      // Cancel remaining open orders
      for (const order of position.orders) {
        if (order.status === 'OPEN') {
          try {
            await cancelOrder(order.orderId);
            order.status = 'CANCELLED';
          } catch (e) {
            console.error('[TRADING] Failed to cancel:', e.message);
          }
        }
      }

      position.state = 'WAITING_LOSER';
      console.log(`[TRADING] Position state: WAITING_LOSER`);
    }

    return position;
  } catch (error) {
    console.error('[TRADING] Error checking fills:', error.message);
    return position;
  }
}

/**
 * Exit a position (sell shares)
 */
export async function exitPosition({ tokenId, shares, reason }) {
  if (!tradingClient) throw new Error('Trading client not initialized');

  console.log(`[TRADING] Exiting position: selling ${shares.toFixed(2)} shares (${reason})`);

  try {
    // Get current orderbook to find best bid
    const book = await tradingClient.getOrderBook(tokenId);
    const bestBid = book?.bids?.length > 0
      ? Math.max(...book.bids.map(b => parseFloat(b.price)))
      : 0.01;

    // Place sell order slightly below best bid for quick fill
    const sellPrice = Math.max(0.01, bestBid - 0.01);

    const order = await placeLimitOrder({
      tokenId,
      side: 'SELL',
      price: sellPrice,
      size: shares,
    });

    return order;
  } catch (error) {
    console.error('[TRADING] Exit failed:', error.message);
    throw error;
  }
}

// ============================================================================
// POSITION TRACKING
// ============================================================================

export function getActivePositions() {
  return Array.from(activePositions.entries()).map(([marketId, pos]) => ({
    marketId,
    ...pos,
  }));
}

export function clearPosition(marketId) {
  activePositions.delete(marketId);
}

export function getDailyPnl() {
  return dailyPnl;
}

export function updateDailyPnl(amount) {
  dailyPnl += amount;
  console.log(`[TRADING] Daily P&L: $${dailyPnl.toFixed(2)}`);
}

export function resetDailyPnl() {
  dailyPnl = 0;
  dailyStartTime = Date.now();
}

// Reset daily P&L at midnight
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    resetDailyPnl();
    console.log('[TRADING] Daily P&L reset');
  }
}, 60000);

export { TRADING_CONFIG };
