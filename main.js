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
let effectiveColumnWidthCache = MIN_COLUMN_WIDTH_RENDERED;

// Import new MIDI player, virtual scroller, and MIDI exporter
import { MidiPlayer } from './midiPlayer.js';
import { VirtualScroller } from './virtualScroller.js';
import { MidiExporter } from './midiExporter.js';

/** @typedef {string[][]} GuitarTab - 2D array representing the guitar tab (6 strings, multiple columns) */
/** @typedef {{fret: string, sustained: boolean, isFirstNote: boolean}} TabNote - Processed note info */

/**
 * @param {number} time
 * @returns {number}
 */
function timeToColumnIndex(time) {
  return (time * sampleRate) / HOP_SIZE;
}

/**
 * @param {number} idx
 * @returns {number} Time position in seconds
 */
function columnIndexToTime(idx) {
  return (idx * HOP_SIZE) / sampleRate;
}

/**
 * @param {number} idx
 * @returns {number} Scroll position in pixels
 */
function calculateScrollPosition(idx) {
  const fixedX = labelWidthPx + PLAYHEAD_FIXED_OFFSET_PX;
  // Use the actual column width that matches the CSS, not the effective width
  const actualColumnWidth = columnWidth || MIN_COLUMN_WIDTH_CALC;
  const px = idx * actualColumnWidth; // Simplified - idx already includes fraction
  let scrollPos = px - fixedX;
  const maxScroll = tabContainer.scrollWidth - tabContainer.clientWidth;
  scrollPos = Math.max(0, Math.min(scrollPos, maxScroll));
  return scrollPos; // Don't round for smoother scrolling
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
const exportMidiButton = document.getElementById('exportMidiButton');
const editModeButton = document.getElementById('editModeButton');
const smoothPlayhead = document.getElementById('smoothPlayhead');

// Web Worker (initialized lazily)
let worker = null;
// Cache for audio data
let cachedAudioData = null;
// Store the current guitar tab data and MIDI playback controller
let currentGuitarTab = null;
let currentNotes = null;
let currentChords = null;
let currentConfidenceMap = null;
let midiPlayer = null;
// Animation frame request ID
let animationFrameId = null;
// Virtual scroller instance
let virtualScroller = null;
let useVirtualScrolling = true; // Feature flag
// MIDI exporter instance
let midiExporter = new MidiExporter();
// Edit mode state
let isEditMode = false;


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

// Ensure worker function
function ensureWorker() {
  if (worker) return;
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    if (e.data.error) {
      console.error(e.data.error);
      tabDisplay.innerHTML = `<pre>Error: ${e.data.error}</pre>`;
      return;
    }
    const { guitarTab, notes, chords, confidenceMap } = e.data;
    currentGuitarTab = guitarTab;
    currentNotes = notes;
    currentChords = chords;
    currentConfidenceMap = confidenceMap;
    toggleMidiButton.disabled = !guitarTab;
    exportMidiButton.disabled = !guitarTab;
    renderTab(guitarTab, confidenceMap);
  };
  worker.onerror = (err) => {
    console.error(err);
    tabDisplay.innerHTML = '<pre>Error: Processing failed</pre>';
  };
}

// Global event listeners (only added once)
let midiTimeUpdateHandler = null;
let tabClickHandler = null;

// Initialize on page load
window.addEventListener('load', () => {
  // Set initial slider values
  zoomValue.textContent = `${DEFAULT_DISPLAY_WINDOW_SECONDS.toFixed(1)} seconds`;
  sensitivityValue.textContent = `${(parseFloat(sensitivitySlider.value) * 100).toFixed(0)}%`;
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

  // Add click handler for tab navigation (only once)
  if (!tabClickHandler) {
    tabClickHandler = handleTabClick;
    tabContainer.addEventListener('click', tabClickHandler);
  }

  // Listen for MIDI-specific events (only once)
  if (!midiTimeUpdateHandler) {
    midiTimeUpdateHandler = (event) => {
      if (event.detail && midiPlayer) {
        // MIDI player time update
        playheadState.currentTime = event.detail.currentTime;
        playheadState.updatingFromMidi = event.detail.isPlaying && midiPlayer;
      }
    };
    window.addEventListener('midiTimeUpdate', midiTimeUpdateHandler);
  }
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

  // Get the column index directly from the data attribute
  const columnIndex = parseInt(clickTarget.dataset.column);
  const stringIndex = parseInt(clickTarget.dataset.string);

  if (isNaN(columnIndex) || isNaN(stringIndex)) return;

  // Check if we're in edit mode
  if (isEditMode) {
    // Edit mode: allow editing the note
    handleEditNote(stringIndex, columnIndex, clickTarget);
    return;
  }

  // Normal mode: seek to position
  // Get more precise click position within the column (for better accuracy)
  const rect = clickTarget.getBoundingClientRect();
  const clickXWithinColumn = event.clientX - rect.left;

  // Get the actual column width for accurate pixel calculations
  const actualColumnWidth = columnWidth || MIN_COLUMN_WIDTH_CALC;

  // Calculate fraction of column (for sub-column precision)
  const fraction = clickXWithinColumn / actualColumnWidth;
  const exactColumnIndex = columnIndex + fraction;

  // Convert column index to time
  const timePosition = columnIndexToTime(exactColumnIndex);

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
  const playheadPixelX = (exactColumnIndex * actualColumnWidth) + labelWidthPx;
  smoothPlayhead.style.transform = `translateX(${playheadPixelX}px)`;
  smoothPlayhead.style.display = 'block'; // Ensure visible

  // Force background highlight update
  updateActiveColumn(Math.floor(exactColumnIndex));

  // If audio was playing and we're using MIDI, seeking is handled automatically
}

/**
 * Handle editing a note in edit mode
 * @param {number} stringIndex - The string index (0-5, where 0 is high E)
 * @param {number} columnIndex - The column index
 * @param {HTMLElement} clickTarget - The clicked element
 * @returns {void}
 */
function handleEditNote(stringIndex, columnIndex, clickTarget) {
  if (!currentGuitarTab) return;
  
  // Prevent multiple inputs
  if (clickTarget.querySelector('input')) return;
  
  // Get current value
  const currentValue = currentGuitarTab[stringIndex][columnIndex];
  
  // Create inline input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit-input';
  input.value = currentValue === '-' ? '' : currentValue;
  input.maxLength = 2;
  
  // Store original content
  const originalContent = clickTarget.textContent;
  
  // Replace content with input
  clickTarget.textContent = '';
  clickTarget.appendChild(input);
  
  // Focus and select
  input.focus();
  input.select();
  
  let updateValue = (value) => {
    input.remove();
    
    let prevNoteColumn = -1;
    
    // Check if MIDI is playing and we need to restart it
    const wasMidiPlaying = midiPlayer && midiPlayer.isPlaying;
    let midiStartTime = 0;
    if (wasMidiPlaying) {
      midiStartTime = midiPlayer.getCurrentTime();
    }
    
    // Validate and update
    if (value === '' || value === '-') {
      currentGuitarTab[stringIndex][columnIndex] = '-';
      // Clear any sustained notes to the right
      for (let col = columnIndex + 1; col < currentGuitarTab[stringIndex].length; col++) {
        const val = currentGuitarTab[stringIndex][col];
        if (val === '~') {
          // This is a sustained note marker, clear it
          currentGuitarTab[stringIndex][col] = '-';
        } else {
          // Hit a new note or dash, stop clearing
          break;
        }
      }
    } else if (value === '~') {
      // Find the previous note to extend
      for (let col = columnIndex - 1; col >= 0; col--) {
        const val = currentGuitarTab[stringIndex][col];
        if (val !== '-' && !isNaN(parseInt(val))) {
          prevNoteColumn = col;
          break;
        }
      }
      
      if (prevNoteColumn >= 0) {
        // Fill all positions between the previous note and current position with sustained markers
        for (let col = prevNoteColumn + 1; col <= columnIndex; col++) {
          currentGuitarTab[stringIndex][col] = '~';
        }
      } else {
        // No previous note to extend, make it a dash
        currentGuitarTab[stringIndex][columnIndex] = '-';
      }
    } else {
      const fretNum = parseInt(value);
      if (!isNaN(fretNum) && fretNum >= 0 && fretNum <= 24) {
        currentGuitarTab[stringIndex][columnIndex] = fretNum.toString();
      } else {
        // Restore original if invalid
        clickTarget.textContent = originalContent;
        return;
      }
    }
    
    
    // Re-render the tab to ensure proper visual update
    renderTab(currentGuitarTab);
    
    // Restart MIDI if it was playing
    if (wasMidiPlaying) {
      // Stop current playback
      midiPlayer.stop();
      
      // Small delay to ensure visual updates are complete
      setTimeout(async () => {
        if (audioPlayer && !audioPlayer.paused) {
          // Synced mode
          await startSyncedMidiPlayback();
        } else {
          // Standalone mode
          await startStandaloneMidiPlayback(midiStartTime);
        }
      }, 50);
    }
  };
  
  // Use flag to prevent double processing
  let processed = false;
  
  // Handle input events
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (!processed) {
        processed = true;
        updateValue(input.value);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      processed = true; // Mark as processed to skip blur handler
      if (input.parentNode) {
        input.remove();
      }
      clickTarget.textContent = originalContent;
    } else if (!/[0-9-~]/.test(e.key) && !['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
    }
  });
  
  input.addEventListener('blur', () => {
    if (!processed) {
      processed = true;
      updateValue(input.value);
    }
  });
}

/**
 * Update sustained note markers after an edit
 * @param {number} stringIndex - The string index
 * @param {number} startColumn - The column that was edited
 */
function updateSustainedNotesAfterEdit(stringIndex, startColumn) {
  if (!currentGuitarTab || !columnElements[stringIndex]) return;
  
  // Update visual display for affected columns
  const row = currentGuitarTab[stringIndex];
  const columns = columnElements[stringIndex];
  
  // Process columns after the edit to update sustained markers
  // If startColumn is 0, process the entire row
  const endColumn = startColumn === 0 ? row.length : Math.min(startColumn + 50, row.length);
  for (let i = startColumn + 1; i < endColumn; i++) {
    const value = row[i];
    const col = columns[i];
    if (!col) continue;
    
    // Update the display based on context
    col.className = 'tab-column';
    col.dataset.column = i;
    col.dataset.string = stringIndex;
    col.textContent = value;
    
    // If it's a number, check if it should be note-start
    if (value !== '-' && !isNaN(parseInt(value))) {
      let isNoteStart = true;
      if (i > 0 && row[i-1] !== '-' && !isNaN(parseInt(row[i-1]))) {
        isNoteStart = false;
      }
      if (isNoteStart) {
        col.classList.add('note-start');
      }
    } else if (value === '~') {
      col.classList.add('sustained');
    }
  }
}

/**
 * @param {GuitarTab} guitarTab
 * @param {number[][]} confidenceMap - Optional confidence scores for each note
 * @returns {void}
 */
function renderTab(guitarTab, confidenceMap = null) {
  // Validate guitarTab structure
  if (!Array.isArray(guitarTab) || guitarTab.length === 0 || !guitarTab.every(row => Array.isArray(row))) {
    console.error('Invalid guitarTab: Must be a non-empty 2D array');
    tabDisplay.innerHTML = '<pre>Error: Invalid tablature data</pre>';
    return;
  }

  const numStrings = guitarTab.length;
  const numColumns = guitarTab[0].length;

  // Ensure column width is calculated before rendering
  if (!columnWidth || columnWidth <= 0) {
    calculateColumnWidth();
  }
  const stringNames = numStrings === 6 ? ['e', 'B', 'G', 'D', 'A', 'E'] :
    Array(numStrings).fill(null).map((_, i) => `S${i+1}`);

  // Use virtual scrolling for large tabs
  if (useVirtualScrolling && numColumns > 500) {
    renderTabVirtual(guitarTab);
    return;
  }

  // Reset cache for column elements
  columnElements = [];
  tabDisplay.innerHTML = '';


  // Calculate expected column count based on audio duration (if we have audio loaded)
  let expectedColumns = numColumns;
  if (audioPlayer.duration) {
    expectedColumns = timeToColumnIndex(audioPlayer.duration);
  }

  // Create tab for each string
  for (let s = numStrings - 1; s >= 0; s--) {
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
    const stringLabel = stringNames[numStrings - 1 - s] || `S${s+1}`;
    label.textContent = stringLabel.padEnd(2, ' ') + '|'; // Include the pipe in the label
    line.appendChild(label);

    // Process the tab data to identify sustained notes
    const processedTab = processSustainedNotes(guitarTab[s]);

    const stringCols = [];
    processedTab.forEach((info, i) => {
      const span = document.createElement('span');
      span.className = 'tab-column';
      span.dataset.column = i;
      span.dataset.string = s;
      let txt = String(info.fret);
      const extra = [];
      if (txt.includes('b')) { extra.push('bend-up'); txt = txt.replace('b', ''); }
      if (txt.includes('r')) { extra.push('bend-down'); txt = txt.replace('r', ''); }
      if (/[hH]/.test(txt)) { extra.push('hammer-on'); txt = txt.replace(/[hH]/g, ''); }
      if (txt.includes('p')) { extra.push('pull-off'); txt = txt.replace('p', ''); }
      if (txt.includes('~')) { extra.push('vibrato'); txt = txt.replace('~', ''); }

      // Add confidence indicator if available
      if (confidenceMap && confidenceMap[s] && confidenceMap[s][i] !== undefined) {
        const confidence = confidenceMap[s][i];
        span.dataset.confidence = confidence.toFixed(2);

        // Add confidence class based on level
        if (confidence < 0.3) {
          extra.push('low-confidence');
        } else if (confidence < 0.7) {
          extra.push('medium-confidence');
        } else {
          extra.push('high-confidence');
        }
      }

      if (info.sustained) {
        span.classList.add('sustained');
        span.textContent = '~';
      } else if (info.isFirstNote) {
        span.classList.add('note-start', ...extra);
        span.textContent = txt;
      } else {
        span.classList.add(...extra);
        span.textContent = txt;
      }
      line.appendChild(span);
      stringCols.push(span);
    });

    // Add pipe after frets
    const endBar = document.createElement('span');
    endBar.textContent = '|';
    line.appendChild(endBar);

    tabDisplay.appendChild(line);

    // Store line's columns in our 2D array
    // Flip the order so columnElements[0] is the lowest string
    columnElements[numStrings - 1 - s] = stringCols;
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
 * @param {string[]} row
 * @returns {TabNote[]}
 */
function processSustainedNotes(row) {
  const out = [];
  for (let i = 0; i < row.length; i++) {
    const t = row[i];
    if (t === '-') {
      out.push({ fret: '-', sustained: false, isFirstNote: false });
    } else if (t === '~') {
      // Tilde indicates a sustained note
      out.push({ fret: '~', sustained: true, isFirstNote: false });
    } else if (t.startsWith('s')) {
      // Legacy sustained note format
      const num = t.substring(1);
      out.push({ fret: '-', sustained: true, actualFret: num, isFirstNote: false });
    } else {
      // It's a fret number
      out.push({ fret: t, sustained: false, isFirstNote: true });
    }
  }
  return out;
}

/**
 * Render tab using virtual scrolling for performance
 * @param {GuitarTab} guitarTab
 * @returns {void}
 */
function renderTabVirtual(guitarTab) {
  // Clean up existing virtual scroller if any
  if (virtualScroller) {
    virtualScroller.dispose();
  }

  // Clear display
  tabDisplay.innerHTML = '';
  tabDisplay.style.position = 'relative';

  // Initialize virtual scroller
  virtualScroller = new VirtualScroller(tabDisplay, tabContainer, {
    columnWidth: columnWidth,
    lineHeight: 28,
    stringCount: guitarTab.length,
    bufferSize: 20,
    labelWidth: labelWidthPx
  });

  // Set data and attach
  virtualScroller.setData(guitarTab);
  virtualScroller.attach();

  // Update column elements reference for compatibility
  columnElements = [];
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
  const midiOnlyMode = midiPlayer && audioPlayer.paused;

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
    const exactColumnIndex = timeToColumnIndex(currentTime);

    // Calculate the current integer column index for the background highlighting
    const currentColumnIndex = Math.floor(exactColumnIndex);

    // Use calculateScrollPosition to determine where to scroll
    const desiredScrollLeft = calculateScrollPosition(exactColumnIndex);

    // Update scroll position during playback
    // Check if we should auto-scroll
    const shouldAutoScroll = !audioPlayer.paused || midiOnlyMode;

    if (shouldAutoScroll) {
      // Temporarily disable smooth scrolling for immediate updates
      const oldScrollBehavior = tabContainer.style.scrollBehavior;
      tabContainer.style.scrollBehavior = 'auto';

      // Always update scroll position during playback
      tabContainer.scrollLeft = desiredScrollLeft;

      // Restore scroll behavior after a frame
      requestAnimationFrame(() => {
        tabContainer.style.scrollBehavior = oldScrollBehavior;
      });
    }

    // --- Update Smooth Playhead Position ---
    // Calculate the exact pixel position relative to the start of tabDisplay
    const actualColumnWidth = columnWidth || MIN_COLUMN_WIDTH_CALC;
    const playheadPixelX = (exactColumnIndex * actualColumnWidth) + labelWidthPx;
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
  } else {
    // Hide playhead if no audio/tab loaded and not in MIDI-only mode
    if (smoothPlayhead) smoothPlayhead.style.display = 'none';
  }

  // Continue the loop even when paused (for seeking)
  animationFrameId = requestAnimationFrame(updateScroll);
}

/**
 * @param {number} newColumnIndex
 * @returns {void}
 */
function updateActiveColumn(newColumnIndex) {
  if (newColumnIndex < 0) return; // Don't process negative indexes

  // Handle virtual scrolling mode
  if (virtualScroller) {
    // Trigger playing animation on columns with notes
    if (newColumnIndex >= 0 && newColumnIndex < (currentGuitarTab?.[0]?.length || 0)) {
      const newElements = virtualScroller.getColumnElements(newColumnIndex);
      newElements.forEach(el => {
        if (el.classList.contains('note-start') || el.classList.contains('sustained')) {
          el.classList.add('playing');
          setTimeout(() => {
            if (el) el.classList.remove('playing');
          }, 700);
        }
      });
    }
    return;
  }

  // Standard mode: Trigger playing animation on columns with notes
  if (newColumnIndex >= 0 && newColumnIndex < (currentGuitarTab?.[0]?.length || 0)) {
    for (let s = 0; s < 6; s++) {
      const currentCol = columnElements[s]?.[newColumnIndex];
      if (currentCol) {
        // Handle 'playing' animation for notes
        if (currentCol.classList.contains('note-start') || currentCol.classList.contains('sustained')) {
          currentCol.classList.add('playing');
          setTimeout(() => {
            if (currentCol) currentCol.classList.remove('playing');
          }, 700); // Match animation duration
        }
      }
    }
  }
}

/**
 * Start MIDI playback in sync mode with the audio player
 * @returns {Promise<void>}
 */
async function startSyncedMidiPlayback() {
  try {
    toggleMidiButton.textContent = 'Stop MIDI';
    toggleMidiButton.classList.add('active');
    const lbl = document.createElement('span');
    lbl.className = 'sync-label';
    lbl.textContent = 'Synced with audio';
    toggleMidiButton.parentNode.appendChild(lbl);

    const origVol = audioPlayer.volume;
    audioPlayer.dataset.originalVolume = origVol;
    audioPlayer.volume = Math.max(0.3, origVol * 0.6);

    if (!window.audioContext) window.audioContext = new AudioContext();
    // Resume audio context if suspended
    if (window.audioContext.state === 'suspended') {
      await window.audioContext.resume();
    }
    midiPlayer = new MidiPlayer(window.audioContext);

    await midiPlayer.play(currentGuitarTab, HOP_SIZE, sampleRate, audioPlayer, 0, playbackRate);
  } catch (err) {
    console.error(err);
    cleanupMidiUI();
  }
}

/**
 * Start MIDI playback in standalone mode
 * @param {number} startPos - The position to start from (in seconds)
 * @returns {Promise<void>}
 */
async function startStandaloneMidiPlayback(startPos) {
  try {
    toggleMidiButton.textContent = 'Stop MIDI';
    toggleMidiButton.classList.add('active');
    const lbl = document.createElement('span');
    lbl.className = 'sync-label';
    lbl.textContent = 'MIDI only';
    toggleMidiButton.parentNode.appendChild(lbl);

    if (!window.audioContext) window.audioContext = new AudioContext();
    // Resume audio context if suspended
    if (window.audioContext.state === 'suspended') {
      await window.audioContext.resume();
    }
    midiPlayer = new MidiPlayer(window.audioContext);

    await midiPlayer.play(currentGuitarTab, HOP_SIZE, sampleRate, null, startPos, playbackRate);

    const totalDur = currentGuitarTab[0].length * HOP_SIZE / sampleRate;
    const remaining = (totalDur - startPos) / playbackRate;
    midiPlayer.autoStopTimeoutId = setTimeout(() => { if (midiPlayer) stopMidiPlayback(); }, remaining * 1000 + 500);
  } catch (err) {
    console.error(err);
    cleanupMidiUI();
  }
}

/**
 * Main function to start MIDI playback in the appropriate mode
 * @returns {Promise<void>}
 */
async function startMidiPlayback() {
  if (midiPlayer || !currentGuitarTab) return;
  if (!audioPlayer.paused) await startSyncedMidiPlayback();
  else await startStandaloneMidiPlayback(playheadState.currentTime);
}

/**
 * Stop MIDI playback and cleanup
 * @returns {void}
 */
function stopMidiPlayback() {
  if (!midiPlayer) return;
  if (midiPlayer.autoStopTimeoutId) clearTimeout(midiPlayer.autoStopTimeoutId);

  midiPlayer.stop();
  midiPlayer.dispose();
  midiPlayer = null;
  cleanupMidiUI();
  if (audioPlayer.dataset.originalVolume) {
    audioPlayer.volume = parseFloat(audioPlayer.dataset.originalVolume);
    delete audioPlayer.dataset.originalVolume;
  }
  playheadState.updatingFromMidi = false;
}

/**
 * Clean up MIDI UI elements
 * @returns {void}
 */
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
    // Stop any existing MIDI playback
    if (midiPlayer) {
      stopMidiPlayback();
    }
    
    // Reset audio playback
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    
    // Show loading state
    tabDisplay.innerHTML = '<pre>Loading...</pre>';

    // Clear previous data immediately
    currentGuitarTab = null;
    currentNotes = null;
    currentChords = null;
    currentConfidenceMap = null;

    // Reset the playback rate to default
    audioPlayer.playbackRate = 1.0;
    tempoSlider.value = 1.0;
    tempoValue.textContent = "1.0x";
    playbackRate = 1.0;
    
    // Disable MIDI buttons until processing is complete
    toggleMidiButton.disabled = true;
    exportMidiButton.disabled = true;
    toggleMidiButton.textContent = 'Play MIDI';
    toggleMidiButton.classList.remove('active');
    
    // Exit edit mode if active
    if (isEditMode) {
      isEditMode = false;
      editModeButton.classList.remove('active');
      editModeButton.textContent = 'Edit Mode';
      tabDisplay.classList.remove('edit-mode');
    }

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

    // Ensure effective column width is updated
    getEffectiveColumnWidth();

    const audioData = audioBuffer.getChannelData(0);
    cachedAudioData = new Float32Array(audioData);

    ensureWorker();
    // Convert threshold to sensitivity (invert it)
    const threshold = parseFloat(sensitivitySlider.value);
    const sensitivity = 1 - threshold;

    worker.postMessage({
      audioBuffer: cachedAudioData.buffer,
      sampleRate,
      fftSize: FFT_SIZE,
      hopSize: HOP_SIZE,
      sensitivity: sensitivity,
      guitarConfig: {
        tuning: [40, 45, 50, 55, 59, 64],
        maxFret: 24,
        capo: 0,
        preferredPosition: [0, 12]
      }
    }, [cachedAudioData.buffer]);

  } catch (error) {
    console.error('Error processing audio:', error);
    tabDisplay.innerHTML = `<pre>Error: ${error.message}</pre>`;
  }
});

let sensTimer = null;
sensitivitySlider.addEventListener('input', () => {
  const threshold = parseFloat(sensitivitySlider.value);
  sensitivityValue.textContent = `${(threshold * 100).toFixed(0)}%`;
  clearTimeout(sensTimer);
  sensTimer = setTimeout(() => {
    // Only update if we have a worker and tab data
    if (!worker || !currentGuitarTab) return;
    const wasMidi = midiPlayer !== null;
    // Send inverted value to worker (high threshold = low sensitivity)
    const sensitivity = 1 - threshold;
    worker.postMessage({ updateSensitivity: true, sensitivity: sensitivity });
    // If MIDI was playing, restart it immediately
    if (wasMidi) {
      stopMidiPlayback();
      setTimeout(() => startMidiPlayback(), 10);
    }
  }, 100);
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
      // Update virtual scroller if active
      if (virtualScroller) {
        virtualScroller.updateConfig({ columnWidth: columnWidth });
      }
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
  if (midiPlayer && audioPlayer.paused) {
    // Stop current playback
    stopMidiPlayback();
    // Restart with new tempo
    setTimeout(() => startMidiPlayback(), 10);
  }
  // If MIDI is playing with audio, the audio playback rate change triggers MIDI sync
});

// Playing state change handlers
audioPlayer.addEventListener('play', () => {
  if (midiPlayer) {
    stopMidiPlayback();
    startSyncedMidiPlayback();
  } else {
    playheadState.updatingFromMidi = false;
    playheadState.updateFromAudio(audioPlayer);
  }
});

audioPlayer.addEventListener('pause', () => {
  // Stop MIDI playback when audio is paused
  if (midiPlayer) {
    stopMidiPlayback();
  }

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
    const exactColumnIndex = timeToColumnIndex(currentTime);
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
 * @returns {void}
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
toggleMidiButton.addEventListener('click', () => {
  if (midiPlayer) stopMidiPlayback();
  else startMidiPlayback();
});

// When starting the application, disable the MIDI button until data is available
toggleMidiButton.disabled = true;
exportMidiButton.disabled = true;

// Edit mode button event listener
editModeButton.addEventListener('click', () => {
  isEditMode = !isEditMode;
  editModeButton.textContent = isEditMode ? 'Exit Edit Mode' : 'Edit Mode';
  editModeButton.classList.toggle('active', isEditMode);
  tabViewport.classList.toggle('edit-mode', isEditMode);
});

// Export MIDI button event listener
exportMidiButton.addEventListener('click', () => {
  if (!currentGuitarTab) return;

  try {
    let blob;

    // Use currentNotes if available (respects sensitivity), otherwise use guitar tab
    if (currentNotes && currentNotes.length > 0) {
      // Export using the current detected notes
      const midiData = midiExporter.exportToMidi(currentNotes, sampleRate, HOP_SIZE);
      blob = new Blob([midiData], { type: 'audio/midi' });
    } else {
      // Fall back to guitar tab export
      const midiData = midiExporter.exportGuitarTabToMidi(
        currentGuitarTab,
        currentConfidenceMap,
        sampleRate,
        HOP_SIZE
      );
      blob = new Blob([midiData], { type: 'audio/midi' });
    }

    // Create download link
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'guitar-tab-export.mid';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Visual feedback
    exportMidiButton.textContent = 'Exported!';
    setTimeout(() => {
      exportMidiButton.textContent = 'Export MIDI';
    }, 2000);

  } catch (error) {
    console.error('MIDI export error:', error);
    alert('Failed to export MIDI: ' + error.message);
  }
});

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

window.addEventListener('beforeunload', cleanup);

/**
 * Clean up resources before page unload
 * @returns {void}
 */
function cleanup() {
  if (midiPlayer) stopMidiPlayback();
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (worker) worker.terminate();
  if (virtualScroller) {
    virtualScroller.dispose();
    virtualScroller = null;
  }
  if (unifiedClock) {
    unifiedClock.dispose();
    unifiedClock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (midiPlayer) stopMidiPlayback();
    audioPlayer.pause();
  }
});