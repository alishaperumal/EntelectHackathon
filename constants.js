/**
 * ============================================================================
 * 1. CONSTANTS & TABLES
 * ============================================================================
 */

// Degradation Constants [cite: 127]
const CONSTANTS = {
  K_STRAIGHT: 0.0000166,
  K_BRAKING: 0.0398,
  K_CORNER: 0.000265,
  FUEL_K_BASE: 0.0005, // Base fuel consumption rate (L/m) [cite: 159]
  FUEL_K_DRAG: 0.0000000015, // Fuel consumption based on distance [cite: 160]
  GRAVITY: 9.8, // Extrapolated from the corner speed example [cite: 193]
};

// Tyre Compound Properties [cite: 116, 455-513]
const TYRE_PROPERTIES = {
  Soft: {
    baseFrictionCoefficient: 1.8,
    multipliers: { dry: 1.18, cold: 1.0, lightRain: 0.92, heavyRain: 0.8 },
    degradationRates: {
      dry: 0.14,
      cold: 0.11,
      lightRain: 0.12,
      heavyRain: 0.13,
    },
  },
  Medium: {
    baseFrictionCoefficient: 1.7,
    multipliers: { dry: 1.08, cold: 0.97, lightRain: 0.88, heavyRain: 0.74 },
    degradationRates: { dry: 0.1, cold: 0.08, lightRain: 0.09, heavyRain: 0.1 },
  },
  Hard: {
    baseFrictionCoefficient: 1.6,
    multipliers: { dry: 0.98, cold: 0.92, lightRain: 0.82, heavyRain: 0.68 },
    degradationRates: {
      dry: 0.07,
      cold: 0.06,
      lightRain: 0.07,
      heavyRain: 0.08,
    },
  },
  Intermediate: {
    baseFrictionCoefficient: 1.2,
    multipliers: { dry: 0.9, cold: 0.96, lightRain: 1.08, heavyRain: 1.02 },
    degradationRates: {
      dry: 0.11,
      cold: 0.09,
      lightRain: 0.08,
      heavyRain: 0.09,
    },
  },
  Wet: {
    baseFrictionCoefficient: 1.1,
    multipliers: { dry: 0.72, cold: 0.88, lightRain: 1.02, heavyRain: 1.2 },
    degradationRates: {
      dry: 0.16,
      cold: 0.12,
      lightRain: 0.09,
      heavyRain: 0.05,
    },
  },
};

/**
 * ============================================================================
 * 2. KINEMATICS & PHYSICS EQUATIONS
 * ============================================================================
 */

// Time it takes to accelerate/decelerate from initial speed to final speed [cite: 99, 100]
function calcTimeForAcceleration(initialSpeed, finalSpeed, acceleration) {
  return (finalSpeed - initialSpeed) / acceleration;
}

// Maximum allowed corner speed [cite: 191-193]
// Note: Example applies a square root to the first term, which is standard for centripetal force friction.
function calcMaxCornerSpeed(tyreFriction, cornerRadius, crawlConstant) {
  return (
    Math.sqrt(tyreFriction * CONSTANTS.GRAVITY * cornerRadius) + crawlConstant
  );
}

// Speed required to cover a certain distance at a certain time [cite: 560-562]
function calcSpeedGivenDistanceAndTime(lengthMeters, timeSeconds) {
  return lengthMeters / timeSeconds;
}

// Distance if final speed is known instead of time [cite: 563, 564]
function calcDistanceGivenFinalSpeed(initialSpeed, finalSpeed, acceleration) {
  return (
    (Math.pow(finalSpeed, 2) - Math.pow(initialSpeed, 2)) / (2 * acceleration)
  );
}

// Distance if time is known instead of final speed [cite: 565, 566]
function calcDistanceGivenTime(initialSpeed, time, acceleration) {
  return initialSpeed * time + 0.5 * acceleration * Math.pow(time, 2);
}

/**
 * ============================================================================
 * 3. TYRE DEGRADATION EQUATIONS
 * ============================================================================
 */

// Tyre Friction at any given point [cite: 145-147]
function calcCurrentTyreFriction(
  baseFriction,
  totalDegradation,
  weatherMultiplier,
) {
  return (baseFriction - totalDegradation) * weatherMultiplier;
}

// Straight Tyre Degradation [cite: 129, 130]
function calcStraightDegradation(tyreDegRate, trackLength) {
  return tyreDegRate * trackLength * CONSTANTS.K_STRAIGHT;
}

// Braking Tyre Degradation [cite: 131-138]
function calcBrakingDegradation(initialSpeed, finalSpeed, tyreDegRate) {
  const initialTerm = Math.pow(initialSpeed / 100, 2);
  const finalTerm = Math.pow(finalSpeed / 100, 2);
  return (initialTerm - finalTerm) * CONSTANTS.K_BRAKING * tyreDegRate;
}

// Corner Tyre Degradation [cite: 139-143]
function calcCornerDegradation(speed, radius, tyreDegRate) {
  return CONSTANTS.K_CORNER * (Math.pow(speed, 2) / radius) * tyreDegRate;
}

/**
 * ============================================================================
 * 4. FUEL & PIT STOP EQUATIONS
 * ============================================================================
 */

// Fuel Usage per segment [cite: 161, 163]
function calcFuelUsed(initialSpeed, finalSpeed, distance) {
  const averageSpeed = (initialSpeed + finalSpeed) / 2;
  const consumptionFactor =
    CONSTANTS.FUEL_K_BASE + CONSTANTS.FUEL_K_DRAG * Math.pow(averageSpeed, 2);
  return consumptionFactor * distance;
}

// Refuel Time in the pit [cite: 173]
function calcRefuelTime(amountToRefuel, refuelRate) {
  return amountToRefuel / refuelRate;
}

// Total Pit Stop Time [cite: 208, 209]
function calcPitStopTime(refuelTime, pitTyreSwapTime, basePitStopTime) {
  return refuelTime + pitTyreSwapTime + basePitStopTime;
}

/**
 * ============================================================================
 * 5. SCORING EQUATIONS
 * ============================================================================
 */

// Level 1: Base Score [cite: 281, 282]
function calcBaseScore(timeReference, actualRaceTime) {
  return 500000 * Math.pow(timeReference / actualRaceTime, 3);
}

// Level 2 & 3: Fuel Bonus [cite: 283]
function calcFuelBonus(fuelUsed, fuelSoftCapLimit) {
  const capRatio = fuelUsed / fuelSoftCapLimit;
  return -500000 * Math.pow(1 - capRatio, 2) + 500000;
}

// Level 4: Tyre Bonus [cite: 285]
function calcTyreBonus(sumOfTyreDegradation, numberOfBlowouts) {
  return 100000 * sumOfTyreDegradation - 50000 * numberOfBlowouts;
}

// Final Score (Applies universally by dropping bonuses to 0 in lower levels) [cite: 286]
function calcFinalScore(baseScore, tyreBonus = 0, fuelBonus = 0) {
  return baseScore + tyreBonus + fuelBonus;
}
