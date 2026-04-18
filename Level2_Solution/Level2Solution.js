const fs = require("fs");
const path = require("path");

// --- Configuration & Constants ---
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "levels", "2.txt"), "utf8"),
);
const car = config.car;
const race = config.race;
const segments = config.track.segments;

const ACCEL = car["accel_m/se2"];
const BRAKE = car["brake_m/se2"];
const MAX_SPEED = car["max_speed_m/s"];
const CRAWL = car["crawl_constant_m/s"];
const TANK_CAP = car["fuel_tank_capacity_l"];
const INITIAL_FUEL = car["initial_fuel_l"];
const K_BASE = 0.0005;
const K_DRAG = 0.0000000015;

const TOTAL_LAPS = race.laps;
const BASE_PIT_TIME = race["base_pit_stop_time_s"];
const REFUEL_RATE = race["pit_refuel_rate_l/s"];
const PIT_EXIT_SPEED = race["pit_exit_speed_m/s"];
const TIME_REF = race["time_reference_s"];
const SOFT_CAP = race["fuel_soft_cap_limit_l"];

const GRAVITY = 9.8;
const TYRE_FRICTION = 1.0 * 1.18; // Default dry friction for Level 1/2
const CHOSEN_TYRE = 1;

// --- Helper Functions ---
function maxCornerSpeed(radius) {
  return Math.sqrt(TYRE_FRICTION * GRAVITY * radius) + CRAWL;
}

function requiredExitSpeed(segIdx) {
  let min = MAX_SPEED;
  for (let i = segIdx + 1; i < segments.length; i++) {
    if (segments[i].type === "corner") {
      const cs = maxCornerSpeed(segments[i].radius_m);
      if (cs < min) min = cs;
    } else break;
  }
  return min;
}

function buildStraightMeta(targetSpeed) {
  const meta = {};
  segments.forEach((seg, i) => {
    if (seg.type !== "straight") return;
    const reqExit = Math.min(targetSpeed, requiredExitSpeed(i));
    const exact = (targetSpeed * targetSpeed - reqExit * reqExit) / (2 * BRAKE);
    const brakeStart = Math.ceil(exact * 10000) / 10000;
    const clamped = Math.max(0, Math.min(brakeStart, seg.length_m));
    const exitSpeed = Math.sqrt(
      Math.max(CRAWL * CRAWL, targetSpeed * targetSpeed - 2 * BRAKE * clamped),
    );
    meta[seg.id] = { brakeStart: clamped, exitSpeed };
  });
  return meta;
}

function simulateLap(entrySpeed, targetSpeed, straightMeta) {
  let speed = entrySpeed,
    time = 0,
    fuel = 0;
  segments.forEach((seg, i) => {
    if (seg.type === "straight") {
      const { brakeStart, exitSpeed } = straightMeta[seg.id];
      const accelDist = Math.max(
        0,
        (targetSpeed * targetSpeed - speed * speed) / (2 * ACCEL),
      );
      const cruiseDist = Math.max(0, seg.length_m - accelDist - brakeStart);
      time +=
        (targetSpeed - speed) / ACCEL +
        cruiseDist / targetSpeed +
        (targetSpeed - exitSpeed) / BRAKE;
      const avg = (speed + targetSpeed) / 2;
      fuel += (K_BASE + K_DRAG * avg * avg) * (seg.length_m - brakeStart);
      speed = exitSpeed;
    } else {
      time += seg.length_m / speed;
      fuel += (K_BASE + K_DRAG * speed * speed) * seg.length_m;
    }
  });
  return { time, fuel, exitSpeed: speed };
}

function runRace(pitLap1, pitLap2, targetSpeed, straightMeta) {
  const pitSet = new Set([pitLap1, pitLap2]);
  let fuel = INITIAL_FUEL,
    lapEntry = 0,
    totalTime = 0,
    totalFuel = 0;
  const refuels = {};

  // Pre-calculate fuel needed for a standard flying lap at this target speed
  const standardLap = simulateLap(targetSpeed, targetSpeed, straightMeta);
  const fuelPerLap = standardLap.fuel;

  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    const r = simulateLap(lapEntry, targetSpeed, straightMeta);
    totalTime += r.time;
    totalFuel += r.fuel;
    fuel -= r.fuel;

    // Limp Mode Trigger
    if (fuel < -0.001) return null;

    if (pitSet.has(lap) && lap < TOTAL_LAPS) {
      const lapsRemaining = TOTAL_LAPS - lap;
      const tankCapacityLaps = Math.floor(TANK_CAP / fuelPerLap);

      let targetLaps;
      if (lapsRemaining <= tankCapacityLaps) {
        // Round down to exactly the laps left
        targetLaps = Math.floor(lapsRemaining);
      } else {
        // Round down to max whole laps the tank allows
        targetLaps = tankCapacityLaps;
      }

      const totalFuelNeeded = targetLaps * fuelPerLap;
      const refuel = Math.max(
        0,
        Math.min(TANK_CAP - fuel, totalFuelNeeded - fuel),
      );

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

// --- Optimization Loop ---
let bestScore = -Infinity,
  bestPit1 = 0,
  bestPit2 = 0,
  bestResult = null;
let optimalTargetSpeed = MAX_SPEED;
let bestStraightMeta = null;

process.stdout.write("Searching optimal speeds and pit strategies...");

// Test target speeds from MAX_SPEED down to 50 m/s
// We step down by 0.5 to balance precision with execution time
for (
  let currentTargetSpeed = MAX_SPEED;
  currentTargetSpeed >= 50;
  currentTargetSpeed -= 0.5
) {
  const currentMeta = buildStraightMeta(currentTargetSpeed);

  // Test combinations of 2 pit stops
  for (let p1 = 1; p1 < TOTAL_LAPS - 1; p1++) {
    for (let p2 = p1 + 1; p2 < TOTAL_LAPS; p2++) {
      const r = runRace(p1, p2, currentTargetSpeed, currentMeta);
      if (!r) continue; // Skip invalid strategies (e.g., ran out of fuel)

      const base = 500000 * Math.pow(TIME_REF / r.totalTime, 3);
      const fb = -500000 * Math.pow(1 - r.totalFuel / SOFT_CAP, 2) + 500000;
      const s = base + fb;

      if (s > bestScore) {
        bestScore = s;
        bestPit1 = p1;
        bestPit2 = p2;
        bestResult = r;
        optimalTargetSpeed = currentTargetSpeed;
        bestStraightMeta = currentMeta;
      }
    }
  }
}
console.log(" done.\n");

// --- Output Generation ---
const lapSegments = segments.map((seg) =>
  seg.type === "straight"
    ? {
        id: seg.id,
        type: "straight",
        "target_m/s": optimalTargetSpeed,
        brake_start_m_before_next: bestStraightMeta[seg.id].brakeStart,
      }
    : { id: seg.id, type: "corner" },
);

const laps = [];
for (let lapNum = 1; lapNum <= TOTAL_LAPS; lapNum++) {
  const refuelAmt = bestResult.refuels[lapNum];
  const pit =
    refuelAmt !== undefined
      ? { enter: true, fuel_refuel_amount_l: refuelAmt }
      : { enter: false };
  laps.push({ lap: lapNum, segments: lapSegments.map((s) => ({ ...s })), pit });
}

fs.writeFileSync(
  path.join(__dirname, "output.txt"),
  JSON.stringify({ initial_tyre_id: CHOSEN_TYRE, laps }, null, 2),
);
console.log(`Output written to ${path.join(__dirname, "output.txt")}\n`);

// --- Final Summary Display ---
const base = 500000 * Math.pow(TIME_REF / bestResult.totalTime, 3);
const fb = -500000 * Math.pow(1 - bestResult.totalFuel / SOFT_CAP, 2) + 500000;

console.log("=== Race Summary ===");
console.log(`Optimal Target Speed: ${optimalTargetSpeed} m/s`);
console.log(`Total time:           ${bestResult.totalTime.toFixed(3)} s`);
console.log(
  `Total fuel burned:    ${bestResult.totalFuel.toFixed(3)} L  (soft cap: ${SOFT_CAP}L)`,
);
console.log(`Pit stops:            after laps ${bestPit1} and ${bestPit2}`);

Object.entries(bestResult.refuels).forEach(([lap, amt]) => {
  console.log(
    `  Lap ${lap}: refuel ${amt.toFixed(3)}L → pit time ${(amt / REFUEL_RATE + BASE_PIT_TIME).toFixed(2)}s`,
  );
});

console.log(
  `Predicted score:      ${(base + fb).toFixed(0)}  (base: ${base.toFixed(0)} + fuel: ${fb.toFixed(0)})`,
);

// Double-check corner penalties to ensure safe taking speeds
let spd =
  bestResult.fuelLeft >= 0
    ? simulateLap(PIT_EXIT_SPEED, optimalTargetSpeed, bestStraightMeta)
        .exitSpeed
    : 34.041;
let penalties = 0;
segments.forEach((seg) => {
  if (seg.type === "straight") {
    spd = bestStraightMeta[seg.id].exitSpeed;
  } else {
    const mcs = maxCornerSpeed(seg.radius_m);
    if (spd > mcs) penalties++;
  }
});
console.log(
  `Corner penalties:     ${penalties === 0 ? "0 ✓" : penalties + " ✗"}`,
);
