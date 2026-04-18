// Level 1+ Solution (Includes Full Scoring Simulation & Adjacent Corner Grouping)
const fs = require("fs");
const path = require("path");

// ── Load constants & helpers from root constants.js ──────────────────────────
const CONSTANTS = {
  K_STRAIGHT: 0.0000166,
  K_BRAKING: 0.0398,
  K_CORNER: 0.000265,
  FUEL_K_BASE: 0.0005,
  FUEL_K_DRAG: 0.0000000015,
  GRAVITY: 9.8,
};

function calcMaxCornerSpeed(tyreFriction, cornerRadius, crawlConstant) {
  return (
    Math.sqrt(tyreFriction * CONSTANTS.GRAVITY * cornerRadius) + crawlConstant
  );
}

function calcCurrentTyreFriction(
  baseFriction,
  totalDegradation,
  weatherMultiplier,
) {
  return (baseFriction - totalDegradation) * weatherMultiplier;
}

function calcDistanceGivenFinalSpeed(initialSpeed, finalSpeed, acceleration) {
  return (
    (Math.pow(finalSpeed, 2) - Math.pow(initialSpeed, 2)) / (2 * acceleration)
  );
}

// ── Scoring Helpers ──────────────────────────────────────────────────────────
function calcBaseScore(timeReference, actualRaceTime) {
  return 500000 * Math.pow(timeReference / actualRaceTime, 3);
}

function calcFuelUsed(initialSpeed, finalSpeed, distance) {
  const averageSpeed = (initialSpeed + finalSpeed) / 2;
  const consumptionFactor =
    CONSTANTS.FUEL_K_BASE + CONSTANTS.FUEL_K_DRAG * Math.pow(averageSpeed, 2);
  return consumptionFactor * distance;
}

function calcFuelBonus(fuelUsed, fuelSoftCapLimit) {
  const capRatio = fuelUsed / fuelSoftCapLimit;
  return -500000 * Math.pow(1 - capRatio, 2) + 500000;
}

function calcTyreBonus(sumOfTyreDegradation, numberOfBlowouts) {
  return 100000 * sumOfTyreDegradation - 50000 * numberOfBlowouts;
}

// ── Read input ────────────────────────────────────────────────────────────────
const inputPath = path.join(__dirname, "../levels/1.txt");
let inputData;
try {
  inputData = fs.readFileSync(inputPath, "utf8");
} catch (e) {
  console.error("Could not read input file. Make sure ../levels/1.txt exists.");
  process.exit(1);
}
const data = JSON.parse(inputData);

// ── Parse car ─────────────────────────────────────────────────────────────────
const car = {
  maxSpeed: data.car["max_speed_m/s"],
  accel: data.car["accel_m/se2"],
  brake: data.car["brake_m/se2"],
  limpSpeed: data.car["limp_constant_m/s"],
  crawlSpeed: data.car["crawl_constant_m/s"],
  tankCapacity: data.car["fuel_tank_capacity_l"],
  initialFuel: data.car["initial_fuel_l"],
  fuelConsumption: data.car["fuel_consumption_l/m"],
};

// ── Parse race ────────────────────────────────────────────────────────────────
const race = {
  name: data.race.name,
  laps: data.race.laps,
  basePitTime: data.race["base_pit_stop_time_s"],
  tyrSwapTime: data.race["pit_tyre_swap_time_s"],
  refuelRate: data.race["pit_refuel_rate_l/s"],
  crashPenalty: data.race["corner_crash_penalty_s"],
  pitExitSpeed: data.race["pit_exit_speed_m/s"],
  fuelSoftCap: data.race["fuel_soft_cap_limit_l"] || 999999, // Fallback for level 1
  startingWeatherId: data.race["starting_weather_condition_id"],
  timeReference: data.race["time_reference_s"] || data.race["time_reference"], // Catch typo in some JSONs
};

// ── Parse track ───────────────────────────────────────────────────────────────
const segments = data.track.segments;
const corners = segments.filter((s) => s.type === "corner");

// ── Parse tyres ───────────────────────────────────────────────────────────────
const tyreProperties = data.tyres.properties;
const availableSets = data.available_sets;

// ── Parse weather ─────────────────────────────────────────────────────────────
const weatherConditions = data.weather ? data.weather.conditions : [];
const weatherById = {};
for (const w of weatherConditions) {
  weatherById[w.id] = w;
}

function weatherKey(conditionStr) {
  switch (conditionStr) {
    case "dry":
      return "dry";
    case "cold":
      return "cold";
    case "light_rain":
      return "lightRain";
    case "heavy_rain":
      return "heavyRain";
    default:
      return "dry";
  }
}

// ── Step 1: Select best tyre for current weather ──────────────────────────────
const currentWeather = weatherById[race.startingWeatherId] || {
  condition: "dry",
};
const wKey = weatherKey(currentWeather.condition);

let bestCompound = null;
let bestFriction = -Infinity;
let tyreDegradationRate = 0;

for (const [compound, props] of Object.entries(tyreProperties)) {
  const friction = calcCurrentTyreFriction(
    { Soft: 1.8, Medium: 1.7, Hard: 1.6, Intermediate: 1.2, Wet: 1.1 }[
      compound
    ],
    0,
    props[`${wKey}_friction_multiplier`] ||
      props[`${currentWeather.condition}_friction_multiplier`],
  );
  if (friction > bestFriction) {
    bestFriction = friction;
    bestCompound = compound;
    tyreDegradationRate =
      props[`${wKey}_degradation`] ||
      props[`${currentWeather.condition}_degradation`];
  }
}

const chosenSet = availableSets.find((s) => s.compound === bestCompound);
const initialTyreId = chosenSet.ids[0];

console.log(
  `Best compound: ${bestCompound} (friction=${bestFriction.toFixed(4)}, ID=${initialTyreId})`,
);

// ── Step 2: Compute max safe speed for each corner ────────────────────────────
// Use 99% of max as a safety margin to guarantee no crash penalty due to floating point.
const SAFETY_MARGIN = 0.99;
const cornerMaxSpeed = {};

for (const corner of corners) {
  const maxSpd = calcMaxCornerSpeed(
    bestFriction,
    corner.radius_m,
    car.crawlSpeed,
  );
  cornerMaxSpeed[corner.id] = maxSpd * SAFETY_MARGIN;
}

// ── Step 3: Exact Kinematic calculation for straights ─────────────────────────
function planStraight(entrySpeed, straightLength, exitSpeed) {
  const theoreticalPeakSpeedSquare =
    (2 * car.accel * car.brake * straightLength +
      car.brake * Math.pow(entrySpeed, 2) +
      car.accel * Math.pow(exitSpeed, 2)) /
    (car.accel + car.brake);

  const theoreticalPeakSpeed = Math.sqrt(
    Math.max(0, theoreticalPeakSpeedSquare),
  );
  const actualPeakSpeed = Math.min(theoreticalPeakSpeed, car.maxSpeed);

  const brakingDistance =
    (Math.pow(actualPeakSpeed, 2) - Math.pow(exitSpeed, 2)) / (2 * car.brake);

  return {
    "target_m/s": Number(actualPeakSpeed.toFixed(2)),
    brake_start_m_before_next: Math.max(0, Number(brakingDistance.toFixed(2))),
  };
}

// ── Step 4: Build one lap's segment list with Adjacent Corner Grouping ────────
function buildLapSegments(lapStartSpeed) {
  const segmentPlan = [];
  let currentSpeed = lapStartSpeed;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.type === "straight") {
      let exitSpeed = car.crawlSpeed;
      let j = (i + 1) % segments.length;

      // Look ahead for adjacent corners to find the most restrictive one
      if (segments[j].type === "corner") {
        let minSafeSpeed = cornerMaxSpeed[segments[j].id];
        while (segments[j].type === "corner") {
          minSafeSpeed = Math.min(minSafeSpeed, cornerMaxSpeed[segments[j].id]);
          j = (j + 1) % segments.length;
          if (j === (i + 1) % segments.length) break; // Prevent infinite loop
        }
        exitSpeed = minSafeSpeed;
      }

      const strat = planStraight(currentSpeed, seg.length_m, exitSpeed);

      segmentPlan.push({
        id: seg.id,
        type: "straight",
        ...strat,
      });

      currentSpeed = exitSpeed;
    } else {
      segmentPlan.push({ id: seg.id, type: "corner" });
      currentSpeed = cornerMaxSpeed[seg.id];
    }
  }

  return { segmentPlan, exitSpeed: currentSpeed };
}

// ── Step 5: Simulate Race for Scoring ─────────────────────────────────────────
function simulateRaceAndScore(lapsData) {
  let totalTime = 0;
  let totalFuelUsed = 0;
  let totalTyreWear = 0;
  let speed = 0;

  for (const lap of lapsData) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const plan = lap.segments.find((p) => p.id === seg.id);

      if (seg.type === "straight") {
        const vTarget = plan["target_m/s"];
        const brakeStart = plan.brake_start_m_before_next;

        let j = (i + 1) % segments.length;
        let vExit = car.crawlSpeed;
        if (segments[j].type === "corner") {
          vExit = cornerMaxSpeed[segments[j].id];
          while (segments[j].type === "corner") {
            vExit = Math.min(vExit, cornerMaxSpeed[segments[j].id]);
            j = (j + 1) % segments.length;
            if (j === (i + 1) % segments.length) break;
          }
        }

        let dist = seg.length_m;

        // Acceleration
        if (vTarget > speed) {
          const accelDist = calcDistanceGivenFinalSpeed(
            speed,
            vTarget,
            car.accel,
          );
          const actualAccelDist = Math.min(accelDist, dist);
          totalTime += (vTarget - speed) / car.accel;
          totalFuelUsed += calcFuelUsed(speed, vTarget, actualAccelDist);
          totalTyreWear +=
            tyreDegradationRate * actualAccelDist * CONSTANTS.K_STRAIGHT;
          dist -= actualAccelDist;
          speed = vTarget;
        }

        // Cruise
        const cruiseDist = Math.max(0, dist - brakeStart);
        if (cruiseDist > 0 && speed > 0) {
          totalTime += cruiseDist / speed;
          totalFuelUsed += calcFuelUsed(speed, speed, cruiseDist);
          totalTyreWear +=
            tyreDegradationRate * cruiseDist * CONSTANTS.K_STRAIGHT;
          dist -= cruiseDist;
        }

        // Braking
        if (vExit < speed) {
          totalTime += (speed - vExit) / car.brake;
          totalFuelUsed += calcFuelUsed(speed, vExit, dist);
          totalTyreWear +=
            (Math.pow(speed / 100, 2) - Math.pow(vExit / 100, 2)) *
            CONSTANTS.K_BRAKING *
            tyreDegradationRate;
          speed = vExit;
        }
      } else {
        // Corner
        const cornerSpeed = cornerMaxSpeed[seg.id];
        totalTime += seg.length_m / cornerSpeed;
        totalFuelUsed += calcFuelUsed(cornerSpeed, cornerSpeed, seg.length_m);
        totalTyreWear +=
          CONSTANTS.K_CORNER *
          (Math.pow(cornerSpeed, 2) / seg.radius_m) *
          tyreDegradationRate;
        speed = cornerSpeed;
      }
    }
  }

  const baseScore = calcBaseScore(race.timeReference, totalTime);
  const fuelBonus = race.fuelSoftCap
    ? calcFuelBonus(totalFuelUsed, race.fuelSoftCap)
    : 0;
  const tyreBonus = calcTyreBonus(totalTyreWear, 0); // Assuming 0 blowouts for this deterministic path

  return {
    totalTime,
    totalFuelUsed,
    totalTyreWear,
    baseScore,
    fuelBonus,
    tyreBonus,
    finalScore: baseScore + fuelBonus + tyreBonus,
  };
}

// ── Step 6: Assemble submission ───────────────────────────────────────────────
const lap1Result = buildLapSegments(0);
const lapNResult = buildLapSegments(lap1Result.exitSpeed);

const laps = [];
for (let lapNum = 1; lapNum <= race.laps; lapNum++) {
  const plan = lapNum === 1 ? lap1Result : lapNResult;
  laps.push({
    lap: lapNum,
    segments: plan.segmentPlan,
    pit: { enter: false },
  });
}

const submission = { initial_tyre_id: initialTyreId, laps };

// ── Step 7: Write output.txt ──────────────────────────────────────────────────
const outputPath = path.join(__dirname, "output.txt");
fs.writeFileSync(outputPath, JSON.stringify(submission, null, 2), "utf8");
console.log("\nOutput written to output.txt");

// ── Step 8: Print Diagnostics & Score ─────────────────────────────────────────
const metrics = simulateRaceAndScore(laps);

console.log(`\n--- Race Simulation & Score Estimation ---`);
console.log(
  `  Total Time : ${metrics.totalTime.toFixed(2)}s  (Reference: ${race.timeReference}s)`,
);
console.log(
  `  Total Fuel : ${metrics.totalFuelUsed.toFixed(2)}L (Soft Cap: ${race.fuelSoftCap}L)`,
);
console.log(
  `  Tyre Wear  : ${metrics.totalTyreWear.toFixed(4)} degradation units`,
);
console.log(`------------------------------------------`);
console.log(`  Base Score : ${Math.round(metrics.baseScore).toLocaleString()}`);
console.log(`  Fuel Bonus : ${Math.round(metrics.fuelBonus).toLocaleString()}`);
console.log(`  Tyre Bonus : ${Math.round(metrics.tyreBonus).toLocaleString()}`);
console.log(
  `  FINAL SCORE: ${Math.round(metrics.finalScore).toLocaleString()}`,
);
