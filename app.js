(() => {
  'use strict';

  // Generic fallbacks until a map loads: one 2.5 s bar (96 BPM in 4/4). They are
  // not taken from any song; applyTrackMetadata() replaces them.
  let DURATION = 1;
  let BAR_ONE = 0;
  let BAR_DURATION = 2.5;
  let BEAT_DURATION = BAR_DURATION / 4;
  let TOTAL_BARS = 1;
  const TAU = Math.PI * 2;
  const START_ANGLE = -Math.PI / 2;
  const NS = 'http://www.w3.org/2000/svg';
  const BEAT_TOLERANCE = .03;
  const requestedProjectId = new URLSearchParams(window.location.search).get('song');
  const selectedProjectId = /^[0-9a-f]{32}$/.test(requestedProjectId || '') ? requestedProjectId : null;
  const projectApiUrl = suffix => `/api/projects/${selectedProjectId}/${suffix}`;

  // localStorage can be blocked (privacy settings) or full; never let that break the app.
  const store = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, String(value)); return true; } catch { return false; }
    },
    remove(key) {
      try { window.localStorage.removeItem(key); } catch { /* storage unavailable */ }
    }
  };

  // detectedSections[].colorKey: the standard section types, plus the keys
  // written by earlier versions (opening, peak, rebuild, develop), which saved
  // maps still use.
  const sectionColors = {
    intro: 'var(--intro)',
    verse: 'var(--verse)',
    prechorus: 'var(--prechorus)',
    chorus: 'var(--chorus)',
    bridge: 'var(--bridge)',
    solo: 'var(--solo)',
    instrumental: 'var(--instrumental)',
    build: 'var(--build)',
    breakdown: 'var(--breakdown)',
    interlude: 'var(--interlude)',
    outro: 'var(--outro)',
    opening: 'var(--opening)',
    peak: 'var(--peak)',
    rebuild: 'var(--rebuild)',
    develop: 'var(--develop)'
  };

  const chordColors = {
    C: 'var(--c)', 'C#': '#9b70e5', Db: '#9b70e5', D: 'var(--d)', 'D#': '#788ee8', Eb: '#788ee8',
    E: '#7ec7f1', F: 'var(--f)', 'F#': '#f39a69', Gb: '#f39a69', G: 'var(--g)', 'G#': '#75c9bb',
    Ab: '#75c9bb', A: 'var(--a)', 'A#': '#dfb968', Bb: '#dfb968', B: '#d6df82', N: 'var(--line)'
  };
  const chordRoot = chord => chord?.match(/^[A-G](?:#|b)?/)?.[0] ?? 'N';
  const chordColor = chord => chordColors[chordRoot(chord)] ?? 'var(--line)';
  const motifColors = ['var(--f)', 'var(--a)', 'var(--g)', 'var(--c)'];
  const modelColors = {
    start: '#64748b', intro: '#3b82f6', verse: '#22b8cf', chorus: '#f59e0b', bridge: '#ff8b76',
    inst: '#2fbf9b', solo: '#9b70e5', break: '#ec7063', outro: '#64748b', end: '#64748b'
  };

  let sections = [];
  let detectedSectionDefaults = [];
  let chordRuns = [];
  let detectedChordBars = [];
  let hasDetectedChords = false;
  let energy = [];
  let turns = [];
  let motifs = [];
  let barChords = [];

  const placeholderSection = (name, short = name) => ({ name, short, startBar: 1, endBar: TOTAL_BARS, color: 'var(--intro)' });

  const rebuildBarChords = () => {
    barChords = Array(TOTAL_BARS + 1).fill('');
    chordRuns.forEach(([start, end, chord]) => {
      for (let bar = start; bar <= end; bar += 1) barChords[bar] = chord;
    });
  };

  const resetMapState = section => {
    sections = [section];
    detectedSectionDefaults = cloneSections(sections);
    chordRuns = [[1, TOTAL_BARS, 'N']];
    detectedChordBars = [];
    hasDetectedChords = false;
    energy = Array(TOTAL_BARS).fill(0);
    turns = [];
    motifs = [];
    rebuildBarChords();
  };

  const $ = selector => document.querySelector(selector);
  const audio = $('#song');
  const playToggle = $('#play-toggle');
  const previousEventButton = $('#previous-event');
  const nextEventButton = $('#next-event');
  const scrubber = $('#scrubber');
  const playbackRate = $('#playback-rate');
  const loopSectionButton = $('#loop-section');
  const audioModeButton = $('#audio-mode');
  const currentTimeEl = $('#current-time');
  const timeToEndEl = $('#time-to-end');
  const wheel = $('#song-wheel');
  const ribbon = $('#session-ribbon');
  const sectionLane = $('#ribbon-sections');
  const chordLane = $('#ribbon-chords');
  const energyLane = $('#ribbon-energy');
  const motifLane = $('#ribbon-motifs');
  const modelLane = $('#ribbon-model');
  const turnLayer = $('#ribbon-turns');
  const ribbonScroll = $('#ribbon-scroll');
  const ribbonPlayhead = $('#ribbon-playhead');
  const ribbonTooltip = $('#ribbon-tooltip');
  const ribbonZoomOut = $('#ribbon-zoom-out');
  const ribbonZoomReset = $('#ribbon-zoom-reset');
  const ribbonZoomIn = $('#ribbon-zoom-in');
  const resetSectionsButton = $('#reset-sections');
  const sectionTools = $('#section-tools');
  const sectionEditorLabel = $('#section-editor-label');
  const sectionNameInput = $('#section-name-input');
  // The section to rename is the one shown when the name field was focused, so
  // playback crossing into the next section while typing doesn't change it.
  let renameTargetIndex = null;
  const renameSectionButton = $('#rename-section');
  const addDividerButton = $('#add-divider');
  const removeLeftDividerButton = $('#remove-left-divider');
  const removeRightDividerButton = $('#remove-right-divider');
  const timelineReadout = $('#timeline-readout');
  const sessionNotes = $('#session-notes');
  const stampNoteButton = $('#stamp-note');
  const clearNotesButton = $('#clear-notes');
  const centerNextChord = $('#center-next-chord');
  const centerNextCount = $('#center-next-count');
  const centerNextProgress = $('#center-next-progress');
  const nowChordEl = $('#now-chord');
  const nowSectionEl = $('#now-section');
  const nowBarEl = $('#now-bar');
  const nowMotifEl = $('#now-motif');
  const nowChordSourceEl = $('#now-chord-source');
  const centerSectionEl = $('#center-section');
  const centerChordEl = $('#center-chord');
  const centerPositionEl = $('#center-position');
  const energyLabelEl = $('#energy-label');
  const energyFillEl = $('#energy-fill');
  const countdownEls = Object.fromEntries(['chord', 'section'].map(kind => {
    const count = $(`#next-${kind}-count`);
    return [kind, { count, card: count.closest('.countdown-card'), name: $(`#next-${kind}-name`) }];
  }));
  const audioModeTitle = audioModeButton.title;

  let hasMap = false;
  let activeSectionIndex = 0;
  let loopedSectionIndex = null;
  let animationFrame = null;
  let wheelSelection = null;
  let wheelPlayhead = null;
  let wheelProgress = null;
  let wheelSectionNodes = [];
  let wheelClassState = null;
  let ribbonRefs = { sections: [], chords: [], models: [] };
  let activeBlocks = { section: -1, chord: -1 };
  let renderKey = null;
  let cueState = { index: -1, imminent: false };
  let progressCircumference = 0;
  let isScrubbing = false;
  let markerMode = false;
  let switchingAudio = false;
  let correctedBarStarts = null;
  let musicalBeatGrid = [];
  let ribbonZoom = 1;

  // Per-song storage keys, set once a map loads. Nothing is saved while no song is open.
  let SECTION_EDITS_KEY = null;
  let RIBBON_ZOOM_KEY = null;
  let NOTES_KEY = null;

  let ORIGINAL_AUDIO = '';
  let MARKER_AUDIO = '';

  const invalidateRender = () => { renderKey = null; };

  const svgElement = (name, attributes = {}) => {
    const node = document.createElementNS(NS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  };

  const setText = (element, text) => {
    if (element.textContent !== text) element.textContent = text;
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const linearBarStart = bar => Math.max(0, BAR_ONE + (bar - 1) * BAR_DURATION);
  const barStart = bar => correctedBarStarts?.[bar] ?? linearBarStart(bar);
  const sectionStart = section => barStart(section.startBar);
  const sectionEnd = section => section.endBar >= TOTAL_BARS ? DURATION : barStart(section.endBar + 1);
  function cloneSections(source) { return source.map(section => ({ ...section })); }
  const angleAtProgress = progress => START_ANGLE + clamp(progress, 0, 1) * TAU;
  const angleForBar = bar => angleAtProgress((bar - 1) / TOTAL_BARS);
  const point = (cx, cy, radius, angle) => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];

  const serializableSections = source => source.map(section => ({
    name: section.name,
    short: section.short,
    startBar: section.startBar,
    endBar: section.endBar,
    color: section.color
  }));

  const isValidSectionSet = candidate => Array.isArray(candidate)
    && candidate.length > 0
    && candidate.every((section, index) => {
      if (!section || !Number.isInteger(section.startBar) || !Number.isInteger(section.endBar)) return false;
      if (typeof section.name !== 'string' || typeof section.short !== 'string' || typeof section.color !== 'string') return false;
      if (section.startBar < 1 || section.endBar > TOTAL_BARS || section.startBar > section.endBar) return false;
      if (index === 0) return section.startBar === 1;
      return section.startBar === candidate[index - 1].endBar + 1;
    })
    && candidate[candidate.length - 1].endBar === TOTAL_BARS;

  const applyStoredSectionEdits = () => {
    if (!SECTION_EDITS_KEY) return false;
    try {
      const saved = JSON.parse(store.get(SECTION_EDITS_KEY));
      if (isValidSectionSet(saved?.sections)) {
        sections = cloneSections(saved.sections);
        return true;
      }
      // Older format: divider positions for the detected sections, by name.
      // Applies only while the detected sections still have the same names.
      const names = sections.map(section => section.name);
      if (!Array.isArray(saved?.starts) || JSON.stringify(saved.names) !== JSON.stringify(names)) return false;
      const starts = saved.starts;
      const valid = starts.length === sections.length && starts[0] === 1
        && starts.every((start, index) => Number.isInteger(start) && start <= TOTAL_BARS && (index === 0 || start > starts[index - 1]));
      if (!valid) return false;
      sections.forEach((section, index) => {
        section.startBar = starts[index];
        section.endBar = index + 1 < starts.length ? starts[index + 1] - 1 : TOTAL_BARS;
      });
      return true;
    } catch {
      return false;
    }
  };

  const saveSectionEdits = () => {
    if (!SECTION_EDITS_KEY) return;
    const current = serializableSections(sections);
    const defaults = serializableSections(detectedSectionDefaults);
    if (JSON.stringify(current) === JSON.stringify(defaults)) {
      store.remove(SECTION_EDITS_KEY);
      return;
    }
    store.set(SECTION_EDITS_KEY, JSON.stringify({ version: 2, sections: current }));
  };

  const setRibbonZoom = (nextZoom, anchorRatio = null) => {
    const oldWidth = ribbon.scrollWidth || ribbonScroll.clientWidth;
    const oldAnchor = anchorRatio === null
      ? (ribbonScroll.scrollLeft + ribbonScroll.clientWidth / 2) / Math.max(1, oldWidth)
      : anchorRatio;
    ribbonZoom = clamp(Math.round(clamp(nextZoom, 1, 4) * 4) / 4, 1, 4);
    ribbon.style.width = `${ribbonZoom * 100}%`;
    ribbonZoomReset.textContent = `${Number.isInteger(ribbonZoom) ? ribbonZoom.toFixed(1) : ribbonZoom.toFixed(2).replace(/0$/, '')}×`;
    ribbonZoomOut.disabled = ribbonZoom <= 1;
    ribbonZoomIn.disabled = ribbonZoom >= 4;
    if (RIBBON_ZOOM_KEY) store.set(RIBBON_ZOOM_KEY, ribbonZoom);
    const newWidth = ribbon.scrollWidth || ribbonScroll.clientWidth;
    ribbonScroll.scrollLeft = clamp(oldAnchor * newWidth - ribbonScroll.clientWidth / 2, 0, newWidth - ribbonScroll.clientWidth);
  };

  const uprightRotation = angle => {
    let rotation = angle * 180 / Math.PI + 90;
    rotation = ((rotation + 180) % 360 + 360) % 360 - 180;
    if (rotation > 90) rotation -= 180;
    if (rotation < -90) rotation += 180;
    return rotation;
  };

  const arcPath = (cx, cy, innerRadius, outerRadius, start, end) => {
    // A whole circle (a one-section song) has the same start and end point,
    // which SVG would drop; draw it as two halves instead.
    if (end - start >= TAU - 1e-6) {
      return `${arcPath(cx, cy, innerRadius, outerRadius, start, start + Math.PI)} ${arcPath(cx, cy, innerRadius, outerRadius, start + Math.PI, end)}`;
    }
    const [x0, y0] = point(cx, cy, outerRadius, start);
    const [x1, y1] = point(cx, cy, outerRadius, end);
    const [x2, y2] = point(cx, cy, innerRadius, end);
    const [x3, y3] = point(cx, cy, innerRadius, start);
    const large = end - start > Math.PI ? 1 : 0;
    return `M${x0},${y0} A${outerRadius},${outerRadius} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${innerRadius},${innerRadius} 0 ${large} 0 ${x3},${y3} Z`;
  };

  const arcLinePath = (cx, cy, radius, start, end, reverse = false) => {
    if (end - start >= TAU - 1e-6) end = start + TAU - 1e-3;
    const from = reverse ? end : start;
    const to = reverse ? start : end;
    const [x0, y0] = point(cx, cy, radius, from);
    const [x1, y1] = point(cx, cy, radius, to);
    const large = end - start > Math.PI ? 1 : 0;
    const sweep = reverse ? 0 : 1;
    return `M${x0},${y0} A${radius},${radius} 0 ${large} ${sweep} ${x1},${y1}`;
  };

  const formatClock = (seconds, tenths = false) => {
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const remainder = safe - minutes * 60;
    return tenths
      ? `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`
      : `${minutes}:${Math.floor(remainder).toString().padStart(2, '0')}`;
  };

  const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  // Bar starts follow analysis_pipeline.corrected_bar_starts(): each model
  // downbeat within min(1.25 s, half a bar) of a nominal bar start replaces it,
  // and bars after the last matched one are projected at the recent median bar
  // length. Two browser-side additions: a downbeat only counts when at least one
  // neighbouring downbeat lies about one nominal bar away (within 10%), so a
  // slower, free or rubato passage (whose bars don't fit the fixed bar count)
  // stays on the nominal grid instead of squeezing bars together; and unmatched
  // bars between two matched bars are interpolated. Starts are then kept strictly
  // increasing and within the track.
  const buildCorrectedTimingGrid = downbeats => {
    const tolerance = Math.min(1.25, BAR_DURATION * .5);
    const starts = Array.from({ length: TOTAL_BARS + 2 }, (_, bar) => linearBarStart(bar));
    const times = downbeats.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const steadyInterval = interval => Math.abs(interval - BAR_DURATION) <= BAR_DURATION * .1;
    const mapped = new Map();

    times.forEach((time, index) => {
      if (!steadyInterval(time - times[index - 1]) && !steadyInterval(times[index + 1] - time)) return;
      const bar = clamp(Math.round((time - BAR_ONE) / BAR_DURATION) + 1, 1, TOTAL_BARS);
      if (Math.abs(time - linearBarStart(bar)) <= tolerance) mapped.set(bar, time);
    });

    const mappedBars = [...mapped.keys()].sort((a, b) => a - b);
    mappedBars.forEach((bar, index) => {
      starts[bar] = mapped.get(bar);
      const next = mappedBars[index + 1];
      if (next === undefined || next === bar + 1) return;
      const step = (mapped.get(next) - mapped.get(bar)) / (next - bar);
      for (let between = bar + 1; between < next; between += 1) starts[between] = mapped.get(bar) + (between - bar) * step;
    });

    const lastMappedBar = mappedBars.at(-1);
    if (lastMappedBar !== undefined) {
      const recentIntervals = mappedBars.slice(-17)
        .filter(bar => mapped.has(bar - 1))
        .map(bar => mapped.get(bar) - mapped.get(bar - 1));
      const projectedBarDuration = median(recentIntervals) ?? BAR_DURATION;
      for (let bar = lastMappedBar + 1; bar <= TOTAL_BARS; bar += 1) {
        starts[bar] = starts[lastMappedBar] + (bar - lastMappedBar) * projectedBarDuration;
      }
    }

    starts[TOTAL_BARS + 1] = DURATION;
    const gap = Math.min(.001, DURATION / (4 * (TOTAL_BARS + 1)));
    starts[1] = Math.max(0, starts[1]);
    for (let bar = 2; bar <= TOTAL_BARS; bar += 1) starts[bar] = Math.max(starts[bar], starts[bar - 1] + gap);
    for (let bar = TOTAL_BARS; bar >= 1; bar -= 1) starts[bar] = Math.min(starts[bar], starts[bar + 1] - gap);

    correctedBarStarts = starts;
    musicalBeatGrid = [];
    for (let bar = 1; bar <= TOTAL_BARS; bar += 1) {
      const start = starts[bar];
      const end = starts[bar + 1];
      // The chart assumes four beats per bar, whatever track.timeSignature says.
      for (let beat = 0; beat < 4; beat += 1) {
        musicalBeatGrid.push(start + (end - start) * beat / 4);
      }
    }
    musicalBeatGrid.push(DURATION);
  };

  const upperBound = (items, value) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (items[middle] <= value) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  // The last bar whose start is at or before `time` (bar starts are increasing).
  const barAtTime = time => {
    let low = 1;
    let high = TOTAL_BARS;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (time >= barStart(middle)) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  const positionAt = time => {
    const safeTime = clamp(time, 0, DURATION);
    const bar = barAtTime(safeTime);
    const start = barStart(bar);
    const end = bar >= TOTAL_BARS ? DURATION : barStart(bar + 1);
    const beatDuration = Math.max(.001, (end - start) / 4);
    const beat = clamp(Math.floor((safeTime - start) / beatDuration) + 1, 1, 4);
    return { bar, beat };
  };

  const formatPosition = (bar, beat) => `${bar}.${beat}`;

  const sectionIndexForBar = bar => sections.findIndex(section => bar >= section.startBar && bar <= section.endBar);
  const motifsForBar = bar => motifs.filter(motif => motif.ranges.some(([start, end]) => bar >= start && bar <= end));
  const chordRunIndexForBar = bar => chordRuns.findIndex(run => bar >= run[0] && bar <= run[1]);

  const beatsRemainingUntil = (time, eventTime) => {
    if (!Number.isFinite(eventTime)) return null;
    if (!musicalBeatGrid.length) return Math.max(0, Math.ceil((eventTime - time) / BEAT_DURATION));
    return Math.max(0,
      upperBound(musicalBeatGrid, eventTime + BEAT_TOLERANCE) - upperBound(musicalBeatGrid, time + BEAT_TOLERANCE));
  };

  const setCountdown = (kind, name, eventTime, time) => {
    const beats = beatsRemainingUntil(time, eventTime);
    const { count, card, name: nameElement } = countdownEls[kind];
    if (nameElement) nameElement.textContent = name;
    count.textContent = kind === 'chord'
      ? (name === 'Track end' ? name : `${name} in ${beats ?? '—'}`)
      : (beats === null ? '—' : beats);
    card.classList.toggle('has-long-chord', kind === 'chord' && name.length >= 5);
    count.setAttribute('aria-label', beats === null
      ? 'No upcoming event'
      : (kind === 'chord' ? `Next chord ${name} in ${beats} beats` : `${beats} beats remaining`));
    card.classList.toggle('is-soon', beats !== null && beats <= 8 && beats > 4);
    card.classList.toggle('is-imminent', beats !== null && beats <= 4);
  };

  const nextAfter = (items, time) => items.find(item => item.time > time + BEAT_TOLERANCE);

  let chordEvents = [];
  let sectionEvents = [];
  let motifEvents = [];
  let navigationEvents = [];

  const rebuildNavigationEvents = () => {
    navigationEvents = [
      ...chordEvents.map(item => ({ ...item, label: `Chord ${item.name}` })),
      ...sectionEvents.map(item => ({ ...item, label: item.name })),
      ...turns.map(item => ({ ...item, label: `Turn ${formatPosition(item.bar, item.beat)}` })),
      ...motifEvents.map(item => ({ ...item, label: item.name }))
    ].sort((a, b) => a.time - b.time);
    invalidateRender();
  };

  const rebuildSectionEvents = () => {
    sectionEvents = sections.slice(1).map(section => ({
      time: sectionStart(section),
      name: section.short,
      bar: section.startBar
    }));
    rebuildNavigationEvents();
  };

  const rebuildAllEvents = () => {
    chordEvents = chordRuns.slice(1).map(run => ({ time: barStart(run[0]), name: run[2], bar: run[0] }));
    motifEvents = motifs.flatMap(motif => motif.ranges.map(([start]) => ({
      time: barStart(start), name: `${motif.id} starts`, bar: start
    }))).sort((a, b) => a.time - b.time);
    rebuildSectionEvents();
  };

  const WHEEL = { cx: 350, cy: 350, sectionInner: 146, sectionOuter: 204 };

  const sectionWheelGeometry = section => {
    const { cx, cy, sectionInner, sectionOuter } = WHEEL;
    const start = angleForBar(section.startBar);
    const end = angleForBar(section.endBar + 1);
    const middle = (start + end) / 2;
    return {
      shape: arcPath(cx, cy, sectionInner, sectionOuter, start, end),
      labelPath: arcLinePath(cx, cy, (sectionInner + sectionOuter) / 2, start + .012, end - .012, Math.sin(middle) > 0)
    };
  };

  // Reshape one section's ring segment and its label path in place (used while dragging a divider).
  const updateWheelSection = index => {
    const nodes = wheelSectionNodes[index];
    if (!nodes || !sections[index]) return;
    const geometry = sectionWheelGeometry(sections[index]);
    nodes.path.setAttribute('d', geometry.shape);
    nodes.labelPath.setAttribute('d', geometry.labelPath);
    fitWheelLabel(nodes.label, nodes.labelPath);
  };

  const wheelAngleFromPointer = event => {
    const rect = wheel.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (700 / rect.width);
    const y = (event.clientY - rect.top) * (700 / rect.height);
    let angle = Math.atan2(y - WHEEL.cy, x - WHEEL.cx) - START_ANGLE;
    if (angle < 0) angle += TAU;
    return angle;
  };

  // Shrinks a wheel section label until it fits its arc (narrow sections and
  // long, user-renamed labels would otherwise be clipped at both ends).
  const fitWheelLabel = (label, labelPath) => {
    try {
      const room = labelPath.getTotalLength() * .92;
      const text = label.firstChild;
      const full = text.dataset.full ?? text.textContent;
      text.dataset.full = full;
      text.textContent = full;
      let size = 12;
      label.setAttribute('font-size', size);
      while (size > 7 && label.getComputedTextLength() > room) {
        size -= 1;
        label.setAttribute('font-size', size);
      }
      // Still too long at the smallest size: shorten it with an ellipsis.
      for (let keep = full.length - 1; keep > 1 && label.getComputedTextLength() > room; keep -= 1) {
        text.textContent = `${full.slice(0, keep).trimEnd()}…`;
      }
    } catch {
      // Not rendered yet (e.g. hidden): keep the default size.
    }
  };

  const drawWheel = () => {
    const { cx, cy } = WHEEL;
    const chordInner = 218;
    const chordOuter = 252;
    const energyInner = 267;
    const energyHeight = 50;

    while (wheel.lastChild && !['title', 'desc'].includes(wheel.lastChild.tagName?.toLowerCase())) wheel.removeChild(wheel.lastChild);
    wheel.setAttribute('viewBox', '0 0 700 700');
    wheelSectionNodes = [];
    wheelClassState = null;
    invalidateRender();

    wheel.appendChild(svgElement('circle', { cx, cy, r: 322, fill: 'none', stroke: 'var(--line)', 'stroke-width': 1 }));

    sections.forEach((section, index) => {
      const geometry = sectionWheelGeometry(section);
      const path = svgElement('path', {
        d: geometry.shape,
        fill: section.color,
        opacity: .84,
        stroke: 'var(--bg)',
        'stroke-width': 3,
        class: 'wheel-section',
        'data-section-index': index
      });
      wheel.appendChild(path);

      const labelPathId = `section-label-path-${index}`;
      const labelPath = svgElement('path', { id: labelPathId, d: geometry.labelPath, fill: 'none', stroke: 'none' });
      wheel.appendChild(labelPath);

      const label = svgElement('text', {
        fill: '#fff',
        'font-size': 12,
        'font-weight': 750,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        class: 'wheel-section-label',
        'data-section-index': index
      });
      const textPath = svgElement('textPath', { href: `#${labelPathId}`, startOffset: '50%' });
      textPath.textContent = section.short.toUpperCase();
      label.appendChild(textPath);
      wheel.appendChild(label);
      fitWheelLabel(label, labelPath);
      wheelSectionNodes[index] = { path, labelPath, label };
    });

    for (let bar = 1; bar <= TOTAL_BARS; bar += 1) {
      const start = angleForBar(bar);
      const end = angleForBar(bar + 1) - .0016;
      wheel.appendChild(svgElement('path', {
        d: arcPath(cx, cy, chordInner, chordOuter, start, end),
        fill: chordColor(barChords[bar]),
        stroke: 'var(--bg)',
        'stroke-width': .45,
        'data-bar': bar
      }));

      const outer = energyInner + energyHeight * (energy[bar - 1] ?? 0);
      wheel.appendChild(svgElement('path', {
        d: arcPath(cx, cy, energyInner, outer, start, end),
        fill: 'var(--accent)',
        opacity: .78
      }));

      if ((bar - 1) % 8 === 0) {
        const [x0, y0] = point(cx, cy, chordInner - 4, start);
        const [x1, y1] = point(cx, cy, energyInner + energyHeight + 6, start);
        wheel.appendChild(svgElement('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: 'var(--line)', 'stroke-width': 1 }));
      }
    }

    motifs.forEach(motif => {
      motif.ranges.forEach(([startBar, endBar]) => {
        const start = angleForBar(startBar);
        const end = angleForBar(endBar + 1) - .004;
        wheel.appendChild(svgElement('path', {
          d: arcPath(cx, cy, 124, 138, start, end),
          fill: motif.color,
          opacity: .86,
          stroke: 'var(--bg)',
          'stroke-width': 2
        }));

        const middle = (start + end) / 2;
        const [x, y] = point(cx, cy, 131, middle);
        const label = svgElement('text', {
          x, y,
          fill: 'var(--text)',
          'font-size': 10,
          'font-weight': 850,
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
          transform: `rotate(${uprightRotation(middle)} ${x} ${y})`
        });
        label.textContent = motif.id;
        wheel.appendChild(label);
      });
    });

    turns.forEach(turn => {
      const angle = angleAtProgress(turn.time / DURATION);
      const [x, y] = point(cx, cy, 329, angle);
      const confidence = clamp(Number(turn.confidence) || 0, 0, 1);
      wheel.appendChild(svgElement('circle', {
        cx: x, cy: y, r: 3.5 + confidence * 2.5,
        fill: 'var(--accent-2)', opacity: .55 + confidence * .45
      }));
    });

    progressCircumference = TAU * 329;
    wheelProgress = svgElement('circle', {
      cx, cy, r: 329,
      fill: 'none', stroke: 'var(--accent)', 'stroke-width': 4,
      'stroke-linecap': 'round', transform: `rotate(-90 ${cx} ${cy})`,
      'stroke-dasharray': progressCircumference,
      'stroke-dashoffset': progressCircumference
    });
    wheel.appendChild(wheelProgress);

    wheelSelection = svgElement('path', {
      fill: 'none', stroke: 'var(--text)', 'stroke-width': 3,
      'pointer-events': 'none'
    });
    wheel.appendChild(wheelSelection);

    wheelPlayhead = svgElement('line', {
      x1: cx, y1: cy, x2: cx, y2: 14,
      stroke: 'var(--accent)', 'stroke-width': 3, 'stroke-linecap': 'round',
      'pointer-events': 'none', filter: 'drop-shadow(0 0 6px rgb(247 209 84 / 75%))'
    });
    wheel.appendChild(wheelPlayhead);

    const hitRing = svgElement('circle', {
      cx, cy, r: 270, fill: 'none', stroke: 'transparent', 'stroke-width': 135,
      class: 'wheel-hit', 'aria-label': 'Click the wheel to seek'
    });
    hitRing.addEventListener('pointermove', event => {
      if (!hasMap) return;
      updateTimelineReadout(clamp(wheelAngleFromPointer(event) / TAU * DURATION, 0, DURATION));
    });
    hitRing.addEventListener('pointerleave', () => { if (hasMap) updateTimelineReadout(audio.currentTime); });
    hitRing.addEventListener('click', event => {
      if (hasMap) seekTo(wheelAngleFromPointer(event) / TAU * DURATION);
    });
    wheel.appendChild(hitRing);
  };

  const boundaryInfo = index => {
    const left = sections[index - 1];
    const right = sections[index];
    return `${left.short} ends ${left.endBar}.4 · ${right.short} starts ${right.startBar}.1`;
  };

  const boundaryLimits = index => ({
    min: sections[index - 1].startBar + 1,
    max: sections[index].endBar
  });

  const boundaryBarFromPointer = (index, clientX) => {
    const rect = sectionLane.getBoundingClientRect();
    const raw = Math.round(clamp((clientX - rect.left) / rect.width, 0, 1) * TOTAL_BARS) + 1;
    const { min, max } = boundaryLimits(index);
    return clamp(raw, min, max);
  };

  const previewSectionBoundary = (index, startBar, handle) => {
    const left = sections[index - 1];
    const right = sections[index];
    const leftLength = startBar - left.startBar;
    const rightLength = right.endBar - startBar + 1;
    left.endBar = startBar - 1;
    right.startBar = startBar;
    ribbonRefs.sections[index - 1].style.flexGrow = leftLength;
    ribbonRefs.sections[index].style.flexGrow = rightLength;
    handle.style.left = `${(startBar - 1) / TOTAL_BARS * 100}%`;
    const info = `${left.short} ends ${startBar - 1}.4 · ${right.short} starts ${startBar}.1`;
    handle.dataset.ribbonInfo = info;
    handle.setAttribute('aria-valuenow', startBar);
    handle.setAttribute('aria-valuetext', info);
    rebuildSectionEvents();
    updateWheelSection(index - 1);
    updateWheelSection(index);
    update(audio.currentTime);
    timelineReadout.textContent = info;
  };

  const commitSectionBoundary = (index, startBar) => {
    const { min, max } = boundaryLimits(index);
    const snapped = clamp(Math.round(startBar), min, max);
    sections[index - 1].endBar = snapped - 1;
    sections[index].startBar = snapped;
    saveSectionEdits();
    rebuildSectionEvents();
    drawWheel();
    buildRibbon();
    update(audio.currentTime);
  };

  const updateSectionTools = () => {
    if (!hasMap) return;
    const position = positionAt(audio.currentTime);
    const index = sectionIndexForBar(position.bar);
    const section = sections[index];
    if (!section) return;
    sectionEditorLabel.textContent = `${section.name} · ${section.startBar}.1–${section.endBar}.4`;
    if (document.activeElement !== sectionNameInput) {
      sectionNameInput.value = section.name;
      renameTargetIndex = null;
    }
    addDividerButton.textContent = `Add at ${position.bar}.1`;
    addDividerButton.disabled = position.bar <= section.startBar || position.bar > section.endBar;
    removeLeftDividerButton.disabled = index === 0;
    removeRightDividerButton.disabled = index === sections.length - 1;
  };

  const clearLoop = () => {
    loopedSectionIndex = null;
    loopSectionButton.textContent = 'Loop section';
    loopSectionButton.setAttribute('aria-pressed', 'false');
  };

  const applySectionStructureChange = () => {
    clearLoop();
    saveSectionEdits();
    rebuildSectionEvents();
    drawWheel();
    buildRibbon();
    update(audio.currentTime);
  };

  const renameActiveSection = () => {
    const section = sections[renameTargetIndex ?? activeSectionIndex];
    const name = sectionNameInput.value.trim();
    if (!hasMap || !section || !name) return;
    section.name = name;
    section.short = name;
    applySectionStructureChange();
    sectionNameInput.focus();
    sectionNameInput.select();
  };

  const addDividerAtPlayhead = () => {
    if (!hasMap) return;
    const { bar } = positionAt(audio.currentTime);
    const index = sectionIndexForBar(bar);
    const section = sections[index];
    if (!section || bar <= section.startBar || bar > section.endBar) return;
    const right = {
      ...section,
      name: `${section.name} B`,
      short: `${section.short} B`,
      startBar: bar,
      endBar: section.endBar
    };
    section.endBar = bar - 1;
    sections.splice(index + 1, 0, right);
    applySectionStructureChange();
  };

  const removeAdjacentDivider = direction => {
    if (!hasMap) return;
    const { bar } = positionAt(audio.currentTime);
    const index = sectionIndexForBar(bar);
    if (direction < 0 && index > 0) {
      sections[index - 1].endBar = sections[index].endBar;
      sections.splice(index, 1);
    } else if (direction > 0 && index < sections.length - 1) {
      sections[index].endBar = sections[index + 1].endBar;
      sections.splice(index + 1, 1);
    } else {
      return;
    }
    applySectionStructureChange();
  };

  const addSectionResizeHandles = () => {
    sections.slice(1).forEach((section, offset) => {
      const index = offset + 1;
      const handle = document.createElement('div');
      const { min, max } = boundaryLimits(index);
      const info = boundaryInfo(index);
      handle.className = 'section-resize-handle';
      handle.style.left = `${(section.startBar - 1) / TOTAL_BARS * 100}%`;
      handle.dataset.boundaryIndex = index;
      handle.dataset.ribbonInfo = info;
      handle.tabIndex = 0;
      handle.title = `${info} · drag to align`;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', `Boundary between ${sections[index - 1].name} and ${section.name}`);
      handle.setAttribute('aria-valuemin', min);
      handle.setAttribute('aria-valuemax', max);
      handle.setAttribute('aria-valuenow', section.startBar);
      handle.setAttribute('aria-valuetext', info);

      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');
        const originalStart = section.startBar;
        let candidate = originalStart;

        const move = moveEvent => {
          const nextCandidate = boundaryBarFromPointer(index, moveEvent.clientX);
          if (nextCandidate === candidate) return;
          candidate = nextCandidate;
          previewSectionBoundary(index, candidate, handle);
        };
        const finish = endEvent => {
          endEvent.preventDefault();
          endEvent.stopPropagation();
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', cancel);
          if (handle.hasPointerCapture(endEvent.pointerId)) handle.releasePointerCapture(endEvent.pointerId);
          commitSectionBoundary(index, candidate);
        };
        const cancel = cancelEvent => {
          cancelEvent.stopPropagation();
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', cancel);
          sections[index - 1].endBar = originalStart - 1;
          sections[index].startBar = originalStart;
          rebuildSectionEvents();
          drawWheel();
          buildRibbon();
          update(audio.currentTime);
        };

        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', cancel);
      });
      handle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        commitSectionBoundary(index, section.startBar + (event.key === 'ArrowRight' ? 1 : -1));
        document.querySelector(`.section-resize-handle[data-boundary-index="${index}"]`)?.focus();
      });
      sectionLane.appendChild(handle);
    });
  };

  // Ribbon targets are role="button" and seek on click, Enter or Space. Each lane
  // has a single tab stop; the arrow keys, Home and End move between its items.
  const registerRibbonTarget = (node, info, seekTime) => {
    node.dataset.ribbonInfo = info;
    node.dataset.seekTime = clamp(seekTime, 0, DURATION);
    node.title = info;
    node.tabIndex = -1;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `${info}. Click to seek.`);
  };

  const laneTargets = lane => [...lane.children]
    .filter(node => node.dataset.seekTime !== undefined)
    .sort((a, b) => Number(a.dataset.seekTime) - Number(b.dataset.seekTime));

  const initRovingLane = lane => {
    const [first] = laneTargets(lane);
    if (first) first.tabIndex = 0;
  };

  const buildRibbon = () => {
    sectionLane.replaceChildren();
    chordLane.replaceChildren();
    energyLane.replaceChildren();
    motifLane.replaceChildren();
    turnLayer.replaceChildren();
    ribbonRefs = { sections: [], chords: [], models: ribbonRefs.models };
    activeBlocks = { section: -1, chord: -1 };
    invalidateRender();

    sections.forEach((section, index) => {
      const block = document.createElement('div');
      block.className = 'section-block';
      block.dataset.sectionIndex = index;
      const label = document.createElement('span');
      label.className = 'section-label';
      label.textContent = section.short;
      block.appendChild(label);
      block.style.flexGrow = section.endBar - section.startBar + 1;
      block.style.background = section.color;
      registerRibbonTarget(
        block,
        `${section.name} · bars ${section.startBar}–${section.endBar} · ${formatClock(sectionStart(section), true)}–${formatClock(sectionEnd(section), true)}`,
        sectionStart(section)
      );
      sectionLane.appendChild(block);
      ribbonRefs.sections.push(block);
    });

    chordRuns.forEach(([start, end, chord, confidence, alternate, evidence]) => {
      const block = document.createElement('div');
      block.className = 'chord-block';
      block.dataset.root = chordRoot(chord);
      const info = Number.isFinite(confidence)
        ? `${chord} · bars ${start}–${end} · chart confidence ${Math.round(confidence * 100)}%${alternate && chord !== 'N' ? ` · alternate ${alternate}` : ''}${evidence?.length ? ` · ${evidence.join(', ')}` : ''}`
        : `${chord} · bars ${start}–${end}`;
      block.style.flexGrow = end - start + 1;
      block.style.background = chordColor(chord);
      registerRibbonTarget(block, info, barStart(start));
      chordLane.appendChild(block);
      ribbonRefs.chords.push(block);
    });

    energy.forEach((value, index) => {
      const barNumber = index + 1;
      const bar = document.createElement('div');
      bar.className = 'energy-bar';
      bar.style.height = `${Math.max(3, value * 100)}%`;
      registerRibbonTarget(
        bar,
        `Energy · bar ${barNumber} · ${Math.round(value * 100)}% · ${barChords[barNumber]}`,
        barStart(barNumber)
      );
      energyLane.appendChild(bar);
    });

    motifs.forEach(motif => {
      motif.ranges.forEach(([start, end]) => {
        const block = document.createElement('div');
        block.className = 'motif-block';
        block.textContent = motif.id;
        block.style.left = `${(start - 1) / TOTAL_BARS * 100}%`;
        block.style.width = `${(end - start + 1) / TOTAL_BARS * 100}%`;
        block.style.borderColor = motif.color;
        const confidence = Number.isFinite(motif.confidence) ? ` · ${Math.round(motif.confidence * 100)}% match` : '';
        registerRibbonTarget(block, `${motif.id} ${motif.name} · bars ${start}–${end}${confidence}`, barStart(start));
        motifLane.appendChild(block);
      });
    });

    turns.forEach(turn => {
      const marker = document.createElement('div');
      marker.className = 'turn-marker';
      marker.style.left = `${turn.time / DURATION * 100}%`;
      const confidence = Number.isFinite(turn.confidence) ? ` · ${Math.round(turn.confidence * 100)}%` : '';
      const evidence = Array.isArray(turn.evidence) && turn.evidence.length ? ` · ${turn.evidence.join(', ')}` : '';
      registerRibbonTarget(marker, `Detected transition · ${formatPosition(turn.bar, turn.beat)} · ${formatClock(turn.time, true)}${confidence}${evidence}`, turn.time);
      turnLayer.appendChild(marker);
    });

    [sectionLane, chordLane, energyLane, motifLane, turnLayer].forEach(initRovingLane);
    addSectionResizeHandles();
    resetSectionsButton.disabled = !SECTION_EDITS_KEY || !store.get(SECTION_EDITS_KEY);
  };

  const showLaneMessage = (lane, text, title = '') => {
    const message = document.createElement('span');
    message.className = 'lane-message';
    message.textContent = text;
    lane.replaceChildren(message);
    if (title) lane.title = title; else lane.removeAttribute('title');
  };

  const buildModelBlocks = segments => {
    modelLane.replaceChildren();
    modelLane.removeAttribute('title');
    ribbonRefs.models = [];
    if (!segments.length) {
      showLaneMessage(modelLane, 'No model segments');
      return;
    }
    segments.forEach(segment => {
      const block = document.createElement('div');
      const label = String(segment.label ?? '');
      const bars = Number.isInteger(segment.startBar) && Number.isInteger(segment.endBar)
        ? ` · ${segment.startBar}.1–${segment.endBar}.4`
        : '';
      const info = `Model: ${label} · ${formatClock(segment.start, true)}–${formatClock(segment.end, true)}${bars}`;
      block.className = 'model-block';
      block.textContent = label;
      block.style.flexGrow = segment.end - segment.start;
      block.style.background = modelColors[label] ?? 'var(--line)';
      registerRibbonTarget(block, info, segment.start);
      modelLane.appendChild(block);
      ribbonRefs.models.push({ node: block, start: segment.start, end: segment.end, active: false });
    });
    initRovingLane(modelLane);
  };

  // Keys were once derived from the upload's file name and duration, but every
  // upload is stored as source.<ext>, so different songs could share them. They
  // are now keyed by project ID; values under the old keys are copied once.
  const storageKeysFor = id => ({
    sections: `hitmapper:${id}:section-boundaries:v1`,
    zoom: `hitmapper:${id}:ribbon-zoom`,
    notes: `hitmapper:${id}:session-notes`
  });

  const migrateLegacyStorage = (track, keys) => {
    const migratedKey = `hitmapper:${selectedProjectId}:storage-migrated`;
    if (store.get(migratedKey)) return;
    const legacyId = `${track.source || track.name || 'song'}:${Math.round(DURATION * 1000)}`.replace(/[^a-z0-9:._-]+/gi, '-');
    const legacy = storageKeysFor(legacyId);
    Object.keys(keys).forEach(kind => {
      if (store.get(keys[kind]) !== null) return;
      const value = store.get(legacy[kind]);
      if (value !== null) store.set(keys[kind], value);
    });
    // Older versions also kept one set of notes for the page as a whole. Give
    // them to the first song opened (the old key is kept).
    const sharedNotes = store.get('hitmapper:session-notes');
    if (sharedNotes && !store.get('hitmapper:session-notes-migrated') && !store.get(keys.notes)) {
      store.set(keys.notes, sharedNotes);
      store.set('hitmapper:session-notes-migrated', selectedProjectId);
    }
    store.set(migratedKey, '1');
  };

  const setNotesEnabled = enabled => {
    sessionNotes.disabled = !enabled;
    stampNoteButton.disabled = !enabled;
    clearNotesButton.disabled = !enabled;
    sessionNotes.placeholder = enabled ? 'Arrangement ideas, lyric cues, mix notes…' : 'Open a song to keep notes for it';
  };

  const applyTrackMetadata = analysis => {
    const track = analysis.track ?? {};
    const bpm = Number(analysis.analyzer?.bpm);
    DURATION = Math.max(.01, Number(track.duration) || 1);
    BAR_ONE = Number(track.barOne) || 0;
    BAR_DURATION = Math.max(.01, Number(track.barDuration) || (240 / Math.max(1, bpm || 96)));
    BEAT_DURATION = BAR_DURATION / 4;
    // At most the bars that fit in the track (a damaged map could claim millions).
    const maxBars = Math.ceil((DURATION - Math.min(0, BAR_ONE)) / BAR_DURATION) + 2;
    TOTAL_BARS = Math.min(maxBars, Math.max(1, Math.round(Number(track.totalBars) || (Array.isArray(analysis.downbeats) ? analysis.downbeats.length : 0) || 1)));
    ORIGINAL_AUDIO = projectApiUrl('audio');
    MARKER_AUDIO = projectApiUrl('markers');
    const keys = storageKeysFor(selectedProjectId);
    migrateLegacyStorage(track, keys);
    SECTION_EDITS_KEY = keys.sections;
    RIBBON_ZOOM_KEY = keys.zoom;
    NOTES_KEY = keys.notes;
    ribbonZoom = Number(store.get(RIBBON_ZOOM_KEY)) || 1;
    resetMapState(placeholderSection('Song'));
    scrubber.max = DURATION;
    audio.src = ORIGINAL_AUDIO;
    const name = track.name || 'Untitled song';
    $('#track-name').textContent = name;
    // Show the meter the analysis reports. The grid itself always assumes four
    // beats per bar (BEAT_DURATION = BAR_DURATION / 4), whatever this says.
    const meter = typeof track.timeSignature === 'string' && track.timeSignature ? ` · ${track.timeSignature} grid` : '';
    const tempo = Number.isFinite(bpm) && bpm > 0 ? ` · ≈${bpm.toFixed(1)} BPM` : '';
    $('#track-details').textContent = `${formatClock(DURATION)}${meter}${tempo}`;
    document.title = `HitMapper — ${name}`;
    sessionNotes.value = store.get(NOTES_KEY) ?? '';
    setNotesEnabled(true);
    $('.timeline-axis').replaceChildren(...Array.from({ length: 8 }, (_, index) => {
      const label = document.createElement('span');
      label.textContent = formatClock(DURATION * index / 7);
      return label;
    }));
    setRibbonZoom(ribbonZoom);
  };

  // Sections must run contiguously from bar 1 to TOTAL_BARS. Each detected
  // section keeps its start bar (clamped and de-duplicated) and runs to the next
  // section's start; with nothing usable the song is one section.
  const normalizeSections = detected => {
    const repaired = [];
    (Array.isArray(detected) ? detected : [])
      .map((section, order) => ({ section, order, start: Math.round(Number(section?.startBar)) }))
      .filter(({ section, start }) => section && typeof section === 'object' && Number.isFinite(start))
      .map(item => ({ ...item, start: clamp(item.start, 1, TOTAL_BARS) }))
      .sort((a, b) => a.start - b.start || a.order - b.order)
      .forEach(({ section, start }) => {
        if (repaired.length && repaired.at(-1).startBar === start) return;
        const name = typeof section.name === 'string' && section.name.trim() ? section.name.trim() : `Section ${repaired.length + 1}`;
        const short = typeof section.short === 'string' && section.short.trim() ? section.short.trim() : name;
        repaired.push({ ...section, name, short, startBar: start, color: sectionColors[section.colorKey] ?? 'var(--intro)' });
      });
    if (!repaired.length) return [placeholderSection('Song')];
    repaired[0].startBar = 1;
    repaired.forEach((section, index) => {
      section.endBar = index + 1 < repaired.length ? repaired[index + 1].startBar - 1 : TOTAL_BARS;
    });
    return repaired;
  };

  // Chord runs must cover every bar: later runs win where runs overlap, and bars
  // no run covers become 'N' (no chord).
  const normalizeChordRuns = runs => {
    const owner = Array(TOTAL_BARS + 1).fill(-1);
    const valid = [];
    (Array.isArray(runs) ? runs : []).forEach(run => {
      const start = Math.round(Number(run?.startBar));
      const end = Math.round(Number(run?.endBar));
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const from = clamp(start, 1, TOTAL_BARS);
      const to = clamp(end, 1, TOTAL_BARS);
      if (from > to) return;
      const name = typeof run.name === 'string' && run.name.trim() ? run.name.trim() : 'N';
      const index = valid.push([
        name,
        Number.isFinite(run.confidence) ? run.confidence : undefined,
        run.alternate,
        Array.isArray(run.evidence) ? run.evidence : undefined
      ]) - 1;
      for (let bar = from; bar <= to; bar += 1) owner[bar] = index;
    });
    const merged = [];
    for (let bar = 1; bar <= TOTAL_BARS; bar += 1) {
      const last = merged.at(-1);
      if (last && last.owner === owner[bar]) {
        last.run[1] = bar;
      } else {
        merged.push({ owner: owner[bar], run: [bar, bar, ...(owner[bar] >= 0 ? valid[owner[bar]] : ['N'])] });
      }
    }
    return { runs: merged.map(item => item.run), detected: valid.some(([name]) => name !== 'N') };
  };

  const normalizeMotifs = groups => (Array.isArray(groups) ? groups : [])
    .filter(motif => motif && typeof motif === 'object')
    .map(motif => ({
      ...motif,
      ranges: (Array.isArray(motif.ranges) ? motif.ranges : [])
        .filter(range => Array.isArray(range) && Number.isInteger(range[0]) && Number.isInteger(range[1]))
        .map(([start, end]) => [clamp(start, 1, TOTAL_BARS), clamp(end, 1, TOTAL_BARS)])
        .filter(([start, end]) => start <= end)
    }))
    .filter(motif => motif.ranges.length > 1)
    .map((motif, index) => ({
      ...motif,
      id: String(motif.id ?? `R${index + 1}`),
      name: typeof motif.name === 'string' ? motif.name : '',
      color: motifColors[index % motifColors.length]
    }));

  const showMapUnavailable = message => {
    hasMap = false;
    resetMapState(placeholderSection('Map unavailable', 'Unavailable'));
    rebuildAllEvents();
    drawWheel();
    buildRibbon();
    nowSectionEl.textContent = 'Map unavailable';
    nowChordSourceEl.textContent = '—';
    ribbonRefs.models = [];
    showLaneMessage(modelLane, 'AI analysis unavailable', message);
  };

  const buildModelLane = async () => {
    try {
      const response = await fetch(projectApiUrl('analysis'), { cache: 'no-store' });
      if (!response.ok) throw new Error(`Analysis data returned ${response.status}`);
      const analysis = await response.json();
      if (!analysis || typeof analysis !== 'object') throw new Error('Analysis data is not a map');
      applyTrackMetadata(analysis);
      buildCorrectedTimingGrid(Array.isArray(analysis.downbeats) ? analysis.downbeats : []);

      sections = normalizeSections(analysis.detectedSections);
      detectedSectionDefaults = cloneSections(sections);
      applyStoredSectionEdits();
      clearLoop();

      const chords = normalizeChordRuns(analysis.chordAnalysis?.runs);
      chordRuns = chords.runs;
      hasDetectedChords = chords.detected;
      detectedChordBars = Array.isArray(analysis.chordAnalysis?.bars) ? analysis.chordAnalysis.bars : [];

      const rawEnergy = Array.isArray(analysis.barEnergy) ? analysis.barEnergy : [];
      energy = Array.from({ length: TOTAL_BARS }, (_, index) => clamp(Number(rawEnergy[index]) || 0, 0, 1));

      turns = Array.isArray(analysis.turnAnalysis?.candidates)
        ? analysis.turnAnalysis.candidates
          .filter(turn => Number.isFinite(turn?.time) && Number.isInteger(turn.bar))
          .map(turn => ({ ...turn, beat: Number.isInteger(turn.beat) ? turn.beat : 1 }))
        : [];
      motifs = normalizeMotifs(analysis.motifAnalysis?.groups);
      const segments = (Array.isArray(analysis.segments) ? analysis.segments : [])
        .filter(segment => segment && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);

      hasMap = true;
      rebuildBarChords();
      rebuildAllEvents();
      drawWheel();
      buildRibbon();
      buildModelBlocks(segments);
      update(audio.currentTime);
    } catch (error) {
      // HTTP failures are already in the console as failed requests.
      if (!/ returned \d+$/.test(error.message)) console.error(error);
      showMapUnavailable(error.message);
      if (error.message.includes('404')) openSongDialog();
    }
  };

  const updateTimelineReadout = (time, position = positionAt(time)) => {
    setText(timelineReadout, `${formatClock(time, true)} · ${formatPosition(position.bar, position.beat)} · ${barChords[position.bar]}`);
  };

  const chordSourceText = bar => {
    const entry = detectedChordBars[bar - 1];
    if (entry && Number.isFinite(entry.confidence)) {
      return `Charted · ${Math.round(entry.confidence * 100)}%${entry.alternate && entry.name !== 'N' ? ` · alt ${entry.alternate}` : ''}`;
    }
    if (!hasDetectedChords) return 'No chords detected';
    const run = chordRuns[chordRunIndexForBar(bar)];
    if (!run || run[2] === 'N') return 'No chord charted';
    return Number.isFinite(run[3]) ? `Charted · ${Math.round(run[3] * 100)}%` : 'Charted';
  };

  const setActiveBlock = (kind, list, index) => {
    const previous = activeBlocks[kind];
    if (previous === index) return;
    list[previous]?.classList.remove('is-active');
    list[index]?.classList.add('is-active');
    activeBlocks[kind] = index;
  };

  const updateModelBlocks = time => {
    ribbonRefs.models.forEach(ref => {
      const active = time >= ref.start && time < ref.end;
      if (active === ref.active) return;
      ref.active = active;
      ref.node.classList.toggle('is-active', active);
    });
  };

  // Toggle wheel section classes only on the sections whose state changed.
  const applyWheelSectionClasses = (active, cue, imminent, beatOn) => {
    const previous = wheelClassState;
    if (previous && previous.active === active && previous.cue === cue
      && previous.imminent === imminent && previous.beatOn === beatOn) return;
    const indices = new Set([active, cue, previous?.active, previous?.cue].filter(index => Number.isInteger(index) && index >= 0));
    indices.forEach(index => {
      const nodes = wheelSectionNodes[index];
      if (!nodes) return;
      const isCue = index === cue;
      [nodes.path, nodes.label].forEach(node => {
        node.classList.toggle('is-active', index === active);
        node.classList.toggle('is-cued', isCue);
        node.classList.toggle('is-imminent', isCue && imminent);
        node.classList.toggle('is-beat-on', isCue && beatOn);
      });
    });
    wheelClassState = { active, cue, imminent, beatOn };
  };

  // Everything that only changes with the bar, beat, section or beat-grid index.
  const renderPosition = (time, bar, beat) => {
    const section = sections[activeSectionIndex];
    const chord = barChords[bar];
    const chordRunIndex = chordRunIndexForBar(bar);
    const chordRun = chordRuns[chordRunIndex];
    const nextChord = nextAfter(chordEvents, time);
    const nextSection = nextAfter(sectionEvents, time);
    const activeMotifs = motifsForBar(bar);
    const energyValue = energy[bar - 1] ?? 0;

    nowChordEl.textContent = chord;
    nowSectionEl.textContent = section.name;
    nowBarEl.textContent = formatPosition(bar, beat);
    nowMotifEl.textContent = activeMotifs.length
      ? activeMotifs.map(item => `${item.id} ${item.name}${Number.isFinite(item.confidence) ? ` ${Math.round(item.confidence * 100)}%` : ''}`).join(' · ')
      : 'No detected repeat';
    nowChordSourceEl.textContent = chordSourceText(bar);
    centerSectionEl.textContent = section.short;
    centerChordEl.textContent = chord;
    centerPositionEl.textContent = formatPosition(bar, beat);
    const chordRunStart = barStart(chordRun[0]);
    const chordRunEnd = chordRun[1] >= TOTAL_BARS ? DURATION : barStart(chordRun[1] + 1);
    const chordRunBeats = Math.max(1, beatsRemainingUntil(chordRunStart, chordRunEnd));
    const chordBeatsLeft = beatsRemainingUntil(time, chordRunEnd);
    const chordRunRemaining = clamp(chordBeatsLeft / chordRunBeats, 0, 1);
    centerNextChord.textContent = nextChord?.name ?? 'END';
    centerNextCount.textContent = nextChord ? chordBeatsLeft : '—';
    centerNextProgress.style.width = `${chordRunRemaining * 100}%`;
    energyLabelEl.textContent = `${Math.round(energyValue * 100)}%`;
    energyFillEl.style.width = `${energyValue * 100}%`;

    setCountdown('chord', nextChord?.name ?? 'Track end', nextChord?.time ?? DURATION, time);
    setCountdown('section', nextSection?.name ?? 'Track end', nextSection?.time ?? DURATION, time);

    const sectionCueBeats = nextSection ? beatsRemainingUntil(time, nextSection.time) : null;
    const cueIsActive = sectionCueBeats !== null && sectionCueBeats <= 8;
    cueState = {
      index: cueIsActive ? sections.findIndex(item => item.startBar === nextSection.bar) : -1,
      imminent: cueIsActive && sectionCueBeats <= 4
    };

    wheelSelection?.setAttribute('d', arcPath(350, 350, 213, 323, angleForBar(bar), angleForBar(bar + 1) - .0016));
    setActiveBlock('section', ribbonRefs.sections, activeSectionIndex);
    setActiveBlock('chord', ribbonRefs.chords, chordRunIndex);
    if (sectionTools.open) updateSectionTools();
  };

  const updateWheelPlayhead = (time, bar) => {
    if (!wheelPlayhead || !wheelProgress) return;
    const progress = clamp(time / DURATION, 0, 1);
    const angle = angleAtProgress(progress);
    const [x1, y1] = point(350, 350, 132, angle);
    const [x2, y2] = point(350, 350, 336, angle);
    wheelPlayhead.setAttribute('x1', x1);
    wheelPlayhead.setAttribute('y1', y1);
    wheelPlayhead.setAttribute('x2', x2);
    wheelPlayhead.setAttribute('y2', y2);
    wheelProgress.setAttribute('stroke-dashoffset', progressCircumference * (1 - progress));

    const barDuration = Math.max(.001, (bar >= TOTAL_BARS ? DURATION : barStart(bar + 1)) - barStart(bar));
    const beatDuration = barDuration / 4;
    const beatPhase = ((time - barStart(bar)) % beatDuration + beatDuration) % beatDuration / beatDuration;
    applyWheelSectionClasses(activeSectionIndex, cueState.index, cueState.imminent, beatPhase < .24);
  };

  const update = (time = audio.currentTime) => {
    if (!hasMap) return;
    const safeTime = clamp(Number.isFinite(time) ? time : 0, 0, DURATION);
    const position = positionAt(safeTime);
    const { bar, beat } = position;
    activeSectionIndex = sectionIndexForBar(bar);
    const beatIndex = musicalBeatGrid.length ? upperBound(musicalBeatGrid, safeTime + BEAT_TOLERANCE) : safeTime;
    const key = `${bar}|${beat}|${activeSectionIndex}|${beatIndex}`;
    if (key !== renderKey) {
      renderKey = key;
      renderPosition(safeTime, bar, beat);
    }

    setText(currentTimeEl, formatClock(safeTime, true));
    setText(timeToEndEl, `−${formatClock(DURATION - safeTime, true)}`);
    if (!isScrubbing) scrubber.value = safeTime;
    ribbonPlayhead.style.left = `${safeTime / DURATION * 100}%`;
    updateTimelineReadout(safeTime, position);
    updateWheelPlayhead(safeTime, bar);
    updateModelBlocks(safeTime);

    if (loopedSectionIndex !== null) {
      const looped = sections[loopedSectionIndex];
      const start = sectionStart(looped);
      const end = sectionEnd(looped);
      if (safeTime >= end - .025 || safeTime < start - .05) audio.currentTime = start;
    }
  };

  const animationLoop = () => {
    update(audio.currentTime);
    if (!audio.paused) animationFrame = requestAnimationFrame(animationLoop);
  };

  const playPause = async () => {
    if (!hasMap) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch (error) {
        nowSectionEl.textContent = 'Audio could not start. Reload the page, or check that HitMapper is still running.';
        console.error(error);
      }
    } else {
      audio.pause();
    }
  };

  const seekTo = time => {
    audio.currentTime = clamp(time, 0, DURATION);
    update(audio.currentTime);
  };

  const goToEvent = direction => {
    if (!hasMap) return;
    const now = audio.currentTime;
    const event = direction > 0
      ? navigationEvents.find(item => item.time > now + .25)
      : [...navigationEvents].reverse().find(item => item.time < now - .75);
    seekTo(event?.time ?? (direction > 0 ? DURATION : 0));
  };

  const toggleLoop = () => {
    if (!hasMap) return;
    if (loopedSectionIndex === null) {
      loopedSectionIndex = activeSectionIndex;
      const section = sections[loopedSectionIndex];
      loopSectionButton.textContent = `Loop: ${section.short}`;
      loopSectionButton.setAttribute('aria-pressed', 'true');
    } else {
      clearLoop();
    }
  };

  const showAudioUnavailable = () => {
    nowSectionEl.textContent = 'Audio is unavailable. Add the song again or check the HitMapper data volume.';
    playToggle.disabled = true;
  };

  // Switch between the original and the marker audio, keeping the position. If
  // the new source fails to load, go back to the one that was playing.
  const switchAudioMode = () => {
    if (switchingAudio || !hasMap) return;
    const wasPlaying = !audio.paused;
    const restoreTime = audio.currentTime;
    const previousMode = markerMode;
    switchingAudio = true;
    audioModeButton.disabled = true;
    audio.pause();

    const finish = async (mode, failed) => {
      markerMode = mode;
      switchingAudio = false;
      audio.currentTime = clamp(restoreTime, 0, Math.min(Number.isFinite(audio.duration) ? audio.duration : DURATION, DURATION));
      audio.playbackRate = Number(playbackRate.value);
      audioModeButton.disabled = false;
      audioModeButton.textContent = markerMode ? 'Original audio' : 'Hear AI markers';
      audioModeButton.setAttribute('aria-pressed', markerMode ? 'true' : 'false');
      audioModeButton.title = failed ? `${mode ? 'Original' : 'Marker'} audio could not be loaded` : audioModeTitle;
      update(audio.currentTime);
      if (wasPlaying) {
        try { await audio.play(); } catch (error) { console.error(error); }
      }
    };

    const load = (mode, onError) => {
      const listeners = new AbortController();
      audio.addEventListener('loadedmetadata', () => {
        listeners.abort();
        finish(mode, mode === previousMode);
      }, { signal: listeners.signal });
      audio.addEventListener('error', () => {
        listeners.abort();
        onError();
      }, { signal: listeners.signal });
      audio.src = mode ? MARKER_AUDIO : ORIGINAL_AUDIO;
      audio.load();
    };

    load(!previousMode, () => {
      console.warn(`${previousMode ? 'Original' : 'Marker'} audio could not be loaded; restoring the previous audio.`);
      load(previousMode, () => {
        markerMode = previousMode;
        switchingAudio = false;
        audioModeButton.disabled = false;
        showAudioUnavailable();
      });
    });
  };

  const showRibbonTooltip = (target, clientX) => {
    const panel = ribbon.closest('.timeline-panel');
    const panelRect = panel.getBoundingClientRect();
    const ribbonRect = ribbon.getBoundingClientRect();
    ribbonTooltip.textContent = target.dataset.ribbonInfo;
    ribbonTooltip.style.left = `${clamp(clientX - panelRect.left, 92, panelRect.width - 92)}px`;
    ribbonTooltip.style.top = `${ribbonRect.top - panelRect.top - 6}px`;
    ribbonTooltip.classList.add('is-visible');
  };

  const hideRibbonTooltip = () => {
    ribbonTooltip.classList.remove('is-visible');
  };

  const songDialog = $('#song-dialog');
  const uploadForm = $('#song-upload-form');
  const songFile = $('#song-file');
  const songName = $('#song-name');
  const songFileLabel = $('#song-file-label');
  const dropzone = $('#song-dropzone');
  const analysisProgress = $('#analysis-progress');
  const analysisStage = $('#analysis-stage');
  const analysisPercent = $('#analysis-percent');
  const analysisProgressFill = $('#analysis-progress-fill');
  const uploadError = $('#upload-error');
  const analyzeSongButton = $('#analyze-song');
  const cancelUploadButton = $('#cancel-song-upload');
  const songLibraryList = $('#song-library-list');
  const songLibraryEmpty = $('#song-library-empty');
  const songLibraryCount = $('#song-library-count');
  let activeUploadJob = null;
  let jobPollTimer = null;
  let libraryRefreshTimer = null;

  function openSongDialog({ refresh = true } = {}) {
    if (songDialog.open) return;
    songDialog.showModal();
    if (refresh) refreshLibrary();
  }

  const openProject = projectId => {
    const url = new URL(window.location.href);
    url.pathname = '/';
    url.search = '';
    url.searchParams.set('song', projectId);
    window.location.assign(url);
  };

  const renderSongLibrary = projects => {
    songLibraryList.replaceChildren();
    songLibraryEmpty.hidden = projects.length > 0;
    songLibraryCount.textContent = projects.length ? `${projects.length} saved` : '';
    projects.forEach(project => {
      const row = document.createElement('article');
      row.className = `song-library-row${project.id === selectedProjectId ? ' is-current' : ''}`;

      const copy = document.createElement('div');
      copy.className = 'song-library-copy';
      const name = document.createElement('strong');
      name.textContent = project.name || 'Untitled song';
      const meta = document.createElement('div');
      meta.className = 'song-library-meta';
      const status = document.createElement('span');
      status.className = `song-status ${project.status || ''}`;
      status.textContent = project.id === selectedProjectId ? 'open' : (project.status || 'unknown');
      const filename = document.createElement('span');
      filename.className = 'song-library-file';
      filename.textContent = project.status === 'analyzing' || project.status === 'queued'
        ? `${project.stage || 'Analyzing'} · ${Math.round(Number(project.progress) || 0)}%`
        : (project.filename || 'Audio file');
      meta.append(status, filename);
      copy.append(name, meta);

      const button = document.createElement('button');
      button.className = 'song-open-button';
      button.type = 'button';
      if (project.status === 'failed') {
        button.dataset.retryProject = project.id;
        button.textContent = 'Retry';
      } else {
        button.dataset.openProject = project.id;
        button.disabled = project.status !== 'ready';
        button.textContent = project.id === selectedProjectId ? 'Open now' : (project.status === 'ready' ? 'Open map' : 'Not ready');
      }
      row.append(copy, button);
      songLibraryList.appendChild(row);
    });
  };

  const fetchStatus = async () => {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Server status returned ${response.status}`);
    const status = await response.json();
    renderSongLibrary(Array.isArray(status.projects) ? status.projects : []);
    return status;
  };

  // While the dialog is open and something is queued or analyzing, keep the library current.
  const scheduleLibraryRefresh = status => {
    window.clearTimeout(libraryRefreshTimer);
    const pending = Boolean(status?.currentJob)
      || (Array.isArray(status?.projects) && status.projects.some(project => project.status === 'queued' || project.status === 'analyzing'));
    if (songDialog.open && pending) libraryRefreshTimer = window.setTimeout(refreshLibrary, 3000);
  };

  async function refreshLibrary() {
    window.clearTimeout(libraryRefreshTimer);
    try {
      scheduleLibraryRefresh(await fetchStatus());
    } catch (error) {
      console.warn(error);
      if (songDialog.open) libraryRefreshTimer = window.setTimeout(refreshLibrary, 6000);
    }
  }

  const setUploadError = message => {
    uploadError.textContent = message || '';
    uploadError.hidden = !message;
  };

  const showJobProgress = project => {
    activeUploadJob = project.id;
    uploadForm.classList.add('is-analyzing');
    analysisProgress.hidden = false;
    analysisStage.textContent = project.stage || 'Analyzing song';
    const progress = clamp(Number(project.progress) || 0, 0, 100);
    analysisPercent.textContent = `${Math.round(progress)}%`;
    analysisProgressFill.style.width = `${progress}%`;
    analyzeSongButton.disabled = true;
    analyzeSongButton.textContent = 'Analyzing…';
    cancelUploadButton.textContent = 'Hide';
  };

  const stopTrackingJob = (message, buttonLabel, { hideProgress = false } = {}) => {
    window.clearTimeout(jobPollTimer);
    activeUploadJob = null;
    uploadForm.classList.remove('is-analyzing');
    if (hideProgress) analysisProgress.hidden = true;
    analyzeSongButton.disabled = false;
    analyzeSongButton.textContent = buttonLabel;
    cancelUploadButton.textContent = 'Cancel';
    setUploadError(message);
    refreshLibrary();
  };

  const pollAnalysisJob = async projectId => {
    window.clearTimeout(jobPollTimer);
    if (activeUploadJob !== projectId) return;
    try {
      const response = await fetch(`/api/jobs/${projectId}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      // Ignore a response for a job this page has stopped tracking.
      if (activeUploadJob !== projectId) return;
      if (response.status >= 400 && response.status < 500) {
        // The job is gone or was refused; polling again won't change that.
        stopTrackingJob(payload.error || `Status request returned ${response.status}`, 'Analyze song', { hideProgress: true });
        return;
      }
      if (!response.ok || !payload.project) throw new Error(payload.error || `Status request returned ${response.status}`);
      const project = payload.project;
      showJobProgress(project);
      if (project.status === 'ready') {
        analysisStage.textContent = 'Map ready — opening song';
        analysisPercent.textContent = '100%';
        analysisProgressFill.style.width = '100%';
        window.setTimeout(() => openProject(project.id), 500);
        return;
      }
      if (project.status === 'failed') {
        stopTrackingJob(project.error || 'Analysis failed.', 'Try another song');
        return;
      }
      jobPollTimer = window.setTimeout(() => pollAnalysisJob(projectId), 1500);
    } catch (error) {
      if (activeUploadJob !== projectId) return;
      setUploadError(error.message);
      jobPollTimer = window.setTimeout(() => pollAnalysisJob(projectId), 3000);
    }
  };

  const trackJob = project => {
    showJobProgress(project);
    pollAnalysisJob(project.id);
    refreshLibrary();
  };

  const initializeSongState = async () => {
    try {
      const status = await fetchStatus();
      if (!selectedProjectId && status.currentJob) {
        showJobProgress(status.currentJob);
        pollAnalysisJob(status.currentJob.id);
      }
      if (!selectedProjectId) openSongDialog({ refresh: false });
      scheduleLibraryRefresh(status);
    } catch (error) {
      setUploadError(`HitMapper server is not available: ${error.message}`);
      openSongDialog({ refresh: false });
    }
  };

  const chooseFiles = files => {
    const file = files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    songFile.files = transfer.files;
    songFileLabel.textContent = file.name;
    if (!songName.value.trim()) songName.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    setUploadError('');
  };

  $('#open-song-dialog').addEventListener('click', () => openSongDialog());
  songLibraryList.addEventListener('click', async event => {
    const openButton = event.target.closest('[data-open-project]');
    if (openButton) {
      if (!openButton.disabled) openProject(openButton.dataset.openProject);
      return;
    }
    const retryButton = event.target.closest('[data-retry-project]');
    if (!retryButton) return;
    retryButton.disabled = true;
    retryButton.textContent = 'Starting…';
    setUploadError('');
    try {
      const response = await fetch(`/api/projects/${retryButton.dataset.retryProject}/retry`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Retry returned ${response.status}`);
      trackJob(payload.project);
    } catch (error) {
      retryButton.disabled = false;
      retryButton.textContent = 'Retry';
      setUploadError(error.message);
    }
  });
  $('#close-song-dialog').addEventListener('click', () => songDialog.close());
  cancelUploadButton.addEventListener('click', () => songDialog.close());
  songDialog.addEventListener('close', () => window.clearTimeout(libraryRefreshTimer));
  songFile.addEventListener('change', () => chooseFiles(songFile.files));
  ['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    if (type === 'drop') chooseFiles(event.dataTransfer.files);
  }));
  uploadForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (activeUploadJob || !songFile.files.length) return;
    setUploadError('');
    analyzeSongButton.disabled = true;
    analyzeSongButton.textContent = 'Uploading…';
    const formData = new FormData();
    formData.append('song', songFile.files[0]);
    formData.append('name', songName.value.trim());
    try {
      const response = await fetch('/api/tracks', { method: 'POST', body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Upload returned ${response.status}`);
      trackJob(payload.project);
    } catch (error) {
      activeUploadJob = null;
      analyzeSongButton.disabled = false;
      analyzeSongButton.textContent = 'Analyze song';
      setUploadError(error.message);
    }
  });

  playToggle.addEventListener('click', playPause);
  previousEventButton.addEventListener('click', () => goToEvent(-1));
  nextEventButton.addEventListener('click', () => goToEvent(1));
  loopSectionButton.addEventListener('click', toggleLoop);
  audioModeButton.addEventListener('click', switchAudioMode);
  ribbonZoomOut.addEventListener('click', () => setRibbonZoom(ribbonZoom - .25));
  ribbonZoomReset.addEventListener('click', () => setRibbonZoom(1));
  ribbonZoomIn.addEventListener('click', () => setRibbonZoom(ribbonZoom + .25));
  sectionTools.addEventListener('toggle', updateSectionTools);
  renameSectionButton.addEventListener('click', renameActiveSection);
  sectionNameInput.addEventListener('focus', () => { renameTargetIndex = activeSectionIndex; });
  sectionNameInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    renameActiveSection();
  });
  addDividerButton.addEventListener('click', addDividerAtPlayhead);
  removeLeftDividerButton.addEventListener('click', () => removeAdjacentDivider(-1));
  removeRightDividerButton.addEventListener('click', () => removeAdjacentDivider(1));
  ribbonScroll.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setRibbonZoom(ribbonZoom + (event.deltaY < 0 ? .25 : -.25));
  }, { passive: false });
  resetSectionsButton.addEventListener('click', () => {
    if (!hasMap) return;
    if (store.get(SECTION_EDITS_KEY)
      && !window.confirm('Reset all section boundaries to the latest detected structure?')) return;
    store.remove(SECTION_EDITS_KEY);
    sections = cloneSections(detectedSectionDefaults);
    clearLoop();
    rebuildSectionEvents();
    drawWheel();
    buildRibbon();
    update(audio.currentTime);
  });

  playbackRate.addEventListener('change', () => { audio.playbackRate = Number(playbackRate.value); });
  scrubber.addEventListener('pointerdown', () => { isScrubbing = true; });
  scrubber.addEventListener('pointerup', () => { isScrubbing = false; });
  scrubber.addEventListener('input', () => { seekTo(Number(scrubber.value)); });

  let hoveredSectionBlock = null;
  const setHoveredSectionBlock = block => {
    if (block === hoveredSectionBlock) return;
    hoveredSectionBlock?.classList.remove('is-hovered');
    block?.classList.add('is-hovered');
    hoveredSectionBlock = block;
  };

  ribbon.addEventListener('pointermove', event => {
    setHoveredSectionBlock(event.target.closest?.('.section-block') ?? null);
    if (!hasMap) return;
    const rect = ribbon.getBoundingClientRect();
    updateTimelineReadout(clamp((event.clientX - rect.left) / rect.width, 0, 1) * DURATION);
    const target = event.target.closest?.('[data-ribbon-info]');
    if (target) {
      showRibbonTooltip(target, event.clientX);
    } else {
      hideRibbonTooltip();
    }
  });
  ribbon.addEventListener('pointerleave', () => {
    setHoveredSectionBlock(null);
    if (hasMap) updateTimelineReadout(audio.currentTime);
    hideRibbonTooltip();
  });
  ribbon.addEventListener('click', event => {
    if (!hasMap || event.target.closest?.('.section-resize-handle')) return;
    const rect = ribbon.getBoundingClientRect();
    seekTo(clamp((event.clientX - rect.left) / rect.width, 0, 1) * DURATION);
  });
  ribbon.addEventListener('focusin', event => {
    const target = event.target.closest?.('[data-ribbon-info]');
    if (!target) return;
    const targetRect = target.getBoundingClientRect();
    showRibbonTooltip(target, targetRect.left + targetRect.width / 2);
  });
  ribbon.addEventListener('focusout', hideRibbonTooltip);
  ribbon.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target.closest?.('[data-seek-time]');
    if (!target) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (hasMap) seekTo(Number(target.dataset.seekTime));
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = laneTargets(target.parentElement);
    const index = items.indexOf(target);
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : clamp(index + (event.key === 'ArrowRight' ? 1 : -1), 0, items.length - 1);
    const next = items[nextIndex];
    if (!next || next === target) return;
    target.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });

  audio.addEventListener('play', () => {
    playToggle.textContent = '❚❚';
    playToggle.setAttribute('aria-label', 'Pause');
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(animationLoop);
  });
  audio.addEventListener('pause', () => {
    playToggle.textContent = '▶';
    playToggle.setAttribute('aria-label', 'Play');
    if (animationFrame) cancelAnimationFrame(animationFrame);
    update(audio.currentTime);
  });
  audio.addEventListener('seeked', () => update(audio.currentTime));
  audio.addEventListener('loadedmetadata', () => {
    scrubber.max = Number.isFinite(audio.duration) ? audio.duration : DURATION;
    // switchAudioMode() restores the position itself.
    if (!switchingAudio) update(audio.currentTime);
  });
  audio.addEventListener('ended', () => {
    const looped = loopedSectionIndex !== null ? sections[loopedSectionIndex] : null;
    if (looped) {
      // The last section ends with the track, so the frame loop's check may never see its end.
      audio.currentTime = sectionStart(looped);
      audio.play().catch(error => console.error(error));
      return;
    }
    update(DURATION);
  });
  audio.addEventListener('error', () => {
    if (switchingAudio || !audio.getAttribute('src')) return;
    showAudioUnavailable();
  });

  const saveNotes = () => {
    if (NOTES_KEY) store.set(NOTES_KEY, sessionNotes.value);
  };
  setNotesEnabled(false);
  sessionNotes.addEventListener('input', saveNotes);
  stampNoteButton.addEventListener('click', () => {
    if (!hasMap) return;
    const { bar, beat } = positionAt(audio.currentTime);
    const stamp = `[${formatClock(audio.currentTime, true)} · ${formatPosition(bar, beat)} · ${barChords[bar]}] `;
    const prefix = sessionNotes.value && !sessionNotes.value.endsWith('\n') ? '\n' : '';
    const insertion = `${prefix}${stamp}`;
    const start = sessionNotes.selectionStart ?? sessionNotes.value.length;
    const end = sessionNotes.selectionEnd ?? start;
    sessionNotes.setRangeText(insertion, start, end, 'end');
    sessionNotes.focus();
    saveNotes();
  });
  clearNotesButton.addEventListener('click', () => {
    if (sessionNotes.value && window.confirm('Clear the locally saved HitMapper notes?')) {
      sessionNotes.value = '';
      if (NOTES_KEY) store.remove(NOTES_KEY);
    }
  });

  // Global shortcuts. Text fields and selects keep every key; buttons, <summary>
  // and ribbon targets keep Space and Enter (their own activation), but the
  // arrows and L still work there so a mouse click on a transport button doesn't
  // switch the shortcuts off.
  // The playback slider is an input too, but the shortcuts should keep working
  // after it has been used.
  const TEXT_ENTRY = 'input:not([type="range"]), textarea, select, [contenteditable]:not([contenteditable="false"])';
  const ACTIVATABLE = 'button, summary, [role="button"]';
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (songDialog.open) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(TEXT_ENTRY)) return;
    const onActivatable = Boolean(target?.closest(ACTIVATABLE));
    if (event.code === 'Space' || event.key === ' ') {
      if (onActivatable) return;
      event.preventDefault();
      playPause();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (event.shiftKey) goToEvent(1); else if (hasMap) seekTo(audio.currentTime + 5);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (event.shiftKey) goToEvent(-1); else if (hasMap) seekTo(audio.currentTime - 5);
    } else if (event.key.toLowerCase() === 'l') {
      event.preventDefault();
      toggleLoop();
    }
  });

  resetMapState(placeholderSection(selectedProjectId ? 'Loading song…' : 'No song loaded', selectedProjectId ? 'Loading' : ''));
  rebuildAllEvents();
  setRibbonZoom(ribbonZoom);
  drawWheel();
  buildRibbon();
  if (selectedProjectId) {
    nowSectionEl.textContent = 'Loading song…';
    nowChordSourceEl.textContent = 'Loading detection…';
    buildModelLane();
  }
  initializeSongState();
})();
