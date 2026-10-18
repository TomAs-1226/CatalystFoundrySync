import type { GeometryAsset } from './model';
import { geometrySHA256, parseSTL } from '../adapters/geometry';

/** Verify both the exported mesh and exact preserved input. Never repair, infer units or rescale. */
export async function validateGeometryIntegrity(asset:GeometryAsset,name='Geometry',recoverLegacyOriginalHash=false):Promise<void> {
  if(asset.units!=='mm')throw new Error(`${name}: normalized geometry units must be millimetres.`);
  if(await geometrySHA256(asset.stl)!==asset.hash)throw new Error(`${name}: geometry hash checksum mismatch.`);
  if(asset.dimensions.length!==3||asset.dimensions.some(n=>!Number.isFinite(n)||n<=0||n>100000))throw new Error(`${name}: invalid source dimensions.`);
  if(asset.original){
    const original=asset.original;let bytes:Uint8Array;
    try{bytes=original.encoding==='base64'?Uint8Array.from(atob(original.data),c=>c.charCodeAt(0)):new TextEncoder().encode(original.data);}
    catch{throw new Error(`${name}: preserved original bytes are not valid base64.`);}
    const originalHash=await geometrySHA256(bytes);
    if(original.hash&&original.hash!==originalHash)throw new Error(`${name}: preserved original checksum mismatch.`);
    let parsed:GeometryAsset;
    try{parsed=await parseSTL(bytes,original.units,{name:original.name,expectedDimensions:asset.dimensions});}
    catch(error){throw new Error(`${name}: preserved original geometry is invalid: ${(error as Error).message}`);}
    if(parsed.hash!==asset.hash)throw new Error(`${name}: preserved original does not produce the recorded source geometry with its declared units.`);
    if(!original.hash){
      if(!recoverLegacyOriginalHash)throw new Error(`${name}: original input checksum is missing. Reimport the source or reopen the project for a verified migration.`);
      original.hash=originalHash;
    }
  }else{
    try{await parseSTL(asset.stl,'mm',{expectedDimensions:asset.dimensions});}
    catch(error){throw new Error(`${name}: invalid normalized geometry: ${(error as Error).message}`);}
  }
}
