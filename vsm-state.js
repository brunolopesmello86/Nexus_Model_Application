// ══════════════════════════════════════════════════════════════════════
// Value Stream Mapping — State Layer
// Streams are stored per board in the `value_streams` column (never inside
// board_state). Shape:
//   [{ id, name, type:'core'|'enabling'|'supporting', trigger, outcome,
//      stages:[{ id, name, owner, capabilityIds:[], unpinned:[] }] }]
// `unpinned` holds practice ids explicitly removed from a stage, so mapping a
// capability brings its practices by default and exceptions are subtractive.
// ══════════════════════════════════════════════════════════════════════

window.valueStreams = window.valueStreams || [];
window.vsActiveId   = window.vsActiveId   || null;
window.vsActiveStage = window.vsActiveStage || null;

// ── Reference templates ──────────────────────────────────────────────
window.VS_TEMPLATES = [
  { key:'delivery', name:'Idea → Running Product', type:'core',
    trigger:'A business need is raised', outcome:'Working capability in production',
    stages:['Sense Demand','Shape & Prioritise','Build','Verify','Release','Operate & Learn'] },
  { key:'support', name:'Request → Resolution', type:'supporting',
    trigger:'A customer or colleague raises a request', outcome:'Request resolved and recurrence prevented',
    stages:['Intake & Triage','Diagnose','Resolve','Confirm & Close','Prevent Recurrence'] },
  { key:'insight', name:'Insight → Decision', type:'enabling',
    trigger:'A question needs evidence', outcome:'A decision made and its impact measured',
    stages:['Collect','Model & Govern','Analyse','Decide','Measure Impact'] },
  { key:'blank', name:'Blank stream', type:'core', trigger:'', outcome:'', stages:['Stage 1'] }
];

function vsUid(p){ return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

window.vsActive = function(){
  return window.valueStreams.find(s => s.id === window.vsActiveId) || window.valueStreams[0] || null;
};

window.vsCreateFromTemplate = function(key){
  const t = window.VS_TEMPLATES.find(x => x.key === key) || window.VS_TEMPLATES[0];
  const s = {
    id: vsUid('vs'), name: t.name, type: t.type, trigger: t.trigger, outcome: t.outcome,
    stages: t.stages.map(n => ({ id: vsUid('st'), name: n, owner: '', capabilityIds: [], unpinned: [] }))
  };
  window.valueStreams.push(s);
  window.vsActiveId = s.id;
  window.vsActiveStage = s.stages[0] ? s.stages[0].id : null;
  if (window.scheduleAutoSave) window.scheduleAutoSave();
  return s;
};

window.vsDeleteStream = function(id){
  window.valueStreams = window.valueStreams.filter(s => s.id !== id);
  if (window.vsActiveId === id) { window.vsActiveId = window.valueStreams[0] ? window.valueStreams[0].id : null; window.vsActiveStage = null; }
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.vsSetField = function(field, value){
  const s = window.vsActive(); if (!s) return;
  s[field] = value;
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.vsAddStage = function(){
  const s = window.vsActive(); if (!s) return;
  const st = { id: vsUid('st'), name: 'New stage', owner: '', capabilityIds: [], unpinned: [] };
  s.stages.push(st); window.vsActiveStage = st.id;
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.vsRemoveStage = function(stageId){
  const s = window.vsActive(); if (!s) return;
  s.stages = s.stages.filter(x => x.id !== stageId);
  if (window.vsActiveStage === stageId) window.vsActiveStage = s.stages[0] ? s.stages[0].id : null;
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.vsMoveStage = function(stageId, dir){
  const s = window.vsActive(); if (!s) return;
  const i = s.stages.findIndex(x => x.id === stageId); const j = i + dir;
  if (i < 0 || j < 0 || j >= s.stages.length) return;
  const tmp = s.stages[i]; s.stages[i] = s.stages[j]; s.stages[j] = tmp;
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.vsStage = function(stageId){
  const s = window.vsActive(); if (!s) return null;
  return s.stages.find(x => x.id === stageId) || null;
};

window.vsSetStageField = function(stageId, field, value){
  const st = window.vsStage(stageId); if (!st) return;
  st[field] = value;
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.vsToggleCapability = function(stageId, capId){
  const st = window.vsStage(stageId); if (!st) return;
  st.capabilityIds = st.capabilityIds || [];
  const i = st.capabilityIds.indexOf(capId);
  if (i >= 0) st.capabilityIds.splice(i,1); else st.capabilityIds.push(capId);
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

window.vsTogglePractice = function(stageId, pracId){
  const st = window.vsStage(stageId); if (!st) return;
  st.unpinned = st.unpinned || [];
  const i = st.unpinned.indexOf(pracId);
  if (i >= 0) st.unpinned.splice(i,1); else st.unpinned.push(pracId);
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};

// ── Derived: which practices land at a stage ─────────────────────────
// Mapping a capability brings all of its practices; `unpinned` subtracts.
window.vsStagePractices = function(stageId){
  const st = window.vsStage(stageId); if (!st) return [];
  const lib = window.capabilitiesLibrary || [];
  const un = new Set(st.unpinned || []);
  const out = [];
  (st.capabilityIds || []).forEach(cid => {
    const cap = lib.find(c => c.id === cid); if (!cap) return;
    (cap.practices || []).forEach(p => {
      out.push({ id:p.id, name:p.name, level:p.level, capName:cap.name, capId:cap.id, pinned: !un.has(p.id) });
    });
  });
  return out;
};

window.vsStageCounts = function(stageId){
  const ps = window.vsStagePractices(stageId);
  return { total: ps.length, placed: ps.filter(p => p.pinned).length };
};

// Total distinct practices placed across the whole stream.
window.vsStreamCounts = function(){
  const s = window.vsActive(); if (!s) return { stages:0, caps:0, practices:0 };
  const caps = new Set(), pracs = new Set();
  s.stages.forEach(st => {
    (st.capabilityIds || []).forEach(c => caps.add(c));
    window.vsStagePractices(st.id).filter(p => p.pinned).forEach(p => pracs.add(p.id));
  });
  return { stages: s.stages.length, caps: caps.size, practices: pracs.size };
};

// Stages with no capability mapped — a structural blind spot worth surfacing.
window.vsGaps = function(){
  const s = window.vsActive(); if (!s) return [];
  return s.stages.filter(st => !(st.capabilityIds || []).length).map(st => st.name);
};
