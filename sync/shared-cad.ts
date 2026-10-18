import {z} from 'zod';
import {ApiError,canonical,digest,type Database,type Member} from './types';
import {SNAPSHOT_CHUNK_SIZE,SNAPSHOT_GZIP_LIMIT,SNAPSHOT_RAW_LIMIT,SNAPSHOT_TEAM_LIMIT,snapshotHash,snapshotMetadataSchema,type SharedSnapshot,type SnapshotDownload} from '../src/domain/shared-cad-contract';
interface Row {id:string;actor_id:string;actor_login:string;metadata_json:string;content_hash:string;payload_hash:string;compressed_bytes:number;raw_bytes:number;created_at:string;}
const columns='s.id,s.actor_id,u.login AS actor_login,s.metadata_json,s.content_hash,s.payload_hash,s.compressed_bytes,s.raw_bytes,s.created_at';
const publicRow=(row:Row):SharedSnapshot=>({id:row.id,metadata:snapshotMetadataSchema.parse(JSON.parse(row.metadata_json)),contentHash:row.content_hash,payloadHash:row.payload_hash,compressedBytes:row.compressed_bytes,rawBytes:row.raw_bytes,actorId:row.actor_id,actorLogin:row.actor_login,createdAt:row.created_at});
export async function listSharedCad(db:Database,team:string){const rows=await db.prepare(`SELECT ${columns} FROM cad_snapshots s JOIN users u ON u.id=s.actor_id WHERE s.team_id=? ORDER BY s.created_at DESC,s.id LIMIT ?`).bind(team,SNAPSHOT_TEAM_LIMIT).all<Row>();return rows.results.map(publicRow);}
export async function readSharedCad(db:Database,team:string,id:string):Promise<SnapshotDownload>{
 snapshotHash.parse(id);const row=await db.prepare(`SELECT ${columns} FROM cad_snapshots s JOIN users u ON u.id=s.actor_id WHERE s.team_id=? AND s.id=?`).bind(team,id).first<Row>();if(!row)throw new ApiError(404,'This shared CAD snapshot was removed or is not available to this workspace.');
 const chunks=await db.prepare('SELECT sequence,payload FROM cad_snapshot_chunks WHERE snapshot_id=? ORDER BY sequence').bind(id).all<{sequence:number;payload:string}>();
 if(!chunks.results.length||chunks.results.some((chunk,index)=>chunk.sequence!==index))throw new ApiError(503,'Shared CAD storage is incomplete. No parts were accepted.');
 return {...publicRow(row),payload:chunks.results.map(chunk=>chunk.payload).join('')};
}
export async function publishSharedCad(db:Database,team:string,member:Member,input:unknown){
 const body=z.object({metadata:snapshotMetadataSchema,contentHash:snapshotHash,payloadHash:snapshotHash,payload:z.string().min(4).max(Math.ceil(SNAPSHOT_GZIP_LIMIT/3)*4).regex(/^[A-Za-z0-9+/]+={0,2}$/),rawBytes:z.number().int().min(1).max(SNAPSHOT_RAW_LIMIT),shareConfirmed:z.literal(true)}).strict().parse(input);
 const metadata=canonical(body.metadata);if(new TextEncoder().encode(metadata).length>512*1024)throw new ApiError(413,'Part catalog metadata is too large. Share a smaller subsystem.');
 let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(body.payload),c=>c.charCodeAt(0));}catch{throw new ApiError(400,'Invalid CAD archive encoding.');}
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),n=>n.toString(16).padStart(2,'0')).join('');
 if(bytes.length>SNAPSHOT_GZIP_LIMIT||bytes.length<2||bytes[0]!==31||bytes[1]!==139||hash!==body.payloadHash)throw new ApiError(400,'CAD archive checksum or gzip format is invalid.');
 const id=await digest(canonical({team,metadata:body.metadata,contentHash:body.contentHash,payloadHash:body.payloadHash}));
 // One atomic transaction. An exhausted team limit inserts neither the catalog
 // nor chunks. Retries cannot overwrite an immutable snapshot or consume slots.
 const statements=[db.prepare('INSERT INTO cad_snapshots(id,team_id,actor_id,metadata_json,content_hash,payload_hash,compressed_bytes,raw_bytes,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM cad_snapshots WHERE team_id=?)<? ON CONFLICT(id) DO NOTHING').bind(id,team,member.id,metadata,body.contentHash,body.payloadHash,bytes.length,body.rawBytes,new Date().toISOString(),team,SNAPSHOT_TEAM_LIMIT)];
 for(let offset=0,sequence=0;offset<body.payload.length;offset+=SNAPSHOT_CHUNK_SIZE,sequence++)statements.push(db.prepare('INSERT INTO cad_snapshot_chunks(snapshot_id,sequence,payload) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM cad_snapshots WHERE id=? AND team_id=?) ON CONFLICT(snapshot_id,sequence) DO NOTHING').bind(id,sequence,body.payload.slice(offset,offset+SNAPSHOT_CHUNK_SIZE),id,team));
 await db.batch(statements);
 const row=await db.prepare(`SELECT ${columns} FROM cad_snapshots s JOIN users u ON u.id=s.actor_id WHERE s.team_id=? AND s.id=?`).bind(team,id).first<Row>();if(!row)throw new ApiError(409,'The shared library has 20 snapshots. The owner can remove an older snapshot, or share a smaller subsystem.');return publicRow(row);
}
export async function removeSharedCad(db:Database,team:string,member:Member,id:string){snapshotHash.parse(id);const removed=await db.prepare('DELETE FROM cad_snapshots WHERE id=? AND team_id=? AND actor_id=? RETURNING id').bind(id,team,member.id).first<{id:string}>();if(removed?.id!==id)throw new ApiError(409,'Only the uploader can remove this shared snapshot. It may already have been removed.');return {removed:true};}
