import { useState, useEffect, useCallback, useRef } from "react";
import type { PetState, PetAction, SaveSlot } from "./tamagotchi-types.js";
import { INITIAL_PET } from "./tamagotchi-types.js";
import {
  tickPet,
  performAction,
  hatchEgg,
  createPet,
  loadSaveSlots,
  saveToSlot,
  deleteSaveSlot,
  getNextSlotId,
  catchUpOffline,
} from "./tamagotchi-logic.js";

const TICK_MS = 1000;
const AUTO_SAVE_MS = 5000;

export type GameScreen = "menu" | "naming" | "playing";

export function useTamagotchi() {
  const [screen, setScreen] = useState<GameScreen>("menu");
  const [pet, setPet] = useState<PetState>({ ...INITIAL_PET });
  const [saves, setSaves] = useState<SaveSlot[]>([]);
  const [currentSlotId, setCurrentSlotId] = useState<number | null>(null);
  const [pendingName, setPendingName] = useState("");
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load saves on mount ──
  useEffect(() => {
    setSaves(loadSaveSlots());
  }, []);

  // ── Start / stop tick loop ──
  useEffect(() => {
    if (screen === "playing" && pet.isAlive) {
      tickRef.current = setInterval(() => {
        setPet((prev) => tickPet(prev));
      }, TICK_MS);
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [screen, pet.isAlive]);

  // ── Auto-save ──
  useEffect(() => {
    if (screen === "playing" && currentSlotId !== null) {
      autoSaveRef.current = setInterval(() => {
        setPet((prev) => {
          saveToSlot(currentSlotId, prev);
          setSaves(loadSaveSlots());
          return prev;
        });
      }, AUTO_SAVE_MS);
    }
    return () => {
      if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    };
  }, [screen, currentSlotId]);

  // ── Save on unmount / page close ──
  useEffect(() => {
    const handler = () => {
      if (currentSlotId !== null) {
        // Save current pet state synchronously
        try {
          const slots = loadSaveSlots();
          const idx = slots.findIndex((s) => s.id === currentSlotId);
          const entry: SaveSlot = { id: currentSlotId, pet, savedAt: Date.now() };
          if (idx >= 0) slots[idx] = entry;
          else slots.push(entry);
          localStorage.setItem("tamagotchi_save_slots", JSON.stringify(slots));
        } catch { /* ignore */ }
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [currentSlotId, pet]);

  // ── Actions ──
  const doAction = useCallback((action: PetAction) => {
    setPet((prev) => {
      const next = performAction(prev, action);
      if (currentSlotId !== null) saveToSlot(currentSlotId, next);
      return next;
    });
  }, [currentSlotId]);

  const doHatch = useCallback(() => {
    setPet((prev) => {
      const next = hatchEgg(prev);
      if (currentSlotId !== null) saveToSlot(currentSlotId, next);
      return next;
    });
  }, [currentSlotId]);

  const startNewGame = useCallback(() => {
    setScreen("naming");
    setPendingName("");
  }, []);

  const confirmName = useCallback((name: string) => {
    const newPet = createPet(name.trim() || "Tama");
    const slotId = getNextSlotId();
    saveToSlot(slotId, newPet);
    setCurrentSlotId(slotId);
    setPet(newPet);
    setSaves(loadSaveSlots());
    setScreen("playing");
  }, []);

  const loadGame = useCallback((slot: SaveSlot) => {
    const caughtUp = catchUpOffline(slot.pet);
    setCurrentSlotId(slot.id);
    setPet(caughtUp);
    saveToSlot(slot.id, caughtUp);
    setSaves(loadSaveSlots());
    setScreen("playing");
  }, []);

  const deleteGame = useCallback((slotId: number) => {
    deleteSaveSlot(slotId);
    setSaves(loadSaveSlots());
  }, []);

  const goToMenu = useCallback(() => {
    // Save before leaving
    if (currentSlotId !== null) {
      saveToSlot(currentSlotId, pet);
      setSaves(loadSaveSlots());
    }
    setCurrentSlotId(null);
    setScreen("menu");
    setPet({ ...INITIAL_PET });
  }, [currentSlotId, pet]);

  const restartGame = useCallback((name: string) => {
    const newPet = createPet(name.trim() || "Tama");
    const slotId = getNextSlotId();
    saveToSlot(slotId, newPet);
    setCurrentSlotId(slotId);
    setPet(newPet);
    setSaves(loadSaveSlots());
  }, []);

  return {
    screen,
    pet,
    saves,
    pendingName,
    setPendingName,
    doAction,
    doHatch,
    startNewGame,
    confirmName,
    loadGame,
    deleteGame,
    goToMenu,
    restartGame,
  };
}
