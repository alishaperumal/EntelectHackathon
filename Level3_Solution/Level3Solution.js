"use strict";
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "levels", "3.txt"), "utf8"),
);
const car = config.car;
const race = config.race;
const segments = config.track.segments;
const weather = config.weather.conditions;

const ACCEL = car["accel_m/se2"];
const BRAKE = car["brake_m/se2"];
const MAX_SPEED = car["max_speed_m/s"];
const CRAWL = car["crawl_constant_m/s"];
const TANK_CAP = car["fuel_tank_capacity_l"];
const INITIAL_FUEL = car["initial_fuel_l"];
const K_BASE = 0.0005;
const K_DRAG = 0.0000000015;
const GRAVITY = 9.8;

const TOTAL_LAPS = race.laps;
const BASE_PIT_TIME = race["base_pit_stop_time_s"];
const TYRE_SWAP_TIME = race["pit_tyre_swap_time_s"];
const REFUEL_RATE = race["pit_refuel_rate_l/s"];
const PIT_EXIT_SPEED = race["pit_exit_speed_m/s"];
const TIME_REF = race["time_reference_s"];
const SOFT_CAP = race["fuel_soft_cap_limit_l"];
const START_WEATHER_ID = race["starting_weather_condition_id"];

const TYRE_SETS = config.available_sets;
const TYRE_PROPS = config.tyres.properties;

// ─── Weather cycle ────────────────────────────────────────────────
const startIdx = weather.findIndex((w) => w.id === START_WEATHER_ID);
const WEATHER_CYCLE = [
  ...weather.slice(startIdx),
  ...weather.slice(0, startIdx),
];
const CYCLE_DURATION = WEATHER_CYCLE.reduce((sum, w) => sum + w.duration_s, 0);

function weatherAtTime(elapsedSec) {
  const t = elapsedSec % CYCLE_DURATION;
  let acc = 0;
  for (const w of WEATHER_CYCLE) {
    if (t < acc + w.duration_s) return w;
    acc += w.duration_s;
  }
  return WEATHER_CYCLE[WEATHER_CYCLE.length - 1];
}

const WEATHER_TO_TYRE_KEY = {
  dry: "dry_friction_multiplier",
  cold: "cold_friction_multiplier",
  light_rain: "light_rain_friction_multiplier",
  heavy_rain: "heavy_rain_friction_multiplier",
};

function getFriction(compound, weatherCondition) {
  const p = TYRE_PROPS[compound];
  const key = WEATHER_TO_TYRE_KEY[weatherCondition];
  return p.life_span * p[key];
}

function bestCompoundFor(weatherCondition) {
  let best = null,
    bestF = -Infinity;
  for (const set of TYRE_SETS) {
    const f = getFriction(set.compound, weatherCondition);
    if (f > bestF) {
      bestF = f;
      best = set;
    }
  }
  return { compound: best.compound, tyreId: best.ids[0], friction: bestF };
}

// ─── Physics helpers ──────────────────────────────────────────────
function maxCornerSpeed(radius, friction) {
  return Math.sqrt(friction * GRAVITY * radius) + CRAWL;
}

function fuelForPhase(vStart, vEnd, dist) {
  if (dist <= 0) return 0;
  const avg = (vStart + vEnd) / 2;
  return (K_BASE + K_DRAG * avg * avg) * dist;
}

function timeForPhase(vStart, vEnd, dist) {
  if (dist <= 0) return 0;
  return (2 * dist) / (vStart + vEnd);
}

function weatherTargetSpeed(weatherCondition, compound) {
  const friction = getFriction(compound, weatherCondition);
  const wObj =
    WEATHER_CYCLE.find((w) => w.condition === weatherCondition) ||
    WEATHER_CYCLE[0];
  const accelMult = wObj.acceleration_multiplier;
  const brakeMult = wObj.deceleration_multiplier;
  const effAccel = ACCEL * accelMult;
  const effBrake = BRAKE * brakeMult;

  let minCorner = Infinity;
  for (const seg of segments) {
    if (seg.type === "corner") {
      const mcs = maxCornerSpeed(seg.radius_m, friction);
      if (mcs < minCorner) minCorner = mcs;
    }
  }

  let minStraightLen = Infinity;
  for (const seg of segments) {
    if (seg.type === "straight" && seg.length_m < minStraightLen) {
      minStraightLen = seg.length_m;
    }
  }

  const A = 1 / (2 * effAccel);
  const B = 1 / (2 * effBrake);
  const entry = minCorner;
  const exit = minCorner;
  const peakSq = (minStraightLen + entry ** 2 * A + exit ** 2 * B) / (A + B);
  const peak = Math.min(Math.sqrt(Math.max(0, peakSq)), MAX_SPEED);

  return peak;
}

// ─── NEW: Dynamic lookahead for segment calculations ──────────────
// ─── NEW: Dynamic lookahead for segment calculations ──────────────
function getRequiredExit(segIdx, friction) {
  let minRequiredSpeed = Infinity;

  // Look ahead at all segments after the current straight
  for (let j = segIdx + 1; j < segments.length; j++) {
    if (segments[j].type === "corner") {
      // Find the max safe speed for this corner
      const mcs = maxCornerSpeed(segments[j].radius_m, friction);
      // Keep track of the tightest/slowest corner in this sequence
      minRequiredSpeed = Math.min(minRequiredSpeed, mcs);
    } else {
      // As soon as we hit the next straight, stop looking ahead.
      // The car can use the next straight to brake for subsequent corners.
      break;
    }
  }

  return minRequiredSpeed === Infinity ? null : minRequiredSpeed;
}

// ─── NEW: Simulate lap dynamically segment-by-segment ─────────────
function simulateLap(entrySpeed, weatherTargets, compound, initialTime) {
  let time = 0;
  let fuel = 0;
  let speed = entrySpeed;
  const lapSegs = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Evaluate weather dynamically based on elapsed simulation time
    const wObj = weatherAtTime(initialTime + time);
    const friction = getFriction(compound, wObj.condition);
    const target = weatherTargets.get(wObj.condition) || MAX_SPEED;

    const effAccel = ACCEL * wObj.acceleration_multiplier;
    const effBrake = BRAKE * wObj.deceleration_multiplier;

    if (seg.type === "straight") {
      const reqExit = getRequiredExit(i, friction);
      const exitForCalc = reqExit !== null ? reqExit : target;

      const A = 1 / (2 * effAccel);
      const B = 1 / (2 * effBrake);
      const peakSq =
        (seg.length_m + speed ** 2 * A + exitForCalc ** 2 * B) / (A + B);
      const peak = Math.min(Math.sqrt(Math.max(0, peakSq)), target);
      const exit = reqExit !== null ? Math.min(reqExit, peak) : peak;

      const accelDist = Math.max(0, (peak ** 2 - speed ** 2) / (2 * effAccel));
      const brakeDist = Math.max(0, (peak ** 2 - exit ** 2) / (2 * effBrake));
      const cruiseDist = Math.max(0, seg.length_m - accelDist - brakeDist);

      fuel += fuelForPhase(speed, peak, accelDist);
      fuel += fuelForPhase(peak, peak, cruiseDist);
      fuel += fuelForPhase(peak, exit, brakeDist);

      time += timeForPhase(speed, peak, accelDist);
      time += cruiseDist > 0 ? cruiseDist / peak : 0;
      time += timeForPhase(peak, exit, brakeDist);

      lapSegs.push({
        id: seg.id,
        type: "straight",
        "target_m/s": parseFloat(peak.toFixed(2)),
        brake_start_m_before_next: Math.ceil(brakeDist * 100) / 100,
      });
      speed = exit;
    } else {
      const mcs = maxCornerSpeed(seg.radius_m, friction);
      const cornerSpd = Math.min(speed, mcs);
      fuel += fuelForPhase(cornerSpd, cornerSpd, seg.length_m);
      time += seg.length_m / cornerSpd;
      lapSegs.push({ id: seg.id, type: "corner" });
      speed = cornerSpd;
    }
  }

  return { time, fuel, exitSpeed: speed, lapSegs };
}

// ─── Scoring ──────────────────────────────────────────────────────
function calcScore(totalTime, totalFuel) {
  const base = 500000 * (TIME_REF / totalTime) ** 3;
  const fb = -500000 * (1 - totalFuel / SOFT_CAP) ** 2 + 500000;
  return { base, fb, total: base + fb };
}

// ─── Full race simulation ─────────────────────────────────────────
function runRace(weatherTargets, pitPlan, initialTyreId) {
  const idToCompound = {};
  for (const s of TYRE_SETS) {
    for (const id of s.ids) idToCompound[id] = s.compound;
  }

  let fuel = INITIAL_FUEL;
  let totalTime = 0;
  let totalFuel = 0;
  let lapEntrySpeed = 0;
  let currentTyre = idToCompound[initialTyreId];

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    const result = simulateLap(
      lapEntrySpeed,
      weatherTargets,
      currentTyre,
      totalTime,
    );

    totalTime += result.time;
    totalFuel += result.fuel;
    fuel -= result.fuel;

    if (fuel < -0.001) return null; // out of fuel

    lapEntrySpeed = result.exitSpeed;

    const pit = pitPlan.get(lap);
    if (pit && lap < TOTAL_LAPS) {
      let pitTime = BASE_PIT_TIME;

      if (
        pit.tyreId !== undefined &&
        idToCompound[pit.tyreId] !== currentTyre
      ) {
        pitTime += TYRE_SWAP_TIME;
        currentTyre = idToCompound[pit.tyreId];
      }

      if (pit.refuelTo !== undefined) {
        const refuel = Math.max(
          0,
          Math.min(TANK_CAP - fuel, pit.refuelTo - fuel),
        );
        pitTime += refuel / REFUEL_RATE;
        fuel += refuel;
      }

      totalTime += pitTime;
      lapEntrySpeed = PIT_EXIT_SPEED;
    }
  }

  return { totalTime, totalFuel, fuelLeft: fuel };
}

// ─── Build weather-by-lap table ───────────────────────────────────
function buildWeatherByLap(weatherTargets) {
  const byLap = [];
  let t = 0;
  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    const w = weatherAtTime(t);
    // Attach simulation time so we can calculate exact fuel requirements later
    w.simTime = t;
    byLap.push(w);

    const best = bestCompoundFor(w.condition);
    const r = simulateLap(PIT_EXIT_SPEED, weatherTargets, best.compound, t);
    t += r.time;
  }
  return byLap;
}

// ─── Build tyre pit plan ──────────────────────────────────────────
function buildTyrePlan(weatherByLap) {
  const plan = new Map();
  const usedIds = new Set();

  function pickTyre(compound) {
    const set = TYRE_SETS.find((s) => s.compound === compound);
    if (!set) return null;
    for (const id of set.ids) {
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
    return set.ids[0];
  }

  const initialCompound = bestCompoundFor(weatherByLap[0].condition).compound;
  const initialTyreId = pickTyre(initialCompound);
  let prevCompound = initialCompound;

  for (let lap = 1; lap < TOTAL_LAPS; lap++) {
    const bestNext = bestCompoundFor(weatherByLap[lap].condition);
    if (bestNext.compound !== prevCompound) {
      const id = pickTyre(bestNext.compound);
      plan.set(lap, { tyreId: id });
      prevCompound = bestNext.compound;
    }
  }

  return { plan, initialTyreId };
}

// ─── Add fuel stops ───────────────────────────────────────────────
function addFuelStops(weatherTargets, tyrePlan, initialTyreId, weatherByLap) {
  const fuelPerLap = weatherByLap.map((w) => {
    const best = bestCompoundFor(w.condition);
    return simulateLap(PIT_EXIT_SPEED, weatherTargets, best.compound, w.simTime)
      .fuel;
  });

  const plan = new Map(tyrePlan);
  let fuelInTank = INITIAL_FUEL;

  function fuelToNextPit(fromLap) {
    let need = 2; // buffer
    for (let k = fromLap + 1; k <= TOTAL_LAPS; k++) {
      need += fuelPerLap[k - 1];
      if (k < TOTAL_LAPS && plan.has(k)) break;
    }
    return Math.min(TANK_CAP, need);
  }

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    fuelInTank -= fuelPerLap[lap - 1];

    const existing = plan.get(lap);

    let simFuel = fuelInTank;
    let needsPit = false;
    for (let k = lap + 1; k <= TOTAL_LAPS; k++) {
      simFuel -= fuelPerLap[k - 1];
      if (simFuel < 1) {
        needsPit = true;
        break;
      }
      if (k < TOTAL_LAPS && plan.has(k)) break;
    }

    if (existing && lap < TOTAL_LAPS) {
      const refuelTo = fuelToNextPit(lap);
      existing.refuelTo = refuelTo;
      fuelInTank = refuelTo;
    } else if (needsPit && lap < TOTAL_LAPS) {
      const refuelTo = fuelToNextPit(lap);
      plan.set(lap, { refuelTo });
      fuelInTank = refuelTo;
    }
  }

  return plan;
}

// ─── Evaluate a candidate speed map ──────────────────────────────
function evaluate(weatherTargets) {
  const weatherByLap = buildWeatherByLap(weatherTargets);
  const { plan: tyrePlan, initialTyreId } = buildTyrePlan(weatherByLap);
  const fullPlan = addFuelStops(
    weatherTargets,
    tyrePlan,
    initialTyreId,
    weatherByLap,
  );
  const result = runRace(weatherTargets, fullPlan, initialTyreId);

  if (!result) return null;
  const { base, fb, total } = calcScore(result.totalTime, result.totalFuel);

  return {
    result,
    plan: fullPlan,
    initialTyreId,
    weatherByLap,
    weatherTargets,
    score: total,
    base,
    fb,
  };
}

// ─── Main optimisation ────────────────────────────────────────────
console.log("=== Level 3 Solver: Spa-Francorchamps ===\n");
console.log(`Weather cycle (starting from ID ${START_WEATHER_ID}):`);
WEATHER_CYCLE.forEach((w) => {
  console.log(
    `  ${w.condition.padEnd(12)} duration: ${w.duration_s}s  accel×${w.acceleration_multiplier}  brake×${w.deceleration_multiplier}`,
  );
});
console.log(`Total cycle: ${CYCLE_DURATION}s\n`);

const distinctConditions = [...new Set(WEATHER_CYCLE.map((w) => w.condition))];

console.log("Best tyre per weather:");
for (const cond of distinctConditions) {
  const b = bestCompoundFor(cond);
  const optSpeed = weatherTargetSpeed(cond, b.compound);
  console.log(
    `  ${cond.padEnd(12)} → ${b.compound.padEnd(14)} friction=${b.friction.toFixed(4)}  optSpeed=${optSpeed.toFixed(2)} m/s`,
  );
}
console.log();

const initialTargets = new Map();
for (const cond of distinctConditions) {
  const best = bestCompoundFor(cond);
  initialTargets.set(cond, weatherTargetSpeed(cond, best.compound));
}

console.log("Searching for optimal per-weather target speeds...");

let bestEval = evaluate(initialTargets);
if (!bestEval) {
  const fallback = new Map();
  for (const cond of distinctConditions) fallback.set(cond, MAX_SPEED * 0.6);
  bestEval = evaluate(fallback);
}

const STEP_SIZES = [5, 1, 0.25];

for (const stepSize of STEP_SIZES) {
  let improved = true;
  while (improved) {
    improved = false;
    for (const cond of distinctConditions) {
      const currentSpeed = bestEval.weatherTargets.get(cond);
      let localBest = bestEval;

      for (
        let delta = -stepSize * 4;
        delta <= stepSize * 4;
        delta += stepSize
      ) {
        const candidate = new Map(localBest.weatherTargets);
        const newSpeed = Math.max(
          CRAWL,
          Math.min(MAX_SPEED, currentSpeed + delta),
        );
        if (Math.abs(newSpeed - currentSpeed) < 0.01) continue;
        candidate.set(cond, newSpeed);

        const e = evaluate(candidate);
        if (e && e.score > localBest.score) {
          localBest = e;
        }
      }

      if (localBest !== bestEval) {
        bestEval = localBest;
        improved = true;
      }
    }
  }
}

if (!bestEval) {
  console.log("No valid strategy found.");
  process.exit(1);
}

console.log("\nOptimal per-weather target speeds:");
for (const [cond, spd] of bestEval.weatherTargets) {
  console.log(`  ${cond.padEnd(12)} → ${spd.toFixed(2)} m/s`);
}

// ─── Build submission output ──────────────────────────────────────
const idToCompound = {};
for (const s of TYRE_SETS) {
  for (const id of s.ids) idToCompound[id] = s.compound;
}

const laps = [];
let fuelSim = INITIAL_FUEL;
let timeSim = 0;
let entrySpeed = 0;
let tyre = idToCompound[bestEval.initialTyreId];
const finalPlan = bestEval.plan;

for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
  // Use the newly engineered segment-by-segment simulation loop
  const simResult = simulateLap(
    entrySpeed,
    bestEval.weatherTargets,
    tyre,
    timeSim,
  );

  const pitInfo = finalPlan.get(lap);
  let pitEntry = { enter: false };

  if (pitInfo && lap < TOTAL_LAPS) {
    pitEntry = { enter: true };

    if (pitInfo.tyreId !== undefined && idToCompound[pitInfo.tyreId] !== tyre) {
      pitEntry.tyre_change_set_id = pitInfo.tyreId;
    }

    if (pitInfo.refuelTo !== undefined) {
      const refuel = Math.max(
        0,
        Math.min(TANK_CAP - fuelSim, pitInfo.refuelTo - fuelSim),
      );
      if (refuel > 0.001) {
        pitEntry.fuel_refuel_amount_l = parseFloat(refuel.toFixed(2));
      }
    }

    if (!pitEntry.tyre_change_set_id && !pitEntry.fuel_refuel_amount_l) {
      pitEntry = { enter: false };
    }
  }

  // Push the lap utilizing the dynamic lapSegs from simulateLap
  laps.push({ lap, segments: simResult.lapSegs, pit: pitEntry });

  timeSim += simResult.time;
  fuelSim -= simResult.fuel;
  entrySpeed = simResult.exitSpeed;

  if (pitEntry.enter && lap < TOTAL_LAPS) {
    let ptime = BASE_PIT_TIME;
    if (pitEntry.tyre_change_set_id) {
      ptime += TYRE_SWAP_TIME;
      tyre = idToCompound[pitEntry.tyre_change_set_id];
    }
    if (pitEntry.fuel_refuel_amount_l) {
      ptime += pitEntry.fuel_refuel_amount_l / REFUEL_RATE;
      fuelSim += pitEntry.fuel_refuel_amount_l;
    }
    timeSim += ptime;
    entrySpeed = PIT_EXIT_SPEED;
  }
}

fs.writeFileSync(
  path.join(__dirname, "output.txt"),
  JSON.stringify({ initial_tyre_id: bestEval.initialTyreId, laps }, null, 2),
);

// ─── Summary ─────────────────────────────────────────────────────
const finalScore = calcScore(
  bestEval.result.totalTime,
  bestEval.result.totalFuel,
);

console.log("\n=== Race Summary ===");
console.log(
  `Initial tyre:        ID ${bestEval.initialTyreId} (${idToCompound[bestEval.initialTyreId]})`,
);
console.log(
  `Total time:          ${bestEval.result.totalTime.toFixed(2)}s  (ref: ${TIME_REF}s)`,
);
console.log(
  `Total fuel:          ${bestEval.result.totalFuel.toFixed(3)}L  (soft cap: ${SOFT_CAP}L)`,
);
console.log(`Fuel remaining:      ${bestEval.result.fuelLeft.toFixed(3)}L`);
console.log(
  `Pit stops planned:   ${[...finalPlan.entries()].filter(([l]) => l < TOTAL_LAPS).length}`,
);

for (const [lap, info] of [...finalPlan.entries()].sort(
  (a, b) => a[0] - b[0],
)) {
  if (lap >= TOTAL_LAPS) continue;
  const parts = [];
  if (info.tyreId !== undefined)
    parts.push(`swap to ${idToCompound[info.tyreId]} (ID ${info.tyreId})`);
  if (info.refuelTo !== undefined)
    parts.push(`refuel to ${info.refuelTo.toFixed(1)}L`);
  if (parts.length) console.log(`  Lap ${lap}: ${parts.join(", ")}`);
}

console.log(`\nBase score:          ${finalScore.base.toFixed(0)}`);
console.log(`Fuel bonus:          ${finalScore.fb.toFixed(0)}`);
console.log(`Predicted score:     ${finalScore.total.toFixed(0)}`);
console.log(`\nOutput written to ${path.join(__dirname, "output.txt")}`);
