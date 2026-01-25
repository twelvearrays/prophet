import { PolymarketClient } from './api/PolymarketClient';

// ============================================================================
// API TEST
// ============================================================================
// Tests the Polymarket API connection using slug-based market lookup.
// Run with: npx ts-node src/test-api.ts
// ============================================================================

async function main() {
  const client = new PolymarketClient();

  console.log('🔍 Testing Polymarket API connection...\n');

  try {
    // Test 0: Basic connectivity check
    console.log('0. Testing basic API connectivity...');
    try {
      const response = await fetch('https://gamma-api.polymarket.com/markets?limit=1');
      if (response.status === 403) {
        console.log('   ⚠️ API is returning 403 Forbidden.');
        console.log('   This typically means Polymarket is blocking requests from cloud/datacenter IPs.');
        console.log('   Try running this script from your local machine instead.\n');
      } else if (response.ok) {
        console.log('   ✅ API is accessible\n');
      } else {
        console.log(`   ⚠️ API returned status ${response.status}\n`);
      }
    } catch (err: any) {
      console.log(`   ⚠️ Connectivity check failed: ${err.message}\n`);
    }

    // Test 1: Get 15-minute crypto markets
    console.log('1. Searching for 15-minute crypto markets...');
    console.log('   Using slug pattern: {asset}-updown-15m-{timestamp}');

    const nowTs = Math.floor(Date.now() / 1000);
    const baseTs = Math.floor(nowTs / 900) * 900;
    console.log(`   Current 15-min window timestamp: ${baseTs}`);
    console.log(`   Example slug: btc-updown-15m-${baseTs}\n`);

    const markets15min = await client.getCryptoMarkets(['BTC', 'ETH', 'SOL']);

    if (markets15min.length > 0) {
      console.log(`   ✅ Found ${markets15min.length} 15-min markets:\n`);
      for (const market of markets15min) {
        console.log(`   [${market.asset}] ${market.question}`);
        console.log(`       Slug: ${market.slug}`);
        console.log(`       End time: ${market.endTime.toLocaleString()}`);
        console.log(`       YES token: ${market.yesTokenId.slice(0, 30)}...`);
        console.log(`       NO token: ${market.noTokenId.slice(0, 30)}...`);
        console.log('');
      }

      // Test price fetch
      const testMarket = markets15min[0];
      console.log(`2. Testing price fetch for ${testMarket.asset}...`);

      const tick = await client.getPriceTick(testMarket.yesTokenId, testMarket.noTokenId);
      console.log(`   YES price: ${(tick.yesPrice * 100).toFixed(1)}¢`);
      console.log(`   NO price: ${(tick.noPrice * 100).toFixed(1)}¢`);
      console.log(`   YES liquidity: $${tick.yesLiquidity.toFixed(2)}`);
      console.log(`   NO liquidity: $${tick.noLiquidity.toFixed(2)}`);
      console.log('');

      // Test polling
      console.log('3. Polling prices for 5 seconds...');
      let count = 0;
      const stop = client.startPolling(
        testMarket.yesTokenId,
        testMarket.noTokenId,
        (t) => {
          count++;
          console.log(`   [${count}] YES: ${(t.yesPrice * 100).toFixed(1)}¢ | NO: ${(t.noPrice * 100).toFixed(1)}¢`);
        },
        1000
      );

      await new Promise(resolve => setTimeout(resolve, 5000));
      stop();
      console.log('   Stopped polling.\n');

    } else {
      console.log('   ⚠️ No 15-min markets found. This could mean:');
      console.log('      - Markets are between windows (wait a minute)');
      console.log('      - Markets are paused/disabled');
      console.log('      - Different slug format is being used\n');
    }

    // Test 2: Get hourly crypto markets
    console.log('4. Searching for hourly crypto markets...');
    const marketsHourly = await client.getHourlyCryptoMarkets(['BTC', 'ETH']);

    if (marketsHourly.length > 0) {
      console.log(`   ✅ Found ${marketsHourly.length} hourly markets:\n`);
      for (const market of marketsHourly.slice(0, 3)) {
        console.log(`   [${market.asset}] ${market.question}`);
        console.log(`       Slug: ${market.slug}`);
        console.log(`       End time: ${market.endTime.toLocaleString()}`);
        console.log('');
      }
    } else {
      console.log('   ⚠️ No hourly markets found.\n');
    }

    console.log('✅ API test complete!');

  } catch (error: any) {
    console.error('❌ API test failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data).slice(0, 200));
    }
  }
}

main();
