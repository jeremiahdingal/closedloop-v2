import React, { useState } from "react";
import { useTetris } from "./useTetris.js";
import { TetrisScores } from "./TetrisScores.js";
import { getPieceShape, getPieceColor } from "./pieces.js";
import type { TetrominoType, TSpinType } from "./tetris-types.js";

type CellDisplay = "empty" | "ghost" | string;

function PiecePreview({ type, dimmed }: { type: TetrominoType | null; dimmed?: boolean }) {
  if (!type) return <div className="tetris-preview-empty">{dimmed ? "" : "—"}</div>;
  const shape = getPieceShape(type, 0);
  const color = getPieceColor(type);
  return (
    <div className="tetris-preview-grid" style={dimmed ? { opacity: 0.4 } : {}}>
      {shape.map((row: number[], r: number) =>
        row.map((cell: number, c: number) => (
          <div
            key={`${r}-${c}`}
            className="tetris-preview-cell"
            style={{ backgroundColor: cell ? color : "transparent" }}
          />
        ))
      )}
    </div>
  );
}

function TSpinNotification({ type }: { type: TSpinType }) {
  if (type === "none") return null;
  const label = type === "full" ? "T-SPIN!" : "MINI T-SPIN";
  const cls = type === "full" ? "tspin-notification tspin-full" : "tspin-notification tspin-mini";
  return <div className={cls}>{label}</div>;
}

function NameInputModal({ score, level, lines, onSubmit }: {
  score: number;
  level: number;
  lines: number;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("AAA");
  return (
    <div className="tetris-name-overlay">
      <div className="tetris-name-box">
        <h3>🎮 New High Score!</h3>
        <div className="tetris-name-stats">
          <span>Score: {score.toLocaleString()}</span>
          <span>Level: {level}</span>
          <span>Lines: {lines}</span>
        </div>
        <div className="tetris-name-input-row">
          <input
            className="tetris-name-input"
            maxLength={3}
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            autoFocus
          />
          <button className="btn tetris-btn" onClick={() => onSubmit(name)}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

export function TetrisGame() {
  const {
    displayBoard,
    nextPreview,
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
  } = useTetris();

  const [tab, setTab] = useState<"play" | "scores">("play");

  return (
    <div className="tetris-container">
      {tab === "play" ? (
        <div className="tetris-main">
          <div className="tetris-board-wrap">
            <div className="tetris-board">
              {displayBoard.map((row: CellDisplay[], r: number) =>
                row.map((cell: CellDisplay, c: number) => (
                  <div
                    key={`${r}-${c}`}
                    className={`tetris-cell ${cell === "empty" ? "tetris-cell-empty" : cell === "ghost" ? "tetris-cell-ghost" : "tetris-cell-filled"}`}
                    style={
                      cell !== "empty" && cell !== "ghost"
                        ? { backgroundColor: cell, boxShadow: `inset 0 0 4px rgba(255,255,255,0.3)` }
                        : {}
                    }
                  />
                ))
              )}
            </div>
            {/* T-Spin notification overlay */}
            <TSpinNotification type={lastTSpin} />
            {/* Overlays */}
            {gameState === "idle" && (
              <div className="tetris-overlay">
                <div className="tetris-overlay-content">
                  <h2>TETRIS</h2>
                  <div className="tetris-controls-hint">
                    <div>← → Move · ↑ Rotate · ↓ Soft Drop</div>
                    <div>Space: Hard Drop · C: Hold · P/Esc: Pause</div>
                  </div>
                  <button className="btn tetris-btn tetris-btn-start" onClick={startGame}>
                    ▶ Start Game
                  </button>
                </div>
              </div>
            )}
            {gameState === "paused" && (
              <div className="tetris-overlay">
                <div className="tetris-overlay-content">
                  <h2>PAUSED</h2>
                  <button className="btn tetris-btn" onClick={togglePause}>
                    ▶ Resume
                  </button>
                </div>
              </div>
            )}
            {gameState === "gameover" && !qualifyingRank && (
              <div className="tetris-overlay">
                <div className="tetris-overlay-content">
                  <h2>GAME OVER</h2>
                  <div className="tetris-final-score">{score.toLocaleString()}</div>
                  <button className="btn tetris-btn tetris-btn-start" onClick={startGame}>
                    ↻ Play Again
                  </button>
                </div>
              </div>
            )}
            {gameState === "gameover" && qualifyingRank && (
              <div className="tetris-overlay">
                <NameInputModal
                  score={score}
                  level={level}
                  lines={lines}
                  onSubmit={(name) => {
                    void submitScore(name);
                  }}
                />
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="tetris-sidebar">
            {/* Hold piece */}
            <div className="tetris-stat-block">
              <div className="tetris-stat-label">HOLD <span className="tetris-key-hint">[C]</span></div>
              <PiecePreview type={holdPiece} dimmed={!canHold} />
            </div>
            <div className="tetris-stat-block">
              <div className="tetris-stat-label">SCORE</div>
              <div className="tetris-stat-value">{score.toLocaleString()}</div>
            </div>
            <div className="tetris-stat-block">
              <div className="tetris-stat-label">LEVEL</div>
              <div className="tetris-stat-value">{level}</div>
            </div>
            <div className="tetris-stat-block">
              <div className="tetris-stat-label">LINES</div>
              <div className="tetris-stat-value">{lines}</div>
            </div>
            <div className="tetris-stat-block">
              <div className="tetris-stat-label">NEXT</div>
              <PiecePreview type={nextPreview} />
            </div>
            {gameState === "playing" && (
              <button className="btn tetris-btn tetris-btn-pause" onClick={togglePause}>
                ⏸ Pause
              </button>
            )}

            {/* Touch controls */}
            <div className="tetris-touch-controls">
              <div className="tetris-touch-row">
                <button className="btn tetris-btn tetris-touch-btn" onClick={() => rotate()}>↻</button>
                <button className="btn tetris-btn tetris-touch-btn tetris-hold-btn" onClick={() => holdCurrentPiece()}>HOLD</button>
              </div>
              <div className="tetris-touch-row">
                <button className="btn tetris-btn tetris-touch-btn" onClick={() => movePiece(0, -1)}>◀</button>
                <button className="btn tetris-btn tetris-touch-btn" onClick={() => softDrop()}>▼</button>
                <button className="btn tetris-btn tetris-touch-btn" onClick={() => movePiece(0, 1)}>▶</button>
              </div>
              <div className="tetris-touch-row">
                <button className="btn tetris-btn tetris-touch-btn tetris-drop-btn" onClick={() => hardDrop()}>DROP</button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <TetrisScores scores={highScores} onRefresh={() => void fetchHighScores()} />
      )}

      {/* Tab switcher */}
      <div className="tetris-tabs">
        <button
          className={`btn tetris-tab-btn ${tab === "play" ? "active" : ""}`}
          onClick={() => setTab("play")}
        >
          🎮 Play
        </button>
        <button
          className={`btn tetris-tab-btn ${tab === "scores" ? "active" : ""}`}
          onClick={() => setTab("scores")}
        >
          🏆 Scores
        </button>
      </div>
    </div>
  );
}
