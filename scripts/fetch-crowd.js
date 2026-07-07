// scripts/fetch-crowd.js
//
// Fetches ActiveSG gym and pool crowd data and writes crowd-data.json.
// Strategy 1: Direct tRPC API call
// Strategy 2: Fetch page HTML and extract __NEXT_DATA__ embedded JSON
// Strategy 3: Write graceful error so dashboard shows "unavailable"

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const zlib  = require('zlib');

const ACTIVESG_API  = 'https://activesg.gov.sg/api/trpc/pass.getFacilityCapacities?input=%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D';
const ACTIVESG_PAGE = 'https://activesg.gov.sg/gym-pool-crowd';
const OUTPUT_FILE   = path.join(__dirname, '..', 'crowd-data.json');

// Check operating hours (0700–2200 SGT = UTC+8)
function isOperatingHours() {
  const sgtHour = (new Date().getUTCHours() + 8) % 24;
  return sgtHour >= 7 && sgtHour < 22;
}

// Fetch with gzip decompression and redirect following
function fetchUrl(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return fetchUrl(next, headers, redirects + 1).then(resolve).catch(reject);
      }
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')   stream = res.pipe(zlib.createGunzip());
      if (enc === 'br')     stream = res.pipe(zlib.createBrotliDecompress());
      if (enc === 'deflate')stream = res.pipe(zlib.createInflate());
      let body = '';
      stream.on('data', c => body += c);
      stream.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function writeOutput(data) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log('Written to crowd-data.json');
}

// Strategy 1: Direct API fetch
async function tryAPIFetch() {
  console.log('\n--- Strategy 1: Direct API fetch ---');
  const res = await fetchUrl(ACTIVESG_API, {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Origin': 'https://activesg.gov.sg',
    'Referer': 'https://activesg.gov.sg/gym-pool-crowd',
    'sec-ch-ua': '"Chromium";v="125"',
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  });
  console.log('Status:', res.status);
  console.log('Body preview:', res.body.slice(0, 200));
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(res.body);
  const inner = json?.result?.data?.json || {};
  if (!inner.gymFacilities?.length) throw new Error('No gymFacilities in response');
  return inner;
}

// Strategy 2: Page HTML scrape
async function tryPageScrape() {
  console.log('\n--- Strategy 2: Page HTML scrape ---');
  const res = await fetchUrl(ACTIVESG_PAGE, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="125"',
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  console.log('Status:', res.status);
  console.log('Has __NEXT_DATA__:', res.body.includes('__NEXT_DATA__'));
  console.log('Has gymFacilities:', res.body.includes('gymFacilities'));
  console.log('Has CF challenge:', res.body.includes('cf-chl') || res.body.includes('Just a moment'));
  console.log('Body preview:', res.body.slice(0, 300));

  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

  // Try __NEXT_DATA__ first
  const nextMatch = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    const nextData = JSON.parse(nextMatch[1]);
    const props = nextData?.props?.pageProps;
    if (props?.gymFacilities?.length) return props;

    // Check dehydrated React Query cache
    const queries = props?.dehydratedState?.queries || [];
    for (const q of queries) {
      const d = q?.state?.data;
      const inner = d?.gymFacilities ? d : d?.result?.data?.json;
      if (inner?.gymFacilities?.length) return inner;
    }
  }

  // Try inline JSON containing gymFacilities
  const gymMatch = res.body.match(/"gymFacilities":(\[[\s\S]*?\]),"swimFacilities"/);
  const poolMatch = res.body.match(/"swimFacilities":(\[[\s\S]*?\])/);
  if (gymMatch && poolMatch) {
    return {
      gymFacilities:  JSON.parse(gymMatch[1]),
      swimFacilities: JSON.parse(poolMatch[1])
    };
  }

  throw new Error('Could not extract facility data from page HTML');
}

async function main() {
  console.log('=== ActiveSG Crowd Data Fetcher ===');
  console.log('Time (UTC):', new Date().toISOString());
  console.log('Time (SGT):', new Date(Date.now() + 8*60*60*1000).toISOString().replace('T',' ').slice(0,19));

  if (!isOperatingHours()) {
    console.log('Outside operating hours (0700–2200 SGT). Skipping.');
    process.exit(0);
  }

  let facilities = null;

  try { facilities = await tryAPIFetch(); console.log('Strategy 1 succeeded.'); }
  catch(e) { console.warn('Strategy 1 failed:', e.message); }

  if (!facilities) {
    try { facilities = await tryPageScrape(); console.log('Strategy 2 succeeded.'); }
    catch(e) { console.warn('Strategy 2 failed:', e.message); }
  }

  if (!facilities) {
    console.error('\nAll strategies failed. Writing error state.');
    writeOutput({ error: true, updatedAt: new Date().toISOString(), gymFacilities: [], swimFacilities: [] });
    process.exit(1);
  }

  writeOutput({
    error: false,
    updatedAt: new Date().toISOString(),
    gymFacilities:  facilities.gymFacilities  || [],
    swimFacilities: facilities.swimFacilities || []
  });
  console.log(`\nSuccess: ${facilities.gymFacilities?.length} gyms, ${facilities.swimFacilities?.length} pools`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
