import type { Job, JobItem, Part, PartCategory, ProcessSettings, Project, Vec3 } from './model';
import { layoutItem, stableStringify, validateDimensions } from './invariants';

/** Advisory geometry checks. These are deliberately separate from strength assessment and slicing. */
export interface OrientationSuggestion {
  id: string; title: string; orientation: Vec3; dimensions: Vec3; fits: boolean; footprintArea: number;
  explanations: string[]; assumptions: string[]; tradeoffs: string[];
  contextConfirmed: boolean; missingContext: string[];
}
export interface PlacementSuggestion {
  available: boolean; orientation?: Vec3; position?: Vec3; dimensions?: Vec3; totalCopies: number;
  explanations: string[]; assumptions: string[]; reason: string;
}
export interface QuantityReconciliation {
  partId: string; name: string; cadQuantity: number; occurrenceCount: number; plannedQuantity: number;
  spareQuantity: number; totalQuantity: number; delta: number; suggestedQuantity: number;
  sourceBasis: 'assembly occurrences' | 'source quantity' | 'local import'; needsReview: boolean;
}
export interface ProfileRecommendation {
  title: string; category: PartCategory; settings: ProcessSettings; reason: string;
  assumptions: string[]; confidence: 'review required';
}
export interface PreflightIssue {
  id: string; severity: 'error' | 'warning' | 'info'; message: string; detail: string;
  partId?: string; page: 'prepare' | 'toolpaths' | 'review'; field: string;
}
export interface PreflightChecks { toolpathCurrent?: boolean; approvalCurrent?: boolean; }

const geometryAssumptions = [
  'Conservative rotated source bounding boxes in millimetres only; this is not simulation or a strength assessment.',
  'Fit and placement use rotated source bounds, not mesh contact analysis; a warning may be conservative for an asymmetric part.',
  'Brims, supports, machine exclusion zones and toolpath clearances require the actual sliced output.',
  'Manufacturing rotation is separate from the installed assembly transform. Geometry is never rescaled.',
];
const finiteVector = (v: readonly number[]): boolean => v.length === 3 && v.every(Number.isFinite);
const validQuantity = (item: JobItem): boolean => Number.isInteger(item.quantity) && item.quantity >= 0 && item.quantity + item.spareQuantity >= 1 && Number.isInteger(item.spareQuantity) && item.spareQuantity >= 0 && item.quantity + item.spareQuantity <= 1000;
const validVolume = (job: Job): boolean => finiteVector(job.printer.buildVolume) && job.printer.buildVolume.every(v => v > 0);
const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.00001;

function candidateDimensions(part: Part, item: JobItem, orientation: Vec3): Vec3 {
  // Match the manifest's Euler XYZ convention and conservative rotated source AABB.
  // Source dimensions are measured on import; this does not measure the rotated mesh.
  return [...layoutItem(part, { ...item, quantity: 1, spareQuantity: 0, orientation })[0].dimensions] as Vec3;
}
function gridSpan(dimensions: Vec3, total: number): Vec3 {
  const columns = Math.ceil(Math.sqrt(total)), rows = Math.ceil(total / columns);
  return [columns * dimensions[0] + (columns - 1) * 8, rows * dimensions[1] + (rows - 1) * 8, dimensions[2]];
}
function missingContext(job: Job): string[] {
  const missing: string[] = [];
  if (!job.useCase.purpose.trim()) missing.push('Confirm intended use and mounting interfaces.');
  if (!job.useCase.loadDirection.trim()) missing.push('Provide reviewed loads and directions, or explicitly record them as unknown.');
  if (!job.useCase.constraints.trim()) missing.push('Identify critical surfaces, fits and dimensional constraints.');
  if (!job.useCase.operatingConditions.trim()) missing.push('Record operating conditions, including temperature and environment.');
  if (!job.useCase.confirmed) missing.push('Have the team confirm the use-case context before making strength decisions.');
  return missing;
}

/** Candidates are ranked by empty-plate fit, then Z extent. No loads are inferred from shape. */
export function orientationSuggestions(project: Project, job: Job, partId: string): OrientationSuggestion[] {
  const part = project.parts.find(p => p.id === partId), item = job.items.find(i => i.partId === partId);
  if (!part || !item || !validQuantity(item) || !finiteVector(item.orientation)) return [];
  try { validateDimensions(part.geometry.dimensions); } catch { return []; }
  const candidates: { id: string; title: string; orientation: Vec3 }[] = [
    { id: 'current', title: 'Current orientation', orientation: [...item.orientation] },
    { id: 'cad-axes', title: 'Source axes on plate', orientation: [0, 0, 0] },
    { id: 'turn-x', title: 'Turn 90° around X', orientation: [90, 0, 0] },
    { id: 'turn-y', title: 'Turn 90° around Y', orientation: [0, 90, 0] },
  ];
  const seen: Vec3[] = [], total = item.quantity + item.spareQuantity, missing = missingContext(job);
  const suggestions: OrientationSuggestion[] = [];
  for (const candidate of candidates) {
    if (seen.some(v => v.every((angle, i) => near(((angle % 360) + 360) % 360, ((candidate.orientation[i] % 360) + 360) % 360)))) continue;
    seen.push(candidate.orientation);
    const dimensions = candidateDimensions(part, item, candidate.orientation);
    const span = gridSpan(dimensions, total);
    const fits = validVolume(job) && span.every((v, i) => v <= job.printer.buildVolume[i] + 0.001);
    suggestions.push({ ...candidate, dimensions, fits, footprintArea: dimensions[0] * dimensions[1],
      explanations: [
        `Conservative rotated source bounds: ${dimensions.map(v => Number(v.toFixed(2))).join(' × ')} mm.`,
        `${total} ${total === 1 ? 'copy' : 'copies'} ${fits ? 'fit' : 'do not fit'} on an otherwise empty plate using the explicit 8 mm copy grid.`,
        'Ranking compares fit and geometric height. It does not rank strength or predict print duration.',
      ], assumptions: [...geometryAssumptions,
        ...(job.useCase.confirmed ? [`Team-confirmed purpose: ${job.useCase.purpose || 'not recorded'}. Load context is user supplied and has not been independently verified.`] : ['Use-case context is incomplete or not confirmed by the team.'])],
      tradeoffs: [
        'Inspect the layer direction against team-reviewed loads; no weak sections or safety factors have been calculated.',
        'Source bounding boxes do not establish mesh contact, support requirements or contact with critical surfaces.',
        'Review bores, datums and tolerances in the selected orientation; actual toolpaths and physical validation are still required.',
      ], contextConfirmed: job.useCase.confirmed && missing.length === 0, missingContext: [...missing] });
  }
  return suggestions.sort((a, b) => Number(b.fits) - Number(a.fits) || a.dimensions[2] - b.dimensions[2] || a.footprintArea - b.footprintArea);
}

type Bounds = { min: Vec3; max: Vec3 };
function instanceBounds(instance: ReturnType<typeof layoutItem>[number]): Bounds {
  const [x, y, z] = instance.position, [w, d, h] = instance.dimensions;
  return { min: [x - w / 2, y - d / 2, z], max: [x + w / 2, y + d / 2, z + h] };
}
function within(bounds: Bounds, volume: Vec3): boolean { return bounds.min.every((v, i) => v >= -0.001 && bounds.max[i] <= volume[i] + 0.001); }
function overlaps(a: Bounds, b: Bounds): boolean {
  // Conservative XY rejection also prevents placing objects above one another on the bed.
  return a.min[0] < b.max[0] - 0.001 && a.max[0] > b.min[0] + 0.001 && a.min[1] < b.max[1] - 0.001 && a.max[1] > b.min[1] + 0.001;
}

/** An explicit, non-mutating proposal. Preserve manual orientation whenever it can be placed. */
export function proposePlacement(project: Project, job: Job, partId: string): PlacementSuggestion {
  const part = project.parts.find(p => p.id === partId), item = job.items.find(i => i.partId === partId);
  const totalCopies = item ? item.quantity + item.spareQuantity : 0;
  const unavailable = (reason: string): PlacementSuggestion => ({ available: false, totalCopies, reason, explanations: [], assumptions: [...geometryAssumptions] });
  if (!part || !item) return unavailable('Select an included part before requesting placement.');
  if (!validQuantity(item) || !validVolume(job)) return unavailable('Correct quantities and the explicit printer build volume before requesting placement.');
  const others: Bounds[] = [];
  for (const other of job.items.filter(i => i.partId !== partId)) {
    const source = project.parts.find(p => p.id === other.partId);
    if (!source || !validQuantity(other) || !finiteVector(other.orientation) || !finiteVector(other.position)) return unavailable('Correct missing parts or invalid placement values elsewhere in the batch first.');
    try { validateDimensions(source.geometry.dimensions); } catch { return unavailable('Correct invalid source dimensions elsewhere in the batch first.'); }
    others.push(...layoutItem(source, other).map(instanceBounds));
  }
  const suggestions = orientationSuggestions(project, job, partId).filter(s => s.fits).sort((a, b) => Number(b.id === 'current') - Number(a.id === 'current'));
  for (const candidate of suggestions) {
    const span = gridSpan(candidate.dimensions, totalCopies), [w, d] = candidate.dimensions;
    // Search plate edges and obstacle edges, rather than silently changing the versioned copy grid.
    const xs = new Set([0, job.printer.buildVolume[0] - span[0]]), ys = new Set([0, job.printer.buildVolume[1] - span[1]]);
    for (const obstacle of others) {
      xs.add(obstacle.max[0] + 8); xs.add(obstacle.min[0] - span[0] - 8);
      ys.add(obstacle.max[1] + 8); ys.add(obstacle.min[1] - span[1] - 8);
    }
    const xCandidates = [...xs].filter(x => x >= -0.001 && x + span[0] <= job.printer.buildVolume[0] + 0.001).sort((a, b) => a - b);
    const yCandidates = [...ys].filter(y => y >= -0.001 && y + span[1] <= job.printer.buildVolume[1] + 0.001).sort((a, b) => a - b);
    for (const y of yCandidates) for (const x of xCandidates) {
      const position: Vec3 = [x + w / 2, y + d / 2, 0];
      const proposed = layoutItem(part, { ...item, orientation: candidate.orientation, position }).map(instanceBounds);
      if (!proposed.every(bounds => within(bounds, job.printer.buildVolume) && others.every(other => !overlaps(bounds, other)))) continue;
      if (proposed.some((bounds, i) => proposed.slice(i + 1).some(other => overlaps(bounds, other)))) continue;
      return { available: true, orientation: [...candidate.orientation], position, dimensions: [...candidate.dimensions], totalCopies,
        reason: `${totalCopies} ${totalCopies === 1 ? 'copy fits' : 'copies fit'} inside the selected build volume without overlapping other conservative source bounds.`,
        explanations: [candidate.id === 'current' ? 'Your current manual orientation is preserved.' : 'A different orientation is proposed explicitly; applying it requires a new matching toolpath review.',
          'Every required copy and spare was checked using the same 8 mm grid as the manifest.', 'No geometry or quantity has been changed. Apply the proposal to update this job.'],
        assumptions: [...geometryAssumptions, 'This is an edge-based placement search, not a complete packing solver. Manual placement remains available.'] };
    }
  }
  return unavailable('No collision-free proposal was found for all copies in the current grid. Reduce this batch quantity, move other parts, select a verified larger machine or place manually. Geometry was not rescaled.');
}

/** CAD demand and this batch's planned demand remain separate until the user reconciles them. */
export function quantityReconciliation(project: Project, job: Job): QuantityReconciliation[] {
  return job.items.map(item => {
    const part = project.parts.find(p => p.id === item.partId);
    const occurrenceCount = part?.source.occurrences?.length ?? 0;
    const cadQuantity = occurrenceCount > 0 ? occurrenceCount : part?.quantity ?? 0;
    const delta = item.quantity - cadQuantity;
    return { partId: item.partId, name: part?.name ?? 'Missing source part', cadQuantity, occurrenceCount,
      plannedQuantity: item.quantity, spareQuantity: item.spareQuantity, totalQuantity: item.quantity + item.spareQuantity,
      delta, suggestedQuantity: cadQuantity, sourceBasis: part?.source.kind === 'local' ? 'local import' : occurrenceCount > 0 ? 'assembly occurrences' : 'source quantity',
      needsReview: !part || !validQuantity(item) || delta !== 0 };
  });
}

const categoryProfiles: Record<PartCategory, { title: string; reason: string; settings: Partial<ProcessSettings> }> = {
  bracket: { title: 'Functional bracket', reason: 'Four walls and 30% infill are an editable starting point for a team-classified bracket. Confirm fasteners, layer direction and real loads before choosing the process.', settings: { layerHeight: 0.2, walls: 4, infill: 30, supports: false } },
  enclosure: { title: 'Electronics enclosure', reason: 'Three walls and 20% infill are an editable starting point. Inspect openings, sealing faces and support access rather than assuming the open face from the bounds.', settings: { layerHeight: 0.2, walls: 3, infill: 20, supports: false } },
  spacer: { title: 'Precision spacer', reason: 'A finer example layer height may be useful when reviewing a spacer. Measure the actual bore and faces; category alone does not establish fit or axial load capacity.', settings: { layerHeight: 0.16, walls: 4, infill: 40, supports: false } },
  pulley: { title: 'Pulley or roller', reason: 'Five walls and 40% infill are an editable example. Team review must establish bore tolerance, groove finish, retention and operating conditions.', settings: { layerHeight: 0.16, walls: 5, infill: 40, supports: false } },
  custom: { title: 'Custom component', reason: 'The category is unresolved. This generic example cannot establish suitable material, support needs or strength; correct the category and record the use case.', settings: { layerHeight: 0.2, walls: 4, infill: 30, supports: false } },
};
export function recommendedProfile(part: Part, job: Job): ProfileRecommendation {
  const category = part.category in categoryProfiles ? part.category : 'custom', profile = categoryProfiles[category];
  const maxExampleLayer = Number((job.printer.nozzleDiameter * 0.5).toFixed(3));
  const settings: ProcessSettings = { ...job.baseSettings };
  Object.assign(settings, profile.settings);
  // An example nozzle heuristic, deliberately disclosed and still editable.
  if (Number.isFinite(maxExampleLayer) && maxExampleLayer >= 0.04) settings.layerHeight = Math.min(settings.layerHeight, maxExampleLayer);
  return { title: profile.title, category, settings, reason: profile.reason, confidence: 'review required', assumptions: [
    'Untested example profile; no material/process qualification or physical load rating is established.',
    `Category “${category}” is supplied by CAD metadata or team input and can be corrected. It is not a verified geometric inference.`,
    `Example for ${job.printer.model}, ${job.printer.nozzleDiameter} mm nozzle, ${job.material.name} and ${job.printer.plate}; exact team hardware must be verified.`,
    'Example layer height is capped at half the declared nozzle diameter. This is a starting-point heuristic, not a machine limit.',
    'CAD material names and colours are hints. They do not select the filament or establish material suitability.',
    'Manual overrides are retained by the caller unless the user explicitly chooses to replace them.',
  ] };
}

/** Synchronous navigable checks; callers supply async hash validation results when available. */
export function preflightIssues(project: Project, job: Job, checks: PreflightChecks = {}): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const add = (id: string, severity: PreflightIssue['severity'], message: string, detail: string, field: string, partId?: string, page: PreflightIssue['page'] = 'prepare') => issues.push({ id, severity, message, detail, field, partId, page });
  if (!job.items.length) add('parts-empty', 'error', 'Select at least one make part.', 'Import CAD parts or a local STL, classify the parts and include them in this batch.', 'Add CAD parts');
  if (!validVolume(job)) add('printer-volume', 'error', 'The selected build volume is invalid.', 'All three printer build-volume coordinates must be positive finite millimetres.', 'Printer profile');
  if (!Number.isFinite(job.printer.nozzleDiameter) || job.printer.nozzleDiameter <= 0) add('printer-nozzle', 'error', 'Declare a positive nozzle diameter.', 'The selected physical nozzle must match the printer profile.', 'Nozzle');
  const seenParts = new Set<string>();
  const placed: { part: Part; bounds: Bounds; index: number }[] = [];
  for (const item of job.items) {
    const part = project.parts.find(p => p.id === item.partId), id = item.partId;
    if (seenParts.has(id)) add(`duplicate-${id}`, 'error', 'A part is included twice.', 'Use one part row and edit the required/spare quantities.', 'Required quantity', id);
    seenParts.add(id);
    if (!part) { add(`missing-${id}`, 'error', 'A batch part is missing from the project.', 'Reimport its exact pinned geometry or explicitly remove the missing part from this batch.', 'Add CAD parts', id); continue; }
    if (part.classification !== 'make') add(`classification-${id}`, 'error', `${part.name}: confirm make/buy classification.`, 'Only parts explicitly classified as make can be manufactured. Purchased parts must be excluded.', 'Classification', id);
    if (part.source.available === false) add(`source-unavailable-${id}`, 'error', `${part.name}: linked/source geometry is unavailable.`, 'Restore authorised access or explicitly exclude this part. Never substitute a similar part.', 'Add CAD parts', id);
    if (part.source.kind !== 'local') {
      if (!part.source.versionId?.trim()) add(`version-${id}`, 'error', `${part.name}: immutable source version is missing.`, 'Select an immutable CAD version; workspace geometry must not replace approved geometry.', 'Add CAD parts', id);
      if (!part.source.documentId?.trim() || !part.source.elementId?.trim() || typeof part.source.configuration !== 'string') add(`configuration-${id}`, 'error', `${part.name}: exact CAD source/configuration is incomplete.`, 'Select the source document, assembly/Part Studio and explicit configuration again.', 'Add CAD parts', id);
      if (part.source.kind === 'onshape' && !part.source.partId?.trim()) add(`source-part-${id}`, 'error', `${part.name}: exact Onshape part ID is missing.`, 'Reimport the exact version/configuration part rather than matching only its display name.', 'Add CAD parts', id);
    }
    if (part.geometry.units !== 'mm' || (part.geometry.original && !['in', 'mm'].includes(part.geometry.original.units))) add(`units-${id}`, 'error', `${part.name}: explicit units are invalid.`, 'Reimport with declared mm or inch input. Manufacturing geometry must be normalized once to millimetres; it is never silently rescaled.', 'Add CAD parts', id);
    let validGeometry = true;
    try { validateDimensions(part.geometry.dimensions); } catch (error) { validGeometry = false; add(`dimensions-${id}`, 'error', `${part.name}: geometry dimensions are invalid.`, (error as Error).message, 'Add CAD parts', id); }
    if (part.geometry.vertices?.length) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      part.geometry.vertices.forEach((value, i) => { min[i % 3] = Math.min(min[i % 3], value); max[i % 3] = Math.max(max[i % 3], value); });
      try { validateDimensions(max.map((value, i) => value - min[i]) as Vec3, part.geometry.dimensions); }
      catch (error) { validGeometry = false; add(`geometry-units-${id}`, 'error', `${part.name}: measured geometry disagrees with its recorded dimensions.`, `${(error as Error).message} Reimport the original source; no automatic repair or conversion was applied.`, 'Add CAD parts', id); }
    }
    for (const [i, warning] of (part.geometry.warnings ?? []).entries()) add(`geometry-warning-${id}-${i}`, 'warning', `${part.name}: source geometry needs review.`, warning, 'Add CAD parts', id);
    if (!validQuantity(item)) add(`quantity-${id}`, 'error', `${part.name}: quantities must be whole numbers.`, 'Required and backup quantities can be zero individually; the combined total must be 1 through 1000.', item.spareQuantity < 0 || !Number.isInteger(item.spareQuantity) ? 'Backup parts' : 'Required quantity', id);
    if (!finiteVector(item.orientation)) add(`orientation-${id}`, 'error', `${part.name}: rotation is invalid.`, 'Enter three finite Euler XYZ angles in degrees.', 'Rotate X', id);
    if (!finiteVector(item.position)) add(`position-${id}`, 'error', `${part.name}: placement is invalid.`, 'Enter three finite plate coordinates in millimetres.', 'Position X', id);
    const paths = (part.source.occurrences ?? []).map(o => JSON.stringify(o.path));
    if (new Set(paths).size !== paths.length) add(`occurrences-${id}`, 'error', `${part.name}: repeated source paths need review.`, 'Identical occurrence paths must not be counted twice. Reimport the exact assembly/configuration.', 'Required quantity', id);
    if (validGeometry && validQuantity(item) && finiteVector(item.orientation) && finiteVector(item.position)) {
      for (const instance of layoutItem(part, item)) {
        const bounds = instanceBounds(instance); placed.push({ part, bounds, index: instance.index });
        if (validVolume(job) && !within(bounds, job.printer.buildVolume)) {
          const axis = bounds.min.findIndex((value, i) => value < -0.001 || bounds.max[i] > job.printer.buildVolume[i] + 0.001);
          add(`fit-${id}-${instance.index}`, 'error', `${part.name}, copy ${instance.index + 1}: outside the build volume.`, 'Move or rotate the part, reduce the batch quantity or choose a verified compatible machine. Geometry was not rescaled.', `Position ${['X', 'Y', 'Z'][Math.max(0, axis)]}`, id);
        }
      }
    }
  }
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) if (overlaps(placed[i].bounds, placed[j].bounds)) {
    const a = placed[i], b = placed[j];
    add(`overlap-${a.part.id}-${a.index}-${b.part.id}-${b.index}`, 'error', `${a.part.name} and ${b.part.name}: geometry bounds overlap.`, `Move the affected parts apart. Copies ${a.index + 1} and ${b.index + 1} overlap under the conservative XY bounds check.`, 'Position X', a.part.id);
  }
  for (const row of quantityReconciliation(project, job)) if (row.delta !== 0 && row.cadQuantity > 0) add(`reconcile-${row.partId}`, 'warning', `${row.name}: planned quantity differs from CAD demand.`, `Source demand ${row.cadQuantity}; planned required ${row.plannedQuantity}; additional spares ${row.spareQuantity}. This may be an intentional partial batch. Reconcile explicitly or keep the override.`, 'Required quantity', row.partId);
  const settings = job.settings;
  if (!Number.isFinite(settings.layerHeight) || settings.layerHeight < 0.04 || settings.layerHeight > 1) add('settings-layer', 'error', 'Layer height is outside the supported adapter range.', 'Enter a finite layer height from 0.04 to 1 mm. A supported numeric range is not machine/process qualification.', 'Layer height');
  else if (Number.isFinite(job.printer.nozzleDiameter) && job.printer.nozzleDiameter > 0 && settings.layerHeight > job.printer.nozzleDiameter * 0.8) add('settings-layer-nozzle', 'warning', 'Review layer height against the selected nozzle.', 'The layer height exceeds 80% of nozzle diameter, an example heuristic only. Check a tested complete slicer profile; this is not a verified machine limit. Your override is retained.', 'Layer height');
  if (!Number.isInteger(settings.walls) || settings.walls < 1 || settings.walls > 20) add('settings-walls', 'error', 'Wall loops must be a whole number from 1 to 20.', 'Correct the process setting before binding a new toolpath.', 'Wall loops');
  if (!Number.isFinite(settings.infill) || settings.infill < 0 || settings.infill > 100) add('settings-infill', 'error', 'Infill must be between 0 and 100%.', 'Use a finite percentage for the selected process profile.', 'Infill');
  if (typeof settings.supports !== 'boolean') add('settings-supports', 'error', 'Choose an explicit support setting.', 'Supports must be on or off. Geometry bounds cannot establish whether supports are needed.', 'Supports');
  if (!Number.isFinite(settings.brimWidth) || settings.brimWidth < 0 || settings.brimWidth > 50) add('settings-brim', 'error', 'Brim width must be between 0 and 50 mm.', 'Check actual brim clearance in the sliced output.', 'Brim width');
  if (!Number.isFinite(settings.speed) || settings.speed <= 0 || settings.speed > 1000) add('settings-speed', 'error', 'Print speed must be greater than 0 and at most 1000 mm/s.', 'The supported range does not establish a tested printer/material speed.', 'Print speed');
  for (const [key, value] of Object.entries(settings)) if (!['layerHeight', 'walls', 'infill', 'supports', 'brimWidth', 'speed'].includes(key) && typeof value === 'number' && !Number.isFinite(value)) add(`settings-extra-${key}`, 'error', `Process setting “${key}” is not finite.`, 'Correct or remove the invalid adapter-specific setting.', 'Layer height');
  if (!job.printer.tested || !job.material.tested) add('profile-untested', 'warning', 'Printer/material profiles are untested examples.', 'Exact model, nozzle, plate, filament and complete process profiles must be validated before physical use. Packages remain demonstration-only.', !job.printer.tested ? 'Printer profile' : 'Filament');
  if (!job.toolpath) add('toolpath-missing', 'error', 'A matching toolpath is required before approval.', 'Import a supported actual G-code result and explicitly confirm its exact job mapping. Fixture toolpaths are demonstration-only.', 'Import G-code', undefined, 'toolpaths');
  else {
    if (job.toolpath.mappingConfirmed !== true) add('toolpath-mapping', 'error', 'The toolpath mapping is missing or revoked.', 'Bind a matching result again and confirm the exact geometry, quantities, machine, material and settings.', 'Import G-code', undefined, 'toolpaths');
    if (job.toolpath.stale || checks.toolpathCurrent === false || stableStringify(job.slicer) !== stableStringify(job.toolpath.slicer)) add('toolpath-stale', 'error', 'The toolpath no longer matches this manufacturing job.', 'Any geometry, orientation, quantity, profile or mapping change requires a new matching result and review.', 'Import G-code', undefined, 'toolpaths');
    if (!job.toolpath.reviewedAt || !job.toolpath.reviewedBy?.trim()) add('toolpath-review', 'error', 'Review the actual toolpath layers before approval.', 'Inspect walls, infill, supports, travel and parser warnings. A CAD cross-section is not a toolpath review.', 'Confirm toolpath review', undefined, 'review');
  }
  if (job.approval && checks.approvalCurrent === false) add('approval-stale', 'error', 'The recorded approval is stale.', 'Review and approve the exact current manufacturing manifest. A saved historical approval cannot release a changed job.', 'Confirm manufacturing manifest', undefined, 'review');
  return issues;
}

/** Preparation state follows blocking input checks, independently of missing downstream toolpaths. */
export function preparationStatus(project: Project, job: Job): Job['status'] {
  if (!['draft', 'needs review', 'ready to slice'].includes(job.status)) return job.status;
  if (!job.items.length) return 'draft';
  return preflightIssues(project, job).some(issue => issue.severity === 'error' && issue.page === 'prepare')
    ? 'needs review' : 'ready to slice';
}
