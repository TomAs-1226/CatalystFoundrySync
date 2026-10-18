import {z} from 'zod';
import {ApiError,canonical,digest,type Database,type Member} from './types';
const hash=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().min(1).max(300),count=z.number().int().min(0).max(1000);
const source=z.object({kind:z.enum(['onshape','local']),documentId:z.string().optional(),versionId:z.string().optional(),elementId:z.string().optional(),partId:z.string().optional(),configuration:z.string().optional(),originDocumentId:z.string().optional(),originVersionId:z.string().optional(),originElementId:z.string().optional(),originConfiguration:z.string().optional(),occurrences:z.array(z.object({path:z.array(z.string().min(1).max(2000)).max(100)}).passthrough()).max(10000).optional(),assemblyMemberships:z.array(z.object({names:z.array(z.string()).max(100)}).passthrough()).optional()}).passthrough();
const manifestSchema=z.object({schemaVersion:z.literal(1),jobId:text,jobName:text,units:z.literal('mm'),parts:z.array(z.object({partId:z.string(),name:text,source,geometryHash:hash,quantity:count,spareQuantity:count,totalQuantity:count,classification:z.literal('make')}).passthrough()).min(1).max(1000)}).passthrough();
export interface Unit {unitKey:string;partKey:string;partName:string;subsystem:string;purpose:'required'|'backup';slot:string;}
export async function manufacturingUnits(input:unknown,workOrder:string){
 const manifest=manifestSchema.parse(input);const units:Unit[]=[];
 for(const part of manifest.parts){
  if(part.quantity+part.spareQuantity<1||part.quantity+part.spareQuantity!==part.totalQuantity||part.totalQuantity>1000)throw new ApiError(400,'Required and backup quantities must match the exact manifest.');
  const s=part.source;if(s.kind==='onshape'&&(!s.documentId||!s.versionId||!s.elementId||!s.partId||s.configuration===undefined))throw new ApiError(400,'An immutable Onshape source is required.');
  const partKey=await digest(canonical({originDocumentId:s.originDocumentId??s.documentId,originVersionId:s.originVersionId??s.versionId,originElementId:s.originElementId??s.elementId,originConfiguration:s.originConfiguration??s.configuration,documentId:s.documentId,versionId:s.versionId,elementId:s.elementId,partId:s.partId,configuration:s.configuration,geometryHash:part.geometryHash}));
  const paths=(s.occurrences??[]).map(o=>canonical(o.path)).sort();if(new Set(paths).size!==paths.length)throw new ApiError(400,'Duplicate assembly occurrences are not allowed.');
  for(const purpose of ['required','backup'] as const){const quantity=purpose==='required'?part.quantity:part.spareQuantity;
   for(let i=0;i<quantity;i++){const slot=purpose==='required'?(paths[i]??`manual-copy-${i+1}`):`backup-${i+1}`;units.push({unitKey:await digest(canonical([workOrder,partKey,purpose,slot])),partKey,partName:part.name,subsystem:s.assemblyMemberships?.map(m=>m.names.join(' / ')).join(' · ')??'',purpose,slot});}
  }
 }
 if(units.length>1000||new Set(units.map(u=>u.unitKey)).size!==units.length)throw new ApiError(400,'Overlapping source selections or more than 1000 copies are not allowed.');
 return {manifest,units};
}
const claimSchema=z.object({workOrder:z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/).transform(value=>value.toLowerCase().replace(/\s+/g,' ')),idempotencyKey:text,manifest:z.unknown(),manifestHash:hash,artifactHash:hash}).strict();
const preferencesSchema=z.object({defaultConnectionMode:z.enum(['lan','connect']).default('lan'),defaultWorkOrder:z.string().max(100).default(''),preferredProfileId:z.string().max(150).default(''),showAdvanced:z.boolean().default(false)}).strict();
export interface Reservation {id:string;actor_id:string;actor_login:string;work_order:string;job_name:string;manifest_hash:string;artifact_hash:string;status:string;revision:number;updated_at:string;request_hash:string;}
export class Ledger {
 constructor(private db:Database,private team:string){}
 async reserve(member:Member,body:unknown){
  const input=claimSchema.parse(body),{manifest,units}=await manufacturingUnits(input.manifest,input.workOrder);
  if(await digest(canonical(input.manifest))!==input.manifestHash)throw new ApiError(400,'Manufacturing manifest checksum mismatch.');
  const requestHash=await digest(canonical(input)),id=await digest(canonical([this.team,member.id,input.idempotencyKey]));
  const previous=await this.db.prepare('SELECT * FROM reservations WHERE id=? AND team_id=?').bind(id,this.team).first<Reservation>();
  if(previous){if(previous.request_hash!==requestHash)throw new ApiError(409,'This request key already refers to different manufacturing inputs.');if(previous.status==='released')throw new ApiError(409,'This reservation was explicitly released. Use a new reviewed attempt.');return this.get(id);}
  const now=new Date().toISOString();
  try{await this.db.batch([
   this.db.prepare('INSERT INTO reservations(id,team_id,actor_id,actor_login,request_key,request_hash,work_order,job_name,manifest_hash,artifact_hash,manifest,unit_snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,this.team,member.id,member.login,input.idempotencyKey,requestHash,input.workOrder,manifest.jobName,input.manifestHash,input.artifactHash,JSON.stringify(input.manifest),JSON.stringify(units),now,now),
   this.db.prepare("INSERT INTO units(team_id,unit_key,reservation_id,part_key,part_name,subsystem,purpose,slot,state) SELECT ?,json_extract(value,'$.unitKey'),?,json_extract(value,'$.partKey'),json_extract(value,'$.partName'),json_extract(value,'$.subsystem'),json_extract(value,'$.purpose'),json_extract(value,'$.slot'),'reserved' FROM json_each(?) WHERE 1 ON CONFLICT(team_id,unit_key) DO UPDATE SET reservation_id=excluded.reservation_id,state='reserved',part_name=excluded.part_name,subsystem=excluded.subsystem WHERE units.state='released'").bind(this.team,id,JSON.stringify(units)),
   this.db.prepare('INSERT INTO reservation_guards(reservation_id,valid) SELECT ?,CASE WHEN (SELECT COUNT(*) FROM units WHERE team_id=? AND reservation_id=?)=? THEN 1 ELSE 0 END').bind(id,this.team,id,units.length),
   this.db.prepare("INSERT INTO events(id,reservation_id,team_id,actor_id,action,note,request_key,request_hash,created_at) VALUES(?,?,?,?, 'reserved','Exact required and backup copies reserved',?,?,?)").bind(crypto.randomUUID(),id,this.team,member.id,'reserve-'+input.idempotencyKey,requestHash,now)
  ]);}catch(error){const concurrent=await this.db.prepare('SELECT * FROM reservations WHERE id=? AND team_id=?').bind(id,this.team).first<Reservation>();if(concurrent?.request_hash===requestHash&&concurrent.status!=='released')return this.get(id);if(concurrent)throw new ApiError(409,'This request key was used for another job.');throw new ApiError(409,'One or more copies are already reserved, handed off or manufactured. Refresh the shared records before making more.');}
  return this.get(id);
 }
 async get(id:string){const row=await this.db.prepare('SELECT id,actor_id,actor_login,work_order,job_name,manifest_hash,artifact_hash,status,revision,created_at,updated_at,unit_snapshot FROM reservations WHERE team_id=? AND id=?').bind(this.team,id).first<Reservation>();if(!row)throw new ApiError(404,'Manufacturing reservation not found.');const units=JSON.parse((row as Reservation&{unit_snapshot:string}).unit_snapshot) as Unit[];const events=(await this.db.prepare('SELECT actor_id,action,note,created_at FROM events WHERE team_id=? AND reservation_id=? ORDER BY created_at').bind(this.team,id).all()).results;return{...row,units,events};}
 async list(){return (await this.db.prepare('SELECT r.id,r.actor_id,r.actor_login,r.work_order,r.job_name,r.manifest_hash,r.artifact_hash,r.status,r.revision,r.created_at,r.updated_at,(SELECT COUNT(*) FROM json_each(r.unit_snapshot) WHERE json_extract(value,\'$.purpose\')=\'required\') required_count,(SELECT COUNT(*) FROM json_each(r.unit_snapshot) WHERE json_extract(value,\'$.purpose\')=\'backup\') backup_count FROM reservations r WHERE r.team_id=? ORDER BY r.updated_at DESC LIMIT 200').bind(this.team).all()).results;}
 async transition(member:Member,id:string,body:unknown){
  const input=z.object({status:z.enum(['handed-off','making','produced','released']),expectedRevision:z.number().int().min(1),idempotencyKey:text,note:z.string().trim().min(3).max(2000),attested:z.boolean()}).strict().parse(body);
  if(!input.attested)throw new ApiError(400,'Explicit operator confirmation is required.');
  const requestHash=await digest(canonical({id,...input}));const old=await this.db.prepare('SELECT request_hash FROM events WHERE team_id=? AND actor_id=? AND request_key=?').bind(this.team,member.id,input.idempotencyKey).first<{request_hash:string}>();if(old){if(old.request_hash!==requestHash)throw new ApiError(409,'This event key already records another action.');return this.get(id);}
  const current=await this.get(id);if(current.actor_id!==member.id)throw new ApiError(403,'Only the reservation owner can change its manufacturing state.');
  const allowed:Record<string,string[]>={reserved:['handed-off','making','released'],'handed-off':['making','produced','released'],making:['produced','released'],produced:[],released:[]};
  if(!allowed[current.status]?.includes(input.status))throw new ApiError(409,'That manufacturing state transition is unavailable.');
  const now=new Date().toISOString();
  try{await this.db.batch([
   this.db.prepare('UPDATE reservations SET status=?,revision=revision+1,updated_at=? WHERE id=? AND team_id=? AND actor_id=? AND revision=?').bind(input.status,now,id,this.team,member.id,input.expectedRevision),
   this.db.prepare('UPDATE reservation_guards SET valid=CASE WHEN changes()=1 THEN 1 ELSE 0 END WHERE reservation_id=?').bind(id),
   this.db.prepare('UPDATE units SET state=? WHERE team_id=? AND reservation_id=?').bind(input.status,this.team,id),
   this.db.prepare('INSERT INTO events(id,reservation_id,team_id,actor_id,action,note,request_key,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,this.team,member.id,input.status,input.note,input.idempotencyKey,requestHash,now)
  ]);}catch{const retry=await this.db.prepare('SELECT request_hash FROM events WHERE team_id=? AND actor_id=? AND request_key=?').bind(this.team,member.id,input.idempotencyKey).first<{request_hash:string}>();if(retry?.request_hash===requestHash)return this.get(id);throw new ApiError(409,'The manufacturing record changed. Refresh it before continuing.');}
  return this.get(id);
 }
 async preferences(member:Member){const row=await this.db.prepare('SELECT revision,data FROM preferences WHERE user_id=?').bind(member.id).first<{revision:number;data:string}>();return row?{revision:row.revision,data:JSON.parse(row.data)}:{revision:0,data:preferencesSchema.parse({})};}
 async savePreferences(member:Member,body:unknown){const input=z.object({expectedRevision:z.number().int().min(0),data:preferencesSchema}).strict().parse(body);const now=new Date().toISOString();const changed=input.expectedRevision===0?await this.db.prepare('INSERT INTO preferences(user_id,revision,data,updated_at) VALUES(?,1,?,?) ON CONFLICT(user_id) DO NOTHING').bind(member.id,JSON.stringify(input.data),now).run():await this.db.prepare('UPDATE preferences SET revision=revision+1,data=?,updated_at=? WHERE user_id=? AND revision=?').bind(JSON.stringify(input.data),now,member.id,input.expectedRevision).run();if(changed.meta.changes!==1)throw new ApiError(409,'Preferences changed on another device. Reload before saving.');return this.preferences(member);}
}
