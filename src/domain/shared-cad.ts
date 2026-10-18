import type {Part} from './model';
import {createProject} from './model';
import {projectSchema,validateGeometryAsset} from './persistence';
import {addRobotDrafts} from './robot-plan';
import {canonical} from '../../sync/types';
import {SNAPSHOT_GZIP_LIMIT,SNAPSHOT_RAW_LIMIT,snapshotMetadataSchema,type SnapshotMetadata,type SnapshotUpload,type SnapshotDownload} from './shared-cad-contract';
export interface CadSnapshot {schemaVersion:1;scope:'imported-parts';label:string;workOrder:string;parts:Part[];}
export function snapshotMetadata(value:CadSnapshot):SnapshotMetadata{return snapshotMetadataSchema.parse({schemaVersion:1,scope:'imported-parts',label:value.label,workOrder:value.workOrder,parts:value.parts.map(part=>({id:part.id,name:part.name,quantity:part.quantity,classification:part.classification,available:part.source.available!==false,geometryHash:part.geometry.hash,dimensions:part.geometry.dimensions,sourceKind:part.source.kind,documentId:part.source.documentId,versionId:part.source.versionId,elementId:part.source.elementId,partId:part.source.partId,configuration:part.source.configuration,materialHint:part.materialHint,subsystems:[...new Set((part.source.assemblyMemberships??[]).map(m=>m.names.join(' / ')))]}))});}
async function validate(value:CadSnapshot){
 value.parts=projectSchema.shape.parts.parse(value.parts).map(part=>{const {status,notes,...catalog}=part;return {...catalog,spareQuantity:0};});
 const metadata=snapshotMetadata(value);value.label=metadata.label;value.workOrder=metadata.workOrder;
 for(const part of value.parts){if(part.source.kind==='onshape'&&(![part.source.documentId,part.source.versionId,part.source.elementId].every(v=>typeof v==='string'&&/^[a-f\d]{24}$/i.test(v))||!part.source.partId||typeof part.source.configuration!=='string'))throw new Error('Shared Onshape parts require an exact immutable source and configuration.');await validateGeometryAsset(part.geometry,part.name);}
 return value;
}
export async function boundedStream(stream:ReadableStream<Uint8Array>,limit:number){const reader=stream.getReader(),chunks:Uint8Array[]=[];let length=0;try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>limit)throw new Error('Shared CAD exceeds its size limit. Split the robot into subsystem snapshots.');chunks.push(next.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;}
const base64=(bytes:Uint8Array)=>{let result='';for(let index=0;index<bytes.length;index+=32768)result+=String.fromCharCode(...bytes.subarray(index,index+32768));return btoa(result);};
const sha=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),n=>n.toString(16).padStart(2,'0')).join('');
export async function encodeSharedCad(parts:readonly Part[],label:string,workOrder:string,shareConfirmed:boolean):Promise<SnapshotUpload>{
 if(shareConfirmed!==true)throw new Error('Confirm permission to share this CAD with the current workspace before uploading.');
 // Catalogs contain source geometry only. No jobs, approvals, machine checks,
 // loaded material claims or toolpaths are shared. Backups are chosen per job.
 const snapshot:CadSnapshot={schemaVersion:1,scope:'imported-parts',label,workOrder,parts:parts.map(part=>{const {vertices,...geometry}=part.geometry;return {id:part.id,name:part.name,source:part.source,quantity:part.quantity,spareQuantity:0,category:part.category,classification:part.classification,materialHint:part.materialHint,colorHint:part.colorHint,geometry};})};
 await validate(snapshot);const bytes=new TextEncoder().encode(canonical(snapshot));if(bytes.length>SNAPSHOT_RAW_LIMIT)throw new Error('Imported CAD exceeds 24 MiB. Share one subsystem at a time.');
 const compressed=await boundedStream(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),SNAPSHOT_GZIP_LIMIT);
 return {metadata:snapshotMetadata(snapshot),contentHash:await sha(bytes),payloadHash:await sha(compressed),payload:base64(compressed),rawBytes:bytes.length,shareConfirmed:true};
}
export async function decodeSharedCad(record:SnapshotDownload):Promise<CadSnapshot>{
 const metadata=snapshotMetadataSchema.parse(record.metadata);
 if(record.payload.length>Math.ceil(SNAPSHOT_GZIP_LIMIT/3)*4)throw new Error('Shared CAD download exceeds the size limit.');
 let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(record.payload),c=>c.charCodeAt(0));}catch{throw new Error('Invalid shared CAD encoding.');}
 if(bytes.length!==record.compressedBytes||await sha(bytes)!==record.payloadHash)throw new Error('Shared CAD archive checksum mismatch.');
 const decoded=await boundedStream(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),SNAPSHOT_RAW_LIMIT);
 if(decoded.length!==record.rawBytes||await sha(decoded)!==record.contentHash)throw new Error('Shared CAD content checksum mismatch.');
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded)) as CadSnapshot;
 if(value.schemaVersion!==1||value.scope!=='imported-parts')throw new Error('Unsupported shared CAD format.');
 await validate(value);if(canonical(snapshotMetadata(value))!==canonical(metadata))throw new Error('Shared CAD does not match the published part catalog.');return value;
}
export function chooseSnapshotParts(value:CadSnapshot,ids:readonly string[]):Part[]{if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!value.parts.some(p=>p.id===id)))throw new Error('Choose available part types from this exact snapshot.');return value.parts.filter(part=>ids.includes(part.id)).map(part=>({...structuredClone(part),classification:part.classification==='buy'?'buy':'make',spareQuantity:0}));}
export function snapshotProject(value:CadSnapshot,ids:readonly string[]){const project=createProject(value.label);project.manufacturingOrder=value.workOrder;addRobotDrafts(project,chooseSnapshotParts(value,ids));return project;}
