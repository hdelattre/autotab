/**
 * MIDI File Exporter
 * Converts detected notes to standard MIDI format
 */

export class MidiExporter {
  constructor() {
    this.ticksPerQuarter = 480;
    this.tempo = 500000; // microseconds per quarter note (120 BPM)
  }

  /**
   * Export notes to MIDI file
   * @param {Array} notes - Array of note objects with time, duration, midi, velocity
   * @param {number} sampleRate - Sample rate used for timing conversion
   * @param {number} hopSize - Hop size used for timing conversion
   * @returns {ArrayBuffer} MIDI file data
   */
  exportToMidi(notes, sampleRate = 44100, hopSize = 2048) {
    if (!notes || notes.length === 0) {
      throw new Error('No notes to export');
    }

    // Sort notes by time
    const sortedNotes = [...notes].sort((a, b) => a.time - b.time);

    // Create MIDI tracks
    const tracks = this.createTracks(sortedNotes);

    // Build MIDI file
    return this.buildMidiFile(tracks);
  }

  /**
   * Create MIDI tracks from notes
   */
  createTracks(notes) {
    const tracks = [];

    // Track 0: Tempo and metadata
    const metaTrack = [];
    metaTrack.push(this.createTempoEvent(0, this.tempo));
    metaTrack.push(this.createTimeSignatureEvent(0, 4, 4));
    metaTrack.push(this.createTrackNameEvent(0, 'Guitar Tab Export'));
    metaTrack.push(this.createEndOfTrackEvent(0));
    tracks.push(metaTrack);

    // Track 1: Note data
    const noteTrack = [];
    noteTrack.push(this.createTrackNameEvent(0, 'Guitar'));
    noteTrack.push(this.createProgramChangeEvent(0, 0, 25)); // Acoustic Guitar

    // Convert notes to MIDI events
    let lastEventTime = 0;

    for (const note of notes) {
      const startTick = this.timeToTicks(note.time);
      const endTick = this.timeToTicks(note.time + note.duration);

      // Note On event
      const deltaTimeOn = startTick - lastEventTime;
      const velocity = Math.round((note.velocity || 0.8) * 127);
      const pitch = Math.round(note.midi);

      noteTrack.push({
        deltaTime: deltaTimeOn,
        type: 'noteOn',
        channel: 0,
        pitch: pitch,
        velocity: velocity
      });

      // Note Off event
      const deltaTimeOff = endTick - startTick;
      noteTrack.push({
        deltaTime: deltaTimeOff,
        type: 'noteOff',
        channel: 0,
        pitch: pitch,
        velocity: 0
      });

      lastEventTime = endTick;
    }

    noteTrack.push(this.createEndOfTrackEvent(lastEventTime));
    tracks.push(noteTrack);

    return tracks;
  }

  /**
   * Convert time in seconds to MIDI ticks
   */
  timeToTicks(timeInSeconds) {
    const quarterNotesPerSecond = 1000000 / this.tempo;
    const ticks = timeInSeconds * quarterNotesPerSecond * this.ticksPerQuarter;
    return Math.round(ticks);
  }

  /**
   * Build complete MIDI file from tracks
   */
  buildMidiFile(tracks) {
    const chunks = [];

    // Header chunk
    chunks.push(this.createHeaderChunk(tracks.length));

    // Track chunks
    for (const track of tracks) {
      chunks.push(this.createTrackChunk(track));
    }

    // Combine all chunks
    return this.combineChunks(chunks);
  }

  /**
   * Create MIDI header chunk
   */
  createHeaderChunk(numTracks) {
    const buffer = new ArrayBuffer(14);
    const view = new DataView(buffer);

    // Chunk type "MThd"
    view.setUint32(0, 0x4D546864, false);

    // Chunk length (always 6 for header)
    view.setUint32(4, 6, false);

    // Format type (1 = multiple tracks, synchronous)
    view.setUint16(8, 1, false);

    // Number of tracks
    view.setUint16(10, numTracks, false);

    // Ticks per quarter note
    view.setUint16(12, this.ticksPerQuarter, false);

    return buffer;
  }

  /**
   * Create MIDI track chunk
   */
  createTrackChunk(events) {
    const eventBytes = [];

    // Convert events to bytes
    for (const event of events) {
      eventBytes.push(...this.eventToBytes(event));
    }

    // Create chunk
    const chunkLength = eventBytes.length;
    const buffer = new ArrayBuffer(8 + chunkLength);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Chunk type "MTrk"
    view.setUint32(0, 0x4D54726B, false);

    // Chunk length
    view.setUint32(4, chunkLength, false);

    // Event data
    bytes.set(eventBytes, 8);

    return buffer;
  }

  /**
   * Convert MIDI event to bytes
   */
  eventToBytes(event) {
    const bytes = [];

    // Delta time (variable length)
    bytes.push(...this.encodeVariableLength(event.deltaTime || 0));

    // Event data
    switch (event.type) {
      case 'noteOn':
        bytes.push(0x90 | (event.channel & 0x0F));
        bytes.push(event.pitch & 0x7F);
        bytes.push(event.velocity & 0x7F);
        break;

      case 'noteOff':
        bytes.push(0x80 | (event.channel & 0x0F));
        bytes.push(event.pitch & 0x7F);
        bytes.push(event.velocity & 0x7F);
        break;

      case 'programChange':
        bytes.push(0xC0 | (event.channel & 0x0F));
        bytes.push(event.program & 0x7F);
        break;

      case 'tempo':
        bytes.push(0xFF, 0x51, 0x03);
        bytes.push((event.tempo >> 16) & 0xFF);
        bytes.push((event.tempo >> 8) & 0xFF);
        bytes.push(event.tempo & 0xFF);
        break;

      case 'timeSignature':
        bytes.push(0xFF, 0x58, 0x04);
        bytes.push(event.numerator);
        bytes.push(Math.log2(event.denominator));
        bytes.push(event.clocksPerClick);
        bytes.push(event.notesPerQuarter);
        break;

      case 'trackName':
        bytes.push(0xFF, 0x03);
        const nameBytes = new TextEncoder().encode(event.name);
        bytes.push(...this.encodeVariableLength(nameBytes.length));
        bytes.push(...nameBytes);
        break;

      case 'endOfTrack':
        bytes.push(0xFF, 0x2F, 0x00);
        break;
    }

    return bytes;
  }

  /**
   * Encode variable length value
   */
  encodeVariableLength(value) {
    const bytes = [];
    let temp = value;

    bytes.push(temp & 0x7F);
    temp >>= 7;

    while (temp > 0) {
      bytes.push((temp & 0x7F) | 0x80);
      temp >>= 7;
    }

    return bytes.reverse();
  }

  /**
   * Create tempo event
   */
  createTempoEvent(deltaTime, tempo) {
    return {
      deltaTime: deltaTime,
      type: 'tempo',
      tempo: tempo
    };
  }

  /**
   * Create time signature event
   */
  createTimeSignatureEvent(deltaTime, numerator, denominator) {
    return {
      deltaTime: deltaTime,
      type: 'timeSignature',
      numerator: numerator,
      denominator: denominator,
      clocksPerClick: 24,
      notesPerQuarter: 8
    };
  }

  /**
   * Create track name event
   */
  createTrackNameEvent(deltaTime, name) {
    return {
      deltaTime: deltaTime,
      type: 'trackName',
      name: name
    };
  }

  /**
   * Create program change event
   */
  createProgramChangeEvent(deltaTime, channel, program) {
    return {
      deltaTime: deltaTime,
      type: 'programChange',
      channel: channel,
      program: program
    };
  }

  /**
   * Create end of track event
   */
  createEndOfTrackEvent(lastEventTime) {
    return {
      deltaTime: 0,
      type: 'endOfTrack'
    };
  }

  /**
   * Combine multiple chunks into single ArrayBuffer
   */
  combineChunks(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const buffer = new ArrayBuffer(totalLength);
    const bytes = new Uint8Array(buffer);

    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    return buffer;
  }

  /**
   * Export guitar tab to MIDI with proper string assignments
   */
  exportGuitarTabToMidi(guitarTab, confidenceMap, sampleRate = 44100, hopSize = 2048) {
    const notes = [];
    const stringMidi = [40, 45, 50, 55, 59, 64]; // E2, A2, D3, G3, B3, E4
    const timePerColumn = hopSize / sampleRate;
    const numStrings = guitarTab.length;

    // Convert tab to notes
    for (let string = 0; string < numStrings; string++) {
      for (let col = 0; col < guitarTab[string].length; col++) {
        const fret = guitarTab[string][col];

        // Skip empty positions and sustained notes
        if (fret === '-' || fret === '~' || !fret) continue;

        // Parse fret number (handle articulation markers)
        let fretStr = String(fret);
        let hasBend = false;
        let hasVibrato = false;

        // Extract articulation markers
        if (fretStr.includes('b')) {
          hasBend = true;
          fretStr = fretStr.replace('b', '');
        }
        if (fretStr.includes('~')) {
          hasVibrato = true;
          fretStr = fretStr.replace('~', '');
        }

        // Parse fret number
        let fretNum = parseInt(fretStr);
        if (isNaN(fretNum)) continue;

        // Calculate MIDI note
        const midiNote = stringMidi[string] + fretNum;

        // Find note duration by looking ahead
        let durationColumns = 1;
        for (let nextCol = col + 1; nextCol < guitarTab[string].length; nextCol++) {
          if (guitarTab[string][nextCol] === '~') {
            durationColumns++;
          } else {
            break;
          }
        }

        // Calculate duration with minimum threshold for GarageBand
        const duration = Math.max(0.1, durationColumns * timePerColumn); // Minimum 100ms

        // Get confidence from 1D array
        const confidence = (confidenceMap && confidenceMap[col]) || 0.8;

        // Scale velocity (ensure minimum velocity for audibility)
        const velocity = Math.max(0.3, Math.min(1.0, confidence));

        // Add note with articulation info
        notes.push({
          time: col * timePerColumn,
          duration: duration,
          midi: midiNote,
          velocity: velocity,
          string: string,
          articulation: {
            bend: hasBend,
            vibrato: hasVibrato
          }
        });
      }
    }

    // Sort notes by time for proper MIDI ordering
    notes.sort((a, b) => a.time - b.time);

    return this.exportToMidi(notes, sampleRate, hopSize);
  }
}