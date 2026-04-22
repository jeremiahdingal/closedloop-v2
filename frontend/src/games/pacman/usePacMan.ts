import { useState, useEffect, useCallback, useRef } from "react";
import type {
  Direction, Grid, PacManState, GhostState, PacManGameState, HighScoreEntry, Position,
} from "./pacman-types.js";
import {
  createGrid, countDots, PACMAN_START, GHOST_STARTS, MAZE_ROWS, MAZE_COLS,
} from "./maze.js";
import {
  moveInDir, isWalkable, chooseGhostDirection, chooseFrightenedDirection,
  chooseEatenDirection, OPPOSITE,
} from "./pacman-logic.js";
import { startBGM, stopBGM } from "../bgm.js";

const TICK_MS = 150;
const GHOST_TICK_MS = 180;
const FRIGHTEN_DURATION = 6000;
const TOTAL_DOTS = countDots(createGrid());

export function usePacMan() {
  const [grid, setGrid] = useState<Grid>(createGrid());
  const [pacman, setPacman] = useState<PacManState>({
    pos: { ...PACMAN_START },
    dir: "left",
    nextDir: "left",
    mouthOpen: true,
  });
  const [ghosts, setGhosts] = useState<GhostState[]>(
    GHOST_STARTS.map(g => ({
      pos: { ...g },
      dir: "left" as Direction,
      color: g.color,
      mode: "scatter" as const,
      scatterTarget: g.scatterTarget,
      name: g.name,
    }))
  );
  const [gameState, setGameState] = useState<PacManGameState>("idle");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [level, setLevel] = useState(1);
  const [dotsEaten, setDotsEaten] = useState(0);
  const [highScores, setHighScores] = useState<HighScoreEntry[]>([]);
  const [qualifyingRank, setQualifyingRank] = useState<number | null>(null);
  const [frightenedTimer, setFrightenedTimer] = useState(false);

  const gameStateRef = useRef(gameState);
  const gridRef = useRef(grid);
  const pacmanRef = useRef(pacman);
  const ghostsRef = useRef(ghosts);
  const scoreRef = useRef(score);
  const livesRef = useRef(lives);
  const levelRef = useRef(level);
  const dotsEatenRef = useRef(dotsEaten);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ghostTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frightenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouthToggleRef = useRef(true);

  gameStateRef.current = gameState;
  gridRef.current = grid;
  pacmanRef.current = pacman;
  ghostsRef.current = ghosts;
  scoreRef.current = score;
  livesRef.current = lives;
  levelRef.current = level;
  dotsEatenRef.current = dotsEaten;

  // Fetch high scores
  const fetchHighScores = useCallback(async () => {
    try {
      const res = await fetch("/api/pacman/scores");
      if (res.ok) setHighScores(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void fetchHighScores(); }, [fetchHighScores]);

  const resetPositions = useCallback(() => {
    setPacman({ pos: { ...PACMAN_START }, dir: "left", nextDir: "left", mouthOpen: true });
    pacmanRef.current = { pos: { ...PACMAN_START }, dir: "left", nextDir: "left", mouthOpen: true };
    setGhosts(GHOST_STARTS.map(g => ({
      pos: { ...g }, dir: "left" as Direction, color: g.color,
      mode: "scatter" as const, scatterTarget: g.scatterTarget, name: g.name,
    })));
  }, []);

  // Pac-Man tick
  const tickPacman = useCallback(() => {
    const state = gameStateRef.current;
    if (state !== "playing") return;

    const pac = pacmanRef.current;
    const g = gridRef.current;

    // Try next direction first
    const nextPos = moveInDir(pac.pos, pac.nextDir);
    if (isWalkable(g, nextPos)) {
      pac.dir = pac.nextDir;
    }

    // Move in current direction
    const newPos = moveInDir(pac.pos, pac.dir);
    if (isWalkable(g, newPos)) {
      pac.pos = newPos;
    }

    // Toggle mouth
    mouthToggleRef.current = !mouthToggleRef.current;
    pac.mouthOpen = mouthToggleRef.current;

    // Eat dot
    const cell = g[newPos.row]?.[newPos.col];
    if (cell === 2) {
      g[newPos.row][newPos.col] = 0;
      scoreRef.current += 10;
      dotsEatenRef.current += 1;
      setGrid(g.map(r => [...r]));
      setScore(scoreRef.current);
      setDotsEaten(dotsEatenRef.current);
    } else if (cell === 3) {
      // Power pellet
      g[newPos.row][newPos.col] = 0;
      scoreRef.current += 50;
      dotsEatenRef.current += 1;
      setGrid(g.map(r => [...r]));
      setScore(scoreRef.current);
      setDotsEaten(dotsEatenRef.current);

      // Frighten ghosts
      setFrightenedTimer(true);
      if (frightenTimeoutRef.current) clearTimeout(frightenTimeoutRef.current);
      frightenTimeoutRef.current = setTimeout(() => {
        setFrightenedTimer(false);
        // Restore ghosts to chase/scatter mode
        setGhosts(prev => {
          const updated = prev.map(gh => ({
            ...gh,
            mode: (gh.mode === "frightened" ? "chase" : gh.mode) as "scatter" | "chase" | "frightened" | "eaten",
          }));
          ghostsRef.current = updated;
          return updated;
        });
      }, FRIGHTEN_DURATION);

      setGhosts(prev => {
        const updated = prev.map(gh => ({ ...gh, mode: "frightened" as const }));
        ghostsRef.current = updated;
        return updated;
      });
    }

    setPacman({ ...pac });
    pacmanRef.current = pac;

    // Check win
    if (dotsEatenRef.current >= TOTAL_DOTS) {
      setGameState("won");
      gameStateRef.current = "won";
      stopBGM();
    }

    // Check ghost collision
    const gs = ghostsRef.current;
    for (const ghost of gs) {
      if (ghost.pos.row === pac.pos.row && ghost.pos.col === pac.pos.col) {
        if (ghost.mode === "frightened") {
          ghost.mode = "eaten";
          scoreRef.current += 200;
          setScore(scoreRef.current);
          ghost.pos = { row: 9, col: 10 }; // back to house
        } else if (ghost.mode !== "eaten") {
          // Die
          const newLives = livesRef.current - 1;
          setLives(newLives);
          livesRef.current = newLives;
          if (newLives <= 0) {
            setGameState("gameover");
            gameStateRef.current = "gameover";
            stopBGM();
          } else {
            resetPositions();
          }
          return;
        }
      }
    }
    setGhosts(gs.map(gh => ({ ...gh })));
  }, [resetPositions]);

  // Ghost tick
  const tickGhosts = useCallback(() => {
    const state = gameStateRef.current;
    if (state !== "playing") return;

    const g = gridRef.current;
    const pac = pacmanRef.current;
    const gs = ghostsRef.current;
    const ghostHome: Position = { row: 9, col: 10 };

    for (const ghost of gs) {
      let target: Position;
      let newDir: Direction;

      if (ghost.mode === "eaten") {
        newDir = chooseEatenDirection(g, ghost, ghostHome);
      } else if (ghost.mode === "frightened") {
        newDir = chooseFrightenedDirection(g, ghost);
      } else {
        // scatter for first few seconds, then chase
        target = pac.pos; // simplified: always chase
        newDir = chooseGhostDirection(g, ghost, target);
      }

      ghost.dir = newDir;
      const newPos = moveInDir(ghost.pos, newDir);
      if (isWalkable(g, newPos) || ghost.mode === "eaten") {
        ghost.pos = newPos;
      }

      // If eaten ghost reached home, revive
      if (ghost.mode === "eaten" && ghost.pos.row === ghostHome.row && ghost.pos.col === ghostHome.col) {
        ghost.mode = "chase";
      }
    }

    setGhosts(gs.map(gh => ({ ...gh })));
  }, []);

  // Start timers
  useEffect(() => {
    if (gameState !== "playing") {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      if (ghostTickRef.current) { clearInterval(ghostTickRef.current); ghostTickRef.current = null; }
      return;
    }

    if (tickRef.current) clearInterval(tickRef.current);
    if (ghostTickRef.current) clearInterval(ghostTickRef.current);

    tickRef.current = setInterval(tickPacman, TICK_MS);
    ghostTickRef.current = setInterval(tickGhosts, GHOST_TICK_MS);

    return () => {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      if (ghostTickRef.current) { clearInterval(ghostTickRef.current); ghostTickRef.current = null; }
    };
  }, [gameState, tickPacman, tickGhosts]);

  // Keyboard
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (gameStateRef.current === "gameover" || gameStateRef.current === "idle") return;

      const dirMap: Record<string, Direction> = {
        ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
        w: "up", s: "down", a: "left", d: "right",
        W: "up", S: "down", A: "left", D: "right",
      };

      const dir = dirMap[e.key];
      if (dir) {
        e.preventDefault();
        setPacman(prev => ({ ...prev, nextDir: dir }));
        pacmanRef.current = { ...pacmanRef.current, nextDir: dir };
      }

      if (e.key === "p" || e.key === "P" || e.key === "Escape") {
        e.preventDefault();
        if (gameStateRef.current === "playing") {
          setGameState("paused");
          gameStateRef.current = "paused";
        } else if (gameStateRef.current === "paused") {
          setGameState("playing");
          gameStateRef.current = "playing";
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // Check qualifying rank
  useEffect(() => {
    if (gameState !== "gameover" && gameState !== "won") return;
    if (score === 0) { setQualifyingRank(null); return; }
    const maxEntries = 10;
    if (highScores.length < maxEntries) { setQualifyingRank(highScores.length + 1); return; }
    const lowest = highScores[highScores.length - 1]?.score ?? 0;
    if (score > lowest) {
      const rank = highScores.findIndex(s => score > s.score);
      setQualifyingRank(rank === -1 ? maxEntries : rank + 1);
    } else {
      setQualifyingRank(null);
    }
  }, [gameState, score, highScores]);

  const startGame = useCallback(() => {
    const newGrid = createGrid();
    setGrid(newGrid);
    gridRef.current = newGrid;
    setScore(0); scoreRef.current = 0;
    setLives(3); livesRef.current = 3;
    setLevel(1); levelRef.current = 1;
    setDotsEaten(0); dotsEatenRef.current = 0;
    setFrightenedTimer(false);
    resetPositions();
    setGameState("playing");
    gameStateRef.current = "playing";
    startBGM();
  }, [resetPositions]);

  const togglePause = useCallback(() => {
    if (gameStateRef.current === "playing") {
      setGameState("paused"); gameStateRef.current = "paused";
    } else if (gameStateRef.current === "paused") {
      setGameState("playing"); gameStateRef.current = "playing";
    }
  }, []);

  const submitScore = useCallback(async (name: string) => {
    try {
      await fetch("/api/pacman/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.slice(0, 3).toUpperCase(), score: scoreRef.current, level: levelRef.current }),
      });
      setQualifyingRank(null);
      void fetchHighScores();
    } catch { /* ignore */ }
  }, [fetchHighScores]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (ghostTickRef.current) clearInterval(ghostTickRef.current);
      if (frightenTimeoutRef.current) clearTimeout(frightenTimeoutRef.current);
    };
  }, []);

  const setNextDir = useCallback((dir: Direction) => {
    if (gameStateRef.current !== "playing") return;
    setPacman(prev => ({ ...prev, nextDir: dir }));
    pacmanRef.current = { ...pacmanRef.current, nextDir: dir };
  }, []);

  return {
    grid, pacman, ghosts, gameState, score, lives, level, dotsEaten, TOTAL_DOTS,
    highScores, qualifyingRank, frightenedTimer,
    startGame, togglePause, submitScore, fetchHighScores, setNextDir,
  };
}
