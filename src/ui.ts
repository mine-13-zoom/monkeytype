// Screen rendering + interaction: test screen, config menu, pickers, results.
import {
  write, size, moveTo, RESET, BOLD, DIM, INVERSE,
  centerPad, visibleLen, type Key,
} from "./term";
import { getTheme, painter, themeNames, type Painter, type Theme } from "./theme";
import type { Config, Mode } from "./config";
import { baseLanguageNames } from "./data";
import { Engine, type TestResult } from "./engine";

// ---------- frame buffer ----------

interface Cell {
  ch: string;
  style: string;
}

const ANSI_RE = /^\x1b\[[0-9;?]*[A-Za-z~]/;

class Frame {
  private grid: Cell[][] = [];
  constructor(private p: Painter) {
    const { rows, cols } = size();
    for (let i = 0; i < rows; i++) {
      this.grid.push(Array.from({ length: cols }, () => ({ ch: " ", style: "" })));
    }
  }
  set(row: number, s: string): void {
    if (row < 0 || row >= this.grid.length) return;
    const { cols } = size();
    this.grid[row] = Array.from({ length: cols }, () => ({ ch: " ", style: "" }));
    this.put(row, 0, s);
  }
  put(row: number, col: number, s: string): void;
  put(row: number, col: number, s: string): void {
    if (row < 0 || row >= this.grid.length) return;
    const line = this.grid[row]!;
    let c = col;
    let style = "";
    let i = 0;
    while (i < s.length && c < line.length) {
      const m = ANSI_RE.exec(s.slice(i));
      if (m) {
        if (m[0] === RESET) style = "";
        else style += m[0];
        i += m[0].length;
        continue;
      }
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (c >= 0) line[c] = { ch, style };
      c++;
    }
  }
  flush(): void {
    let out = moveTo(1, 1) + this.p.bg;
    for (let r = 0; r < this.grid.length; r++) {
      const line = this.grid[r]!;
      let cur = "";
      for (const cell of line) {
        if (cell.style !== cur) {
          out += cell.style === "" ? RESET + this.p.bg : RESET + this.p.bg + cell.style;
          cur = cell.style;
        }
        out += cell.ch;
      }
      if (r < this.grid.length - 1) out += "\r\n";
    }
    out += RESET;
    write(out);
  }
}

// ---------- shared bits ----------

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[], width: number, p: Painter): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  let data = values;
  if (data.length > width) {
    // bucket-average down to width
    const bucket = data.length / width;
    const sampled: number[] = [];
    for (let i = 0; i < width; i++) {
      const slice = data.slice(Math.floor(i * bucket), Math.floor((i + 1) * bucket));
      sampled.push(slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length));
    }
    data = sampled;
  }
  let out = "";
  for (const v of data) {
    const level = Math.min(7, Math.max(0, Math.round((v / max) * 7)));
    out += p.main(SPARK[level]!);
  }
  return out;
}

function centerRow(f: Frame, row: number, s: string): void {
  const { cols } = size();
  f.set(row, " ".repeat(cols));
  f.put(row, Math.max(0, Math.floor((cols - visibleLen(s)) / 2)), s);
}

// ---------- generic picker ----------

export interface PickerItem<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface Screen {
  render(): void;
  handleKey(key: Key): void;
}

export class PickerScreen<T> implements Screen {
  private filtered: PickerItem<T>[];
  private cursor = 0;
  private query = "";

  constructor(
    private app: App,
    private title: string,
    private items: PickerItem<T>[],
    private current: T,
    private onPick: (value: T) => void,
  ) {
    this.filtered = items;
    const idx = items.findIndex((i) => i.value === current);
    if (idx >= 0) this.cursor = idx;
  }

  private refilter(): void {
    const q = this.query.toLowerCase();
    this.filtered = q
      ? this.items.filter((i) => i.label.toLowerCase().includes(q))
      : this.items;
    this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
  }

  render(): void {
    const p = this.app.p;
    const f = new Frame(p);
    const { rows } = size();
    centerRow(f, 2, p.main(BOLD + this.title) + p.sub(this.query ? `  filter: ${this.query}` : "  (type to filter)"));
    const top = 4;
    const pageSize = rows - top - 2;
    let start = 0;
    if (this.cursor >= pageSize) start = this.cursor - pageSize + 1;
    for (let i = 0; i < Math.min(pageSize, this.filtered.length); i++) {
      const item = this.filtered[start + i]!;
      const selected = start + i === this.cursor;
      const isCurrent = item.value === this.current;
      let label = (selected ? p.main("❯ ") : "  ") +
        (selected ? p.main(item.label) : p.text(item.label));
      if (isCurrent) label += p.sub("  ●");
      if (item.hint) label += p.sub("  " + item.hint);
      f.put(top + i, 6, label);
    }
    if (this.filtered.length === 0) {
      centerRow(f, top + 2, p.sub("no matches"));
    }
    centerRow(f, rows - 2, p.sub("↑/↓ navigate  enter select  esc cancel"));
    f.flush();
  }

  handleKey(key: Key): void {
    if (key.type === "escape") return this.app.popScreen();
    if (key.type === "up") {
      this.cursor = (this.cursor - 1 + this.filtered.length) % Math.max(1, this.filtered.length);
    } else if (key.type === "down") {
      this.cursor = (this.cursor + 1) % Math.max(1, this.filtered.length);
    } else if (key.type === "enter") {
      const item = this.filtered[this.cursor];
      if (item) {
        this.onPick(item.value);
        this.app.popScreen();
      }
      return;
    } else if (key.type === "backspace") {
      this.query = [...this.query].slice(0, -1).join("");
      this.refilter();
    } else if (key.type === "char") {
      this.query += key.char;
      this.refilter();
    }
    this.render();
  }
}

// ---------- text input screen ----------

export class InputScreen implements Screen {
  private value: string;
  constructor(
    private app: App,
    private title: string,
    initial: string,
    private validate: (v: string) => string | null,
    private onSubmit: (v: string) => void,
  ) {
    this.value = initial;
  }

  render(): void {
    const p = this.app.p;
    const f = new Frame(p);
    const { rows, cols } = size();
    centerRow(f, Math.floor(rows / 2) - 2, p.main(BOLD + this.title));
    const err = this.validate(this.value);
    const display = this.value.length > cols - 12
      ? "…" + this.value.slice(-(cols - 13))
      : this.value;
    centerRow(f, Math.floor(rows / 2), p.text(display) + INVERSE + p.fgCaret + " " + RESET + p.bg);
    if (err) centerRow(f, Math.floor(rows / 2) + 2, p.error(err));
    centerRow(f, rows - 2, p.sub("enter confirm  esc cancel"));
    f.flush();
  }

  handleKey(key: Key): void {
    if (key.type === "escape") return this.app.popScreen();
    if (key.type === "enter") {
      if (this.validate(this.value) === null) {
        this.onSubmit(this.value);
        return this.app.popScreen();
      }
    } else if (key.type === "backspace") {
      this.value = [...this.value].slice(0, -1).join("");
    } else if (key.type === "ctrl_backspace") {
      this.value = this.value.replace(/\S+\s*$/, "");
    } else if (key.type === "char") {
      this.value += key.char;
    }
    this.render();
  }
}

// ---------- config menu ----------

interface MenuEntry {
  label: string;
  value: () => string;
  action: () => void;
}

export class MenuScreen implements Screen {
  private cursor = 0;
  private entries: MenuEntry[];

  constructor(private app: App) {
    const cfg = app.cfg;
    this.entries = [
      {
        label: "theme",
        value: () => cfg.theme,
        action: () =>
          app.pushScreen(
            new PickerScreen(app, "theme", themeNames.map((n) => ({ label: n.replace(/_/g, " "), value: n })), cfg.theme, (v) => {
              cfg.theme = v;
              app.applyTheme();
              app.save();
            }),
          ),
      },
      {
        label: "language",
        value: () => cfg.language,
        action: () =>
          app.pushScreen(
            new PickerScreen(app, "language", baseLanguageNames().map((n) => ({ label: n.replace(/_/g, " "), value: n })), cfg.language, (v) => {
              cfg.language = v;
              app.save();
              void app.restart();
            }),
          ),
      },
      {
        label: "mode",
        value: () => cfg.mode,
        action: () =>
          app.pushScreen(
            new PickerScreen<Mode>(app, "mode",
              (["time", "words", "quote", "zen", "custom"] as Mode[]).map((m) => ({ label: m, value: m })),
              cfg.mode,
              (v) => { cfg.mode = v; app.save(); void app.restart(); }),
          ),
      },
      {
        label: "time",
        value: () => `${cfg.time}s`,
        action: () =>
          app.pushScreen(
            new PickerScreen<number>(app, "time",
              [15, 30, 60, 120].map((t) => ({ label: `${t}`, value: t })).concat([{ label: "custom…", value: -1 }]),
              [15, 30, 60, 120].includes(cfg.time) ? cfg.time : -1,
              (v) => {
                if (v === -1) {
                  app.pushScreen(new InputScreen(app, "time (seconds)", String(cfg.time),
                    (s) => (/^\d+$/.test(s) && +s > 0 ? null : "enter a positive number"),
                    (s) => { cfg.time = +s; app.save(); void app.restart(); }));
                } else { cfg.time = v; app.save(); void app.restart(); }
              }),
          ),
      },
      {
        label: "word count",
        value: () => `${cfg.words}`,
        action: () =>
          app.pushScreen(
            new PickerScreen<number>(app, "words",
              [10, 25, 50, 100].map((t) => ({ label: `${t}`, value: t })).concat([{ label: "custom…", value: -1 }]),
              [10, 25, 50, 100].includes(cfg.words) ? cfg.words : -1,
              (v) => {
                if (v === -1) {
                  app.pushScreen(new InputScreen(app, "word count", String(cfg.words),
                    (s) => (/^\d+$/.test(s) && +s > 0 ? null : "enter a positive number"),
                    (s) => { cfg.words = +s; app.save(); void app.restart(); }));
                } else { cfg.words = v; app.save(); void app.restart(); }
              }),
          ),
      },
      {
        label: "quote length",
        value: () => cfg.quoteLength,
        action: () =>
          app.pushScreen(
            new PickerScreen(app, "quote length",
              ["short", "medium", "long", "thicc", "all"].map((q) => ({ label: q, value: q })),
              cfg.quoteLength,
              (v) => { cfg.quoteLength = v as Config["quoteLength"]; app.save(); void app.restart(); }),
          ),
      },
      {
        label: "punctuation",
        value: () => (cfg.punctuation ? "on" : "off"),
        action: () => { cfg.punctuation = !cfg.punctuation; app.save(); void app.restart(); this.render(); },
      },
      {
        label: "numbers",
        value: () => (cfg.numbers ? "on" : "off"),
        action: () => { cfg.numbers = !cfg.numbers; app.save(); void app.restart(); this.render(); },
      },
      {
        label: "custom text",
        value: () => (cfg.customText.length > 30 ? cfg.customText.slice(0, 30) + "…" : cfg.customText),
        action: () =>
          app.pushScreen(new InputScreen(app, "custom text", cfg.customText,
            (s) => (s.trim().length > 0 ? null : "text cannot be empty"),
            (s) => { cfg.customText = s.trim(); app.save(); void app.restart(); })),
      },
      {
        label: "custom limit",
        value: () => cfg.customLimit === "none" ? "none" : `${cfg.customLimitValue} ${cfg.customLimit}`,
        action: () =>
          app.pushScreen(
            new PickerScreen(app, "custom limit",
              [{ label: "none (type text once)", value: "none" },
               { label: "word limit", value: "words" },
               { label: "time limit", value: "time" }],
              cfg.customLimit,
              (v) => {
                cfg.customLimit = v as Config["customLimit"];
                if (v !== "none") {
                  app.pushScreen(new InputScreen(app, `custom ${v} limit`, String(cfg.customLimitValue),
                    (s) => (/^\d+$/.test(s) && +s > 0 ? null : "enter a positive number"),
                    (s) => { cfg.customLimitValue = +s; app.save(); void app.restart(); }));
                }
                app.save(); void app.restart();
              }),
          ),
      },
      {
        label: "live wpm",
        value: () => (cfg.liveWpm ? "on" : "off"),
        action: () => { cfg.liveWpm = !cfg.liveWpm; app.save(); this.render(); },
      },
    ];
  }

  render(): void {
    const p = this.app.p;
    const f = new Frame(p);
    const { rows } = size();
    centerRow(f, 2, p.main(BOLD + "settings"));
    const top = 4;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      const selected = i === this.cursor;
      const label = (selected ? p.main("❯ " + e.label) : p.text("  " + e.label));
      const val = selected ? p.main(e.value()) : p.sub(e.value());
      f.put(top + i, 8, label);
      f.put(top + i, 30, val);
    }
    centerRow(f, rows - 2, p.sub("↑/↓ navigate  enter change  esc back"));
    f.flush();
  }

  handleKey(key: Key): void {
    if (key.type === "escape" || key.type === "tab") return this.app.popScreen();
    if (key.type === "up" || (key.type === "char" && key.char === "k")) {
      this.cursor = (this.cursor - 1 + this.entries.length) % this.entries.length;
    } else if (key.type === "down" || (key.type === "char" && key.char === "j")) {
      this.cursor = (this.cursor + 1) % this.entries.length;
    } else if (key.type === "enter") {
      this.entries[this.cursor]!.action();
      return;
    }
    this.render();
  }
}

// ---------- results screen ----------

export class ResultsScreen implements Screen {
  constructor(private app: App, private result: TestResult) {}

  render(): void {
    const p = this.app.p;
    const r = this.result;
    const f = new Frame(p);
    const { rows, cols } = size();

    const mid = Math.floor(rows / 2);
    const leftCol = Math.max(4, Math.floor(cols / 2) - 34);

    centerRow(f, 2, p.main(BOLD + "result"));

    f.put(mid - 5, leftCol, p.sub("wpm"));
    f.put(mid - 4, leftCol, p.main(BOLD + String(Math.round(r.wpm))));
    f.put(mid - 2, leftCol, p.sub("acc"));
    f.put(mid - 1, leftCol, p.main(BOLD + Math.round(r.acc) + "%"));

    const rc = leftCol + 14;
    const row = mid - 5;
    const kv = (dy: number, k: string, v: string) => {
      f.put(row + dy, rc, p.sub(k));
      f.put(row + dy, rc + 14, p.text(v));
    };
    kv(0, "test type", `${r.mode}${r.mode2 ? " " + r.mode2 : ""}`);
    kv(1, "raw", String(Math.round(r.rawWpm)));
    kv(2, "characters", `${r.charStats.correct}/${r.charStats.incorrect}/${r.charStats.extra}/${r.charStats.missed}`);
    kv(3, "consistency", Math.round(r.consistency) + "%");
    kv(4, "time", r.testDuration.toFixed(1) + "s");
    kv(5, "language", r.language.replace(/_/g, " "));
    let extra = 0;
    if (r.punctuation) { f.put(row + 6, rc, p.sub("punctuation")); extra++; }
    if (r.numbers) { f.put(row + 6, rc + 12 + extra * 2, p.sub("numbers")); }

    // chart
    const chartWidth = Math.min(72, cols - 16);
    centerRow(f, mid + 2, sparkline(r.wpmHistory, chartWidth, p));
    centerRow(f, mid + 3, p.sub("wpm per second"));
    const errTotal = r.errHistory.reduce((a, b) => a + b, 0);
    if (errTotal > 0) {
      centerRow(f, mid + 4, p.sub("errors: ") + p.error(String(errTotal)));
    }
    if (r.quoteSource) {
      centerRow(f, mid + 6, p.sub("— " + r.quoteSource));
    }

    centerRow(f, rows - 2, p.sub("tab/enter next test  esc settings  ctrl+c quit"));
    f.flush();
  }

  handleKey(key: Key): void {
    if (key.type === "tab" || key.type === "enter") {
      this.app.popScreen();
      void this.app.restart();
    } else if (key.type === "escape") {
      this.app.popScreen();
      this.app.pushScreen(new MenuScreen(this.app));
    }
  }
}

// ---------- test screen ----------

export class TestScreen implements Screen {
  engine: Engine | null = null;

  constructor(private app: App) {}

  async init(): Promise<void> {
    this.engine = await Engine.create(this.app.cfg);
    this.render();
  }

  /** Layout words into lines of given width; returns lines as word index ranges. */
  private layout(width: number): Array<{ start: number; end: number }> {
    const eng = this.engine!;
    const lines: Array<{ start: number; end: number }> = [];
    let lineStart = 0;
    let len = 0;
    for (let i = 0; i < eng.words.length; i++) {
      const w = eng.words[i]!;
      const wl = [...w].length;
      const need = len === 0 ? wl : len + 1 + wl;
      if (need > width && len > 0) {
        lines.push({ start: lineStart, end: i - 1 });
        lineStart = i;
        len = wl;
      } else {
        len = need;
      }
    }
    lines.push({ start: lineStart, end: eng.words.length - 1 });
    return lines;
  }

  render(): void {
    const eng = this.engine;
    if (!eng) return;
    const p = this.app.p;
    const f = new Frame(p);
    const { rows, cols } = size();
    const cfg = this.app.cfg;

    // header
    centerRow(f, 1, p.main(BOLD + "monkey") + p.text(BOLD + "type") + p.sub(" cli"));

    // config bar
    const bar = this.configBar(p);
    centerRow(f, 2, bar);

    // live stats
    const statsRow = Math.floor(rows / 2) - 4;
    if (eng.isStarted && !eng.isFinished) {
      let stat = "";
      const limit = eng.timeLimit();
      const live = eng.liveWpm();
      if (limit !== null) stat += p.main(String(Math.ceil(eng.remainingSeconds))) + "  ";
      else if (cfg.mode === "words") stat += p.main(`${eng.currentWord}/${cfg.words}`) + "  ";
      if (cfg.liveWpm) {
        stat += p.sub("wpm ") + p.main(String(Math.round(live.wpm))) +
                p.sub("  acc ") + p.main(Math.round(live.acc) + "%");
      }
      centerRow(f, statsRow, stat);
    } else if (!eng.isStarted) {
      centerRow(f, statsRow, p.sub(cfg.mode === "zen" ? "type anything, enter to finish" : "start typing to begin"));
    }

    // words area: 3 lines, current word's line in the middle
    const width = Math.min(cols - 10, 110);
    const lines = this.layout(width);
    const curLineIdx = lines.findIndex((l) => eng.currentWord >= l.start && eng.currentWord <= l.end);
    const startLine = Math.max(0, Math.min(curLineIdx - 1, lines.length - 3));
    const wordsTop = Math.floor(rows / 2) - 2;
    const leftPad = Math.floor((cols - width) / 2);

    for (let li = 0; li < 3 && startLine + li < lines.length; li++) {
      const line = lines[startLine + li]!;
      let col = leftPad;
      const row = wordsTop + li;
      for (let wi = line.start; wi <= line.end; wi++) {
        col += this.renderWord(f, row, col, wi) + 1;
      }
    }

    // footer
    centerRow(f, rows - 2, p.sub("tab restart  esc settings  ctrl+c quit"));
    f.flush();
  }

  /** Render one word at (row, col); returns its visible length. */
  private renderWord(f: Frame, row: number, col: number, wi: number): number {
    const eng = this.engine!;
    const p = this.app.p;
    const target = eng.words[wi]!;
    const typed = eng.typed[wi]!;
    const isCurrent = wi === eng.currentWord && !eng.isFinished;
    const isPast = wi < eng.currentWord;
    const tChars = [...target];
    const yChars = [...typed];

    let out = "";
    const len = Math.max(tChars.length, isCurrent ? yChars.length : tChars.length);
    for (let i = 0; i < tChars.length; i++) {
      const tc = tChars[i]!;
      const zen = this.app.cfg.mode === "zen";
      if (i < yChars.length) {
        const yc = yChars[i]!;
        if (zen || yc === tc) out += p.fgText + (zen ? yc : tc);
        else out += p.fgError + tc;
      } else if (isPast) {
        out += p.fgErrorExtra + tc; // missed char (skipped word)
      } else {
        out += p.fgSub + tc;
      }
    }
    // extra chars beyond target
    for (let i = tChars.length; i < yChars.length; i++) {
      out += p.fgErrorExtra + yChars[i];
    }
    // caret
    if (isCurrent) {
      const caretPos = yChars.length;
      // insert inverse block at caret position
      const before = this.sliceAnsi(out, caretPos);
      const at = tChars[caretPos] ?? " ";
      out = before + INVERSE + p.fgCaret + at + RESET + p.bg + this.sliceAnsiFrom(out, caretPos + 1);
    }
    f.put(row, col, out);
    return Math.max(tChars.length, yChars.length);
  }

  /** Take the first n visible chars of an ansi string (keeps escapes). */
  private sliceAnsi(s: string, n: number): string {
    let vis = 0, i = 0, out = "";
    while (i < s.length && vis < n) {
      if (s[i] === "\x1b") {
        const m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(s.slice(i));
        if (m) { out += m[0]; i += m[0].length; continue; }
      }
      out += s[i]; i++; vis++;
    }
    return out;
  }

  /** Drop the first n visible chars of an ansi string (keeps escapes, minus consumed char). */
  private sliceAnsiFrom(s: string, n: number): string {
    let vis = 0, i = 0;
    while (i < s.length) {
      if (vis >= n) break;
      if (s[i] === "\x1b") {
        const m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(s.slice(i));
        if (m) { i += m[0].length; continue; }
      }
      i++; vis++;
    }
    return s.slice(i);
  }

  private configBar(p: Painter): string {
    const cfg = this.app.cfg;
    const on = (b: boolean, s: string) => (b ? p.main(s) : p.sub(s));
    const sep = p.sub("  |  ");
    let bar = on(cfg.punctuation, "@ punctuation") + "  " + on(cfg.numbers, "# numbers") + sep;
    const modePart = (m: string, extra?: string) =>
      cfg.mode === m ? p.main(m + (extra ? " " + extra : "")) : p.sub(m);
    bar += modePart("time", cfg.mode === "time" ? String(cfg.time) : "") + "  ";
    bar += modePart("words", cfg.mode === "words" ? String(cfg.words) : "") + "  ";
    bar += modePart("quote") + "  " + modePart("zen") + "  " + modePart("custom");
    bar += sep + p.sub(cfg.language.replace(/_/g, " "));
    return bar;
  }

  handleKey(key: Key): void {
    const eng = this.engine;
    if (!eng) return;
    if (key.type === "escape") {
      this.app.pushScreen(new MenuScreen(this.app));
      return;
    }
    if (key.type === "tab") {
      void this.app.restart();
      return;
    }
    if (eng.isFinished) return;
    if (eng.input(key)) {
      if (eng.isFinished) {
        this.app.pushScreen(new ResultsScreen(this.app, eng.result()));
      } else {
        this.render();
      }
    }
  }

  /** Called by app timer; finish time-based tests and refresh live stats. */
  tick(): void {
    const eng = this.engine;
    if (!eng || eng.isFinished) return;
    if (eng.tick()) {
      this.app.pushScreen(new ResultsScreen(this.app, eng.result()));
    } else if (eng.isStarted) {
      this.render();
    }
  }
}

// ---------- app ----------

export class App {
  p: Painter;
  theme: Theme;
  private screens: Screen[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(public cfg: Config, private onSave: () => void) {
    this.theme = getTheme(cfg.theme);
    this.p = painter(this.theme);
  }

  applyTheme(): void {
    this.theme = getTheme(this.cfg.theme);
    this.p = painter(this.theme);
    // repaint base bg
    write("\x1b[2J" + moveTo(1, 1));
    this.render();
  }

  save(): void {
    this.onSave();
  }

  setRoot(s: Screen): void {
    this.screens = [s];
  }

  pushScreen(s: Screen): void {
    this.screens.push(s);
    s.render();
  }

  popScreen(): void {
    this.screens.pop();
    this.render();
  }

  get current(): Screen | undefined {
    return this.screens[this.screens.length - 1];
  }

  get testScreen(): TestScreen | undefined {
    return this.screens.find((s): s is TestScreen => s instanceof TestScreen);
  }

  render(): void {
    this.current?.render();
  }

  handleKey(key: Key): void {
    this.current?.handleKey(key);
  }

  async restart(): Promise<void> {
    const ts = new TestScreen(this);
    this.screens = [ts];
    write("\x1b[2J");
    await ts.init();
  }

  startTimer(): void {
    this.timer = setInterval(() => {
      const cur = this.current;
      if (cur instanceof TestScreen) cur.tick();
    }, 250);
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
