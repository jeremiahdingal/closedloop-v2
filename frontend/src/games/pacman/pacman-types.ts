// Pac-Man shared types

export type Direction = "up" | "down" | "left" | "right" | "none";

export interface Position {
  row: number;
  col: number;
}

export type CellValue = 0 | 1 | 2 | 3 | 4; // empty, wall, dot, power pellet, ghost house door

export type Grid = CellValue[][];

export interface GhostState {
  pos: Position;
  dir: Direction;
  color: string;
  mode: "scatter" | "chase" | "frightened" | "eaten";
  scatterTarget: Position;
  name: string;
}

export interface PacManState {
  pos: Position;
  dir: Direction;
  nextDir: Direction;
  mouthOpen: boolean;
}

export type PacManGameState = "idle" | "playing" | "paused" | "gameover" | "won";

export interface HighScoreEntry {
  id?: number;
  name: string;
  score: number;
  level: number;
  created_at?: string;
}
