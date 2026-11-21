// Contact sheets of the parity diffs (4 fixtures per sheet), composited with Takumi itself.
import console from "node:console";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { render } from "takumi-js";
import { decodeImagePixels } from "metaplate/node";
const names = JSON.parse(readFileSync("out/results-wasm.json","utf8")).map(r=>r.name).filter(n=>existsSync(`out/diff-wasm/${n}.png`));
const W=1800;
for (let i=0;i<names.length;i+=4){
  const group=names.slice(i,i+4);
  const rows=group.map(n=>{const b=readFileSync(`out/diff-wasm/${n}.png`);const {width,height}=decodeImagePixels(b);const h=Math.round(height*W/width);
    return {type:"div",props:{style:{display:"flex",flexDirection:"column"},children:[{type:"div",props:{style:{fontSize:22,fontWeight:700,color:"#000",background:"#ff0",padding:4},children:`${n}   (left: Satori/metaplate-node | middle: Takumi wasm | right: changed px red)`}},{type:"img",props:{src:`data:image/png;base64,${b.toString("base64")}`,width:W,height:h}}]}}});
  const png=await render({type:"div",props:{style:{display:"flex",flexDirection:"column",width:W,background:"#888"},children:rows}},{width:W});
  writeFileSync(`out/sheet-${i/4}.png`,png);
}
console.log(names.length);
