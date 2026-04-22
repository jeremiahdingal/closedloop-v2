export type CellValue = 0 | string; // 0 = empty, string = color

export type Board = CellValue[][]; // 20 rows × 10 cols

export interface Position {
  row: number;
  col: number;
}

export interface Piece {
  shape: number[][];
  color: string;
  pos: Position;
  type: TetrominoType;
}

export type TetrominoType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

export type GameState = "idle" | "playing" | "paused" | "gameover";

export type TSpinType = "none" | "mini" | "full";

export interface HighScoreEntry {
  name: string;
  score: number;
  level: number;
  lines: number;
  date: string;
}
