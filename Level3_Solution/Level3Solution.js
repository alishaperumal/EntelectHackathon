'use strict';
const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────
const config   = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'levels', '3.txt'), 'utf8'));
const car      = config.car;
const race     = config.race;
const segments = config.track.segments;
const weather  = config.weather.conditions;

const ACCEL        = car['accel_m/se2'];
const BRAKE        = car['brake_m/se2'];
const MAX_SPEED    = car['max_speed_m/s'];
const CRAWL        = car['crawl_constant_m/s'];
const TANK_CAP     = car['fuel_tank_capacity_l'];
const INITIAL_FUEL = car['initial_fuel_l'];
const K_BASE       = 0.0005;
const K_DRAG       = 0.0000000015;
const GRAVITY      = 9.8;

const TOTAL_LAPS      = race.laps;
const BASE_PIT_TIME   = race['base_pit_stop_time_s'];
const TYRE_SWAP_TIME  = race['pit_tyre_swap_time_s'];
const REFUEL_RATE     = race['pit_refuel_rate_l/s'];
const PIT_EXIT_SPEED  = race['pit_exit_speed_m/s'];
const TIME_REF        = race['time_reference_s'];
const SOFT_CAP        = race['fuel_soft_cap_limit_l'];
const START_WEATHER_ID = race['starting_weather_condition_id'];

const TYRE_SETS  = config.available_sets;
const TYRE_PROPS = config.tyres.properties;

// ─── Weather cycle ────────────────────────────────────────────────
const startIdx = weather.findIndex(w => w.id === START_WEATHER_ID);
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

// ─── Tyre friction ─────────────────────────────────────────────────
// Level 3: no degradation. life_span is the base friction coefficient.
// tyre_friction = life_span × weather_multiplier
const WEATHER_TO_TYRE_KEY = {
  dry:         'dry_friction_multiplier',
  cold:        'cold_friction_multiplier',
  light_rain:  'light_rain_friction_multiplier',
  heavy_rain:  'heavy_rain_friction_multiplier',
};

function getFriction(compound, weatherCondition) {
  const p   = TYRE_PROPS[compound];
  const key = WEATHER_TO_TYRE_KEY[weatherCondition];
  return p.life_span * p[key];
}

function bestCompoundFor(weatherCondition) {
  let best = null, bestF = -Infinity;
  for (const set of TYRE_SETS) {
    const f = getFriction(set.compound, weatherCondition);
    if (f > bestF) { bestF = f; best = set; }
  }
  return { compound: best.compound, friction: bestF };
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

// ─── Build straight meta ─────────────────────────────────────────

function computeRequiredExit(segIdx, friction) {
  const next = segments[segIdx + 1];
  if (!next || next.type === 'straight') return null;
  let min = Infinity;
  for (let j = segIdx + 1; j < segments.length; j++) {
    if (segments[j].type === 'corner') {
      min = Math.min(min, maxCornerSpeed(segments[j].radius_m, friction));
    } else break;
  }
  return min;
}

function buildMeta(entrySpeed, targetSpeed, friction, accelMult, brakeMult) {
  const effAccel = ACCEL * accelMult;
  const effBrake = BRAKE * brakeMult;
  const meta     = {};
  let   speed    = entrySpeed;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'straight') {
      const reqExit     = computeRequiredExit(i, friction);
      const exitForCalc = reqExit !== null ? reqExit : 0;

      const A      = 1 / (2 * effAccel);
      const B      = 1 / (2 * effBrake);
      const peakSq = (seg.length_m + speed ** 2 * A + exitForCalc ** 2 * B) / (A + B);
      const peak   = Math.min(Math.sqrt(Math.max(0, peakSq)), targetSpeed);
      const exit   = reqExit !== null ? Math.min(reqExit, peak) : peak;

      const brakeDist  = Math.max(0, (peak ** 2 - exit ** 2) / (2 * effBrake));
      const brakeStart = Math.ceil(brakeDist * 100) / 100;

      meta[seg.id] = { entry: speed, peak, exit, brakeStart, effAccel, effBrake };
      speed = exit;
    } else {
      speed = Math.min(speed, maxCornerSpeed(seg.radius_m, friction));
    }
  }
  return meta;
}

// ─── Simulate one lap ────────────────────────────────────────────

function simulateLap(entrySpeed, targetSpeed, compound, weatherCondition) {
  const friction  = getFriction(compound, weatherCondition);
  const wObj      = WEATHER_CYCLE.find(w => w.condition === weatherCondition) || WEATHER_CYCLE[0];
  const accelMult = wObj.acceleration_multiplier;
  const brakeMult = wObj.deceleration_multiplier;
  const meta      = buildMeta(entrySpeed, targetSpeed, friction, accelMult, brakeMult);

  let time  = 0, fuel = 0, speed = entrySpeed;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'straight') {
      const m          = meta[seg.id];
      const accelDist  = Math.max(0, (m.peak ** 2 - speed ** 2) / (2 * m.effAccel));
      const brakeDist  = Math.max(0, (m.peak ** 2 - m.exit ** 2) / (2 * m.effBrake));
      const cruiseDist = Math.max(0, seg.length_m - accelDist - brakeDist);

      fuel += fuelForPhase(speed,   m.peak, accelDist);
      fuel += fuelForPhase(m.peak,  m.peak, cruiseDist);
      fuel += fuelForPhase(m.peak,  m.exit, brakeDist);

      time += timeForPhase(speed,   m.peak, accelDist);
      time += cruiseDist > 0 ? cruiseDist / m.peak : 0;
      time += timeForPhase(m.peak,  m.exit, brakeDist);

      speed = m.exit;
    } else {
      const mcs       = maxCornerSpeed(seg.radius_m, friction);
      const cornerSpd = Math.min(speed, mcs);
      fuel += fuelForPhase(cornerSpd, cornerSpd, seg.length_m);
      time += seg.length_m / cornerSpd;
      speed = cornerSpd;
    }
  }

  return { time, fuel, exitSpeed: speed, meta };
}

// ─── Scoring ──────────────────────────────────────────────────────
function calcScore(totalTime, totalFuel) {
  const base = 500000 * (TIME_REF / totalTime) ** 3;
  const fb   = -500000 * (1 - totalFuel / SOFT_CAP) ** 2 + 500000;
  return { base, fb, total: base + fb };
}

// ─── Per-weather optimal target speed ────────────────────────────

function weatherTargetSpeed(weatherCondition, compound) {
  const friction  = getFriction(compound, weatherCondition);
  const wObj      = WEATHER_CYCLE.find(w => w.condition === weatherCondition) || WEATHER_CYCLE[0];
  const accelMult = wObj.acceleration_multiplier;
  const brakeMult = wObj.deceleration_multiplier;
  const effAccel  = ACCEL * accelMult;
  const effBrake  = BRAKE * brakeMult;

  let minStraightLen = Infinity;
  for (const seg of segments) {
    if (seg.type === 'straight' && seg.length_m < minStraightLen) {
      minStraightLen = seg.length_m;
    }
  }

  let minCorner = Infinity;
  for (const seg of segments) {
    if (seg.type === 'corner') {
      const mcs = maxCornerSpeed(seg.radius_m, friction);
      if (mcs < minCorner) minCorner = mcs;
    }
  }

  const A      = 1 / (2 * effAccel);
  const B      = 1 / (2 * effBrake);
  const entry  = minCorner;
  const exit   = minCorner;
  const peakSq = (minStraightLen + entry ** 2 * A + exit ** 2 * B) / (A + B);
  return Math.min(Math.sqrt(Math.max(0, peakSq)), MAX_SPEED);
}

// ─── Build accurate weather-by-lap table ─────────────────────────
// KEY FIX: track actual exit speed lap-to-lap so cumulative time is
// accurate, preventing off-by-one errors in weather transition laps.

function buildWeatherByLap(weatherTargets) {
  const byLap = [];
  let t          = 0;
  let entrySpeed = 0;

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    const w    = weatherAtTime(t);
    byLap.push(w);
    const best = bestCompoundFor(w.condition);
    const tgt  = weatherTargets.get(w.condition) || MAX_SPEED;
    const r    = simulateLap(entrySpeed, tgt, best.compound, w.condition);
    t         += r.time;
    entrySpeed = r.exitSpeed;
  }
  return byLap;
}

// ─── Build tyre pit plan ──────────────────────────────────────────
// KEY FIX: swap at end of lap N so lap N+1 STARTS with the right
// compound. This eliminates the one-lap-late crash scenario.

function buildTyrePlan(weatherByLap) {
  const plan    = new Map();
  const usedIds = new Set();

  function pickTyre(compound) {
    const set = TYRE_SETS.find(s => s.compound === compound);
    if (!set) return null;
    for (const id of set.ids) {
      if (!usedIds.has(id)) { usedIds.add(id); return id; }
    }
    return set.ids[0]; // reuse if exhausted
  }

  const initialCompound = bestCompoundFor(weatherByLap[0].condition).compound;
  const initialTyreId   = pickTyre(initialCompound);
  let   currentCompound = initialCompound;

  for (let lap = 1; lap < TOTAL_LAPS; lap++) {
    // weatherByLap[lap] is the weather for lap+1 (0-indexed)
    const neededCompound = bestCompoundFor(weatherByLap[lap].condition).compound;
    if (neededCompound !== currentCompound) {
      plan.set(lap, { tyreId: pickTyre(neededCompound) });
      currentCompound = neededCompound;
    }
  }

  return { plan, initialTyreId };
}

// ─── Add fuel stops ───────────────────────────────────────────────
// KEY FIX: `nextRefuelLap` only counts stops that already have
// refuelTo set, so newly inserted fuel-only stops don't create a chain
// of 1-lap micro-refuels. Each refuel covers the full gap to the
// next planned refueling opportunity.

function addFuelStops(weatherTargets, tyrePlan, initialTyreId, weatherByLap) {
  const fuelPerLap = weatherByLap.map(w => {
    const best = bestCompoundFor(w.condition);
    const tgt  = weatherTargets.get(w.condition) || MAX_SPEED;
    return simulateLap(PIT_EXIT_SPEED, tgt, best.compound, w.condition).fuel;
  });

  const plan       = new Map(tyrePlan);
  let   fuelInTank = INITIAL_FUEL;

  // Find the next lap AFTER fromLap that already has refuelTo assigned.
  // We use a snapshot of the plan at the START of this function — new
  // insertions during the loop must not affect earlier forward-scans.
  // We rebuild this lazily after each insertion.
  function nextRefuelLap(fromLap, currentPlan) {
    for (let k = fromLap + 1; k < TOTAL_LAPS; k++) {
      const p = currentPlan.get(k);
      if (p && p.refuelTo !== undefined) return k;
    }
    return TOTAL_LAPS;
  }

  function fuelNeededFrom(fromLap, toExclusive) {
    let need = 2; // safety buffer
    for (let k = fromLap + 1; k < toExclusive; k++) {
      need += fuelPerLap[k - 1];
    }
    return Math.min(TANK_CAP, need);
  }

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    fuelInTank -= fuelPerLap[lap - 1];

    const existing = plan.get(lap);

    // Snapshot the plan *before* we potentially mutate it this iteration
    const planSnapshot = new Map(plan);

    const stopAt    = nextRefuelLap(lap, planSnapshot);
    let simFuel     = fuelInTank;
    let willRunDry  = false;

    for (let k = lap + 1; k < stopAt && k <= TOTAL_LAPS; k++) {
      simFuel -= fuelPerLap[k - 1];
      if (simFuel < 1) { willRunDry = true; break; }
    }

    if (existing && lap < TOTAL_LAPS) {
      // Always fold a refuel into an existing tyre-swap pit
      const refuelTo = fuelNeededFrom(lap, stopAt);
      existing.refuelTo = refuelTo;
      fuelInTank = refuelTo;
    } else if (willRunDry && lap < TOTAL_LAPS) {
      const refuelTo = fuelNeededFrom(lap, stopAt);
      plan.set(lap, { refuelTo });
      fuelInTank = refuelTo;
    }
  }

  return plan;
}

// ─── Full race simulation ─────────────────────────────────────────

function runRace(weatherTargets, pitPlan, initialTyreId) {
  const idToCompound = {};
  for (const s of TYRE_SETS) for (const id of s.ids) idToCompound[id] = s.compound;

  let fuel          = INITIAL_FUEL;
  let totalTime     = 0;
  let totalFuel     = 0;
  let lapEntrySpeed = 0;
  let currentTyre   = idToCompound[initialTyreId];

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    const wObj   = weatherAtTime(totalTime);
    const target = weatherTargets.get(wObj.condition) || MAX_SPEED;
    const result = simulateLap(lapEntrySpeed, target, currentTyre, wObj.condition);

    totalTime += result.time;
    totalFuel += result.fuel;
    fuel      -= result.fuel;

    if (fuel < -0.001) return null;

    lapEntrySpeed = result.exitSpeed;

    const pit = pitPlan.get(lap);
    if (pit && lap < TOTAL_LAPS) {
      let pitTime = BASE_PIT_TIME;

      if (pit.tyreId !== undefined && idToCompound[pit.tyreId] !== currentTyre) {
        pitTime    += TYRE_SWAP_TIME;
        currentTyre = idToCompound[pit.tyreId];
      }
      if (pit.refuelTo !== undefined) {
        const refuel = Math.max(0, Math.min(TANK_CAP - fuel, pit.refuelTo - fuel));
        pitTime     += refuel / REFUEL_RATE;
        fuel        += refuel;
      }

      totalTime    += pitTime;
      lapEntrySpeed = PIT_EXIT_SPEED;
    }
  }

  return { totalTime, totalFuel, fuelLeft: fuel };
}

// ─── Evaluate a candidate speed map ──────────────────────────────

function evaluate(weatherTargets) {
  const weatherByLap              = buildWeatherByLap(weatherTargets);
  const { plan: tyrePlan, initialTyreId } = buildTyrePlan(weatherByLap);
  const fullPlan                  = addFuelStops(weatherTargets, tyrePlan, initialTyreId, weatherByLap);
  const result                    = runRace(weatherTargets, fullPlan, initialTyreId);
  if (!result) return null;
  const { base, fb, total }       = calcScore(result.totalTime, result.totalFuel);
  return { result, plan: fullPlan, initialTyreId, weatherByLap, weatherTargets, score: total, base, fb };
}

// ─── Main optimisation ────────────────────────────────────────────
console.log('=== Level 3 Solver ===\n');
console.log(`Weather cycle (from ID ${START_WEATHER_ID}):`);
WEATHER_CYCLE.forEach(w =>
  console.log(`  ${w.condition.padEnd(12)} ${w.duration_s}s  accel×${w.acceleration_multiplier}  brake×${w.deceleration_multiplier}`)
);
console.log(`Cycle total: ${CYCLE_DURATION}s\n`);

const distinctConditions = [...new Set(WEATHER_CYCLE.map(w => w.condition))];

console.log('Best tyre + initial speed per weather:');
const initialTargets = new Map();
for (const cond of distinctConditions) {
  const best = bestCompoundFor(cond);
  const spd  = weatherTargetSpeed(cond, best.compound);
  initialTargets.set(cond, spd);
  console.log(`  ${cond.padEnd(12)} → ${best.compound.padEnd(14)} opt=${spd.toFixed(2)} m/s`);
}
console.log();

// ─── Coordinate descent over per-weather speeds ───────────────────
console.log('Optimising per-weather target speeds...');

let bestEval = evaluate(initialTargets);
if (!bestEval) {
  const fallback = new Map(distinctConditions.map(c => [c, MAX_SPEED * 0.7]));
  bestEval = evaluate(fallback);
}

if (!bestEval) {
  console.log('No valid strategy found. Try a lower fallback speed or revise the evaluator.');
  process.exit(1);
}

for (const stepSize of [5, 1, 0.25]) {
  let improved = true;
  while (improved) {
    improved = false;
    for (const cond of distinctConditions) {
      const cur = bestEval.weatherTargets.get(cond);
      for (let delta = -stepSize * 6; delta <= stepSize * 6; delta += stepSize) {
        if (Math.abs(delta) < 0.001) continue;
        const candidate = new Map(bestEval.weatherTargets);
        candidate.set(cond, Math.max(CRAWL, Math.min(MAX_SPEED, cur + delta)));
        const e = evaluate(candidate);
        if (e && e.score > bestEval.score) {
          bestEval = e;
          improved = true;
        }
      }
    }
  }
}

if (!bestEval) { console.log('No valid strategy found.'); process.exit(1); }

console.log('\nOptimal target speeds:');
for (const [cond, spd] of bestEval.weatherTargets) {
  console.log(`  ${cond.padEnd(12)} → ${spd.toFixed(2)} m/s`);
}

// ─── Build submission output ──────────────────────────────────────

const idToCompound = {};
for (const s of TYRE_SETS) for (const id of s.ids) idToCompound[id] = s.compound;

const laps       = [];
let   fuelSim    = INITIAL_FUEL;
let   timeSim    = 0;
let   entrySpeed = 0;
let   tyre       = idToCompound[bestEval.initialTyreId];
const finalPlan  = bestEval.plan;

for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
  const w        = weatherAtTime(timeSim);
  const target   = bestEval.weatherTargets.get(w.condition) || MAX_SPEED;
  const friction = getFriction(tyre, w.condition);
  const wObj     = WEATHER_CYCLE.find(wx => wx.condition === w.condition) || WEATHER_CYCLE[0];
  const meta     = buildMeta(entrySpeed, target, friction,
                             wObj.acceleration_multiplier, wObj.deceleration_multiplier);

  const lapSegs = segments.map(seg =>
    seg.type === 'straight'
      ? {
          id:                        seg.id,
          type:                      'straight',
          'target_m/s':              parseFloat(target.toFixed(2)),
          brake_start_m_before_next: meta[seg.id].brakeStart,
        }
      : { id: seg.id, type: 'corner' }
  );

  const pitInfo  = finalPlan.get(lap);
  let   pitEntry = { enter: false };

  if (pitInfo && lap < TOTAL_LAPS) {
    pitEntry = { enter: true };

    if (pitInfo.tyreId !== undefined && idToCompound[pitInfo.tyreId] !== tyre) {
      pitEntry.tyre_change_set_id = pitInfo.tyreId;
    }
    if (pitInfo.refuelTo !== undefined) {
      const refuel = Math.max(0, Math.min(TANK_CAP - fuelSim, pitInfo.refuelTo - fuelSim));
      if (refuel > 0.01) pitEntry.fuel_refuel_amount_l = parseFloat(refuel.toFixed(2));
    }

    if (!pitEntry.tyre_change_set_id && !pitEntry.fuel_refuel_amount_l) {
      pitEntry = { enter: false };
    }
  }

  laps.push({ lap, segments: lapSegs, pit: pitEntry });

  const simResult = simulateLap(entrySpeed, target, tyre, w.condition);
  timeSim    += simResult.time;
  fuelSim    -= simResult.fuel;
  entrySpeed  = simResult.exitSpeed;

  if (pitEntry.enter && lap < TOTAL_LAPS) {
    let ptime = BASE_PIT_TIME;
    if (pitEntry.tyre_change_set_id) {
      ptime   += TYRE_SWAP_TIME;
      tyre     = idToCompound[pitEntry.tyre_change_set_id];
    }
    if (pitEntry.fuel_refuel_amount_l) {
      ptime   += pitEntry.fuel_refuel_amount_l / REFUEL_RATE;
      fuelSim += pitEntry.fuel_refuel_amount_l;
    }
    timeSim   += ptime;
    entrySpeed = PIT_EXIT_SPEED;
  }
}

fs.writeFileSync(
  path.join(__dirname, 'output.txt'),
  JSON.stringify({ initial_tyre_id: bestEval.initialTyreId, laps }, null, 2)
);

// ─── Summary ─────────────────────────────────────────────────────
const finalScore = calcScore(bestEval.result.totalTime, bestEval.result.totalFuel);

console.log('\n=== Race Summary ===');
console.log(`Initial tyre:        ID ${bestEval.initialTyreId} (${idToCompound[bestEval.initialTyreId]})`);
console.log(`Total time:          ${bestEval.result.totalTime.toFixed(2)}s  (ref: ${TIME_REF}s)`);
console.log(`Total fuel:          ${bestEval.result.totalFuel.toFixed(3)}L  (soft cap: ${SOFT_CAP}L)`);
console.log(`Fuel remaining:      ${bestEval.result.fuelLeft.toFixed(3)}L`);

const actualPits = [...finalPlan.entries()]
  .filter(([l, info]) => l < TOTAL_LAPS && (info.tyreId !== undefined || info.refuelTo !== undefined))
  .sort((a, b) => a[0] - b[0]);

console.log(`Pit stops:           ${actualPits.length}`);
for (const [lap, info] of actualPits) {
  const parts = [];
  if (info.tyreId !== undefined) parts.push(`swap→${idToCompound[info.tyreId]} (ID ${info.tyreId})`);
  if (info.refuelTo !== undefined) parts.push(`refuel→${info.refuelTo.toFixed(1)}L`);
  console.log(`  Lap ${lap}: ${parts.join(', ')}`);
}

console.log(`\nBase score:          ${finalScore.base.toFixed(0)}`);
console.log(`Fuel bonus:          ${finalScore.fb.toFixed(0)}`);
console.log(`Predicted score:     ${finalScore.total.toFixed(0)}`);
console.log(`\nOutput written to ${path.join(__dirname, 'output.txt')}`);