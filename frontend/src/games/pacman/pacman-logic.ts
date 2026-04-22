import type { Direction, Position, GhostState, Grid } from "./pacman-types.js";
import { MAZE_ROWS, MAZE_COLS } from "./maze.js";

const DIR_DELTA: Record<Direction, Position> = {
  up: { row: -1, col: 0 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
  right: { row: 0, col: 1 },
  none: { row: 0, col: 0 },
};

const OPPOSITE: Record<Direction, Direction> = {
  up: "down", down: "up", left: "right", right: "left", none: "none",
};

export function wrap(pos: Position): Position {
  return {
    row: ((pos.row % MAZE_ROWS) + MAZE_ROWS) % MAZE_ROWS,
    col: ((pos.col % MAZE_COLS) + MAZE_COLS) % MAZE_COLS,
  };
}

export function isWalkable(grid: Grid, pos: Position): boolean {
  const p = wrap(pos);
  const cell = grid[p.row]?.[p.col];
  return cell !== undefined && cell !== 1;
}

export function moveInDir(pos: Position, dir: Direction): Position {
  const d = DIR_DELTA[dir];
  return wrap({ row: pos.row + d.row, col: pos.col + d.col });
}

export function getDistance(a: Position, b: Position): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

export function getAvailableDirections(grid: Grid, pos: Position, excludeReverse?: Direction): Direction[] {
  const dirs: Direction[] = ["up", "down", "left", "right"];
  return dirs.filter(d => {
    if (excludeReverse && d === OPPOSITE[excludeReverse]) return false;
    return isWalkable(grid, moveInDir(pos, d));
  });
}

// Ghost AI: pick direction that minimizes distance to target
export function chooseGhostDirection(
  grid: Grid,
  ghost: GhostState,
  target: Position
): Direction {
  const available = getAvailableDirections(grid, ghost.pos, ghost.dir);
  if (available.length === 0) {
    // Dead end — allow reverse
    const allDirs = getAvailableDirections(grid, ghost.pos);
    return allDirs[0] ?? "none";
  }

  let bestDir: Direction = available[0];
  let bestDist = Infinity;

  for (const dir of available) {
    const next = moveInDir(ghost.pos, dir);
    const dist = getDistance(next, target);
    if (dist < bestDist) {
      bestDist = dist;
      bestDir = dir;
    }
  }
  return bestDir;
}

// Frightened ghost: random direction
export function chooseFrightenedDirection(
  grid: Grid,
  ghost: GhostState
): Direction {
  const available = getAvailableDirections(grid, ghost.pos, ghost.dir);
  if (available.length === 0) {
    const allDirs = getAvailableDirections(grid, ghost.pos);
    return allDirs[0] ?? "none";
  }
  return available[Math.floor(Math.random() * available.length)];
}

// Eaten ghost: head back to ghost house
export function chooseEatenDirection(
  grid: Grid,
  ghost: GhostState,
  home: Position
): Direction {
  return chooseGhostDirection(grid, ghost, home);
}

export { OPPOSITE };
