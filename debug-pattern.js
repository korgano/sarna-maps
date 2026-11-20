import { generateDisputedSystemFillPattern } from './src/render/svg/functions/generate-disputed-system-fill-pattern';
const factions: Record<string, any> = {
  LC: { id: 'LC', name: 'Lyran Commonwealth', color: '#4477cc' },
  DC: { id: 'DC', name: 'Draconis Combine', color: '#cc4444' },
  CC: { id: 'CC', name: 'Capellan Confederation', color: '#44cc44' },
  FS: { id: 'FS', name: 'Federated Suns', color: '#cccc44' },
};

// Test 3 factions (previously had floating point issues)
const result = generateDisputedSystemFillPattern('D-LC-DC-CC', factions);
console.log('=== 3 factions ===');
console.log(result);

// Extract paths
const pathMatches = result.match(/<path /g) || [];
console.log('Number of paths:', pathMatches.length);

// Get d attributes
const dMatches = result.match(/d="([^"]+)"/g);
if (dMatches) {
  console.log('\nPath data:');
  for (const d of dMatches) {
    console.log(d);
  }
}

// Also test 5 factions
console.log('\n\n=== 5 factions ===');
const result5 = generateDisputedSystemFillPattern('D-LC-DC-CC-FS', factions); // This will have 5 but FS may not be in key... let me use D-LC-DC-CC-FS
// Actually need 5 unique factions. Let me create a test with 5.