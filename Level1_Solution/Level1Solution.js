/**
 * Entelect Grand Prix - Level 1 Solver
 *
 * Key discovery from simulator logs:
 *   tyre_friction = life_span * weather_multiplier
 *                 = 1.0 * 1.18 = 1.18  (Soft tyre, dry weather)
 *
 * NOT baseFrictionCoefficient * multiplier as the PDF might imply.
 * The life_span value (1.0) IS the starting friction value, not a separate
 * "count of sets". The baseFrictionCoefficient in constants.js is not used
 * by the simulator for max corner speed calculation.
 *
 * Strategy:
 *   - Use Soft tyres (best friction in dry, and tyres don't degrade in Level 1)
 *   - Target speed = 90 m/s (max) on every straight
 *   - Brake point: ceil((90^2 - exitSpeed^2) / (2 * 20)) metres before end
 *   - Exit speed calculated to be safely below maxCornerSpeed of the next
 *     corner (or the minimum across a chain of consecutive corners)
 */

const fs = require('fs');
const path = require('path');

// ─── Load race config ────────────────────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'levels', '1.txt');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const car       = config.car;
const race      = config.race;
const segments  = config.track.segments;
const ACCEL     = car['accel_m/se2'];          // 10
const BRAKE     = car['brake_m/se2'];          // 20
const MAX_SPEED = car['max_speed_m/s'];        // 90
const CRAWL     = car['crawl_constant_m/s'];   // 10
const GRAVITY   = 9.8;
const TOTAL_LAPS = race.laps;                  // 50

// ─── Tyre selection ──────────────────────────────────────────────────────────
// Soft tyre: life_span = 1, dry_friction_multiplier = 1.18
// Tyres don't degrade in Level 1, so friction stays constant.
const CHOSEN_TYRE_ID = 1;   // id:1 → Soft compound
const TYRE_LIFE_SPAN = 1.0;
const DRY_MULTIPLIER = 1.18;
const TYRE_FRICTION  = TYRE_LIFE_SPAN * DRY_MULTIPLIER;  // 1.18

// ─── Physics helpers ─────────────────────────────────────────────────────────

/** Maximum safe entry speed for a corner given current tyre friction */
function maxCornerSpeed(radius) {
  return Math.sqrt(TYRE_FRICTION * GRAVITY * radius) + CRAWL;
}

/**
 * For a straight at segments[segIdx], look ahead through any consecutive
 * corners that immediately follow it and return the minimum max corner speed.
 * This is the speed the car must be doing as it exits the straight.
 */
function requiredExitSpeed(segIdx) {
  let minSpeed = MAX_SPEED;
  for (let i = segIdx + 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'corner') {
      const cs = maxCornerSpeed(seg.radius_m);
      if (cs < minSpeed) minSpeed = cs;
    } else {
      break;
    }
  }
  return minSpeed;
}

/**
 * Build the segment actions for a single straight.
 *
 * target_m/s  : always MAX_SPEED (90)
 * brake_start : ceil of braking distance so exit speed ≤ requiredExit
 *               Using ceil guarantees the car decelerates enough even with
 *               floating-point rounding.
 */
function straightActions(segIdx) {
  const seg      = segments[segIdx];
  const exitNeeded = requiredExitSpeed(segIdx);
  const target   = MAX_SPEED;

  // Distance needed to brake from target down to exitNeeded
  // v² = u² − 2·a·s  →  s = (u² − v²) / (2·a)
  const brakeDist = (target * target - exitNeeded * exitNeeded) / (2 * BRAKE);
  const brakeStart = Math.ceil(brakeDist);

  return {
    id: seg.id,
    type: 'straight',
    'target_m/s': target,
    brake_start_m_before_next: brakeStart,
  };
}

/** Build the segment action for a corner (no parameters needed for L1) */
function cornerActions(seg) {
  return { id: seg.id, type: 'corner' };
}

// ─── Build lap template (same every lap) ─────────────────────────────────────
const lapTemplate = segments.map((seg, i) =>
  seg.type === 'straight' ? straightActions(i) : cornerActions(seg)
);

// ─── Build full submission ────────────────────────────────────────────────────
const laps = [];
for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
  laps.push({
    lap,
    segments: lapTemplate.map(s => ({ ...s })),
    pit: { enter: false },
  });
}

const submission = {
  initial_tyre_id: CHOSEN_TYRE_ID,
  laps,
};

// ─── Write output ─────────────────────────────────────────────────────────────
const outPath = path.join(__dirname, 'output.txt');
fs.writeFileSync(outPath, JSON.stringify(submission, null, 2));
console.log(`Output written to ${outPath}`);

// ─── Quick sanity simulation ──────────────────────────────────────────────────
console.log('\n=== Lap 1 sanity simulation ===');
let speed = 0;
let penaltyCount = 0;
segments.forEach((seg, i) => {
  if (seg.type === 'straight') {
    const act = lapTemplate[i];
    const brakeStart = act.brake_start_m_before_next;
    const target     = act['target_m/s'];
    // Exit speed after braking from target for brakeStart metres
    const exitSpeedSq = target * target - 2 * BRAKE * brakeStart;
    const exitSpeed   = Math.sqrt(Math.max(0, exitSpeedSq));
    console.log(`  S${seg.id}: target=${target} brake@${brakeStart}m exit=${exitSpeed.toFixed(3)}`);
    speed = exitSpeed;
  } else {
    const maxSpd  = maxCornerSpeed(seg.radius_m);
    const penalty = speed > maxSpd;
    if (penalty) penaltyCount++;
    console.log(`  C${seg.id} (r=${seg.radius_m}): entry=${speed.toFixed(3)} max=${maxSpd.toFixed(3)} ${penalty ? 'PENALTY!' : 'OK'}`);
    if (penalty) speed = CRAWL;
  }
});
