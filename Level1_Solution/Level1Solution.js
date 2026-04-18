// Level 1 Solution

const fs = require('fs');
const path = require('path');

// Read input file
const inputPath = path.join(__dirname, '../levels/1.txt');
const inputData = fs.readFileSync(inputPath, 'utf8');
const data = JSON.parse(inputData);

// ── Car properties ──────────────────────────────────────────────
const car = {
  maxSpeed:    data.car["max_speed_m/s"],
  accel:       data.car["accel_m/se2"],
  brake:       data.car["brake_m/se2"],
  limpSpeed:   data.car["limp_constant_m/s"],
  crawlSpeed:  data.car["crawl_constant_m/s"],
  tankCapacity: data.car["fuel_tank_capacity_l"],
  initialFuel:  data.car["initial_fuel_l"],
  fuelConsumption: data.car["fuel_consumption_l/m"],
};

// ── Race properties ─────────────────────────────────────────────
const race = {
  name:              data.race.name,
  laps:              data.race.laps,
  basePitTime:       data.race["base_pit_stop_time_s"],
  tyrSwapTime:       data.race["pit_tyre_swap_time_s"],
  refuelRate:        data.race["pit_refuel_rate_l/s"],
  crashPenalty:      data.race["corner_crash_penalty_s"],
  pitExitSpeed:      data.race["pit_exit_speed_m/s"],
  fuelSoftCap:       data.race["fuel_soft_cap_limit_l"],
  startingWeatherId: data.race["starting_weather_condition_id"],
  timeReference:     data.race["time_reference_s"],
};

// ── Track segments ───────────────────────────────────────────────
// All segments
const segments = data.track.segments;

// Split into straights and corners for convenience
const straights = segments.filter(s => s.type === "straight");
const corners   = segments.filter(s => s.type === "corner");

// ── Tyre compound properties ─────────────────────────────────────
const tyreProperties = data.tyres.properties;

// Available tyre sets (IDs → compound)
const availableSets = data.available_sets;

// Flat map: tyre ID → compound name (for quick lookup when we know the ID but need the compound)
const tyreIdToCompound = {};
for (const set of availableSets) {
  for (const id of set.ids) {
    tyreIdToCompound[id] = set.compound;
  }
}

// ── Weather conditions ───────────────────────────────────────────
const weatherConditions = data.weather.conditions;
// Lookup by ID
const weatherById = {};
for (const w of weatherConditions) {
  weatherById[w.id] = w;
}


// ── Summary printout ─────────────────────────────────────────────
function main() {
  console.log("=== Level 1 Solution ===\n");

  console.log("CAR:", car);
  console.log("\nRACE:", race);

  console.log(`\nTRACK: ${data.track.name}`);
  console.log(`  Total segments : ${segments.length}`);
  console.log(`  Straights (${straights.length}):`, straights.map(s => `ID${s.id}(${s.length_m}m)`).join(", "));
  console.log(`  Corners   (${corners.length}):`,   corners.map(c => `ID${c.id}(r=${c.radius_m}m)`).join(", "));

  console.log("\nAVAILABLE TYRE SETS:");
  for (const set of availableSets) {
    console.log(`  IDs ${set.ids.join(",")} → ${set.compound}`);
  }

  console.log("\nWEATHER CONDITIONS:");
  for (const w of weatherConditions) {
    console.log(`  [${w.id}] ${w.condition} — duration: ${w.duration_s}s`);
  }

  // Example: max corner speed for each corner using Soft tyre at full friction, dry weather
  const exampleCompound = "Soft";
  const exampleDegradation = 0;
  const exampleWeather = "dry";
//   const friction = tyreFriction(exampleCompound, exampleDegradation, exampleWeather);

//   console.log(`\nMAX CORNER SPEEDS (${exampleCompound} tyre, dry, no degradation — friction=${friction.toFixed(3)}):`);
//   for (const corner of corners) {
//     const mcs = maxCornerSpeed(friction, corner.radius_m);
//     console.log(`  Segment ID${corner.id} (r=${corner.radius_m}m): max ${mcs.toFixed(2)} m/s`);
//   }
}

main();

// ── Write output ─────────────────────────────────────────────────
const outputPath = path.join(__dirname, 'output.txt');
fs.writeFileSync(outputPath, inputData, 'utf8');
console.log('\nOutput written to output.txt');