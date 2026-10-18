import {z} from 'zod';
import {canonicalOnshapeUrl} from '../src/domain/onshape-link';
import {ApiError,type Database,type Member} from './types';
export interface TeamSource {id:string;label:string;source_url:string;work_order:string;actor_id:string;revision:number;updated_at:string;}
export async function listTeamSources(db:Database,team:string){return(await db.prepare('SELECT id,label,source_url,work_order,actor_id,revision,updated_at FROM team_sources WHERE team_id=? ORDER BY updated_at DESC,id LIMIT 100').bind(team).all<TeamSource>()).results;}
export async function saveTeamSource(db:Database,team:string,member:Member,input:unknown){
 const value=z.object({id:z.string().uuid(),label:z.string().trim().min(1).max(100),sourceUrl:z.string().max(4000),workOrder:z.string().trim().min(1).max(100),expectedRevision:z.number().int().min(0)}).strict().parse(input);
 let sourceUrl:string;try{sourceUrl=canonicalOnshapeUrl(value.sourceUrl);}catch{throw new ApiError(400,'Use a complete HTTPS Onshape assembly or Part Studio link.');}
 const order=value.workOrder.toLowerCase().replace(/\s+/g,' '),at=new Date().toISOString();
 if(value.expectedRevision===0){const result=await db.prepare('INSERT INTO team_sources(id,team_id,label,source_url,work_order,actor_id,updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM team_sources WHERE team_id=?)<100 ON CONFLICT(id) DO NOTHING').bind(value.id,team,value.label,sourceUrl,order,member.id,at,team).run();if(result.meta.changes!==1)throw new ApiError(409,'The robot link already exists or this team has reached 100 saved links. Refresh the library.');}
 else{const result=await db.prepare('UPDATE team_sources SET label=?,source_url=?,work_order=?,revision=revision+1,updated_at=? WHERE id=? AND team_id=? AND actor_id=? AND revision=?').bind(value.label,sourceUrl,order,at,value.id,team,member.id,value.expectedRevision).run();if(result.meta.changes!==1)throw new ApiError(409,'This link changed or belongs to another teammate. Refresh before editing.');}
 return await db.prepare('SELECT id,label,source_url,work_order,actor_id,revision,updated_at FROM team_sources WHERE id=? AND team_id=?').bind(value.id,team).first<TeamSource>();
}
