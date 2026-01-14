/**
 * Distraction Blocker - Background Service Worker
 * Handles blocking logic, timer management, and cross-tab synchronization
 */

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

const DEFAULT_BLOCKED_SITES = [
  { domain: 'instagram.com', enabled: true, name: 'Instagram' },
  { domain: 'youtube.com', enabled: true, name: 'YouTube' },
  { domain: 'tiktok.com', enabled: true, name: 'TikTok' },
  { domain: 'twitter.com', enabled: true, name: 'Twitter' },
  { domain: 'x.com', enabled: true, name: 'X (Twitter)' },
  { domain: 'facebook.com', enabled: true, name: 'Facebook' },
  { domain: 'reddit.com', enabled: true, name: 'Reddit' }
];

const DEFAULT_SETTINGS = {
  enabled: true,
  unlockPhrase: "i'm a loser",
  blockedSites: DEFAULT_BLOCKED_SITES,
  // Volume thresholds and corresponding unlock times (in seconds)
  volumeThresholds: {
    quiet: { maxDb: -35, unlockTime: 30 },      // Whisper
    medium: { maxDb: -20, unlockTime: 120 },    // Normal voice
    loud: { maxDb: -10, unlockTime: 300 },      // Loud voice
    veryLoud: { maxDb: 0, unlockTime: 600 }     // Shouting
  }
};

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize extension on install or update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Blocker] Extension installed/updated:', details.reason);
  
  // Get existing settings or use defaults
  const existing = await chrome.storage.local.get(['settings', 'unlockTimers']);
  
  if (!existing.settings) {
    await chrome.storage.local.set({ 
      settings: DEFAULT_SETTINGS,
      unlockTimers: {} // { domain: { unlockedUntil: timestamp } }
    });
    console.log('[Blocker] Default settings initialized');
  }
  
  // Clean up any expired timers
  await cleanupExpiredTimers();
});

/**
 * Clean up expired unlock timers
 */
async function cleanupExpiredTimers() {
  const { unlockTimers = {} } = await chrome.storage.local.get('unlockTimers');
  const now = Date.now();
  let hasChanges = false;
  
  for (const domain in unlockTimers) {
    if (unlockTimers[domain].unlockedUntil <= now) {
      delete unlockTimers[domain];
      hasChanges = true;
    }
  }
  
  if (hasChanges) {
    await chrome.storage.local.set({ unlockTimers });
  }
}

// ============================================================================
// BLOCKING LOGIC
// ============================================================================

/**
 * Check if a URL matches any blocked domain
 */
function getBlockedDomain(url, blockedSites) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    for (const site of blockedSites) {
      if (!site.enabled) continue;
      
      // Match domain and subdomains
      if (hostname === site.domain || hostname.endsWith('.' + site.domain)) {
        return site.domain;
      }
    }
  } catch (e) {
    // Invalid URL
  }
  return null;
}

/**
 * Check if a domain is currently unlocked
 */
async function isDomainUnlocked(domain) {
  const { unlockTimers = {} } = await chrome.storage.local.get('unlockTimers');
  const timer = unlockTimers[domain];
  
  if (timer && timer.unlockedUntil > Date.now()) {
    return {
      unlocked: true,
      remainingTime: Math.ceil((timer.unlockedUntil - Date.now()) / 1000)
    };
  }
  
  return { unlocked: false, remainingTime: 0 };
}

/**
 * Check if a tab should be blocked
 */
async function shouldBlockTab(url) {
  const { settings } = await chrome.storage.local.get('settings');
  
  if (!settings || !settings.enabled) {
    return { shouldBlock: false };
  }
  
  const blockedDomain = getBlockedDomain(url, settings.blockedSites);
  
  if (!blockedDomain) {
    return { shouldBlock: false };
  }
  
  const unlockStatus = await isDomainUnlocked(blockedDomain);
  
  return {
    shouldBlock: !unlockStatus.unlocked,
    domain: blockedDomain,
    remainingTime: unlockStatus.remainingTime
  };
}

// ============================================================================
// TAB MONITORING
// ============================================================================

/**
 * Monitor navigation events to detect blocked sites
 */
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Only handle main frame navigation
  if (details.frameId !== 0) return;
  
  const blockStatus = await shouldBlockTab(details.url);
  
  if (blockStatus.shouldBlock) {
    // Notify content script to show overlay
    try {
      await chrome.tabs.sendMessage(details.tabId, {
        action: 'showBlockOverlay',
        domain: blockStatus.domain
      });
    } catch (e) {
      // Content script might not be ready yet
      console.log('[Blocker] Could not send message to tab:', e.message);
    }
  }
});

/**
 * Monitor tab updates (for SPA navigation)
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  
  const blockStatus = await shouldBlockTab(tab.url);
  
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: blockStatus.shouldBlock ? 'showBlockOverlay' : 'hideBlockOverlay',
      domain: blockStatus.domain,
      remainingTime: blockStatus.remainingTime
    });
  } catch (e) {
    // Ignore errors for tabs where content script isn't loaded
  }
});

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Handle messages from content scripts and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.action) {
    case 'checkBlocked':
      return await shouldBlockTab(message.url);
      
    case 'unlockSite':
      return await unlockSite(message.domain, message.duration);
      
    case 'getSettings':
      const { settings } = await chrome.storage.local.get('settings');
      return settings || DEFAULT_SETTINGS;
      
    case 'saveSettings':
      await chrome.storage.local.set({ settings: message.settings });
      return { success: true };
      
    case 'getUnlockStatus':
      return await isDomainUnlocked(message.domain);
      
    case 'getRemainingTime':
      const status = await isDomainUnlocked(message.domain);
      return { remainingTime: status.remainingTime };
      
    default:
      return { error: 'Unknown action' };
  }
}

/**
 * Unlock a site for a specified duration
 */
async function unlockSite(domain, durationSeconds) {
  const { unlockTimers = {} } = await chrome.storage.local.get('unlockTimers');
  
  unlockTimers[domain] = {
    unlockedUntil: Date.now() + (durationSeconds * 1000),
    unlockedAt: Date.now()
  };
  
  await chrome.storage.local.set({ unlockTimers });
  
  // Set an alarm to re-block the site when timer expires
  chrome.alarms.create(`reblock_${domain}`, {
    when: Date.now() + (durationSeconds * 1000)
  });
  
  console.log(`[Blocker] ${domain} unlocked for ${durationSeconds} seconds`);
  
  // Notify all tabs with this domain to hide overlay
  await notifyTabsForDomain(domain, 'hideBlockOverlay', durationSeconds);
  
  return { 
    success: true, 
    unlockedUntil: unlockTimers[domain].unlockedUntil,
    duration: durationSeconds
  };
}

/**
 * Notify all tabs matching a domain
 */
async function notifyTabsForDomain(domain, action, remainingTime = 0) {
  const tabs = await chrome.tabs.query({});
  
  for (const tab of tabs) {
    if (tab.url) {
      const { settings } = await chrome.storage.local.get('settings');
      const tabDomain = getBlockedDomain(tab.url, settings.blockedSites);
      
      if (tabDomain === domain) {
        try {
          await chrome.tabs.sendMessage(tab.id, { 
            action, 
            domain,
            remainingTime 
          });
        } catch (e) {
          // Ignore
        }
      }
    }
  }
}

// ============================================================================
// ALARM HANDLING (Re-blocking after unlock expires)
// ============================================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('reblock_')) {
    const domain = alarm.name.replace('reblock_', '');
    console.log(`[Blocker] Timer expired for ${domain}, re-blocking`);
    
    // Clean up the timer
    const { unlockTimers = {} } = await chrome.storage.local.get('unlockTimers');
    delete unlockTimers[domain];
    await chrome.storage.local.set({ unlockTimers });
    
    // Notify tabs to show overlay again
    await notifyTabsForDomain(domain, 'showBlockOverlay');
  }
});

// ============================================================================
// PERIODIC CLEANUP
// ============================================================================

// Clean up expired timers every minute
setInterval(cleanupExpiredTimers, 60000);

console.log('[Blocker] Background service worker initialized');