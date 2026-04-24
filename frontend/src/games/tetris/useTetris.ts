import { useState, useEffect, useCallback, useRef } from "react";
import type { Board, Piece, TetrominoType, GameState, HighScoreEntry, TSpinType } from "./tetris-types.js";
import {
  createEmptyBoard,
  spawnPiece,
  isValidPosition,
  mergeBoard,
  clearLines,
  rotatePiece,
  getGhostPosition,
  calculateScore,
  getLevel,
  getDropInterval,
  detectTSpin,
  BOARD_ROWS,
  BOARD_COLS,
} from "./tetris-logic.js";
import { ALL_TETROMINO_TYPES } from "./pieces.js";
import { startBGM, stopBGM } from "../bgm.js";

function randomBag(): TetrominoType[] {
  const bag = [...ALL_TETROMINO_TYPES];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

export function useTetris() {
  const [board, setBoard] = useState<Board>(createEmptyBoard());
  const [currentPiece, setCurrentPiece] = useState<Piece | null>(null);
  const [nextPieces, setNextPieces] = useState<TetrominoType[]>([]);
  const [holdPiece, setHoldPiece] = useState<TetrominoType | null>(null);
  const [canHold, setCanHold] = useState(true);
  const [gameState, setGameState] = useState<GameState>("idle");
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [level, setLevel] = useState(0);
  const [highScores, setHighScores] = useState<HighScoreEntry[]>([]);
  const [qualifyingRank, setQualifyingRank] = useState<number | null>(null);
  const [lastTSpin, setLastTSpin] = useState<TSpinType>("none");

  const dropTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameStateRef = useRef(gameState);
  const boardRef = useRef(board);
  const currentPieceRef = useRef(currentPiece);
  const scoreRef = useRef(score);
  const linesRef = useRef(lines);
  const levelRef = useRef(level);
  const nextPiecesRef = useRef(nextPieces);
  const holdPieceRef = useRef(holdPiece);
  const canHoldRef = useRef(canHold);
  const lastActionWasRotationRef = useRef(false);
  const wasKickedRef = useRef(false);

  // Keep refs in sync
  gameStateRef.current = gameState;
  boardRef.current = board;
  currentPieceRef.current = currentPiece;
  scoreRef.current = score;
  linesRef.current = lines;
  levelRef.current = level;
  nextPiecesRef.current = nextPieces;
  holdPieceRef.current = holdPiece;
  canHoldRef.current = canHold;

  // Fetch high scores
  const fetchHighScores = useCallback(async () => {
    try {
      const res = await fetch("/api/tetris/scores");
      if (res.ok) {
        const data = await res.json();
        setHighScores(data);
      }
    } catch {
      // API not available yet — ignore
    }
  }, []);

  useEffect(() => {
    void fetchHighScores();
  }, [fetchHighScores]);

  // Generate next piece from bag
  const pullNextPiece = useCallback((): TetrominoType => {
    const bag = [...nextPiecesRef.current];
    if (bag.length < 7) {
      bag.push(...randomBag());
    }
    const next = bag.shift()!;
    setNextPieces(bag);
    nextPiecesRef.current = bag;
    return next;
  }, []);

  // Lock piece into board and spawn next
  const lockAndSpawn = useCallback(() => {
    const piece = currentPieceRef.current;
    if (!piece) return;

    // T-spin detection before merge
    const tSpin = detectTSpin(
      boardRef.current,
      piece,
      lastActionWasRotationRef.current,
      wasKickedRef.current
    );

    const merged = mergeBoard(boardRef.current, piece);
    const { board: clearedBoard, linesCleared } = clearLines(merged);

    // Reset rotation tracking
    lastActionWasRotationRef.current = false;
    wasKickedRef.current = false;

    const newLines = linesRef.current + linesCleared;
    const newLevel = getLevel(newLines);
    const addedScore = calculateScore(linesCleared, levelRef.current, tSpin);

    // Show T-spin notification
    if (tSpin !== "none" && linesCleared > 0) {
      setLastTSpin(tSpin);
      setTimeout(() => setLastTSpin("none"), 2000);
    }

    setBoard(clearedBoard);
    boardRef.current = clearedBoard;
    setScore((s) => s + addedScore);
    scoreRef.current += addedScore;
    setLines(newLines);
    linesRef.current = newLines;
    setLevel(newLevel);
    levelRef.current = newLevel;

    // Re-enable hold after piece locks
    setCanHold(true);
    canHoldRef.current = true;

    // Spawn next
    const nextType = pullNextPiece();
    const newPiece = spawnPiece(nextType);

    if (!isValidPosition(clearedBoard, newPiece.shape, newPiece.pos)) {
      // Game over
      setCurrentPiece(null);
      currentPieceRef.current = null;
      setGameState("gameover");
      gameStateRef.current = "gameover";
      stopBGM();
      if (dropTimer.current) {
        clearInterval(dropTimer.current);
        dropTimer.current = null;
      }
      return;
    }

    setCurrentPiece(newPiece);
    currentPieceRef.current = newPiece;
  }, [pullNextPiece]);

  // Move piece
  const movePiece = useCallback(
    (dRow: number, dCol: number) => {
      const piece = currentPieceRef.current;
      if (!piece || gameStateRef.current !== "playing") return;
      const newPos = { row: piece.pos.row + dRow, col: piece.pos.col + dCol };
      if (isValidPosition(boardRef.current, piece.shape, newPos)) {
        const updated = { ...piece, pos: newPos };
        setCurrentPiece(updated);
        currentPieceRef.current = updated;
        lastActionWasRotationRef.current = false;
      }
    },
    []
  );

  // Hard drop
  const hardDrop = useCallback(() => {
    const piece = currentPieceRef.current;
    if (!piece || gameStateRef.current !== "playing") return;
    const ghost = getGhostPosition(boardRef.current, piece);
    const dropDistance = ghost.row - piece.pos.row;
    const updated = { ...piece, pos: ghost };
    setCurrentPiece(updated);
    currentPieceRef.current = updated;
    setScore((s) => s + dropDistance * 2);
    scoreRef.current += dropDistance * 2;
    lockAndSpawn();
  }, [lockAndSpawn]);

  // Soft drop
  const softDrop = useCallback(() => {
    movePiece(1, 0);
    setScore((s) => s + 1);
    scoreRef.current += 1;
  }, [movePiece]);

  // Rotate with kick tracking
  const rotate = useCallback(() => {
    const piece = currentPieceRef.current;
    if (!piece || gameStateRef.current !== "playing") return;
    const oldPos = { ...piece.pos };
    const rotated = rotatePiece(piece, boardRef.current, 1);

    // Check if rotation actually happened (shape changed)
    if (rotated.shape !== piece.shape) {
      lastActionWasRotationRef.current = true;
      // Check if a kick was applied (position changed during rotation)
      wasKickedRef.current = rotated.pos.row !== oldPos.row || rotated.pos.col !== oldPos.col;
    }

    setCurrentPiece(rotated);
    currentPieceRef.current = rotated;
  }, []);

  // Hold piece
  const holdCurrentPiece = useCallback(() => {
    const piece = currentPieceRef.current;
    if (!piece || gameStateRef.current !== "playing" || !canHoldRef.current) return;

    const currentType = piece.type;
    const heldType = holdPieceRef.current;

    setHoldPiece(currentType);
    holdPieceRef.current = currentType;
    setCanHold(false);
    canHoldRef.current = false;

    // Reset rotation tracking
    lastActionWasRotationRef.current = false;
    wasKickedRef.current = false;

    if (heldType) {
      // Swap with held piece
      const newPiece = spawnPiece(heldType);
      setCurrentPiece(newPiece);
      currentPieceRef.current = newPiece;
    } else {
      // No held piece yet, pull from bag
      const nextType = pullNextPiece();
      const newPiece = spawnPiece(nextType);
      setCurrentPiece(newPiece);
      currentPieceRef.current = newPiece;
    }
  }, [pullNextPiece]);

  // Start game
  const startGame = useCallback(() => {
    const emptyBoard = createEmptyBoard();
    setBoard(emptyBoard);
    boardRef.current = emptyBoard;
    setScore(0);
    scoreRef.current = 0;
    setLines(0);
    linesRef.current = 0;
    setLevel(0);
    levelRef.current = 0;
    setHoldPiece(null);
    holdPieceRef.current = null;
    setCanHold(true);
    canHoldRef.current = true;
    setLastTSpin("none");
    lastActionWasRotationRef.current = false;
    wasKickedRef.current = false;

    // Fill bag
    const bag = randomBag();
    setNextPieces(bag);
    nextPiecesRef.current = bag;

    const firstType = bag.shift()!;
    setNextPieces([...bag]);
    nextPiecesRef.current = [...bag];
    const piece = spawnPiece(firstType);
    setCurrentPiece(piece);
    currentPieceRef.current = piece;
    setGameState("playing");
    gameStateRef.current = "playing";
    startBGM();
  }, []);

  // Pause / Resume
  const togglePause = useCallback(() => {
    if (gameStateRef.current === "playing") {
      setGameState("paused");
      gameStateRef.current = "paused";
      if (dropTimer.current) {
        clearInterval(dropTimer.current);
        dropTimer.current = null;
      }
    } else if (gameStateRef.current === "paused") {
      setGameState("playing");
      gameStateRef.current = "playing";
    }
  }, []);

  // Game tick
  useEffect(() => {
    if (gameState !== "playing") {
      if (dropTimer.current) {
        clearInterval(dropTimer.current);
        dropTimer.current = null;
      }
      return;
    }

    if (dropTimer.current) clearInterval(dropTimer.current);

    const interval = getDropInterval(level);
    dropTimer.current = setInterval(() => {
      const piece = currentPieceRef.current;
      if (!piece) return;
      const newPos = { row: piece.pos.row + 1, col: piece.pos.col };
      if (isValidPosition(boardRef.current, piece.shape, newPos)) {
        const updated = { ...piece, pos: newPos };
        setCurrentPiece(updated);
        currentPieceRef.current = updated;
      } else {
        lockAndSpawn();
      }
    }, interval);

    return () => {
      if (dropTimer.current) {
        clearInterval(dropTimer.current);
        dropTimer.current = null;
      }
    };
  }, [gameState, level, lockAndSpawn]);

  // Check qualifying rank on game over
  useEffect(() => {
    if (gameState !== "gameover") return;
    const rank = checkQualifyingRank(score, highScores);
    setQualifyingRank(rank);
  }, [gameState, score, highScores]);

  // Keyboard handler
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (gameStateRef.current === "gameover" || gameStateRef.current === "idle") return;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          movePiece(0, -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          movePiece(0, 1);
          break;
        case "ArrowDown":
          e.preventDefault();
          softDrop();
          break;
        case "ArrowUp":
          e.preventDefault();
          rotate();
          break;
        case " ":
          e.preventDefault();
          hardDrop();
          break;
        case "c":
        case "C":
          e.preventDefault();
          holdCurrentPiece();
          break;
        case "p":
        case "P":
        case "Escape":
          e.preventDefault();
          togglePause();
          break;
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [movePiece, softDrop, rotate, hardDrop, holdCurrentPiece, togglePause]);

  // Submit high score
  const submitScore = useCallback(
    async (name: string) => {
      try {
        await fetch("/api/tetris/scores", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.slice(0, 3).toUpperCase(), score: scoreRef.current, level: levelRef.current, lines: linesRef.current }),
        });
        setQualifyingRank(null);
        void fetchHighScores();
      } catch {
        // ignore
      }
    },
    [fetchHighScores]
  );

  // Compute ghost piece position
  const ghostPos = currentPiece ? getGhostPosition(board, currentPiece) : null;

  // Compute display board (board + current piece + ghost)
  const displayBoard = currentPiece
    ? (() => {
        const display = board.map((row: (0 | string)[]) => row.map((c: (0 | string)) => (c === 0 ? ("empty" as const) : (c as string))));
        // Ghost
        if (ghostPos) {
          for (let r = 0; r < currentPiece.shape.length; r++) {
            for (let c = 0; c < currentPiece.shape[r].length; c++) {
              if (!currentPiece.shape[r][c]) continue;
              const row = ghostPos.row + r;
              const col = ghostPos.col + c;
              if (row >= 0 && row < BOARD_ROWS && col >= 0 && col < BOARD_COLS && display[row][col] === "empty") {
                display[row][col] = "ghost";
              }
            }
          }
        }
        // Active piece
        for (let r = 0; r < currentPiece.shape.length; r++) {
          for (let c = 0; c < currentPiece.shape[r].length; c++) {
            if (!currentPiece.shape[r][c]) continue;
            const row = currentPiece.pos.row + r;
            const col = currentPiece.pos.col + c;
            if (row >= 0 && row < BOARD_ROWS && col >= 0 && col < BOARD_COLS) {
              display[row][col] = currentPiece.color;
            }
          }
        }
        return display;
      })()
    : board.map((row: (0 | string)[]) => row.map((c: (0 | string)) => (c === 0 ? ("empty" as const) : (c as string))));

  return {
    displayBoard,
    currentPiece,
    nextPreview: nextPieces[0] || null,
    holdPiece,
    canHold,
    gameState,
    score,
    lines,
    level,
    highScores,
    qualifyingRank,
    lastTSpin,
    startGame,
    togglePause,
    hardDrop,
    softDrop,
    movePiece,
    rotate,
    holdCurrentPiece,
    submitScore,
    fetchHighScores,
  };
}

function checkQualifyingRank(score: number, highScores: HighScoreEntry[]): number | null {
  if (score === 0) return null;
  const maxEntries = 10;
  if (highScores.length < maxEntries) return highScores.length + 1;
  const lowest = highScores[highScores.length - 1]?.score ?? 0;
  if (score > lowest) {
    const rank = highScores.findIndex((s) => score > s.score);
    return rank === -1 ? maxEntries : rank + 1;
  }
  return null;
}
