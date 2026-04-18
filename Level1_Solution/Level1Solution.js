// Level 1 Solution
const fs = require("fs");
const path = require("path");

// ── Load constants & helpers from root constants.js ──────────────────────────
// (inline here so the file runs standalone — mirrors constants.js exactly)

const CONSTANTS = {
  K_STRAIGHT:   0.0000166,
  K_BRAKING:    0.0398,
  K_CORNER:     0.000265,
  FUEL_K_BASE:  0.0005,
  FUEL_K_DRAG:  0.0000000015,
  GRAVITY:      9.8,
};

// From constants.js ── calcMaxCornerSpeed
function calcMaxCornerSpeed(tyreFriction, cornerRadius, crawlConstant) {
  return Math.sqrt(tyreFriction * CONSTANTS.GRAVITY * cornerRadius) + crawlConstant;
}

// From constants.js ── calcCurrentTyreFriction
function calcCurrentTyreFriction(baseFriction, totalDegradation, weatherMultiplier) {
  return (baseFriction - totalDegradation) * weatherMultiplier;
}

// From constants.js ── calcDistanceGivenFinalSpeed (used for brake/accel distances)
function calcDistanceGivenFinalSpeed(initialSpeed, finalSpeed, acceleration) {
  return (Math.pow(finalSpeed, 2) - Math.pow(initialSpeed, 2)) / (2 * acceleration);
}

// From constants.js ── calcBaseScore
function calcBaseScore(timeReference, actualRaceTime) {
  return 500000 * Math.pow(timeReference / actualRaceTime, 3);
}

// ── Read input ────────────────────────────────────────────────────────────────
const inputPath = path.join(__dirname, "../levels/1.txt");
const inputData = fs.readFileSync(inputPath, "utf8");
const data = JSON.parse(inputData);

// ── Parse car ─────────────────────────────────────────────────────────────────
const car = {
  maxSpeed:        data.car["max_speed_m/s"],
  accel:           data.car["accel_m/se2"],
  brake:           data.car["brake_m/se2"],
  limpSpeed:       data.car["limp_constant_m/s"],
  crawlSpeed:      data.car["crawl_constant_m/s"],
  tankCapacity:    data.car["fuel_tank_capacity_l"],
  initialFuel:     data.car["initial_fuel_l"],
  fuelConsumption: data.car["fuel_consumption_l/m"],
};

// ── Parse race ────────────────────────────────────────────────────────────────
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

// ── Parse track ───────────────────────────────────────────────────────────────
const segments = data.track.segments;
const straights = segments.filter((s) => s.type === "straight");
const corners   = segments.filter((s) => s.type === "corner");

// ── Parse tyres ───────────────────────────────────────────────────────────────
const tyreProperties = data.tyres.properties;
const availableSets  = data.available_sets;

// Build tyre ID → compound lookup
const tyreIdToCompound = {};
for (const set of availableSets) {
  for (const id of set.ids) {
    tyreIdToCompound[id] = set.compound;
  }
}

// ── Parse weather ─────────────────────────────────────────────────────────────
const weatherConditions = data.weather.conditions;
const weatherById = {};
for (const w of weatherConditions) {
  weatherById[w.id] = w;
}

// ── Helper: map weather condition string → multiplier key ────────────────────
function weatherKey(conditionStr) {
  switch (conditionStr) {
    case "dry":        return "dry";
    case "cold":       return "cold";
    case "light_rain": return "lightRain";
    case "heavy_rain": return "heavyRain";
    default:           return "dry";
  }
}

// ── Step 1: Select best tyre for current weather ──────────────────────────────
// Level 1: weather is dry for 100 000s (entire race). No degradation in Level 1.
// Best tyre = highest effective friction = baseFriction * weatherMultiplier

const currentWeather = weatherById[race.startingWeatherId];
const wKey = weatherKey(currentWeather.condition);

let bestCompound = null;
let bestFriction = -Infinity;

for (const [compound, props] of Object.entries(tyreProperties)) {
  // Level 1: no degradation, so totalDegradation = 0
  const friction = calcCurrentTyreFriction(
    // baseFrictionCoefficient from TYRE_PROPERTIES table (not in JSON, use hardcoded table)
    { Soft: 1.8, Medium: 1.7, Hard: 1.6, Intermediate: 1.2, Wet: 1.1 }[compound],
    0, // no degradation
    props[`${wKey}_friction_multiplier`]
  );
  if (friction > bestFriction) {
    bestFriction = friction;
    bestCompound = compound;
  }
}

// Find the tyre ID for the chosen compound
const chosenSet  = availableSets.find((s) => s.compound === bestCompound);
const initialTyreId = chosenSet.ids[0];

console.log(`Best compound: ${bestCompound} (friction=${bestFriction.toFixed(4)}, ID=${initialTyreId})`);

// ── Step 2: Compute max safe speed for each corner ────────────────────────────
// Formula: sqrt(tyreFriction * gravity * radius) + crawlSpeed
// Use 99% of max as a safety margin to guarantee no crash penalty.

const SAFETY_MARGIN = 0.99;

const cornerMaxSpeed = {}; // segmentId → safe entry speed (integer m/s)
for (const corner of corners) {
  const maxSpd = calcMaxCornerSpeed(bestFriction, corner.radius_m, car.crawlSpeed);
  cornerMaxSpeed[corner.id] = Math.floor(maxSpd * SAFETY_MARGIN);
}

console.log("\nCorner safe speeds:");
for (const corner of corners) {
  console.log(`  Seg ${corner.id} (r=${corner.radius_m}m): ${cornerMaxSpeed[corner.id]} m/s`);
}

// ── Step 3: Plan each straight ────────────────────────────────────────────────
// For each straight we need:
//   target_m/s           — highest speed we can reach given entry/exit constraints
//   brake_start_m_before_next — metres from end of straight where braking begins
//
// Physics:
//   accel distance = (vTarget² - vEntry²) / (2 * accel)    [calcDistanceGivenFinalSpeed]
//   brake distance = (vTarget² - vExit²)  / (2 * brake)    [same formula, negative accel]
//   constraint: accelDist + brakeDist <= straightLength

function planStraight(entrySpeed, straightLength, exitSpeed) {
  const vEntry = Math.min(entrySpeed, car.maxSpeed);
  const vExit  = Math.min(exitSpeed,  car.maxSpeed);

  // Binary search for the highest integer target speed that fits
  let lo = Math.max(vEntry, vExit, car.crawlSpeed);
  let hi = car.maxSpeed;

  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    // accelDist: distance to accelerate from vEntry → mid (0 if mid <= vEntry)
    const accelDist = mid > vEntry
      ? calcDistanceGivenFinalSpeed(vEntry, mid, car.accel)
      : 0;
    // brakeDist: distance to decelerate from mid → vExit (0 if mid <= vExit)
    const brakeDist = mid > vExit
      ? calcDistanceGivenFinalSpeed(vExit, mid, car.brake)  // (mid²-vExit²)/(2*brake)
      : 0;

    if (accelDist + brakeDist <= straightLength) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const vTarget = Math.min(Math.floor(lo), car.maxSpeed);

  // Exact brake distance for the chosen target speed
  const brakeDist = vTarget > vExit
    ? calcDistanceGivenFinalSpeed(vExit, vTarget, car.brake)
    : 0;

  // Round up braking start so we never arrive at corner too fast
  const brakeStart = Math.ceil(brakeDist);

  return {
    "target_m/s":                 vTarget,
    brake_start_m_before_next:    Math.min(brakeStart, straightLength),
  };
}

// ── Step 4: Build one lap's segment list ──────────────────────────────────────
// We need the entry speed for each segment, which chains from the previous one.
// - Race starts at 0 m/s (lap 1 only)
// - Subsequent laps start at the exit speed of the last segment (a corner)

function buildLapSegments(lapStartSpeed) {
  const segmentPlan = [];
  let currentSpeed = lapStartSpeed;

  for (let i = 0; i < segments.length; i++) {
    const seg     = segments[i];
    const nextSeg = segments[(i + 1) % segments.length];

    if (seg.type === "straight") {
      // Required exit speed = max safe speed of the very next corner
      const exitSpeed = nextSeg.type === "corner"
        ? cornerMaxSpeed[nextSeg.id]
        : car.crawlSpeed; // Straight→Straight is unusual; be conservative

      const strat = planStraight(currentSpeed, seg.length_m, exitSpeed);

      segmentPlan.push({
        id:   seg.id,
        type: "straight",
        ...strat,
      });

      currentSpeed = exitSpeed; // We arrive at next segment at this speed

    } else {
      // Corner: constant speed, no decision needed in submission JSON
      segmentPlan.push({ id: seg.id, type: "corner" });
      currentSpeed = cornerMaxSpeed[seg.id];
    }
  }

  return { segmentPlan, exitSpeed: currentSpeed };
}

// ── Step 5: Simulate lap times for score estimate ─────────────────────────────
function estimateLapTime(segmentPlan, lapStartSpeed) {
  let time  = 0;
  let speed = lapStartSpeed;

  for (let i = 0; i < segments.length; i++) {
    const seg  = segments[i];
    const plan = segmentPlan.find((p) => p.id === seg.id);

    if (seg.type === "straight") {
      const vTarget    = plan["target_m/s"];
      const brakeStart = plan.brake_start_m_before_next;
      const nextSeg    = segments[(i + 1) % segments.length];
      const vExit      = nextSeg.type === "corner" ? cornerMaxSpeed[nextSeg.id] : car.crawlSpeed;

      let dist = seg.length_m;

      // Acceleration phase
      if (vTarget > speed) {
        const accelDist = calcDistanceGivenFinalSpeed(speed, vTarget, car.accel);
        const accelTime = (vTarget - speed) / car.accel;
        dist  -= Math.min(accelDist, dist);
        time  += accelTime;
        speed  = vTarget;
      }

      // Cruise phase (everything before braking starts)
      const cruiseDist = Math.max(0, dist - brakeStart);
      if (cruiseDist > 0 && speed > 0) {
        time += cruiseDist / speed;
        dist -= cruiseDist;
      }

      // Braking phase
      if (vExit < speed) {
        const brakeTime = (speed - vExit) / car.brake;
        time  += brakeTime;
        speed  = vExit;
      }

    } else {
      // Corner at constant speed
      const cornerSpeed = cornerMaxSpeed[seg.id];
      time  += seg.length_m / cornerSpeed;
      speed  = cornerSpeed;
    }
  }

  return time;
}

// ── Step 6: Assemble submission ───────────────────────────────────────────────
const lap1Result = buildLapSegments(0);
const lapNResult = buildLapSegments(lap1Result.exitSpeed); // steady-state from lap 2+

const laps = [];
for (let lapNum = 1; lapNum <= race.laps; lapNum++) {
  const plan = lapNum === 1 ? lap1Result : lapNResult;
  laps.push({
    lap:      lapNum,
    segments: plan.segmentPlan,
    pit:      { enter: false },
  });
}

const submission = { initial_tyre_id: initialTyreId, laps };

// ── Step 7: Write output.txt ──────────────────────────────────────────────────
const outputPath = path.join(__dirname, "output.txt");
fs.writeFileSync(outputPath, JSON.stringify(submission, null, 2), "utf8");
console.log("\nOutput written to output.txt");

// ── Step 8: Print diagnostics ─────────────────────────────────────────────────
console.log("\n--- Straight plan (Lap 1, entry=0 m/s) ---");
for (const s of lap1Result.segmentPlan.filter((p) => p.type === "straight")) {
  console.log(`  Seg ${s.id}: target=${s["target_m/s"]} m/s, brake=${s.brake_start_m_before_next}m before end`);
}

console.log(`\n--- Straight plan (Lap 2+, entry=${lap1Result.exitSpeed} m/s) ---`);
for (const s of lapNResult.segmentPlan.filter((p) => p.type === "straight")) {
  console.log(`  Seg ${s.id}: target=${s["target_m/s"]} m/s, brake=${s.brake_start_m_before_next}m before end`);
}

const t1 = estimateLapTime(lap1Result.segmentPlan, 0);
const tN = estimateLapTime(lapNResult.segmentPlan, lap1Result.exitSpeed);
const totalTime = t1 + tN * (race.laps - 1);
const score = calcBaseScore(race.timeReference, totalTime);

console.log(`\n--- Time estimate ---`);
console.log(`  Lap 1  : ${t1.toFixed(2)}s`);
console.log(`  Lap 2+ : ${tN.toFixed(2)}s`);
console.log(`  Total  : ${totalTime.toFixed(2)}s  (reference: ${race.timeReference}s)`);
console.log(`  Estimated base score: ${Math.round(score).toLocaleString()}`);