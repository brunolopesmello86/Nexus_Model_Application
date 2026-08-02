// ofm-score-slide.js — regenerates the "How to Calculate Your OFM Score" slide
// with the CURRENT practice-based Organizational Fitness formula.
//   Org Fitness = average of each practice's Fitness Score /100
//   Practice Fitness = Maturity × RepMult + Adopted×6 − Failed×1   (clamped 0–100)
//   RepMult = 0.4 + 0.6 × min(1, Reps ÷ 5)
//   Bands: Fragile <20 · Emerging 20–39 · Stable 40–59 · Resilient 60–79 · Antifragile 80+
const PptxGenJS = require('pptxgenjs');
const pptx = new PptxGenJS();
pptx.defineLayout({ name:'WIDE', width:13.33, height:7.5 });
pptx.layout = 'WIDE';
pptx.theme = { headFontFace:'Segoe UI', bodyFontFace:'Segoe UI' };

const C = {
  bg:'0a1a3a', panel:'102a5c', panel2:'0d2350', header:'0a2352',
  text:'FFFFFF', muted:'9fb2d4', faint:'6f83a8',
  orange:'e8943a', cyan:'2fb8cf', green:'3fbf76', blue:'4a90d9',
  purple:'9b82c9', red:'d94a4a', total:'2bb8d0',
};
const F='Segoe UI';
// band → color + label
function band(v){
  if(v>=80) return {n:'ANTIFRAGILE', c:C.blue};
  if(v>=60) return {n:'RESILIENT',   c:C.green};
  if(v>=40) return {n:'STABLE',      c:C.cyan};
  if(v>=20) return {n:'EMERGING',    c:C.orange};
  return {n:'FRAGILE', c:C.red};
}
// blend for tint backgrounds
function blend(hex,op){const R=0x0a,G=0x1a,B=0x3a;const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
  const f=(a,z)=>Math.round(a*op+z*(1-op)).toString(16).padStart(2,'0');return f(r,R)+f(g,G)+f(b,B);}

// worked example — Q1 snapshot, 4 practices → avg 52 (STABLE)
const PRACTICES = [
  { name:'Trunk-Based Development',          mat:76, reps:5, mult:1.00, adopt:1, fail:0 },
  { name:'Continuous Integration Cadence',   mat:65, reps:3, mult:0.76, adopt:0, fail:0 },
  { name:'Blameless Post-Incident Reviews',  mat:55, reps:2, mult:0.64, adopt:1, fail:0 },
  { name:'Error Budget Policy',              mat:42, reps:4, mult:0.88, adopt:0, fail:1 },
];
PRACTICES.forEach(p=>{ p.score = Math.max(0,Math.min(100, Math.round(p.mat*p.mult + p.adopt*6 - p.fail*1))); });
const ORG = Math.round(PRACTICES.reduce((s,p)=>s+p.score,0)/PRACTICES.length);
const B = band(ORG);

const s = pptx.addSlide();
s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:'100%',h:'100%',fill:{color:C.bg}});

// ── header band ──
s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:13.33,h:0.72,fill:{color:C.header}});
s.addShape(pptx.ShapeType.rect,{x:0,y:0.72,w:13.33,h:0.045,fill:{color:C.orange}});
s.addText('NTT DATA · Nexus',{x:0.4,y:0,w:4,h:0.72,fontSize:11,color:C.faint,fontFace:F,valign:'middle',align:'left'});
s.addText('Organizational Fitness Model · Scoring Walkthrough',{x:3,y:0,w:7.33,h:0.72,fontSize:13,bold:true,color:C.text,fontFace:F,valign:'middle',align:'center'});
s.addText('WORKED EXAMPLE',{x:9.33,y:0,w:3.6,h:0.72,fontSize:10,italic:true,color:C.faint,fontFace:F,valign:'middle',align:'right'});

// ── title + subtitle ──
s.addText('How to Calculate Your OFM Score',{x:0.5,y:1.02,w:12,h:0.6,fontSize:30,bold:true,color:C.text,fontFace:F,align:'left'});
s.addText('A team with 3 months of active transformation activity — Q1 Sprint Review snapshot',{x:0.5,y:1.62,w:12,h:0.35,fontSize:13,italic:true,color:C.muted,fontFace:F,align:'left'});

// ── formula strip (left) ──
const LX=0.5, LW=7.9;
s.addShape(pptx.ShapeType.roundRect,{x:LX,y:2.05,w:LW,h:0.62,rectRadius:0.06,fill:{color:blend(C.cyan,0.14)},line:{color:C.cyan,width:1}});
s.addText([
  {text:'Practice Fitness ',options:{color:C.cyan,bold:true}},
  {text:'= Maturity × Rep-Mult + (Adopted × 6) − (Failed × 1)',options:{color:C.text}},
],{x:LX+0.18,y:2.12,w:LW-0.36,h:0.24,fontSize:11.5,fontFace:F,align:'left',valign:'middle'});
s.addText('Rep-Mult = 0.4 + 0.6 × min(1, Reps ÷ 5)   ·   each practice score is clamped 0–100',
  {x:LX+0.18,y:2.38,w:LW-0.36,h:0.22,fontSize:9.5,color:C.muted,fontFace:F,align:'left',valign:'middle'});

// ── practice rows ──
let y=2.85; const RH=0.72, GAP=0.12;
PRACTICES.forEach(p=>{
  const pb=band(p.score);
  s.addShape(pptx.ShapeType.roundRect,{x:LX,y,w:LW,h:RH,rectRadius:0.05,fill:{color:C.panel2},line:{color:C.header,width:1}});
  s.addShape(pptx.ShapeType.rect,{x:LX,y:y+0.06,w:0.07,h:RH-0.12,fill:{color:pb.c}}); // accent
  s.addText(p.name,{x:LX+0.28,y:y+0.09,w:LW-1.6,h:0.28,fontSize:13,bold:true,color:C.text,fontFace:F,align:'left'});
  const expTxt = p.adopt? `  ·  +${p.adopt*6} adopted` : (p.fail? `  ·  −${p.fail} failed` : '');
  s.addText(`Maturity ${p.mat} × rep-mult ${p.mult.toFixed(2)} (${p.reps} reps)${expTxt}`,
    {x:LX+0.28,y:y+0.38,w:LW-1.6,h:0.26,fontSize:10.5,color:C.muted,fontFace:F,align:'left'});
  // score badge
  const bx=LX+LW-1.15;
  s.addShape(pptx.ShapeType.roundRect,{x:bx,y:y+0.12,w:0.95,h:RH-0.24,rectRadius:0.05,fill:{color:blend(pb.c,0.18)},line:{color:pb.c,width:1.2}});
  s.addText(String(p.score),{x:bx,y:y+0.12,w:0.95,h:0.34,fontSize:19,bold:true,color:pb.c,fontFace:F,align:'center',valign:'middle'});
  s.addText(pb.n,{x:bx,y:y+0.44,w:0.95,h:0.16,fontSize:6.5,bold:true,color:pb.c,charSpacing:1,fontFace:F,align:'center'});
  y+=RH+GAP;
});

// ── total row ──
s.addShape(pptx.ShapeType.roundRect,{x:LX,y:y+0.04,w:LW,h:0.74,rectRadius:0.06,fill:{color:blend(C.total,0.18)},line:{color:C.total,width:1.4}});
s.addText('ORG FITNESS SCORE',{x:LX+0.28,y:y+0.12,w:5,h:0.28,fontSize:14,bold:true,color:C.total,charSpacing:1,fontFace:F,align:'left'});
s.addText('average of the practice scores  (82 + 49 + 41 + 36) ÷ 4',{x:LX+0.28,y:y+0.42,w:5.5,h:0.24,fontSize:10,color:C.muted,fontFace:F,align:'left'});
s.addShape(pptx.ShapeType.roundRect,{x:LX+LW-1.15,y:y+0.13,w:0.95,h:0.56,rectRadius:0.05,fill:{color:C.total}});
s.addText(String(ORG),{x:LX+LW-1.15,y:y+0.13,w:0.95,h:0.56,fontSize:24,bold:true,color:'042028',fontFace:F,align:'center',valign:'middle'});

// ── right column: score card ──
const RX=8.75, RW=4.15;
s.addShape(pptx.ShapeType.roundRect,{x:RX,y:2.05,w:RW,h:1.72,rectRadius:0.07,fill:{color:C.panel},line:{color:blend(C.cyan,0.5),width:1}});
s.addShape(pptx.ShapeType.roundRect,{x:RX+0.22,y:2.28,w:1.15,h:1.15,rectRadius:0.06,fill:{color:C.total}});
s.addText(String(ORG),{x:RX+0.22,y:2.28,w:1.15,h:1.15,fontSize:40,bold:true,color:'042028',fontFace:F,align:'center',valign:'middle'});
s.addText(B.n,{x:RX+1.55,y:2.35,w:RW-1.7,h:0.4,fontSize:22,bold:true,color:C.text,fontFace:F,align:'left'});
s.addText('40–59 range',{x:RX+1.55,y:2.78,w:RW-1.7,h:0.3,fontSize:12,color:C.muted,fontFace:F,align:'left'});
s.addText('Absorbing change. Habits are forming and repetition is building, but experiments and systemic reinforcement are still developing.',
  {x:RX+0.22,y:3.5,w:RW-0.44,h:0.2,fontSize:9.5,color:C.muted,fontFace:F,align:'left',valign:'top'});

// ── priority actions ──
s.addShape(pptx.ShapeType.rect,{x:RX,y:4.0,w:RW,h:0.03,fill:{color:C.orange}});
s.addText('PRIORITY ACTIONS TO MOVE TO RESILIENT (60+)',{x:RX,y:4.1,w:RW,h:0.3,fontSize:10,bold:true,color:C.orange,charSpacing:1,fontFace:F,align:'left'});
const ACTIONS = [
  {c:C.cyan,   t:'Raise habit maturity — score each practice’s good habits higher. Maturity multiplies everything.'},
  {c:C.green,  t:'Log repetitions. Every rep lifts the rep-multiplier toward 1.0 (5 reps = full credit).'},
  {c:C.orange, t:'Run and adopt experiments — each adopted experiment adds +6 to its practice.'},
  {c:C.blue,   t:'Give every practice ≥3 good habits so it counts and can mature.'},
  {c:C.purple, t:'Clear failed / abandoned experiments — each costs −1 and signals a weak hypothesis.'},
];
let ay=4.5;
ACTIONS.forEach((a,i)=>{
  s.addShape(pptx.ShapeType.ellipse,{x:RX+0.05,y:ay,w:0.26,h:0.26,fill:{color:blend(a.c,0.22)},line:{color:a.c,width:1}});
  s.addText(String(i+1),{x:RX+0.05,y:ay,w:0.26,h:0.26,fontSize:10,bold:true,color:a.c,fontFace:F,align:'center',valign:'middle'});
  s.addText(a.t,{x:RX+0.42,y:ay-0.04,w:RW-0.5,h:0.5,fontSize:9.5,color:C.text,fontFace:F,align:'left',valign:'top',lineSpacingMultiple:1.02});
  ay+=0.56;
});

// ── footer ──
s.addText('NTT DATA · Nexus Board · Organizational Fitness Model — Confidential',
  {x:0,y:7.15,w:13.33,h:0.3,fontSize:8.5,color:C.faint,fontFace:F,align:'center'});

const out = process.argv[2] || 'OFM-Score-Walkthrough.pptx';
pptx.writeFile({ fileName: out }).then(()=>{
  console.log('Wrote', out, '| Org score', ORG, B.n, '| practice scores', PRACTICES.map(p=>p.score).join(','));
});
