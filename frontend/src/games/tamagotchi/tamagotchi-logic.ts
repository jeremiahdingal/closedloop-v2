import type { PetState, PetStage, PetMood, SaveSlot, PetAction } from "./tamagotchi-types.js";
import { INITIAL_PET, STAGE_THRESHOLDS, SAVE_KEY } from "./tamagotchi-types.js";

// ── Stat decay rates per real second (the game ticks every 1s) ──
const DECAY = {
  hunger: 0.35,
  happiness: 0.25,
  energy: 0.15,
  cleanliness: 0.20,
} as const;

// ── Sickness probability per tick when health < 30 ──
const SICK_CHANCE = 0.005;
// ── Health decay per tick when sick ──
const SICK_HEALTH_DECAY = 0.4;
// ── Health decay when hunger is 0 ──
const STARVE_HEALTH_DECAY = 0.6;
// ── Recovery per tick when well-fed and clean ──
const NATURAL_HEAL = 0.05;
// ── Age increment per tick (1 game-second = ~1 game-minute equivalent) ──
const AGE_PER_TICK = 0.0167;

// ────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────
function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function determineStage(age: number): PetStage {
  const stages: PetStage[] = ["elder", "adult", "teen", "child", "baby", "egg"];
  for (const s of stages) {
    if (age >= STAGE_THRESHOLDS[s]) return s;
  }
  return "egg";
}

function determineMood(pet: PetState): PetMood {
  if (!pet.isAlive) return "dead";
  const avg = (pet.hunger + pet.happiness + pet.energy + pet.health + pet.cleanliness) / 5;
  if (avg >= 85) return "ecstatic";
  if (avg >= 65) return "happy";
  if (avg >= 45) return "neutral";
  if (avg >= 25) return "sad";
  return "miserable";
}

// ────────────────────────────────────────────
//  Core tick: advance pet by 1 real second
// ────────────────────────────────────────────
export function tickPet(prev: PetState): PetState {
  if (!prev.isAlive) return prev;

  const now = Date.now();
  let { hunger, happiness, energy, cleanliness, health, age, isSick, isSleeping } = prev;

  // Energy recharges while sleeping; decays otherwise
  if (isSleeping) {
    energy = clamp(energy + 0.6);
    // While sleeping, other stats decay slower
    hunger = clamp(hunger - DECAY.hunger * 0.3);
    happiness = clamp(happiness - DECAY.happiness * 0.1);
    cleanliness = clamp(cleanliness - DECAY.cleanliness * 0.1);
  } else {
    hunger = clamp(hunger - DECAY.hunger);
    happiness = clamp(happiness - DECAY.happiness);
    energy = clamp(energy - DECAY.energy);
    cleanliness = clamp(cleanliness - DECAY.cleanliness);
  }

  // Sickness mechanics
  if (!isSick && health < 30 && Math.random() < SICK_CHANCE) {
    isSick = true;
  }
  if (isSick) {
    health = clamp(health - SICK_HEALTH_DECAY);
    happiness = clamp(happiness - 0.15);
  }

  // Starvation damage
  if (hunger <= 0) {
    health = clamp(health - STARVE_HEALTH_DECAY);
  }

  // Natural healing
  if (!isSick && hunger > 50 && cleanliness > 50 && health < 100) {
    health = clamp(health + NATURAL_HEAL);
  }

  // Age
  age += AGE_PER_TICK;
  const stage = determineStage(age);

  // Death check
  let isAlive = true;
  let causeOfDeath: string | null = null;
  if (health <= 0) {
    isAlive = false;
    causeOfDeath = hunger <= 5 ? "starvation" : isSick ? "illness" : "neglect";
  }
  if (energy <= 0 && !isSleeping) {
    // Force sleep
    isSleeping = true;
  }

  const pet: PetState = {
    ...prev,
    hunger,
    happiness,
    energy,
    cleanliness,
    health,
    age,
    stage,
    isAlive,
    isSick,
    isSleeping,
    lastUpdated: now,
    causeOfDeath,
    mood: "happy", // placeholder, set below
  };
  pet.mood = determineMood(pet);
  return pet;
}

// ────────────────────────────────────────────
//  Actions
// ────────────────────────────────────────────
export function performAction(prev: PetState, action: PetAction): PetState {
  if (!prev.isAlive) return prev;

  let pet = { ...prev };

  switch (action) {
    case "feed":
      if (pet.isSleeping) break;
      pet.hunger = clamp(pet.hunger + 25);
      pet.happiness = clamp(pet.happiness + 5);
      pet.health = clamp(pet.health + 2);
      pet.totalFeedings++;
      break;

    case "play":
      if (pet.isSleeping) break;
      if (pet.energy < 10) break; // too tired
      pet.happiness = clamp(pet.happiness + 20);
      pet.energy = clamp(pet.energy - 15);
      pet.hunger = clamp(pet.hunger - 5);
      pet.totalPlaySessions++;
      break;

    case "sleep":
      pet.isSleeping = true;
      pet.totalSleeps++;
      break;

    case "wake":
      pet.isSleeping = false;
      break;

    case "clean":
      if (pet.isSleeping) break;
      pet.cleanliness = clamp(pet.cleanliness + 30);
      pet.happiness = clamp(pet.happiness + 5);
      pet.totalCleanings++;
      break;

    case "medicine":
      if (pet.isSleeping) break;
      if (!pet.isSick && pet.health > 70) break; // don't need medicine
      pet.isSick = false;
      pet.health = clamp(pet.health + 20);
      pet.happiness = clamp(pet.happiness - 10); // medicine tastes bad
      pet.totalMedicine++;
      break;
  }

  pet.mood = determineMood(pet);
  pet.lastUpdated = Date.now();
  return pet;
}

// ────────────────────────────────────────────
//  Hatch: transition from egg to baby
// ────────────────────────────────────────────
export function hatchEgg(prev: PetState): PetState {
  if (prev.stage !== "egg") return prev;
  return {
    ...prev,
    stage: "baby",
    age: 1,
    hunger: 90,
    happiness: 90,
    energy: 90,
    health: 100,
    cleanliness: 100,
    mood: "happy",
    lastUpdated: Date.now(),
  };
}

// ────────────────────────────────────────────
//  Create a new pet
// ────────────────────────────────────────────
export function createPet(name: string): PetState {
  return {
    ...INITIAL_PET,
    name,
    createdAt: Date.now(),
    lastUpdated: Date.now(),
    mood: "happy",
  };
}

// ────────────────────────────────────────────
//  Persistence
// ────────────────────────────────────────────
export function loadSaveSlots(): SaveSlot[] {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SaveSlot[];
  } catch {
    return [];
  }
}

export function saveToSlot(id: number, pet: PetState): void {
  const slots = loadSaveSlots();
  const idx = slots.findIndex((s) => s.id === id);
  const entry: SaveSlot = { id, pet, savedAt: Date.now() };
  if (idx >= 0) {
    slots[idx] = entry;
  } else {
    slots.push(entry);
  }
  localStorage.setItem(SAVE_KEY, JSON.stringify(slots));
}

export function deleteSaveSlot(id: number): void {
  const slots = loadSaveSlots().filter((s) => s.id !== id);
  localStorage.setItem(SAVE_KEY, JSON.stringify(slots));
}

export function getNextSlotId(): number {
  const slots = loadSaveSlots();
  return slots.length === 0 ? 1 : Math.max(...slots.map((s) => s.id)) + 1;
}

// ────────────────────────────────────────────
//  Offline progress: catch up missed time
// ────────────────────────────────────────────
export function catchUpOffline(pet: PetState): PetState {
  if (!pet.isAlive) return pet;

  const now = Date.now();
  const elapsedSec = Math.min((now - pet.lastUpdated) / 1000, 3600); // cap at 1 hour
  if (elapsedSec < 2) return pet; // nothing to catch up

  let current = { ...pet };
  // Simulate ticks in batches of 10 seconds for performance
  const steps = Math.ceil(elapsedSec / 10);
  const perStep = elapsedSec / steps;

  for (let i = 0; i < steps; i++) {
    // Apply decay proportional to perStep seconds
    current.hunger = clamp(current.hunger - DECAY.hunger * perStep * (current.isSleeping ? 0.3 : 1));
    current.happiness = clamp(current.happiness - DECAY.happiness * perStep * (current.isSleeping ? 0.1 : 1));
    current.energy = clamp(current.energy + (current.isSleeping ? 0.6 : -DECAY.energy) * perStep);
    current.cleanliness = clamp(current.cleanliness - DECAY.cleanliness * perStep * (current.isSleeping ? 0.1 : 1));
    current.age += AGE_PER_TICK * perStep;

    if (current.hunger <= 0) {
      current.health = clamp(current.health - STARVE_HEALTH_DECAY * perStep);
    }
    if (current.isSick) {
      current.health = clamp(current.health - SICK_HEALTH_DECAY * perStep);
    }
    if (current.health <= 0) {
      current.isAlive = false;
      current.causeOfDeath = current.hunger <= 5 ? "starvation" : current.isSick ? "illness" : "neglect";
      break;
    }
  }

  current.stage = determineStage(current.age);
  current.mood = determineMood(current);
  current.lastUpdated = now;
  return current;
}
