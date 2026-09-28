// ══════════════════════════════════════════════════════════════════════
// Möbius Loop — UI Layer
// Renders #loopDock based on window.activeLoop state
// ══════════════════════════════════════════════════════════════════════

const LOOP_PHASE_META = [
  { n:'Sense',      i:'👁',  key:'sense',      color:'#e8943a', hint:'Observe signals, friction, bottlenecks — no solutions yet.' },
  { n:'Focus',      i:'🎯',  key:'focus',      color:'#4a90d9', hint:'Select 1–2 anti-patterns to target. Name the habit, not the project.' },
  { n:'Experiment', i:'🧪',  key:'experiment', color:'#7b5ea7', hint:'Design the smallest possible safe-to-fail action.' },
  { n:'Stabilize',  i:'🔒',  key:'stabilize',  color:'#2d9d5e', hint:'Lock the gain: one norm, one owner, one cadence.' },
  { n:'Diffuse',    i:'🌊',  key:'diffuse',    color:'#38b2a0', hint:'Tell the story. Create pull. Seed the next cycle.' }
];

// ── Loop Dock ─────────────────────────────────────────────────────────

window.renderLoopDock = function() {
  const dock = document.getElementById('loopDock');
  if (!dock) return;

  const loop  = window.activeLoop;
  const open  = window.loopDockOpen;
  const done  = (window.loopSessions || []).filter(s => s.completedAt).length;

  dock.className = 'loop-dock' + (open ? ' loop-dock-open' : '') + (loop ? ' loop-dock-active' : '');

  let body = '';
  if (open) {
    if (!loop) {
      body = `
        <div class="loop-dock-empty">Start a cycle at <strong>Sense</strong> — probe the system for anti-patterns, friction and tensions.</div>
        <div class="loop-dock-meta">${done} cycle${done!==1?'s':''} completed</div>
        <button class="loop-dock-btn primary" style="width:100%;margin-top:8px" onclick="startLoop()">▶ Start Möbius Loop</button>`;
    } else {
      const ph = LOOP_PHASE_META[loop.phase];
      const dots = LOOP_PHASE_META.map((p, i) => {
        const cls = i < loop.phase ? 'loop-dot done' : i === loop.phase ? 'loop-dot active' : 'loop-dot';
        return `<span class="${cls}" title="${p.n}" style="background:${i<=loop.phase?ph.color:''}"></span>`;
      }).join('');
      const rd = window.getLoopReadiness(loop.phase);
      const gate = rd.missing.length ? `<div class="loop-dock-gate">${rd.missing.map(m => '• ' + esc(m)).join('<br>')}</div>` : '';
      const advLabel = loop.phase === 4 ? '✓ Complete cycle' : esc(LOOP_PHASE_META[loop.phase + 1].n) + ' →';
      body = `
        <div class="loop-dock-anchor"><span class="loop-dock-anchor-icon">${ph.i}</span>${esc(ph.n)}</div>
        <div class="loop-dock-meta">Cycle ${loop.cycleNum} &nbsp;·&nbsp; phase ${loop.phase + 1} of 5</div>
        <div class="loop-dock-dots">${dots}</div>
        <div class="loop-dock-tip">${esc(ph.hint)}</div>
        ${gate}
        <div class="loop-dock-actions" style="margin-top:9px">
          ${loop.phase > 0 ? `<button class="loop-dock-btn" onclick="backLoopPhase()" title="Back a phase">←</button>` : ''}
          <button class="loop-dock-btn primary" id="loopAdvanceBtn" style="flex:1${rd.ready ? '' : ';opacity:.5'}" onclick="advanceLoopPhase()">${advLabel}</button>
          <button class="loop-dock-btn danger" onclick="cancelLoop()" title="Cancel this cycle">✕</button>
        </div>`;
    }
  }

  document.getElementById('loopDockBody').innerHTML = body;
};

// ── Utility ───────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

// ── Init ──────────────────────────────────────────────────────────────

// Render dock once DOM is ready (called after DOMContentLoaded in index.html context)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (window.renderLoopDock) window.renderLoopDock();
  });
} else {
  // Scripts loaded after DOMContentLoaded — render immediately
  setTimeout(() => { if (window.renderLoopDock) window.renderLoopDock(); }, 0);
}
