import { generateDisputedSystemFillPattern } from './src/render/svg/functions/generate-disputed-system-fill-pattern';
const factions: Record<string, any> = {
  LC: { id: 'LC', name: 'Lyran Commonwealth', color: '#4477cc' },
  DC: { id: 'DC', name: 'Draconis Combine', color: '#cc4444' },
  CC: { id: 'CC', name: 'Capellan Confederation', color: '#44cc44' },
  FS: { id: 'FS', name: 'Federated Suns', color: '#cccc44' },
};

// Test with 2 factions - extract path data
const result = generateDisputedSystemFillPattern('D-LC-DC', factions);
const dMatches = result.match(/d="([^"]+)"/g);
console.log('=== 2 factions (D-LC-DC) path data ===');
if (dMatches) {
  for (const d of dMatches) {
    console.log(d);
    // Extract the coordinate values
    const coords = d.match(/[-+]?\.?\d+/g) || [];
    console.log('  coords:', coords);
  }
}
console.log('---');

// Test with 4 factions (0.25 slices)
const result4 = generateDisputedSystemFillPattern('D-LC-DC-CC-FS', factions);
const dMatches4 = result4.match(/d="([^"]+)"/g);
console.log('=== 4 factions (D-LC-DC-CC-FS) path data ===');
if (dMatches4) {
  for (const d of dMatches4) {
    console.log(d);
    const coords = d.match(/[-+]?\.?\d+/g) || [];
    console.log('  coords:', coords);
  }
}