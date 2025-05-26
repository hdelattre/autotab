/**
 * Virtual scrolling implementation for guitar tablature
 * Only renders visible columns for optimal performance
 */
export class VirtualScroller {
  constructor(container, viewport, config = {}) {
    this.container = container;
    this.viewport = viewport;

    // Configuration
    this.config = {
      columnWidth: 20,
      lineHeight: 28,
      stringCount: 6,
      bufferSize: 10, // Extra columns to render outside viewport
      labelWidth: 35,
      ...config
    };

    // State
    this.data = null;
    this.visibleRange = { start: 0, end: 0 };
    this.renderedRange = { start: -1, end: -1 };
    this.columnPool = [];
    this.activeColumns = new Map();
    this.stringLabels = this.config.stringCount === 6 ?
      ['e', 'B', 'G', 'D', 'A', 'E'] :
      Array(this.config.stringCount).fill(null).map((_, i) => `S${i+1}`);

    // Performance
    this.rafId = null;
    this.lastScrollLeft = 0;

    // Bind methods
    this.handleScroll = this.handleScroll.bind(this);
    this.render = this.render.bind(this);
  }

  /**
   * Initialize with tab data
   */
  setData(guitarTab) {
    this.data = guitarTab;
    this.totalColumns = guitarTab[0].length;

    // Calculate total width
    this.totalWidth = this.totalColumns * this.config.columnWidth + this.config.labelWidth;

    // Create spacer for scrolling
    this.createSpacer();

    // Initial render
    this.updateVisibleRange();
    this.render();
  }

  /**
   * Create spacer element to enable scrolling
   */
  createSpacer() {
    // Clear existing content
    this.container.innerHTML = '';

    // Create spacer
    this.spacer = document.createElement('div');
    this.spacer.style.width = `${this.totalWidth}px`;
    this.spacer.style.height = '1px';
    this.spacer.style.position = 'absolute';
    this.spacer.style.top = '0';
    this.spacer.style.left = '0';
    this.container.appendChild(this.spacer);

    // Create content container
    this.content = document.createElement('div');
    this.content.style.position = 'absolute';
    this.content.style.top = '0';
    this.content.style.left = '0';
    this.content.style.width = '100%';
    this.content.style.height = '100%';
    this.container.appendChild(this.content);

    // Create string labels (sticky)
    this.createStringLabels();
  }

  /**
   * Create sticky string labels
   */
  createStringLabels() {
    this.labelsContainer = document.createElement('div');
    this.labelsContainer.style.position = 'sticky';
    this.labelsContainer.style.left = '0';
    this.labelsContainer.style.zIndex = '20';
    this.labelsContainer.style.backgroundColor = 'var(--tab-label-bg, #ffffff)';
    this.labelsContainer.style.width = `${this.config.labelWidth}px`;
    this.labelsContainer.style.height = '100%';

    for (let i = 0; i < this.config.stringCount; i++) {
      const label = document.createElement('div');
      label.className = 'string-label';
      label.textContent = this.stringLabels[i] + '|';
      label.style.height = `${this.config.lineHeight}px`;
      label.style.lineHeight = `${this.config.lineHeight}px`;
      this.labelsContainer.appendChild(label);
    }

    this.content.appendChild(this.labelsContainer);
  }

  /**
   * Update visible column range based on scroll position
   */
  updateVisibleRange() {
    const scrollLeft = this.viewport.scrollLeft;
    const viewportWidth = this.viewport.clientWidth;

    // Calculate visible columns
    const startColumn = Math.floor((scrollLeft - this.config.labelWidth) / this.config.columnWidth);
    const endColumn = Math.ceil((scrollLeft + viewportWidth - this.config.labelWidth) / this.config.columnWidth);

    // Add buffer
    this.visibleRange = {
      start: Math.max(0, startColumn - this.config.bufferSize),
      end: Math.min(this.totalColumns - 1, endColumn + this.config.bufferSize)
    };
  }

  /**
   * Main render function - only renders visible columns
   */
  render() {
    if (!this.data) return;

    const { start, end } = this.visibleRange;

    // Always ensure visible range is fully rendered
    // Don't skip to prevent gaps when scrolling quickly

    // Remove columns outside visible range
    for (const [col, elements] of this.activeColumns) {
      if (col < start || col > end) {
        this.recycleColumn(col, elements);
      }
    }

    // Render visible columns
    for (let col = start; col <= end; col++) {
      if (!this.activeColumns.has(col)) {
        this.renderColumn(col);
      }
    }

    this.renderedRange = { start, end };
  }

  /**
   * Render a single column
   */
  renderColumn(columnIndex) {
    const columnElements = [];
    const x = this.config.labelWidth + columnIndex * this.config.columnWidth;

    for (let string = 0; string < this.config.stringCount; string++) {
      const fretValue = this.data[string][columnIndex];
      const y = ((this.config.stringCount - 1) - string) * this.config.lineHeight; // Reverse string order dynamically

      // Get or create column element
      const element = this.getColumnElement();
      element.className = 'tab-column virtual';
      element.style.position = 'absolute';
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.width = `${this.config.columnWidth}px`;
      element.style.height = `${this.config.lineHeight}px`;
      element.dataset.column = columnIndex;
      element.dataset.string = string;

      // Parse fret data
      const { text, classes } = this.parseFretData(fretValue, columnIndex, string);
      element.textContent = text;
      element.className = `tab-column virtual ${classes.join(' ')}`;

      this.content.appendChild(element);
      columnElements.push(element);
    }

    this.activeColumns.set(columnIndex, columnElements);
  }

  /**
   * Parse fret data and return display text and classes
   */
  parseFretData(fretValue, columnIndex, stringIndex) {
    if (!fretValue || fretValue === '-') {
      return { text: '-', classes: [] };
    }

    if (fretValue === '~') {
      return { text: '~', classes: ['sustained'] };
    }

    // Extract articulation markers
    let text = fretValue;
    const classes = [];

    if (text.includes('b')) {
      classes.push('bend-up');
      text = text.replace('b', '');
    }
    if (text.includes('r')) {
      classes.push('bend-down');
      text = text.replace('r', '');
    }
    if (/[hH]/.test(text)) {
      classes.push('hammer-on');
      text = text.replace(/[hH]/g, '');
    }
    if (text.includes('p')) {
      classes.push('pull-off');
      text = text.replace('p', '');
    }
    if (text.includes('~')) {
      classes.push('vibrato');
      text = text.replace('~', '');
    }

    // Check if this is a note start
    if (text && text !== '-' && text !== '~') {
      classes.push('note-start');
    }

    return { text, classes };
  }

  /**
   * Get a column element from pool or create new
   */
  getColumnElement() {
    if (this.columnPool.length > 0) {
      return this.columnPool.pop();
    }
    return document.createElement('span');
  }

  /**
   * Recycle column elements back to pool
   */
  recycleColumn(columnIndex, elements) {
    for (const element of elements) {
      element.remove();
      element.className = '';
      element.removeAttribute('style'); // Properly clear inline styles
      element.textContent = '';
      element.removeAttribute('data-column');
      element.removeAttribute('data-string');
      this.columnPool.push(element);
    }
    this.activeColumns.delete(columnIndex);
  }

  /**
   * Handle scroll events
   */
  handleScroll() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }

    this.rafId = requestAnimationFrame(() => {
      this.updateVisibleRange();
      this.render();
      this.rafId = null;

      // Force a second render to catch any missed columns
      // This handles fast scrolling edge cases
      requestAnimationFrame(() => {
        this.updateVisibleRange();
        this.render();
      });
    });
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);

    // Update string labels if string count changed
    if (newConfig.stringCount !== undefined) {
      this.stringLabels = this.config.stringCount === 6 ?
        ['e', 'B', 'G', 'D', 'A', 'E'] :
        Array(this.config.stringCount).fill(null).map((_, i) => `S${i+1}`);
    }

    // Re-render if column width changed
    if (newConfig.columnWidth !== undefined || newConfig.stringCount !== undefined) {
      this.totalWidth = this.totalColumns * this.config.columnWidth + this.config.labelWidth;
      this.spacer.style.width = `${this.totalWidth}px`;
      this.clearAll();
      this.render();
    }
  }

  /**
   * Get column element at index for highlighting
   */
  getColumnElements(columnIndex) {
    return this.activeColumns.get(columnIndex) || [];
  }

  /**
   * Clear all rendered columns
   */
  clearAll() {
    for (const [col, elements] of this.activeColumns) {
      this.recycleColumn(col, elements);
    }
    this.renderedRange = { start: -1, end: -1 };
  }

  /**
   * Attach scroll listener
   */
  attach() {
    this.viewport.addEventListener('scroll', this.handleScroll, { passive: true });
  }

  /**
   * Detach scroll listener
   */
  detach() {
    this.viewport.removeEventListener('scroll', this.handleScroll);
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
  }

  /**
   * Dispose of virtual scroller
   */
  dispose() {
    this.detach();
    this.clearAll();
    this.columnPool = [];
    this.data = null;
  }
}