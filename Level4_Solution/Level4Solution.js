'use strict';
const fs = require('fs');
const path = require('path');

// ─── Load Configuration ───────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '4.txt'), 'utf8'));
const car = config.car;
const race = config.race;
const segments = config.track.segments;
const weather = config.weather.conditions;

// Car constants
const ACCEL = car['accel_m/se2'];
const BRAKE = car['brake_m/se2'];
const MAX_SPEED = car['max_speed_m/s'];
const CRAWL = car['crawl_constant_m/s'];
const LIMP = car['limp_constant_m/s'];
const TANK_CAP = car['fuel_tank_capacity_l'];
const INITIAL_FUEL = car['initial_fuel_l'];

// Fuel constants
const K_BASE = 0.0005;
const K_DRAG = 0.0000000015;
const GRAVITY = 9.8;

// Race constants
const TOTAL_LAPS = race.laps;
const BASE_PIT_TIME = race['base_pit_stop_time_s'];
const TYRE_SWAP_TIME = race['pit_tyre_swap_time_s'];
const REFUEL_RATE = race['pit_refuel_rate_l/s'];
const PIT_EXIT_SPEED = race['pit_exit_speed_m/s'];
const TIME_REF = race['time_reference_s'];
const SOFT_CAP = race['fuel_soft_cap_limit_l'];
const START_WEATHER_ID = race['starting_weather_condition_id'];

// Tyre degradation constants (from problem statement)
const K_STRAIGHT = 0.0000166;
const K_BRAKING = 0.0398;
const K_CORNER = 0.000265;

// Tyre data
const TYRE_SETS = config.available_sets;
const TYRE_PROPS = config.tyres.properties;

// Track length for lap time estimation
const TRACK_LENGTH = segments.reduce((sum, seg) => sum + seg.length_m, 0);

// ─── Weather Cycle Setup ──────────────────────────────────────────
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

// ─── Tyre Degradation and Friction ────────────────────────────────
const WEATHER_TO_DEG_KEY = {
    dry: 'dry_degradation',
    cold: 'cold_degradation',
    light_rain: 'light_rain_degradation',
    heavy_rain: 'heavy_rain_degradation',
};

const WEATHER_TO_FRIC_KEY = {
    dry: 'dry_friction_multiplier',
    cold: 'cold_friction_multiplier',
    light_rain: 'light_rain_friction_multiplier',
    heavy_rain: 'heavy_rain_friction_multiplier',
};

function getBaseFriction(compound) {
    return TYRE_PROPS[compound].life_span;
}

function getDegradationRate(compound, weatherCondition) {
    const key = WEATHER_TO_DEG_KEY[weatherCondition];
    return TYRE_PROPS[compound][key];
}

function getFrictionMultiplier(compound, weatherCondition) {
    const key = WEATHER_TO_FRIC_KEY[weatherCondition];
    return TYRE_PROPS[compound][key];
}

function calculateCurrentFriction(compound, weatherCondition, totalDegradation) {
    const baseFriction = getBaseFriction(compound);
    const multiplier = getFrictionMultiplier(compound, weatherCondition);
    const remainingFriction = Math.max(0.1, baseFriction - totalDegradation);
    return remainingFriction * multiplier;
}

function maxCornerSpeed(radius, friction) {
    return Math.sqrt(friction * GRAVITY * radius) + CRAWL;
}

// ─── Tyre Degradation Calculations ────────────────────────────────
function degradationStraight(degradationRate, length) {
    return degradationRate * length * K_STRAIGHT;
}

function degradationBraking(degradationRate, vInitial, vFinal) {
    const term = Math.pow(vInitial / 100, 2) - Math.pow(vFinal / 100, 2);
    return term * K_BRAKING * degradationRate;
}

function degradationCorner(degradationRate, speed, radius) {
    return K_CORNER * (speed * speed / radius) * degradationRate;
}

// ─── Fuel Calculations ────────────────────────────────────────────
function fuelForPhase(vStart, vEnd, dist) {
    if (dist <= 0) return 0;
    const avg = (vStart + vEnd) / 2;
    return (K_BASE + K_DRAG * avg * avg) * dist;
}

function timeForPhase(vStart, vEnd, dist) {
    if (dist <= 0) return 0;
    return (2 * dist) / (vStart + vEnd);
}

// ─── Straight Motion Planning with Degradation ────────────────────
function computeRequiredCornerExitSpeed(segIdx, friction, degradation, weatherCond, degradationRate) {
    let minSpeed = Infinity;
    for (let j = segIdx + 1; j < segments.length; j++) {
        if (segments[j].type === 'corner') {
            const currentFriction = calculateCurrentFriction(
                'placeholder', weatherCond, degradation
            );
            const mcs = maxCornerSpeed(segments[j].radius_m, currentFriction);
            minSpeed = Math.min(minSpeed, mcs);
        } else break;
    }
    return minSpeed === Infinity ? null : minSpeed;
}

function simulateStraight(entrySpeed, targetSpeed, length, friction, degradation, 
                          degradationRate, accelMult, brakeMult, weatherCond) {
    const effAccel = ACCEL * accelMult;
    const effBrake = BRAKE * brakeMult;
    
    let currentDegradation = degradation;
    let currentFriction = friction;
    let speed = entrySpeed;
    let totalTime = 0;
    let totalFuel = 0;
    let totalDeg = 0;
    
    // Acceleration phase
    let accelDist = 0;
    let peakSpeed = Math.min(targetSpeed, MAX_SPEED);
    
    if (speed < peakSpeed) {
        const timeToPeak = (peakSpeed - speed) / effAccel;
        accelDist = speed * timeToPeak + 0.5 * effAccel * timeToPeak * timeToPeak;
        accelDist = Math.min(accelDist, length);
        
        if (accelDist > 0) {
            const avgSpeed = (speed + peakSpeed) / 2;
            totalTime += accelDist / avgSpeed;
            totalFuel += fuelForPhase(speed, peakSpeed, accelDist);
            
            // Degradation during acceleration (straight)
            totalDeg += degradationStraight(degradationRate, accelDist);
            
            speed = peakSpeed;
        }
    }
    
    let remainingDist = length - accelDist;
    
    // Cruise phase (constant speed)
    if (remainingDist > 0 && speed > 0) {
        totalTime += remainingDist / speed;
        totalFuel += fuelForPhase(speed, speed, remainingDist);
        totalDeg += degradationStraight(degradationRate, remainingDist);
    }
    
    return {
        exitSpeed: speed,
        time: totalTime,
        fuel: totalFuel,
        degradation: totalDeg,
        brakeStart: length // No braking needed if we don't need to slow
    };
}

function simulateStraightWithBraking(entrySpeed, targetSpeed, exitSpeed, length, 
                                      degradationRate, accelMult, brakeMult) {
    const effAccel = ACCEL * accelMult;
    const effBrake = BRAKE * brakeMult;
    
    let speed = entrySpeed;
    let totalTime = 0;
    let totalFuel = 0;
    let totalDeg = 0;
    let brakeStart = length;
    
    const peakSpeed = Math.min(targetSpeed, MAX_SPEED);
    
    // Acceleration phase
    let accelDist = 0;
    if (speed < peakSpeed) {
        const timeToPeak = (peakSpeed - speed) / effAccel;
        accelDist = speed * timeToPeak + 0.5 * effAccel * timeToPeak * timeToPeak;
        accelDist = Math.min(accelDist, length);
        
        if (accelDist > 0) {
            const avgSpeed = (speed + peakSpeed) / 2;
            totalTime += accelDist / avgSpeed;
            totalFuel += fuelForPhase(speed, peakSpeed, accelDist);
            totalDeg += degradationStraight(degradationRate, accelDist);
            speed = peakSpeed;
        }
    }
    
    let remainingAfterAccel = length - accelDist;
    
    // Braking phase calculation
    let brakeDist = 0;
    if (speed > exitSpeed && remainingAfterAccel > 0) {
        brakeDist = (speed * speed - exitSpeed * exitSpeed) / (2 * effBrake);
        brakeDist = Math.min(brakeDist, remainingAfterAccel);
        
        if (brakeDist > 0) {
            const avgSpeed = (speed + exitSpeed) / 2;
            totalTime += brakeDist / avgSpeed;
            totalFuel += fuelForPhase(speed, exitSpeed, brakeDist);
            totalDeg += degradationBraking(degradationRate, speed, exitSpeed);
            brakeStart = length - brakeDist;
            speed = exitSpeed;
        }
    }
    
    // Cruise phase between accel and brake
    const cruiseDist = remainingAfterAccel - brakeDist;
    if (cruiseDist > 0 && speed > 0) {
        totalTime += cruiseDist / speed;
        totalFuel += fuelForPhase(speed, speed, cruiseDist);
        totalDeg += degradationStraight(degradationRate, cruiseDist);
    }
    
    return {
        exitSpeed: speed,
        time: totalTime,
        fuel: totalFuel,
        degradation: totalDeg,
        brakeStart: brakeStart
    };
}

function simulateCorner(entrySpeed, radius, length, degradationRate, weatherCond, 
                        friction, compound, currentDegradation) {
    const currentFriction = calculateCurrentFriction(compound, weatherCond, currentDegradation);
    const maxAllowedSpeed = maxCornerSpeed(radius, currentFriction);
    const cornerSpeed = Math.min(entrySpeed, maxAllowedSpeed);
    
    let timePenalty = 0;
    let crash = false;
    let finalDegradation = 0;
    
    if (entrySpeed > maxAllowedSpeed) {
        // Crash penalty
        timePenalty = race['corner_crash_penalty_s'];
        crash = true;
        finalDegradation += 0.1; // Flat 0.1 degradation for crash
    }
    
    // Normal corner degradation
    finalDegradation += degradationCorner(degradationRate, cornerSpeed, radius);
    
    const time = (length / cornerSpeed) + timePenalty;
    const fuel = fuelForPhase(cornerSpeed, cornerSpeed, length);
    
    return {
        exitSpeed: cornerSpeed,
        time: time,
        fuel: fuel,
        degradation: finalDegradation,
        crash: crash,
        maxAllowedSpeed: maxAllowedSpeed
    };
}

// ─── Lap Simulation with Full Degradation Tracking ────────────────
function simulateLap(entrySpeed, targetSpeed, compound, weatherCond, initialDegradation, 
                     limpMode, crawlMode) {
    let speed = entrySpeed;
    let time = 0;
    let fuel = 0;
    let degradation = initialDegradation;
    let crashed = false;
    let inLimpMode = limpMode;
    let inCrawlMode = crawlMode;
    
    const degRate = getDegradationRate(compound, weatherCond);
    const frictionMultiplier = getFrictionMultiplier(compound, weatherCond);
    const accelMult = weatherCond.acceleration_multiplier;
    const brakeMult = weatherCond.deceleration_multiplier;
    
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        
        if (inLimpMode) {
            // Limp mode: constant speed, no fuel usage
            const segTime = seg.length_m / LIMP;
            time += segTime;
            speed = LIMP;
            continue;
        }
        
        if (inCrawlMode && seg.type === 'corner') {
            // Crawl mode through corners until straight
            const segTime = seg.length_m / CRAWL;
            time += segTime;
            fuel += fuelForPhase(CRAWL, CRAWL, seg.length_m);
            speed = CRAWL;
            continue;
        }
        
        if (seg.type === 'straight') {
            // Reset crawl mode on straight
            inCrawlMode = false;
            
            // Find required exit speed for upcoming corners
            let requiredExitSpeed = null;
            let minCornerFriction = calculateCurrentFriction(compound, weatherCond, degradation);
            for (let j = i + 1; j < segments.length; j++) {
                if (segments[j].type === 'corner') {
                    const mcs = maxCornerSpeed(segments[j].radius_m, minCornerFriction);
                    if (requiredExitSpeed === null || mcs < requiredExitSpeed) {
                        requiredExitSpeed = mcs;
                    }
                } else break;
            }
            
            let result;
            if (requiredExitSpeed !== null && requiredExitSpeed < speed) {
                result = simulateStraightWithBraking(
                    speed, targetSpeed, requiredExitSpeed, seg.length_m,
                    degRate, accelMult, brakeMult
                );
            } else {
                result = simulateStraight(
                    speed, targetSpeed, seg.length_m, 
                    calculateCurrentFriction(compound, weatherCond, degradation),
                    degradation, degRate, accelMult, brakeMult, weatherCond
                );
            }
            
            time += result.time;
            fuel += result.fuel;
            degradation += result.degradation;
            speed = result.exitSpeed;
            
        } else if (seg.type === 'corner') {
            const currentFriction = calculateCurrentFriction(compound, weatherCond, degradation);
            const result = simulateCorner(
                speed, seg.radius_m, seg.length_m, degRate, weatherCond,
                currentFriction, compound, degradation
            );
            
            time += result.time;
            fuel += result.fuel;
            degradation += result.degradation;
            speed = result.exitSpeed;
            
            if (result.crash) {
                inCrawlMode = true;
                crashed = true;
            }
        }
    }
    
    return {
        time: time,
        fuel: fuel,
        degradation: degradation - initialDegradation,
        totalDegradation: degradation,
        exitSpeed: speed,
        crashed: crashed,
        inLimpMode: inLimpMode,
        inCrawlMode: inCrawlMode
    };
}

// ─── Best Tyre Compound Selection ─────────────────────────────────
function getFrictionForCompound(compound, weatherCond, degradation) {
    const baseFriction = getBaseFriction(compound);
    const multiplier = getFrictionMultiplier(compound, weatherCond);
    const remaining = Math.max(0.1, baseFriction - degradation);
    return remaining * multiplier;
}

function bestCompoundFor(weatherCond, degradation = 0) {
    let best = null;
    let bestFriction = -Infinity;
    
    for (const set of TYRE_SETS) {
        const friction = getFrictionForCompound(set.compound, weatherCond, degradation);
        if (friction > bestFriction) {
            bestFriction = friction;
            best = set;
        }
    }
    return { compound: best.compound, friction: bestFriction };
}

// ─── Estimate Optimal Target Speed for Weather ────────────────────
function estimateOptimalTargetSpeed(weatherCond, compound) {
    const degRate = getDegradationRate(compound, weatherCond.condition);
    const friction = getFrictionForCompound(compound, weatherCond.condition, 0);
    const effAccel = ACCEL * weatherCond.acceleration_multiplier;
    
    // Find minimum corner speed on track
    let minCornerSpeed = Infinity;
    for (const seg of segments) {
        if (seg.type === 'corner') {
            const mcs = maxCornerSpeed(seg.radius_m, friction);
            minCornerSpeed = Math.min(minCornerSpeed, mcs);
        }
    }
    
    // Find shortest straight for acceleration estimation
    let minStraightLen = Infinity;
    for (const seg of segments) {
        if (seg.type === 'straight' && seg.length_m < minStraightLen) {
            minStraightLen = seg.length_m;
        }
    }
    
    // Estimate achievable speed on shortest straight
    if (minStraightLen > 0 && minCornerSpeed < Infinity) {
        // v^2 = u^2 + 2*a*s
        const maxReachable = Math.sqrt(minCornerSpeed * minCornerSpeed + 
                                       2 * effAccel * minStraightLen);
        return Math.min(maxReachable, MAX_SPEED);
    }
    
    return MAX_SPEED * 0.7;
}

// ─── Race Simulation with Pit Strategy ────────────────────────────
function simulateRace(strategy) {
    let currentTime = 0;
    let currentFuel = INITIAL_FUEL;
    let currentDegradation = 0;
    let currentCompound = strategy.initialCompound;
    let currentTyreId = strategy.initialTyreId;
    let lapEntrySpeed = 0;
    let totalFuelUsed = 0;
    let totalDegradation = 0;
    let blowouts = 0;
    let inLimpMode = false;
    let inCrawlMode = false;
    
    const lapResults = [];
    const usedTyreIds = new Set([currentTyreId]);
    let nextPitLap = strategy.pitLaps.length > 0 ? strategy.pitLaps[0] : Infinity;
    let pitIndex = 0;
    
    for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
        const weatherCond = weatherAtTime(currentTime);
        const currentFriction = getFrictionForCompound(currentCompound, weatherCond.condition, currentDegradation);
        
        // Check if we need to pit this lap
        let pitStop = null;
        if (lap === nextPitLap && lap < TOTAL_LAPS) {
            const pitStrategy = strategy.pitLaps[pitIndex];
            pitStop = {
                newTyreId: pitStrategy.tyreId,
                refuelAmount: pitStrategy.refuelAmount
            };
            pitIndex++;
            nextPitLap = pitIndex < strategy.pitLaps.length ? strategy.pitLaps[pitIndex] : Infinity;
        }
        
        // Simulate the lap
        const targetSpeed = strategy.targetSpeeds[weatherCond.condition] || MAX_SPEED * 0.7;
        const lapResult = simulateLap(
            lapEntrySpeed, targetSpeed, currentCompound, 
            weatherCond, currentDegradation, inLimpMode, inCrawlMode
        );
        
        currentTime += lapResult.time;
        currentFuel -= lapResult.fuel;
        totalFuelUsed += lapResult.fuel;
        currentDegradation += lapResult.degradation;
        totalDegradation += lapResult.degradation;
        lapEntrySpeed = lapResult.exitSpeed;
        inLimpMode = lapResult.inLimpMode;
        inCrawlMode = lapResult.inCrawlMode;
        
        // Check for blowout
        if (currentDegradation >= 1.0 && !inLimpMode) {
            blowouts++;
            inLimpMode = true;
        }
        
        // Handle pit stop
        if (pitStop) {
            let pitTime = BASE_PIT_TIME;
            
            // Tyre change
            if (pitStop.newTyreId && pitStop.newTyreId !== currentTyreId) {
                pitTime += TYRE_SWAP_TIME;
                const newSet = TYRE_SETS.find(s => s.ids.includes(pitStop.newTyreId));
                if (newSet) {
                    currentCompound = newSet.compound;
                    currentTyreId = pitStop.newTyreId;
                    usedTyreIds.add(currentTyreId);
                    currentDegradation = 0; // Reset degradation on new tyres
                    inLimpMode = false; // Limp mode ends at pit stop
                }
            }
            
            // Refuel
            if (pitStop.refuelAmount && pitStop.refuelAmount > 0) {
                const actualRefuel = Math.min(pitStop.refuelAmount, TANK_CAP - currentFuel);
                pitTime += actualRefuel / REFUEL_RATE;
                currentFuel += actualRefuel;
            }
            
            currentTime += pitTime;
            lapEntrySpeed = PIT_EXIT_SPEED;
            inCrawlMode = false;
        }
        
        // Check for fuel exhaustion
        if (currentFuel <= 0 && !inLimpMode) {
            inLimpMode = true;
        }
        
        lapResults.push({
            lap,
            time: lapResult.time,
            fuel: lapResult.fuel,
            degradation: lapResult.degradation,
            totalDegradation: currentDegradation,
            compound: currentCompound,
            weather: weatherCond.condition,
            inLimpMode,
            blowout: currentDegradation >= 1.0
        });
    }
    
    return {
        totalTime: currentTime,
        totalFuel: totalFuelUsed,
        totalDegradation: totalDegradation,
        blowouts: blowouts,
        finalDegradation: currentDegradation,
        finalFuel: currentFuel,
        lapResults,
        usedTyreIds: Array.from(usedTyreIds)
    };
}

// ─── Scoring ──────────────────────────────────────────────────────
function calculateScore(totalTime, totalFuel, totalDegradation, blowouts) {
    const baseScore = 500000 * Math.pow(TIME_REF / totalTime, 3);
    
    // Fuel bonus (Levels 2-4)
    let fuelBonus = 0;
    if (totalFuel <= SOFT_CAP) {
        fuelBonus = -500000 * Math.pow(1 - totalFuel / SOFT_CAP, 2) + 500000;
    }
    
    // Tyre bonus (Level 4)
    const tyreBonus = 100000 * totalDegradation - 50000 * blowouts;
    
    const finalScore = baseScore + fuelBonus + tyreBonus;
    
    return {
        baseScore,
        fuelBonus,
        tyreBonus,
        totalScore: finalScore
    };
}

// ─── Pit Stop Strategy Optimization ───────────────────────────────
function optimizePitStrategy(weatherCycle, initialCompound) {
    // Estimate lap time and degradation per lap for each compound
    const lapData = {};
    
    for (const set of TYRE_SETS) {
        const compound = set.compound;
        lapData[compound] = {
            dry: { time: 0, degradation: 0 },
            cold: { time: 0, degradation: 0 },
            light_rain: { time: 0, degradation: 0 },
            heavy_rain: { time: 0, degradation: 0 }
        };
        
        for (const weatherCond of ['dry', 'cold', 'light_rain', 'heavy_rain']) {
            const weatherObj = { condition: weatherCond, acceleration_multiplier: 1, deceleration_multiplier: 1 };
            if (weatherCond === 'cold') {
                weatherObj.acceleration_multiplier = 0.95;
                weatherObj.deceleration_multiplier = 0.95;
            } else if (weatherCond === 'light_rain') {
                weatherObj.acceleration_multiplier = 0.80;
                weatherObj.deceleration_multiplier = 0.80;
            } else if (weatherCond === 'heavy_rain') {
                weatherObj.acceleration_multiplier = 0.70;
                weatherObj.deceleration_multiplier = 0.70;
            }
            
            const sim = simulateLap(0, MAX_SPEED * 0.7, compound, weatherObj, 0, false, false);
            lapData[compound][weatherCond] = {
                time: sim.time,
                degradation: sim.degradation
            };
        }
    }
    
    // Build weather timeline over laps
    let currentTime = 0;
    const weatherByLap = [];
    const degradationRate = 0.07; // Average degradation per lap for Hard tyres
    
    for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
        const weatherCond = weatherAtTime(currentTime);
        weatherByLap.push({
            lap,
            condition: weatherCond.condition,
            startTime: currentTime
        });
        
        // Estimate lap time for this weather
        let estLapTime = 0;
        switch (weatherCond.condition) {
            case 'dry': estLapTime = 82; break;
            case 'cold': estLapTime = 86; break;
            case 'light_rain': estLapTime = 98; break;
            case 'heavy_rain': estLapTime = 115; break;
            default: estLapTime = 90;
        }
        currentTime += estLapTime;
    }
    
    // Determine optimal pit laps based on tyre life and weather changes
    const pitLaps = [];
    let currentDeg = 0;
    const TYRE_LIFE_LIMIT = 0.85; // Pit before blowout
    let lastPitLap = 0;
    
    for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
        const weather = weatherByLap[lap - 1];
        let lapDegradation = 0;
        
        switch (weather.condition) {
            case 'dry': lapDegradation = 0.07; break;
            case 'cold': lapDegradation = 0.06; break;
            case 'light_rain': lapDegradation = 0.07; break;
            case 'heavy_rain': lapDegradation = 0.08; break;
            default: lapDegradation = 0.07;
        }
        
        currentDeg += lapDegradation;
        
        // Check if we need to pit
        const weatherChange = lap < TOTAL_LAPS && 
            weatherByLap[lap] && weatherByLap[lap].condition !== weather.condition;
        
        if (currentDeg >= TYRE_LIFE_LIMIT || (weatherChange && lap - lastPitLap > 10)) {
            if (lap < TOTAL_LAPS - 2) {
                // Determine best tyre for upcoming weather
                let upcomingWeather = weather.condition;
                for (let lookahead = 1; lookahead <= 5 && lap + lookahead <= TOTAL_LAPS; lookahead++) {
                    if (weatherByLap[lap + lookahead - 1]) {
                        upcomingWeather = weatherByLap[lap + lookahead - 1].condition;
                        break;
                    }
                }
                
                let newCompound = 'Hard';
                if (upcomingWeather === 'light_rain' || upcomingWeather === 'heavy_rain') {
                    newCompound = upcomingWeather === 'heavy_rain' ? 'Wet' : 'Intermediate';
                }
                
                const newSet = TYRE_SETS.find(s => s.compound === newCompound);
                if (newSet && newSet.ids.length > 0) {
                    pitLaps.push({
                        lap: lap,
                        tyreId: newSet.ids[0],
                        compound: newCompound,
                        refuelAmount: TANK_CAP * 0.9
                    });
                    currentDeg = 0;
                    lastPitLap = lap;
                }
            }
        }
    }
    
    return pitLaps;
}

// ─── Build Target Speeds for Each Weather Condition ───────────────
function buildTargetSpeeds() {
    const targetSpeeds = {};
    const weatherTypes = ['dry', 'cold', 'light_rain', 'heavy_rain'];
    
    for (const weatherType of weatherTypes) {
        const weatherObj = { condition: weatherType, acceleration_multiplier: 1, deceleration_multiplier: 1 };
        if (weatherType === 'cold') {
            weatherObj.acceleration_multiplier = 0.95;
            weatherObj.deceleration_multiplier = 0.95;
        } else if (weatherType === 'light_rain') {
            weatherObj.acceleration_multiplier = 0.80;
            weatherObj.deceleration_multiplier = 0.80;
        } else if (weatherType === 'heavy_rain') {
            weatherObj.acceleration_multiplier = 0.70;
            weatherObj.deceleration_multiplier = 0.70;
        }
        
        const best = bestCompoundFor(weatherType);
        targetSpeeds[weatherType] = estimateOptimalTargetSpeed(weatherObj, best.compound);
    }
    
    return targetSpeeds;
}

// ─── Build Final Race Strategy ────────────────────────────────────
function buildRaceStrategy() {
    // Get initial weather
    const initialWeather = WEATHER_CYCLE[0];
    const initialBest = bestCompoundFor(initialWeather.condition);
    const initialTyreSet = TYRE_SETS.find(s => s.compound === initialBest.compound);
    const initialTyreId = initialTyreSet ? initialTyreSet.ids[0] : 1;
    
    // Build target speeds
    const targetSpeeds = buildTargetSpeeds();
    
    // Optimize pit strategy
    const pitLaps = optimizePitStrategy(WEATHER_CYCLE, initialBest.compound);
    
    // Add initial fuel top-up if needed
    const pitStops = pitLaps.map(pit => ({
        lap: pit.lap,
        tyreId: pit.tyreId,
        refuelAmount: Math.min(TANK_CAP * 0.85, SOFT_CAP / TOTAL_LAPS * 30)
    }));
    
    return {
        initialTyreId: initialTyreId,
        initialCompound: initialBest.compound,
        targetSpeeds: targetSpeeds,
        pitLaps: pitStops
    };
}

// ─── Build Output JSON ────────────────────────────────────────────
function buildOutput(strategy, simulation) {
    let currentTime = 0;
    let currentFuel = INITIAL_FUEL;
    let currentDegradation = 0;
    let currentCompound = strategy.initialCompound;
    let currentTyreId = strategy.initialTyreId;
    let lapEntrySpeed = 0;
    let inLimpMode = false;
    let inCrawlMode = false;
    
    const laps = [];
    let nextPitLap = strategy.pitLaps.length > 0 ? strategy.pitLaps[0].lap : Infinity;
    let pitIndex = 0;
    
    for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
        const weatherCond = weatherAtTime(currentTime);
        
        // Check for pit stop this lap
        let pitStop = null;
        if (lap === nextPitLap && lap < TOTAL_LAPS) {
            const pitStrategy = strategy.pitLaps[pitIndex];
            pitStop = {
                enter: true
            };
            if (pitStrategy.tyreId && pitStrategy.tyreId !== currentTyreId) {
                pitStop.tyre_change_set_id = pitStrategy.tyreId;
            }
            if (pitStrategy.refuelAmount && pitStrategy.refuelAmount > 0) {
                const currentFuelLevel = currentFuel;
                const refuelNeeded = Math.min(pitStrategy.refuelAmount, TANK_CAP - currentFuelLevel);
                if (refuelNeeded > 0.01) {
                    pitStop.fuel_refuel_amount_l = parseFloat(refuelNeeded.toFixed(2));
                }
            }
            if (!pitStop.tyre_change_set_id && !pitStop.fuel_refuel_amount_l) {
                pitStop.enter = false;
            }
            pitIndex++;
            nextPitLap = pitIndex < strategy.pitLaps.length ? strategy.pitLaps[pitIndex].lap : Infinity;
        }
        
        // Build segment actions
        const targetSpeed = strategy.targetSpeeds[weatherCond.condition] || MAX_SPEED * 0.7;
        const degRate = getDegradationRate(currentCompound, weatherCond.condition);
        const accelMult = weatherCond.acceleration_multiplier;
        const brakeMult = weatherCond.deceleration_multiplier;
        
        const segmentActions = [];
        let speed = lapEntrySpeed;
        let currentSegDegradation = currentDegradation;
        
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            
            if (seg.type === 'straight') {
                // Find required exit speed for upcoming corners
                let requiredExitSpeed = null;
                for (let j = i + 1; j < segments.length; j++) {
                    if (segments[j].type === 'corner') {
                        const friction = getFrictionForCompound(currentCompound, weatherCond.condition, currentSegDegradation);
                        const mcs = maxCornerSpeed(segments[j].radius_m, friction);
                        if (requiredExitSpeed === null || mcs < requiredExitSpeed) {
                            requiredExitSpeed = mcs;
                        }
                    } else break;
                }
                
                let brakeStart = seg.length_m;
                if (requiredExitSpeed !== null && requiredExitSpeed < targetSpeed) {
                    const effBrake = BRAKE * brakeMult;
                    const brakeDist = (targetSpeed * targetSpeed - requiredExitSpeed * requiredExitSpeed) / (2 * effBrake);
                    brakeStart = Math.max(0, seg.length_m - brakeDist);
                }
                
                segmentActions.push({
                    id: seg.id,
                    type: 'straight',
                    "target_m/s": parseFloat(targetSpeed.toFixed(2)),
                    brake_start_m_before_next: parseFloat(brakeStart.toFixed(2))
                });
                
                // Update speed for simulation continuity
                if (requiredExitSpeed !== null && requiredExitSpeed < targetSpeed) {
                    speed = requiredExitSpeed;
                } else {
                    speed = targetSpeed;
                }
                
                // Degradation on straight
                currentSegDegradation += degradationStraight(degRate, seg.length_m);
                
            } else {
                const friction = getFrictionForCompound(currentCompound, weatherCond.condition, currentSegDegradation);
                const maxSpeed = maxCornerSpeed(seg.radius_m, friction);
                const cornerSpeed = Math.min(speed, maxSpeed);
                
                segmentActions.push({
                    id: seg.id,
                    type: 'corner'
                });
                
                speed = cornerSpeed;
                
                // Degradation on corner
                currentSegDegradation += degradationCorner(degRate, cornerSpeed, seg.radius_m);
            }
        }
        
        const lapObj = {
            lap: lap,
            segments: segmentActions,
            pit: pitStop || { enter: false }
        };
        laps.push(lapObj);
        
        // Simulate lap for state update
        const lapResult = simulateLap(
            lapEntrySpeed, targetSpeed, currentCompound, weatherCond,
            currentDegradation, inLimpMode, inCrawlMode
        );
        
        currentTime += lapResult.time;
        currentFuel -= lapResult.fuel;
        currentDegradation += lapResult.degradation;
        lapEntrySpeed = lapResult.exitSpeed;
        inLimpMode = lapResult.inLimpMode;
                inCrawlMode = lapResult.inCrawlMode;

        // Handle pit stop effects
        if (pitStop && pitStop.enter) {
            let pitTime = BASE_PIT_TIME;
            if (pitStop.tyre_change_set_id && pitStop.tyre_change_set_id !== currentTyreId) {
                pitTime += TYRE_SWAP_TIME;
                const newSet = TYRE_SETS.find(s => s.ids.includes(pitStop.tyre_change_set_id));
                if (newSet) {
                    currentCompound = newSet.compound;
                    currentTyreId = pitStop.tyre_change_set_id;
                    currentDegradation = 0;
                    inLimpMode = false;
                }
            }
            if (pitStop.fuel_refuel_amount_l && pitStop.fuel_refuel_amount_l > 0) {
                pitTime += pitStop.fuel_refuel_amount_l / REFUEL_RATE;
                currentFuel += pitStop.fuel_refuel_amount_l;
            }
            currentTime += pitTime;
            lapEntrySpeed = PIT_EXIT_SPEED;
            inCrawlMode = false;
        }

        // Check for blowout
        if (currentDegradation >= 1.0 && !inLimpMode) {
            inLimpMode = true;
        }

        // Check for fuel exhaustion
        if (currentFuel <= 0 && !inLimpMode) {
            inLimpMode = true;
        }
    }

    return { initial_tyre_id: strategy.initialTyreId, laps: laps };
}

// ─── Main Execution ───────────────────────────────────────────────
console.log('=== Entelect F1 Level 4 Solver ===\n');
console.log(`Track: ${config.track.name}`);
console.log(`Segments: ${segments.length}`);
console.log(`Laps: ${TOTAL_LAPS}`);
console.log(`Track length: ${TRACK_LENGTH}m`);
console.log(`Total race distance: ${(TRACK_LENGTH * TOTAL_LAPS / 1000).toFixed(2)}km\n`);

console.log('Weather cycle:');
WEATHER_CYCLE.forEach(w => {
    console.log(`  ${w.condition.padEnd(12)} ${w.duration_s}s  accel×${w.acceleration_multiplier}  brake×${w.deceleration_multiplier}`);
});
console.log(`Cycle total: ${CYCLE_DURATION}s\n`);

console.log('Available tyre sets:');
for (const set of TYRE_SETS) {
    console.log(`  ${set.compound.padEnd(12)} IDs: [${set.ids.join(', ')}]`);
}
console.log();

// Build and validate strategy
const strategy = buildRaceStrategy();
console.log('Initial strategy:');
console.log(`  Initial tyre: ID ${strategy.initialTyreId} (${strategy.initialCompound})`);
console.log('  Target speeds:');
for (const [weather, speed] of Object.entries(strategy.targetSpeeds)) {
    console.log(`    ${weather.padEnd(12)} → ${speed.toFixed(2)} m/s`);
}
console.log(`  Planned pit stops: ${strategy.pitLaps.length}`);
for (const pit of strategy.pitLaps) {
    console.log(`    Lap ${pit.lap}: tyre ID ${pit.tyreId}, refuel ${pit.refuelAmount.toFixed(1)}L`);
}
console.log();

// Run simulation
console.log('Running race simulation...');
const simulation = simulateRace(strategy);

// Calculate score
const score = calculateScore(
    simulation.totalTime,
    simulation.totalFuel,
    simulation.totalDegradation,
    simulation.blowouts
);

console.log('\n=== Race Results ===');
console.log(`Total time:        ${simulation.totalTime.toFixed(2)}s (ref: ${TIME_REF}s)`);
console.log(`Total fuel used:   ${simulation.totalFuel.toFixed(3)}L (soft cap: ${SOFT_CAP}L)`);
console.log(`Final fuel left:   ${simulation.finalFuel.toFixed(3)}L`);
console.log(`Total degradation: ${simulation.totalDegradation.toFixed(3)}`);
console.log(`Blowouts:          ${simulation.blowouts}`);
console.log(`Tyres used:        ${simulation.usedTyreIds.join(', ')}`);

console.log('\n=== Score Breakdown ===');
console.log(`Base score:    ${score.baseScore.toFixed(0)}`);
console.log(`Fuel bonus:    ${score.fuelBonus.toFixed(0)}`);
console.log(`Tyre bonus:    ${score.tyreBonus.toFixed(0)}`);
console.log(`TOTAL SCORE:   ${score.totalScore.toFixed(0)}`);

// Display lap-by-lap summary
console.log('\n=== Lap Summary ===');
console.log('Lap   Weather      Time(s)  Fuel(L)  Degradation  Compound    Status');
console.log('----   ----------   -------  -------  -----------  ----------  ------');
for (const lap of simulation.lapResults) {
    const status = [];
    if (lap.inLimpMode) status.push('LIMP');
    if (lap.blowout) status.push('BLOWOUT');
    const statusStr = status.join(',') || '-';
    console.log(`${lap.lap.toString().padStart(4)}   ${lap.weather.padEnd(10)}   ${lap.time.toFixed(2).padStart(7)}  ${lap.fuel.toFixed(3).padStart(7)}  ${lap.totalDegradation.toFixed(3).padStart(11)}  ${lap.compound.padEnd(10)}  ${statusStr}`);
}

// Build and write output
console.log('\nGenerating output file...');
const output = buildOutput(strategy, simulation);
const outputPath = path.join(__dirname, 'output.txt');
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`Output written to ${outputPath}`);

// Validate output structure
console.log('\n=== Output Validation ===');
console.log(`Initial tyre ID: ${output.initial_tyre_id}`);
console.log(`Total laps in output: ${output.laps.length}`);
console.log(`First lap segments: ${output.laps[0].segments.length}`);
console.log(`Last lap pit: ${output.laps[output.laps.length - 1].pit.enter ? 'Yes' : 'No'}`);

// Verify no limp mode in output (limp mode is simulation-only, output assumes optimal strategy)
const limpLaps = simulation.lapResults.filter(l => l.inLimpMode);
if (limpLaps.length > 0) {
    console.log(`\n  Warning: ${limpLaps.length} laps had limp mode in simulation`);
    console.log('   Consider adjusting strategy to avoid fuel exhaustion or blowouts');
} else {
    console.log('\n✓ No limp mode encountered - strategy is valid');
}

console.log('\n=== Done ===');