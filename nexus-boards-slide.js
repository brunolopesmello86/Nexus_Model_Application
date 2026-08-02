// nexus-boards-slide.js — "Antipadrão → transição → padrão, nos dois tabuleiros"
// Compares the actual hexes on two Nexus boards (pulled from the game DB).
const PptxGenJS = require('pptxgenjs');
const pptx = new PptxGenJS();
pptx.defineLayout({ name:'WIDE', width:13.33, height:7.5 });
pptx.layout = 'WIDE';
pptx.theme = { headFontFace:'Segoe UI', bodyFontFace:'Segoe UI' };

const C = {
  bg:'0b1c3a', bg2:'0e2247', hexline:'173163',
  text:'FFFFFF', muted:'aebfd8', faint:'6f83a8',
  teal:'2fb8a0', green:'2bbd8f', orange:'e8943a', blue:'5b83c4',
  red:'e0556b', cyan:'3fb6d4',
};
const F='Segoe UI';

// ── the two boards (resolved from the game database) ──
const BOARDS = [
  { label:'nWOW 2026', company:'NTT DATA DS&A', accent:C.green,
    cats:[
      { key:'ANTIPADRÃO', color:C.orange, items:['Portfolio as Inventory','One-Way Learning','Priority Inflation','Tool-First Transformation','Output Obsession','Unstable Teams','Narrative Vacuum','Declaring an End State'], note:'+ 2 antipadrões personalizados' },
      { key:'TRANSIÇÃO', color:C.blue, items:['Protected Sandbox','Min Viable Governance'] },
      { key:'PADRÃO', color:C.green, items:['Portfolio as Value Flow','Not Everyone Needs Change','Use Appropriate Tools','Optimize Flow'] },
      { key:'CAPACIDADE', color:C.cyan, items:['Prioritisation','Portfolio Governance','Small Batch Work'], note:'+ 5 capacidades (baralho anterior)' },
    ]},
  { label:'DevSecOps Squad', company:'Bradesco USA', accent:C.red,
    cats:[
      { key:'ANTIPADRÃO', color:C.orange, items:['Change Without Meaning'] },
      { key:'TRANSIÇÃO', color:C.blue, items:['—'] },
      { key:'PADRÃO', color:C.green, items:['Organizations Are Living Systems','Be Transparent','Portfolio as Value Flow','No End State'] },
      { key:'CAPACIDADE', color:C.cyan, items:['OKR & Goals Mgmt','Work Visualization','Feedback Loops'] },
    ]},
];

const s = pptx.addSlide();
s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:'100%',h:'100%',fill:{color:C.bg}});
// faint hex texture (a scatter of outlined hexes)
const texHex=[[0.5,5.6],[1.6,6.2],[2.7,5.6],[11.0,0.5],[12.0,1.1],[11.5,2.0],[3.8,6.2],[9.6,6.4],[10.7,5.8]];
texHex.forEach(([x,y])=>s.addShape(pptx.ShapeType.hexagon,{x,y,w:1.0,h:0.9,fill:{type:'none'},line:{color:C.hexline,width:1}}));
// decorative hex cluster top-right
[[11.4,0.3,C.hexline],[12.1,0.7,C.hexline],[11.75,1.15,C.teal]].forEach(([x,y,c])=>
  s.addShape(pptx.ShapeType.hexagon,{x,y,w:0.62,h:0.56,fill:c===C.teal?{color:C.teal}:{type:'none'},line:{color:c,width:1.4}}));

// eyebrow + title
s.addText('O  MODELO  ·  O  CODEX',{x:0.55,y:0.55,w:8,h:0.3,fontSize:11,bold:true,color:C.teal,charSpacing:3,fontFace:F});
s.addText('Antipadrão → transição → padrão, nos dois tabuleiros.',
  {x:0.55,y:0.92,w:11.5,h:0.7,fontSize:30,bold:true,color:C.text,fontFace:F});

// ── columns ──
const COLW=5.85, GAP=0.55, X0=0.55;
BOARDS.forEach((bd,ci)=>{
  const x = X0 + ci*(COLW+GAP+0.5);
  // board header: hex + name + sub + rule
  s.addShape(pptx.ShapeType.hexagon,{x,y:2.02,w:0.34,h:0.3,fill:{color:bd.accent},line:{color:bd.accent,width:0}});
  s.addText(bd.label.toUpperCase(),{x:x+0.5,y:1.94,w:COLW-0.5,h:0.32,fontSize:15,bold:true,color:bd.accent,charSpacing:2,fontFace:F});
  s.addText(`${bd.company}  ·  Padrões trabalhados`,{x:x+0.5,y:2.28,w:COLW-0.5,h:0.26,fontSize:10.5,color:C.muted,fontFace:F});
  s.addShape(pptx.ShapeType.rect,{x,y:2.62,w:COLW,h:0.022,fill:{color:bd.accent}});

  // category blocks
  let y=2.92;
  bd.cats.forEach(cat=>{
    s.addShape(pptx.ShapeType.hexagon,{x,y:y+0.02,w:0.3,h:0.27,fill:{color:cat.color},line:{color:cat.color,width:0}});
    s.addText(cat.key,{x:x+0.44,y:y-0.02,w:COLW-0.44,h:0.26,fontSize:11,bold:true,color:cat.color,charSpacing:2,fontFace:F});
    const names = cat.items.join('   ·   ');
    s.addText(names,{x:x+0.44,y:y+0.26,w:COLW-0.5,h:0.5,fontSize:11,color:C.text,fontFace:F,valign:'top',lineSpacingMultiple:1.02});
    // measure rough height by item count/length
    const lines = Math.max(1, Math.ceil(names.length/58));
    let blockH = 0.26 + lines*0.22 + 0.12;
    if(cat.note){
      s.addText(cat.note,{x:x+0.44,y:y+0.26+lines*0.22+0.02,w:COLW-0.5,h:0.22,fontSize:9,italic:true,color:C.faint,fontFace:F});
      blockH += 0.24;
    }
    y += Math.max(0.92, blockH+0.18);
  });
});

// vertical divider
s.addShape(pptx.ShapeType.rect,{x:X0+COLW+GAP+0.5-0.28,y:2.0,w:0.014,h:4.7,fill:{color:C.hexline}});

// footer
s.addText([{text:'NTT ',options:{color:C.text,bold:true}},{text:'DATA',options:{color:C.teal,bold:true}}],
  {x:0.55,y:7.05,w:3,h:0.3,fontSize:11,fontFace:F});
s.addText('Modelo Nexus · nWOW & Bradesco   ·   Tabuleiros reais do jogo',
  {x:6,y:7.05,w:6.8,h:0.3,fontSize:9.5,color:C.faint,align:'right',fontFace:F});

const out = process.argv[2] || 'Nexus-Boards-Hexes.pptx';
pptx.writeFile({ fileName: out }).then(()=>console.log('Wrote', out));
