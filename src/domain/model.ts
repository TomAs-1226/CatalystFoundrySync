/** Immutable source and manufacturing records. All manufacturing coordinates use millimetres. */
export type Vec3 = [number, number, number];
export type InputUnits = 'mm' | 'in';
export type PartCategory = 'bracket' | 'enclosure' | 'spacer' | 'pulley' | 'custom';
export type Classification = 'make' | 'buy' | 'review';
export interface GeometryAsset {
  stl: string;
  hash: string;
  dimensions: Vec3;
  units: 'mm';
  original?: { name: string; data: string; hash?: string; units: InputUnits; format: 'stl'; encoding?: 'text' | 'base64' };
  vertices?: number[];
  warnings?: string[];
}
export interface SourceOccurrence { path: string[]; transform: number[]; }
export interface AssemblyMembership { path:string[]; names:string[]; quantity:number; }
export interface SourceRef {
  kind: 'fixture' | 'onshape' | 'local';
  documentId?: string; documentName?: string; elementId?: string; elementName?: string;
  versionId?: string; versionName?: string; configuration?: string; url?: string;
  revision?: string; occurrences?: SourceOccurrence[]; linkedDocumentId?: string;
  available?: boolean; partId?: string; microversionId?: string;
  installedTransformUnits?: 'm' | 'mm'; elementType?: 'assembly' | 'partstudio'; originDocumentId?: string;
  /** Exact selected assembly/studio context; child source versions may differ in linked documents. */
  originVersionId?: string; originElementId?: string; originConfiguration?: string;
  originElementName?:string; assemblyScope?:string[]; assemblyMemberships?:AssemblyMembership[];
}
export interface Part {
  id: string; name: string; geometry: GeometryAsset; source: SourceRef;
  quantity: number; spareQuantity: number; category: PartCategory;
  classification: Classification; materialHint?: string; colorHint?: string;
  notes?: string; status?: string;
}
export interface PrinterProfile {
  id: string; model: string; nozzleDiameter: number; plate: string; buildVolume: Vec3; tested: boolean;
  nozzleCount?:number; activeNozzle?:'primary';
}
export interface MaterialProfile { id: string; name: string; type: string; color: string; tested: boolean; }
export interface ProcessSettings {
  layerHeight: number; walls: number; infill: number; supports: boolean; brimWidth: number;
  speed: number; [key: string]: number | string | boolean;
}
export interface SlicerIdentity { id: string; version: string; profileBundleHash?: string; }
export interface Profile {
  id: string; name: string; category: PartCategory; printer: PrinterProfile;
  material: MaterialProfile; settings: ProcessSettings; tested: boolean;
}
export interface JobItem {
  partId: string; quantity: number; spareQuantity: number;
  orientation: Vec3; position: Vec3;
}
export interface UseCase {
  purpose: string; loadDirection: string; constraints: string; operatingConditions: string; confirmed: boolean;
}
export type JobStatus = 'draft' | 'needs review' | 'ready to slice' | 'sliced' | 'approved' | 'assigned' | 'printing' | 'completed';
export interface SlicerProjectArtifact { name: string; data: string; hash: string; encoding: 'base64'; format: '3mf'; }
export interface ToolpathArtifact {
  id: string; name: string; gcode: string; hash: string; manifestHash: string;
  source: 'imported' | 'bambu' | 'fixture'; slicer: SlicerIdentity;
  slicerProject?: SlicerProjectArtifact;
  createdAt: string; warnings: string[]; mappingConfirmed: boolean;
  reviewedAt?: string; reviewedBy?: string; reviewedManifestHash?: string; stale?: boolean;
}
export interface Approval {
  id: string; actor: string; at: string; manifestHash: string; toolpathHash: string;
  demonstrationOnly: boolean;
}
export interface ReviewEvent { id: string; at: string; actor: string; action: string; detail: string; manifestHash?:string; toolpathHash?:string; releaseId?:string; }
export interface ReleaseRecord {
  id: string; idempotencyKey: string; at: string; actor: string; manifestHash: string;
  toolpathHash: string; demonstrationOnly: boolean;
}
export interface OperatorChecks {
  machine: boolean; material: boolean; nozzle: boolean; plate: boolean; clearBed: boolean;
}
export interface Job {
  id: string; name: string; items: JobItem[]; printer: PrinterProfile; material: MaterialProfile;
  settings: ProcessSettings; baseSettings: ProcessSettings; slicer: SlicerIdentity;
  useCase: UseCase; status: JobStatus; toolpath?: ToolpathArtifact; approval?: Approval;
  reviews: ReviewEvent[]; releases: ReleaseRecord[]; assignee?: string;
  operatorChecks?: OperatorChecks; createdAt: string; updatedAt: string;
}
export interface Project {
  schemaVersion: 1; id: string; name: string; parts: Part[]; jobs: Job[]; manufacturingOrder?:string;
  activeJobId: string; teamPresets: Profile[]; createdAt: string; updatedAt: string;
}
export interface ManufacturingManifest {
  schemaVersion: 1; jobId: string; jobName: string; units: 'mm'; layoutVersion: 'grid-v1';
  orientationConvention: 'Euler XYZ degrees'; placementConvention: 'source bounding-box XY centre, rotated minimum Z';
  parts: { partId: string; name: string; source: SourceRef; geometryHash: string; originalHash?: string; geometryWarnings: string[]; classification: Classification; geometryFile: string; originalFile?: string; dimensions: Vec3;
    quantity: number; spareQuantity: number; totalQuantity: number; orientation: Vec3; position: Vec3;
    instances: {index:number;orientation:Vec3;position:Vec3}[] }[];
  printer: PrinterProfile; material: MaterialProfile; settings: ProcessSettings;
  slicer: SlicerIdentity; useCase: UseCase; toolpathHash?: string;
  toolpath?: Omit<ToolpathArtifact, 'gcode' | 'stale' | 'slicerProject'> & {slicerProject?:Omit<SlicerProjectArtifact,'data'>};
}
export const defaultPrinter: PrinterProfile = {
  id: 'example-bambu-256', model: 'Bambu Lab 256 mm family · example', nozzleDiameter: 0.4,
  plate: 'Textured PEI · example', buildVolume: [256, 256, 256], tested: false,
};
export const defaultMaterial: MaterialProfile = {
  id: 'example-petg', name: 'Generic PETG · example', type: 'PETG', color: '#d9d9d9', tested: false,
};
export const defaultSettings: ProcessSettings = { layerHeight: 0.2, walls: 4, infill: 30, supports: false, brimWidth: 3, speed: 100 };
export function createId(): string { return crypto.randomUUID(); }
export function createJob(parts: Part[] = [], name = 'Untitled manufacturing job'): Job {
  const at = new Date().toISOString();
  return { id: createId(), name, items: parts.filter(p => p.classification === 'make').map((p,i) => ({
    partId: p.id, quantity: p.quantity, spareQuantity: p.spareQuantity, orientation: [0,0,0], position: [35 + i * 65, 45, 0],
  })), printer: structuredClone(defaultPrinter), material: structuredClone(defaultMaterial),
  settings: { ...defaultSettings }, baseSettings: { ...defaultSettings }, slicer: { id: 'external-import', version: 'operator-declared' },
  useCase: { purpose: '', loadDirection: '', constraints: '', operatingConditions: '', confirmed: false },
  status: parts.length ? 'needs review' : 'draft', reviews: [], releases: [], createdAt: at, updatedAt: at };
}
export function createProject(name = 'Catalyst robot · manufacturing'): Project {
  const at = new Date().toISOString(); const job = createJob();
  return { schemaVersion: 1, id: createId(), name, parts: [], jobs: [job], activeJobId: job.id, teamPresets: [], createdAt: at, updatedAt: at };
}
