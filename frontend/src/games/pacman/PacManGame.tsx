import React, { useState } from "react";
import { usePacMan } from "./usePacMan.js";
import { MAZE_ROWS, MAZE_COLS } from "./maze.js";
import type { PacManState, GhostState, Direction, HighScoreEntry } from "./pacman-types.js";

function Cell({ value, row, col, pacman, ghosts }: {
  value: number; row: number; col: number;
  pacman: PacManState; ghosts: GhostState[];
}) {
  const isPacman = pacman.pos.row === row && pacman.pos.col === col;
  const ghostHere = ghosts.find(g => g.pos.row === row && g.pos.col === col && g.mode !== "eaten");

  if (isPacman) {
    const rotations: Record<Direction, string> = {
      right: "0deg", down: "90deg", left: "180deg", up: "270deg", none: "0deg",
    };
    // Classic Pac-Man mouth: wedge cut from a circle
    const mouthAngle = pacman.mouthOpen ? 30 : 5;
    return (
      <div className="pacman-cell" style={{ background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{
          width: "75%", height: "75%", borderRadius: "50%",
          background: "#ffff00",
          transform: `rotate(${rotations[pacman.dir]})`,
          clipPath: `polygon(100% 50%, ${100 * Math.cos(mouthAngle * Math.PI / 180)}% ${100 * (50 - 50 * Math.sin(mouthAngle * Math.PI / 180))}%, ${100 * Math.cos(mouthAngle * Math.PI / 180)}% ${100 * (50 + 50 * Math.sin(mouthAngle * Math.PI / 180))}%, 0% 0%, 0% 100%)`,
        }} />
      </div>
    );
  }

  if (ghostHere) {
    const frightened = ghostHere.mode === "frightened";
    const color = frightened ? "#2121de" : ghostHere.color;
    return (
      <div className="pacman-cell" style={{ background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: "70%", height: "70%", position: "relative" }}>
          {/* Ghost body */}
          <div style={{
            width: "100%", height: "85%", borderRadius: "50% 50% 0 0",
            background: color, position: "absolute", top: 0,
          }} />
          {/* Ghost skirt (wavy bottom) */}
          <div style={{
            width: "100%", height: "30%", position: "absolute", bottom: 0,
            background: color,
            clipPath: "polygon(0% 0%, 20% 100%, 40% 0%, 60% 100%, 80% 0%, 100% 100%, 100% 0%)",
          }} />
          {/* Eyes */}
          {!frightened && (
            <>
              <div style={{ position:"absolute", top:"18%", left:"12%", width:"30%", height:"35%", background:"#fff", borderRadius:"50%" }} />
              <div style={{ position:"absolute", top:"18%", right:"12%", width:"30%", height:"35%", background:"#fff", borderRadius:"50%" }} />
              <div style={{ position:"absolute", top:"28%", left:"20%", width:"14%", height:"18%", background:"#00f", borderRadius:"50%" }} />
              <div style={{ position:"absolute", top:"28%", right:"20%", width:"14%", height:"18%", background:"#00f", borderRadius:"50%" }} />
            </>
          )}
          {frightened && (
            <>
              {/* Frightened face */}
              <div style={{ position:"absolute", top:"25%", left:"22%", width:"12%", height:"12%", background:"#fff", borderRadius:"50%" }} />
              <div style={{ position:"absolute", top:"25%", right:"22%", width:"12%", height:"12%", background:"#fff", borderRadius:"50%" }} />
              <div style={{ position:"absolute", bottom:"15%", left:"15%", right:"15%", height:"2px", background:"#fff" }} />
            </>
          )}
        </div>
      </div>
    );
  }

  const bg = value === 1 ? "#1a1aff" : "#000";
  return (
    <div className="pacman-cell" style={{ background: bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {value === 2 && <div style={{ width: "20%", height: "20%", borderRadius: "50%", background: "#ffb8ae" }} />}
      {value === 3 && <div style={{ width: "45%", height: "45%", borderRadius: "50%", background: "#ffb8ae", animation: "pulse 0.6s infinite alternate" }} />}
      {value === 4 && <div style={{ width: "100%", height: "3px", background: "#ffb8ff" }} />}
    </div>
  );
}

function PacManScores({ scores, onRefresh, onClear }: {
  scores: HighScoreEntry[]; onRefresh: () => void; onClear: () => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <div className="tetris-scores">
      <h3>🏆 Pac-Man High Scores</h3>
      <div className="scores-actions">
        <button className="btn tetris-btn" onClick={onRefresh}>🔄 Refresh</button>
        <button className="btn tetris-btn" style={{ background: confirmClear ? "#c00" : undefined, color: confirmClear ? "#fff" : undefined }} onClick={() => { if (confirmClear) { onClear(); setConfirmClear(false); } else { setConfirmClear(true); } }}>
          {confirmClear ? "⚠️ Confirm?" : "🗑️ Clear"}
        </button>
      </div>
      {scores.length === 0 ? <p style={{ color: "#888", textAlign: "center", fontFamily: "'VT323', monospace" }}>No scores yet. Be the first!</p> : (
        <table className="scores-table">
          <thead><tr><th>#</th><th>Name</th><th>Score</th><th>Level</th></tr></thead>
          <tbody>
            {scores.map((s, i) => (
              <tr key={s.id ?? i}>
                <td>{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}</td>
                <td>{s.name}</td><td>{s.score.toLocaleString()}</td><td>{s.level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PacManGame() {
  const game = usePacMan();
  const [tab, setTab] = useState<"play" | "scores">("play");
  const [playerName, setPlayerName] = useState("AAA");

  const handleSubmitScore = () => {
    if (playerName.length > 0) {
      game.submitScore(playerName);
      setPlayerName("AAA");
    }
  };

  const clearScores = async () => {
    try { await fetch("/api/pacman/scores", { method: "DELETE" }); void game.fetchHighScores(); } catch {}
  };

  return (
    <div className="pacman-game">
      {/* Tabs — matching Tetris style */}
      <div className="tetris-tabs" style={{ borderBottom: "1px solid #333", marginBottom: "8px" }}>
        <button
          className={`tetris-tab-btn ${tab === "play" ? "active" : ""}`}
          onClick={() => setTab("play")}
        >
          🕹️ Play
        </button>
        <button
          className={`tetris-tab-btn ${tab === "scores" ? "active" : ""}`}
          onClick={() => setTab("scores")}
        >
          🏆 Scores
        </button>
      </div>

      {tab === "scores" && (
        <PacManScores scores={game.highScores} onRefresh={game.fetchHighScores} onClear={clearScores} />
      )}

      {tab === "play" && (
        <>
          <div className="pacman-stats">
            <div className="tetris-stat-block">
              <div className="tetris-stat-label">SCORE</div>
              <div className="tetris-stat-value">{game.score.toLocaleString()}</div>
            </div>
            <div className="tetris-stat-block">
              <div className="tetris-stat-label">LEVEL</div>
              <div className="tetris-stat-value">{game.level}</div>
            </div>
            <div className="tetris-stat-block">
              <div className="tetris-stat-label">LIVES</div>
              <div className="tetris-stat-value">{"💛".repeat(game.lives)}</div>
            </div>
          </div>

          <div className="pacman-board-wrap">
            <div className="pacman-board" style={{
              display: "grid",
              gridTemplateColumns: `repeat(${MAZE_COLS}, 1fr)`,
              gridTemplateRows: `repeat(${MAZE_ROWS}, 1fr)`,
              gap: "0px",
              width: `${MAZE_COLS * 16}px`,
              height: `${MAZE_ROWS * 16}px`,
              margin: "0 auto",
            }}>
              {game.grid.map((row, ri) =>
                row.map((cell, ci) => (
                  <Cell key={`${ri}-${ci}`} value={cell} row={ri} col={ci} pacman={game.pacman} ghosts={game.ghosts} />
                ))
              )}
            </div>

            {/* Overlays */}
            {game.gameState === "idle" && (
              <div className="pacman-overlay">
                <div className="pacman-overlay-content">
                  <h2>PAC-MAN</h2>
                  <div className="pacman-controls-hint">
                    <div>Arrow keys or WASD to move</div>
                    <div>P / Esc to pause</div>
                  </div>
                  <button className="btn tetris-btn tetris-btn-start" onClick={game.startGame}>
                    ▶ Start Game
                  </button>
                </div>
              </div>
            )}
            {game.gameState === "paused" && (
              <div className="pacman-overlay">
                <div className="pacman-overlay-content">
                  <h2>PAUSED</h2>
                  <button className="btn tetris-btn" onClick={game.togglePause}>
                    ▶ Resume
                  </button>
                </div>
              </div>
            )}
            {(game.gameState === "gameover" || game.gameState === "won") && !game.qualifyingRank && (
              <div className="pacman-overlay">
                <div className="pacman-overlay-content">
                  <h2>{game.gameState === "won" ? "🎉 YOU WIN!" : "GAME OVER"}</h2>
                  <div className="tetris-final-score">{game.score.toLocaleString()}</div>
                  <button className="btn tetris-btn tetris-btn-start" onClick={game.startGame}>
                    ↻ Play Again
                  </button>
                </div>
              </div>
            )}
            {(game.gameState === "gameover" || game.gameState === "won") && game.qualifyingRank && (
              <div className="pacman-overlay">
                <div className="tetris-name-overlay" style={{ position: "absolute" }}>
                  <div className="tetris-name-box">
                    <h3>🎮 New High Score!</h3>
                    <div className="tetris-name-stats">
                      <span>Score: {game.score.toLocaleString()}</span>
                      <span>Level: {game.level}</span>
                    </div>
                    <div className="tetris-name-input-row">
                      <input
                        className="tetris-name-input"
                        maxLength={3}
                        value={playerName}
                        onChange={(e) => setPlayerName(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                        onKeyDown={e => { if (e.key === "Enter") handleSubmitScore(); }}
                        autoFocus
                      />
                      <button className="btn tetris-btn" onClick={handleSubmitScore}>OK</button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Touch controls */}
          <div className="tetris-touch-controls" style={{ marginTop: "8px" }}>
            <div className="tetris-touch-row">
              <button className="btn tetris-btn tetris-touch-btn" onClick={() => { game.setNextDir("up"); }}>▲</button>
            </div>
            <div className="tetris-touch-row">
              <button className="btn tetris-btn tetris-touch-btn" onClick={() => { game.setNextDir("left"); }}>◀</button>
              <button className="btn tetris-btn tetris-touch-btn" onClick={() => { game.setNextDir("down"); }}>▼</button>
              <button className="btn tetris-btn tetris-touch-btn" onClick={() => { game.setNextDir("right"); }}>▶</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
