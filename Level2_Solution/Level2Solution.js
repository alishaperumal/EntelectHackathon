'use strict';
const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────
const config   = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'levels', '2.txt'), 'utf8'));
const car      = config.car;
const race     = config.race;
const segments = config.track.segments;

const ACCEL        = car['accel_m/se2'];
const BRAKE        = car['brake_m/se2'];
const MAX_SPEED    = car['max_speed_m/s'];
const CRAWL        = car['crawl_constant_m/s'];
const TANK_CAP     = car['fuel_tank_capacity_l'];
const INITIAL_FUEL = car['initial_fuel_l'];
const K_BASE       = 0.0005;
const K_DRAG       = 0.0000000015;
const GRAVITY      = 9.8;

const TOTAL_LAPS     = race.laps;
const BASE_PIT_TIME  = race['base_pit_stop_time_s'];
const REFUEL_RATE    = race['pit_refuel_rate_l/s'];
const PIT_EXIT_SPEED = race['pit_exit_speed_m/s'];
const TIME_REF       = race['time_reference_s'];
const SOFT_CAP       = race['fuel_soft_cap_limit_l'];

const TYRE_FRICTION = 1.0 * 1.18;
const CHOSEN_TYRE   = 1;

// ─── Physics ──────────────────────────────────────────────────────

function maxCornerSpeed(radius) {
  return Math.sqrt(TYRE_FRICTION * GRAVITY * radius) + CRAWL;
}

// Fuel used travelling distance d, linearly interpolating speed v0→v1
function fuelSegment(v0, v1, d) {
  if (d <= 0) return 0;
  const avg = (v0 + v1) / 2;
  return (K_BASE + K_DRAG * avg * avg) * d;
}

// Time to uniformly accelerate/decelerate from v0 to v1 over distance d
function timeSegment(v0, v1, d) {
  if (d <= 0) return 0;
  // Use kinematics: d = (v0+v1)/2 * t → t = 2d/(v0+v1)
  return (2 * d) / (v0 + v1);
}

// ─── Pre-compute straight metadata ────────────────────────────────
// For each straight, find:
//   exitSpeed  : speed the car must arrive at the end
//   brakeStart : metres before end to start braking
//   peakSpeed  : actual peak speed reached (may be < MAX_SPEED on short straights)
// Also handles consecutive corner groups correctly by taking the minimum
// maxCornerSpeed across ALL corners in the group.

function buildStraightMeta(entrySpeedFn) {
  const meta = {};

  segments.forEach((seg, i) => {
    if (seg.type !== 'straight') return;

    const entrySpeed = entrySpeedFn(i);

    // ── Required exit speed ──────────────────────────────────────
    // Look ahead: if next is a straight → no braking needed
    // If next is corner(s) → take minimum maxCornerSpeed of the entire group
    const nextSeg = segments[i + 1];
    let requiredExit;

    if (!nextSeg || nextSeg.type === 'straight') {
      // No corner ahead — exit at whatever speed we reach
      requiredExit = null; // will be set to peakSpeed below
    } else {
      let minCorner = Infinity;
      for (let j = i + 1; j < segments.length; j++) {
        if (segments[j].type === 'corner') {
          minCorner = Math.min(minCorner, maxCornerSpeed(segments[j].radius_m));
        } else break;
      }
      requiredExit = minCorner;
    }

    // ── Peak speed on this straight ──────────────────────────────
    // Solve: accelDist + brakeDist ≤ seg.length_m
    // accelDist = (peak² - entry²) / 2a
    // brakeDist = (peak² - exit²)  / 2b
    // peak² (1/2a + 1/2b) = length + entry²/2a + exit²/2b
    const exitForCalc  = requiredExit !== null ? requiredExit : CRAWL;
    const A = 1 / (2 * ACCEL);
    const B = 1 / (2 * BRAKE);
    const peakSq = (seg.length_m + entrySpeed ** 2 * A + exitForCalc ** 2 * B) / (A + B);
    const peakSpeed = Math.min(Math.sqrt(Math.max(0, peakSq)), MAX_SPEED);

    // If requiredExit is null (straight→straight), exit at peakSpeed
    const exitSpeed = requiredExit !== null
      ? Math.min(requiredExit, peakSpeed)
      : peakSpeed;

    // ── Brake start distance ─────────────────────────────────────
    const brakeDist  = Math.max(0, (peakSpeed ** 2 - exitSpeed ** 2) / (2 * BRAKE));
    // Round up to nearest 0.01m to guarantee safe braking
    const brakeStart = Math.ceil(brakeDist * 100) / 100;

    meta[seg.id] = { entrySpeed, peakSpeed, exitSpeed, brakeStart };
  });

  return meta;
}

// ─── Lap simulation ───────────────────────────────────────────────
// Simulates one lap given the entry speed at segment 1.
// Returns { time, fuel, exitSpeed } where exitSpeed is the speed
// at which the car completes the final segment.

function simulateLap(entrySpeed, straightMeta) {
  let speed = entrySpeed;
  let time  = 0;
  let fuel  = 0;

  segments.forEach((seg, i) => {
    if (seg.type === 'straight') {
      const m = straightMeta[seg.id];

      // Phase 1: accelerate from current speed to peakSpeed
      const accelDist  = Math.max(0, (m.peakSpeed ** 2 - speed ** 2) / (2 * ACCEL));
      // Phase 3: brake from peakSpeed to exitSpeed
      const brakeDist  = Math.max(0, (m.peakSpeed ** 2 - m.exitSpeed ** 2) / (2 * BRAKE));
      // Phase 2: cruise at peakSpeed
      const cruiseDist = Math.max(0, seg.length_m - accelDist - brakeDist);

      // Fuel
      fuel += fuelSegment(speed,        m.peakSpeed,  accelDist);
      fuel += fuelSegment(m.peakSpeed,  m.peakSpeed,  cruiseDist);
      fuel += fuelSegment(m.peakSpeed,  m.exitSpeed,  brakeDist);

      // Time
      time += timeSegment(speed,        m.peakSpeed,  accelDist);
      time += cruiseDist > 0 ? cruiseDist / m.peakSpeed : 0;
      time += timeSegment(m.peakSpeed,  m.exitSpeed,  brakeDist);

      speed = m.exitSpeed;

    } else {
      // Corner: car enters at `speed` but must stay ≤ maxCornerSpeed
      const maxSpd      = maxCornerSpeed(seg.radius_m);
      const cornerSpeed = Math.min(speed, maxSpd);

      time  += seg.length_m / cornerSpeed;
      fuel  += fuelSegment(cornerSpeed, cornerSpeed, seg.length_m);
      speed  = cornerSpeed;
    }
  });

  return { time, fuel, exitSpeed: speed };
}

// ─── Build initial straight meta (lap 1 starts from rest) ────────
// For laps 2+, entry speed = last segment's exit speed.
// We use an iterative approach: simulate once from 0 to get steady-state
// exit speed, then rebuild meta with that as the recurring entry.

function buildMeta(firstSegEntrySpeed) {
  // We need to know entry speed for each straight, which depends on
  // the exit speed of the previous corner.
  // Build by walking the track once with a given starting speed.
  const entryMap = {};
  let   speed    = firstSegEntrySpeed;

  segments.forEach((seg, i) => {
    if (seg.type === 'straight') {
      entryMap[i] = speed;
      // We'll compute exitSpeed after building meta, for now approximate
      // Use MAX_SPEED as a placeholder — will be refined below
      speed = MAX_SPEED; // will be overwritten by actual exitSpeed
    } else {
      const maxSpd = maxCornerSpeed(seg.radius_m);
      speed = Math.min(speed, maxSpd);
    }
  });

  // Now build proper meta using actual entry speeds
  const meta = {};
  speed = firstSegEntrySpeed;

  segments.forEach((seg, i) => {
    if (seg.type === 'straight') {
      const entrySpeed = speed;

      const nextSeg = segments[i + 1];
      let requiredExit;
      if (!nextSeg || nextSeg.type === 'straight') {
        requiredExit = null;
      } else {
        let minCorner = Infinity;
        for (let j = i + 1; j < segments.length; j++) {
          if (segments[j].type === 'corner') {
            minCorner = Math.min(minCorner, maxCornerSpeed(segments[j].radius_m));
          } else break;
        }
        requiredExit = minCorner;
      }

      const exitForCalc = requiredExit !== null ? requiredExit : 0;
      const A = 1 / (2 * ACCEL);
      const B = 1 / (2 * BRAKE);
      const peakSq    = (seg.length_m + entrySpeed ** 2 * A + exitForCalc ** 2 * B) / (A + B);
      const peakSpeed = Math.min(Math.sqrt(Math.max(0, peakSq)), MAX_SPEED);
      const exitSpeed = requiredExit !== null ? Math.min(requiredExit, peakSpeed) : peakSpeed;
      const brakeDist = Math.max(0, (peakSpeed ** 2 - exitSpeed ** 2) / (2 * BRAKE));
      const brakeStart = Math.ceil(brakeDist * 100) / 100;

      meta[seg.id] = { entrySpeed, peakSpeed, exitSpeed, brakeStart };
      speed = exitSpeed;

    } else {
      const maxSpd = maxCornerSpeed(seg.radius_m);
      speed = Math.min(speed, maxSpd);
    }
  });

  return meta;
}

// Build meta for lap 1 (starts from 0) and steady-state (starts from pit exit or loop)
const metaFromRest    = buildMeta(0);
const metaFromPit     = buildMeta(PIT_EXIT_SPEED);

// Get steady-state entry: simulate one lap from rest, use its exit speed for all subsequent laps
const lap1Result      = simulateLap(0, metaFromRest);
const steadyEntry     = lap1Result.exitSpeed;
const metaSteady      = buildMeta(steadyEntry);

// ─── Fuel per lap lookup ──────────────────────────────────────────
const LAP1_FUEL       = simulateLap(0,            metaFromRest).fuel;
const LAP_PIT_FUEL    = simulateLap(PIT_EXIT_SPEED, metaFromPit).fuel;   // lap after a pit
const LAP_STEADY_FUEL = simulateLap(steadyEntry,  metaSteady).fuel;      // normal laps

const LAP1_TIME       = simulateLap(0,            metaFromRest).time;
const LAP_PIT_TIME    = simulateLap(PIT_EXIT_SPEED, metaFromPit).time;
const LAP_STEADY_TIME = simulateLap(steadyEntry,  metaSteady).time;

// ─── Race simulation with arbitrary pit laps ──────────────────────

function runRace(pitLaps) {
  const pitSet   = new Set(pitLaps);
  let fuel       = INITIAL_FUEL;
  let totalTime  = 0;
  let totalFuel  = 0;
  let lapEntry   = 0;
  let isFromPit  = false;
  const refuels  = {};

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    // Choose correct meta based on how we entered this lap
    const meta   = lap === 1 ? metaFromRest : (isFromPit ? metaFromPit : metaSteady);
    const entry  = lap === 1 ? 0 : (isFromPit ? PIT_EXIT_SPEED : steadyEntry);
    const result = simulateLap(entry, meta);

    totalTime += result.time;
    totalFuel += result.fuel;
    fuel      -= result.fuel;

    if (fuel < -0.001) return null; // ran out of fuel

    isFromPit = false;

    if (pitSet.has(lap) && lap < TOTAL_LAPS) {
      // Calculate fuel needed to reach next pit stop or finish
      const nextPitLap = pitLaps.find(p => p > lap) || TOTAL_LAPS;
      let   needed     = 0;
      let   simFuel    = 0;
      let   fromPitNow = true;

      for (let fl = lap + 1; fl <= nextPitLap; fl++) {
        const m = fromPitNow ? metaFromPit : metaSteady;
        const e = fromPitNow ? PIT_EXIT_SPEED : steadyEntry;
        const r = simulateLap(e, m);
        needed += r.fuel;
        fromPitNow = false;
      }

      // Refuel just enough to reach next stop (or finish) with 0 spare
      const refuel = Math.max(0, Math.min(TANK_CAP - fuel, needed - fuel));
      totalTime   += BASE_PIT_TIME + refuel / REFUEL_RATE;
      fuel        += refuel;
      refuels[lap] = parseFloat(refuel.toFixed(4));
      isFromPit    = true;
    }
  }

  return { totalTime, totalFuel, refuels, fuelLeft: fuel };
}

// ─── Score function ───────────────────────────────────────────────
function score(result) {
  if (!result) return -Infinity;
  const base = 500000 * (TIME_REF / result.totalTime) ** 3;
  const fb   = -500000 * (1 - result.totalFuel / SOFT_CAP) ** 2 + 500000;
  return base + fb;
}

// ─── Optimise pit strategy ────────────────────────────────────────
// Strategy: always run at MAX_SPEED (fastest possible).
// Find the 1 or 2 pit stop laps that maximise score.
// For 2 pit stops, the optimal split is roughly equal thirds of the race.
// We search around the optimal region rather than full O(n²).

console.log('Optimising pit strategy...');

let bestScore  = -Infinity;
let bestPits   = [];
let bestResult = null;

// Try 1 pit stop
for (let p1 = 1; p1 < TOTAL_LAPS; p1++) {
  const r = runRace([p1]);
  const s = score(r);
  if (s > bestScore) {
    bestScore = s; bestPits = [p1]; bestResult = r;
  }
}

// Try 2 pit stops — search full range
for (let p1 = 1; p1 < TOTAL_LAPS - 1; p1++) {
  for (let p2 = p1 + 1; p2 < TOTAL_LAPS; p2++) {
    const r = runRace([p1, p2]);
    const s = score(r);
    if (s > bestScore) {
      bestScore = s; bestPits = [p1, p2]; bestResult = r;
    }
  }
}

// Try 3 pit stops if tank is small relative to fuel use
const lapsPerTank = Math.floor(TANK_CAP / LAP_STEADY_FUEL);
if (lapsPerTank < TOTAL_LAPS / 3) {
  const step = Math.floor(TOTAL_LAPS / 4);
  for (let p1 = step - 3; p1 <= step + 3; p1++) {
    for (let p2 = 2 * step - 3; p2 <= 2 * step + 3; p2++) {
      for (let p3 = 3 * step - 3; p3 <= 3 * step + 3; p3++) {
        if (p1 >= p2 || p2 >= p3 || p3 >= TOTAL_LAPS) continue;
        const r = runRace([p1, p2, p3]);
        const s = score(r);
        if (s > bestScore) {
          bestScore = s; bestPits = [p1, p2, p3]; bestResult = r;
        }
      }
    }
  }
}

console.log('Done.');

// ─── Build submission ─────────────────────────────────────────────
// Use steady-state meta for all laps (same segment actions every lap).
// The simulator handles pit exit speed internally.

const lapSegments = segments.map(seg =>
  seg.type === 'straight'
    ? {
        id:                        seg.id,
        type:                      'straight',
        'target_m/s':              MAX_SPEED,
        brake_start_m_before_next: metaSteady[seg.id].brakeStart,
      }
    : { id: seg.id, type: 'corner' }
);

const laps = [];
for (let lapNum = 1; lapNum <= TOTAL_LAPS; lapNum++) {
  const refuelAmt = bestResult.refuels[lapNum];
  const pit = refuelAmt !== undefined && refuelAmt > 0
    ? { enter: true, fuel_refuel_amount_l: refuelAmt }
    : { enter: false };
  laps.push({
    lap:      lapNum,
    segments: lapSegments.map(s => ({ ...s })),
    pit,
  });
}

fs.writeFileSync(
  path.join(__dirname, 'output.txt'),
  JSON.stringify({ initial_tyre_id: CHOSEN_TYRE, laps }, null, 2)
);

// ─── Summary ─────────────────────────────────────────────────────
const base = 500000 * (TIME_REF / bestResult.totalTime) ** 3;
const fb   = -500000 * (1 - bestResult.totalFuel / SOFT_CAP) ** 2 + 500000;

console.log('\n=== Race Summary ===');
console.log(`Pit stops after laps : ${bestPits.join(', ')}`);
console.log(`Total time           : ${bestResult.totalTime.toFixed(2)}s  (ref: ${TIME_REF}s)`);
console.log(`Total fuel           : ${bestResult.totalFuel.toFixed(3)}L  (cap: ${SOFT_CAP}L)`);
console.log(`Fuel remaining       : ${bestResult.fuelLeft.toFixed(3)}L`);
Object.entries(bestResult.refuels).forEach(([lap, amt]) => {
  const pitTime = BASE_PIT_TIME + amt / REFUEL_RATE;
  console.log(`  Lap ${lap}: refuel ${amt.toFixed(3)}L  (pit time: ${pitTime.toFixed(2)}s)`);
});
console.log(`Base score           : ${base.toFixed(0)}`);
console.log(`Fuel bonus           : ${fb.toFixed(0)}`);
console.log(`Predicted score      : ${(base + fb).toFixed(0)}`);
console.log(`\nOutput written to ${path.join(__dirname, 'output.txt')}`);

// ─── Sanity check ────────────────────────────────────────────────
console.log('\n=== Sanity Check (steady-state lap) ===');
let spd = steadyEntry;
let penalties = 0;
segments.forEach(seg => {
  if (seg.type === 'straight') {
    spd = metaSteady[seg.id].exitSpeed;
  } else {
    const mcs = maxCornerSpeed(seg.radius_m);
    if (spd > mcs + 0.001) {
      penalties++;
      console.log(`  ❌ C${seg.id} r=${seg.radius_m}m: entry=${spd.toFixed(3)} > max=${mcs.toFixed(3)}`);
    }
    spd = Math.min(spd, mcs);
  }
});
console.log(`Corner penalties: ${penalties === 0 ? '0 ✓' : penalties + ' ✗'}`);
console.log(`Steady-state fuel/lap: ${LAP_STEADY_FUEL.toFixed(4)}L`);
console.log(`Laps per tank:         ${Math.floor(TANK_CAP / LAP_STEADY_FUEL)}`);