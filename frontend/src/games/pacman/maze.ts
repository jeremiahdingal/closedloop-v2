import type { CellValue, Grid } from "./pacman-types.js";

// Classic Pac-Man inspired maze (28 wide x 31 tall)
// 0=empty, 1=wall, 2=dot, 3=power pellet, 4=ghost house door
// Simplified to 21 wide x 23 tall for our display

const W = 1;
const D = 2;
const P = 3;
const E = 0;
const G = 4; // ghost house

export const MAZE_TEMPLATE: CellValue[][] = [
  [W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W],
  [W,D,D,D,D,D,D,D,D,D,W,D,D,D,D,D,D,D,D,D,W],
  [W,D,W,W,D,W,W,W,D,D,W,D,D,W,W,W,D,W,W,D,W],
  [W,P,W,W,D,W,W,W,D,D,W,D,D,W,W,W,D,W,W,P,W],
  [W,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,W],
  [W,D,W,W,D,W,D,W,W,W,W,W,W,W,D,W,D,W,W,D,W],
  [W,D,D,D,D,W,D,D,D,D,W,D,D,D,D,W,D,D,D,D,W],
  [W,W,W,W,D,W,W,W,E,E,W,E,E,W,W,W,D,W,W,W,W],
  [E,E,E,W,D,W,E,E,E,E,E,E,E,E,E,W,D,W,E,E,E],
  [W,W,W,W,D,W,E,W,W,G,G,G,W,W,E,W,D,W,W,W,W],
  [E,E,E,E,D,E,E,W,E,E,E,E,E,W,E,E,D,E,E,E,E],
  [W,W,W,W,D,W,E,W,W,W,W,W,W,W,E,W,D,W,W,W,W],
  [E,E,E,W,D,W,E,E,E,E,E,E,E,E,E,W,D,W,E,E,E],
  [W,W,W,W,D,W,E,W,W,W,W,W,W,W,E,W,D,W,W,W,W],
  [W,D,D,D,D,D,D,D,D,D,W,D,D,D,D,D,D,D,D,D,W],
  [W,D,W,W,D,W,W,W,D,D,W,D,D,W,W,W,D,W,W,D,W],
  [W,P,D,W,D,D,D,D,D,D,E,D,D,D,D,D,D,W,D,P,W],
  [W,W,D,W,D,W,D,W,W,W,W,W,W,W,D,W,D,W,D,W,W],
  [W,D,D,D,D,W,D,D,D,D,W,D,D,D,D,W,D,D,D,D,W],
  [W,D,W,W,W,W,W,W,D,D,W,D,D,W,W,W,W,W,W,D,W],
  [W,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,W],
  [W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W],
];

export const PACMAN_START = { row: 16, col: 10 };
export const GHOST_STARTS = [
  { row: 9, col: 9, color: "#ff0000", name: "Blinky", scatterTarget: { row: 0, col: 20 } },
  { row: 10, col: 10, color: "#ffb8ff", name: "Pinky", scatterTarget: { row: 0, col: 0 } },
  { row: 9, col: 11, color: "#00ffff", name: "Inky", scatterTarget: { row: 21, col: 20 } },
  { row: 9, col: 10, color: "#ffb852", name: "Clyde", scatterTarget: { row: 21, col: 0 } },
];

export const MAZE_ROWS = MAZE_TEMPLATE.length;
export const MAZE_COLS = MAZE_TEMPLATE[0].length;

export function createGrid(): Grid {
  return MAZE_TEMPLATE.map(row => [...row]);
}

export function countDots(grid: Grid): number {
  let count = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell === 2 || cell === 3) count++;
    }
  }
  return count;
}
