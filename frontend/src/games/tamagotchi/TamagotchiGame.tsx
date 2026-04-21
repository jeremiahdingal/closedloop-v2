import React from "react";
import { useTamagotchi } from "./useTamagotchi.js";
import type { PetState, PetStage, PetMood } from "./tamagotchi-types.js";

// Emoji constants to avoid encoding issues
const EGG = "\u{1F95A}";
const BABY_HAPPY = "\u{1F423}";
const BABY_ECSTATIC = "\u{1F425}";
const CHILD_ECSTATIC = "\u{1F424}";
const TEEN = "\u{1F426}";
const ADULT_HAPPY = "\u{1F989}";
const ADULT_ECSTATIC = "\u{1F99A}";
const ELDER = "\u{1F985}";
const DEAD = "\u{1F480}";
const PAW = "\u{1F43E}";
const DRUMSTICK = "\u{1F356}";
const SMILE = "\u{1F60A}";
const ZAP = "\u26A1";
const HEART = "\u2764\uFE0F";
const SPARKLE = "\u2728";
const CROSS = "\u2715";

const SPRITES: Record<string, string> = {
  egg: EGG,
  "baby-happy": BABY_HAPPY,
  "baby-ecstatic": BABY_ECSTATIC,
  "baby-neutral": BABY_HAPPY,
  "baby-sad": BABY_HAPPY,
  "baby-miserable": BABY_HAPPY,
  "child-happy": BABY_ECSTATIC,
  "child-ecstatic": CHILD_ECSTATIC,
  "child-neutral": BABY_ECSTATIC,
  "child-sad": BABY_ECSTATIC,
  "child-miserable": BABY_ECSTATIC,
  "teen-happy": TEEN,
  "teen-ecstatic": TEEN,
  "teen-neutral": TEEN,
  "teen-sad": TEEN,
  "teen-miserable": TEEN,
  "adult-happy": ADULT_HAPPY,
  "adult-ecstatic": ADULT_ECSTATIC,
  "adult-neutral": ADULT_HAPPY,
  "adult-sad": ADULT_HAPPY,
  "adult-miserable": ADULT_HAPPY,
  "elder-happy": ELDER,
  "elder-ecstatic": ELDER,
  "elder-neutral": ELDER,
  "elder-sad": ELDER,
  "elder-miserable": ELDER,
  dead: DEAD,
};

function getSprite(pet: PetState): string {
  if (!pet.isAlive) return SPRITES.dead;
  return SPRITES[pet.stage + "-" + pet.mood] || SPRITES[pet.stage] || PAW;
}

function statColor(v: number): string {
  if (v >= 70) return "#4caf50";
  if (v >= 40) return "#ff9800";
  return "#f44336";
}

function StatBar(p: { label: string; value: number; icon: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
      <span style={{ width: 20, textAlign: "center" }}>{p.icon}</span>
      <span style={{ width: 70, fontSize: 11, color: "#ccc" }}>{p.label}</span>
      <div style={{ flex: 1, height: 10, background: "#333", borderRadius: 5, overflow: "hidden" }}>
        <div style={{ width: p.value + "%", height: "100%", background: statColor(p.value), borderRadius: 5, transition: "width 0.3s" }} />
      </div>
      <span style={{ width: 30, fontSize: 11, color: "#aaa", textAlign: "right" }}>{Math.round(p.value)}</span>
    </div>
  );
}

function ActionBtn(p: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={p.onClick}
      disabled={p.disabled}
      style={{
        padding: "8px 12px",
        fontSize: 13,
        border: "none",
        borderRadius: 8,
        background: p.disabled ? "#333" : "#2a5a8a",
        color: p.disabled ? "#555" : "#fff",
        cursor: p.disabled ? "not-allowed" : "pointer",
        transition: "background 0.2s",
      }}
    >
      {p.children}
    </button>
  );
}

/* ── Menu Screen ── */
function MenuScreen(p: {
  saves: { id: number; pet: PetState; savedAt: number }[];
  onNew: () => void;
  onLoad: (s: { id: number; pet: PetState; savedAt: number }) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 48, marginBottom: 8 }}>{EGG} {PAW}</div>
      <h2 style={{ margin: "0 0 16px", color: "#7fdbff" }}>Tamagotchi</h2>
      <button onClick={p.onNew} style={bigBtnStyle}>{BABY_HAPPY} New Pet</button>
      <div style={{ marginTop: 16, textAlign: "left" }}>
        <h3 style={{ color: "#aaa", fontSize: 13 }}>Saved Pets</h3>
        {p.saves.length === 0 && <p style={{ color: "#555", fontSize: 12 }}>No saves yet</p>}
        {p.saves.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: 8, background: "#1a1a2e", borderRadius: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 28 }}>{s.pet.isAlive ? getSprite(s.pet) : DEAD}</span>
            <div style={{ flex: 1 }}>
              <div style={{ color: "#eee", fontSize: 13 }}>{s.pet.name || "Unnamed"}</div>
              <div style={{ color: "#777", fontSize: 11 }}>
                {s.pet.isAlive
                  ? "Stage: " + s.pet.stage + " | Mood: " + s.pet.mood
                  : "Died of " + s.pet.causeOfDeath}
                {" | " + new Date(s.savedAt).toLocaleDateString()}
              </div>
            </div>
            <button onClick={() => p.onLoad(s)} style={smBtnStyle}>Load</button>
            <button onClick={() => p.onDelete(s.id)} style={{ ...smBtnStyle, background: "#8a2a2a" }}>{CROSS}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Naming Screen ── */
function NamingScreen(p: { onConfirm: (name: string) => void }) {
  const [name, setName] = React.useState("");
  return (
    <div style={{ textAlign: "center", paddingTop: 40 }}>
      <div style={{ fontSize: 56, marginBottom: 12 }}>{EGG}</div>
      <h3 style={{ color: "#7fdbff" }}>Name your new pet!</h3>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (name.trim() && e.key === "Enter") p.onConfirm(name); }}
        placeholder="Enter a name..."
        autoFocus
        style={{ padding: "8px 14px", fontSize: 16, borderRadius: 8, border: "2px solid #2a5a8a", background: "#1a1a2e", color: "#eee", width: "60%", textAlign: "center", marginTop: 8 }}
      />
      <div style={{ marginTop: 12 }}>
        <button onClick={() => p.onConfirm(name)} disabled={!name.trim()} style={bigBtnStyle}>Confirm</button>
      </div>
    </div>
  );
}

/* ── Playing Screen ── */
function PlayingScreen(p: {
  pet: PetState;
  onAction: (a: "feed" | "play" | "sleep" | "clean" | "medicine" | "wake") => void;
  onHatch: () => void;
  onMenu: () => void;
  onRestart: (name: string) => void;
}) {
  const pet = p.pet;

  if (!pet.isAlive) {
    return (
      <div style={{ textAlign: "center", paddingTop: 30 }}>
        <div style={{ fontSize: 64 }}>{DEAD}</div>
        <h2 style={{ color: "#f44336", margin: "8px 0" }}>{pet.name} has passed away</h2>
        <p style={{ color: "#aaa" }}>Cause: {pet.causeOfDeath}</p>
        <p style={{ color: "#777", fontSize: 12 }}>Lived for {Math.round(pet.age)} game-minutes</p>
        <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={() => p.onRestart(pet.name)} style={bigBtnStyle}>New Pet</button>
          <button onClick={p.onMenu} style={bigBtnStyle}>Menu</button>
        </div>
      </div>
    );
  }

  const isEgg = pet.stage === "egg";

  return (
    <div>
      {/* Pet display */}
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <div style={{ fontSize: 72, lineHeight: 1, filter: pet.isSleeping ? "brightness(0.6)" : undefined }}>
          {getSprite(pet)}
        </div>
        {pet.isSleeping && <div style={{ color: "#7fdbff", fontSize: 12, marginTop: 4 }}>Sleeping...</div>}
        {pet.isSick && <div style={{ color: "#f44336", fontSize: 12, marginTop: 2 }}>Feeling sick!</div>}
        <div style={{ color: "#eee", fontSize: 16, marginTop: 4 }}>{pet.name}</div>
        <div style={{ color: "#888", fontSize: 11 }}>
          Stage: {pet.stage} | Age: {Math.round(pet.age)} min | Mood: {pet.mood}
        </div>
      </div>

      {/* Stats */}
      <div style={{ padding: "0 8px" }}>
        <StatBar label="Hunger" value={pet.hunger} icon={DRUMSTICK} />
        <StatBar label="Happy" value={pet.happiness} icon={SMILE} />
        <StatBar label="Energy" value={pet.energy} icon={ZAP} />
        <StatBar label="Health" value={pet.health} icon={HEART} />
        <StatBar label="Clean" value={pet.cleanliness} icon={SPARKLE} />
      </div>

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginTop: 12 }}>
        {isEgg ? (
          <button onClick={p.onHatch} style={{ ...bigBtnStyle, fontSize: 18, padding: "12px 28px" }}>Tap to Hatch!</button>
        ) : (
          <>
            <ActionBtn onClick={() => p.onAction("feed")} disabled={pet.isSleeping}>{DRUMSTICK} Feed</ActionBtn>
            <ActionBtn onClick={() => p.onAction("play")} disabled={pet.isSleeping || pet.energy < 10}>Play</ActionBtn>
            <ActionBtn onClick={() => p.onAction(pet.isSleeping ? "wake" : "sleep")}>
              {pet.isSleeping ? "Wake" : "Sleep"}
            </ActionBtn>
            <ActionBtn onClick={() => p.onAction("clean")} disabled={pet.isSleeping}>{SPARKLE} Clean</ActionBtn>
            <ActionBtn onClick={() => p.onAction("medicine")} disabled={pet.isSleeping || (!pet.isSick && pet.health > 70)}>Medicine</ActionBtn>
          </>
        )}
      </div>

      <div style={{ textAlign: "center", marginTop: 12 }}>
        <button onClick={p.onMenu} style={{ ...smBtnStyle, background: "#333", color: "#aaa" }}>Back to Menu</button>
      </div>
    </div>
  );
}

/* ── Styles ── */
const bigBtnStyle: React.CSSProperties = {
  padding: "10px 22px",
  fontSize: 14,
  border: "none",
  borderRadius: 10,
  background: "#2a5a8a",
  color: "#fff",
  cursor: "pointer",
  fontWeight: 600,
};
const smBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  border: "none",
  borderRadius: 6,
  background: "#2a5a8a",
  color: "#fff",
  cursor: "pointer",
};

/* ── Main Export ── */
export function TamagotchiGame() {
  const {
    screen, pet, saves,
    doAction, doHatch, startNewGame, confirmName, loadGame, deleteGame, goToMenu, restartGame,
  } = useTamagotchi();

  return (
    <div style={{
      background: "#0d0d1a",
      borderRadius: 16,
      padding: 16,
      color: "#eee",
      fontFamily: "'Segoe UI', sans-serif",
      maxWidth: 380,
      margin: "0 auto",
      minHeight: 480,
      border: "2px solid #1a1a3e",
      boxShadow: "0 0 20px rgba(0,200,255,0.1)",
    }}>
      {screen === "menu" && <MenuScreen saves={saves} onNew={startNewGame} onLoad={loadGame} onDelete={deleteGame} />}
      {screen === "naming" && <NamingScreen onConfirm={confirmName} />}
      {screen === "playing" && <PlayingScreen pet={pet} onAction={doAction} onHatch={doHatch} onMenu={goToMenu} onRestart={restartGame} />}
    </div>
  );
}
