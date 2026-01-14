/**
 * Distraction Blocker - Popup Script
 * Handles settings UI and user interactions
 */

// ============================================================================
// STATE
// ============================================================================

let settings = null;
let unlockTimers = {};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadUnlockTimers();
  renderUI();
  attachEventListeners();
  startTimerUpdates();
});

/**
 * Load settings from storage
 */
async function loadSettings() {
  const result = await chrome.runtime.sendMessage({ action: 'getSettings' });
  settings = result;
}

/**
 * Load current unlock timers
 */
async function loadUnlockTimers() {
  const result = await chrome.storage.local.get('unlockTimers');
  unlockTimers = result.unlockTimers || {};
}

/**
 * Save settings to storage
 */
async function saveSettings() {
  await chrome.runtime.sendMessage({ 
    action: 'saveSettings', 
    settings: settings 
  });
}

// ============================================================================
// UI RENDERING
// ============================================================================

/**
 * Render all UI elements
 */
function renderUI() {
  renderMasterToggle();
  renderSitesList();
  renderUnlockedSites();
  renderStats();
  renderUnlockPhrase();
}

/**
 * Render master toggle state
 */
function renderMasterToggle() {
  const toggle = document.getElementById('master-toggle');
  toggle.checked = settings.enabled;
}

/**
 * Render the list of blocked sites
 */
function renderSitesList() {
  const container = document.getElementById('sites-list');
  container.innerHTML = '';

  if (!settings.blockedSites || settings.blockedSites.length === 0) {
    container.innerHTML = '<p class="empty-message">No sites blocked yet</p>';
    return;
  }

  settings.blockedSites.forEach((site, index) => {
    const siteElement = document.createElement('div');
    siteElement.className = 'site-item';
    siteElement.innerHTML = `
      <label class="site-toggle">
        <input type="checkbox" 
               data-index="${index}" 
               ${site.enabled ? 'checked' : ''}>
        <span class="toggle-slider small"></span>
      </label>
      <span class="site-name">${escapeHtml(site.name || site.domain)}</span>
      <span class="site-domain">${escapeHtml(site.domain)}</span>
      <button class="btn-icon delete-site" data-index="${index}" title="Remove site">
         <i class="fa-solid fa-trash"></i>
      </button>
    `;
    container.appendChild(siteElement);
  });
}

/**
 * Render currently unlocked sites
 */
function renderUnlockedSites() {
  const container = document.getElementById('unlocked-list');
  const section = document.getElementById('unlocked-section');
  const now = Date.now();
  
  // Filter to only active unlocks
  const activeUnlocks = Object.entries(unlockTimers)
    .filter(([domain, timer]) => timer.unlockedUntil > now)
    .map(([domain, timer]) => ({
      domain,
      remaining: Math.ceil((timer.unlockedUntil - now) / 1000)
    }));

  if (activeUnlocks.length === 0) {
    container.innerHTML = '<p class="empty-message">No sites currently unlocked</p>';
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  container.innerHTML = '';

  activeUnlocks.forEach(({ domain, remaining }) => {
    const item = document.createElement('div');
    item.className = 'unlocked-item';
    item.innerHTML = `
      <span class="unlocked-domain">${escapeHtml(domain)}</span>
      <span class="unlocked-timer" data-domain="${domain}">
        ${formatDuration(remaining)}
      </span>
    `;
    container.appendChild(item);
  });
}

/**
 * Render unlock phrase setting
 */
function renderUnlockPhrase() {
  const input = document.getElementById('unlock-phrase');
  input.value = settings.unlockPhrase || "i'm a loser";
}

/**
 * Render stats (placeholder - would need actual tracking)
 */
function renderStats() {
  // These would normally come from storage
  // For now, using placeholder values
  document.getElementById('blocks-today').textContent = '0';
  document.getElementById('unlocks-today').textContent = '0';
  document.getElementById('time-saved').textContent = '0m';
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Attach all event listeners
 */
function attachEventListeners() {
  // Master toggle
  document.getElementById('master-toggle').addEventListener('change', handleMasterToggle);

  // Add site button
  document.getElementById('add-site-btn').addEventListener('click', handleAddSite);
  
  // Add site on Enter key
  document.getElementById('new-site-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddSite();
  });

  // Site list event delegation
  document.getElementById('sites-list').addEventListener('change', handleSiteToggle);
  document.getElementById('sites-list').addEventListener('click', handleSiteDelete);

  // Unlock phrase change
  document.getElementById('unlock-phrase').addEventListener('change', handlePhraseChange);

  // Reset stats
  document.getElementById('reset-stats-btn').addEventListener('click', handleResetStats);
}

/**
 * Handle master toggle change
 */
async function handleMasterToggle(e) {
  settings.enabled = e.target.checked;
  await saveSettings();
  
  // Update badge or icon based on state
  updateExtensionIcon();
}

/**
 * Handle adding a new site
 */
async function handleAddSite() {
  const input = document.getElementById('new-site-input');
  let domain = input.value.trim().toLowerCase();
  
  if (!domain) return;

  // Clean up the domain
  domain = domain
    .replace(/^https?:\/\//, '')  // Remove protocol
    .replace(/^www\./, '')         // Remove www
    .replace(/\/.*$/, '');         // Remove path

  // Validate domain format
  if (!isValidDomain(domain)) {
    showToast('Invalid domain format', 'error');
    return;
  }

  // Check for duplicates
  if (settings.blockedSites.some(site => site.domain === domain)) {
    showToast('Site already in list', 'error');
    return;
  }

  // Add the site
  settings.blockedSites.push({
    domain: domain,
    name: domain.charAt(0).toUpperCase() + domain.slice(1).replace(/\..*/, ''),
    enabled: true
  });

  await saveSettings();
  renderSitesList();
  
  input.value = '';
  showToast('Site added', 'success');
}

/**
 * Handle site toggle change
 */
async function handleSiteToggle(e) {
  if (e.target.type !== 'checkbox') return;
  
  const index = parseInt(e.target.dataset.index);
  if (isNaN(index)) return;

  settings.blockedSites[index].enabled = e.target.checked;
  await saveSettings();
}

/**
 * Handle site deletion
 */
async function handleSiteDelete(e) {
  if (!e.target.classList.contains('delete-site')) return;

  const index = parseInt(e.target.dataset.index);
  if (isNaN(index)) return;

  const site = settings.blockedSites[index];
  
  if (confirm(`Remove ${site.domain} from blocked list?`)) {
    settings.blockedSites.splice(index, 1);
    await saveSettings();
    renderSitesList();
    showToast('Site removed', 'success');
  }
}

/**
 * Handle unlock phrase change
 */
async function handlePhraseChange(e) {
  const phrase = e.target.value.trim().toLowerCase();
  
  if (phrase.length < 3) {
    showToast('Phrase must be at least 3 characters', 'error');
    e.target.value = settings.unlockPhrase;
    return;
  }

  settings.unlockPhrase = phrase;
  await saveSettings();
  showToast('Phrase updated', 'success');
}

/**
 * Handle stats reset
 */
async function handleResetStats() {
  if (confirm('Reset all statistics?')) {
    // Clear stats from storage
    await chrome.storage.local.set({ stats: {} });
    renderStats();
    showToast('Stats reset', 'success');
  }
}

// ============================================================================
// TIMER UPDATES
// ============================================================================

/**
 * Start periodic timer updates
 */
function startTimerUpdates() {
  setInterval(async () => {
    await loadUnlockTimers();
    updateTimerDisplays();
  }, 1000);
}

/**
 * Update all timer displays
 */
function updateTimerDisplays() {
  const now = Date.now();
  const timerElements = document.querySelectorAll('.unlocked-timer');

  timerElements.forEach(el => {
    const domain = el.dataset.domain;
    const timer = unlockTimers[domain];

    if (timer && timer.unlockedUntil > now) {
      const remaining = Math.ceil((timer.unlockedUntil - now) / 1000);
      el.textContent = formatDuration(remaining);
    } else {
      // Timer expired, re-render the list
      renderUnlockedSites();
    }
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format seconds to MM:SS or HH:MM:SS
 */
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Validate domain format
 */
function isValidDomain(domain) {
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
  // Remove existing toast
  const existingToast = document.querySelector('.toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  setTimeout(() => toast.classList.add('show'), 10);

  // Remove after delay
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

/**
 * Update extension icon based on state
 */
function updateExtensionIcon() {
  // Could change icon color/badge based on enabled state
  chrome.action.setBadgeText({
    text: settings.enabled ? '' : 'OFF'
  });
  
  chrome.action.setBadgeBackgroundColor({
    color: '#ff6b6b'
  });
}

console.log('[Blocker] Popup script loaded');