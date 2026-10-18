import {ApiError,type Database} from './types';

// Conservative ceiling starting after the operator-reported 663/2500 snapshot.
// Counts every attempted read and redirect, including failures. It is NOT the
// provider's authoritative annual balance; other apps can consume that balance.
export const ONSHAPE_REQUEST_CAP=1000;
const key='private-app-reserve-2026-10-18';
export async function onshapeBudget(db:Database){
 const row=await db.prepare('SELECT attempts FROM onshape_budget WHERE id=?').bind(key).first<{attempts:number}>();
 return {attempts:row?.attempts??0,cap:ONSHAPE_REQUEST_CAP,remaining:Math.max(0,ONSHAPE_REQUEST_CAP-(row?.attempts??0)),reportedBaseline:663,reportedAllocation:2500,authoritative:false,automaticReset:false};
}
export async function chargeOnshapeAttempt(db:Database){
 const row=await db.prepare('INSERT INTO onshape_budget(id,attempts) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1 WHERE attempts<? RETURNING attempts').bind(key,ONSHAPE_REQUEST_CAP).first<{attempts:number}>();
 if(!row)throw new ApiError(409,'Foundry paused new Onshape requests to preserve the shared API reserve. Saved projects still slice offline. An administrator must check Onshape usage before increasing the cap.');
}
