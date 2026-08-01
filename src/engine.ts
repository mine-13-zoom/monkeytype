// Core typing-test engine: input state machine + monkeytype-accurate stats.
import type { Config } from "./config";
import { buildTest, getMoreWords } from "./generator";
import type { Key } from "./term";

export interface CharStats {
  correct: number; // correct chars incl. spaces after correct words
  incorrect: number;
  extra: number;
  missed: number;
}

export interface TestResult {
  mode: string;
  mode2: string;
  wpm: number;
  rawWpm: number;
  acc: number;
  consistency: number;
  charStats: CharStats;
  testDuration: number; // seconds
  wpmHistory: number[];
  rawHistory: number[];
  errHistory: number[];
  wpmConsistency: number;
  language: string;
  punctuation: boolean;
  numbers: boolean;
  quoteSource?: string;
  quoteId?: number;
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

function calculateWpm(charCount: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return charCount / 5 / (durationSeconds / 60);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** monkeytype's kogasa: 100 * (1 - cov) */
function kogasa(cov: number): number {
  return roundTo2(100 * (1 - cov));
}

export class Engine {
  cfg: Config;
  words: string[] = [];
  typed: string[] = [];
  currentWord = 0;
  startedAt: number | null = null;
  endedAt: number | null = null;
  createdAt = 0;
  firstKeyAt: number | null = null;
  lastKeyAt: number | null = null;
  quoteSource: string | undefined;
  quoteId: number | undefined;
  quoteGroup: number | undefined;

  // keystroke log: [timestampMs, correct]
  keyLog: Array<[number, boolean]> = [];
  // per-second buckets
  rawPerSecond: number[] = [];
  errPerSecond: number[] = [];
  wpmHistory: number[] = [];
  private lastSampleSecond = 0;

  private constructor(cfg: Config) {
    this.cfg = cfg;
  }

  static async create(cfg: Config): Promise<Engine> {
    const e = new Engine(cfg);
    const built = await buildTest(cfg);
    e.words = built.words;
    e.typed = e.words.map(() => "");
    e.quoteSource = built.quoteSource;
    e.quoteId = built.quoteId;
    e.quoteGroup = built.quoteGroup;
    e.createdAt = Date.now();
    return e;
  }

  /** Inter-keypress intervals in ms (monkeytype keySpacing). */
  keySpacing(): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.keyLog.length; i++) {
      out.push(this.keyLog[i]![0] - this.keyLog[i - 1]![0]);
    }
    return out;
  }

  lastKeyToEnd(): number {
    if (this.endedAt === null || this.keyLog.length === 0) return 0;
    return Math.max(0, this.endedAt - this.keyLog[this.keyLog.length - 1]![0]);
  }

  startToFirstKey(): number {
    if (this.keyLog.length === 0 || this.createdAt === 0) return 0;
    return Math.max(0, this.keyLog[0]![0] - this.createdAt);
  }

  get isStarted(): boolean {
    return this.startedAt !== null;
  }

  get isFinished(): boolean {
    return this.endedAt !== null;
  }

  get elapsedSeconds(): number {
    if (this.startedAt === null) return 0;
    const end = this.endedAt ?? Date.now();
    return (end - this.startedAt) / 1000;
  }

  get remainingSeconds(): number {
    const limit = this.timeLimit();
    if (limit === null) return 0;
    return Math.max(0, limit - this.elapsedSeconds);
  }

  timeLimit(): number | null {
    if (this.cfg.mode === "time") return this.cfg.time;
    if (this.cfg.mode === "custom" && this.cfg.customLimit === "time")
      return this.cfg.customLimitValue;
    return null;
  }

  private ensureStarted(): void {
    if (this.startedAt === null) {
      this.startedAt = Date.now();
      this.firstKeyAt = this.startedAt;
    }
  }

  private bucket(t: number): number {
    if (this.startedAt === null) return 0;
    return Math.floor((t - this.startedAt) / 1000);
  }

  private logKeypress(correct: boolean): void {
    const t = Date.now();
    this.lastKeyAt = t;
    this.keyLog.push([t, correct]);
    const b = this.bucket(t);
    while (this.rawPerSecond.length <= b) this.rawPerSecond.push(0);
    while (this.errPerSecond.length <= b) this.errPerSecond.push(0);
    this.rawPerSecond[b]! += 1;
    if (!correct) this.errPerSecond[b]! += 1;
  }

  /** Handle a key. Returns true if the display should re-render. */
  input(key: Key): boolean {
    if (this.isFinished) return false;

    if (key.type === "char") {
      const ch = key.char;
      this.ensureStarted();
      const target = this.words[this.currentWord] ?? "";
      const typed = this.typed[this.currentWord] ?? "";

      if (ch === " ") {
        if (typed.length === 0) return false; // ignore leading spaces
        const correctSoFar =
          this.cfg.mode === "zen"
            ? true
            : typed === target.slice(0, typed.length) && typed.length === target.length;
        this.logKeypress(correctSoFar);
        if (this.currentWord >= this.words.length - 1) {
          this.finish();
          return true;
        }
        this.currentWord++;
        void this.refillIfNeeded();
        return true;
      }

      // normal char
      const pos = typed.length;
      const zen = this.cfg.mode === "zen";
      const correct = zen ? true : target[pos] === ch;
      this.typed[this.currentWord] = typed + ch;
      this.logKeypress(correct);

      // end of words/quote/custom-none: finish when last word typed fully and correctly
      if (this.currentWord === this.words.length - 1) {
        if (zen) {
          // zen never auto-finishes
        } else if (this.typed[this.currentWord] === target) {
          this.finish();
        }
      }
      void this.refillIfNeeded();
      return true;
    }

    if (key.type === "backspace") {
      const typed = this.typed[this.currentWord] ?? "";
      if (typed.length > 0) {
        this.typed[this.currentWord] = [...typed].slice(0, -1).join("");
        return true;
      }
      // move back to previous word if it was not fully correct
      if (this.currentWord > 0) {
        const prevTarget = this.words[this.currentWord - 1]!;
        const prevTyped = this.typed[this.currentWord - 1]!;
        if (prevTyped !== prevTarget) {
          this.currentWord--;
          return true;
        }
      }
      return false;
    }

    if (key.type === "ctrl_backspace") {
      const typed = this.typed[this.currentWord] ?? "";
      if (typed.length > 0) {
        this.typed[this.currentWord] = "";
      } else if (this.currentWord > 0) {
        this.currentWord--;
        this.typed[this.currentWord] = "";
      }
      return true;
    }

    if (key.type === "enter" && this.cfg.mode === "zen") {
      if (this.isStarted) {
        this.finish();
        return true;
      }
      return false;
    }

    return false;
  }

  /** Time-mode countdown check; call on a timer. Returns true if test just finished. */
  tick(): boolean {
    if (!this.isStarted || this.isFinished) return false;
    const limit = this.timeLimit();
    if (limit !== null && this.elapsedSeconds >= limit) {
      this.finish();
      return true;
    }
    // sample live wpm each second
    const sec = Math.floor(this.elapsedSeconds);
    if (sec > this.lastSampleSecond) {
      this.lastSampleSecond = sec;
      this.wpmHistory.push(roundTo2(this.liveWpm().wpm));
    }
    return false;
  }

  private needsRolling(): boolean {
    return (
      this.cfg.mode === "time" ||
      this.cfg.mode === "zen" ||
      (this.cfg.mode === "custom" && this.cfg.customLimit !== "none")
    );
  }

  private refillPromise: Promise<void> | null = null;
  private async refillIfNeeded(): Promise<void> {
    if (!this.needsRolling() || this.isFinished) return;
    if (this.words.length - this.currentWord > 60) return;
    if (this.refillPromise) return this.refillPromise;
    this.refillPromise = (async () => {
      const prev = this.words[this.words.length - 1];
      const more = await getMoreWords(this.cfg, 60, prev);
      this.words.push(...more);
      this.typed.push(...more.map(() => ""));
      this.refillPromise = null;
    })();
    return this.refillPromise;
  }

  finish(): void {
    if (this.endedAt !== null) return;
    if (this.startedAt === null) this.startedAt = Date.now();
    this.endedAt = Date.now();
  }

  liveWpm(): { wpm: number; raw: number; acc: number } {
    const dur = this.elapsedSeconds;
    const stats = this.charStats();
    const wpm = calculateWpm(stats.correct, dur);
    const totalTyped = this.keyLog.length;
    const correctKp = this.keyLog.reduce((n, [, c]) => n + (c ? 1 : 0), 0);
    const raw = calculateWpm(totalTyped, dur);
    const acc = totalTyped === 0 ? 100 : (correctKp / totalTyped) * 100;
    return { wpm: roundTo2(wpm), raw: roundTo2(raw), acc: roundTo2(acc) };
  }

  charStats(): CharStats {
    let correct = 0;
    let incorrect = 0;
    let extra = 0;
    let missed = 0;
    const zen = this.cfg.mode === "zen";

    for (let i = 0; i <= this.currentWord && i < this.words.length; i++) {
      const target = this.words[i]!;
      const typed = this.typed[i]!;
      if (i === this.currentWord && !this.isFinished) {
        // word in progress: count chars so far
        for (let j = 0; j < typed.length; j++) {
          if (zen || typed[j] === target[j]) correct++;
          else if (j >= target.length) extra++;
          else incorrect++;
        }
        continue;
      }
      const fullyCorrect = zen ? typed.length > 0 : typed === target;
      if (fullyCorrect) {
        correct += typed.length;
        if (i < this.currentWord) correct += 1; // the space that advanced past this word
      } else {
        for (let j = 0; j < typed.length; j++) {
          if (j >= target.length) extra++;
          else if (typed[j] === target[j]) correct++;
          else incorrect++;
        }
        if (typed.length < target.length && i < this.currentWord) {
          missed += target.length - typed.length;
        }
      }
    }
    return { correct, incorrect, extra, missed };
  }

  result(): TestResult {
    const dur = this.elapsedSeconds;
    const stats = this.charStats();
    const totalTyped = this.keyLog.length;
    const correctKp = this.keyLog.reduce((n, [, c]) => n + (c ? 1 : 0), 0);

    const wpm = roundTo2(calculateWpm(stats.correct, dur));
    const rawWpm = roundTo2(calculateWpm(totalTyped, dur));
    const acc = totalTyped === 0 ? 100 : roundTo2((correctKp / totalTyped) * 100);

    const rawHist = this.rawPerSecond.map((c, i) => {
      const isLast = i === this.rawPerSecond.length - 1;
      const interval = isLast ? Math.max(0.001, dur - i) : 1;
      return Math.round(calculateWpm(c, interval));
    });
    const sd = stdDev(rawHist);
    const avg = mean(rawHist);
    let consistency = avg > 0 ? kogasa(sd / avg) : 0;
    if (isNaN(consistency)) consistency = 0;
    consistency = Math.min(100, Math.max(0, consistency));

    // fill wpm history for short tests (needed before wpmConsistency)
    const wpmHistory = [...this.wpmHistory];
    if (wpmHistory.length === 0) wpmHistory.push(wpm);
    let wpmConsistency = kogasa(stdDev(wpmHistory) / Math.max(1e-9, mean(wpmHistory)));
    if (isNaN(wpmConsistency)) wpmConsistency = 0;
    wpmConsistency = Math.min(100, Math.max(0, wpmConsistency));

    const cfg = this.cfg;
    const mode2 =
      cfg.mode === "time"
        ? String(cfg.time)
        : cfg.mode === "words"
          ? String(cfg.words)
          : cfg.mode === "quote"
            ? String(this.quoteId ?? -1)
            : cfg.mode === "custom"
              ? "custom"
              : "zen";

    return {
      mode: cfg.mode,
      mode2,
      wpm,
      rawWpm,
      acc,
      consistency,
      charStats: stats,
      testDuration: roundTo2(dur),
      wpmHistory,
      rawHistory: rawHist,
      errHistory: this.errPerSecond,
      wpmConsistency,
      language: cfg.language,
      punctuation: cfg.punctuation,
      numbers: cfg.numbers,
      quoteSource: this.quoteSource,
      quoteId: this.quoteId,
    };
  }
}
