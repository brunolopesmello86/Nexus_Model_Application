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


// ── Safe access to app globals ───────────────────────────────────────
// index.html declares these with `let`, so they never become window
// properties — but classic scripts share the global lexical scope, so the
// bare identifier resolves. Guarded with typeof so this file can also be
// loaded in isolation (tests) without throwing.
function vsLib(){
  try { return (typeof capabilitiesLibrary !== 'undefined' && Array.isArray(capabilitiesLibrary)) ? capabilitiesLibrary : []; }
  catch (e) { return []; }
}
function vsReps(pid){
  try { return (typeof practiceRepetitions !== 'undefined' && practiceRepetitions) ? (practiceRepetitions[pid] || 0) : 0; }
  catch (e) { return 0; }
}
function vsHabitCount(pid){
  try { return (typeof pmHabits === 'function') ? pmHabits(pid).length : 0; }
  catch (e) { return 0; }
}
function vsPracFitness(pid){
  try { return (typeof pmStats === 'function') ? (pmStats(pid).fitness || 0) : 0; }
  catch (e) { return 0; }
}

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
  const lib = vsLib();
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

// ── Stage fitness ────────────────────────────────────────────────────
// A practice counts toward a stage's score only once it is actually tracked
// (habits scored, or repetitions logged). Averaging untracked practices in
// would report "Fragile" for a stage that simply has not been measured yet —
// so coverage is reported separately rather than folded into the number.
window.vsPracticeTracked = function(pid){
  return vsHabitCount(pid) > 0 || vsReps(pid) > 0;
};

window.vsStageFitness = function(stageId){
  const placed = window.vsStagePractices(stageId).filter(p => p.pinned);
  const tracked = placed.filter(p => window.vsPracticeTracked(p.id));
  if (!tracked.length) {
    return { measured:false, score:null, placed:placed.length, tracked:0, coverage:0 };
  }
  const sum = tracked.reduce((a,p) => a + vsPracFitness(p.id), 0);
  return {
    measured:true,
    score: Math.round(sum / tracked.length),
    placed: placed.length,
    tracked: tracked.length,
    coverage: placed.length ? Math.round(tracked.length / placed.length * 100) : 0
  };
};

// Same bands as the Practices tracker so the two surfaces agree.
window.vsBand = function(v){
  if (typeof pmBand === 'function') { try { return pmBand(v); } catch(e){} }
  if (v >= 80) return { n:'Antifragile', c:'#0072ce' };
  if (v >= 60) return { n:'Resilient',   c:'#2d9d5e' };
  if (v >= 40) return { n:'Stable',      c:'#f2c14e' };
  if (v >= 20) return { n:'Emerging',    c:'#f5821f' };
  return         { n:'Fragile',     c:'#d94a4a' };
};

// Stream fitness = average of the stages that are actually measured.
window.vsStreamFitness = function(){
  const s = window.vsActive(); if (!s) return { measured:false, score:null, measuredStages:0, totalStages:0 };
  const f = s.stages.map(st => window.vsStageFitness(st.id)).filter(x => x.measured);
  if (!f.length) return { measured:false, score:null, measuredStages:0, totalStages:s.stages.length };
  return {
    measured:true,
    score: Math.round(f.reduce((a,x) => a + x.score, 0) / f.length),
    measuredStages: f.length,
    totalStages: s.stages.length
  };
};

// The weakest measured stage — a bottleneck can only be claimed where there is data.
window.vsBottleneck = function(){
  const s = window.vsActive(); if (!s) return null;
  let worst = null;
  s.stages.forEach(st => {
    const f = window.vsStageFitness(st.id);
    if (!f.measured) return;
    if (!worst || f.score < worst.score) worst = { id: st.id, name: st.name, score: f.score };
  });
  return worst;
};

// Let the stream type be changed after creation (it is set by the template).
window.VS_TYPES = ['core','enabling','supporting'];
window.vsCycleType = function(){
  const s = window.vsActive(); if (!s) return;
  const i = window.VS_TYPES.indexOf(s.type || 'core');
  s.type = window.VS_TYPES[(i + 1) % window.VS_TYPES.length];
  if (window.scheduleAutoSave) window.scheduleAutoSave();
};
