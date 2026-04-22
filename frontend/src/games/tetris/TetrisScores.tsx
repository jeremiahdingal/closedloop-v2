import React, { useState } from "react";
import type { HighScoreEntry } from "./tetris-types.js";

interface TetrisScoresProps {
  scores: HighScoreEntry[];
  onClose?: () => void;
  onRefresh: () => void;
}

export function TetrisScores({ scores, onRefresh }: TetrisScoresProps) {
  const [confirming, setConfirming] = useState(false);

  async function handleClear() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    try {
      await fetch("/api/tetris/scores", { method: "DELETE" });
      onRefresh();
    } catch {
      // ignore
    }
    setConfirming(false);
  }

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="tetris-scores-panel">
      <div className="tetris-scores-header">
        <h3>🏆 High Scores</h3>
        <div style={{ display: "flex", gap: "4px" }}>
          <button className="btn tetris-btn" onClick={onRefresh}>
            ↻
          </button>
          <button
            className={`btn tetris-btn ${confirming ? "tetris-btn-danger" : ""}`}
            onClick={handleClear}
          >
            {confirming ? "Confirm?" : "Clear"}
          </button>
        </div>
      </div>
      {scores.length === 0 ? (
        <div className="tetris-scores-empty">No scores yet. Be the first!</div>
      ) : (
        <table className="tetris-scores-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Score</th>
              <th>Lvl</th>
              <th>Lines</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {scores.map((entry, idx) => (
              <tr key={entry.name + entry.score + entry.date} className={idx < 3 ? "tetris-rank-top" : ""}>
                <td className="tetris-rank-cell">
                  {idx < 3 ? medals[idx] : idx + 1}
                </td>
                <td className="tetris-name-cell">{entry.name}</td>
                <td className="tetris-score-cell">{entry.score.toLocaleString()}</td>
                <td>{entry.level}</td>
                <td>{entry.lines}</td>
                <td className="tetris-date-cell">
                  {new Date(entry.date).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
