const fs   = require('fs');
const path = require('path');

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
const REFUEL_RATE    = race['pit_refuel_rate_l/s'];
const PIT_EXIT_SPEED = race['pit_exit_speed_m/s'];
const TIME_REF       = race['time_reference_s'];
const SOFT_CAP       = race['fuel_soft_cap_limit_l'];

const GRAVITY       = 9.8;
const TYRE_FRICTION = 1.0 * 1.18;
const CHOSEN_TYRE   = 1;

function maxCornerSpeed(radius) {
  return Math.sqrt(TYRE_FRICTION * GRAVITY * radius) + CRAWL;
}

function requiredExitSpeed(segIdx) {
  let min = MAX_SPEED;
  for (let i = segIdx + 1; i < segments.length; i++) {
    if (segments[i].type === 'corner') {
      const cs = maxCornerSpeed(segments[i].radius_m);
      if (cs < min) min = cs;
    } else break;
  }
  return min;
}

const straightMeta = {};
segments.forEach((seg, i) => {
  if (seg.type !== 'straight') return;
  const reqExit    = requiredExitSpeed(i);
  const exact      = (MAX_SPEED * MAX_SPEED - reqExit * reqExit) / (2 * BRAKE);
  const brakeStart = Math.ceil(exact * 100) / 100;
  const clamped    = Math.max(0, Math.min(brakeStart, seg.length_m));
  const exitSpeed  = Math.sqrt(Math.max(CRAWL * CRAWL, MAX_SPEED * MAX_SPEED - 2 * BRAKE * clamped));
  straightMeta[seg.id] = { brakeStart: clamped, exitSpeed };
});

function simulateLap(entrySpeed) {
  let speed = entrySpeed, time = 0, fuel = 0;
  segments.forEach((seg, i) => {
    if (seg.type === 'straight') {
      const { brakeStart, exitSpeed } = straightMeta[seg.id];
      const accelDist  = Math.max(0, (MAX_SPEED * MAX_SPEED - speed * speed) / (2 * ACCEL));
      const cruiseDist = Math.max(0, seg.length_m - accelDist - brakeStart);
      time += (MAX_SPEED - speed) / ACCEL + cruiseDist / MAX_SPEED + (MAX_SPEED - exitSpeed) / BRAKE;
      const avg = (speed + MAX_SPEED) / 2;
      fuel += (K_BASE + K_DRAG * avg * avg) * (seg.length_m - brakeStart);
      speed = exitSpeed;
    } else {
      time += seg.length_m / speed;
      fuel += (K_BASE + K_DRAG * speed * speed) * seg.length_m;
    }
  });
  return { time, fuel, exitSpeed: speed };
}

function runRace(pitLap1, pitLap2) {
  const pitSet = new Set([pitLap1, pitLap2]);
  let fuel = INITIAL_FUEL, lapEntry = 0, totalTime = 0, totalFuel = 0;
  const refuels = {};

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    const r = simulateLap(lapEntry);
    totalTime += r.time; totalFuel += r.fuel; fuel -= r.fuel;
    if (fuel < -0.001) return null;

    if (pitSet.has(lap) && lap < TOTAL_LAPS) {
      const nextPit = [...pitSet].filter(p => p > lap)[0] || TOTAL_LAPS;
      let needed = 0, e2 = PIT_EXIT_SPEED;
      for (let fl = lap + 1; fl <= nextPit; fl++) {
        const fr = simulateLap(e2); needed += fr.fuel; e2 = fr.exitSpeed;
      }
      const refuel = Math.max(0, Math.min(TANK_CAP - fuel, needed - fuel));
      totalTime += refuel / REFUEL_RATE + BASE_PIT_TIME;
      fuel += refuel;
      refuels[lap] = parseFloat(refuel.toFixed(6));
      lapEntry = PIT_EXIT_SPEED;
    } else {
      lapEntry = r.exitSpeed;
    }
  }
  return { totalTime, totalFuel, refuels, fuelLeft: fuel };
}

let bestScore = -Infinity, bestPit1 = 0, bestPit2 = 0, bestResult = null;
process.stdout.write('Searching pit strategies...');
for (let p1 = 1; p1 < TOTAL_LAPS - 1; p1++) {
  for (let p2 = p1 + 1; p2 < TOTAL_LAPS; p2++) {
    const r = runRace(p1, p2);
    if (!r) continue;
    const base = 500000 * Math.pow(TIME_REF / r.totalTime, 3);
    const fb   = -500000 * Math.pow(1 - r.totalFuel / SOFT_CAP, 2) + 500000;
    const s    = base + fb;
    if (s > bestScore) { bestScore = s; bestPit1 = p1; bestPit2 = p2; bestResult = r; }
  }
}
console.log(' done.');

const lapSegments = segments.map(seg =>
  seg.type === 'straight'
    ? { id: seg.id, type: 'straight', 'target_m/s': MAX_SPEED,
        brake_start_m_before_next: straightMeta[seg.id].brakeStart }
    : { id: seg.id, type: 'corner' }
);

const laps = [];
for (let lapNum = 1; lapNum <= TOTAL_LAPS; lapNum++) {
  const refuelAmt = bestResult.refuels[lapNum];
  const pit = refuelAmt !== undefined
    ? { enter: true, fuel_refuel_amount_l: refuelAmt }
    : { enter: false };
  laps.push({ lap: lapNum, segments: lapSegments.map(s => ({ ...s })), pit });
}

fs.writeFileSync(path.join(__dirname, 'output.txt'), JSON.stringify({ initial_tyre_id: CHOSEN_TYRE, laps }, null, 2));
console.log(`Output written to ${path.join(__dirname, 'output.txt')}`);

const base = 500000 * Math.pow(TIME_REF / bestResult.totalTime, 3);
const fb   = -500000 * Math.pow(1 - bestResult.totalFuel / SOFT_CAP, 2) + 500000;
console.log('\n=== Race Summary ===');
console.log(`Total time:        ${bestResult.totalTime.toFixed(3)} s`);
console.log(`Total fuel burned: ${bestResult.totalFuel.toFixed(3)} L  (soft cap: ${SOFT_CAP}L)`);
console.log(`Pit stops:         after laps ${bestPit1} and ${bestPit2}`);
Object.entries(bestResult.refuels).forEach(([lap, amt]) => {
  console.log(`  Lap ${lap}: refuel ${amt.toFixed(3)}L → pit time ${(amt / REFUEL_RATE + BASE_PIT_TIME).toFixed(2)}s`);
});
console.log(`Predicted score:   ${(base + fb).toFixed(0)}  (base: ${base.toFixed(0)} + fuel: ${fb.toFixed(0)})`);

let spd = bestResult.fuelLeft >= 0 ? simulateLap(PIT_EXIT_SPEED).exitSpeed : 34.041;
let penalties = 0;
segments.forEach(seg => {
  if (seg.type === 'straight') spd = straightMeta[seg.id].exitSpeed;
  else { const mcs = maxCornerSpeed(seg.radius_m); if (spd > mcs) penalties++; }
});
console.log(`Corner penalties:  ${penalties === 0 ? '0 ✓' : penalties + ' ✗'}`);