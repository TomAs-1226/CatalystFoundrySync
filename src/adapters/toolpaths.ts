/** A bounded, conservative viewer for the documented linear G-code subset. It never executes G-code. */
export type ToolpathFeature = 'wall' | 'infill' | 'support' | 'travel' | 'other';
export type ToolpathPoint = [number, number, number];
export interface ToolpathSegment {
  from: ToolpathPoint;
  to: ToolpathPoint;
  feature: ToolpathFeature;
  layer: number;
  extrusionMm: number;
  line: number;
  feedrateMmMin: number;
}
export interface ToolpathLayer { index: number; z: number; startSegment: number; endSegment: number }
export interface ToolpathPreview {
  segments: ToolpathSegment[];
  layers: ToolpathLayer[];
  warnings: string[];
  blockingIssues: string[];
  unsupportedCommands: string[];
  /** Parser completeness only. Does not attest that an imported file matches CAD or settings. */
  canApprove: boolean;
  units: 'mm';
  sourceUnits: ('mm' | 'inch')[];
  bounds: { min: ToolpathPoint; max: ToolpathPoint };
  extrusionMm: number;
  lineCount: number;
  isDemonstration: boolean;
}
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SEGMENTS = 250_000;
const IGNORABLE = new Set(['G4', 'M0', 'M1', 'M17', 'M18', 'M73', 'M84', 'M104', 'M105', 'M106', 'M107', 'M109', 'M117', 'M140', 'M190', 'M201', 'M203', 'M204', 'M205', 'M220', 'M221', 'M400', 'M900']);
function featureFromComment(comment: string): ToolpathFeature | undefined {
  const match = comment.match(/(?:TYPE|FEATURE)\s*:\s*(.+)/i);
  if (!match) return undefined;
  const name = match[1].trim().toLowerCase();
  if (/support/.test(name)) return 'support';
  if (/wall|perimeter/.test(name)) return 'wall';
  if (/infill|fill|skin|top surface|bottom surface|bridge/.test(name)) return 'infill';
  if (/travel/.test(name)) return 'travel';
  return 'other';
}
export function parseGcode(text: string, options: { maxBytes?: number; maxSegments?: number } = {}): ToolpathPreview {
  const maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const maxSegments = Math.min(options.maxSegments ?? MAX_SEGMENTS, MAX_SEGMENTS);
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`Toolpath exceeds the ${Math.round(maxBytes / 1024)} KiB import limit.`);
  if (!text.trim() || text.includes('\0')) throw new Error('Import a nonempty text G-code file. Binary toolpaths are unsupported.');
  const segments: ToolpathSegment[] = [];
  const layers: ToolpathLayer[] = [];
  const warnings = new Set<string>();
  const blocking = new Set<string>();
  const unsupported = new Set<string>();
  const sourceUnits = new Set<'mm' | 'inch'>();
  let unit = 1;
  let unitsDeclared = false;
  let extrusionModeDeclared = false;
  let absoluteXYZ = true;
  let absoluteE = true;
  let position: ToolpathPoint = [0, 0, 0];
  let offset: ToolpathPoint = [0, 0, 0];
  let e = 0;
  let feedrate = 0;
  let extrusionMm = 0;
  let currentFeature: ToolpathFeature = 'other';
  const lines = text.replace(/\r/g, '').split('\n');
  const issue = (message: string) => { warnings.add(message); blocking.add(message); };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const original = lines[lineIndex];
    // Full semicolon comments are non-executable metadata (Bambu embeds full start scripts).
    // The entire input is still byte-bounded. Never relax the limit for executable lines.
    const fullComment=/^\s*;/.test(original);
    if (original.length > 16_384 && !fullComment) throw new Error(`Line ${lineIndex + 1} is too long.`);
    const comment = original.includes(';') ? original.slice(original.indexOf(';') + 1) : '';
    const feature = featureFromComment(comment);
    if (feature) currentFeature = feature;
    let code = original.split(';')[0].replace(/\([^)]*\)/g, '').trim();
    code = code.replace(/^N\d+\s*/i, '').replace(/\*\d+\s*$/, '').trim();
    if (!code || code === '%') continue;
    const commandMatch = code.match(/^([GMT])\s*(\d+(?:\.\d+)?)/i);
    if (!commandMatch) { issue(`Unrecognized syntax at line ${lineIndex + 1}; preview is incomplete.`); continue; }
    const command = commandMatch[1].toUpperCase() + Number(commandMatch[2]);
    const tail = code.slice(commandMatch[0].length);
    // Unsupported dialect commands remain blocking; their proprietary argument grammar is
    // never mistaken for our supported numeric movement grammar (for example M970.3 Q0 ... Q0).
    const understood = ['G0','G1','G20','G21','G90','G91','G92','M82','M83','G28'].includes(command) || IGNORABLE.has(command);
    if(!understood){unsupported.add(command);issue(`Unsupported command ${command}; preview is incomplete and approval is blocked.`);continue;}
    if (/[GM]\s*\d/i.test(tail)) { issue(`Multiple commands on line ${lineIndex + 1} are unsupported.`); continue; }
    // Free text in M117 display messages is not interpreted as coordinates.
    const values: Record<string, number> = {};
    if (command !== 'M117') {
      const tokens = [...tail.matchAll(/([A-Z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/gi)];
      const residue = tail.replace(/([A-Z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/gi, '').trim();
      if (residue) { issue(`Unsupported parameters at line ${lineIndex + 1}; preview is incomplete.`); continue; }
      for (const token of tokens) {
        const key = token[1].toUpperCase();
        const value = Number(token[2]);
        if (!Number.isFinite(value) || Math.abs(value) > 1e9) throw new Error(`Invalid numeric value at line ${lineIndex + 1}.`);
        if (key in values) throw new Error(`Duplicate ${key} parameter at line ${lineIndex + 1}.`);
        values[key] = value;
      }
    }
    if (command === 'G20' || command === 'G21') {
      unit = command === 'G20' ? 25.4 : 1;
      sourceUnits.add(command === 'G20' ? 'inch' : 'mm'); unitsDeclared = true; continue;
    }
    if (command === 'G90') { absoluteXYZ = true; continue; }
    if (command === 'G91') { absoluteXYZ = false; continue; }
    if (command === 'M82' || command === 'M83') { absoluteE = command === 'M82'; extrusionModeDeclared = true; continue; }
    if (command === 'G92') {
      for (const [index, axis] of ['X', 'Y', 'Z'].entries()) if (axis in values) offset[index] = position[index] - values[axis] * unit;
      if ('E' in values) e = values.E * unit;
      continue;
    }
    if (command === 'G28') {
      // Homing cannot be positioned accurately without verified machine coordinates.
      issue('G28 homing has machine-dependent coordinates. Verify the full path in the target slicer.');
      continue;
    }
    if (command !== 'G0' && command !== 'G1') {
      if (IGNORABLE.has(command)) {
        if (!['G4', 'M73', 'M117'].includes(command)) warnings.add('Machine controls, temperatures, acceleration and flow overrides are not simulated.');
      } else {
        unsupported.add(command);
        issue(`Unsupported command ${command}; preview is incomplete and approval is blocked.`);
      }
      continue;
    }
    if (!unitsDeclared) issue('Motion precedes an explicit G20/G21 unit declaration; approval is blocked.');
    const unfamiliar = Object.keys(values).filter(key => !['X', 'Y', 'Z', 'E', 'F'].includes(key));
    if (unfamiliar.length) issue(`Unsupported motion parameters ${unfamiliar.join(', ')} at line ${lineIndex + 1}.`);
    if ('E' in values && !extrusionModeDeclared) issue('Extrusion precedes an explicit M82/M83 declaration; approval is blocked.');
    const next = [...position] as ToolpathPoint;
    for (const [index, axis] of ['X', 'Y', 'Z'].entries()) {
      if (axis in values) next[index] = absoluteXYZ ? values[axis] * unit + offset[index] : position[index] + values[axis] * unit;
      if (Math.abs(next[index]) > 100_000) throw new Error(`Coordinate outside preview limits at line ${lineIndex + 1}. Check units.`);
    }
    if ('F' in values) { feedrate = values.F * unit; if (feedrate < 0) throw new Error(`Negative feedrate at line ${lineIndex + 1}.`); }
    const deltaE = 'E' in values ? absoluteE ? values.E * unit - e : values.E * unit : 0;
    if ('E' in values) e = absoluteE ? values.E * unit : e + values.E * unit;
    const distance = Math.hypot(...next.map((value, i) => value - position[i]));
    if (distance > 1e-8) {
      const extruding = deltaE > 1e-8;
      if (extruding) {
        extrusionMm += deltaE;
        const priorLayer = layers.at(-1);
        if (!priorLayer || Math.abs(priorLayer.z - next[2]) > 0.0001) {
          if (priorLayer && next[2] < priorLayer.z - 0.0001) issue('Extrusion descends to an earlier height; nonplanar/layer ordering is not supported.');
          if (priorLayer) priorLayer.endSegment = segments.length;
          layers.push({ index: layers.length, z: next[2], startSegment: priorLayer ? segments.length : 0, endSegment: segments.length });
        }
        if (Math.abs(next[2] - position[2]) > 0.0001) issue('Nonplanar extrusion is unsupported; verify the full path in the target slicer.');
      }
      segments.push({ from: [...position], to: next, feature: extruding ? currentFeature === 'travel' ? 'other' : currentFeature : 'travel', layer: Math.max(0, layers.length - 1), extrusionMm: extruding ? deltaE : 0, line: lineIndex + 1, feedrateMmMin: feedrate });
      if (segments.length > maxSegments) throw new Error(`Toolpath exceeds the ${maxSegments.toLocaleString()} segment preview limit.`);
    }
    position = next;
  }
  if (!layers.length || extrusionMm <= 0) throw new Error('No supported extrusion moves found. Import linear G0/G1 G-code with extrusion.');
  layers[layers.length - 1].endSegment = segments.length;
  const min: ToolpathPoint = [Infinity, Infinity, Infinity];
  const max: ToolpathPoint = [-Infinity, -Infinity, -Infinity];
  for (const segment of segments) for (const point of [segment.from, segment.to]) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
  }
  const isDemonstration = /CATALYST_DEMONSTRATION_TOOLPATH/i.test(text);
  if (isDemonstration) warnings.add('Demonstration toolpath: manually authored fixture, never generated from the selected CAD and not for machine use.');
  return { segments, layers, warnings: [...warnings], blockingIssues: [...blocking], unsupportedCommands: [...unsupported], canApprove: blocking.size === 0, units: 'mm', sourceUnits: [...sourceUnits], bounds: { min, max }, extrusionMm, lineCount: lines.length, isDemonstration };
}
