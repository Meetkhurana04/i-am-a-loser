/**
 * Distraction Blocker - Content Script
 * Handles overlay display, voice recognition, and loudness detection
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const UNLOCK_PHRASE = "i'm a loser";

// Volume-to-duration mapping (dB to seconds)
const VOLUME_DURATION_MAP = [
  { minDb: -50, maxDb: -35, duration: 30, label: 'Whisper', emoji: '🤫' },
  { minDb: -35, maxDb: -25, duration: 60, label: 'Quiet', emoji: '😶' },
  { minDb: -25, maxDb: -15, duration: 120, label: 'Normal', emoji: '🗣️' },
  { minDb: -15, maxDb: -5, duration: 300, label: 'Loud', emoji: '📢' },
  { minDb: -5, maxDb: 0, duration: 600, label: 'SHOUTING!', emoji: '🔊' }
];

// ============================================================================
// STATE
// ============================================================================

let overlayElement = null;
let isOverlayVisible = false;
let currentDomain = null;
let countdownInterval = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let volumeSamples = [];
let isListening = false;
let recognition = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize content script
 */
async function init() {
  // Check if current page should be blocked
  const result = await chrome.runtime.sendMessage({
    action: 'checkBlocked',
    url: window.location.href
  });
  
  if (result.shouldBlock) {
    currentDomain = result.domain;
    showBlockOverlay();
  } else if (result.remainingTime > 0) {
    currentDomain = result.domain;
    startCountdownDisplay(result.remainingTime);
  }
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'showBlockOverlay':
      currentDomain = message.domain;
      showBlockOverlay();
      break;
      
    case 'hideBlockOverlay':
      hideBlockOverlay();
      if (message.remainingTime > 0) {
        startCountdownDisplay(message.remainingTime);
      }
      break;
      
    case 'updateCountdown':
      updateCountdown(message.remainingTime);
      break;
  }
  sendResponse({ received: true });
  return true;
});

// ============================================================================
// OVERLAY UI
// ============================================================================

/**
 * Create and show the block overlay
 */
function showBlockOverlay() {
  if (isOverlayVisible) return;
  
  // Create overlay container
  overlayElement = document.createElement('div');
  overlayElement.id = 'distraction-blocker-overlay';
  overlayElement.innerHTML = createOverlayHTML();
  
  // Add to page (at the end of body or to document element if body not ready)
  const parent = document.body || document.documentElement;
  parent.appendChild(overlayElement);
  
  // Attach event listeners
  attachOverlayEventListeners();
  
  isOverlayVisible = true;
  
  // Prevent scrolling
  document.body.style.overflow = 'hidden';
  
  console.log('[Blocker] Overlay shown for domain:', currentDomain);
}

/**
 * Create overlay HTML
 */
function createOverlayHTML() {
  return `
    <div class="blocker-content">
      <div class="blocker-icon"></div>
      <h1 class="blocker-title">SITE BLOCKED</h1>
      <p class="blocker-domain">${escapeHtml(currentDomain)}</p>
      <p class="blocker-message">
        This site is blocked to help you stay focused.<br>
        Want to access it anyway? You know what to do...
      </p>
      
      <div class="blocker-unlock-section">
        <button id="blocker-voice-btn" class="blocker-btn">
           Voice Unlock
        </button>
        <br>
        <p class="blocker-hint">
          Say the magic words <em>loudly</em> to unlock.<br>
          The louder you say it, the longer you get!
        </p>
      </div>
      
      <div id="blocker-listening" class="blocker-listening hidden">
        <div class="blocker-mic-animation">
          <div class="mic-circle"></div>
          <div class="mic-icon">🎤</div>
        </div>
        <p class="listening-text">Listening...</p>
        <p class="blocker-phrase">Say: "<strong>I'm a loser</strong>"</p>
        <div class="volume-meter">
          <div id="volume-bar" class="volume-bar"></div>
        </div>
        <p id="volume-label" class="volume-label">Volume: --</p>
        <button id="blocker-cancel-btn" class="blocker-btn secondary">Cancel</button>
      </div>
      
      <div id="blocker-result" class="blocker-result hidden">
        <div class="result-icon"></div>
        <p class="result-message"></p>
      </div>
      
      <div id="blocker-countdown" class="blocker-countdown hidden">
        <p class="countdown-label">Site unlocked for:</p>
        <div class="countdown-timer">
          <span id="countdown-value">00:00</span>
        </div>
      </div>
    </div>
    
    <div class="blocker-footer">
      <p>Distraction Blocker v1.0 | Click extension icon to manage settings</p>
    </div>
  `;
}

/**
 * Hide the block overlay
 */
function hideBlockOverlay() {
  if (overlayElement) {
    overlayElement.remove();
    overlayElement = null;
  }
  
  isOverlayVisible = false;
  document.body.style.overflow = '';
  
  // Clean up audio
  stopListening();
}

/**
 * Attach event listeners to overlay buttons
 */
function attachOverlayEventListeners() {
  const voiceBtn = document.getElementById('blocker-voice-btn');
  const cancelBtn = document.getElementById('blocker-cancel-btn');
  
  if (voiceBtn) {
    voiceBtn.addEventListener('click', startVoiceUnlock);
  }
  
  if (cancelBtn) {
    cancelBtn.addEventListener('click', cancelVoiceUnlock);
  }
}

// ============================================================================
// VOICE RECOGNITION & VOLUME DETECTION
// ============================================================================

/**
 * Start voice unlock process
 */
async function startVoiceUnlock() {
  console.log('[Blocker] Starting voice unlock');
  
  // Check for browser support
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  if (!SpeechRecognition) {
    showResult(false, 'Speech recognition not supported in this browser');
    return;
  }
  
  // Show listening UI
  document.querySelector('.blocker-unlock-section').classList.add('hidden');
  document.getElementById('blocker-listening').classList.remove('hidden');
  
  try {
    // Start audio capture for volume measurement
    await startAudioCapture();
    
    // Start speech recognition
    startSpeechRecognition(SpeechRecognition);
    
    isListening = true;
  } catch (error) {
    console.error('[Blocker] Error starting voice unlock:', error);
    showResult(false, 'Could not access microphone. Please allow microphone access.');
    cancelVoiceUnlock();
  }
}

/**
 * Start capturing audio for volume measurement
 */
async function startAudioCapture() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  microphone = audioContext.createMediaStreamSource(stream);
  microphone.connect(analyser);
  
  volumeSamples = [];
  
  // Start volume monitoring
  monitorVolume();
}

/**
 * Monitor volume levels continuously
 */
function monitorVolume() {
  if (!isListening || !analyser) return;
  
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);
  
  // Calculate RMS (Root Mean Square) for volume
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i] * dataArray[i];
  }
  const rms = Math.sqrt(sum / dataArray.length);
  
  // Convert to decibels (approximate)
  const db = 20 * Math.log10(rms / 255);
  
  // Store sample
  volumeSamples.push(db);
  
  // Update UI
  updateVolumeDisplay(db);
  
  // Continue monitoring
  if (isListening) {
    requestAnimationFrame(monitorVolume);
  }
}

/**
 * Update volume display in UI
 */
function updateVolumeDisplay(db) {
  const volumeBar = document.getElementById('volume-bar');
  const volumeLabel = document.getElementById('volume-label');
  
  if (!volumeBar || !volumeLabel) return;
  
  // Normalize dB to percentage (assuming -60dB to 0dB range)
  const percentage = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  
  volumeBar.style.width = `${percentage}%`;
  
  // Color based on volume
  if (percentage < 30) {
    volumeBar.style.backgroundColor = '#ff6b6b';
  } else if (percentage < 60) {
    volumeBar.style.backgroundColor = '#ffd93d';
  } else {
    volumeBar.style.backgroundColor = '#6bcb77';
  }
  
  // Get volume label
  const mapping = getVolumeDurationMapping(db);
  volumeLabel.textContent = `Volume: ${mapping.label} ${mapping.emoji} (${mapping.duration}s unlock)`;
}

/**
 * Get unlock duration based on volume
 */
function getVolumeDurationMapping(db) {
  for (const mapping of VOLUME_DURATION_MAP) {
    if (db >= mapping.minDb && db < mapping.maxDb) {
      return mapping;
    }
  }
  // Default to lowest if very quiet
  return VOLUME_DURATION_MAP[0];
}

/**
 * Calculate average volume from samples
 */
function calculateAverageVolume() {
  if (volumeSamples.length === 0) return -60;
  
  // Remove outliers and calculate average
  const sorted = [...volumeSamples].sort((a, b) => a - b);
  const trimmed = sorted.slice(
    Math.floor(sorted.length * 0.1),
    Math.floor(sorted.length * 0.9)
  );
  
  if (trimmed.length === 0) return sorted[Math.floor(sorted.length / 2)];
  
  const sum = trimmed.reduce((a, b) => a + b, 0);
  return sum / trimmed.length;
}

/**
 * Start speech recognition
 */
function startSpeechRecognition(SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  
  recognition.onresult = (event) => {
    let finalTranscript = '';
    let interimTranscript = '';
    
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }
    
    console.log('[Blocker] Heard:', finalTranscript || interimTranscript);
    
    if (finalTranscript) {
      validatePhrase(finalTranscript);
    }
  };
  
  recognition.onerror = (event) => {
    console.error('[Blocker] Speech recognition error:', event.error);
    
    if (event.error === 'not-allowed') {
      showResult(false, 'Microphone access denied. Please allow microphone access in your browser settings.');
    } else if (event.error === 'no-speech') {
      showResult(false, 'No speech detected. Please try again and speak clearly.');
    } else {
      showResult(false, `Error: ${event.error}. Please try again.`);
    }
    
    cancelVoiceUnlock();
  };
  
  recognition.onend = () => {
    if (isListening) {
      // Recognition ended without a result, restart or show error
      console.log('[Blocker] Recognition ended, no valid phrase detected');
    }
  };
  
  recognition.start();
}

/**
 * Validate the spoken phrase
 */
async function validatePhrase(transcript) {
  const normalizedTranscript = transcript.toLowerCase().trim();
  const normalizedPhrase = UNLOCK_PHRASE.toLowerCase().trim();
  
  console.log('[Blocker] Validating phrase:', normalizedTranscript);
  
  // Check for exact or close match
  const isMatch = normalizedTranscript.includes(normalizedPhrase) ||
    levenshteinDistance(normalizedTranscript, normalizedPhrase) <= 3;
  
  if (isMatch) {
    // Calculate unlock duration based on volume
    const avgVolume = calculateAverageVolume();
    const mapping = getVolumeDurationMapping(avgVolume);
    
    console.log('[Blocker] Phrase matched! Avg volume:', avgVolume, 'Duration:', mapping.duration);
    
    stopListening();
    
    // Unlock the site
    const result = await chrome.runtime.sendMessage({
      action: 'unlockSite',
      domain: currentDomain,
      duration: mapping.duration
    });
    
    if (result.success) {
      showResult(true, `${mapping.emoji} Unlocked for ${formatDuration(mapping.duration)}!`);
      
      // Hide overlay after a short delay
      setTimeout(() => {
        hideBlockOverlay();
        startCountdownDisplay(mapping.duration);
      }, 2000);
    } else {
      showResult(false, 'Failed to unlock. Please try again.');
      resetUnlockUI();
    }
  } else {
    showResult(false, `Wrong phrase! You said: "${transcript}"`);
    setTimeout(resetUnlockUI, 2000);
  }
}

/**
 * Cancel voice unlock process
 */
function cancelVoiceUnlock() {
  stopListening();
  resetUnlockUI();
}

/**
 * Stop all audio/recognition processes
 */
function stopListening() {
  isListening = false;
  
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {}
    recognition = null;
  }
  
  if (microphone) {
    microphone.disconnect();
    microphone = null;
  }
  
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  
  analyser = null;
  volumeSamples = [];
}

/**
 * Reset the unlock UI to initial state
 */
function resetUnlockUI() {
  const unlockSection = document.querySelector('.blocker-unlock-section');
  const listening = document.getElementById('blocker-listening');
  const result = document.getElementById('blocker-result');
  
  if (unlockSection) unlockSection.classList.remove('hidden');
  if (listening) listening.classList.add('hidden');
  if (result) result.classList.add('hidden');
}

/**
 * Show result message
 */
function showResult(success, message) {
  const listening = document.getElementById('blocker-listening');
  const result = document.getElementById('blocker-result');
  
  if (listening) listening.classList.add('hidden');
  if (result) {
    result.classList.remove('hidden');
    result.querySelector('.result-icon').textContent = success ? '✅' : '❌';
    result.querySelector('.result-message').textContent = message;
  }
}

// ============================================================================
// COUNTDOWN DISPLAY
// ============================================================================

/**
 * Start displaying countdown timer
 */
function startCountdownDisplay(seconds) {
  // Create floating countdown if not in overlay
  if (!isOverlayVisible) {
    createFloatingCountdown();
  }
  
  updateCountdownValue(seconds);
  
  // Clear any existing interval
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
  
  // Start countdown
  let remaining = seconds;
  countdownInterval = setInterval(() => {
    remaining--;
    
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      removeFloatingCountdown();
      
      // Show block overlay again
      showBlockOverlay();
    } else {
      updateCountdownValue(remaining);
    }
  }, 1000);
}

/**
 * Create floating countdown element
 */
function createFloatingCountdown() {
  let floating = document.getElementById('blocker-floating-countdown');
  
  if (!floating) {
    floating = document.createElement('div');
    floating.id = 'blocker-floating-countdown';
    floating.className = 'blocker-floating';
    floating.innerHTML = `
      <span class="floating-label">⏱️ Auto-block in: </span>
      <span id="floating-countdown-value">00:00</span>
    `;
    document.body.appendChild(floating);
  }
}

/**
 * Remove floating countdown
 */
function removeFloatingCountdown() {
  const floating = document.getElementById('blocker-floating-countdown');
  if (floating) {
    floating.remove();
  }
}

/**
 * Update countdown value in UI
 */
function updateCountdownValue(seconds) {
  const formatted = formatDuration(seconds);
  
  // Update in overlay if visible
  const overlayCountdown = document.getElementById('countdown-value');
  if (overlayCountdown) {
    overlayCountdown.textContent = formatted;
  }
  
  // Update floating countdown
  const floatingCountdown = document.getElementById('floating-countdown-value');
  if (floatingCountdown) {
    floatingCountdown.textContent = formatted;
  }
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
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Calculate Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  
  return dp[m][n];
}

// ============================================================================
// ANTI-BYPASS MEASURES
// ============================================================================

/**
 * Prevent closing overlay via dev tools
 */
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.removedNodes) {
      if (node.id === 'distraction-blocker-overlay' && isOverlayVisible) {
        // Re-add overlay if it was removed
        showBlockOverlay();
      }
    }
  }
});

// Observe document for changes
if (document.body) {
  observer.observe(document.body, { childList: true });
}

/**
 * Prevent keyboard shortcuts on overlay
 */
document.addEventListener('keydown', (e) => {
  if (isOverlayVisible) {
    // Block certain keyboard shortcuts that might bypass the overlay
    if (
      (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) || // Dev tools
      (e.ctrlKey && e.shiftKey && (e.key === 'J' || e.key === 'j')) || // Console
      (e.ctrlKey && (e.key === 'U' || e.key === 'u')) || // View source
      e.key === 'F12' // Dev tools
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}, true);

/**
 * Prevent right-click context menu on overlay
 */
document.addEventListener('contextmenu', (e) => {
  if (isOverlayVisible && overlayElement && overlayElement.contains(e.target)) {
    e.preventDefault();
  }
}, true);

// ============================================================================
// INITIALIZATION ON LOAD
// ============================================================================

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Also check on window load for SPAs
window.addEventListener('load', init);

// Handle visibility changes (when user returns to tab)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;

  // Extension context alive check
  if (!chrome?.runtime?.id) return;

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'checkBlocked',
      url: window.location.href
    });

    if (result?.shouldBlock && !isOverlayVisible) {
      currentDomain = result.domain;
      showBlockOverlay();
    } else if (!result?.shouldBlock && isOverlayVisible) {
      hideBlockOverlay();
    }

  } catch (err) {
    // Context invalidated / extension reloaded
    console.warn('Visibility check skipped:', err.message);
  }
});


console.log('[Blocker] Content script loaded');