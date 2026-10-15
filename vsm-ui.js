// ══════════════════════════════════════════════════════════════════════
// Value Stream Mapping — UI Layer
// Renders #valueStreamsPage: the stage flow, the stage editor (capability
// mapping), and the derived practice placement list.
// ══════════════════════════════════════════════════════════════════════

function vsEsc(s){
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function vsAttr(s){ return vsEsc(s).replace(/'/g,'&#039;'); }

window.renderValueStreamsPage = function(){
  const page = document.getElementById('valueStreamsPage');
  if (!page) return;
  const streams = window.valueStreams || [];
  if (!streams.length) { page.innerHTML = vsEmptyHtml(); return; }

  const s = window.vsActive();
  if (!s) { page.innerHTML = vsEmptyHtml(); return; }
  if (!window.vsActiveStage || !s.stages.some(x => x.id === window.vsActiveStage)) {
    window.vsActiveStage = s.stages[0] ? s.stages[0].id : null;
  }
  const counts = window.vsStreamCounts();
  const gaps = window.vsGaps();

  let html = `<div class="vs-wrap">`;

  // ── Header: stream picker + identity ──
  html += `<div class="vs-head">
    <div class="vs-head-left">
      <div class="vs-tabs">
        ${streams.map(x => `<button class="vs-tab${x.id===s.id?' on':''}" onclick="vsSelectStream('${vsAttr(x.id)}')" title="${vsAttr(x.name)}">
            <span class="vs-tab-type ${vsEsc(x.type)}">${vsEsc((x.type||'core').slice(0,4).toUpperCase())}</span>${vsEsc(x.name)}</button>`).join('')}
        <button class="vs-tab add" onclick="vsOpenTemplatePicker()" title="Add another value stream">＋</button>
      </div>
      <input class="vs-name-input" value="${vsAttr(s.name)}" placeholder="Name this value stream"
             oninput="vsSetField('name',this.value)">
      <div class="vs-trigger-row">
        <label>Trigger</label><input value="${vsAttr(s.trigger||'')}" placeholder="What starts this stream?" oninput="vsSetField('trigger',this.value)">
        <label>Outcome</label><input value="${vsAttr(s.outcome||'')}" placeholder="What value is delivered?" oninput="vsSetField('outcome',this.value)">
      </div>
    </div>
    <div class="vs-head-right">
      <div class="vs-kpis">
        <div class="vs-kpi"><div class="v">${counts.stages}</div><div class="l">Stages</div></div>
        <div class="vs-kpi"><div class="v">${counts.caps}</div><div class="l">Capabilities</div></div>
        <div class="vs-kpi"><div class="v">${counts.practices}</div><div class="l">Practices placed</div></div>
      </div>
      <button class="vs-del" onclick="vsConfirmDelete()" title="Delete this value stream">✕ Delete stream</button>
    </div>
  </div>`;

  if (gaps.length) {
    html += `<div class="vs-gap">⚠ ${gaps.length} stage${gaps.length>1?'s have':' has'} no capability mapped —
      <strong>${gaps.map(vsEsc).join(' · ')}</strong>. A stage with nothing behind it is a structural blind spot.</div>`;
  }

  // ── Stage flow ──
  html += `<div class="vs-flowscroll"><div class="vs-flow">`;
  s.stages.forEach((st, i) => {
    const c = window.vsStageCounts(st.id);
    const on = st.id === window.vsActiveStage;
    const capNames = (st.capabilityIds||[]).map(cid => {
      const cap = (window.capabilitiesLibrary||[]).find(x => x.id === cid);
      return cap ? cap.name : null;
    }).filter(Boolean);
    html += `<div class="vs-stage${on?' on':''}${!capNames.length?' empty':''}" onclick="vsSelectStage('${vsAttr(st.id)}')">
      <div class="vs-st-top"><span class="vs-st-num">${String(i+1).padStart(2,'0')}</span></div>
      <div class="vs-st-name">${vsEsc(st.name)}</div>
      <div class="vs-st-owner">${st.owner ? vsEsc(st.owner) : '<span class="muted">no owner</span>'}</div>
      <div class="vs-caps">${capNames.length
          ? capNames.map(n => `<span class="vs-cap">${vsEsc(n)}</span>`).join('')
          : '<span class="vs-cap none">no capability mapped</span>'}</div>
      <div class="vs-st-foot">practices <b>${c.placed}</b>${c.total!==c.placed?` <span class="muted">of ${c.total}</span>`:''}</div>
    </div>`;
    if (i < s.stages.length-1) html += `<div class="vs-arrow">→</div>`;
  });
  html += `<button class="vs-addstage" onclick="vsAddStage();renderValueStreamsPage()" title="Add a stage">＋</button>`;
  html += `</div></div>`;

  // ── Stage editor ──
  const st = window.vsStage(window.vsActiveStage);
  if (st) html += vsStageEditorHtml(st, s);

  html += `</div>`;
  page.innerHTML = html;
};

function vsEmptyHtml(){
  return `<div class="vs-empty">
    <div class="vs-empty-ico">⟿</div>
    <div class="vs-empty-t">Map how value actually flows</div>
    <div class="vs-empty-d">Define the stages a request passes through, map the capabilities each stage depends on,
      and every practice those capabilities carry lands in the flow automatically.</div>
    <div class="vs-tpl-grid">
      ${window.VS_TEMPLATES.map(t => `<button class="vs-tpl" onclick="vsCreateFromTemplate('${t.key}');renderValueStreamsPage()">
        <div class="vs-tpl-type ${t.type}">${t.type.toUpperCase()}</div>
        <div class="vs-tpl-name">${vsEsc(t.name)}</div>
        <div class="vs-tpl-stages">${t.stages.length} stage${t.stages.length>1?'s':''} · ${vsEsc(t.stages.slice(0,3).join(' → '))}${t.stages.length>3?' → …':''}</div>
      </button>`).join('')}
    </div>
  </div>`;
}

function vsStageEditorHtml(st, s){
  const lib = window.capabilitiesLibrary || [];
  const pracs = window.vsStagePractices(st.id);
  const placed = pracs.filter(p => p.pinned).length;
  const idx = s.stages.findIndex(x => x.id === st.id);
  // group capabilities by domain for the picker
  const byDom = {};
  lib.forEach(c => { const d = c.domain || 'Other'; (byDom[d] = byDom[d] || []).push(c); });

  return `<div class="vs-editor">
    <div class="vs-ed-left">
      <div class="vs-ed-label">Stage ${String(idx+1).padStart(2,'0')}</div>
      <input class="vs-ed-name" value="${vsAttr(st.name)}" oninput="vsSetStageField('${vsAttr(st.id)}','name',this.value);vsRefreshFlow()">
      <div class="vs-ed-field">
        <label>Owner</label>
        <input value="${vsAttr(st.owner||'')}" placeholder="team or role" oninput="vsSetStageField('${vsAttr(st.id)}','owner',this.value);vsRefreshFlow()">
      </div>
      <div class="vs-ed-actions">
        <button onclick="vsMoveStage('${vsAttr(st.id)}',-1);renderValueStreamsPage()" ${idx===0?'disabled':''} title="Move earlier">← earlier</button>
        <button onclick="vsMoveStage('${vsAttr(st.id)}',1);renderValueStreamsPage()" ${idx===s.stages.length-1?'disabled':''} title="Move later">later →</button>
        <button class="danger" onclick="vsConfirmRemoveStage('${vsAttr(st.id)}')" title="Remove this stage">✕ Remove</button>
      </div>
      <div class="vs-ed-label" style="margin-top:16px">Capabilities at this stage</div>
      <div class="vs-ed-hint">Mapping a capability places all of its practices here. Unpin the ones that belong elsewhere.</div>
      <div class="vs-cappick">
        ${Object.keys(byDom).sort().map(d => `
          <div class="vs-dom">${vsEsc(d)}</div>
          ${byDom[d].map(c => {
            const on = (st.capabilityIds||[]).includes(c.id);
            return `<label class="vs-capopt${on?' on':''}">
              <input type="checkbox" ${on?'checked':''} onchange="vsToggleCapability('${vsAttr(st.id)}','${vsAttr(c.id)}');renderValueStreamsPage()">
              <span class="vs-capopt-n">${vsEsc(c.name)}</span>
              <span class="vs-capopt-c">${(c.practices||[]).length}</span>
            </label>`;
          }).join('')}
        `).join('')}
      </div>
    </div>
    <div class="vs-ed-right">
      <div class="vs-ed-label">Practices placed here — <b>${placed}</b>${pracs.length!==placed?` <span class="muted">of ${pracs.length} carried</span>`:''}</div>
      ${pracs.length === 0
        ? `<div class="vs-noprac">No capability mapped to this stage yet. Pick one on the left and its practices appear here.</div>`
        : `<div class="vs-praclist">${pracs.map(p => {
            const score = (typeof window.pmScore === 'function') ? window.pmScore(p.id) : 0;
            const band = score >= 60 ? 'good' : score >= 35 ? 'mid' : score > 0 ? 'low' : 'none';
            return `<div class="vs-prac${p.pinned?'':' off'}">
              <button class="vs-pin" onclick="vsTogglePractice('${vsAttr(st.id)}','${vsAttr(p.id)}');renderValueStreamsPage()"
                      title="${p.pinned?'Unpin — this practice does not belong at this stage':'Pin back to this stage'}">${p.pinned?'●':'○'}</button>
              <span class="vs-prac-lvl">${vsEsc(p.level||'')}</span>
              <span class="vs-prac-n">${vsEsc(p.name)}</span>
              <span class="vs-prac-c">${vsEsc(p.capName)}</span>
              <span class="vs-prac-s ${band}">${score || '—'}</span>
            </div>`;
          }).join('')}</div>`}
    </div>
  </div>`;
}

// Light refresh for text inputs so the caret is not lost while typing.
window.vsRefreshFlow = function(){
  const s = window.vsActive(); if (!s) return;
  document.querySelectorAll('.vs-stage').forEach((el, i) => {
    const st = s.stages[i]; if (!st) return;
    const n = el.querySelector('.vs-st-name'); if (n) n.textContent = st.name;
    const o = el.querySelector('.vs-st-owner');
    if (o) o.innerHTML = st.owner ? vsEsc(st.owner) : '<span class="muted">no owner</span>';
  });
};

window.vsSelectStream = function(id){ window.vsActiveId = id; window.vsActiveStage = null; renderValueStreamsPage(); };
window.vsSelectStage  = function(id){ window.vsActiveStage = id; renderValueStreamsPage(); };

window.vsOpenTemplatePicker = function(){
  const names = window.VS_TEMPLATES.map((t,i) => `${i+1}. ${t.name}`).join('\n');
  const pick = prompt('Add a value stream — choose a template:\n\n' + names + '\n\nEnter a number:');
  if (!pick) return;
  const t = window.VS_TEMPLATES[parseInt(pick,10)-1];
  if (!t) { if (window.showToast) showToast('No template with that number', 'info'); return; }
  window.vsCreateFromTemplate(t.key);
  renderValueStreamsPage();
};

window.vsConfirmDelete = function(){
  const s = window.vsActive(); if (!s) return;
  if (!confirm(`Delete the value stream "${s.name}"? Its stages and capability mapping are removed. The board, practices and experiments are not affected.`)) return;
  window.vsDeleteStream(s.id);
  renderValueStreamsPage();
};

window.vsConfirmRemoveStage = function(stageId){
  const st = window.vsStage(stageId); if (!st) return;
  if (!confirm(`Remove the stage "${st.name}"? Its capability mapping is removed; the capabilities themselves are untouched.`)) return;
  window.vsRemoveStage(stageId);
  renderValueStreamsPage();
};
