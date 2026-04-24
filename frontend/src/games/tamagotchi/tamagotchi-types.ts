export interface PetState {
  name: string;
  hunger: number;       // 0-100, 0=starving, 100=full
  happiness: number;    // 0-100, 0=sad, 100=ecstatic
  energy: number;       // 0-100, 0=exhausted, 100=rested
  health: number;       // 0-100, 0=sick, 100=healthy
  cleanliness: number;  // 0-100, 0=filthy, 100=clean
  age: number;          // in game-minutes
  stage: PetStage;
  isAlive: boolean;
  isSleeping: boolean;
  isSick: boolean;
  lastUpdated: number;  // timestamp ms
  createdAt: number;    // timestamp ms
  totalFeedings: number;
  totalPlaySessions: number;
  totalSleeps: number;
  totalCleanings: number;
  totalMedicine: number;
  mood: PetMood;
  causeOfDeath: string | null;
}

export type PetStage = "egg" | "baby" | "child" | "teen" | "adult" | "elder";
export type PetMood = "ecstatic" | "happy" | "neutral" | "sad" | "miserable" | "dead";
export type PetAction = "feed" | "play" | "sleep" | "clean" | "medicine" | "wake";

export interface SaveSlot {
  id: number;
  pet: PetState;
  savedAt: number;
}

export const INITIAL_PET: PetState = {
  name: "",
  hunger: 80,
  happiness: 80,
  energy: 80,
  health: 100,
  cleanliness: 80,
  age: 0,
  stage: "egg",
  isAlive: true,
  isSleeping: false,
  isSick: false,
  lastUpdated: Date.now(),
  createdAt: Date.now(),
  totalFeedings: 0,
  totalPlaySessions: 0,
  totalSleeps: 0,
  totalCleanings: 0,
  totalMedicine: 0,
  mood: "happy",
  causeOfDeath: null,
};

export const STAGE_THRESHOLDS: Record<PetStage, number> = {
  egg: 0,
  baby: 1,
  child: 10,
  teen: 30,
  adult: 60,
  elder: 120,
};

export const SAVE_KEY = "tamagotchi_save_slots";
