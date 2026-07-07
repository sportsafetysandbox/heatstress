// content.js — Injected into the HEAT/SG dashboard page
//
// Acts as a bridge between the background service worker
// and the dashboard's JavaScript.

function requestCrowdData() {
  chrome.runtime.sendMessage({ type: 'GET_CROWD_DATA' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.crowdData) {
      window.dispatchEvent(new CustomEvent('heatsg:crowd', {
        detail: response.crowdData
      }));
    }
  });
}

// Dashboard can trigger a pull by dispatching heatsg:requestCrowd
window.addEventListener('heatsg:requestCrowd', () => requestCrowdData());

// Listen for real-time updates pushed from the background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CROWD_DATA_UPDATED' && msg.crowdData) {
    window.dispatchEvent(new CustomEvent('heatsg:crowd', {
      detail: msg.crowdData
    }));
  }
});

// Request data immediately and after a short delay for slow page loads
requestCrowdData();
setTimeout(requestCrowdData, 2000);
