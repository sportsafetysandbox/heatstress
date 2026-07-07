// scripts/fetch-crowd.js
//
// Fetches ActiveSG gym and pool crowd data and writes crowd-data.json.
// Run by GitHub Actions every 15 minutes during 0700–2200 SGT.

const fs = require('fs');
const path = require('path');

const ACTIVESG_URL = 'https://activesg.gov.sg/api/trpc/pass.getFacilityCapacities?input=%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D';
const OUTPUT_FILE  = path.join(__dirname, '..', 'crowd-data.json');

// Check if current time is within 0700–2200 SGT
function isOperatingHours() {
  const now = new Date();
  const sgtHour = (now.getUTCHours() + 8) % 24;
  return sgtHour >= 7 && sgtHour < 22;
}

async function fetchCrowd() {
  if (!isOperatingHours()) {
    console.log('Outside operating hours (0700–2200 SGT). Skipping fetch.');
    process.exit(0);
  }

  console.log('Fetching ActiveSG crowd data...');

  const res = await fetch(ACTIVESG_URL, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://activesg.gov.sg/gym-pool-crowd',
      'Origin': 'https://activesg.gov.sg',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
  });

  if (!res.ok) {
    console.error(`Fetch failed: HTTP ${res.status}`);
    // Write an error marker — dashboard will show "data unavailable"
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      error: true,
      status: res.status,
      updatedAt: new Date().toISOString(),
      gymFacilities: [],
      swimFacilities: []
    }, null, 2));
    process.exit(1);
  }

  const json = await res.json();
  const inner = json?.result?.data?.json || {};

  const output = {
    error: false,
    updatedAt: new Date().toISOString(),
    gymFacilities:  inner.gymFacilities  || [],
    swimFacilities: inner.swimFacilities || []
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`Done. ${output.gymFacilities.length} gyms, ${output.swimFacilities.length} pools. Saved to crowd-data.json`);
}

fetchCrowd().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
