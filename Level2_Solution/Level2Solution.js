/**
 * Entelect Grand Prix - Level 2 Solver
 *
 * Key findings:
 *  - Tyre friction = life_span * weather_multiplier = 1.0 * 1.18 = 1.18 (Soft, dry)
 *  - Fuel soft cap (219L) is UNREACHABLE: K_BASE alone costs 311L for 60 laps at 10370m/lap
 *  - Best strategy: always run at max speed (90 m/s), accept the fuel over-cap penalty
 *    (time savings from full speed outweigh the fuel bonus loss by >1.3M points)
 *  - 2 pit stops required (150L tank can't cover 315L fuel burn)
 *  - No tyre change at pit stops (tyres don't degrade in Level 2)
 *  - Pit as LATE as possible to minimise refuel amount at each stop
 *
 * Consecutive straight S9→S10: S9 has no corner after it, so brake=0, exit=90.
 * S10 then brakes for the C11/C12 corner chain.
 */

const fs   = require('fs');
const path = require('path');

// ─── Load config ─────────────────────────────────────────────────────────────
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

const TOTAL_LAPS     = race.laps;
const BASE_PIT_TIME  = race['base_pit_stop_time_s'];
const TYRE_SWAP_TIME = race['pit_tyre_swap_time_s'];
const REFUEL_RATE    = race['pit_refuel_rate_l/s'];
const PIT_EXIT_SPEED = race['pit_exit_speed_m/s'];
const TIME_REF       = race['time_reference_s'];

const GRAVITY        = 9.8;
const TYRE_FRICTION  = 1.0 * 1.18;  // life_span * dry_multiplier for Soft
const CHOSEN_TYRE_ID = 1;            // Soft compound

// ─── Physics helpers ─────────────────────────────────────────────────────────
function maxCornerSpeed(radius) {
  return Math.sqrt(TYRE_FRICTION * GRAVITY * radius) + CRAWL;
}

function fuelUsed(vi, vf, dist) {
  const avg = (vi + vf) / 2;
  return (K_BASE + K_DRAG * avg * avg) * dist;
}

/**
 * Minimum exit speed needed at the end of segment segIdx.
 * Looks ahead through consecutive corners and returns the minimum max corner speed.
 * If the next segment is a straight (or end of track), no braking is needed: returns MAX_SPEED.
 */
function requiredExitSpeed(segIdx) {
  let min = MAX_SPEED;
  for (let i = segIdx + 1; i < segments.length; i++) {
    if (segments[i].type === 'corner') {
      const cs = maxCornerSpeed(segments[i].radius_m);
      if (cs < min) min = cs;
    } else {
      break;
    }
  }
  return min;
}

// ─── Pre-compute straight strategies (same every lap) ────────────────────────
// brakeStart: metres before end of straight to start braking
// exitSpeed:  speed at end of straight after braking
const straightStrategy = {};
segments.forEach((seg, i) => {
  if (seg.type !== 'straight') return;
  const reqExit   = requiredExitSpeed(i);
  const brakeStart = Math.ceil((MAX_SPEED * MAX_SPEED - reqExit * reqExit) / (2 * BRAKE));
  const clamped   = Math.max(0, Math.min(brakeStart, seg.length_m));
  const exitSpeed = Math.sqrt(Math.max(reqExit * reqExit, MAX_SPEED * MAX_SPEED - 2 * BRAKE * clamped));
  straightStrategy[seg.id] = { brakeStart: clamped, exitSpeed, reqExit };
});

// ─── Simulate a single lap ───────────────────────────────────────────────────
function simulateLap(entrySpeed) {
  let speed = entrySpeed, time = 0, fuel = 0;
  segments.forEach((seg, i) => {
    if (seg.type === 'straight') {
      const { brakeStart, exitSpeed } = straightStrategy[seg.id];
      const accelDist  = Math.max(0, (MAX_SPEED * MAX_SPEED - speed * speed) / (2 * ACCEL));
      const cruiseDist = Math.max(0, seg.length_m - accelDist - brakeStart);
      time  += (MAX_SPEED - speed) / ACCEL
             + cruiseDist / MAX_SPEED
             + (MAX_SPEED - exitSpeed) / BRAKE;
      fuel  += fuelUsed(speed, MAX_SPEED, accelDist)
             + fuelUsed(MAX_SPEED, MAX_SPEED, cruiseDist)
             + fuelUsed(MAX_SPEED, exitSpeed, brakeStart);
      speed  = exitSpeed;
    } else {
      time += seg.length_m / speed;
      fuel += fuelUsed(speed, speed, seg.length_m);
    }
  });
  return { time, fuel, exitSpeed: speed };
}

// ─── Pre-calculate per-lap fuel usage ────────────────────────────────────────
// Run through all 60 laps to determine fuel burned each lap (entry speeds matter)
const perLapFuel  = [];
const perLapEntry = [];
{
  let entry = 0;
  for (let lap = 0; lap < TOTAL_LAPS; lap++) {
    perLapEntry.push(entry);
    const r = simulateLap(entry);
    perLapFuel.push(r.fuel);
    entry = r.exitSpeed; // assume no pit for fuel calc (SS quickly reached)
  }
}

// ─── Greedy pit scheduling: pit as late as possible, refuel minimum needed ───
function buildPitSchedule() {
  let fuelInTank = INITIAL_FUEL;
  const pits = {};    // lap number (1-indexed) → refuelAmount

  // We need to track actual entry speeds accounting for pit exits
  let entry = 0;

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    const r = simulateLap(entry);
    fuelInTank -= r.fuel;

    if (lap === TOTAL_LAPS) break; // last lap - no need to pit after finish

    // Will we run out of fuel on the very next lap?
    const nextEntry = pits[lap] !== undefined ? PIT_EXIT_SPEED : r.exitSpeed;
    const nextLapFuel = simulateLap(nextEntry).fuel;

    if (fuelInTank < nextLapFuel) {
      // Must pit now. Calculate how much fuel to add to survive to the next forced pit
      // or the finish — whichever comes first within one tank.
      let cumFuel = 0;
      let e2 = PIT_EXIT_SPEED; // entry after this pit
      for (let futureLap = lap + 1; futureLap <= TOTAL_LAPS; futureLap++) {
        const fr = simulateLap(e2);
        cumFuel += fr.fuel;
        if (cumFuel > TANK_CAP - fuelInTank) {
          // Can't cover this far on a single fill - stop one lap before
          cumFuel -= fr.fuel;
          break;
        }
        e2 = fr.exitSpeed;
      }
      const refuelAmount = parseFloat(Math.min(TANK_CAP - fuelInTank, cumFuel).toFixed(6));
      pits[lap] = refuelAmount;
      fuelInTank += refuelAmount;
      entry = PIT_EXIT_SPEED;
    } else {
      entry = r.exitSpeed;
    }
  }
  return pits;
}

const pitSchedule = buildPitSchedule();

// ─── Build submission JSON ────────────────────────────────────────────────────
// Re-simulate to get exact lap entry speeds and confirm no fuel-out
let lapEntry   = 0;
let fuelInTank = INITIAL_FUEL;
let totalTime  = 0;
let totalFuel  = 0;
const laps     = [];
let penalties  = 0;

for (let lapNum = 1; lapNum <= TOTAL_LAPS; lapNum++) {
  const segments_out = segments.map((seg, i) => {
    if (seg.type === 'straight') {
      const { brakeStart } = straightStrategy[seg.id];
      return {
        id: seg.id,
        type: 'straight',
        'target_m/s': MAX_SPEED,
        brake_start_m_before_next: brakeStart,
      };
    }
    return { id: seg.id, type: 'corner' };
  });

  const pit = pitSchedule[lapNum]
    ? { enter: true, fuel_refuel_amount_l: pitSchedule[lapNum] }
    : { enter: false };

  laps.push({ lap: lapNum, segments: segments_out, pit });

  // Track simulation state
  const r = simulateLap(lapEntry);
  fuelInTank -= r.fuel;
  totalTime  += r.time;
  totalFuel  += r.fuel;

  if (pitSchedule[lapNum]) {
    const refuel   = pitSchedule[lapNum];
    const pitTime  = refuel / REFUEL_RATE + BASE_PIT_TIME;  // no tyre swap
    totalTime     += pitTime;
    fuelInTank    += refuel;
    lapEntry       = PIT_EXIT_SPEED;
  } else {
    lapEntry = r.exitSpeed;
  }
}

// ─── Write output ─────────────────────────────────────────────────────────────
const submission = { initial_tyre_id: CHOSEN_TYRE_ID, laps };
const outPath    = path.join(__dirname, 'output.txt');
fs.writeFileSync(outPath, JSON.stringify(submission, null, 2));
console.log(`Output written to ${outPath}`);

// ─── Summary ─────────────────────────────────────────────────────────────────
const base      = 500000 * Math.pow(TIME_REF / totalTime, 3);
const fuelBonus = -500000 * Math.pow(1 - totalFuel / race['fuel_soft_cap_limit_l'], 2) + 500000;
console.log('\n=== Race Summary ===');
console.log(`Total laps:       ${TOTAL_LAPS}`);
console.log(`Total time:       ${totalTime.toFixed(3)} s`);
console.log(`Total fuel used:  ${totalFuel.toFixed(3)} L  (soft cap: ${race['fuel_soft_cap_limit_l']}L)`);
console.log(`Fuel left in tank: ${fuelInTank.toFixed(3)} L`);
console.log(`Pit stops:        ${Object.keys(pitSchedule).length} (after laps: ${Object.keys(pitSchedule).join(', ')})`);
Object.entries(pitSchedule).forEach(([lap, amount]) => {
  const pitTime = amount / REFUEL_RATE + BASE_PIT_TIME;
  console.log(`  Lap ${lap}: refuel ${amount.toFixed(3)}L → pit time ${pitTime.toFixed(2)}s`);
});
console.log(`Base score:       ${base.toFixed(0)}`);
console.log(`Fuel bonus:       ${fuelBonus.toFixed(0)}`);
console.log(`Total score:      ${(base + fuelBonus).toFixed(0)}`);

// ─── Corner safety check ─────────────────────────────────────────────────────
console.log('\n=== Corner safety (steady-state lap) ===');
let speed = lapEntry; // use final lapEntry which is ~SS
segments.forEach((seg, i) => {
  if (seg.type === 'straight') {
    speed = straightStrategy[seg.id].exitSpeed;
  } else {
    const maxSpd  = maxCornerSpeed(seg.radius_m);
    const penalty = speed > maxSpd;
    if (penalty) penalties++;
    if (penalty) console.log(`  C${seg.id} PENALTY: ${speed.toFixed(3)} > ${maxSpd.toFixed(3)}`);
  }
});
if (penalties === 0) console.log('  All corners safe ✓');