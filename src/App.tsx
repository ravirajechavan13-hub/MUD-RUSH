import { useCallback, useEffect, useRef, useState } from "react";
import { ScreenOrientation } from "@capacitor/screen-orientation";

const GAME_W = 432;
const GAME_H = 768;
const CAR_START_X = 112;
const HALF_WHEELBASE = 38;
const WHEEL_RADIUS = 17;
// The reference car has the axle centers tucked high inside the fender arches.
// Keep a visible, believable gap between the fender edge and tire crown.
const SUSPENSION_REST_Y = 20;
const GRAVITY = 670;
const BODY_INERTIA = 2550;
const SPRING_STRENGTH = 150;
const SPRING_DAMPING = 11;
const TIRE_GRIP = 1.35;
const WHEEL_INERTIA = 300;
const WORLD_ZOOM = 0.74;
const COIN_START_X = 950;
const COIN_CLUSTER_GAP = 1750;
const COIN_SPACING = 92;
const FUEL_START_X = 2200;
const FUEL_SPACING = 4800;
const FEATURE_START_X = CAR_START_X + 1000 * 9;
const DIFFICULTY_END_X = CAR_START_X + 50000 * 9;
const NIGHT_DISTANCE = 10000;
const STAR_DISTANCE = 20000;
const FEATURE_CYCLE = 7600;

type Screen = "menu" | "playing" | "paused" | "gameover";
type InputState = { gas: boolean; brake: boolean };
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  color: string;
};

type GameState = {
  carX: number;
  carY: number;
  vx: number;
  vy: number;
  angle: number;
  angularVelocity: number;
  grounded: boolean;
  cameraX: number;
  cameraY: number;
  fuel: number;
  coins: number;
  distance: number;
  wheelSpin: number;
  wheelAngularVelocity: number;
  rearSuspension: number;
  frontSuspension: number;
  rearSuspensionVelocity: number;
  frontSuspensionVelocity: number;
  brakeHold: number;
  triggeredRamps: Set<number>;
  hitLogs: Set<number>;
  hitCracks: Set<number>;
  brokenBridges: Set<number>;
  collectedCoins: Set<number>;
  collectedFuel: Set<number>;
  particles: Particle[];
  dustClock: number;
  runTime: number;
  hintTime: number;
  airTime: number;
  impactFlash: number;
  reason: string;
};

type HudState = { distance: number; coins: number; fuel: number; speed: number; level: string };
type SpriteSource = HTMLImageElement | HTMLCanvasElement;
type AudioEngine = {
  context: AudioContext;
  update: (playing: boolean, rpm: number, throttle: boolean) => void;
  coin: () => void;
  fuel: () => void;
  land: (strength: number) => void;
  setMuted: (muted: boolean) => void;
  close: () => void;
};

// Image generators sometimes bake a white matte into PNGs. Remove only the
// light pixels connected to the outside, preserving highlights inside the car.
function removeLightBackground(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;

  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const pixelCount = canvas.width * canvas.height;
  const queued = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let readIndex = 0;
  let writeIndex = 0;

  const isOutsideColor = (pixelIndex: number) => {
    const offset = pixelIndex * 4;
    if (data[offset + 3] < 18) return true;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    return Math.min(red, green, blue) > 205 && Math.max(red, green, blue) - Math.min(red, green, blue) < 34;
  };

  const enqueue = (pixelIndex: number) => {
    if (queued[pixelIndex] || !isOutsideColor(pixelIndex)) return;
    queued[pixelIndex] = 1;
    queue[writeIndex] = pixelIndex;
    writeIndex += 1;
  };

  for (let x = 0; x < canvas.width; x += 1) {
    enqueue(x);
    enqueue((canvas.height - 1) * canvas.width + x);
  }
  for (let y = 0; y < canvas.height; y += 1) {
    enqueue(y * canvas.width);
    enqueue(y * canvas.width + canvas.width - 1);
  }

  while (readIndex < writeIndex) {
    const pixelIndex = queue[readIndex];
    readIndex += 1;
    data[pixelIndex * 4 + 3] = 0;
    const x = pixelIndex % canvas.width;
    const y = Math.floor(pixelIndex / canvas.width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x < canvas.width - 1) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - canvas.width);
    if (y < canvas.height - 1) enqueue(pixelIndex + canvas.width);
  }

  // Fade the remaining bright anti-aliased edge instead of leaving a white halo.
  for (let pass = 0; pass < 2; pass += 1) {
    const nextAlpha = new Uint8Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) nextAlpha[pixelIndex] = data[pixelIndex * 4 + 3];
    for (let y = 1; y < canvas.height - 1; y += 1) {
      for (let x = 1; x < canvas.width - 1; x += 1) {
        const pixelIndex = y * canvas.width + x;
        const offset = pixelIndex * 4;
        if (data[offset + 3] === 0) continue;
        const touchesTransparency =
          data[(pixelIndex - 1) * 4 + 3] === 0 ||
          data[(pixelIndex + 1) * 4 + 3] === 0 ||
          data[(pixelIndex - canvas.width) * 4 + 3] === 0 ||
          data[(pixelIndex + canvas.width) * 4 + 3] === 0;
        if (!touchesTransparency) continue;
        const minimum = Math.min(data[offset], data[offset + 1], data[offset + 2]);
        const range = Math.max(data[offset], data[offset + 1], data[offset + 2]) - minimum;
        if (minimum > 170 && range < 48) nextAlpha[pixelIndex] = Math.min(nextAlpha[pixelIndex], 45);
      }
    }
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) data[pixelIndex * 4 + 3] = nextAlpha[pixelIndex];
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function distanceAtWorldX(x: number) {
  return Math.max(0, (x - CAR_START_X) / 9);
}

function difficultyAtWorldX(x: number) {
  const distance = distanceAtWorldX(x);
  return Math.min(
    1,
    0.1 +
      smoothstep(100, 900, distance) * 0.12 +
      smoothstep(900, 1100, distance) * 0.18 +
      smoothstep(1900, 2100, distance) * 0.22 +
      smoothstep(2900, 3300, distance) * 0.22 +
      smoothstep(3800, 5000, distance) * 0.06 +
      smoothstep(5000, 50000, distance) * 0.1,
  );
}

function levelRankAtDistance(distance: number) {
  if (distance < 1000) return 0;
  if (distance < 2000) return 1;
  if (distance < 3000) return 2;
  return 3;
}

function levelLabelAtDistance(distance: number) {
  const rank = levelRankAtDistance(distance);
  if (rank === 0) return "SIMPLE";
  if (rank === 1) return "MEDIUM";
  if (rank === 2) return "HARD";
  return distance < 5000 ? "VERY HARD" : "VERY HARD +";
}

function terrainHeight(x: number) {
  const t = x - 185;
  const difficulty = difficultyAtWorldX(x);
  const lateGame = smoothstep(CAR_START_X + 15000 * 9, DIFFICULTY_END_X, x);
  // Large elevation comes from broad waves. Keeping amplitude / wavelength
  // controlled prevents narrow V-shaped traps that the vehicle cannot climb.
  const climbAmplitude = 27 + difficulty * 154 + lateGame * 16;
  const primaryWave = 302 - difficulty * 62;
  const secondaryAmplitude = 4 + difficulty * 28;
  const secondaryWave = 188 - difficulty * 28;
  const hills =
    -climbAmplitude * Math.sin(t / primaryWave) -
    secondaryAmplitude * Math.sin(t / secondaryWave) -
    (5 + difficulty * 20) * Math.sin(t / (500 - difficulty * 55)) +
    3 * Math.sin(t / 102);

  // Smooth localized humps and potholes create tire movement without ever
  // disconnecting adjacent terrain vertices or creating vertical walls.
  let roughness = 0;
  if (x > CAR_START_X + 650 * 9) {
    const spacing = 390 - difficulty * 115;
    const cell = Math.floor((x - FEATURE_START_X) / spacing);
    for (let offset = -1; offset <= 1; offset += 1) {
      const index = Math.max(0, cell + offset);
      const random = seededRandom(index + 301);
      const center = FEATURE_START_X + (index + 0.28 + random * 0.44) * spacing;
      const width = 72 + seededRandom(index + 401) * 85;
      const delta = (x - center) / width;
      const signedHeight = seededRandom(index + 501) > 0.34 ? -1 : 1;
      roughness += signedHeight * (2 + difficulty * 7) * Math.exp(-delta * delta * 1.9);
    }
  }

  return 572 + (hills + roughness) * smoothstep(150, 390, x);
}

function terrainSlope(x: number) {
  return (terrainHeight(x + 3) - terrainHeight(x - 3)) / 6;
}

function normalizeAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function roadPose(x: number) {
  let angle = Math.atan2(
    terrainHeight(x + HALF_WHEELBASE) - terrainHeight(x - HALF_WHEELBASE),
    HALF_WHEELBASE * 2,
  );
  let rearGroundY = 0;
  let frontGroundY = 0;

  // Refine the contact points because rotating the body also shifts both axles.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const rearX = x - HALF_WHEELBASE * Math.cos(angle) - SUSPENSION_REST_Y * Math.sin(angle);
    const frontX = x + HALF_WHEELBASE * Math.cos(angle) - SUSPENSION_REST_Y * Math.sin(angle);
    rearGroundY = terrainHeight(rearX);
    frontGroundY = terrainHeight(frontX);
    angle = Math.atan2(frontGroundY - rearGroundY, Math.max(1, frontX - rearX));
  }
  const wheelCenterY = (rearGroundY + frontGroundY) * 0.5 - WHEEL_RADIUS;
  const bodyY = wheelCenterY - Math.cos(angle) * SUSPENSION_REST_Y;
  return { angle, bodyY, rearGroundY, frontGroundY };
}

function seededRandom(seed: number) {
  const value = Math.sin(seed * 91.733 + 17.17) * 43758.5453;
  return value - Math.floor(value);
}

function coinClusterSize(cluster: number) {
  return seededRandom(cluster + 43) > 0.48 ? 3 : 2;
}

function coinPosition(cluster: number, slot: number) {
  const jitter = (seededRandom(cluster + 7) - 0.5) * 520;
  const x = COIN_START_X + cluster * COIN_CLUSTER_GAP + jitter + slot * COIN_SPACING;
  const coinArc = coinClusterSize(cluster) === 3 ? [0, 15, 0][slot] : [5, 5][slot];
  const y = terrainHeight(x) - 52 - coinArc;
  return { x, y };
}

function coinId(cluster: number, slot: number) {
  return cluster * 3 + slot;
}

function featureInfo(x: number) {
  if (x < FEATURE_START_X) return { cycle: -1, phase: -1 };
  const shifted = x - FEATURE_START_X;
  return { cycle: Math.floor(shifted / FEATURE_CYCLE), phase: shifted % FEATURE_CYCLE };
}

function featureLayout(cycle: number) {
  const baseX = FEATURE_START_X + cycle * FEATURE_CYCLE;
  return {
    baseX,
    boostStart: baseX + 720 + seededRandom(cycle + 701) * 390,
    logX: baseX + 1780 + seededRandom(cycle + 702) * 520,
    mudStart: baseX + 2700 + seededRandom(cycle + 703) * 460,
    crackStart: baseX + 3900 + seededRandom(cycle + 704) * 420,
    bridgeStart: baseX + 4800 + seededRandom(cycle + 705) * 380,
    gripStart: baseX + 5900 + seededRandom(cycle + 706) * 310,
    rampX: baseX + 6750 + seededRandom(cycle + 707) * 350,
  };
}

function logGroupCount(cycle: number) {
  return seededRandom(cycle + 760) > 0.52 ? 3 : 1;
}

function logGroupsInCycle(cycle: number) {
  const distance = distanceAtWorldX(featureLayout(cycle).baseX);
  if (distance < 2000) return 1;
  if (distance < 3000) return 2;
  if (distance < 5000) return 3;
  return Math.min(5, 3 + Math.floor((distance - 5000) / 10000));
}

function logGroupCenter(cycle: number, group: number) {
  const layout = featureLayout(cycle);
  const phases = [
    layout.logX,
    layout.mudStart - 420,
    layout.crackStart - 330,
    layout.gripStart - 360,
    layout.rampX - 430,
  ];
  return phases[group] + (seededRandom(cycle * 13 + group + 780) - 0.5) * 130;
}

function logPosition(cycle: number, group: number, slot: number) {
  return logGroupCenter(cycle, group) + slot * 43;
}

function surfaceGripAt(x: number) {
  const info = featureInfo(x);
  if (info.cycle < 0) return 1;
  const layout = featureLayout(info.cycle);
  const rank = levelRankAtDistance(distanceAtWorldX(x));
  if (x >= layout.mudStart && x <= layout.mudStart + 620) return 0.24;
  if (rank >= 2 && x >= layout.crackStart && x <= layout.crackStart + 520) return 0.62;
  if (x >= layout.gripStart && x <= layout.gripStart + 460) return 1.45;
  return 1;
}

function fuelPosition(index: number) {
  const x = FUEL_START_X + index * FUEL_SPACING;
  return { x, y: terrainHeight(x) - 58 };
}

function createGame(): GameState {
  const startPose = roadPose(CAR_START_X);
  return {
    carX: CAR_START_X,
    // A small preload lets the springs support the body immediately.
    carY: startPose.bodyY + 2.25,
    vx: 0,
    vy: 0,
    angle: startPose.angle,
    angularVelocity: 0,
    grounded: true,
    cameraX: 0,
    cameraY: -34,
    fuel: 100,
    coins: 0,
    distance: 0,
    wheelSpin: 0,
    wheelAngularVelocity: 0,
    rearSuspension: -2.25,
    frontSuspension: -2.25,
    rearSuspensionVelocity: 0,
    frontSuspensionVelocity: 0,
    brakeHold: 0,
    triggeredRamps: new Set(),
    hitLogs: new Set(),
    hitCracks: new Set(),
    brokenBridges: new Set(),
    collectedCoins: new Set(),
    collectedFuel: new Set(),
    particles: [],
    dustClock: 0,
    runTime: 0,
    hintTime: 4.8,
    airTime: 0,
    impactFlash: 0,
    reason: "",
  };
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5v14M17 5v14" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 10v4h4l5 4V6l-5 4H5z" fill="currentColor" />
      {muted ? (
        <path d="m17 9 4 6m0-6-4 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      ) : (
        <path d="M17 9.2c1.7 1.5 1.7 4.1 0 5.6M19.5 7c3 2.8 3 7.2 0 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

function FuelIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 20V5.8C5 4.8 5.8 4 6.8 4h6.4c1 0 1.8.8 1.8 1.8V20M4 20h13M7.5 8h5M15 7h2l2 2.5V16c0 .8.5 1.5 1.2 1.5s1.3-.7 1.3-1.5v-5l-2-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 8a8 8 0 1 1-1 7M5 8V3m0 5h5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 21V4m0 1c4-2.5 7 2 12-.5v9c-5 2.5-8-2-12 .5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameState>(createGame());
  const inputRef = useRef<InputState>({ gas: false, brake: false });
  const screenRef = useRef<Screen>("menu");
  const carImageRef = useRef<SpriteSource | null>(null);
  const wheelImageRef = useRef<SpriteSource | null>(null);
  const suspensionImageRef = useRef<SpriteSource | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const mutedRef = useRef(localStorage.getItem("mudrush-muted") === "true");
  const [screen, setScreen] = useState<Screen>("menu");
  const [hud, setHud] = useState<HudState>({ distance: 0, coins: 0, fuel: 100, speed: 0, level: "SIMPLE" });
  const [best, setBest] = useState(() => Number(localStorage.getItem("mudrush-best") || 0));
  const [muted, setMuted] = useState(mutedRef.current);

  useEffect(() => {
    void ScreenOrientation.lock({ orientation: "portrait" }).catch(() => {
      // Browser previews may not permit orientation lock; Android does.
    });
  }, []);

  const changeScreen = useCallback((next: Screen) => {
    screenRef.current = next;
    setScreen(next);
  }, []);

  const ensureAudio = useCallback(() => {
    if (audioRef.current?.context.state === "closed") audioRef.current = null;
    if (!audioRef.current) {
      const AudioContextClass = window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;

      const context = new AudioContextClass();
      const master = context.createGain();
      const compressor = context.createDynamicsCompressor();
      master.gain.value = mutedRef.current ? 0 : 0.32;
      compressor.threshold.value = -22;
      compressor.knee.value = 18;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.008;
      compressor.release.value = 0.22;
      master.connect(compressor);
      compressor.connect(context.destination);

      const engineGain = context.createGain();
      const engineFilter = context.createBiquadFilter();
      const engineLow = context.createOscillator();
      const engineHigh = context.createOscillator();
      const engineHighGain = context.createGain();
      engineGain.gain.value = 0.0001;
      engineFilter.type = "lowpass";
      engineFilter.frequency.value = 360;
      engineFilter.Q.value = 0.7;
      engineLow.type = "triangle";
      engineHigh.type = "sawtooth";
      engineHighGain.gain.value = 0.035;
      engineLow.connect(engineFilter);
      engineHigh.connect(engineHighGain);
      engineHighGain.connect(engineFilter);
      engineFilter.connect(engineGain);
      engineGain.connect(master);

      // Filtered brown noise adds a soft exhaust/road rumble without a sharp buzz.
      const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const noiseData = noiseBuffer.getChannelData(0);
      let previousNoise = 0;
      for (let sample = 0; sample < noiseData.length; sample += 1) {
        previousNoise = (previousNoise + (Math.random() * 2 - 1) * 0.025) / 1.025;
        noiseData[sample] = previousNoise * 3.2;
      }
      const exhaustNoise = context.createBufferSource();
      const exhaustFilter = context.createBiquadFilter();
      const exhaustGain = context.createGain();
      exhaustNoise.buffer = noiseBuffer;
      exhaustNoise.loop = true;
      exhaustFilter.type = "lowpass";
      exhaustFilter.frequency.value = 190;
      exhaustFilter.Q.value = 0.6;
      exhaustGain.gain.value = 0.0001;
      exhaustNoise.connect(exhaustFilter);
      exhaustFilter.connect(exhaustGain);
      exhaustGain.connect(master);
      engineLow.start();
      engineHigh.start();
      exhaustNoise.start();

      const playTone = (frequency: number, duration: number, volume: number, type: OscillatorType) => {
        const now = context.currentTime;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, now);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.55, now + duration);
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(now);
        oscillator.stop(now + duration + 0.02);
      };

      audioRef.current = {
        context,
        update: (playing, rpm, throttle) => {
          const now = context.currentTime;
          const normalizedRpm = Math.min(1, Math.abs(rpm) / 38);
          const baseFrequency = 42 + normalizedRpm * 96;
          engineLow.frequency.setTargetAtTime(baseFrequency, now, 0.035);
          engineHigh.frequency.setTargetAtTime(baseFrequency * 2.01, now, 0.04);
          engineFilter.frequency.setTargetAtTime(280 + normalizedRpm * 610, now, 0.07);
          exhaustFilter.frequency.setTargetAtTime(150 + normalizedRpm * 240, now, 0.08);
          const toneVolume = playing ? (throttle ? 0.15 + normalizedRpm * 0.075 : 0.011) : 0.0001;
          const rumbleVolume = playing ? (throttle ? 0.075 + normalizedRpm * 0.048 : 0.005) : 0.0001;
          engineGain.gain.setTargetAtTime(toneVolume, now, throttle ? 0.045 : 0.14);
          exhaustGain.gain.setTargetAtTime(rumbleVolume, now, throttle ? 0.055 : 0.16);
        },
        coin: () => {
          playTone(780, 0.11, 0.075, "sine");
          window.setTimeout(() => playTone(1040, 0.08, 0.045, "sine"), 42);
        },
        fuel: () => {
          playTone(310, 0.18, 0.2, "sawtooth");
          window.setTimeout(() => playTone(465, 0.2, 0.18, "sine"), 80);
        },
        land: (strength) => {
          const now = context.currentTime;
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(82, now);
          oscillator.frequency.exponentialRampToValueAtTime(34, now + 0.16);
          gain.gain.setValueAtTime(Math.min(0.28, 0.08 + strength * 0.2), now);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
          oscillator.connect(gain);
          gain.connect(master);
          oscillator.start(now);
          oscillator.stop(now + 0.2);
        },
        setMuted: (nextMuted) => {
          master.gain.setTargetAtTime(nextMuted ? 0 : 0.32, context.currentTime, 0.025);
        },
        close: () => {
          engineLow.stop();
          engineHigh.stop();
          exhaustNoise.stop();
          void context.close();
        },
      };
    }
    const audio = audioRef.current;
    if (audio?.context.state === "suspended") void audio.context.resume();
  }, []);

  const toggleMute = useCallback(() => {
    ensureAudio();
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    localStorage.setItem("mudrush-muted", String(nextMuted));
    audioRef.current?.setMuted(nextMuted);
    setMuted(nextMuted);
  }, [ensureAudio]);

  const startGame = useCallback(() => {
    ensureAudio();
    inputRef.current = { gas: false, brake: false };
    gameRef.current = createGame();
    setHud({ distance: 0, coins: 0, fuel: 100, speed: 0, level: "SIMPLE" });
    changeScreen("playing");
  }, [changeScreen, ensureAudio]);

  const resumeGame = useCallback(() => {
    ensureAudio();
    inputRef.current = { gas: false, brake: false };
    changeScreen("playing");
  }, [changeScreen, ensureAudio]);

  const togglePause = useCallback(() => {
    if (screenRef.current === "playing") {
      inputRef.current = { gas: false, brake: false };
      changeScreen("paused");
    } else if (screenRef.current === "paused") {
      resumeGame();
    }
  }, [changeScreen, resumeGame]);

  useEffect(() => {
    const car = new Image();
    car.onload = () => {
      carImageRef.current = removeLightBackground(car);
    };
    car.src = "/images/yellow-safari-car.png";
    const wheel = new Image();
    wheel.onload = () => {
      wheelImageRef.current = removeLightBackground(wheel);
    };
    wheel.src = "/images/mud-wheel.png";

    const suspension = new Image();
    suspension.onload = () => {
      suspensionImageRef.current = removeLightBackground(suspension);
    };
    suspension.src = "/images/red-coilover.png";
  }, []);

  useEffect(() => () => {
    audioRef.current?.close();
    audioRef.current = null;
  }, []);

  useEffect(() => {
    const releaseControls = () => {
      inputRef.current.gas = false;
      inputRef.current.brake = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowRight", "ArrowLeft", "Space", "KeyA", "KeyD"].includes(event.code)) event.preventDefault();
      if (event.code === "ArrowRight" || event.code === "KeyD" || event.code === "Space") inputRef.current.gas = true;
      if (event.code === "ArrowLeft" || event.code === "KeyA") inputRef.current.brake = true;
      if (event.code === "Escape" || event.code === "KeyP") togglePause();
      if (event.code === "KeyM") toggleMute();
      if (event.code === "Enter" && (screenRef.current === "menu" || screenRef.current === "gameover")) startGame();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "ArrowRight" || event.code === "KeyD" || event.code === "Space") inputRef.current.gas = false;
      if (event.code === "ArrowLeft" || event.code === "KeyA") inputRef.current.brake = false;
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerup", releaseControls);
    window.addEventListener("pointercancel", releaseControls);
    window.addEventListener("blur", releaseControls);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", releaseControls);
      window.removeEventListener("pointercancel", releaseControls);
      window.removeEventListener("blur", releaseControls);
    };
  }, [startGame, toggleMute, togglePause]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = GAME_W * dpr;
    canvas.height = GAME_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let animationFrame = 0;
    let previousTime = performance.now();
    let hudClock = 0;

    const endRun = (reason: string) => {
      if (screenRef.current !== "playing") return;
      const game = gameRef.current;
      game.reason = reason;
      inputRef.current = { gas: false, brake: false };
      const wholeDistance = Math.floor(game.distance);
      setBest((oldBest) => {
        const nextBest = Math.max(oldBest, wholeDistance);
        localStorage.setItem("mudrush-best", String(nextBest));
        return nextBest;
      });
      changeScreen("gameover");
    };

    const addDust = (game: GameState, amount = 1) => {
      for (let i = 0; i < amount; i += 1) {
        const maxLife = 0.45 + Math.random() * 0.35;
        game.particles.push({
          x: game.carX - 42 + Math.random() * 10,
          y: game.carY + 22 + Math.random() * 6,
          vx: -25 - Math.random() * 48 - Math.max(0, game.vx) * 0.12,
          vy: -8 - Math.random() * 24,
          size: 4 + Math.random() * 8,
          life: maxLife,
          maxLife,
          color: "#9a7046",
        });
      }
    };

    const addCoinBurst = (game: GameState, x: number, y: number) => {
      for (let i = 0; i < 8; i += 1) {
        const angle = (Math.PI * 2 * i) / 8;
        const maxLife = 0.34 + Math.random() * 0.2;
        game.particles.push({
          x,
          y,
          vx: Math.cos(angle) * (28 + Math.random() * 28),
          vy: Math.sin(angle) * (28 + Math.random() * 28) - 14,
          size: 2.4 + Math.random() * 2.8,
          life: maxLife,
          maxLife,
          color: i % 2 === 0 ? "#ffd653" : "#fff2a1",
        });
      }
    };

    const addFuelBurst = (game: GameState, x: number, y: number) => {
      for (let i = 0; i < 10; i += 1) {
        const angle = (Math.PI * 2 * i) / 10;
        const maxLife = 0.42 + Math.random() * 0.22;
        game.particles.push({
          x,
          y,
          vx: Math.cos(angle) * (34 + Math.random() * 25),
          vy: Math.sin(angle) * (34 + Math.random() * 25) - 18,
          size: 2.8 + Math.random() * 3.2,
          life: maxLife,
          maxLife,
          color: i % 2 === 0 ? "#ef553d" : "#ffd45c",
        });
      }
    };

    const addWoodBurst = (game: GameState, x: number, y: number) => {
      for (let i = 0; i < 9; i += 1) {
        const maxLife = 0.55 + Math.random() * 0.35;
        game.particles.push({
          x: x + (Math.random() - 0.5) * 55,
          y: y - 5,
          vx: -30 + Math.random() * 80,
          vy: -35 - Math.random() * 70,
          size: 3 + Math.random() * 5,
          life: maxLife,
          maxLife,
          color: i % 2 === 0 ? "#8b552d" : "#c88642",
        });
      }
    };

    const update = (dt: number) => {
      const game = gameRef.current;
      const input = inputRef.current;
      game.runTime += dt;
      game.hintTime = Math.max(0, game.hintTime - dt);
      game.impactFlash = Math.max(0, game.impactFlash - dt * 2.8);
      const gasOn = input.gas && game.fuel > 0;
      const brakeOn = input.brake;
      const wasGrounded = game.grounded;
      const landingSpeed = game.vy;
      const substeps = Math.max(1, Math.ceil(dt / (1 / 120)));
      const step = dt / substeps;

      for (let substep = 0; substep < substeps; substep += 1) {
        let targetWheelSpeed: number | null = null;
        let motorResponse = 0;

        if (gasOn) {
          targetWheelSpeed = 34;
          const uphillLoad = Math.max(0, Math.min(0.9, -terrainSlope(game.carX)));
          motorResponse = 9.2 + uphillLoad * 2.2;
          game.brakeHold = 0;
        } else if (brakeOn) {
          // Reverse torque starts immediately. Tire RPM changes direction fast,
          // while ground friction first stops forward motion and then reverses it.
          game.brakeHold += step;
          targetWheelSpeed = -22;
          motorResponse = 20;
        } else {
          game.brakeHold = 0;
        }

        const motorAngularAcceleration = targetWheelSpeed === null
          ? 0
          : (targetWheelSpeed - game.wheelAngularVelocity) * motorResponse;
        game.wheelAngularVelocity += motorAngularAcceleration * step;

        let accelerationX = -game.vx * 0.035;
        let accelerationY = GRAVITY;
        let angularAcceleration = -game.angularVelocity * 0.2 - motorAngularAcceleration * 0.018;
        let wheelReactionAcceleration = 0;
        let contacts = 0;
        let rearSuspensionTarget = 5;
        let frontSuspensionTarget = 5;

        const simulateWheel = (localX: number, isRear: boolean) => {
          const cosine = Math.cos(game.angle);
          const sine = Math.sin(game.angle);
          const localY = SUSPENSION_REST_Y;
          const radiusX = localX * cosine - localY * sine;
          const radiusY = localX * sine + localY * cosine;
          const wheelX = game.carX + radiusX;
          const wheelY = game.carY + radiusY;
          const slope = terrainSlope(wheelX);
          const normalScale = Math.sqrt(1 + slope * slope);
          const tangentX = 1 / normalScale;
          const tangentY = slope / normalScale;
          const normalX = slope / normalScale;
          const normalY = -1 / normalScale;
          const groundY = terrainHeight(wheelX);
          const penetration = (wheelY + WHEEL_RADIUS - groundY) / normalScale;

          if (penetration <= 0) return;

          contacts += 1;
          const pointVelocityX = game.vx - game.angularVelocity * radiusY;
          const pointVelocityY = game.vy + game.angularVelocity * radiusX;
          const closingSpeed = -(pointVelocityX * normalX + pointVelocityY * normalY);
          const normalForce = Math.max(
            0,
            Math.min(2350, penetration * SPRING_STRENGTH + closingSpeed * SPRING_DAMPING),
          );

          const tangentSpeed = pointVelocityX * tangentX + pointVelocityY * tangentY;
          const wheelSurfaceSpeed = game.wheelAngularVelocity * WHEEL_RADIUS;
          const slipSpeed = wheelSurfaceSpeed - tangentSpeed;
          const maximumGrip = normalForce * (TIRE_GRIP + 0.3) * surfaceGripAt(wheelX);
          const tractionForce = Math.max(-maximumGrip, Math.min(maximumGrip, slipSpeed * 48));
          const forceX = normalX * normalForce + tangentX * tractionForce;
          const forceY = normalY * normalForce + tangentY * tractionForce;

          accelerationX += forceX;
          accelerationY += forceY;
          angularAcceleration += (radiusX * forceY - radiusY * forceX) / BODY_INERTIA;
          wheelReactionAcceleration -= (tractionForce * WHEEL_RADIUS) / WHEEL_INERTIA;

          const visualCompression = -Math.min(7, penetration);
          if (isRear) rearSuspensionTarget = visualCompression;
          else frontSuspensionTarget = visualCompression;
        };

        simulateWheel(-HALF_WHEELBASE, true);
        simulateWheel(HALF_WHEELBASE, false);

        game.grounded = contacts > 0;
        if (contacts === 0) {
          // Wheel acceleration transfers an opposite reaction to the chassis;
          // the extra game-tuned torque keeps airborne balancing responsive.
          if (gasOn) angularAcceleration -= 1.35;
          if (brakeOn) angularAcceleration += 1.55;
        }
        game.wheelAngularVelocity += wheelReactionAcceleration * step;
        game.wheelAngularVelocity = Math.max(-26, Math.min(38, game.wheelAngularVelocity));

        // The spring visuals use their own damped oscillator, so they compress
        // on impact and settle instead of snapping between two positions.
        const rearSpringAcceleration = (rearSuspensionTarget - game.rearSuspension) * 105 - game.rearSuspensionVelocity * 15;
        const frontSpringAcceleration = (frontSuspensionTarget - game.frontSuspension) * 105 - game.frontSuspensionVelocity * 15;
        game.rearSuspensionVelocity += rearSpringAcceleration * step;
        game.frontSuspensionVelocity += frontSpringAcceleration * step;
        game.rearSuspension += game.rearSuspensionVelocity * step;
        game.frontSuspension += game.frontSuspensionVelocity * step;
        game.rearSuspension = Math.max(-7, Math.min(6, game.rearSuspension));
        game.frontSuspension = Math.max(-7, Math.min(6, game.frontSuspension));

        if (contacts > 0) accelerationX -= game.vx * (gasOn || brakeOn ? 0.05 : 0.16);
        if (brakeOn && contacts > 0 && game.vx > 0) {
          accelerationX -= 520 + game.vx * 1.65;
        }
        game.vx += accelerationX * step;
        game.vy += accelerationY * step;
        game.angularVelocity += angularAcceleration * step;
        game.angularVelocity = Math.max(-4.8, Math.min(4.8, game.angularVelocity));
        game.carX += game.vx * step;
        game.carY += game.vy * step;
        game.angle += game.angularVelocity * step;
        game.wheelSpin += game.wheelAngularVelocity * step;

        game.vx = Math.max(-220, Math.min(500, game.vx));
        game.vy = Math.max(-430, Math.min(680, game.vy));
        if (game.carX < 72) {
          game.carX = 72;
          game.vx = Math.max(0, game.vx);
        }
      }

      const activeFeature = featureInfo(game.carX);
      if (activeFeature.cycle >= 0) {
        const layout = featureLayout(activeFeature.cycle);
        const levelRank = levelRankAtDistance(game.distance);
        if (game.grounded && game.carX >= layout.boostStart && game.carX <= layout.boostStart + 580) {
          const downhillBonus = terrainSlope(game.carX) > 0 ? 1.4 : 1;
          game.vx = Math.min(500, game.vx + 96 * downhillBonus * dt);
        }

        for (let group = 0; group < logGroupsInCycle(activeFeature.cycle); group += 1) {
          for (let slot = 0; slot < logGroupCount(activeFeature.cycle + group * 19); slot += 1) {
            const id = activeFeature.cycle * 32 + group * 3 + slot;
            const logX = logPosition(activeFeature.cycle, group, slot);
            if (
              game.grounded &&
              Math.abs(game.carX - logX) < 35 &&
              !game.hitLogs.has(id) &&
              Math.abs(game.vx) > 20
            ) {
              const impactSpeed = Math.abs(game.vx);
              const direction = game.vx >= 0 ? 1 : -1;
              game.hitLogs.add(id);
              game.vx *= impactSpeed > 145 ? 0.56 : 0.73;
              game.vy -= Math.min(190, 72 + impactSpeed * 0.48);
              game.angularVelocity -= direction * (impactSpeed > 145 ? Math.min(2.5, 0.85 + impactSpeed / 125) : 0.38);
              addWoodBurst(game, logX, terrainHeight(logX));
            }
          }
        }

        if (
          levelRank >= 2 &&
          game.grounded &&
          game.carX >= layout.crackStart &&
          game.carX <= layout.crackStart + 520 &&
          !game.hitCracks.has(activeFeature.cycle) &&
          Math.abs(game.vx) > 30
        ) {
          game.hitCracks.add(activeFeature.cycle);
          game.vy += 58;
          game.angularVelocity += (seededRandom(activeFeature.cycle + 811) - 0.5) * 0.55;
        }

        if (
          levelRank >= 3 &&
          game.grounded &&
          Math.abs(game.carX - layout.rampX) < 48 &&
          !game.triggeredRamps.has(activeFeature.cycle) &&
          game.vx > 25
        ) {
          game.triggeredRamps.add(activeFeature.cycle);
          game.vx = Math.min(500, game.vx + 58);
          game.vy -= 145;
          game.angularVelocity -= 0.42;
        }

        if (
          levelRank >= 2 &&
          game.carX > layout.bridgeStart + 620 &&
          !game.brokenBridges.has(activeFeature.cycle)
        ) {
          game.brokenBridges.add(activeFeature.cycle);
          addWoodBurst(game, layout.bridgeStart + 430, terrainHeight(layout.bridgeStart + 430));
        }
      }

      if (!wasGrounded && game.grounded) {
        const landingPose = roadPose(game.carX);
        const landingError = Math.abs(normalizeAngle(game.angle - landingPose.angle));
        if (landingSpeed > 45) audioRef.current?.land(Math.min(1, (landingSpeed - 35) / 220));
        if (landingSpeed > 105) {
          game.impactFlash = Math.min(1, landingSpeed / 440);
          addDust(game, Math.min(5, Math.ceil(landingSpeed / 75)));
        }
        if (landingError > 1.5 && landingSpeed > 80 && game.runTime > 1) endRun("Hard landing");
      }

      if (game.grounded) game.airTime = 0;
      else game.airTime += dt;

      if (Math.abs(normalizeAngle(game.angle)) > 2.55 && game.carY > terrainHeight(game.carX) - 60) endRun("Vehicle flipped");
      if (game.carY > terrainHeight(game.carX) + 110) endRun("Vehicle lost");
      game.distance = Math.max(game.distance, (game.carX - CAR_START_X) / 9);
      // Fuel never regenerates on its own. It drains while parked and faster
      // under throttle; only a collected can can increase this value.
      game.fuel = Math.max(0, game.fuel - dt * (1.8 + (gasOn || brakeOn ? 1.8 : 0)));

      const nearestCluster = Math.round((game.carX - COIN_START_X) / COIN_CLUSTER_GAP);
      for (let cluster = Math.max(0, nearestCluster - 1); cluster <= nearestCluster + 1; cluster += 1) {
        for (let slot = 0; slot < coinClusterSize(cluster); slot += 1) {
          const id = coinId(cluster, slot);
          if (game.collectedCoins.has(id)) continue;
          const coin = coinPosition(cluster, slot);
          if (Math.abs(coin.x - game.carX) < 52 && Math.abs(coin.y - game.carY) < 60) {
            game.collectedCoins.add(id);
            game.coins += 1;
            addCoinBurst(game, coin.x, coin.y);
            audioRef.current?.coin();
          }
        }
      }

      const nearestFuel = Math.round((game.carX - FUEL_START_X) / FUEL_SPACING);
      for (let index = Math.max(0, nearestFuel - 1); index <= nearestFuel + 1; index += 1) {
        if (game.collectedFuel.has(index)) continue;
        const fuel = fuelPosition(index);
        if (Math.abs(fuel.x - game.carX) < 38 && Math.abs(fuel.y - game.carY) < 48) {
          game.collectedFuel.add(index);
          game.fuel = Math.min(100, game.fuel + 35);
          addFuelBurst(game, fuel.x, fuel.y);
          audioRef.current?.fuel();
        }
      }

      game.dustClock -= dt;
      if (gasOn && game.grounded && Math.abs(game.vx) > 12 && game.dustClock <= 0) {
        addDust(game, 1);
        game.dustClock = 0.055 + Math.random() * 0.045;
      }
      game.particles = game.particles.filter((particle) => {
        particle.life -= dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.vy += 28 * dt;
        particle.size += 8 * dt;
        return particle.life > 0;
      });

      const targetCameraX = Math.max(0, game.carX - 108);
      const targetCameraY = 494 - game.carY;
      game.cameraX += (targetCameraX - game.cameraX) * Math.min(1, dt * 4.2);
      game.cameraY += (targetCameraY - game.cameraY) * Math.min(1, dt * 2.3);
      if (game.fuel <= 0 && game.runTime > 3) endRun("Out of fuel");

      hudClock -= dt;
      if (hudClock <= 0) {
        setHud({
          distance: Math.floor(game.distance),
          coins: game.coins,
          fuel: game.fuel,
          speed: Math.round(Math.abs(game.vx) * 0.38),
          level: levelLabelAtDistance(game.distance),
        });
        hudClock = 0.08;
      }
    };

    const drawCloud = (x: number, y: number, scale: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#fff5dc";
      ctx.beginPath();
      ctx.ellipse(x, y, 28 * scale, 11 * scale, 0, 0, Math.PI * 2);
      ctx.ellipse(x - 18 * scale, y + 2 * scale, 18 * scale, 8 * scale, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 18 * scale, y + 3 * scale, 20 * scale, 8 * scale, 0, 0, Math.PI * 2);
      ctx.ellipse(x - 4 * scale, y - 8 * scale, 17 * scale, 14 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawBackground = (game: GameState) => {
      const nightProgress = smoothstep(NIGHT_DISTANCE - 500, NIGHT_DISTANCE + 250, game.distance);
      const starProgress = smoothstep(STAR_DISTANCE - 500, STAR_DISTANCE + 500, game.distance);
      const sky = ctx.createLinearGradient(0, 0, 0, GAME_H);
      sky.addColorStop(0, "#79c8dc");
      sky.addColorStop(0.58, "#cfe7d8");
      sky.addColorStop(1, "#f6d79b");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, GAME_W, GAME_H);

      if (nightProgress > 0) {
        const nightSky = ctx.createLinearGradient(0, 0, 0, GAME_H);
        nightSky.addColorStop(0, starProgress > 0.2 ? "#100d31" : "#07182f");
        nightSky.addColorStop(0.58, starProgress > 0.2 ? "#282451" : "#18334d");
        nightSky.addColorStop(1, "#4d5b64");
        ctx.globalAlpha = nightProgress;
        ctx.fillStyle = nightSky;
        ctx.fillRect(0, 0, GAME_W, GAME_H);
        ctx.globalAlpha = 1;

        const starCount = starProgress > 0.05 ? 76 : 25;
        ctx.fillStyle = "#fff7d6";
        for (let star = 0; star < starCount; star += 1) {
          const starX = (star * 83.17 + 31 - game.cameraX * 0.012) % (GAME_W + 26) - 13;
          const starY = 38 + ((star * 47.63) % 330);
          const twinkle = 0.45 + 0.55 * Math.abs(Math.sin(game.runTime * 1.8 + star * 2.17));
          ctx.globalAlpha = nightProgress * (0.28 + starProgress * 0.72) * twinkle;
          ctx.beginPath();
          ctx.arc(starX, starY, star % 9 === 0 ? 1.7 : 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        if (starProgress > 0.05) {
          ctx.strokeStyle = `rgba(211,224,255,${starProgress * 0.42})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(66, 170);
          ctx.lineTo(116, 146);
          ctx.stroke();
        }
      }

      const sunGlow = ctx.createRadialGradient(344, 134, 22, 344, 134, 92);
      sunGlow.addColorStop(0, "rgba(255,247,188,.48)");
      sunGlow.addColorStop(1, "rgba(255,247,188,0)");
      ctx.globalAlpha = 1 - nightProgress;
      ctx.fillStyle = sunGlow;
      ctx.fillRect(250, 40, 188, 188);
      ctx.globalAlpha = 0.88 * (1 - nightProgress);
      ctx.fillStyle = "#fff4c3";
      ctx.beginPath();
      ctx.arc(344, 134, 43, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (nightProgress > 0) {
        ctx.globalAlpha = nightProgress;
        const moonGlow = ctx.createRadialGradient(344, 132, 18, 344, 132, 64);
        moonGlow.addColorStop(0, "rgba(218,232,255,.32)");
        moonGlow.addColorStop(1, "rgba(218,232,255,0)");
        ctx.fillStyle = moonGlow;
        ctx.fillRect(278, 66, 132, 132);
        ctx.fillStyle = "#dce7ee";
        ctx.beginPath();
        ctx.arc(344, 132, 27, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(151,170,184,.3)";
        ctx.beginPath();
        ctx.arc(335, 124, 6, 0, Math.PI * 2);
        ctx.arc(352, 141, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      const cloudOffset = (game.cameraX * 0.07) % 620;
      drawCloud(78 - cloudOffset, 135, 0.9, 0.66 * (1 - nightProgress * 0.65));
      drawCloud(405 - cloudOffset, 215, 0.72, 0.5 * (1 - nightProgress * 0.65));
      drawCloud(660 - cloudOffset, 107, 1.05, 0.56 * (1 - nightProgress * 0.65));

      const peakOffset = (game.cameraX * 0.075) % 210;
      ctx.globalAlpha = 0.48;
      for (let peak = -1; peak < 4; peak += 1) {
        const peakX = peak * 210 - peakOffset + 55;
        const peakY = 298 + (peak % 2) * 24;
        ctx.fillStyle = peak % 2 === 0 ? "#87aaa4" : "#91b2aa";
        ctx.beginPath();
        ctx.moveTo(peakX - 125, 438);
        ctx.lineTo(peakX, peakY);
        ctx.lineTo(peakX + 132, 438);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#dce8d9";
        ctx.beginPath();
        ctx.moveTo(peakX - 34, peakY + 42);
        ctx.lineTo(peakX, peakY);
        ctx.lineTo(peakX + 42, peakY + 48);
        ctx.lineTo(peakX + 15, peakY + 38);
        ctx.lineTo(peakX - 3, peakY + 54);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const farOffset = game.cameraX * 0.13;
      ctx.fillStyle = "#91a993";
      ctx.beginPath();
      ctx.moveTo(0, 455);
      for (let x = -20; x <= GAME_W + 20; x += 10) {
        const wx = x + farOffset;
        ctx.lineTo(x, 405 + Math.sin(wx / 86) * 34 + Math.sin(wx / 37) * 10);
      }
      ctx.lineTo(GAME_W, 590);
      ctx.lineTo(0, 590);
      ctx.closePath();
      ctx.fill();

      const forestOffset = (game.cameraX * 0.19) % 52;
      ctx.globalAlpha = 0.38;
      for (let tree = -2; tree < 12; tree += 1) {
        const treeX = tree * 52 - forestOffset;
        const baseY = 478 + Math.sin((treeX + forestOffset) / 92) * 14;
        const height = 34 + (tree % 4) * 7;
        ctx.fillStyle = tree % 2 === 0 ? "#527765" : "#5d816d";
        ctx.beginPath();
        ctx.moveTo(treeX, baseY - height);
        ctx.lineTo(treeX - 15, baseY - 7);
        ctx.lineTo(treeX - 8, baseY - 10);
        ctx.lineTo(treeX - 19, baseY + 2);
        ctx.lineTo(treeX + 19, baseY + 2);
        ctx.lineTo(treeX + 8, baseY - 10);
        ctx.lineTo(treeX + 15, baseY - 7);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const nearOffset = game.cameraX * 0.26;
      ctx.fillStyle = "#718b72";
      ctx.beginPath();
      ctx.moveTo(0, 500);
      for (let x = -20; x <= GAME_W + 20; x += 8) {
        const wx = x + nearOffset;
        ctx.lineTo(x, 465 + Math.sin(wx / 63) * 31 + Math.sin(wx / 28) * 8);
      }
      ctx.lineTo(GAME_W, 620);
      ctx.lineTo(0, 620);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 10; i += 1) {
        const treeX = i * 72 - (nearOffset * 1.3) % 72;
        const baseY = 488 + Math.sin((treeX + nearOffset) / 63) * 20;
        const treeHeight = 31 + (i % 3) * 8;
        ctx.fillStyle = i % 2 === 0 ? "#3f6857" : "#496f5d";
        ctx.beginPath();
        ctx.moveTo(treeX, baseY - treeHeight);
        ctx.lineTo(treeX - 14, baseY - 7);
        ctx.lineTo(treeX - 6, baseY - 10);
        ctx.lineTo(treeX - 17, baseY + 1);
        ctx.lineTo(treeX + 17, baseY + 1);
        ctx.lineTo(treeX + 6, baseY - 10);
        ctx.lineTo(treeX + 14, baseY - 7);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#71523a";
        ctx.fillRect(treeX - 1.5, baseY - 3, 3, 8);
      }
      ctx.globalAlpha = 1;

      ctx.globalAlpha = 1 - nightProgress;
      ctx.strokeStyle = "rgba(50,75,67,.46)";
      ctx.lineWidth = 1.5;
      for (let bird = 0; bird < 3; bird += 1) {
        const birdX = 95 + bird * 118 - (game.cameraX * 0.035) % 510;
        const birdY = 245 + bird * 23;
        ctx.beginPath();
        ctx.arc(birdX - 4, birdY, 5, Math.PI * 1.08, Math.PI * 1.9);
        ctx.arc(birdX + 4, birdY, 5, Math.PI * 1.1, Math.PI * 1.92);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const drawTerrain = (game: GameState) => {
      ctx.beginPath();
      ctx.moveTo(-240, GAME_H + 300);
      for (let sx = -240; sx <= GAME_W + 260; sx += 5) ctx.lineTo(sx, terrainHeight(game.cameraX + sx) + game.cameraY);
      ctx.lineTo(GAME_W + 260, GAME_H + 300);
      ctx.closePath();
      const soil = ctx.createLinearGradient(0, 470, 0, GAME_H);
      soil.addColorStop(0, "#a86a37");
      soil.addColorStop(0.18, "#74472e");
      soil.addColorStop(1, "#3b2a25");
      ctx.fillStyle = soil;
      ctx.fill();

      // Layered soil bands make the large cutaway hills feel carved and deep.
      ctx.save();
      ctx.globalAlpha = 0.3;
      for (let layer = 0; layer < 3; layer += 1) {
        ctx.beginPath();
        for (let sx = -240; sx <= GAME_W + 260; sx += 8) {
          const worldX = game.cameraX + sx;
          const y = terrainHeight(worldX) + game.cameraY + 48 + layer * 54 + Math.sin(worldX / (82 + layer * 21)) * 8;
          if (sx === -240) ctx.moveTo(sx, y);
          else ctx.lineTo(sx, y);
        }
        ctx.strokeStyle = layer === 0 ? "#d19654" : layer === 1 ? "#5f3c2d" : "#2d2523";
        ctx.lineWidth = 7 + layer * 2;
        ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath();
      for (let sx = -240; sx <= GAME_W + 260; sx += 4) {
        const y = terrainHeight(game.cameraX + sx) + game.cameraY;
        if (sx === -240) ctx.moveTo(sx, y);
        else ctx.lineTo(sx, y);
      }
      ctx.strokeStyle = "#38291f";
      ctx.lineWidth = 13;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.strokeStyle = "#7d9b45";
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = "#c6d768";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      const firstMarker = Math.floor(game.cameraX / 74) - 1;
      for (let marker = firstMarker; marker < firstMarker + 12; marker += 1) {
        if (marker < 0) continue;
        const worldX = marker * 74 + 18;
        const sx = worldX - game.cameraX;
        const y = terrainHeight(worldX) + game.cameraY;
        const random = Math.abs(Math.sin(marker * 91.73));
        ctx.save();
        ctx.translate(sx, y + 10);
        ctx.rotate(Math.atan(terrainSlope(worldX)));
        ctx.fillStyle = random > 0.58 ? "#483226" : "#6d452d";
        ctx.beginPath();
        ctx.ellipse(0, 0, 3 + random * 5, 2 + random * 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (random > 0.34 && marker % 3 === 0) {
          ctx.save();
          ctx.translate(sx, y - 2);
          ctx.rotate(Math.atan(terrainSlope(worldX)));
          ctx.strokeStyle = marker % 2 === 0 ? "#6d8d3e" : "#829f4a";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(-5, 1);
          ctx.lineTo(-8, -9 - random * 5);
          ctx.moveTo(0, 1);
          ctx.lineTo(-1, -12 - random * 7);
          ctx.moveTo(5, 1);
          ctx.lineTo(8, -8 - random * 6);
          ctx.stroke();
          ctx.restore();
        }

        if (marker > 0 && marker % 13 === 0) {
          ctx.save();
          ctx.translate(sx, y - 4);
          ctx.rotate(Math.atan(terrainSlope(worldX)));
          ctx.strokeStyle = "#493226";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(0, 1);
          ctx.lineTo(0, -31);
          ctx.stroke();
          ctx.fillStyle = "#d7a43c";
          ctx.strokeStyle = "#4b3222";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(0, -37);
          ctx.lineTo(16, -26);
          ctx.lineTo(0, -17);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#4b3222";
          ctx.font = "900 9px Arial, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("!", 5, -25);
          ctx.restore();
        }

        if (marker > 0 && marker % 19 === 0) {
          ctx.save();
          ctx.translate(sx, y - 6);
          ctx.rotate(Math.atan(terrainSlope(worldX)));
          ctx.fillStyle = "#8b4f2d";
          ctx.strokeStyle = "#3f2b22";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(-9, -17, 18, 18, 3);
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = "#c68d4f";
          ctx.beginPath();
          ctx.moveTo(-8, -12);
          ctx.lineTo(8, -12);
          ctx.moveTo(-8, -4);
          ctx.lineTo(8, -4);
          ctx.stroke();
          ctx.restore();
        }
      }
    };

    const drawFeatures = (game: GameState) => {
      const firstCycle = Math.max(0, Math.floor((game.cameraX - FEATURE_START_X) / FEATURE_CYCLE) - 1);
      for (let cycle = firstCycle; cycle < firstCycle + 4; cycle += 1) {
        const layout = featureLayout(cycle);
        const levelRank = levelRankAtDistance(distanceAtWorldX(layout.baseX));

        // Downhill boost strip: safe extra momentum with clear arrow markings.
        for (let worldX = layout.boostStart; worldX < layout.boostStart + 580; worldX += 58) {
          const screenX = worldX - game.cameraX;
          if (screenX < -100 || screenX > GAME_W + 220) continue;
          const y = terrainHeight(worldX) + game.cameraY - 5;
          ctx.save();
          ctx.translate(screenX, y);
          ctx.rotate(Math.atan(terrainSlope(worldX)));
          ctx.fillStyle = "#f5bf35";
          ctx.strokeStyle = "#76511c";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(-13, -5);
          ctx.lineTo(4, 0);
          ctx.lineTo(-13, 5);
          ctx.lineTo(-5, 0);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }

        // Log groups become more frequent as the distance level increases.
        for (let group = 0; group < logGroupsInCycle(cycle); group += 1) {
          for (let slot = 0; slot < logGroupCount(cycle + group * 19); slot += 1) {
            const id = cycle * 32 + group * 3 + slot;
            const logX = logPosition(cycle, group, slot);
            const logScreenX = logX - game.cameraX;
            if (logScreenX > -100 && logScreenX < GAME_W + 220 && !game.hitLogs.has(id)) {
              const logY = terrainHeight(logX) + game.cameraY - 9 - slot * 2;
              ctx.save();
              ctx.translate(logScreenX, logY);
              ctx.rotate(Math.atan(terrainSlope(logX)) + (slot - 1) * 0.035);
              const logGradient = ctx.createLinearGradient(0, -8, 0, 8);
              logGradient.addColorStop(0, "#c98443");
              logGradient.addColorStop(1, "#694027");
              ctx.fillStyle = logGradient;
              ctx.strokeStyle = "#35251d";
              ctx.lineWidth = 2.5;
              ctx.beginPath();
              ctx.roundRect(-29, -8, 58, 16, 7);
              ctx.fill();
              ctx.stroke();
              ctx.fillStyle = "#d9a263";
              ctx.beginPath();
              ctx.ellipse(27, 0, 6, 7, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
              ctx.strokeStyle = "#7b4c2b";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.arc(27, 0, 3, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
            }
          }
        }

        // Slippery mud patch lowers tire grip but remains fully driveable.
        ctx.beginPath();
        for (let worldX = layout.mudStart; worldX <= layout.mudStart + 620; worldX += 14) {
          const screenX = worldX - game.cameraX;
          const y = terrainHeight(worldX) + game.cameraY - 2;
          if (worldX === layout.mudStart) ctx.moveTo(screenX, y);
          else ctx.lineTo(screenX, y);
        }
        ctx.strokeStyle = "rgba(80,126,128,.9)";
        ctx.lineWidth = 8;
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.strokeStyle = "rgba(183,224,210,.55)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Cracked road visually warns about a rough low-grip impact section.
        for (let crack = 0; crack < (levelRank >= 2 ? 8 : 0); crack += 1) {
          const worldX = layout.crackStart + 35 + crack * 66;
          const screenX = worldX - game.cameraX;
          const y = terrainHeight(worldX) + game.cameraY - 4;
          ctx.save();
          ctx.translate(screenX, y);
          ctx.rotate(Math.atan(terrainSlope(worldX)));
          ctx.strokeStyle = "#33251f";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(-17, -1);
          ctx.lineTo(-5, 4);
          ctx.lineTo(2, -3);
          ctx.lineTo(15, 2);
          ctx.moveTo(-5, 4);
          ctx.lineTo(-9, 9);
          ctx.stroke();
          ctx.restore();
        }

        // Wooden bridge planks break visually after the player crosses them.
        if (levelRank >= 2 && !game.brokenBridges.has(cycle)) {
          ctx.strokeStyle = "#5a351f";
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let worldX = layout.bridgeStart; worldX <= layout.bridgeStart + 620; worldX += 26) {
            const screenX = worldX - game.cameraX;
            const y = terrainHeight(worldX) + game.cameraY - 6;
            ctx.save();
            ctx.translate(screenX, y);
            ctx.rotate(Math.atan(terrainSlope(worldX)));
            ctx.fillStyle = Math.floor(worldX / 26) % 2 === 0 ? "#a96935" : "#c28143";
            ctx.strokeStyle = "#55321e";
            ctx.lineWidth = 1.5;
            ctx.fillRect(-12, -5, 24, 9);
            ctx.strokeRect(-12, -5, 24, 9);
            ctx.restore();
          }
        }

        // Bright gravel has extra grip and rewards controlled acceleration.
        ctx.beginPath();
        for (let worldX = layout.gripStart; worldX <= layout.gripStart + 460; worldX += 14) {
          const screenX = worldX - game.cameraX;
          const y = terrainHeight(worldX) + game.cameraY - 2;
          if (worldX === layout.gripStart) ctx.moveTo(screenX, y);
          else ctx.lineTo(screenX, y);
        }
        ctx.strokeStyle = "rgba(217,185,112,.92)";
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,231,163,.76)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // A rotating ramp gives a controlled jump rather than a lethal wall.
        const rampX = layout.rampX;
        const rampScreenX = rampX - game.cameraX;
        if (levelRank >= 3 && rampScreenX > -120 && rampScreenX < GAME_W + 240) {
          const rampY = terrainHeight(rampX) + game.cameraY - 7;
          const rampAngle = -0.18 + Math.sin(game.runTime * 1.35 + cycle) * 0.075;
          ctx.save();
          ctx.translate(rampScreenX, rampY);
          ctx.rotate(rampAngle);
          ctx.fillStyle = "#b9793d";
          ctx.strokeStyle = "#432d21";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.roundRect(-47, -6, 94, 12, 3);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#5b4430";
          ctx.beginPath();
          ctx.arc(0, 11, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Deterministic random rocks make each cycle look less repetitive;
        // matching smooth terrain humps provide the actual tire physics.
        const rockCount = levelRank >= 3 ? 10 : levelRank >= 2 ? 7 : 4;
        for (let rock = 0; rock < rockCount; rock += 1) {
          const worldX = layout.baseX + 240 + seededRandom(cycle * 17 + rock + 901) * (FEATURE_CYCLE - 480);
          const screenX = worldX - game.cameraX;
          if (screenX < -80 || screenX > GAME_W + 180) continue;
          const size = 3 + seededRandom(cycle * 23 + rock + 951) * 7;
          const y = terrainHeight(worldX) + game.cameraY - size * 0.55;
          ctx.save();
          ctx.translate(screenX, y);
          ctx.rotate(Math.atan(terrainSlope(worldX)));
          ctx.fillStyle = rock % 2 === 0 ? "#5b493e" : "#765b47";
          ctx.strokeStyle = "#3e332c";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(-size, size * 0.4);
          ctx.lineTo(-size * 0.55, -size * 0.7);
          ctx.lineTo(size * 0.25, -size);
          ctx.lineTo(size, size * 0.45);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }
    };

    const drawCoin = (x: number, y: number, time: number) => {
      const bob = Math.sin(time * 4.5 + x) * 3;
      const squash = 0.68 + Math.abs(Math.sin(time * 2.8 + x)) * 0.32;
      ctx.save();
      ctx.translate(x, y + bob);
      ctx.scale(squash, 1);
      ctx.fillStyle = "rgba(92,54,16,.18)";
      ctx.beginPath();
      ctx.ellipse(2, 29, 13, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f6c83d";
      ctx.strokeStyle = "#6f4816";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "#fff0a2";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(-2, -2, 7, Math.PI * 0.95, Math.PI * 1.7);
      ctx.stroke();
      ctx.fillStyle = "#8b5716";
      ctx.font = "900 14px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("B", 0, 0.5);
      ctx.strokeStyle = "#8b5716";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-3, -8);
      ctx.lineTo(-3, 8);
      ctx.moveTo(1, -8);
      ctx.lineTo(1, 8);
      ctx.stroke();
      ctx.restore();
    };

    const drawFuel = (x: number, y: number, time: number) => {
      ctx.save();
      ctx.translate(x, y + Math.sin(time * 3) * 3);
      ctx.rotate(-0.05);
      ctx.shadowColor = "rgba(255,197,68,.62)";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "rgba(255,211,86,.18)";
      ctx.beginPath();
      ctx.arc(0, -1, 30, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(47,35,25,.2)";
      ctx.beginPath();
      ctx.ellipse(2, 32, 20, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      const canGradient = ctx.createLinearGradient(-18, -24, 18, 24);
      canGradient.addColorStop(0, "#ef6a43");
      canGradient.addColorStop(0.5, "#c94231");
      canGradient.addColorStop(1, "#8f2f29");
      ctx.fillStyle = canGradient;
      ctx.strokeStyle = "#3e2a22";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(-18, -24, 36, 49, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#3e2a22";
      ctx.beginPath();
      ctx.roundRect(-8, -30, 18, 8, 2);
      ctx.fill();
      ctx.strokeStyle = "#742b26";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-10, -14);
      ctx.lineTo(10, 14);
      ctx.moveTo(10, -14);
      ctx.lineTo(-10, 14);
      ctx.stroke();
      ctx.fillStyle = "#ffe8a0";
      ctx.font = "900 8px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("FUEL", 0, 3);
      ctx.strokeStyle = "rgba(255,237,171,.72)";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-12, -19);
      ctx.lineTo(-12, 19);
      ctx.stroke();
      ctx.restore();
    };

    const drawPickups = (game: GameState) => {
      const firstCluster = Math.max(0, Math.floor((game.cameraX - COIN_START_X) / COIN_CLUSTER_GAP) - 1);
      for (let cluster = firstCluster; cluster < firstCluster + 4; cluster += 1) {
        for (let slot = 0; slot < coinClusterSize(cluster); slot += 1) {
          const id = coinId(cluster, slot);
          if (game.collectedCoins.has(id)) continue;
          const coin = coinPosition(cluster, slot);
          if (coin.x - game.cameraX > -80 && coin.x - game.cameraX < GAME_W + 180) {
            drawCoin(coin.x - game.cameraX, coin.y + game.cameraY, game.runTime);
          }
        }
      }
      const firstFuel = Math.max(0, Math.floor((game.cameraX - FUEL_START_X) / FUEL_SPACING) - 1);
      for (let index = firstFuel; index < firstFuel + 2; index += 1) {
        if (game.collectedFuel.has(index)) continue;
        const fuel = fuelPosition(index);
        if (fuel.x - game.cameraX > -60 && fuel.x - game.cameraX < GAME_W + 60) drawFuel(fuel.x - game.cameraX, fuel.y + game.cameraY, game.runTime);
      }
    };

    const drawWheel = (x: number, y: number, rotation: number) => {
      const wheel = wheelImageRef.current;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      if (wheel) {
        ctx.drawImage(wheel, -WHEEL_RADIUS, -WHEEL_RADIUS, WHEEL_RADIUS * 2, WHEEL_RADIUS * 2);
      } else {
        ctx.fillStyle = "#292725";
        ctx.strokeStyle = "#191817";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, WHEEL_RADIUS - 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#766a5d";
        ctx.beginPath();
        ctx.arc(0, 0, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#332f2b";
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i += 1) {
          ctx.rotate(Math.PI / 3);
          ctx.beginPath();
          ctx.moveTo(3, 0);
          ctx.lineTo(9, 0);
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    const drawFallbackBody = () => {
      ctx.fillStyle = "#e8a62d";
      ctx.strokeStyle = "#3c2a22";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-66, 10);
      ctx.lineTo(-61, -20);
      ctx.lineTo(-35, -38);
      ctx.lineTo(17, -38);
      ctx.lineTo(37, -19);
      ctx.lineTo(63, -10);
      ctx.lineTo(70, 10);
      ctx.lineTo(52, 18);
      ctx.lineTo(-52, 18);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#8fc7c6";
      ctx.beginPath();
      ctx.moveTo(-31, -33);
      ctx.lineTo(12, -33);
      ctx.lineTo(30, -16);
      ctx.lineTo(-40, -16);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "#3c2a22";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-45, -43);
      ctx.lineTo(33, -43);
      ctx.stroke();
      ctx.fillStyle = "#b73f2d";
      ctx.fillRect(-28, -55, 18, 12);
    };

    const drawSuspension = (anchorX: number, anchorY: number, wheelX: number, wheelY: number) => {
      const suspension = suspensionImageRef.current;
      const deltaX = wheelX - anchorX;
      const deltaY = wheelY - anchorY;
      const length = Math.hypot(deltaX, deltaY);
      const rotation = Math.atan2(deltaY, deltaX) - Math.PI / 2;

      ctx.lineCap = "round";
      ctx.strokeStyle = "#302822";
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(anchorX * 0.58, 9);
      ctx.lineTo(wheelX, wheelY);
      ctx.stroke();

      if (suspension) {
        ctx.save();
        ctx.translate(anchorX, anchorY);
        ctx.rotate(rotation);
        ctx.drawImage(suspension, -6.5, -2, 13, length + 5);
        ctx.restore();
      } else {
        ctx.strokeStyle = "#b45d40";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(anchorX, anchorY);
        for (let step = 1; step <= 7; step += 1) {
          const progress = step / 8;
          const centerX = anchorX + deltaX * progress;
          const centerY = anchorY + deltaY * progress;
          ctx.lineTo(centerX + (step % 2 === 0 ? -3 : 3), centerY);
        }
        ctx.lineTo(wheelX, wheelY);
        ctx.stroke();
      }

      ctx.strokeStyle = "#d5b078";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(wheelX, wheelY);
      ctx.stroke();
    };

    const drawCar = (game: GameState) => {
      const screenX = game.carX - game.cameraX;
      const screenY = game.carY + game.cameraY;
      const shadowPose = roadPose(game.carX);
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = "#261e19";
      ctx.translate(screenX, (shadowPose.rearGroundY + shadowPose.frontGroundY) * 0.5 + game.cameraY + 7);
      ctx.rotate(shadowPose.angle);
      ctx.beginPath();
      ctx.ellipse(2, 0, 54, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(screenX, screenY);
      ctx.rotate(game.angle);
      const rearWheelY = SUSPENSION_REST_Y + game.rearSuspension;
      const frontWheelY = SUSPENSION_REST_Y + game.frontSuspension;
      drawSuspension(-30, -3.5, -HALF_WHEELBASE, rearWheelY);
      drawSuspension(30, -3.5, HALF_WHEELBASE, frontWheelY);
      drawWheel(-HALF_WHEELBASE, rearWheelY, game.wheelSpin);
      drawWheel(HALF_WHEELBASE, frontWheelY, game.wheelSpin);
      const car = carImageRef.current;
      if (car) {
        ctx.drawImage(car, -67, -55, 134, 80);
      } else {
        ctx.save();
        ctx.scale(0.88, 0.88);
        drawFallbackBody();
        ctx.restore();
      }
      ctx.restore();
    };

    const drawParticles = (game: GameState) => {
      for (const particle of game.particles) {
        const alpha = Math.max(0, particle.life / particle.maxLife);
        ctx.globalAlpha = alpha * 0.48;
        ctx.fillStyle = particle.color;
        ctx.beginPath();
        ctx.arc(particle.x - game.cameraX, particle.y + game.cameraY, particle.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawNightLighting = (game: GameState) => {
      const nightProgress = smoothstep(NIGHT_DISTANCE - 500, NIGHT_DISTANCE + 250, game.distance);
      if (nightProgress <= 0) return;
      const starProgress = smoothstep(STAR_DISTANCE - 500, STAR_DISTANCE + 500, game.distance);

      ctx.fillStyle = `rgba(3,8,20,${nightProgress * (0.48 + starProgress * 0.08)})`;
      ctx.fillRect(0, 0, GAME_W, GAME_H);

      const carScreenX = game.carX - game.cameraX;
      const carScreenY = game.carY + game.cameraY;
      ctx.save();
      ctx.translate(carScreenX, carScreenY);
      ctx.rotate(game.angle);
      ctx.scale(WORLD_ZOOM, WORLD_ZOOM);
      ctx.globalCompositeOperation = "screen";

      const lampX = 59;
      const lampY = -14;
      const beam = ctx.createLinearGradient(lampX, 0, 370, 0);
      beam.addColorStop(0, `rgba(255,244,176,${nightProgress * 0.68})`);
      beam.addColorStop(0.45, `rgba(255,226,132,${nightProgress * 0.24})`);
      beam.addColorStop(1, "rgba(255,220,120,0)");
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(lampX, lampY - 5);
      ctx.lineTo(375, lampY - 105);
      ctx.quadraticCurveTo(395, lampY, 375, lampY + 112);
      ctx.lineTo(lampX, lampY + 5);
      ctx.closePath();
      ctx.fill();

      ctx.shadowColor = "#fff1a7";
      ctx.shadowBlur = 16;
      ctx.fillStyle = `rgba(255,249,203,${nightProgress})`;
      ctx.beginPath();
      ctx.arc(lampX, lampY, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawScene = () => {
      const game = gameRef.current;
      drawBackground(game);

      // Zoom only the playable world. HUD and touch controls stay full-size,
      // while more upcoming road remains visible around the vehicle.
      ctx.save();
      const focusX = game.carX - game.cameraX;
      const focusY = game.carY + game.cameraY;
      ctx.translate(focusX, focusY);
      ctx.scale(WORLD_ZOOM, WORLD_ZOOM);
      ctx.translate(-focusX, -focusY);
      drawPickups(game);
      drawTerrain(game);
      drawFeatures(game);
      drawParticles(game);
      drawCar(game);
      ctx.restore();
      drawNightLighting(game);

      if (screenRef.current === "playing" && game.airTime > 0.75) {
        const alpha = Math.min(1, (game.airTime - 0.75) * 2);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.textAlign = "center";
        ctx.font = "900 19px Arial Black, sans-serif";
        ctx.lineWidth = 5;
        ctx.strokeStyle = "rgba(54,37,24,.65)";
        ctx.strokeText("AIR TIME", GAME_W / 2, 214);
        ctx.fillStyle = "#fff3c9";
        ctx.fillText("AIR TIME", GAME_W / 2, 214);
        ctx.restore();
      }
      if (game.impactFlash > 0) {
        ctx.fillStyle = `rgba(255,244,194,${game.impactFlash * 0.12})`;
        ctx.fillRect(0, 0, GAME_W, GAME_H);
      }
    };

    const frame = (now: number) => {
      const dt = Math.min(0.032, Math.max(0.001, (now - previousTime) / 1000));
      previousTime = now;
      if (screenRef.current === "playing") update(dt);
      const game = gameRef.current;
      audioRef.current?.update(
        screenRef.current === "playing",
        game.wheelAngularVelocity,
        inputRef.current.gas || inputRef.current.brake,
      );
      drawScene();
      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationFrame);
  }, [changeScreen]);

  const pressControl = (control: keyof InputState, pressed: boolean) => {
    if (pressed) ensureAudio();
    if (screenRef.current === "playing") inputRef.current[control] = pressed;
  };
  const game = gameRef.current;

  return (
    <main className="app-stage">
      <section className="game-shell" aria-label="Mud Rush hill climb game">
        <canvas ref={canvasRef} className="game-canvas" aria-label="Hill climb driving area" />
        <div className="screen-vignette" aria-hidden="true" />

        {(screen === "playing" || screen === "paused") && (
          <div className="hud-layer">
            <div className="hud-topline">
              <div className="distance-readout">
                <span>DISTANCE</span>
                <strong>{hud.distance}<small>m</small></strong>
                <em>{hud.speed} KM/H</em>
                <b className={`level-label level-${hud.level.toLowerCase().replace(/\s+/g, "-").replace("+", "plus")}`}>{hud.level}</b>
              </div>
              <div className="coin-readout" aria-label={`${hud.coins} Bitcoin coins`}><i aria-hidden="true">B</i><strong>{hud.coins}</strong></div>
              <div className="hud-actions">
                <button className="round-icon-button mute-button" onClick={toggleMute} aria-label={muted ? "Unmute game" : "Mute game"}>
                  <VolumeIcon muted={muted} />
                </button>
                <button className="round-icon-button" onClick={togglePause} aria-label="Pause game"><PauseIcon /></button>
              </div>
            </div>
            <div className="fuel-row">
              <FuelIcon />
              <div className="fuel-meter">
                <span>FUEL <strong>{Math.ceil(hud.fuel)}%</strong></span>
                <div className={`fuel-track ${hud.fuel < 22 ? "fuel-low" : ""}`}><div style={{ width: `${hud.fuel}%` }} /></div>
              </div>
            </div>
            {screen === "playing" && game.hintTime > 0 && <div className="drive-hint">Hold GAS to climb. Use BRAKE to balance.</div>}
          </div>
        )}

        {screen === "playing" && (
          <div className="control-layer">
            <button className="pedal pedal-brake" aria-label="Brake while moving, reverse when stopped" onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pressControl("brake", true); }}
              onPointerUp={() => pressControl("brake", false)} onPointerCancel={() => pressControl("brake", false)}
              onPointerLeave={(event) => { if (event.buttons === 0) pressControl("brake", false); }}>
              <span className="pedal-arrow left" aria-hidden="true" /><strong>BRAKE / REV</strong>
            </button>
            <button className="pedal pedal-gas" aria-label="Accelerate and lean back" onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pressControl("gas", true); }}
              onPointerUp={() => pressControl("gas", false)} onPointerCancel={() => pressControl("gas", false)}
              onPointerLeave={(event) => { if (event.buttons === 0) pressControl("gas", false); }}>
              <span className="pedal-arrow right" aria-hidden="true" /><strong>GAS</strong>
            </button>
          </div>
        )}

        {screen === "menu" && (
          <div className="menu-layer">
            <div className="brand-lockup">
              <p>HILL TRIALS</p>
              <h1>MUD<br /><span>RUSH</span></h1>
              <div className="brand-stripe" />
              <h2>Climb. Balance. Survive.</h2>
            </div>
            <div className="menu-actions">
              <button className="primary-action" onClick={startGame}><FlagIcon /><span>START RIDE</span></button>
              <p>Best distance <strong>{best}m</strong></p>
            </div>
          </div>
        )}

        {screen === "paused" && (
          <div className="modal-layer">
            <div className="modal-content">
              <p className="modal-kicker">ENGINE IDLING</p><h2>PAUSED</h2>
              <button className="primary-action" onClick={resumeGame}>RESUME RIDE</button>
              <button className="text-action" onClick={() => changeScreen("menu")}>BACK TO MENU</button>
            </div>
          </div>
        )}

        {screen === "gameover" && (
          <div className="modal-layer gameover-layer">
            <div className="modal-content">
              <p className="modal-kicker">{game.reason || "RIDE OVER"}</p>
              <h2>{Math.floor(game.distance)}<small>m</small></h2>
              <p className="run-result">{game.coins} coins collected</p>
              <button className="primary-action" onClick={startGame}><RestartIcon /><span>RIDE AGAIN</span></button>
              <p className="best-result">Personal best <strong>{best}m</strong></p>
            </div>
          </div>
        )}
      </section>
      <p className="desktop-help">Arrow keys or A / D to drive</p>
    </main>
  );
}
