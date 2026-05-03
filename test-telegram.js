// Test Telegram Bot Integration
const axios = require('axios');

const BOT_TOKEN = '8243348623:AAEcGNcEl8R_HvWr-wWEVGPNszwCy00QpBM';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function testTelegramBot() {
  console.log('🧪 Testing Telegram Bot Integration\n');
  console.log('=' .repeat(50));

  try {
    // Test 1: Get bot info
    console.log('\n📋 Test 1: Getting bot info...');
    const meResponse = await axios.get(`${TELEGRAM_API}/getMe`);
    
    if (meResponse.data.ok) {
      const bot = meResponse.data.result;
      console.log('✅ Bot Info:');
      console.log(`   Name: ${bot.first_name}`);
      console.log(`   Username: @${bot.username}`);
      console.log(`   ID: ${bot.id}`);
    } else {
      console.log('❌ Failed to get bot info');
    }

    // Test 2: Get webhook info
    console.log('\n📋 Test 2: Checking webhook status...');
    const webhookResponse = await axios.get(`${TELEGRAM_API}/getWebhookInfo`);
    
    if (webhookResponse.data.ok) {
      const webhook = webhookResponse.data.result;
      console.log('✅ Webhook Info:');
      console.log(`   URL: ${webhook.url || 'Not set'}`);
      console.log(`   Has custom certificate: ${webhook.has_custom_certificate}`);
      console.log(`   Pending updates: ${webhook.pending_update_count}`);
      
      if (!webhook.url) {
        console.log('\n⚠️  WARNING: Webhook not set!');
        console.log('   You need to set a webhook URL for the bot to receive messages.');
      }
    }

    // Test 3: Send test message (optional - requires chat_id)
    console.log('\n📋 Test 3: To test sending messages:');
    console.log('   1. Message your bot @mohammedImranbot on Telegram');
    console.log('   2. Then run: node get-chat-id.js');
    console.log('   3. Use that chat ID to send test messages');

    console.log('\n' + '=' .repeat(50));
    console.log('\n✅ Bot is online and responding to API calls!');
    console.log('\nNext steps:');
    console.log('1. Message @mohammedImranbot on Telegram');
    console.log('2. Check if you receive a response');
    console.log('3. If no response, webhook needs to be configured');

  } catch (error) {
    console.error('\n❌ Error testing bot:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

// Run test
testTelegramBot();
