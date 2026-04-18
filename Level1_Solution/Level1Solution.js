const fs = require("fs");
const path = require("path");

// ─── Load race config ────────────────────────────────────────────────────────
const configPath = path.join(__dirname, "../levels/1.txt"); // Adjusted to match standard folder structure
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const car = config.car;
const race = config.race;
const segments = config.track.segments;
const ACCEL = car["accel_m/se2"]; // 10
const BRAKE = car["brake_m/se2"]; // 20
const MAX_SPEED = car["max_speed_m/s"]; // 90
const CRAWL = car["crawl_constant_m/s"]; // 10
const GRAVITY = 9.8;
const TOTAL_LAPS = race.laps;

// ─── Tyre selection ──────────────────────────────────────────────────────────
const CHOSEN_TYRE_ID = 1; // id:1 → Soft compound
const TYRE_LIFE_SPAN = 1.0;
const DRY_MULTIPLIER = 1.18;
const TYRE_FRICTION = TYRE_LIFE_SPAN * DRY_MULTIPLIER; // 1.18

// ─── Physics helpers ─────────────────────────────────────────────────────────

/** Maximum safe entry speed for a corner given current tyre friction */
function maxCornerSpeed(radius) {
  return Math.sqrt(TYRE_FRICTION * GRAVITY * radius) + CRAWL;
}

/**
 * For a straight at segments[segIdx], look ahead through any consecutive
 * corners that immediately follow it and return the minimum max corner speed.
 */
function requiredExitSpeed(segIdx) {
  let minSpeed = MAX_SPEED;
  for (let i = segIdx + 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === "corner") {
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
 */
function straightActions(segIdx) {
  const seg = segments[segIdx];
  const exitNeeded = requiredExitSpeed(segIdx);
  const target = MAX_SPEED;

  // Distance needed to brake from target down to exitNeeded
  const brakeDist = (target * target - exitNeeded * exitNeeded) / (2 * BRAKE);

  // OPTIMIZATION: Round up to the nearest 0.1 instead of a full integer (1.0)
  const brakeStart = Math.ceil(brakeDist * 100) / 100;

  return {
    id: seg.id,
    type: "straight",
    "target_m/s": target,
    brake_start_m_before_next: brakeStart,
  };
}

/** Build the segment action for a corner */
function cornerActions(seg) {
  return { id: seg.id, type: "corner" };
}

// ─── Build lap template (same every lap) ─────────────────────────────────────
const lapTemplate = segments.map((seg, i) =>
  seg.type === "straight" ? straightActions(i) : cornerActions(seg),
);

// ─── Build full submission ────────────────────────────────────────────────────
const laps = [];
for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
  laps.push({
    lap,
    segments: lapTemplate.map((s) => ({ ...s })),
    pit: { enter: false },
  });
}

const submission = {
  initial_tyre_id: CHOSEN_TYRE_ID,
  laps,
};

// ─── Write output ─────────────────────────────────────────────────────────────
const outPath = path.join(__dirname, "../output.txt");
fs.writeFileSync(outPath, JSON.stringify(submission, null, 2));
console.log(`Output written to ${outPath}`);