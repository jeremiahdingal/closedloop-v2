import React, { useState, useEffect } from "react";
import { TetrisGame } from "../games/tetris/TetrisGame.js";
import { PacManGame } from "../games/pacman/PacManGame.js";
import { TamagotchiGame } from "../games/tamagotchi/TamagotchiGame.js";
import { stopBGM } from "../games/bgm.js";

interface GameModalProps {
  isOpen: boolean;
  onClose: () => void;
  game?: "tetris" | "pacman" | "tamagotchi";
  onMinimize?: () => void;
}

export function GameModal({ isOpen, onClose, game = "tetris", onMinimize }: GameModalProps) {
  const [isMinimized, setIsMinimized] = useState(false);

  // When modal opens, reset minimized state
  useEffect(() => {
    if (isOpen) setIsMinimized(false);
  }, [isOpen]);

  // Stop BGM when modal closes or unmounts
  useEffect(() => {
    if (!isOpen) {
      stopBGM();
    }
    return () => {
      stopBGM();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const title = game === "pacman" ? "Pac-Man" : game === "tamagotchi" ? "Tamagotchi" : "Tetris";
  const icon = game === "pacman" ? "🕹️" : game === "tamagotchi" ? "🐾" : "🎮";

  const handleMinimize = () => {
    setIsMinimized(true);
    if (onMinimize) onMinimize();
  };

  const handleRestore = () => {
    setIsMinimized(false);
  };

  const handleClose = () => {
    stopBGM();
    onClose();
  };

  // Minimized: render a small taskbar button
  if (isMinimized) {
    return (
      <button
        className="game-taskbar-btn"
        onClick={handleRestore}
        title={`Restore ${title}`}
      >
        {icon} {title}
      </button>
    );
  }

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <div className="game-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <span>{icon}</span>
            <div className="modal-header-title-wrap">
              <h2>{title}</h2>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={handleMinimize} title="Minimize">
              ─
            </button>
            <button className="win-btn-box" onClick={handleClose} title="Close">
              ×
            </button>
          </div>
        </div>
        <div className="game-modal-body">
          {game === "tetris" && <TetrisGame />}
          {game === "pacman" && <PacManGame />}
          {game === "tamagotchi" && <TamagotchiGame />}
        </div>
      </div>
    </div>
  );
}
