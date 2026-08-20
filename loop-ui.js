// ══════════════════════════════════════════════════════════════════════
// Möbius Loop — UI Layer
// Renders #loopDock and #loopModal based on window.activeLoop state
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

// ── Loop Modal ────────────────────────────────────────────────────────

window.renderLoopModal = function(forceView) {
  const sidebar = document.getElementById('loopPhaseSidebar');
  const content = document.getElementById('loopPhaseContent');
  if (!sidebar || !content) return;

  const loop = window.activeLoop;
  const view = forceView || (loop ? 'phase' : 'log');

  // Phase sidebar
  if (view === 'phase' && loop) {
    sidebar.innerHTML = `
      <div class="loop-modal-header">
        <div class="loop-modal-title">⟳ Möbius Loop</div>
        <div class="loop-modal-subtitle">Cycle ${loop.cycleNum} &nbsp;·&nbsp; ${esc(loop.anchorName)}</div>
      </div>
      <div class="loop-phase-steps">
        ${LOOP_PHASE_META.map((p, i) => {
          const isDone = i < loop.phase;
          const isAct  = i === loop.phase;
          return `<div class="loop-phase-step${isAct?' active':''}${isDone?' done':''}" onclick="if(${isDone})window.backLoopPhase()">
            <div class="loop-phase-step-dot" style="background:${isAct||isDone?p.color:''}">
              ${isDone ? '✓' : p.i}
            </div>
            <div class="loop-phase-step-info">
              <div class="loop-phase-step-name">${p.n}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="loop-modal-log-btn">
        <button class="loop-dock-btn" style="width:100%" onclick="window.renderLoopModal('log')">📋 Cycle Log (${(window.loopSessions||[]).filter(s=>s.completedAt).length})</button>
      </div>`;
  } else {
    sidebar.innerHTML = `
      <div class="loop-modal-header">
        <div class="loop-modal-title">⟳ Möbius Loop</div>
        <div class="loop-modal-subtitle">Cycle Log</div>
      </div>
      ${loop ? `<button class="loop-dock-btn primary" style="margin:12px;width:calc(100% - 24px)" onclick="window.renderLoopModal('phase')">← Active Loop</button>` : ''}`;
  }

  // Content area
  if (view === 'log') {
    content.innerHTML = renderCycleLogContent();
    return;
  }
  if (!loop) { content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">No active loop.</div>'; return; }

  const ph = LOOP_PHASE_META[loop.phase];
  const { ready, missing } = window.getLoopReadiness(loop.phase);

  const checklistHtml = `
    <div class="loop-readiness-panel">
      <div class="loop-readiness-title">Ready to advance?</div>
      ${ready
        ? `<div class="loop-readiness-ok">✓ All conditions met</div>`
        : missing.map(m => `<div class="loop-readiness-item fail">✗ ${esc(m)}</div>`).join('')}
    </div>`;

  const navHtml = `
    <div class="loop-nav">
      ${loop.phase > 0 ? `<button class="loop-nav-btn secondary" onclick="window.backLoopPhase()">← Back</button>` : '<span></span>'}
      <button id="loopAdvanceBtn" class="loop-nav-btn primary${ready?'':' dimmed'}"
        onclick="window.advanceLoopPhase()">
        ${loop.phase === 4 ? '🌊 Complete Loop' : `Advance to ${LOOP_PHASE_META[loop.phase+1]?.n||'Complete'} →`}
      </button>
    </div>`;

  let phaseBodyHtml = '';
  if (loop.phase === 0) phaseBodyHtml = renderSensePhase(loop, ph);
  else if (loop.phase === 1) phaseBodyHtml = renderFocusPhase(loop, ph);
  else if (loop.phase === 2) phaseBodyHtml = renderExperimentPhase(loop, ph);
  else if (loop.phase === 3) phaseBodyHtml = renderStabilizePhase(loop, ph);
  else if (loop.phase === 4) phaseBodyHtml = renderDiffusePhase(loop, ph);

  content.innerHTML = `
    <div class="loop-phase-header" style="border-left:3px solid ${ph.color}">
      <div class="loop-phase-icon">${ph.i}</div>
      <div>
        <div class="loop-phase-title" style="color:${ph.color}">${ph.n}</div>
        <div class="loop-phase-hint">${ph.hint}</div>
      </div>
      <button class="loop-close-btn" onclick="document.getElementById('loopModal').classList.remove('show')">✕</button>
    </div>
    <div class="loop-phase-body">
      ${phaseBodyHtml}
    </div>
    ${checklistHtml}
    ${navHtml}`;
};

// ── Phase 0: Sense ────────────────────────────────────────────────────

function renderSensePhase(loop, ph) {
  const anchor = (typeof resolveItem !== 'undefined') ? resolveItem(loop.anchorId) : (window.allItems ? window.allItems.find(i => i.id === loop.anchorId) : null);
  const domain = anchor ? anchor.domain : null;
  const promptSet = (window.LOOP_PROMPTS || {})[domain] || (window.LOOP_PROMPTS || {})._default || [];

  const promptsHtml = promptSet.map(p => `<div class="loop-prompt">❓ ${esc(p)}</div>`).join('');
  const signalsHtml = loop.sense.signals.map((s, i) => `
    <div class="loop-signal-card">
      <div class="loop-signal-text">${esc(s.text)}</div>
      <div class="loop-signal-meta">${s.ts ? new Date(s.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''}</div>
      <button class="loop-signal-del" onclick="loopRemoveSignal(${i})">✕</button>
    </div>`).join('');

  return `
    <div class="loop-section">
      <div class="loop-section-title">Diagnostic prompts <span class="loop-section-badge" style="background:${ph.color}">${domain||'General'}</span></div>
      <div class="loop-prompts">${promptsHtml}</div>
    </div>
    <div class="loop-section">
      <div class="loop-section-title">Signal cards <span class="loop-section-badge">min 1</span></div>
      <div id="loopSignalList">${signalsHtml}</div>
      <div class="loop-add-row">
        <textarea id="loopSignalInput" class="loop-input loop-textarea" placeholder="Describe a friction signal, anti-pattern, or bottleneck you observe…" rows="2"></textarea>
        <button class="loop-dock-btn primary" onclick="loopAddSignal()">+ Add Signal</button>
      </div>
      <div class="loop-sense-tip">⚠ No solutions at this stage. Observe only.</div>
    </div>`;
}

window.loopAddSignal = function() {
  const input = document.getElementById('loopSignalInput');
  const text = (input ? input.value : '').trim();
  if (!text || !window.activeLoop) return;
  window.activeLoop.sense.signals.push({ text, ts: new Date().toISOString() });
  input.value = '';
  if (window.scheduleAutoSave) window.scheduleAutoSave();
  window.renderLoopModal();
};

window.loopRemoveSignal = function(idx) {
  if (!window.activeLoop) return;
  window.activeLoop.sense.signals.splice(idx, 1);
  if (window.scheduleAutoSave) window.scheduleAutoSave();
  window.renderLoopModal();
};

// ── Phase 1: Focus ────────────────────────────────────────────────────

function renderFocusPhase(loop, ph) {
  // Gather anti-patterns on the board
  const boardAPs = Object.entries(window.gridState || {})
    .map(([key, id]) => ({ key, item: (typeof resolveItem !== 'undefined') ? resolveItem(id) : (window.allItems||[]).find(i=>i.id===id) }))
    .filter(({ item }) => item && item.type === 'antipattern');

  const apHtml = boardAPs.length === 0
    ? `<div class="loop-empty-msg">No anti-patterns on the board yet. Go back to Sense and add some.</div>`
    : boardAPs.map(({ key, item }) => {
        const sel = loop.focus.selected.includes(item.id);
        const disabled = !sel && loop.focus.selected.length >= 2;
        return `<div class="loop-focus-item${sel?' selected':''}${disabled?' disabled':''}"
          onclick="${disabled?'':''}"
          data-ap-id="${item.id}"
          ${!disabled ? `onclick="loopToggleFocusAP('${item.id}')"` : ''}>
          <div class="loop-focus-badge">ANTI</div>
          <div class="loop-focus-info">
            <div class="loop-focus-name">${esc(item.name)}</div>
            <div class="loop-focus-signal">${esc(item.signal||'')}</div>
            ${item.domain ? `<div class="loop-focus-domain">${esc(item.domain)}</div>` : ''}
          </div>
          ${sel ? '<div class="loop-focus-check">✓</div>' : ''}
        </div>`;
      }).join('');

  const sigHtml = loop.sense.signals.map(s => `<div class="loop-signal-ref">• ${esc(s.text)}</div>`).join('');

  return `
    <div class="loop-section">
      <div class="loop-section-title">Signals from Sense phase</div>
      <div class="loop-signal-refs">${sigHtml || '<em style="color:var(--text-muted)">None recorded</em>'}</div>
    </div>
    <div class="loop-section">
      <div class="loop-section-title">Select 1–2 anti-patterns to focus on <span class="loop-section-badge">${loop.focus.selected.length}/2 selected</span></div>
      <div class="loop-focus-grid">${apHtml}</div>
    </div>
    <div class="loop-section">
      <div class="loop-section-title">What behaviour or habit are you targeting?</div>
      <div class="loop-input-hint">Describe the specific behaviour — not a project, not a tool. A habit someone has.</div>
      <textarea class="loop-input loop-textarea" rows="2" id="loopFocusBehavior"
        placeholder="e.g. 'Teams waiting for approval before taking the next step…'"
        oninput="window.activeLoop.focus.behavior=this.value"
      >${esc(loop.focus.behavior)}</textarea>
    </div>`;
}

window.loopToggleFocusAP = function(hexId) {
  if (!window.activeLoop) return;
  const sel = window.activeLoop.focus.selected;
  const idx = sel.indexOf(hexId);
  if (idx >= 0) { sel.splice(idx, 1); }
  else if (sel.length < 2) { sel.push(hexId); }
  if (window.scheduleAutoSave) window.scheduleAutoSave();
  window.renderLoopModal();
};

// ── Phase 2: Experiment ───────────────────────────────────────────────

function renderExperimentPhase(loop, ph) {
  const cards = loop.experiment;
  if (!cards.length) {
    return `<div class="loop-empty-msg">No focused items found. Go back to Focus and select at least 1 anti-pattern.</div>`;
  }

  const cardsHtml = cards.map((c, ci) => `
    <div class="loop-exp-card">
      <div class="loop-exp-card-header">
        <span class="loop-exp-card-num">EXP ${ci+1}</span>
        <span class="loop-exp-signal">${esc(c.signal)}</span>
      </div>
      <div class="loop-exp-fields">
        <div class="loop-exp-field">
          <label>Smallest action <span class="loop-required">*</span></label>
          <textarea class="loop-input" rows="2" placeholder="What's the smallest possible change we can test?"
            oninput="window.activeLoop.experiment[${ci}].action=this.value"
          >${esc(c.action)}</textarea>
        </div>
        <div class="loop-exp-field">
          <label>Owner <span class="loop-required">*</span></label>
          <input class="loop-input" type="text" placeholder="Who owns this?"
            value="${esc(c.owner)}"
            oninput="window.activeLoop.experiment[${ci}].owner=this.value" />
        </div>
        <div class="loop-exp-field">
          <label>By when</label>
          <input class="loop-input" type="text" placeholder="e.g. end of sprint, 2 weeks"
            value="${esc(c.by)}"
            oninput="window.activeLoop.experiment[${ci}].by=this.value" />
        </div>
        <div class="loop-exp-field">
          <label>How will we know it worked?</label>
          <textarea class="loop-input" rows="2" placeholder="Observable signal of success (not a metric — a behaviour)…"
            oninput="window.activeLoop.experiment[${ci}].successCriteria=this.value"
          >${esc(c.successCriteria)}</textarea>
        </div>
      </div>
    </div>`).join('');

  return `
    <div class="loop-section">
      <div class="loop-section-title">Experiment cards <span class="loop-section-badge">${cards.length} card${cards.length!==1?'s':''}</span></div>
      <div class="loop-exp-tip">Go to the board and place a Pattern tile + draw a Nexus connection + register an S2F experiment to enable advancing.</div>
      ${cardsHtml}
    </div>`;
}

// ── Phase 3: Stabilize ────────────────────────────────────────────────

function renderStabilizePhase(loop, ph) {
  const expSummary = loop.experiment.map(c =>
    `<div class="loop-signal-ref">• <strong>${esc(c.owner||'?')}</strong> — ${esc(c.action||'No action defined')}</div>`
  ).join('');

  return `
    <div class="loop-section">
      <div class="loop-section-title">Experiments run</div>
      <div class="loop-signal-refs">${expSummary || '<em style="color:var(--text-muted)">None</em>'}</div>
    </div>
    <div class="loop-section">
      <div class="loop-section-title">Minimum Viable Norm</div>
      <div class="loop-mvn-prompt">❓ "What needs to survive you?" — Write one sentence that codifies the gain.</div>
      <div class="loop-mvn-card">
        <div class="loop-exp-field">
          <label>The norm <span class="loop-required">*</span></label>
          <textarea class="loop-input loop-textarea" rows="2" id="loopStabNorm"
            placeholder="e.g. 'Every new feature must have a defined rollback plan before shipping.'"
            oninput="window.activeLoop.stabilize.norm=this.value"
          >${esc(loop.stabilize.norm)}</textarea>
        </div>
        <div class="loop-exp-fields" style="display:flex;gap:12px;margin-top:10px">
          <div class="loop-exp-field" style="flex:1">
            <label>Owner <span class="loop-required">*</span></label>
            <input class="loop-input" type="text" placeholder="Who maintains this?"
              value="${esc(loop.stabilize.owner)}"
              oninput="window.activeLoop.stabilize.owner=this.value" />
          </div>
          <div class="loop-exp-field" style="flex:1">
            <label>Cadence</label>
            <input class="loop-input" type="text" placeholder="e.g. weekly retro, monthly review"
              value="${esc(loop.stabilize.cadence)}"
              oninput="window.activeLoop.stabilize.cadence=this.value" />
          </div>
        </div>
      </div>
    </div>`;
}

// ── Phase 4: Diffuse ──────────────────────────────────────────────────

function renderDiffusePhase(loop, ph) {
  const showPreview = loop.diffuse.changed && loop.diffuse.audience;

  const previewHtml = showPreview ? `
    <div class="loop-story-preview">
      <div class="loop-story-preview-title">📤 Shareable Summary</div>
      <div class="loop-story-preview-body">
        <p><strong>🔁 Anchor:</strong> ${esc(loop.anchorName)} &nbsp;·&nbsp; Cycle ${loop.cycleNum}</p>
        <p><strong>What changed:</strong> ${esc(loop.diffuse.changed)}</p>
        ${loop.diffuse.surprised ? `<p><strong>What surprised us:</strong> ${esc(loop.diffuse.surprised)}</p>` : ''}
        <p><strong>Who should see this:</strong> ${esc(loop.diffuse.audience)}</p>
        ${loop.stabilize.norm ? `<p><strong>Norm locked:</strong> ${esc(loop.stabilize.norm)}</p>` : ''}
      </div>
    </div>` : '';

  return `
    <div class="loop-section">
      <div class="loop-section-title">Story frame</div>
      <div class="loop-input-hint">Distil the transformation story — what changed, what surprised you, who else needs to hear this.</div>
      <div class="loop-story-card">
        <div class="loop-exp-field">
          <label>What changed? <span class="loop-required">*</span></label>
          <textarea class="loop-input loop-textarea" rows="2"
            placeholder="What is different now compared to when we started this loop?"
            oninput="window.activeLoop.diffuse.changed=this.value;window.renderLoopModal()"
          >${esc(loop.diffuse.changed)}</textarea>
        </div>
        <div class="loop-exp-field">
          <label>What surprised you?</label>
          <textarea class="loop-input loop-textarea" rows="2"
            placeholder="What didn't you expect? Unexpected resistance, unexpected support, emergent patterns…"
            oninput="window.activeLoop.diffuse.surprised=this.value"
          >${esc(loop.diffuse.surprised)}</textarea>
        </div>
        <div class="loop-exp-field">
          <label>Who else should see this? <span class="loop-required">*</span></label>
          <input class="loop-input" type="text"
            placeholder="e.g. Leadership, adjacent teams, all-hands…"
            value="${esc(loop.diffuse.audience)}"
            oninput="window.activeLoop.diffuse.audience=this.value" />
        </div>
      </div>
    </div>
    <div class="loop-section">
      <div class="loop-section-title">Seed for Cycle ${loop.cycleNum + 1}</div>
      <input class="loop-input" type="text"
        placeholder="What new signal emerged from this loop? (optional)"
        value="${esc(loop.diffuse.nextSignal||loop.nextSignal||'')}"
        oninput="window.activeLoop.diffuse.nextSignal=this.value;if(window.activeLoop)window.activeLoop.nextSignal=this.value" />
    </div>
    ${previewHtml}`;
}

// ── Cycle Log ─────────────────────────────────────────────────────────

function renderCycleLogContent() {
  const sessions = (window.loopSessions || []).filter(s => s.completedAt).slice().reverse();
  if (!sessions.length) {
    return `<div style="padding:40px;color:var(--text-muted);text-align:center">
      <div style="font-size:32px;margin-bottom:12px">⟳</div>
      <div>No completed loops yet.</div>
      <div style="font-size:11px;margin-top:8px">Complete a full Möbius cycle to see it here.</div>
    </div>`;
  }

  return `
    <div class="loop-log-header">
      <button class="loop-close-btn" onclick="document.getElementById('loopModal').classList.remove('show')">✕</button>
      <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--text)">Completed Loops (${sessions.length})</h3>
    </div>
    <div class="loop-log-list">
      ${sessions.map(s => {
        const completedDate = s.completedAt ? new Date(s.completedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
        return `<div class="loop-log-entry">
          <div class="loop-log-entry-header">
            <span class="loop-log-anchor"><span style="background:var(--accent);color:#fff;border-radius:3px;padding:1px 6px;font-size:9px;font-weight:700;margin-right:6px">C</span>${esc(s.anchorName)}</span>
            <span class="loop-log-cycle">Cycle ${s.cycleNum}</span>
            <span class="loop-log-date">${completedDate}</span>
          </div>
          <div class="loop-log-phases">
            ${LOOP_PHASE_META.map(p => `<span class="loop-log-phase-tag" title="${p.n}">${p.i}</span>`).join('')}
            <span class="loop-log-complete">✓ Complete</span>
          </div>
          ${s.stabilize && s.stabilize.norm ? `<div class="loop-log-norm">🔒 ${esc(s.stabilize.norm)}</div>` : ''}
          ${s.diffuse && s.diffuse.changed ? `<div class="loop-log-changed">${esc(s.diffuse.changed)}</div>` : ''}
          ${s.diffuse && s.nextSignal ? `<div class="loop-log-next">→ Seed: ${esc(s.nextSignal||s.diffuse.nextSignal)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
}

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
