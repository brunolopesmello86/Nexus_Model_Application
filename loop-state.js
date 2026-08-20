// ══════════════════════════════════════════════════════════════════════
// Möbius Loop — State Layer
// Reads/writes window.loopSessions and window.activeLoop
// Reads board state from global vars (gridState, connections, experimentResults, boardMarkers, allItems)
// ══════════════════════════════════════════════════════════════════════

window.loopSessions  = window.loopSessions  || [];
window.activeLoop    = window.activeLoop    || null;
window.loopDockOpen  = window.loopDockOpen  || false;

// ── Diagnostic prompts keyed by domain ──────────────────────────────
window.LOOP_PROMPTS = {
  'Strategy & Portfolio': [
    'What strategic bets are being ignored or delayed?',
    'Where is leadership attention fragmented across too many priorities?',
    'Which capabilities are being starved of investment?',
    'What decisions keep being revisited without resolution?',
    'Where is alignment breaking down between layers of leadership?'
  ],
  'Product & Delivery': [
    'Where does user feedback get lost before reaching the team?',
    'What delivery bottlenecks recur cycle after cycle?',
    'Which features are being built without clear user validation?',
    'Where do handoffs between teams introduce delay or loss of context?',
    'What "done" criteria are ambiguous or contested?'
  ],
  'Technology & Architecture': [
    'What technical debt is actively blocking experiments or releases?',
    'Where are architecture decisions creating coupling that slows change?',
    'Which systems lack observability, making failure invisible?',
    'Where is toil consuming engineering capacity that could be automated?',
    'What security or compliance constraints are treated as blockers rather than design inputs?'
  ],
  'People, Culture & Governance': [
    'What behaviours are rewarded that contradict the intended culture?',
    'Where is psychological safety low enough to suppress honest signals?',
    'Which governance processes create bottlenecks without adding value?',
    'What habits are teams defending that no longer serve the mission?',
    'Where is accountability diffused to the point where no one owns outcomes?'
  ],
  'Operations': [
    'What processes have no clear owner and drift toward chaos?',
    'Where does operational complexity prevent small experiments from running?',
    'Which metrics are being tracked but never acted upon?',
    'What runbooks or procedures are outdated and silently causing failure?',
    'Where is operational knowledge locked in individuals rather than systems?'
  ],
  _default: [
    'What signals of friction or slowdown are you observing?',
    'Where do decisions consistently get stuck or reversed?',
    'What patterns of behaviour are working against transformation?',
    'Which team habits are consuming energy without producing value?',
    'Where is the gap between what people say and what they do widest?'
  ]
};

// ── Helpers ──────────────────────────────────────────────────────────

function _boardAntipatternCount() {
  if (!window.gridState || !window.allItems) return 0;
  return Object.values(window.gridState).filter(id => {
    const item = (typeof resolveItem !== 'undefined') ? resolveItem(id) : window.allItems.find(i => i.id === id);
    return item && item.type === 'antipattern';
  }).length;
}

function _boardPatternCount() {
  if (!window.gridState || !window.allItems) return 0;
  return Object.values(window.gridState).filter(id => {
    const item = (typeof resolveItem !== 'undefined') ? resolveItem(id) : window.allItems.find(i => i.id === id);
    return item && item.type === 'pattern';
  }).length;
}

function _experimentResultCount() {
  if (!window.experimentResults) return 0;
  return Object.keys(window.experimentResults).length;
}

function _connectionCount() {
  if (!window.connections) return 0;
  return window.connections.length;
}

// ── Phase Gate Logic ─────────────────────────────────────────────────

window.getLoopReadiness = function(phase) {
  const loop = window.activeLoop;
  if (!loop) return { ready: false, missing: ['No active loop'] };

  const s = (typeof window.loopBoardStats === 'function')
    ? window.loopBoardStats() : { agents: 0, total: 0, filled: 0, unresolved: 0 };
  const missing = [];

  if (phase === 1) {        // FOCUS → EXPERIMENT
    if (s.agents < 1) missing.push('Place at least 1 Agent on the board — nothing moves without one');
    if (s.filled  < 1) missing.push('Build at least 1 experiment card (fully filled) from a capability hex');
  } else if (phase === 2) { // EXPERIMENT → STABILIZE
    if (s.total < 1) missing.push('This cycle has no experiments yet');
    else if (s.unresolved > 0) missing.push(s.unresolved + ' experiment' + (s.unresolved > 1 ? 's' : '') + ' still open — resolve every one (adopt / adapt / abandon) before closing the phase');
  }
  // Phase 0 (Sense→Focus), 3 (Stabilize→Diffuse), 4 (Diffuse→Complete): advance when the facilitator is ready.

  return { ready: missing.length === 0, missing };
};

// ── Session Management ───────────────────────────────────────────────

window.startLoop = function(anchorId, anchorName, anchorHexKey) {
  if (window.activeLoop) {
    if (!confirm('A loop session is already active. Start a new one? (current session will be cancelled)')) return;
    window.activeLoop = null;
  }

  // Anchorless cycle — numbered by how many cycles have completed.
  const prevCycles = window.loopSessions.filter(s => s.completedAt).length;

  window.activeLoop = {
    id:           'loop_' + Date.now(),
    anchorId:     anchorId || null,
    anchorName:   anchorName || 'Möbius Loop',
    anchorHexKey: anchorHexKey || null,
    cycleNum:     prevCycles + 1,
    phase:        0,
    diffuse:      { nextSignal: '' },
    completedAt:  null
  };

  window.loopDockOpen = true;
  if (window.renderLoopDock)   window.renderLoopDock();
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.advanceLoopPhase = function() {
  const loop = window.activeLoop;
  if (!loop) return;

  const { ready } = window.getLoopReadiness(loop.phase);
  if (!ready) {
    const btn = document.getElementById('loopAdvanceBtn');
    if (btn) { btn.classList.add('shake'); setTimeout(() => btn.classList.remove('shake'), 500); }
    return;
  }
  if (loop.phase === 4) { window.completeLoop(); return; }
  loop.phase++;
  if (window.renderLoopDock)   window.renderLoopDock();
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.backLoopPhase = function() {
  const loop = window.activeLoop;
  if (!loop || loop.phase === 0) return;
  loop.phase--;
  if (window.renderLoopDock)  window.renderLoopDock();
  if (window.renderLoopModal) window.renderLoopModal();
};

window.completeLoop = function() {
  const loop = window.activeLoop;
  if (!loop) return;

  loop.completedAt = new Date().toISOString();
  window.loopSessions.push({ ...loop });
  window.activeLoop = null;

  document.getElementById('loopModal').classList.remove('show');
  if (window.renderLoopDock) window.renderLoopDock();
  if (window.renderBoard)    window.renderBoard();
  if (window.scheduleAutoSave) window.scheduleAutoSave();

  // Prompt for next cycle seed
  const next = loop.diffuse.nextSignal || loop.nextSignal || '';
  if (next && next.trim()) {
    setTimeout(() => {
      const msg = `Loop completed! "${next}" noted as the seed for Cycle ${loop.cycleNum + 1}.`;
      if (window.addLog) window.addLog(msg, 'success');
    }, 300);
  }
  if (window.addLog) window.addLog(`Möbius Loop Cycle ${loop.cycleNum} completed — anchor: ${loop.anchorName}`, 'success');
};

window.cancelLoop = function() {
  if (window.activeLoop) {
    if (!confirm('Cancel this loop session? Unsaved progress will be lost.')) return;
    window.activeLoop = null;
  }
  document.getElementById('loopModal').classList.remove('show');
  if (window.renderLoopDock) window.renderLoopDock();
  if (window.renderBoard)    window.renderBoard();
};

window.toggleLoopDock = function() {
  window.loopDockOpen = !window.loopDockOpen;
  if (window.renderLoopDock) window.renderLoopDock();
};

window.openLoopModal = function() {
  if (!window.activeLoop) return;
  document.getElementById('loopModal').classList.add('show');
  if (window.renderLoopModal) window.renderLoopModal();
};

window.openLoopLog = function() {
  document.getElementById('loopModal').classList.add('show');
  if (window.renderLoopModal) window.renderLoopModal('log');
};
