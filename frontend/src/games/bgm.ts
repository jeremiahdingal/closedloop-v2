// Chiptune BGM generator using Web Audio API
// Generates a classic arcade-style loop with square wave melody + triangle bass

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let melodyOsc: OscillatorNode | null = null;
let bassOsc: OscillatorNode | null = null;
let melodyGain: GainNode | null = null;
let bassGain: GainNode | null = null;
let playing = false;
let loopTimer: ReturnType<typeof setTimeout> | null = null;

// Note frequencies (Hz)
const NOTE: Record<string, number> = {
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  REST: 0,
};

// Melody pattern: [note, durationInBeats]
const MELODY: [string, number][] = [
  ["E4",1],["E4",1],["REST",1],["E4",1],["REST",1],["C4",1],["E4",2],
  ["G4",2],["REST",2],["G3",2],["REST",2],
  ["C4",1],["REST",1],["G3",1],["REST",1],["E3",1],["REST",1],
  ["A3",1],["B3",1],["REST",1],["A3",1],["REST",1],["G3",1],["E4",2],
  ["G4",1],["A4",1],["F4",1],["G4",1],["E4",2],["C4",1],["D4",1],
  ["B3",2],["REST",1],
];

const BASS: [string, number][] = [
  ["C3",2],["C3",2],["G3",2],["G3",2],
  ["C3",2],["C3",2],["G3",2],["G3",2],
  ["A3",2],["A3",2],["E3",2],["E3",2],
  ["F3",2],["G3",2],["C3",2],["REST",1],
];

const BPM = 180;
const BEAT_MS = 60000 / BPM;

function getCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
  }
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  return ctx;
}

function scheduleSequence(
  audioCtx: AudioContext,
  osc: OscillatorNode,
  gain: GainNode,
  pattern: [string, number][],
  startTime: number
): number {
  let t = startTime;
  for (const [noteName, beats] of pattern) {
    const freq = NOTE[noteName] ?? 0;
    const dur = (beats * BEAT_MS) / 1000;
    if (freq > 0) {
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.setValueAtTime(0.25, t + dur * 0.8);
      gain.gain.linearRampToValueAtTime(0, t + dur * 0.95);
    } else {
      gain.gain.setValueAtTime(0, t);
    }
    t += dur;
  }
  return t;
}

function getPatternDuration(pattern: [string, number][]): number {
  const totalBeats = pattern.reduce((sum, p) => sum + p[1], 0);
  return (totalBeats * BEAT_MS) / 1000;
}

function playLoop() {
  if (!playing) return;
  const audioCtx = getCtx();
  const now = audioCtx.currentTime + 0.05;

  // Melody — square wave
  melodyOsc = audioCtx.createOscillator();
  melodyGain = audioCtx.createGain();
  melodyOsc.type = "square";
  melodyOsc.connect(melodyGain).connect(masterGain!);
  melodyGain.gain.setValueAtTime(0, now);

  // Bass — triangle wave
  bassOsc = audioCtx.createOscillator();
  bassGain = audioCtx.createGain();
  bassOsc.type = "triangle";
  bassOsc.connect(bassGain).connect(masterGain!);
  bassGain.gain.setValueAtTime(0, now);

  scheduleSequence(audioCtx, melodyOsc, melodyGain, MELODY, now);
  scheduleSequence(audioCtx, bassOsc, bassGain, BASS, now);

  melodyOsc.start(now);
  bassOsc.start(now);

  const melodyDur = getPatternDuration(MELODY);
  const bassDur = getPatternDuration(BASS);
  const loopDur = Math.max(melodyDur, bassDur);

  melodyOsc.stop(now + melodyDur);
  bassOsc.stop(now + bassDur);

  loopTimer = setTimeout(() => {
    if (melodyOsc) { try { melodyOsc.disconnect(); } catch {} }
    if (bassOsc) { try { bassOsc.disconnect(); } catch {} }
    playLoop();
  }, loopDur * 1000 - 50); // slight overlap for seamless loop
}

export function startBGM(): void {
  if (playing) return;
  const audioCtx = getCtx();
  if (!masterGain) {
    masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    masterGain.connect(audioCtx.destination);
  }
  playing = true;
  playLoop();
}

export function stopBGM(): void {
  playing = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (melodyOsc) { try { melodyOsc.stop(); melodyOsc.disconnect(); } catch {} melodyOsc = null; }
  if (bassOsc) { try { bassOsc.stop(); bassOsc.disconnect(); } catch {} bassOsc = null; }
  if (melodyGain) { try { melodyGain.disconnect(); } catch {} melodyGain = null; }
  if (bassGain) { try { bassGain.disconnect(); } catch {} bassGain = null; }
}

export function setBGMVolume(vol: number): void {
  if (masterGain && ctx) {
    masterGain.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), ctx.currentTime);
  }
}

export function isBGMPlaying(): boolean {
  return playing;
}
