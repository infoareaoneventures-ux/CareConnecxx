// Get Chat ID from Telegram updates
// Run this after messaging your bot

const axios = require('axios');

const BOT_TOKEN = '8243348623:AAEcGNcEl8R_HvWr-wWEVGPNszwCy00QpBM';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function getChatId() {
  console.log('🔍 Getting Chat ID from Telegram updates...\n');
  
  try {
    const response = await axios.get(`${TELEGRAM_API}/getUpdates`);
    
    if (response.data.ok && response.data.result.length > 0) {
      console.log('✅ Found messages!\n');
      
      response.data.result.forEach((update, index) => {
        if (update.message) {
          const chat = update.message.chat;
          const user = update.message.from;
          
          console.log(`Message ${index + 1}:`);
          console.log(`  From: ${user.first_name} ${user.last_name || ''} (@${user.username || 'no username'})`);
          console.log(`  Chat ID: ${chat.id}`);
          console.log(`  Text: ${update.message.text}`);
          console.log('');
        }
      });
      
      console.log('=' .repeat(50));
      console.log('\nUse this Chat ID to send messages:');
      console.log('  const CHAT_ID = <number from above>;');
      
    } else {
      console.log('⚠️  No messages found.');
      console.log('   Please message @mohammedImranbot first, then run this script again.');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

getChatId();
