const cron = require('node-cron');
const { scrapeAndStore } = require('./scraper'); // Export scrapeAndStore from scraper.js

console.log('PhilGEPS Automated Scheduler Started...');

// Runs automatically every day at 6:00 AM
cron.schedule('0 6 * * *', async () => {
  console.log('⏰ Scheduled Task: Starting daily PhilGEPS scrape...');
  try {
    await scrapeAndStore();
  } catch (err) {
    // Log and keep the scheduler alive for the next run
    console.error('❌ Scheduled scrape failed:', err.message);
  }
});
