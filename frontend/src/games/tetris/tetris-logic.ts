import type { Board, CellValue, Piece, Position, TetrominoType, TSpinType } from "./tetris-types.js";
import { getPieceShape, getPieceColor } from "./pieces.js";

export const BOARD_ROWS = 20;
export const BOARD_COLS = 10;

export function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_ROWS }, () => Array<CellValue>(BOARD_COLS).fill(0));
}

export function spawnPiece(type: TetrominoType): Piece {
  const shape = getPieceShape(type, 0);
  const col = Math.floor((BOARD_COLS - shape[0].length) / 2);
  return {
    shape,
    color: getPieceColor(type),
    pos: { row: 0, col },
    type,
  };
}

export function isValidPosition(board: Board, shape: number[][], pos: Position): boolean {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const newRow = pos.row + r;
      const newCol = pos.col + c;
      if (newRow < 0 || newRow >= BOARD_ROWS || newCol < 0 || newCol >= BOARD_COLS) return false;
      if (board[newRow][newCol] !== 0) return false;
    }
  }
  return true;
}

export function mergeBoard(board: Board, piece: Piece): Board {
  const next = board.map((row) => [...row]);
  for (let r = 0; r < piece.shape.length; r++) {
    for (let c = 0; c < piece.shape[r].length; c++) {
      if (!piece.shape[r][c]) continue;
      const row = piece.pos.row + r;
      const col = piece.pos.col + c;
      if (row >= 0 && row < BOARD_ROWS && col >= 0 && col < BOARD_COLS) {
        next[row][col] = piece.color;
      }
    }
  }
  return next;
}

export function clearLines(board: Board): { board: Board; linesCleared: number } {
  const remaining = board.filter((row: CellValue[]) => row.some((cell: CellValue) => cell === 0));
  const linesCleared = BOARD_ROWS - remaining.length;
  const emptyRows = Array.from({ length: linesCleared }, () => Array<CellValue>(BOARD_COLS).fill(0));
  return { board: [...emptyRows, ...remaining], linesCleared };
}

export function rotatePiece(piece: Piece, board: Board, direction: 1 | -1 = 1): Piece {
  const currentRotation = piece.shape;
  const rows = currentRotation.length;
  const cols = currentRotation[0].length;

  // Transpose and reverse to rotate
  let rotated: number[][];
  if (direction === 1) {
    // Clockwise: transpose then reverse rows
    rotated = Array.from({ length: cols }, (_, c) =>
      Array.from({ length: rows }, (_, r) => currentRotation[rows - 1 - r][c])
    );
  } else {
    // Counter-clockwise: reverse rows then transpose
    rotated = Array.from({ length: cols }, (_, c) =>
      Array.from({ length: rows }, (_, r) => currentRotation[r][cols - 1 - c])
    );
  }

  // Try basic rotation
  const newPiece: Piece = { ...piece, shape: rotated };
  if (isValidPosition(board, rotated, piece.pos)) return newPiece;

  // Wall kicks: try offsets
  const kicks = [
    { row: 0, col: -1 },
    { row: 0, col: 1 },
    { row: 0, col: -2 },
    { row: 0, col: 2 },
    { row: -1, col: 0 },
    { row: -1, col: -1 },
    { row: -1, col: 1 },
  ];

  for (const kick of kicks) {
    const kickPos = { row: piece.pos.row + kick.row, col: piece.pos.col + kick.col };
    if (isValidPosition(board, rotated, kickPos)) {
      return { ...piece, shape: rotated, pos: kickPos };
    }
  }

  // Can't rotate — return original
  return piece;
}

export function getGhostPosition(board: Board, piece: Piece): Position {
  let ghostRow = piece.pos.row;
  while (isValidPosition(board, piece.shape, { row: ghostRow + 1, col: piece.pos.col })) {
    ghostRow++;
  }
  return { row: ghostRow, col: piece.pos.col };
}

/**
 * T-Spin detection using the 3-corner rule (Guideline standard).
 *
 * For a T-piece, find its center (the middle cell of the 3×3 matrix).
 * Count how many of the 4 diagonal corners relative to that center are filled
 * (walls or placed blocks). If 3+ corners are filled after locking:
 *   - "full" T-Spin if the last move was a rotation and the piece was kicked
 *   - "mini" T-Spin if the last move was a rotation without a kick
 *   - "none" if the last move was NOT a rotation
 *
 * The piece must have been rotated as its last action for any T-Spin to count.
 */
export function detectTSpin(
  board: Board,
  piece: Piece,
  lastActionWasRotation: boolean,
  wasKicked: boolean
): TSpinType {
  if (piece.type !== "T" || !lastActionWasRotation) return "none";

  // Find center of the T-piece (the cell at row 1, col 1 in the 3×3 matrix)
  // The T-piece is always 3×3, center is at matrix position (1,1)
  const centerRow = piece.pos.row + 1;
  const centerCol = piece.pos.col + 1;

  // Check the 4 diagonal corners relative to center
  const corners = [
    { row: centerRow - 1, col: centerCol - 1 },
    { row: centerRow - 1, col: centerCol + 1 },
    { row: centerRow + 1, col: centerCol - 1 },
    { row: centerRow + 1, col: centerCol + 1 },
  ];

  let filledCorners = 0;
  for (const corner of corners) {
    // Out of bounds counts as filled (it's a wall)
    if (
      corner.row < 0 || corner.row >= BOARD_ROWS ||
      corner.col < 0 || corner.col >= BOARD_COLS
    ) {
      filledCorners++;
    } else if (board[corner.row][corner.col] !== 0) {
      filledCorners++;
    }
  }

  if (filledCorners >= 3) {
    return wasKicked ? "full" : "mini";
  }

  return "none";
}

export function calculateScore(linesCleared: number, level: number, tSpin: TSpinType = "none"): number {
  // T-Spin scoring (Guideline)
  if (tSpin === "full") {
    const tSpinPoints: Record<number, number> = { 0: 400, 1: 800, 2: 1200, 3: 1600 };
    return (tSpinPoints[linesCleared] || 0) * (level + 1);
  }
  if (tSpin === "mini") {
    const miniPoints: Record<number, number> = { 0: 100, 1: 200, 2: 400 };
    return (miniPoints[linesCleared] || 0) * (level + 1);
  }

  // Normal scoring
  const linePoints: Record<number, number> = { 1: 100, 2: 300, 3: 500, 4: 800 };
  return (linePoints[linesCleared] || 0) * (level + 1);
}

export function getLevel(totalLines: number): number {
  return Math.floor(totalLines / 10);
}

export function getDropInterval(level: number): number {
  // Speeds up as level increases, min 50ms
  return Math.max(50, 800 - level * 70);
}
