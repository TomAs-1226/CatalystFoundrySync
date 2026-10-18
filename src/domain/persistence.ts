import { preparationStatus } from './preparation';
import { z } from 'zod';
import type { GeometryAsset, Job, Project } from './model';
import { createId } from './model';
import { validateGeometryIntegrity } from './geometry-integrity';
import { invalidateJob, isApprovalCurrent, isDemonstration, isToolpathCurrent, sha256, validateDimensions } from './invariants';
const finite=z.number().finite();
const short=z.string().max(2000);
const vec=z.tuple([finite,finite,finite]);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const settings=z.object({layerHeight:finite,walls:finite,infill:finite,supports:z.boolean(),brimWidth:finite,speed:finite}).catchall(z.union([finite,z.string(),z.boolean()]));
const printer=z.object({id:short,model:short,nozzleDiameter:finite,plate:short,buildVolume:vec,tested:z.boolean(),nozzleCount:z.number().int().min(1).max(2).optional(),activeNozzle:z.literal('primary').optional()});
const material=z.object({id:short,name:short,type:short,color:short,tested:z.boolean()});
const slicer=z.object({id:short,version:short,profileBundleHash:sha.optional()});
const category=z.enum(['bracket','enclosure','spacer','pulley','custom']);
const occurrence=z.object({path:z.array(short).max(100),transform:z.array(finite).length(16)});
const source=z.object({kind:z.enum(['fixture','onshape','local']),documentId:short.optional(),documentName:short.optional(),
  elementId:short.optional(),elementName:short.optional(),versionId:short.optional(),versionName:short.optional(),configuration:short.optional(),
  url:z.string().max(4000).refine(v=>/^https?:\/\//i.test(v),'Source links must use HTTP(S).').optional(),revision:short.optional(),
  occurrences:z.array(occurrence).max(10000).optional(),linkedDocumentId:short.optional(),available:z.boolean().optional(),partId:short.optional(),
  microversionId:short.optional(),installedTransformUnits:z.enum(['m','mm']).optional(),elementType:z.enum(['assembly','partstudio']).optional(),originDocumentId:short.optional(),originVersionId:short.optional(),originElementId:short.optional(),originConfiguration:short.optional(),originElementName:short.optional(),assemblyScope:z.array(short).max(100).optional(),assemblyMemberships:z.array(z.object({path:z.array(short).max(100),names:z.array(short).max(100),quantity:z.number().int().min(1).max(10000)})).max(10000).optional()});
const geometry=z.object({stl:z.string().min(1).max(50*1024*1024),hash:sha,dimensions:vec,units:z.literal('mm'),
  original:z.object({name:short,hash:sha.optional(),data:z.string().max(70*1024*1024),units:z.enum(['mm','in']),format:z.literal('stl'),encoding:z.enum(['text','base64']).optional()}).optional(),
  vertices:z.array(finite).max(9_000_000).optional(),warnings:z.array(short).optional()});
const part=z.object({id:short,name:short,geometry,source,quantity:z.number().int().min(1).max(1000),spareQuantity:z.number().int().min(0).max(999),
  category,classification:z.enum(['make','buy','review']),materialHint:short.optional(),colorHint:short.optional(),notes:short.optional(),status:short.optional()});
const event=z.object({id:short,at:short,actor:short,action:short,detail:z.string().max(10000),manifestHash:sha.optional(),toolpathHash:sha.optional(),releaseId:short.optional()});
const release=z.object({id:short,idempotencyKey:short,at:short,actor:short,manifestHash:sha,toolpathHash:sha,demonstrationOnly:z.boolean()});
const checks=z.object({machine:z.boolean(),material:z.boolean(),nozzle:z.boolean(),plate:z.boolean(),clearBed:z.boolean()});
const job=z.object({id:short,name:short,items:z.array(z.object({partId:short,quantity:z.number().int().min(0).max(1000),spareQuantity:z.number().int().min(0).max(999),orientation:vec,position:vec})).max(1000),
  printer,material,settings,baseSettings:settings,slicer,
  useCase:z.object({purpose:short,loadDirection:short,constraints:short,operatingConditions:short,confirmed:z.boolean()}),
  status:z.enum(['draft','needs review','ready to slice','sliced','approved','assigned','printing','completed']),
  toolpath:z.object({id:short,name:short,gcode:z.string().max(25*1024*1024),hash:sha,manifestHash:sha,source:z.enum(['imported','bambu','fixture']),slicer,
    slicerProject:z.object({name:short,data:z.string().max(70*1024*1024),hash:sha,encoding:z.literal('base64'),format:z.literal('3mf')}).optional(),
    createdAt:short,warnings:z.array(z.string()).max(1000),mappingConfirmed:z.boolean(),reviewedAt:short.optional(),reviewedBy:short.optional(),reviewedManifestHash:sha.optional(),stale:z.boolean().optional()}).optional(),
  approval:z.object({id:short,actor:short,at:short,manifestHash:sha,toolpathHash:sha,demonstrationOnly:z.boolean()}).optional(),
  reviews:z.array(event).max(10000),releases:z.array(release).max(10000),assignee:short.optional(),operatorChecks:checks.optional(),createdAt:short,updatedAt:short});
export const projectSchema=z.object({schemaVersion:z.literal(1),id:short,name:short,manufacturingOrder:z.string().max(100).optional(),parts:z.array(part).max(1000),jobs:z.array(job).max(1000),activeJobId:short,
  teamPresets:z.array(z.object({id:short,name:short,category,printer,material,settings,tested:z.boolean()})).max(1000),createdAt:short,updatedAt:short});
export async function validateGeometryAsset(asset:GeometryAsset,name='Geometry'):Promise<void> {
  await validateGeometryIntegrity(asset,name,true);
}
export function serializeProject(project:Project):string {
  projectSchema.parse(project);return JSON.stringify(project,null,2);
}
function physicalHistoryConsistent(job:Job):boolean {
  const releases=job.releases.filter(r=>r.manifestHash===job.approval?.manifestHash&&r.toolpathHash===job.toolpath?.hash&&!r.demonstrationOnly&&r.actor.trim()&&Number.isFinite(Date.parse(r.at)));
  if(!job.assignee?.trim()||!job.operatorChecks||!(['machine','material','nozzle','plate','clearBed'] as const).every(k=>job.operatorChecks?.[k]===true))return false;
  return releases.some(release=>{
    const bound=(e:Job['reviews'][number])=>e.actor.trim()&&Number.isFinite(Date.parse(e.at))&&e.manifestHash===release.manifestHash&&e.toolpathHash===release.toolpathHash&&e.releaseId===release.id;
    const exported=job.reviews.findIndex(e=>e.action==='package exported'&&bound(e));
    const printing=job.reviews.findIndex((e,index)=>index>exported&&e.action==='operator reported printing'&&bound(e));
    if(exported<0||printing<0)return false;
    return job.status!=='completed'||job.reviews.some((e,index)=>index>printing&&e.action==='operator reported completed'&&bound(e));
  });
}
function recoverPhysicalClaim(job:Job,claimed:string):void {
  job.status=job.approval?'approved':job.toolpath&&!job.toolpath.stale?'sliced':job.items.length?'ready to slice':'draft';
  const at=new Date().toISOString();job.updatedAt=at;
  job.reviews.push({id:createId(),at,actor:'Project recovery',action:'physical state recovered',detail:`The imported ${claimed} claim lacks a matching release, physical checks or named operator transition history. A package release alone does not report printing.`});
}
/** Reopen checks bytes independently; stale approvals are retained in history but no longer actionable. */
export async function deserializeProject(json:string):Promise<Project> {
  if(new TextEncoder().encode(json).byteLength>100*1024*1024)throw new Error('Project exceeds the 100 MB import limit.');
  let raw:unknown;try{raw=JSON.parse(json);}catch{throw new Error('Project is not valid JSON. Import a Catalyst project JSON file.');}
  const result=projectSchema.safeParse(raw);
  if(!result.success)throw new Error(`Invalid Catalyst project: ${result.error.issues[0]?.path.join('.') || 'schema'} ${result.error.issues[0]?.message}.`);
  const project=result.data as Project;
  if(new Set(project.parts.map(p=>p.id)).size!==project.parts.length||new Set(project.jobs.map(j=>j.id)).size!==project.jobs.length)throw new Error('Project contains duplicate part or job IDs.');
  if(!project.jobs.some(j=>j.id===project.activeJobId))throw new Error('Active job is missing.');
  for(const part of project.parts)await validateGeometryAsset(part.geometry,part.name);
  for(const job of project.jobs){
    const claimedPhysical=['printing','completed'].includes(job.status)?job.status:undefined;
    if(job.items.some(i=>!project.parts.some(p=>p.id===i.partId)))throw new Error(`${job.name}: referenced geometry is missing.`);
    if(new Set(job.releases.map(r=>r.idempotencyKey)).size!==job.releases.length)throw new Error('Project contains duplicate release keys.');
    if(job.toolpath&&await sha256(job.toolpath.gcode)!==job.toolpath.hash)throw new Error(`${job.name}: toolpath checksum mismatch.`);
    if(job.toolpath&&!await isToolpathCurrent(project,job))invalidateJob(job,'Reopened project contains stale or unsupported toolpaths.','Project recovery');
    if(job.approval&&(!await isApprovalCurrent(project,job)||job.approval.demonstrationOnly!==isDemonstration(project,job)))invalidateJob(job,'Reopened project approval does not match the complete manufacturing manifest.','Project recovery');
    if(['approved','assigned','printing','completed'].includes(job.status)&&!job.approval){job.status=job.toolpath&&!job.toolpath.stale?'sliced':job.items.length?'ready to slice':'draft';}
    if(claimedPhysical&&(isDemonstration(project,job)||!physicalHistoryConsistent(job)))recoverPhysicalClaim(job,claimedPhysical);
  }
  for(const batch of project.jobs)if(batch.status==='ready to slice')batch.status=preparationStatus(project,batch);
  return project;
}
