import {z} from 'zod';
export const SNAPSHOT_RAW_LIMIT=24*1024*1024;
export const SNAPSHOT_GZIP_LIMIT=6*1024*1024;
export const SNAPSHOT_CHUNK_SIZE=256*1024;
export const SNAPSHOT_TEAM_LIMIT=20;
export const snapshotHash=z.string().regex(/^[a-f0-9]{64}$/);
const text=z.string().min(1).max(2000);
const info=z.object({id:text,name:text,quantity:z.number().int().min(1).max(1000),classification:z.enum(['make','buy','review']),available:z.boolean(),geometryHash:snapshotHash,dimensions:z.tuple([z.number().positive().finite(),z.number().positive().finite(),z.number().positive().finite()]),sourceKind:z.enum(['onshape','fixture','local']),documentId:text.optional(),versionId:text.optional(),elementId:text.optional(),partId:text.optional(),configuration:z.string().max(2000).optional(),materialHint:z.string().max(2000).optional(),subsystems:z.array(text).max(10000)}).strict();
export const snapshotMetadataSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('imported-parts'),label:z.string().trim().min(1).max(100),workOrder:z.string().trim().min(1).max(100),parts:z.array(info).min(1).max(1000)}).strict().superRefine((value,context)=>{if(new Set(value.parts.map(p=>p.id)).size!==value.parts.length)context.addIssue({code:'custom',message:'A part appears twice in this snapshot.'});});
export type SnapshotMetadata=z.infer<typeof snapshotMetadataSchema>;
export interface SnapshotUpload {metadata:SnapshotMetadata;contentHash:string;payloadHash:string;payload:string;rawBytes:number;shareConfirmed:true;}
export interface SharedSnapshot {id:string;metadata:SnapshotMetadata;contentHash:string;payloadHash:string;compressedBytes:number;rawBytes:number;actorId:string;actorLogin:string;createdAt:string;}
export interface SnapshotDownload extends SharedSnapshot {payload:string;}
