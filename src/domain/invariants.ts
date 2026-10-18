import { strToU8, zipSync } from 'fflate';
import type { Job, JobItem, ManufacturingManifest, OperatorChecks, Part, ProcessSettings, Project, ReviewEvent, SlicerIdentity, Vec3 } from './model';
import { createId } from './model';
import { parseGcode } from '../adapters/toolpaths';
import { validateGeometryIntegrity } from './geometry-integrity';

export function stableStringify(value: unknown): string {
  function sorted(v: unknown): unknown {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Non-finite numbers are not valid manufacturing data.');
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter(k => (v as Record<string,unknown>)[k] !== undefined).map(k => [k, sorted((v as Record<string,unknown>)[k])]));
    return v;
  }
  return JSON.stringify(sorted(value));
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2,'0')).join('');
}
export function toMillimetres(value: number, units: 'mm' | 'in'): number {
  if (!Number.isFinite(value)) throw new Error('Dimensions must be finite.');
  if (units !== 'mm' && units !== 'in') throw new Error('Explicit mm or in units are required.');
  return value * (units === 'in' ? 25.4 : 1);
}
export function validateDimensions(actual: Vec3, expected?: Vec3, tolerance = 0.05): void {
  if (actual.length !== 3 || actual.some(n => !Number.isFinite(n) || n <= 0 || n > 100000)) throw new Error('Invalid or implausible dimensions in millimetres. No geometry was repaired or rescaled.');
  if (expected && actual.some((n,i) => Math.abs(n-expected[i]) > Math.max(tolerance, expected[i]*0.001))) {
    const inches = actual.every((n,i) => Math.abs(n / expected[i] - 25.4) < 0.05 || Math.abs(n / expected[i] - 1/25.4) < 0.001);
    throw new Error(inches ? 'Dimensions differ by an inch/mm conversion factor. Confirm the explicit source units.' : 'Imported dimensions do not match the expected source dimensions. Confirm the source units and geometry.');
  }
}
function event(job: Job, action: string, detail: string, actor = 'Team member'): ReviewEvent {
  const e = { id: createId(), at: new Date().toISOString(), actor, action, detail }; job.reviews.push(e); job.updatedAt = e.at; return e;
}
export function invalidateJob(job: Job, reason: string, actor = 'Team member'): Job {
  const hadResult = !!job.toolpath || !!job.approval;
  if (job.toolpath) { job.toolpath.stale = true; delete job.toolpath.reviewedAt; delete job.toolpath.reviewedBy; delete job.toolpath.reviewedManifestHash; }
  delete job.approval; delete job.operatorChecks;
  if (job.status !== 'draft') job.status = job.items.length ? 'ready to slice' : 'draft';
  if (hadResult) event(job, 'invalidated', reason, actor);
  return job;
}
/** Revoking an operator's mapping preserves the artifact as evidence, never as an actionable result. */
export function revokeToolpathMapping(job: Job, actor: string, reason: string): Job {
  if (!actor.trim() || !reason.trim()) throw new Error('Identify the reviewer and the reason for revoking this toolpath mapping.');
  if (!job.toolpath) throw new Error('There is no toolpath mapping to revoke.');
  if (job.toolpath.mappingConfirmed === false && job.toolpath.stale === true && !job.approval && !job.operatorChecks && !job.toolpath.reviewedAt && !job.toolpath.reviewedBy && !job.toolpath.reviewedManifestHash && !['approved','assigned','printing','completed'].includes(job.status)) return job;
  job.toolpath.mappingConfirmed = false;
  invalidateJob(job, reason, actor);
  event(job, 'toolpath mapping revoked', reason, actor);
  return job;
}
/** Includes exact geometry bytes and unit declarations so asynchronous validation cannot race an edit. */
function operationState(project: Project, job: Job): string {
  return stableStringify({manifest: manufacturingManifest(project, job, true),
    geometry: job.items.map(item => project.parts.find(part => part.id === item.partId)?.geometry),
    gcode: job.toolpath?.gcode, slicerProjectData:job.toolpath?.slicerProject?.data, stale: job.toolpath?.stale, approval: job.approval, status: job.status, assignee: job.assignee});
}
function operationSnapshot(project: Project, job: Job): {project: Project; job: Job; state: string} {
  const state = operationState(project, job);
  const snapshotProject = structuredClone(project);
  const snapshotJob = structuredClone(job);
  const index = snapshotProject.jobs.findIndex(candidate => candidate.id === job.id);
  if (index >= 0) snapshotProject.jobs[index] = snapshotJob;
  return {project: snapshotProject, job: snapshotJob, state};
}
function assertOperationUnchanged(project: Project, job: Job, state: string): void {
  if (operationState(project, job) !== state) throw new Error('Manufacturing inputs or toolpath mapping changed during this action. Review the current job and retry.');
}
export function manufacturingManifest(project: Project, job: Job, includeToolpath = false): ManufacturingManifest {
  const parts = job.items.map(item => {
    const part = project.parts.find(p => p.id === item.partId);
    if (!part) throw new Error(`Part ${item.partId} is missing from the project.`);
    return { partId: part.id, name: part.name, source: structuredClone(part.source), geometryHash: part.geometry.hash, geometryWarnings:[...(part.geometry.warnings??[])], classification:part.classification, geometryFile: `geometry/${encodeURIComponent(part.id)}.stl`,
      ...(part.geometry.original?{originalFile:`originals/${encodeURIComponent(part.id)}.stl`,originalHash:part.geometry.original.hash}:{}),
      dimensions: [...part.geometry.dimensions] as Vec3, quantity: item.quantity, spareQuantity: item.spareQuantity,
      totalQuantity: item.quantity + item.spareQuantity, orientation: [...item.orientation] as Vec3, position: [...item.position] as Vec3,
      instances: layoutItem(part,item).map(({index,orientation,position})=>({index,orientation,position})) };
  });
  return { schemaVersion: 1, jobId: job.id, jobName: job.name, units: 'mm', layoutVersion:'grid-v1', orientationConvention:'Euler XYZ degrees', placementConvention:'source bounding-box XY centre, rotated minimum Z', parts,
    printer: structuredClone(job.printer), material: structuredClone(job.material), settings: structuredClone(job.settings),
    slicer: { ...job.slicer }, useCase: { ...job.useCase }, ...(includeToolpath ? {toolpathHash: job.toolpath?.hash,toolpath:job.toolpath?toolpathAttestation(job.toolpath):undefined} : {}) };
}
function toolpathAttestation(toolpath:import('./model').ToolpathArtifact):NonNullable<ManufacturingManifest['toolpath']> {
  const {gcode:_gcode,stale:_stale,slicerProject,...attestation}=toolpath;
  const metadata=slicerProject?(({data:_data,...rest})=>rest)(slicerProject):undefined;
  return structuredClone({...attestation,...(metadata?{slicerProject:metadata}:{})});
}
export async function fingerprint(project: Project, job: Job): Promise<string> { return sha256(stableStringify(manufacturingManifest(project,job))); }
export async function toolpathReviewFingerprint(project:Project,job:Job):Promise<string> {
  if(!job.toolpath)throw new Error('No toolpath is available for review.');
  const {reviewedAt:_at,reviewedBy:_by,reviewedManifestHash:_hash,...attestation}=toolpathAttestation(job.toolpath);
  return sha256(stableStringify({manufacturing:manufacturingManifest(project,job),attestation}));
}
export async function approvalFingerprint(project: Project, job: Job): Promise<string> { return sha256(stableStringify(manufacturingManifest(project,job,true))); }
export function rotatedDimensions(dimensions: Vec3, orientation: Vec3): Vec3 {
  const [x,y,z] = orientation.map(v => v * Math.PI / 180);
  const [a,b,c,d,e,f] = [Math.cos(x),Math.sin(x),Math.cos(y),Math.sin(y),Math.cos(z),Math.sin(z)];
  // THREE.Euler's XYZ rotation convention, applied to the bounding box corners.
  const m = [c*e,-c*f,d,a*f+b*d*e,a*e-b*d*f,-b*c,b*f-a*d*e,b*e+a*d*f,a*c];
  return [0,1,2].map(r => Math.abs(m[r*3])*dimensions[0]+Math.abs(m[r*3+1])*dimensions[1]+Math.abs(m[r*3+2])*dimensions[2]) as Vec3;
}
export interface PlacedInstance { partId: string; index: number; orientation: Vec3; position: Vec3; dimensions: Vec3; }
export function layoutItem(part: Part, item: JobItem): PlacedInstance[] {
  const dimensions = rotatedDimensions(part.geometry.dimensions,item.orientation);
  const total = item.quantity + item.spareQuantity; const columns = Math.ceil(Math.sqrt(total));
  return Array.from({length:total},(_,i)=>({partId:item.partId,index:i,orientation:[...item.orientation] as Vec3,dimensions,
    position:[item.position[0]+(i%columns)*(dimensions[0]+8),item.position[1]+Math.floor(i/columns)*(dimensions[1]+8),item.position[2]] as Vec3}));
}
export function layoutInstances(project: Project, job: Job): PlacedInstance[] {
  const out: PlacedInstance[] = [];
  for (const item of job.items) {
    const part = project.parts.find(p => p.id === item.partId); if (!part) continue;
    out.push(...layoutItem(part,item));
  }
  return out;
}
export function fitWarnings(project: Project, job: Job): string[] {
  const warnings: string[] = []; const placed = layoutInstances(project,job);
  for (const p of placed) {
    const [x,y,z] = p.position, [w,d,h] = p.dimensions;
    if (x-w/2 < -0.001 || x+w/2 > job.printer.buildVolume[0]+0.001 || y-d/2 < -0.001 || y+d/2 > job.printer.buildVolume[1]+0.001 || z < -0.001 || z+h > job.printer.buildVolume[2]+0.001)
      warnings.push(`${project.parts.find(v=>v.id===p.partId)?.name ?? p.partId}, copy ${p.index+1}: outside the selected build volume.`);
  }
  for(let i=0;i<placed.length;i++) for(let j=i+1;j<placed.length;j++) {
    const a=placed[i],b=placed[j];
    if (Math.abs(a.position[0]-b.position[0]) < (a.dimensions[0]+b.dimensions[0])/2-0.001 && Math.abs(a.position[1]-b.position[1]) < (a.dimensions[1]+b.dimensions[1])/2-0.001)
      warnings.push(`${project.parts.find(v=>v.id===a.partId)?.name} and ${project.parts.find(v=>v.id===b.partId)?.name}: bounding boxes overlap; move the parts apart.`);
  }
  return [...new Set(warnings)];
}
function assertVec(v: number[], label: string): void { if(v.length!==3 || v.some(x=>!Number.isFinite(x))) throw new Error(`${label} must contain three finite coordinates.`); }
export function validateSettings(settings: ProcessSettings): void {
  if (!Number.isFinite(settings.layerHeight) || settings.layerHeight < 0.04 || settings.layerHeight > 1) throw new Error('Layer height must be between 0.04 and 1 mm.');
  if (!Number.isInteger(settings.walls) || settings.walls < 1 || settings.walls > 20) throw new Error('Wall count must be an integer between 1 and 20.');
  if (!Number.isFinite(settings.infill) || settings.infill < 0 || settings.infill > 100) throw new Error('Infill must be between 0 and 100%.');
  if (typeof settings.supports !== 'boolean') throw new Error('Support selection must be explicit.');
  if (!Number.isFinite(settings.brimWidth) || settings.brimWidth < 0 || settings.brimWidth > 50) throw new Error('Brim width must be between 0 and 50 mm.');
  if (!Number.isFinite(settings.speed) || settings.speed <= 0 || settings.speed > 1000) throw new Error('Print speed must be greater than 0 and at most 1000 mm/s.');
  for(const value of Object.values(settings)) if(typeof value==='number'&&!Number.isFinite(value)) throw new Error('Settings cannot contain non-finite numbers.');
}
export async function validateJob(project: Project, job: Job, checkFit = true): Promise<void> {
  if (!job.items.length) throw new Error('Select at least one make part for this job.');
  if(new Set(job.items.map(i=>i.partId)).size!==job.items.length) throw new Error('Duplicate part rows are not allowed; use the quantity field.');
  validateSettings(job.settings); assertVec(job.printer.buildVolume,'Build volume');
  if(job.printer.buildVolume.some(v=>v<=0)||!Number.isFinite(job.printer.nozzleDiameter)||job.printer.nozzleDiameter<=0) throw new Error('Printer dimensions and nozzle must be positive.');
  const countedOccurrences=new Set<string>();
  for (const item of job.items) {
    const part = project.parts.find(p=>p.id===item.partId);
    if (!part) throw new Error('The job refers to a missing part.');
    if (part.classification !== 'make') throw new Error(`${part.name}: classify this part as make before manufacturing.`);
    if (part.source.available===false) throw new Error(`${part.name}: linked geometry is unavailable.`);
    if (part.source.kind !== 'local' && !part.source.versionId) throw new Error(`${part.name}: select an immutable CAD version.`);
    if (part.source.kind !== 'local' && (!part.source.documentId?.trim()||!part.source.elementId?.trim()||typeof part.source.configuration!=='string')) throw new Error(`${part.name}: source document, element and explicit configuration are required.`);
    if (part.source.kind === 'onshape' && !part.source.partId?.trim()) throw new Error(`${part.name}: the exact Onshape source part ID is missing.`);
    const occurrencePaths=(part.source.occurrences??[]).map(occurrence=>JSON.stringify(occurrence.path));
    if(new Set(occurrencePaths).size!==occurrencePaths.length)throw new Error(`${part.name}: duplicate source occurrence paths must not be counted twice. Reimport the exact assembly and configuration.`);
    for(const occurrence of part.source.occurrences??[]){
      const key=JSON.stringify([part.source.originDocumentId??part.source.documentId,part.source.originVersionId??part.source.versionId,part.source.originElementId??part.source.elementId,part.source.originConfiguration??part.source.configuration,occurrence.path]);
      if(countedOccurrences.has(key))throw new Error(`${part.name}: overlapping assembly imports count the same occurrence twice. Remove one source selection.`);
      countedOccurrences.add(key);
    }
    if (!Number.isInteger(item.quantity)||item.quantity<0||item.quantity+item.spareQuantity<1||!Number.isInteger(item.spareQuantity)||item.spareQuantity<0||item.quantity+item.spareQuantity>1000) throw new Error('Quantities must be whole numbers from 0 to 1000 with at least one total required or backup copy.');
    assertVec(item.orientation,'Orientation'); assertVec(item.position,'Placement');
    if(part.geometry.units!=='mm') throw new Error('Normalized manufacturing geometry must use explicit millimetres.');
    validateDimensions(part.geometry.dimensions);
    await validateGeometryIntegrity(part.geometry,part.name);
  }
  if(checkFit) { const warnings=fitWarnings(project,job); if(warnings.length) throw new Error(warnings[0]); }
}
export interface AttachToolpathOptions {
  name: string; source: 'imported' | 'bambu' | 'fixture'; slicer?: SlicerIdentity; warnings?: string[];
  mappingConfirmed: boolean; slicerProject?: import('./model').ToolpathArtifact['slicerProject']; bounds?: {min:Vec3;max:Vec3};
}
function hasSlicerIdentity(slicer:SlicerIdentity):boolean {
  return !!slicer.id.trim()&&!!slicer.version.trim()&&!/^(?:operator-declared|unknown|unspecified|pending|n\/a)$/i.test(slicer.version.trim());
}
export async function attachToolpath(project: Project, job: Job, gcode: string, options: AttachToolpathOptions): Promise<Job> {
  const snapshot = operationSnapshot(project, job);
  options = structuredClone(options);
  await validateJob(snapshot.project,snapshot.job);
  if (!gcode.trim() || gcode.length > 25*1024*1024 || !/^\s*(?:N\d+\s+)?G[01](?:\s|$)/mi.test(gcode)) throw new Error('Import a supported G-code file containing actual G0/G1 toolpaths (maximum 25 MB).');
  const preview = parseGcode(gcode);
  if(!preview.canApprove) throw new Error(preview.blockingIssues[0] ?? 'Toolpath preview is incomplete; approval is blocked.');
  options = {...options, bounds: preview.bounds, warnings: [...new Set([...(options.warnings??[]),...preview.warnings])], source: preview.isDemonstration ? 'fixture' : options.source};
  if(!options.mappingConfirmed) throw new Error('Confirm that the imported toolpath corresponds to this exact geometry, quantity, placement, printer, material and settings.');
  if(options.bounds) {
    assertVec(options.bounds.min,'Toolpath bounds'); assertVec(options.bounds.max,'Toolpath bounds');
    for(let i=0;i<3;i++) if(options.bounds.min[i]<-0.1||options.bounds.max[i]>snapshot.job.printer.buildVolume[i]+0.1) throw new Error('Toolpath coordinates exceed the selected build volume. Verify units and printer mapping.');
  }
  const slicer=options.slicer??snapshot.job.slicer;
  if(!hasSlicerIdentity(slicer))throw new Error('Declare the actual slicer name and version before binding a toolpath.');
  snapshot.job.slicer={...slicer};
  if(options.slicerProject && await sha256(Uint8Array.from(atob(options.slicerProject.data),c=>c.charCodeAt(0)))!==options.slicerProject.hash)throw new Error('Slicer project checksum mismatch.');
  const at=new Date().toISOString();
  const toolpath: import('./model').ToolpathArtifact = {id:createId(),name:options.name,gcode,hash:await sha256(gcode),manifestHash:await fingerprint(snapshot.project,snapshot.job),
    source:options.source,slicer:{...snapshot.job.slicer},...(options.slicerProject?{slicerProject:options.slicerProject}:{}),createdAt:at,warnings:[...(options.warnings??[])],mappingConfirmed:true};
  assertOperationUnchanged(project, job, snapshot.state);
  job.slicer={...slicer};
  delete job.approval; delete job.operatorChecks;
  job.toolpath=toolpath;
  job.status='sliced'; event(job,'toolpath imported',`${options.source} · ${options.name}`); return job;
}
export async function isToolpathCurrent(project: Project, job: Job): Promise<boolean> {
  try {
    const snapshot = operationSnapshot(project, job);
    const current = await snapshotToolpathCurrent(snapshot.project, snapshot.job);
    return current && operationState(project,job) === snapshot.state;
  } catch { return false; }
}
async function snapshotToolpathCurrent(project: Project, job: Job): Promise<boolean> {
  if(!job.toolpath || job.toolpath.stale || job.toolpath.mappingConfirmed!==true || !hasSlicerIdentity(job.slicer)) return false;
  if(stableStringify(job.toolpath.slicer)!==stableStringify(job.slicer))return false;
  try {
    if(job.toolpath.slicerProject && await sha256(Uint8Array.from(atob(job.toolpath.slicerProject.data),c=>c.charCodeAt(0)))!==job.toolpath.slicerProject.hash)return false;
    const preview=parseGcode(job.toolpath.gcode);
    if(!preview.canApprove || (preview.isDemonstration&&job.toolpath.source!=='fixture'))return false;
    for(let i=0;i<3;i++)if(preview.bounds.min[i]<-0.1||preview.bounds.max[i]>job.printer.buildVolume[i]+0.1)return false;
  } catch { return false; }
  return job.toolpath.manifestHash===await fingerprint(project,job) && job.toolpath.hash===await sha256(job.toolpath.gcode);
}
const reviewLocks = new WeakMap<Job,Promise<Job>>();
export async function reviewToolpath(project: Project, job: Job, actor: string): Promise<Job> {
  const pending=reviewLocks.get(job);if(pending)return pending;
  const operation=performToolpathReview(project,job,actor);reviewLocks.set(job,operation);
  try{return await operation;}finally{reviewLocks.delete(job);}
}
async function performToolpathReview(project: Project, job: Job, actor: string): Promise<Job> {
  if(!actor.trim()) throw new Error('Identify the reviewer.');
  const snapshot=operationSnapshot(project,job);
  if(!await snapshotToolpathCurrent(snapshot.project,snapshot.job)) throw new Error('Toolpath is stale or missing. Import or generate a matching result before review.');
  const reviewedManifestHash=await toolpathReviewFingerprint(snapshot.project,snapshot.job);
  assertOperationUnchanged(project,job,snapshot.state);
  if(job.toolpath!.reviewedAt&&Number.isFinite(Date.parse(job.toolpath!.reviewedAt))&&job.toolpath!.reviewedBy===actor&&job.toolpath!.reviewedManifestHash===reviewedManifestHash)return job;
  if(job.approval){
    delete job.approval;delete job.operatorChecks;job.status='sliced';
    event(job,'approval invalidated','The layer review attestation changed. Approve the exact current review before release.',actor);
  }
  job.toolpath!.reviewedAt=new Date().toISOString(); job.toolpath!.reviewedBy=actor;job.toolpath!.reviewedManifestHash=reviewedManifestHash;
  event(job,'toolpath reviewed',`Reviewed ${job.toolpath!.hash}`,actor); return job;
}
export function isDemonstration(project:Project,job:Job):boolean {
  return job.toolpath?.source==='fixture'||/CATALYST_DEMONSTRATION_TOOLPATH/i.test(job.toolpath?.gcode??'')||!job.printer.tested||!job.material.tested||job.items.some(i=>project.parts.find(p=>p.id===i.partId)?.source.kind==='fixture');
}
const approvalLocks = new WeakMap<Job,Promise<Job>>();
export async function approveJob(project: Project, job: Job, actor: string): Promise<Job> {
  const pending=approvalLocks.get(job);if(pending)return pending;
  const operation=performApproval(project,job,actor);approvalLocks.set(job,operation);
  try{return await operation;}finally{approvalLocks.delete(job);}
}
async function performApproval(project: Project, job: Job, actor: string): Promise<Job> {
  if(!actor.trim()) throw new Error('Identify the approving reviewer.');
  const snapshot=operationSnapshot(project,job), reviewed=snapshot.job;
  await validateJob(snapshot.project,reviewed);
  if(!await snapshotToolpathCurrent(snapshot.project,reviewed)) throw new Error('Toolpath is stale or missing. Review a matching slicing result before approval.');
  if(!reviewed.toolpath?.reviewedAt||!Number.isFinite(Date.parse(reviewed.toolpath.reviewedAt))||!reviewed.toolpath.reviewedBy?.trim()) throw new Error('Review the actual layer toolpaths before approving this job.');
  if(reviewed.toolpath.reviewedManifestHash!==await toolpathReviewFingerprint(snapshot.project,reviewed))throw new Error('Review the actual layer toolpaths again: the toolpath provenance or attestation changed.');
  if(!reviewed.toolpath.mappingConfirmed) throw new Error('The imported toolpath mapping has not been confirmed.');
  const manifestHash=await approvalFingerprint(snapshot.project,reviewed);
  const demonstrationOnly=isDemonstration(snapshot.project,reviewed);
  assertOperationUnchanged(project,job,snapshot.state);
  if(job.approval?.manifestHash===manifestHash&&job.approval.demonstrationOnly===demonstrationOnly&&job.approval.toolpathHash===reviewed.toolpath.hash&&job.approval.actor.trim()&&Number.isFinite(Date.parse(job.approval.at))) return job;
  job.approval={id:createId(),actor,at:new Date().toISOString(),manifestHash,toolpathHash:reviewed.toolpath.hash,demonstrationOnly};
  job.status='approved'; event(job,'approved',`Exact manifest ${manifestHash}`,actor); return job;
}
export async function isApprovalCurrent(project: Project, job: Job): Promise<boolean> {
  try {
    const snapshot=operationSnapshot(project,job);
    const current=await snapshotApprovalCurrent(snapshot.project,snapshot.job);
    return current && operationState(project,job)===snapshot.state;
  } catch { return false; }
}
async function snapshotApprovalCurrent(project: Project, job: Job): Promise<boolean> {
  if(!job.approval||!job.approval.actor.trim()||!Number.isFinite(Date.parse(job.approval.at)))return false;
  if(!job.toolpath?.reviewedAt||!Number.isFinite(Date.parse(job.toolpath.reviewedAt))||!job.toolpath.reviewedBy?.trim()||job.toolpath.mappingConfirmed!==true)return false;
  if(job.approval.demonstrationOnly!==isDemonstration(project,job))return false;
  try { await validateJob(project,job); } catch { return false; }
  return await snapshotToolpathCurrent(project,job) && job.toolpath.reviewedManifestHash===await toolpathReviewFingerprint(project,job) && job.approval.manifestHash===await approvalFingerprint(project,job) && job.approval.toolpathHash===job.toolpath.hash;
}
export async function assignJob(project: Project, job: Job, assignee: string, actor = 'Team member'): Promise<Job> {
  if(!assignee.trim()) throw new Error('Enter an operator or station assignment.');
  if(job.status==='printing'||job.status==='completed')throw new Error('A job with reported manufacturing activity cannot be reset by reassignment.');
  const snapshot=operationSnapshot(project,job);
  if(!await snapshotApprovalCurrent(snapshot.project,snapshot.job)) throw new Error('Approve the exact current job before assignment.');
  assertOperationUnchanged(project,job,snapshot.state);
  if(job.assignee===assignee&&job.status==='assigned') return job;
  job.assignee=assignee; job.status='assigned'; event(job,'assigned',`Assigned to ${assignee}; machine acceptance and printing are not verified.`,actor); return job;
}
export interface ReleaseOptions { idempotencyKey: string; actor: string; checks?: OperatorChecks; }
const releaseLocks = new WeakMap<Job, Map<string, Promise<import('./model').ReleaseRecord>>>();
export async function releaseJob(project: Project, job: Job, options: ReleaseOptions):Promise<import('./model').ReleaseRecord> {
  let locks=releaseLocks.get(job);if(!locks){locks=new Map();releaseLocks.set(job,locks);}
  const pending=locks.get(options.idempotencyKey);if(pending)return pending;
  const operation=performRelease(project,job,options);locks.set(options.idempotencyKey,operation);
  try{return await operation;}finally{locks.delete(options.idempotencyKey);}
}
async function performRelease(project: Project, job: Job, options: ReleaseOptions) {
  options=structuredClone(options);
  if(!options.idempotencyKey.trim()||!options.actor.trim()) throw new Error('Release needs an operator name and an idempotency key.');
  const snapshot=operationSnapshot(project,job);
  const existing=job.releases.find(r=>r.idempotencyKey===options.idempotencyKey);
  if(existing) {
    if(!await snapshotApprovalCurrent(snapshot.project,snapshot.job)||existing.manifestHash!==snapshot.job.approval!.manifestHash) throw new Error('This release key belongs to a different manufacturing manifest.');
    assertOperationUnchanged(project,job,snapshot.state);return existing;
  }
  if(!await snapshotApprovalCurrent(snapshot.project,snapshot.job)) throw new Error('Approval is stale or missing. Approve the exact current manifest before export.');
  const demonstrationOnly=snapshot.job.approval!.demonstrationOnly;
  if(!demonstrationOnly && (!options.checks||!(['machine','material','nozzle','plate','clearBed'] as const).every(key=>options.checks?.[key]===true))) throw new Error('An operator must confirm the machine, loaded material, nozzle, plate and clear bed before physical release.');
  assertOperationUnchanged(project,job,snapshot.state);
  const record={id:createId(),idempotencyKey:options.idempotencyKey,at:new Date().toISOString(),actor:options.actor,
    manifestHash:snapshot.job.approval!.manifestHash,toolpathHash:snapshot.job.toolpath!.hash,demonstrationOnly};
  job.releases.push(record); if(options.checks)job.operatorChecks={...options.checks};
  const reported=event(job,'package exported',demonstrationOnly?'NON-MANUFACTURABLE demonstration package.':`Operator-attested checks; no machine dispatch was performed.`,options.actor);
  reported.manifestHash=record.manifestHash;reported.toolpathHash=record.toolpathHash;reported.releaseId=record.id;return record;
}
export async function operatorTransition(project: Project,job: Job,status:'printing'|'completed',actor:string):Promise<Job> {
  if(!actor.trim())throw new Error('Identify the operator reporting this state.');
  if(!await isApprovalCurrent(project,job)||!job.releases.some(r=>r.manifestHash===job.approval?.manifestHash&&r.toolpathHash===job.toolpath?.hash))throw new Error('Export a currently approved package before recording manufacturing activity.');
  if(isDemonstration(project,job))throw new Error('Demonstration jobs cannot be marked as physically printing or completed.');
  if(status==='completed'&&job.status!=='printing')throw new Error('An operator must first report that printing started.');
  if(status==='printing'&&job.status!=='assigned')throw new Error('Assign an operator before recording printing.');
  const matchingReleases=job.releases.filter(r=>r.manifestHash===job.approval!.manifestHash&&r.toolpathHash===job.toolpath!.hash);
  const priorPrinting=[...job.reviews].reverse().find(e=>e.action==='operator reported printing'&&e.manifestHash===job.approval!.manifestHash&&e.toolpathHash===job.toolpath!.hash);
  const release=status==='completed'?matchingReleases.find(r=>r.id===priorPrinting?.releaseId):matchingReleases.at(-1);
  if(!release)throw new Error('A named printing report must bind to the current approved release before completion.');
  job.status=status;const reported=event(job,`operator reported ${status}`,'Explicit operator action; no verified machine feedback.',actor);
  reported.manifestHash=release.manifestHash;reported.toolpathHash=release.toolpathHash;reported.releaseId=release.id;return job;
}
export function settingOverrides(job:Job):Record<string,{base:number|string|boolean|undefined;value:number|string|boolean}> {
  return Object.fromEntries(Object.entries(job.settings).filter(([key,value])=>job.baseSettings[key]!==value).map(([key,value])=>[key,{base:job.baseSettings[key],value}]));
}
const exportLocks=new WeakMap<Job,Map<string,Promise<Uint8Array>>>();
export async function exportJobPackage(project:Project,job:Job,options:ReleaseOptions):Promise<Uint8Array> {
  let locks=exportLocks.get(job);if(!locks){locks=new Map();exportLocks.set(job,locks);}
  const pending=locks.get(options.idempotencyKey);if(pending)return pending;
  const operation=performPackageExport(project,job,options);locks.set(options.idempotencyKey,operation);
  try{return await operation;}finally{locks.delete(options.idempotencyKey);}
}
async function performPackageExport(project:Project,job:Job,options:ReleaseOptions):Promise<Uint8Array> {
  options=structuredClone(options);
  const snapshot=operationSnapshot(project,job);
  // Prepare the record inside the snapshot; interrupted exports must not claim a package was exported.
  await releaseJob(snapshot.project,snapshot.job,options);
  const bytes=await buildJobPackage(snapshot.project,snapshot.job,options);
  assertOperationUnchanged(project,job,snapshot.state);
  const release=snapshot.job.releases.find(record=>record.idempotencyKey===options.idempotencyKey)!;
  const existing=job.releases.find(record=>record.idempotencyKey===options.idempotencyKey);
  if(existing&&existing.id!==release.id)throw new Error('This release key changed during export. Retry to export its existing approved package.');
  if(!existing){
    job.releases.push(structuredClone(release));
    job.reviews.push(...structuredClone(snapshot.job.reviews.filter(review=>review.action==='package exported'&&review.releaseId===release.id)));
    if(options.checks)job.operatorChecks={...options.checks};
    job.updatedAt=snapshot.job.updatedAt;
  }
  return bytes;
}
async function buildJobPackage(project:Project,job:Job,options:ReleaseOptions):Promise<Uint8Array> {
  const manifest={...manufacturingManifest(project,job,true),approval:job.approval,demonstrationOnly:job.approval!.demonstrationOnly,
    release:job.releases.find(r=>r.idempotencyKey===options.idempotencyKey),handoff:'operator-controlled-export',dispatchPerformed:false};
  const files:Record<string,Uint8Array>={
    'manifest.json':strToU8(JSON.stringify(manifest,null,2)),
    'project.catalyst.json':strToU8(JSON.stringify(project,null,2)),
    'settings.json':strToU8(JSON.stringify({printer:job.printer,material:job.material,process:job.settings,slicer:job.slicer},null,2)),
    'toolpaths/job.gcode':strToU8(job.toolpath!.gcode),
    'README.txt':strToU8((manifest.demonstrationOnly?'NON-MANUFACTURABLE DEMONSTRATION PACKAGE\nFixture geometry/toolpaths or untested profiles are present. DO NOT RUN ON A MACHINE.\n\n':'OPERATOR-CONTROLLED MANUFACTURING PACKAGE\n')+
      'Geometry is preserved as source artifacts. Every copy placement, Euler XYZ rotation in degrees, quantity and explicit millimetre units are in manifest.json. XY is the source bounding-box centre after rotation; Z offsets the rotated minimum. Copies use the versioned grid-v1 layout with 8 mm bounding-box gaps.\nSources, slicer projects and toolpaths are distinct artifacts. Native sliced projects are included under slicer/ when present.\nNo dispatch, machine acceptance, printing or physical condition verification was performed by this software.\nBefore physical use, verify machine, material, nozzle, build plate and clear bed. Verify external G-code mapping and machine compatibility.\nImported G-code mapping is an operator attestation; it is not cryptographic proof that an external slicer used these settings.\nApproval records are local review records, not authenticated digital signatures.\n'),
  };
  if(job.toolpath?.slicerProject){const artifact=job.toolpath.slicerProject;const data=Uint8Array.from(atob(artifact.data),c=>c.charCodeAt(0));if(await sha256(data)!==artifact.hash)throw new Error('Slicer project checksum mismatch.');files['slicer/job.3mf']=data;}
  for(const item of job.items){const p=project.parts.find(v=>v.id===item.partId)!;const safe=encodeURIComponent(p.id);files[`geometry/${safe}.stl`]=strToU8(p.geometry.stl);
    if(p.geometry.original){const o=p.geometry.original;files[`originals/${safe}.stl`]=o.encoding==='base64'?Uint8Array.from(atob(o.data),c=>c.charCodeAt(0)):strToU8(o.data);}}
  const checksums:Record<string,string>={};for(const [name,data] of Object.entries(files))checksums[name]=await sha256(data);
  files['checksums.sha256.json']=strToU8(JSON.stringify(checksums,null,2));return zipSync(files,{level:6,mtime:new Date(job.approval!.at)});
}
