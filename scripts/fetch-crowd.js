// scripts/fetch-crowd.js
//
// Fetches ActiveSG gym and pool crowd data and writes crowd-data.json.
// Strategy 1: Call the tRPC API directly
// Strategy 2: Fetch the page HTML and extract __NEXT_DATA__ embedded JSON
// Strategy 3: If both fail, write a graceful error so dashboard shows "unavailable"

const fs   = require('fs');
const path = require('path');
const https = require('https');

const ACTIVESG_API  = 'https://activesg.gov.sg/api/trpc/pass.getFacilityCapacities?input=%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D';
const ACTIVESG_PAGE = 'https://activesg.gov.sg/gym-pool-crowd';
const OUTPUT_FILE   = path.join(__dirname, '..', 'crowd-data.json');

const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Referer': 'https://activesg.gov.sg/',
  'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive'
};

const API_HEADERS = {
  ...BROWSER_HEADERS,
  'Accept': 'application/json, text/plain, */*',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'Origin': 'https://activesg.gov.sg',
  'Referer': 'https://activesg.gov.sg/gym-pool-crowd',
};
delete API_HEADERS['upgrade-insecure-requests'];

// Check operating hours (0700–2200 SGT)
function isOperatingHours() {
  const now = new Date();
  const sgtHour = (now.getUTCHours() + 8) % 24;
  return sgtHour >= 7 && sgtHour < 22;
}

// Simple fetch wrapper using Node's built-in https
function fetchUrl(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, headers).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function writeOutput(data) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log('Written to', OUTPUT_FILE);
}

async function tryAPIFetch() {
  console.log('Strategy 1: Direct API fetch...');
  const res = await fetchUrl(ACTIVESG_API, API_HEADERS);
  console.log('  Status:', res.status);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(res.body);
  const inner = json?.result?.data?.json || {};
  if (!inner.gymFacilities) throw new Error('No gymFacilities in response');
  return inner;
}

async function tryPageScrape() {
  console.log('Strategy 2: Page HTML scrape for __NEXT_DATA__...');
  const res = await fetchUrl(ACTIVESG_PAGE, BROWSER_HEADERS);
  console.log('  Status:', res.status);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

  // Next.js embeds server-side props in <script id="__NEXT_DATA__">
  const match = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('__NEXT_DATA__ not found in page');

  const nextData = JSON.parse(match[1]);
  // Navigate the Next.js data structure to find facility capacities
  const props = nextData?.props?.pageProps;
  if (props?.gymFacilities) return props;

  // Try dehydrated React Query cache
  const dehydrated = props?.dehydratedState?.queries || [];
  for (const q of dehydrated) {
    const data = q?.state?.data;
    if (data?.gymFacilities || data?.result?.data?.json?.gymFacilities) {
      return data?.gymFacilities ? data : data.result.data.json;
    }
  }
  throw new Error('Facility data not found in __NEXT_DATA__');
}

async function main() {
  if (!isOperatingHours()) {
    console.log('Outside operating hours (0700–2200 SGT). Skipping.');
    process.exit(0);
  }

  let facilities = null;

  // Try Strategy 1
  try {
    facilities = await tryAPIFetch();
    console.log('Strategy 1 succeeded.');
  } catch(e) {
    console.warn('Strategy 1 failed:', e.message);
  }

  // Try Strategy 2 if Strategy 1 failed
  if (!facilities) {
    try {
      facilities = await tryPageScrape();
      console.log('Strategy 2 succeeded.');
    } catch(e) {
      console.warn('Strategy 2 failed:', e.message);
    }
  }

  if (!facilities) {
    console.error('All strategies failed. Writing error state.');
    writeOutput({
      error: true,
      updatedAt: new Date().toISOString(),
      gymFacilities: [],
      swimFacilities: []
    });
    process.exit(1);
  }

  writeOutput({
    error: false,
    updatedAt: new Date().toISOString(),
    gymFacilities:  facilities.gymFacilities  || [],
    swimFacilities: facilities.swimFacilities || []
  });

  console.log(`Success: ${facilities.gymFacilities?.length || 0} gyms, ${facilities.swimFacilities?.length || 0} pools`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
