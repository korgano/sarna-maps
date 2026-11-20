const factionCounts = [2, 3, 4, 5, 6, 7];
const systemRadius = 5;

for (const factionCount of factionCounts) {
  console.log(`=== ${factionCount} factions ===`);
  console.log(`sliceAngle = 2π / ${factionCount} = ${(2 * Math.PI / factionCount).toFixed(4)} rad = ${(2 * Math.PI / factionCount * 180 / Math.PI).toFixed(1)}°`);
  let cumulativeAngle = 0;
  for (let i = 0; i < factionCount; i++) {
    const startAngle = cumulativeAngle;
    const sliceAngle = 2 * Math.PI / factionCount;
    const endAngle = cumulativeAngle + sliceAngle;
    cumulativeAngle = endAngle;
    const startX = systemRadius * Math.cos(startAngle);
    const startY = systemRadius * Math.sin(startAngle);
    const endX = systemRadius * Math.cos(endAngle);
    const endY = systemRadius * Math.sin(endAngle);
    const sliceDeg = sliceAngle * 180 / Math.PI;
    console.log(`  Sector ${i}: startAngle=${startAngle.toFixed(4)} rad (${sliceDeg.toFixed(1)}°), endAngle=${endAngle.toFixed(4)} rad`);
    console.log(`    start=(${startX.toFixed(2)}, ${startY.toFixed(2)}), end=(${endX.toFixed(2)}, ${endY.toFixed(2)})`);
  }
  console.log();

  // Also check the current code's percentage-based approach
  console.log(`  (Code approach: i/${factionCount} to ${(i+1)}/${factionCount})`);
  for (let i = 0; i < factionCount; i++) {
    const currentPercentage = i / factionCount;
    const endPercentage = (i + 1) / factionCount;
    const startAngle = 2 * Math.PI * currentPercentage;
    const endAngle = 2 * Math.PI * endPercentage;
    const sliceDeg = (endAngle - startAngle) * 180 / Math.PI;
    console.log(`  Code sector ${i}: ${sliceDeg.toFixed(1)}°`);
  }
  console.log();
}