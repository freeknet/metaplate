// Summarizes `wrangler tail --format json` output (tail.jsonl) into CPU-time percentiles.
import console from "node:console";
import fs from "node:fs";
const txt=fs.readFileSync("tail.jsonl","utf8");
const objs=[];let depth=0,start=-1,inStr=false,esc=false;for(let i=0;i<txt.length;i++){const c=txt[i];if(inStr){if(esc)esc=false;else if(c==="\\")esc=true;else if(c==="\"")inStr=false;continue}if(c==="\""){inStr=true;continue}if(c==="{"){if(depth===0)start=i;depth++}else if(c==="}"){depth--;if(depth===0)objs.push(JSON.parse(txt.slice(start,i+1)))}}
const rows=objs.filter(o=>o.event?.request?.url?.includes("/og/")).map(o=>({url:o.event.request.url.replace(/^https:\/\/[^/]+/,""),status:o.event?.response?.status,cpu:o.cpuTime,wall:o.wallTime,outcome:o.outcome,colo:o.event.request.cf?.colo}));
const stats=(xs)=>{const c=xs.map(r=>r.cpu).sort((a,b)=>a-b);const q=p=>c[Math.min(c.length-1,Math.floor(c.length*p))];return {n:c.length,min:c[0],p50:q(.5),p75:q(.75),p90:q(.9),p99:q(.99),max:c[c.length-1],over10:c.filter(v=>v>10).length,over50:c.filter(v=>v>50).length}};
const outcomes={};rows.forEach(r=>outcomes[r.outcome+"/"+r.status]=(outcomes[r.outcome+"/"+r.status]||0)+1);
const colos={};rows.forEach(r=>colos[r.colo]=(colos[r.colo]||0)+1);
console.log("all",JSON.stringify(stats(rows)));console.log("sequential",JSON.stringify(stats(rows.filter(r=>!r.url.includes("Load")))));console.log("load c=4",JSON.stringify(stats(rows.filter(r=>r.url.includes("Load")))));
console.log("outcomes",JSON.stringify(outcomes),"colos",JSON.stringify(colos));
console.log("cpu>50 list",rows.filter(r=>r.cpu>50).map(r=>`${r.url}:${r.cpu}`).join(" "));
fs.writeFileSync("tail-rows.json",JSON.stringify(rows,null,1));
