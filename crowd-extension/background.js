// background.js — Service worker for HEAT/SG Crowd Feeder
//
// Fetches ActiveSG crowd data and caches it in chrome.storage.local.
// Runs on a 15-minute alarm and also on demand when the dashboard asks.

const ACTIVESG_URL = 'https://activesg.gov.sg/api/trpc/pass.getFacilityCapacities?input=%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D';
const ALARM_NAME   = 'crowd-refresh';
const INTERVAL_MIN = 15;

// Set up the recurring alarm when the extension installs or starts
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: INTERVAL_MIN });
  fetchAndCache(); // Fetch immediately on install
});

chrome.runtime.onStartup.addListener(() => {
  fetchAndCache();
});

// Fetch on alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) fetchAndCache();
});

// Respond to messages from the content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_CROWD_DATA') {
    chrome.storage.local.get('crowdData', (result) => {
      sendResponse({ crowdData: result.crowdData || null });
    });
    return true; // Keep channel open for async response
  }
  if (msg.type === 'REFRESH_NOW') {
    fetchAndCache().then(() => {
      chrome.storage.local.get('crowdData', (result) => {
        sendResponse({ crowdData: result.crowdData || null });
      });
    });
    return true;
  }
});

async function fetchAndCache() {
  try {
    console.log('[HEAT/SG] Fetching crowd data...');
    const res = await fetch(ACTIVESG_URL, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://activesg.gov.sg/gym-pool-crowd',
        'Origin': 'https://activesg.gov.sg'
      },
      credentials: 'include' // Include the Cloudflare cookie
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const inner = json?.result?.data?.json || {};

    if (!inner.gymFacilities?.length) throw new Error('No facility data in response');

    const crowdData = {
      error: false,
      updatedAt: new Date().toISOString(),
      gymFacilities:  inner.gymFacilities  || [],
      swimFacilities: inner.swimFacilities || []
    };

    await chrome.storage.local.set({ crowdData });
    console.log(`[HEAT/SG] Cached: ${crowdData.gymFacilities.length} gyms, ${crowdData.swimFacilities.length} pools`);

    // Notify any open dashboard tabs
    notifyDashboardTabs(crowdData);

  } catch (err) {
    console.error('[HEAT/SG] Fetch failed:', err.message);
    const crowdData = {
      error: true,
      message: err.message,
      updatedAt: new Date().toISOString(),
      gymFacilities:  [],
      swimFacilities: []
    };
    await chrome.storage.local.set({ crowdData });
  }
}

function notifyDashboardTabs(crowdData) {
  chrome.tabs.query({ url: 'https://sportsafetysandbox.github.io/heatstress/*' }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'CROWD_DATA_UPDATED', crowdData })
        .catch(() => {}); // Tab may not have content script ready yet
    });
  });
}
