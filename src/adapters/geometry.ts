import type { GeometryAsset, InputUnits, Vec3 } from '../domain/model';

/** Unitless STL always requires an explicit declaration by its importer. */
export const MAX_STL_BYTES = 20 * 1024 * 1024;
export const MAX_STL_TRIANGLES = 250_000;
export class GeometryImportError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'GeometryImportError'; }
}
export interface GeometryImportOptions { name?: string; expectedDimensions?: Vec3; maxBytes?: number; }
const encoder = new TextEncoder();
export async function geometrySHA256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : Uint8Array.from(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let at = 0; at < bytes.length; at += 8192) result += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(result);
}
export function base64ToBytes(data: string): Uint8Array { return Uint8Array.from(atob(data), c => c.charCodeAt(0)); }
const numeric = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const facetPattern = new RegExp(`facet\\s+normal\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+outer\\s+loop\\s+vertex\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+vertex\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+vertex\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+endloop\\s+endfacet`, 'gi');

/** Parse genuine ASCII/binary STL; preserve bytes, never repair, split, infer units, or fit to a plate. */
export async function parseSTL(input: string | ArrayBuffer | Uint8Array, units: InputUnits, options: GeometryImportOptions = {}): Promise<GeometryAsset> {
  if (units !== 'mm' && units !== 'in') throw new GeometryImportError('UNITS_REQUIRED', 'STL has no unit metadata. Declare millimetres or inches.');
  const bytes = typeof input === 'string' ? encoder.encode(input) : input instanceof Uint8Array ? Uint8Array.from(input) : new Uint8Array(input);
  if (bytes.byteLength > (options.maxBytes ?? MAX_STL_BYTES)) throw new GeometryImportError('TOO_LARGE', 'STL exceeds the 20 MiB import limit. Export a coarser mesh explicitly in CAD.');
  if (!bytes.length) throw new GeometryImportError('EMPTY', 'The STL file is empty.');
  const vertices: number[] = [];
  let binary = false;
  if (bytes.length >= 84) {
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    binary = count > 0 && bytes.length === 84 + count * 50;
    if (binary) {
      if (count > MAX_STL_TRIANGLES) throw new GeometryImportError('TOO_COMPLEX', 'STL exceeds 250,000 triangles. Export a coarser mesh explicitly in CAD.');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let triangle = 0; triangle < count; triangle++) for (let coordinate = 0; coordinate < 9; coordinate++) vertices.push(view.getFloat32(84 + triangle * 50 + 12 + coordinate * 4, true));
    }
  }
  if (!binary) {
    let ascii: string;
    try { ascii = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); }
    catch { throw new GeometryImportError('INVALID_STL', 'Invalid or truncated binary STL. Expected 84 header bytes plus 50 bytes per triangle.'); }
    const begin = /^solid(?:[^\r\n]*)[\r\n]+/i.exec(ascii);
    const end = /(?:^|[\r\n])\s*endsolid[^\r\n]*\s*$/i.exec(ascii);
    if (!begin || !end || end.index < begin[0].length) throw new GeometryImportError('INVALID_STL', 'Expected a complete ASCII or binary STL file. STEP, OBJ and 3MF are not supported for local geometry import yet.');
    let body = ascii.slice(begin[0].length, end.index);
    let previous = 0;
    for (const match of body.matchAll(facetPattern)) {
      if (body.slice(previous, match.index).trim()) throw new GeometryImportError('INVALID_STL', 'Unrecognised or non-finite data in STL triangle definitions.');
      vertices.push(...match.slice(4, 13).map(Number));
      previous = match.index! + match[0].length;
      if (vertices.length / 9 > MAX_STL_TRIANGLES) throw new GeometryImportError('TOO_COMPLEX', 'STL exceeds 250,000 triangles.');
    }
    if (body.slice(previous).trim()) throw new GeometryImportError('INVALID_STL', 'Incomplete or invalid STL triangles. Geometry was not repaired.');
  }
  if (!vertices.length) throw new GeometryImportError('EMPTY_MESH', 'STL contains no triangles.');
  if (vertices.some(n => !Number.isFinite(n))) throw new GeometryImportError('NON_FINITE', 'STL contains NaN or infinite coordinates. Geometry was not repaired.');
  const scale = units === 'in' ? 25.4 : 1;
  for (let i = 0; i < vertices.length; i++) vertices[i] *= scale;
  const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) { const axis = i % 3; low[axis] = Math.min(low[axis], vertices[i]); high[axis] = Math.max(high[axis], vertices[i]); }
  const dimensions = high.map((n, axis) => n - low[axis]) as Vec3;
  if (dimensions.some(n => n <= 1e-7)) throw new GeometryImportError('NO_VOLUME', 'STL has zero extent on an axis. A manufacturing solid is required.');
  if (dimensions.some(n => n > 100_000)) throw new GeometryImportError('DIMENSION_RANGE', 'Imported geometry exceeds 100 metres. Check the declared units; no automatic scaling was applied.');
  if (options.expectedDimensions) validateDimensions(dimensions, options.expectedDimensions);
  const lines = ['solid catalyst_mm'];
  const edges = new Map<string, number>();
  const vertexKey = (at: number) => vertices.slice(at, at + 3).map(n => n.toFixed(5)).join(',');
  for (let i = 0; i < vertices.length; i += 9) {
    const ax = vertices[i + 3] - vertices[i], ay = vertices[i + 4] - vertices[i + 1], az = vertices[i + 5] - vertices[i + 2];
    const bx = vertices[i + 6] - vertices[i], by = vertices[i + 7] - vertices[i + 1], bz = vertices[i + 8] - vertices[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const length = Math.hypot(nx, ny, nz);
    if (length <= 1e-12) throw new GeometryImportError('DEGENERATE_TRIANGLE', 'STL contains a zero-area triangle. Re-export valid geometry; no triangle was removed.');
    nx /= length; ny /= length; nz /= length;
    lines.push(` facet normal ${nx} ${ny} ${nz}`, '  outer loop');
    for (let v = 0; v < 3; v++) lines.push(`   vertex ${vertices[i + v * 3]} ${vertices[i + v * 3 + 1]} ${vertices[i + v * 3 + 2]}`);
    lines.push('  endloop', ' endfacet');
    for (const [a, b] of [[i, i + 3], [i + 3, i + 6], [i + 6, i]]) { const edge = [vertexKey(a), vertexKey(b)].sort().join('|'); edges.set(edge, (edges.get(edge) ?? 0) + 1); }
  }
  lines.push('endsolid catalyst_mm', '');
  const stl = lines.join('\n');
  const warnings = [...edges.values()].some(count => count !== 2) ? ['Mesh has open or non-manifold edges. No repairs were applied; review in CAD before manufacturing.'] : [];
  return { stl, hash: await geometrySHA256(stl), dimensions, units: 'mm', vertices,
    original: { name: options.name ?? 'import.stl', data: bytesToBase64(bytes), hash: await geometrySHA256(bytes), encoding: 'base64', units, format: 'stl' }, warnings };
}
export function validateDimensions(actual: Vec3, expected: Vec3): void {
  if (expected.some(n => !Number.isFinite(n) || n <= 0)) throw new GeometryImportError('INVALID_EXPECTATION', 'Expected dimensions must be positive finite millimetres.');
  const differs = actual.some((n, i) => Math.abs(n - expected[i]) > Math.max(0.05, expected[i] * 0.005));
  if (!differs) return;
  const unitFactor = [25.4, 1 / 25.4].find(scale => actual.every((n, i) => Math.abs(n * scale - expected[i]) <= Math.max(0.05, expected[i] * 0.005)));
  throw new GeometryImportError(unitFactor ? 'UNIT_MISMATCH' : 'DIMENSION_MISMATCH', unitFactor
    ? 'Imported dimensions differ by an inch/mm factor of 25.4. Check export units; geometry was not automatically rescaled.'
    : `Imported dimensions ${actual.map(n => n.toFixed(2)).join(' × ')} mm do not match CAD dimensions ${expected.join(' × ')} mm. Review the source and export settings.`);
}
