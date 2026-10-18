import type {LiveOnshapePartOption,OnshapeCatalogItem,OnshapeElement} from '../adapters/onshape-http';
import {createJob,type Part,type Project} from './model';
export type PartRoute='print'|'hardware'|'other'|'review'|'unavailable';
export function recommendRobotPart(part:Pick<LiveOnshapePartOption,'name'|'available'|'materialHint'|'standardContent'>):{route:PartRoute;reason:string}{
  if(!part.available)return{route:'unavailable',reason:'Resolve CAD access or the source reference before importing.'};
  if(part.standardContent)return{route:'hardware',reason:'Onshape identifies this as standard content.'};
  const housing=/\b(mount|bracket|housing|cover|guard|guide|adapter|support|retainer|block|holder)\b/i.test(part.name);
  if(!housing&&(/\b(bearing|bolt|screw|washer|nut|rivnut|rivet|motor|gearbox|sprocket|chain|belt|encoder|connector|battery|pneumatic|solenoid)\b/i.test(part.name)||/\bm\d+(?:\.\d+)?\s*[x×]\s*\d+\b/i.test(part.name)))return{route:'hardware',reason:'The name suggests purchased hardware. Confirm before excluding.'};
  if(/\b(alumini?um|steel|stainless|titanium|brass|bronze|copper|wood|plywood|acrylic)\b/i.test(part.materialHint??''))return{route:'other',reason:'The CAD material suggests machining, cutting or purchasing.'};
  if(/\b(pla|petg|abs|asa|nylon|pa\d*|ppa|tpu|tpe|polycarbonate|pc|pet|polyamide)\b/i.test(part.materialHint??''))return{route:'print',reason:'The CAD material suggests a printable polymer. Confirm the intended process and filament.'};
  if(/\b(3d[ -]?print(?:ed|ing)?|printed)\b/i.test(part.name))return{route:'print',reason:'The CAD name identifies a printed part. Confirm the intended process.'};
  return{route:'review',reason:'CAD does not establish how this part should be manufactured.'};
}
export function suggestedVersion(versions:OnshapeCatalogItem[]){
  if(versions.length===1)return versions[0];
  if(!versions.length||versions.some(v=>!v.createdAt||!Number.isFinite(Date.parse(v.createdAt))))return undefined;
  return [...versions].sort((a,b)=>Date.parse(b.createdAt!)-Date.parse(a.createdAt!)||a.id.localeCompare(b.id))[0];
}
export function suggestedElement(elements:OnshapeElement[],preferred?:string){
  if(preferred)return elements.find(e=>e.id===preferred);
  const assemblies=elements.filter(e=>e.type==='assembly');
  return assemblies.length===1?assemblies[0]:elements.length===1?elements[0]:undefined;
}
export function robotSubsystem(part:Pick<LiveOnshapePartOption,'assemblyMemberships'>){const roots=new Map((part.assemblyMemberships??[]).filter(m=>m.path.length===1).map(m=>[m.path[0],m.names[0]]));return roots.size>1?'Shared parts':roots.size===1?[...roots.values()][0]:'Robot-level parts';}
/** Bounded upstream work: stop scheduling after failure; callers retain atomic project updates. */
export async function mapBounded<T>(items:readonly T[],limit:number,action:(item:T)=>Promise<void>){let cursor=0;let failed=false;let failure:unknown;await Promise.all(Array.from({length:Math.min(Math.max(1,limit),items.length)},async()=>{while(!failed){const index=cursor++;if(index>=items.length)return;try{await action(items[index]);}catch(error){failed=true;failure=error;}}}));if(failed)throw failure;}
/** Draft grouping only: no material/profile selection, fit claim, orientation or approval is inferred. */
export function addRobotDrafts(project:Project,incoming:Part[]){
 const assignedIds=new Set(project.jobs.flatMap(job=>job.items.map(item=>item.partId)));
 const copies=(part:Part)=>part.source.occurrences?.length?part.source.occurrences.map(occurrence=>JSON.stringify([part.source.originDocumentId??part.source.documentId,part.source.originVersionId??part.source.versionId,part.source.originElementId??part.source.elementId,part.source.originConfiguration??part.source.configuration,occurrence.path])):[JSON.stringify(part.source.kind==='local'?['local',part.geometry.hash]:[part.source.kind,part.source.documentId,part.source.versionId,part.source.elementId,part.source.partId??part.id,part.source.configuration])];
 const claimed=new Set(project.parts.filter(part=>assignedIds.has(part.id)).flatMap(copies));
 for(const part of incoming){if(part.classification!=='make'||assignedIds.has(part.id))continue;for(const copy of copies(part)){if(claimed.has(copy))throw new Error(`${part.name}: these CAD copies already appear in another draft or job. Open that job, or choose a different subsystem.`);claimed.add(copy);}}
 for(const part of incoming){const existing=project.parts.find(p=>p.id===part.id);if(existing&&existing.geometry.hash!==part.geometry.hash)throw new Error('An immutable source changed. Create a new revision job instead.');if(existing){existing.quantity=part.quantity;existing.spareQuantity=part.spareQuantity;existing.classification=part.classification;}else project.parts.push(structuredClone(part));}
 const assigned=new Set(project.jobs.flatMap(job=>job.items.map(item=>item.partId))),groups=new Map<string,Part[]>();
 for(const part of incoming){if(part.classification!=='make'||assigned.has(part.id))continue;assigned.add(part.id);const group=[robotSubsystem({assemblyMemberships:part.source.assemblyMemberships}),part.materialHint??'Choose filament'];const key=JSON.stringify(group);groups.set(key,[...(groups.get(key)??[]),part]);}
 const drafts=[...groups].map(([key,parts])=>createJob(parts,JSON.parse(key).join(' · ')));
 if(drafts.length){const current=project.jobs.find(job=>job.id===project.activeJobId);if(current&&!current.items.length&&!current.toolpath&&!current.reviews.length&&!current.releases.length)project.jobs=project.jobs.filter(job=>job.id!==current.id);project.jobs.push(...drafts);project.activeJobId=drafts[0].id;}
 return drafts;
}
