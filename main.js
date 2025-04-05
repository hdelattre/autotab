const FFT_SIZE = 8192;
const HOP_SIZE = FFT_SIZE / 4;
const DEFAULT_DISPLAY_WINDOW_SECONDS = 3;
const PLAYHEAD_FIXED_OFFSET_PX = 20;
const MIN_COLUMN_WIDTH_CALC = 6;
const MIN_COLUMN_WIDTH_RENDERED = 6.5;

let sampleRate = 44100;
let displayWindowSeconds = DEFAULT_DISPLAY_WINDOW_SECONDS;
let columnWidth = 0;
let labelWidthPx = 35;
let playbackRate = 1.0;
let columnElements = [];
let lastActiveIndex = -1;
let lastPrevActiveIndex = -1;
let lastNextActiveIndex = -1;
let effectiveColumnWidthCache = MIN_COLUMN_WIDTH_RENDERED;

// Import the MIDI player module
import { playTabAsMidi } from './midiPlayer.js';

/** @typedef {string[][]} GuitarTab - 2D array representing the guitar tab (6 strings, multiple columns) */
/** @typedef {{fret: string, sustained: boolean, isFirstNote: boolean}} TabNote - Processed note info */

/**
 * @param {number} time
 * @param {number} sampleRate
 * @param {number} hopSize
 * @returns {number}
 */
function timeToColumnIndex(time, sampleRate, hopSize) {
  // Calculate column index directly from audio parameters
  // Removing the 0.5 factor for correct time-to-column mapping
  return (time * sampleRate) / hopSize;
}

/**
 * @param {number} columnIndex
 * @param {number} sampleRate
 * @param {number} hopSize
 * @returns {number} Time position in seconds
 */
function columnIndexToTime(columnIndex, sampleRate, hopSize) {
  // The inverse of timeToColumnIndex
  return (columnIndex * hopSize) / sampleRate;
}

/**
 * @param {number} columnIndex
 * @returns {number} Scroll position in pixels
 */
function calculateScrollPosition(columnIndex) {
  // Define fixed playhead target position
  const fixedPlayheadViewportX = labelWidthPx + PLAYHEAD_FIXED_OFFSET_PX;

  // Use the cached effective width for better performance
  const effectiveColumnWidth = effectiveColumnWidthCache;

  // Split columnIndex into integer and fractional parts for precise interpolation
  const intColumnIndex = Math.floor(columnIndex);
  const fraction = columnIndex - intColumnIndex;

  // Calculate position using full precision (exact fractional position)
  // This ensures smooth scrolling between columns at high zoom levels
  const columnPositionPx = intColumnIndex * effectiveColumnWidth + (fraction * effectiveColumnWidth);

  // Calculate scroll position that would put this column at the fixed playhead position
  let scrollPosition = columnPositionPx - fixedPlayheadViewportX;

  // Handle edge cases - make sure we don't exceed scroll bounds
  const maxScroll = tabContainer.scrollWidth - tabContainer.clientWidth;
  scrollPosition = Math.max(0, Math.min(scrollPosition, maxScroll));

  // Use Math.round instead of floor for more accurate positioning
  return Math.round(scrollPosition);
}

const audioInput = document.getElementById('audioInput');
const audioPlayer = document.getElementById('audioPlayer');
const tabViewport = document.getElementById('tabViewport');
const tabContainer = document.getElementById('tabContainer');
const tabDisplay = document.getElementById('tabDisplay');
const timePosition = document.getElementById('timePosition');
const sensitivitySlider = document.getElementById('sensitivitySlider');
const sensitivityValue = document.getElementById('sensitivityValue');
const zoomSlider = document.getElementById('zoomSlider');
const zoomValue = document.getElementById('zoomValue');
const tempoSlider = document.getElementById('tempoSlider');
const tempoValue = document.getElementById('tempoValue');
const toggleMidiButton = document.getElementById('toggleMidiButton');
const smoothPlayhead = document.getElementById('smoothPlayhead');

// Web Worker (initialized lazily)
let worker = null;
// Cache for audio data
let cachedAudioData = null;
// Store the current guitar tab data and MIDI playback controller
let currentGuitarTab = null;
let midiPlayback = null;
// Animation frame request ID
let animationFrameId = null;

// Define a unified playhead state tracker
const playheadState = {
  // Current unified playhead position (in seconds)
  currentTime: 0,
  // Total duration of the content
  totalDuration: 0,
  // Last update timestamp for tracking elapsed time when manually updating
  lastUpdateTime: 0,
  // Is the playhead currently being updated by MIDI
  updatingFromMidi: false,
  // Current playback rate
  playbackRate: 1.0,

  // Method to update time from audio
  updateFromAudio: function(audioPlayer) {
    if (!this.updatingFromMidi) {
      this.currentTime = audioPlayer.currentTime;
      this.totalDuration = audioPlayer.duration;
    }
  },

  // Method to apply current playhead position to audio
  applyToAudio: function(audioPlayer) {
    audioPlayer.currentTime = this.currentTime;
  }
};

// Initialize on page load
window.addEventListener('load', () => {
  // Set initial slider values
  zoomValue.textContent = `${DEFAULT_DISPLAY_WINDOW_SECONDS.toFixed(1)} seconds`;
  sensitivityValue.textContent = `${(parseFloat(sensitivitySlider.value) * 100).toFixed(1)}%`;
  tempoValue.textContent = `${parseFloat(tempoSlider.value).toFixed(1)}x`;

  // Calculate initial column width
  calculateColumnWidth();

  // Set initial maximum zoom based on viewport size
  updateZoomSliderMax();

  // Set initial time position indicator with fixed offset from label
  const fixedTimePositionX = labelWidthPx + PLAYHEAD_FIXED_OFFSET_PX;
  timePosition.style.left = `${fixedTimePositionX}px`;

  // Hide the playhead initially until audio is loaded
  if (smoothPlayhead) {
    smoothPlayhead.style.display = 'none';
  }

  // Start the scroll animation loop to handle seeking even before playing
  if (animationFrameId === null) {
    animationFrameId = requestAnimationFrame(updateScroll);
  }

  // Add click handler for tab navigation
  tabContainer.addEventListener('click', handleTabClick);

  // Add listener for MIDI virtual time updates from standalone MIDI playback
  window.addEventListener('midiTimeUpdate', (event) => {
    if (event.detail) {
      // Update the unified playhead from MIDI events
      if (event.detail.currentTime !== undefined) {
        playheadState.currentTime = event.detail.currentTime;
        // Mark that MIDI is currently controlling the playhead
        playheadState.updatingFromMidi = event.detail.isPlaying === true;
      }
      if (event.detail.duration !== undefined) {
        playheadState.totalDuration = event.detail.duration;
      }
    }
  });
});


/**
 * @param {MouseEvent} event
 * @returns {void}
 */
function handleTabClick(event) {
  // Only process if we have loaded audio
  if (!audioPlayer.src || !currentGuitarTab) return;

  // Find if a column was clicked
  let clickTarget = event.target;
  if (!clickTarget.classList.contains('tab-column')) {
    // If not directly on a column, return early
    return;
  }

  // Get all columns to calculate index
  const columns = tabDisplay.querySelectorAll('.tab-column');
  const columnsArray = Array.from(columns);

  // Find the index of the clicked column
  const clickedColumn = columnsArray.indexOf(clickTarget);
  if (clickedColumn === -1) return;

  // Find which string (line) this is in
  const stringIndex = Math.floor(clickedColumn / (currentGuitarTab[0].length));

  // Calculate actual column index in the tab data
  const columnIndex = clickedColumn % currentGuitarTab[0].length;

  // Get more precise click position within the column (for better accuracy)
  const rect = clickTarget.getBoundingClientRect();
  const clickXWithinColumn = event.clientX - rect.left;

  // Get the effective column width for accurate pixel calculations
  const effectiveWidth = getEffectiveColumnWidth();

  // Calculate fraction of column (for sub-column precision)
  const fraction = clickXWithinColumn / effectiveWidth;
  const exactColumnIndex = columnIndex + fraction;

  // Convert column index to time
  const timePosition = columnIndexToTime(exactColumnIndex, sampleRate, HOP_SIZE);

  // Update unified playhead position
  playheadState.currentTime = timePosition;

  // If MIDI is not controlling playback, also update audio position
  if (!playheadState.updatingFromMidi) {
    // Set audio position
    audioPlayer.currentTime = timePosition;
  }

  // --- Immediate Visual Update ---
  // Force scroll position
  const scrollPos = calculateScrollPosition(exactColumnIndex);
  tabContainer.scrollLeft = scrollPos;

  // Force smooth playhead position update
  const playheadPixelX = (exactColumnIndex * effectiveColumnWidthCache) + labelWidthPx;
  smoothPlayhead.style.transform = `translateX(${playheadPixelX}px)`;
  smoothPlayhead.style.display = 'block'; // Ensure visible

  // Force background highlight update
  updateActiveColumn(Math.floor(exactColumnIndex));

  // If audio was playing and we're using MIDI, need to reset the MIDI playback
  if (!audioPlayer.paused && midiPlayback) {
    // Seeking is handled automatically by the MIDI player's seek event handler
  }
}

/**
 * @param {GuitarTab} guitarTab
 * @returns {void}
 */
function renderTab(guitarTab) {
  // Validate guitarTab structure
  if (!Array.isArray(guitarTab) || guitarTab.length !== 6 || !guitarTab.every(row => Array.isArray(row))) {
    console.error('Invalid guitarTab: Must be a 6-row 2D array');
    tabDisplay.innerHTML = '<pre>Error: Invalid tablature data</pre>';
    return;
  }

  const numColumns = guitarTab[0].length;
  const stringNames = ['e', 'B', 'G', 'D', 'A', 'E'];

  // Reset cache for column elements
  columnElements = [];
  tabDisplay.innerHTML = '';

  // Reset last indices when re-rendering
  lastActiveIndex = -1;
  lastPrevActiveIndex = -1;
  lastNextActiveIndex = -1;

  // Calculate expected column count based on audio duration (if we have audio loaded)
  let expectedColumns = numColumns;
  if (audioPlayer.duration) {
    expectedColumns = timeToColumnIndex(audioPlayer.duration, sampleRate, HOP_SIZE);
  }

  // Create tab for each string
  for (let s = 5; s >= 0; s--) {
    if (guitarTab[s].length !== numColumns) {
      console.warn(`String ${s} has inconsistent length`);
      continue;
    }

    const line = document.createElement('div');
    line.className = 'tab-line';
    const lineColumns = []; // Cache columns for this line

    // Add string label with fixed width for alignment
    const label = document.createElement('span');
    label.className = 'string-label';
    label.textContent = stringNames[5 - s].padEnd(2, ' ') + '|'; // Include the pipe in the label
    line.appendChild(label);

    // Process the tab data to identify sustained notes
    const processedTab = processSustainedNotes(guitarTab[s]);

    // Add each fret/note as a separate column with fixed width
    processedTab.forEach((fretInfo, i) => {
      const column = document.createElement('span');
      column.className = 'tab-column';
      // Make sure data-column attribute is set correctly for our position checks
      column.setAttribute('data-column', i);
      column.setAttribute('data-string', s);

      // Add appropriate classes and content based on note status
      if (fretInfo.sustained) {
        column.classList.add('sustained');
        // Use a horizontal line for sustained notes - shorter for narrow widths
        column.textContent = '-';

        // Store the actual fret number as a data attribute for reference
        if (fretInfo.actualFret) {
          column.setAttribute('data-fret', fretInfo.actualFret);
        }
      } else if (fretInfo.isFirstNote) {
        // This is the starting point of a note, add active class
        column.classList.add('note-start');
        // Don't pad the fret number to allow for narrower columns
        column.textContent = String(fretInfo.fret);
      } else {
        // This is an empty space
        column.textContent = String(fretInfo.fret);
      }

      line.appendChild(column);
      lineColumns.push(column); // Store reference to this column
    });

    // Add pipe after frets
    const endBar = document.createElement('span');
    endBar.textContent = '|';
    line.appendChild(endBar);

    tabDisplay.appendChild(line);

    // Store line's columns in our 2D array
    // 5-s to flip the order so columnElements[0] is the lowest string (E)
    columnElements[5-s] = lineColumns;
  }

  // Calculate the width needed for the entire song
  const tabWidth = numColumns * columnWidth;

  // If we have audio loaded, make sure tab width matches expected duration
  if (audioPlayer.duration) {
    // Ensure padding at the end to make the tab width correspond to audio duration
    const expectedWidth = expectedColumns * columnWidth;

    // Add explicit end marker that extends to full audio duration

  } else {
    // No audio - just add basic padding
    const padding = document.createElement('div');
    padding.style.height = '1px';
    padding.style.width = `${tabContainer.clientWidth}px`;
    padding.style.display = 'inline-block';
    tabDisplay.appendChild(padding);
  }

  // Measure the string label width after rendering
  const firstLabel = tabDisplay.querySelector('.string-label');
  if (firstLabel) {
    // Force reflow maybe needed if styles haven't applied yet
    const rect = firstLabel.getBoundingClientRect();
    // Use offsetWidth for integer width including padding/border if box-sizing is border-box
    labelWidthPx = firstLabel.offsetWidth;

    // Calculate column width and set the CSS variable
    calculateColumnWidth();

    // Check a sample column's actual rendered width
    const sampleColumn = columnElements[0]?.[Math.floor(numColumns / 2)]; // middle column
    if (sampleColumn) {
      // Force a reflow to get accurate measurements
      void tabContainer.offsetWidth;
      const actualWidth = sampleColumn.getBoundingClientRect().width;

      // Update MIN_COLUMN_WIDTH_RENDERED dynamically if we're at the minimum and can get a better measurement
      if (columnWidth === MIN_COLUMN_WIDTH_CALC && Math.abs(actualWidth - MIN_COLUMN_WIDTH_RENDERED) > 0.1) {
        // We can't change the constant, but we can create a temporary global variable with the same effect
        window.MIN_COLUMN_WIDTH_RENDERED_OVERRIDE = actualWidth;
        // Update effective width cache
        effectiveColumnWidthCache = actualWidth;
      }
    }

    // Force browser reflow to get the latest scrollWidth
    void tabContainer.offsetWidth;
  }
}

/**
 * @param {string[]} tabRow
 * @returns {TabNote[]}
 */
function processSustainedNotes(tabRow) {
  const result = [];

  for (let i = 0; i < tabRow.length; i++) {
    const currentFret = tabRow[i];

    if (currentFret === '-') {
      // Empty column (no note)
      result.push({
        fret: '-',
        sustained: false,
        isFirstNote: false
      });
    }
    else if (currentFret === '-' || currentFret.startsWith('s')) {
      // This is a sustained note (marked with '-' or with 's' prefix in legacy format)
      const fretNumber = currentFret.startsWith('s') ? currentFret.substring(1) : null;
      result.push({
        fret: '-', // Display as dash for sustained notes
        sustained: true,
        actualFret: fretNumber, // Store the actual fret number for reference (if available)
        isFirstNote: false
      });
    }
    else {
      // This is the first note of a new or continuing sequence
      result.push({
        fret: currentFret,
        sustained: false,
        isFirstNote: true
      });
    }
  }

  return result;
}

/**
 * @returns {number} Column width in pixels
 */
function calculateColumnWidth() {
  const viewportWidth = tabViewport.clientWidth;

  // Ensure sampleRate and hopSize are valid before dividing
  if (!sampleRate || !HOP_SIZE || !displayWindowSeconds) {
    console.warn("Cannot calculate column width without valid audio params/zoom.");
    return columnWidth || 20; // Return previous or default
  }

  // Calculate how many columns should be visible in the display window
  const columnsInWindow = (displayWindowSeconds * sampleRate) / HOP_SIZE;

  // Calculate width per column based on available space, accounting for labels
  const availableWidth = viewportWidth - labelWidthPx;

  // Ensure availableWidth and columnsInWindow are positive
  if (availableWidth <= 0 || columnsInWindow <= 0) {
    console.warn("Cannot calculate column width with zero/negative available space or columns.");
    return columnWidth || 20;
  }

  // Calculate width per column (ensure minimum size)
  columnWidth = Math.max(MIN_COLUMN_WIDTH_CALC, Math.floor(availableWidth / columnsInWindow));

  // Update the CSS variable on the container
  tabDisplay.style.setProperty('--column-width', `${columnWidth}px`);

  // --- Recalculate effective width ---
  let effectiveWidth = columnWidth;
  if (availableWidth > 0 && columnsInWindow > 0) {
    const idealWidth = availableWidth / columnsInWindow;
    if (Math.floor(idealWidth) < MIN_COLUMN_WIDTH_CALC) {
      effectiveWidth = window.MIN_COLUMN_WIDTH_RENDERED_OVERRIDE || MIN_COLUMN_WIDTH_RENDERED;
    }
  }
  effectiveColumnWidthCache = Math.max(effectiveWidth, 1); // Ensure > 0
  // --- End recalculation ---

  return columnWidth;
}

/**
 * Determines the effective column width for pixel-precise calculations
 * @returns {number} Effective column width in pixels
 */
function getEffectiveColumnWidth() {
  // Use cached value for better performance
  return effectiveColumnWidthCache;
}

/**
 * @returns {void}
 */
function updateScroll() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId); // Prevent duplicates if called rapidly
  }

  // Track if we're in MIDI-only mode
  const midiOnlyMode = midiPlayback && audioPlayer.paused;

  // Update the unified playhead from audio if needed
  if (!midiOnlyMode && audioPlayer.duration > 0) {
    playheadState.updateFromAudio(audioPlayer);
  }

  // Use playhead for all timing
  if ((sampleRate && audioPlayer.duration > 0 && currentGuitarTab) || midiOnlyMode) {
    // Get times from unified playhead
    let currentTime = playheadState.currentTime;
    let totalDuration = playheadState.totalDuration;

    // Fall back to calculated duration if needed
    if (totalDuration <= 0 && currentGuitarTab) {
      totalDuration = currentGuitarTab[0].length * HOP_SIZE / sampleRate;
    }

    // Calculate the exact column index for the current time (including fraction)
    const exactColumnIndex = timeToColumnIndex(currentTime, sampleRate, HOP_SIZE);

    // Calculate the current integer column index for the background highlighting
    const currentColumnIndex = Math.floor(exactColumnIndex);

    // Use calculateScrollPosition to determine where to scroll
    const desiredScrollLeft = calculateScrollPosition(exactColumnIndex);

    // Force scroll position if audio is playing OR if in MIDI-only mode
    // This allows manual scrolling when audio is paused (but not in MIDI-only mode)
    if (!audioPlayer.paused || midiOnlyMode) {
      tabContainer.scrollLeft = Math.round(desiredScrollLeft);
    }

    // --- Update Smooth Playhead Position ---
    // Calculate the exact pixel position relative to the start of tabDisplay
    // Add a small positive offset (10px) to align the playhead with the active column
    const playheadPixelX = (exactColumnIndex * effectiveColumnWidthCache) + labelWidthPx;
    // Apply using translateX for smooth animation
    smoothPlayhead.style.transform = `translateX(${playheadPixelX}px)`;
    // Make it visible only when audio is loaded/potentially playing or MIDI is playing
    smoothPlayhead.style.display = 'block';

    // Update time display
    const minutes = Math.floor(currentTime / 60);
    const seconds = Math.floor(currentTime % 60);
    const durationMin = Math.floor(totalDuration / 60);
    const durationSec = Math.floor(totalDuration % 60);
    timePosition.textContent = `${minutes}:${seconds.toString().padStart(2, '0')} / ${durationMin}:${durationSec.toString().padStart(2, '0')}`;

    // Position time display at fixed position
    const fixedPlayheadViewportX = labelWidthPx + PLAYHEAD_FIXED_OFFSET_PX;
    timePosition.style.left = `${fixedPlayheadViewportX}px`;

    // Update active column highlights (on integer column)
    updateActiveColumn(currentColumnIndex); // Main highlight
    //updateActiveColumn(currentColumnIndex - 1, 'prev-active');
    //updateActiveColumn(currentColumnIndex + 1, 'next-active');
  } else {
    // Hide playhead if no audio/tab loaded and not in MIDI-only mode
    if (smoothPlayhead) smoothPlayhead.style.display = 'none';
  }

  // Continue the loop even when paused (for seeking)
  animationFrameId = requestAnimationFrame(updateScroll);
}

/**
 * @param {number} columnIndex
 * @param {string} [className='active']
 * @returns {void}
 */
function updateActiveColumn(newColumnIndex, className = 'active') {
  if (newColumnIndex < 0) return; // Don't process negative indexes

  let lastIndexRef;
  let setLastIndex; // Function to update the correct last index variable

  // Determine which last index to use/update
  switch (className) {
    case 'active':
      lastIndexRef = lastActiveIndex;
      setLastIndex = (index) => { lastActiveIndex = index; };
      break;
    case 'prev-active':
      lastIndexRef = lastPrevActiveIndex;
      setLastIndex = (index) => { lastPrevActiveIndex = index; };
      break;
    case 'next-active':
      lastIndexRef = lastNextActiveIndex;
      setLastIndex = (index) => { lastNextActiveIndex = index; };
      break;
    default:
      return; // Unknown class
  }

  // If index hasn't changed, do nothing
  if (newColumnIndex === lastIndexRef) {
    return;
  }

  // Remove class from the *previous* column index (if valid)
  if (lastIndexRef >= 0 && lastIndexRef < (currentGuitarTab?.[0]?.length || 0)) {
    for (let s = 0; s < 6; s++) {
      const prevCol = columnElements[s]?.[lastIndexRef];
      if (prevCol) {
        prevCol.classList.remove(className);
        if (className === 'active') {
          //prevCol.classList.remove('playing'); // Also remove playing state
          prevCol.style.zIndex = ''; // Reset z-index to default
        } else if (className === 'prev-active' || className === 'next-active') {
          prevCol.style.zIndex = ''; // Reset z-index for adjacent columns too
        }
      }
    }
  }

  // Add class to the *new* column index (if valid)
  if (newColumnIndex >= 0 && newColumnIndex < (currentGuitarTab?.[0]?.length || 0)) {
    for (let s = 0; s < 6; s++) {
      const currentCol = columnElements[s]?.[newColumnIndex];
      if (currentCol) {
        // currentCol.classList.add(className);

        if (className === 'active') {
          // Bring active column to front, with higher value for note columns
          if (currentCol.classList.contains('note-start')) {
            currentCol.style.zIndex = '11'; // Note columns appear on top
          } else {
            currentCol.style.zIndex = '10'; // Standard active columns
          }

          // Handle 'playing' animation only for the main 'active' class
          if (currentCol.classList.contains('note-start') || currentCol.classList.contains('sustained')) {
            // Use a timeout or animationend listener for removal
            currentCol.classList.add('playing');
            setTimeout(() => {
              if (currentCol) currentCol.classList.remove('playing');
            }, 700); // Match animation duration
          }
        } else if (className === 'prev-active' || className === 'next-active') {
          // Adjacent columns get intermediate z-index
          currentCol.style.zIndex = '5';
        }
      }
    }
  }

  // Update the stored last index
  setLastIndex(newColumnIndex);
}

/**
 * Start MIDI playback in sync mode with the audio player
 * @returns {Promise<Object>} The MIDI playback controller
 */
async function startSyncedMidiPlayback() {
  try {
    // Set button to active state
    toggleMidiButton.textContent = 'Stop MIDI';
    toggleMidiButton.classList.add('active');

    // Create a label to show sync mode
    const syncLabel = document.createElement('span');
    syncLabel.className = 'sync-label';
    syncLabel.textContent = 'Synced with audio';
    toggleMidiButton.parentNode.appendChild(syncLabel);

    // Lower the audio track volume to hear the MIDI better
    const originalVolume = audioPlayer.volume;
    audioPlayer.dataset.originalVolume = originalVolume;
    audioPlayer.volume = Math.max(0.3, originalVolume * 0.6);

    // Play the tab as MIDI synchronized with the audio player
    const playback = await playTabAsMidi(currentGuitarTab, HOP_SIZE, sampleRate, audioPlayer);

    // Set up a handler to clean up when audio ends
    const audioEndHandler = () => {
      if (midiPlayback) {
        stopMidiPlayback();
        // Remove this handler
        audioPlayer.removeEventListener('ended', audioEndHandler);
      }
    };

    audioPlayer.addEventListener('ended', audioEndHandler);

    return playback;
  } catch (error) {
    console.error('Error starting synced MIDI playback:', error);

    cleanupMidiUI();

    return null;
  }
}

/**
 * Start MIDI playback in standalone mode
 * @param {number} startPosition - The position to start from (in seconds)
 * @returns {Promise<Object>} The MIDI playback controller
 */
async function startStandaloneMidiPlayback(startPosition) {
  try {
    // Set button to active state
    toggleMidiButton.textContent = 'Stop MIDI';
    toggleMidiButton.classList.add('active');

    // Create a label to show mode
    const syncLabel = document.createElement('span');
    syncLabel.className = 'sync-label';
    syncLabel.textContent = 'MIDI only';
    toggleMidiButton.parentNode.appendChild(syncLabel);

    // Play the tab as standalone MIDI without synchronization
    const playback = await playTabAsMidi(
      currentGuitarTab,
      HOP_SIZE,
      sampleRate,
      null,
      startPosition,
      playbackRate
    );

    const autoStopTimeoutId = setTimeout(() => {
      if (midiPlayback === playback) {
        stopMidiPlayback();
      }
    }, playback.remainingDuration * 1000 + 500);

    // Store the timeout ID in the playback object for cleanup
    playback.autoStopTimeoutId = autoStopTimeoutId;

    return playback;
  } catch (error) {
    console.error('Error starting standalone MIDI playback:', error);
    cleanupMidiUI();
    return null;
  }
}

/**
 * Main function to start MIDI playback in the appropriate mode
 */
async function startMidiPlayback() {
  if (midiPlayback) { return; }
  if (!currentGuitarTab) { return; }

  const currentPlayheadPosition = Math.max(0, playheadState.currentTime);
  if (!audioPlayer.paused) {
    midiPlayback = await startSyncedMidiPlayback();
  } else {
    midiPlayback = await startStandaloneMidiPlayback(currentPlayheadPosition);
  }

  if (!midiPlayback) {
    cleanupMidiUI();
  }
}

function stopMidiPlayback() {
  if (midiPlayback == null) { return; }

  // Clear any auto-stop timeout if present
  if (midiPlayback.autoStopTimeoutId) {
    clearTimeout(midiPlayback.autoStopTimeoutId);
    midiPlayback.autoStopTimeoutId = null;
  }

  // Stop the actual MIDI playback
  midiPlayback.stop();
  midiPlayback = null;

  cleanupMidiUI();

  // Restore original audio volume if it was changed
  if (audioPlayer.dataset.originalVolume) {
    audioPlayer.volume = parseFloat(audioPlayer.dataset.originalVolume);
    delete audioPlayer.dataset.originalVolume;
  }

  // Mark MIDI as no longer controlling the playhead
  playheadState.updatingFromMidi = false;

  // If audio is loaded, update the audio position to match the unified playhead
  if (audioPlayer.src && audioPlayer.duration > 0) {
    // Only set if the difference is significant
    if (Math.abs(audioPlayer.currentTime - playheadState.currentTime) > 0.1) {
      audioPlayer.currentTime = playheadState.currentTime;
    }
  }
}

function cleanupMidiUI() {
  toggleMidiButton.textContent = 'Play MIDI';
  toggleMidiButton.classList.remove('active');

  // Remove any sync mode label
  const existingLabels = document.querySelectorAll('.sync-label');
  existingLabels.forEach(label => label.parentNode.removeChild(label));
}

/**
 * Handles audio file input, processes it, and sends data to the worker.
 */
audioInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) {
    console.log('No file selected');
    return;
  }

  try {
    // Show loading state
    tabDisplay.innerHTML = '<pre>Loading...</pre>';

    // Reset the playback rate to default
    audioPlayer.playbackRate = 1.0;
    tempoSlider.value = 1.0;
    tempoValue.textContent = "1.0x";
    playbackRate = 1.0;

    // Set audio player source
    const audioURL = URL.createObjectURL(file);
    audioPlayer.src = audioURL;

    // Decode audio file
    const audioContext = new AudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer).catch(err => {
      throw new Error(`Failed to decode audio: ${err.message}`);
    });

    // Update sample rate and calculate column width based on file
    sampleRate = audioBuffer.sampleRate;
    displayWindowSeconds = parseFloat(zoomSlider.value);

    // Update zoom slider max based on new sample rate and viewport
    updateZoomSliderMax();

    // Calculate column width after updating max zoom
    columnWidth = calculateColumnWidth();

    const audioData = audioBuffer.getChannelData(0);

    // Create a copy of the audio data to cache
    cachedAudioData = new Float32Array(audioData.length);
    cachedAudioData.set(audioData);

    // Initialize worker if not already created
    if (!worker) {
      worker = new Worker('worker.js', { type: 'module' });
      worker.onmessage = (e) => {
        const { guitarTab } = e.data;

        // Store the guitar tab data for MIDI playback
        if (guitarTab) {
          currentGuitarTab = guitarTab;
          toggleMidiButton.disabled = false;
        }

        renderTab(guitarTab);

        // Initialize scroll animation when tab is first rendered
        if (animationFrameId === null) {
          animationFrameId = requestAnimationFrame(updateScroll);
        }
      };
      worker.onerror = (err) => {
        console.error('Worker error:', err);
        tabDisplay.innerHTML = '<pre>Error: Processing failed</pre>';
      };
    }

    // Send audio data to worker
    worker.postMessage({
      audioBuffer: audioData.buffer,
      sampleRate,
      fftSize: FFT_SIZE,
      hopSize: HOP_SIZE,
      sensitivity: parseFloat(sensitivitySlider.value),
    }, [audioData.buffer]);

  } catch (error) {
    console.error('Error processing audio:', error);
    tabDisplay.innerHTML = `<pre>Error: ${error.message}</pre>`;
  }
});

// Debounce function to limit reprocessing frequency
let sensitivityDebounceTimer = null;

// Update sensitivity when slider changes
sensitivitySlider.addEventListener('input', () => {
  const sensitivity = parseFloat(sensitivitySlider.value);
  sensitivityValue.textContent = `${(sensitivity * 100).toFixed(1)}%`;

  // Debounce the processing to avoid too frequent updates
  clearTimeout(sensitivityDebounceTimer);
  sensitivityDebounceTimer = setTimeout(() => {
    // If worker exists, update sensitivity directly (no need to reprocess audio data)
    if (worker) {
      // Show loading state
      tabDisplay.innerHTML = '<pre>Processing...</pre>';

      // Store the current MIDI state before reprocessing
      const wasMidiPlaying = midiPlayback !== null;
      const audioWasPlaying = !audioPlayer.paused;
      const currentTime = audioPlayer.currentTime;

      // If MIDI is playing, stop it - we'll restart it after reprocessing
      if (wasMidiPlaying) {
        stopMidiPlayback();
      }

      // With the new GuitarNoteDetector structure, we can update sensitivity without reprocessing audio
      worker.postMessage({
        updateSensitivity: true,
        sensitivity: sensitivity,  // Worker converts this to threshold config values
      });

      // When the worker responds with new data, the onmessage handler will update currentGuitarTab
      // Use the existing worker.onmessage handler to restart MIDI if it was playing
      const originalOnMessage = worker.onmessage;
      worker.onmessage = async (e) => {
        // Call the original handler to update the tab
        originalOnMessage(e);

        // Restore MIDI playback if it was active before
        if (wasMidiPlaying) {
          await startMidiPlayback();
        }

        // Restore worker's original onmessage handler
        worker.onmessage = originalOnMessage;
      };
    }
  }, 100); // Reduced debounce time since processing is much faster now
});

// Zoom slider event listener
zoomSlider.addEventListener('input', () => {
  displayWindowSeconds = parseFloat(zoomSlider.value);
  zoomValue.textContent = `${displayWindowSeconds.toFixed(1)} seconds`;

  // Only proceed if columnWidth could be calculated initially
  if (columnWidth > 0 && currentGuitarTab) { // Check if tab exists too
    // Update column width based on new zoom level
    const oldWidth = columnWidth;
    calculateColumnWidth(); // This now just updates the CSS variable

    // Only force reflow and update scroll if width actually changed
    // (The browser handles applying the CSS var change automatically)
    if (columnWidth !== oldWidth) {
      // Force reflow might still be needed before scroll update
      void tabContainer.offsetWidth;
      requestAnimationFrame(updateScroll);
    }
  } else {
    // If no tab loaded yet, just update the calculation for future use
    calculateColumnWidth();
  }
});

// Tempo slider event listener
tempoSlider.addEventListener('input', () => {
  playbackRate = parseFloat(tempoSlider.value);
  tempoValue.textContent = `${playbackRate.toFixed(1)}x`;

  // Update unified playhead state
  playheadState.playbackRate = playbackRate;

  // Apply new playback rate to audio
  if (audioPlayer.src) {
    audioPlayer.playbackRate = playbackRate;
  }

  // If standalone MIDI is playing, we need to stop and restart it with the new tempo
  if (midiPlayback && audioPlayer.paused) {
    const wasPlaying = true;
    // Stop current playback
    stopMidiPlayback();

    // Restart with new tempo
    if (wasPlaying) {
      setTimeout(() => {
        startMidiPlayback();
      }, 10);
    }
  }
  // If MIDI is playing with audio, the audio playback rate change triggers MIDI sync
});

// Playing state change handlers
audioPlayer.addEventListener('play', async () => {
  // Check if MIDI is currently playing
  const midiWasPlaying = midiPlayback !== null;

  // If MIDI is playing but not in sync mode, we need to restart it in sync mode
  if (midiWasPlaying) {
    // First stop the current MIDI playback
    stopMidiPlayback();

    // Now restart MIDI in sync mode with audio using our refactored function
    midiPlayback = await startSyncedMidiPlayback();

    if (!midiPlayback) {
      console.error('Failed to resync MIDI with audio');
    }
  } else {
    // Normal case - just update unified playhead to indicate audio is in control
    playheadState.updatingFromMidi = false;
    playheadState.updateFromAudio(audioPlayer);
  }
});

audioPlayer.addEventListener('pause', () => {
  // Update playhead with final position on pause
  if (!playheadState.updatingFromMidi) {
    playheadState.updateFromAudio(audioPlayer);
  }
});

audioPlayer.addEventListener('seeking', () => {
  if (sampleRate) {
    // Update unified playhead when seeking
    if (!playheadState.updatingFromMidi) {
      playheadState.updateFromAudio(audioPlayer);
    }

    const currentTime = playheadState.currentTime;
    const exactColumnIndex = timeToColumnIndex(currentTime, sampleRate, HOP_SIZE);
    const desiredScrollLeft = calculateScrollPosition(exactColumnIndex);

    // Force scroll position update
    tabContainer.scrollLeft = Math.round(desiredScrollLeft);

    // Force smooth playhead position update
    const playheadPixelX = (exactColumnIndex * effectiveColumnWidthCache) + labelWidthPx;
    smoothPlayhead.style.transform = `translateX(${playheadPixelX}px)`;
    smoothPlayhead.style.display = 'block'; // Ensure visible

    // Force background highlight update
    updateActiveColumn(Math.floor(exactColumnIndex));
  }
});

/**
 * Calculate the maximum supported zoom level based on viewport size
 * @returns {number} Maximum zoom in seconds
 */
function calculateMaxZoomLevel() {
  // Get the available space for columns
  const viewportWidth = tabViewport.clientWidth;
  const availableWidth = viewportWidth - labelWidthPx;

  // If we don't have space or necessary parameters, return a default
  if (availableWidth <= 0 || !sampleRate || !HOP_SIZE) {
    return 20; // Default max
  }

  // Calculate maximum zoom seconds
  // Formula: (available space in pixels / min column width) * (HOP_SIZE / sampleRate)
  // This tells us how many seconds can be displayed if all columns are at minimum width
  const columnsInView = availableWidth / MIN_COLUMN_WIDTH_CALC;
  const maxZoomSeconds = columnsInView * (HOP_SIZE / sampleRate);

  // Floor to nearest 0.5 to ensure we don't exceed what can be rendered properly
  return Math.max(1, Math.floor(maxZoomSeconds * 2) / 2);
}

/**
 * Update zoom slider's maximum value based on viewport size
 */
function updateZoomSliderMax() {
  const maxZoom = calculateMaxZoomLevel();

  // Only update if we have a meaningful difference (avoid circular events)
  if (Math.abs(parseFloat(zoomSlider.max) - maxZoom) > 0.1) {
    zoomSlider.max = maxZoom;

    // If current value exceeds new max, adjust it
    if (parseFloat(zoomSlider.value) > maxZoom) {
      zoomSlider.value = maxZoom;
      displayWindowSeconds = maxZoom;
      zoomValue.textContent = `${maxZoom.toFixed(1)} seconds`;
      calculateColumnWidth();
    }

  }
}

// Recalculate column width when window is resized
window.addEventListener('resize', () => {
  if (audioPlayer.src) {
    // Update zoom slider max first
    updateZoomSliderMax();

    // Recalculate column width, which updates the CSS variable
    calculateColumnWidth();

    // Update playhead and scroll position
    if (audioPlayer.duration > 0) {
      // Force an immediate update via updateScroll
      requestAnimationFrame(updateScroll);
    }
  }
});

// Toggle MIDI button event listener
toggleMidiButton.addEventListener('click', async () => {
  if (midiPlayback) {
    stopMidiPlayback();
  }
  else {
    await startMidiPlayback();
  }
});

// When starting the application, disable the MIDI button until data is available
toggleMidiButton.disabled = true;

// Handle theme toggle
const themeToggle = document.getElementById('themeToggle');

// Check for saved theme preference or use preferred color scheme
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.body.classList.add('dark-mode');
}

// Toggle dark/light mode
themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark-mode');
  const isDarkMode = document.body.classList.contains('dark-mode');
  localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
});

// Use more modern beforeunload or visibilitychange instead of unload
window.addEventListener('beforeunload', () => {
  // Clean up resources before page unload
  cleanupResources();
});

/**
 * @returns {void}
 */
function cleanupResources() {
  // Stop any active MIDI playback
  if (midiPlayback) {
    stopMidiPlayback();
  }

  // Cancel any active animation frame
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  // Terminate worker
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

// Also clean up when tab becomes hidden (better for mobile/modern browsers)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Stop MIDI playback when tab is hidden
    if (midiPlayback) {
      stopMidiPlayback();
    }

    audioPlayer.pause();
  }
});