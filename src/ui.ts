// Screen rendering + interaction: test screen, config menu, pickers, results.
import {
  write, size, moveTo, RESET, BOLD, INVERSE,
  visibleLen, type Key,
} from "./term";
import { getTheme, painter, themeNames, type Painter, type Theme } from "./theme";
import type { Config, Mode } from "./config";
import { baseLanguageNames } from "./data";
import { Engine, type TestResult } from "./engine";
import { signInWithEmailPassword, submitResult } from "./api";

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

// ---------- click hit-testing ----------

type MouseKind = "press" | "release" | "wheel_up" | "wheel_down" | "move";

class ClickMap {
  private regions: Array<{ y: number; x1: number; x2: number; id: string }> = [];
  add(y: number, x1: number, x2: number, id: string): void {
    this.regions.push({ y, x1, x2, id });
  }
  hit(x: number, y: number): string | undefined {
    // x/y are 1-based terminal coords
    for (const r of this.regions) {
      if (y === r.y + 1 && x >= r.x1 + 1 && x <= r.x2 + 1) return r.id;
    }
    return undefined;
  }
}

// ---------- shared bits ----------

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[], width: number, p: Painter): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  let data = values;
  if (data.length > width) {
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

function centerRow(f: Frame, row: number, s: string): number {
  const { cols } = size();
  f.set(row, " ".repeat(cols));
  const startCol = Math.max(0, Math.floor((cols - visibleLen(s)) / 2));
  f.put(row, startCol, s);
  return startCol;
}

// ---------- screens ----------

export interface Screen {
  render(): void;
  handleKey(key: Key): void;
  handleMouse?(x: number, y: number, kind: MouseKind): void;
}

// ---------- generic picker ----------

export interface PickerItem<T> {
  label: string;
  value: T;
  hint?: string;
}

export class PickerScreen<T> implements Screen {
  private filtered: PickerItem<T>[];
  private cursor = 0;
  private query = "";
  private clicks = new ClickMap();

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

  private pageSize(): number {
    return size().rows - 4 - 2;
  }

  private startIndex(): number {
    const pageSize = this.pageSize();
    return this.cursor >= pageSize ? this.cursor - pageSize + 1 : 0;
  }

  render(): void {
    const p = this.app.p;
    const f = new Frame(p);
    const { rows } = size();
    this.clicks = new ClickMap();
    centerRow(f, 2, p.main(BOLD + this.title) + p.sub(this.query ? `  filter: ${this.query}` : "  (type to filter)"));
    const top = 4;
    const pageSize = this.pageSize();
    const start = this.startIndex();
    for (let i = 0; i < Math.min(pageSize, this.filtered.length); i++) {
      const item = this.filtered[start + i]!;
      const selected = start + i === this.cursor;
      const isCurrent = item.value === this.current;
      let label = (selected ? p.main("❯ ") : "  ") +
        (selected ? p.main(item.label) : p.text(item.label));
      if (isCurrent) label += p.sub("  ●");
      if (item.hint) label += p.sub("  " + item.hint);
      f.put(top + i, 6, label);
      this.clicks.add(top + i, 6, 6 + visibleLen(item.label) + 4, `item:${start + i}`);
    }
    if (this.filtered.length === 0) {
      centerRow(f, top + 2, p.sub("no matches"));
    }
    centerRow(f, rows - 2, p.sub("↑/↓ navigate  enter select  esc cancel"));
    f.flush();
  }

  private move(delta: number): void {
    const n = Math.max(1, this.filtered.length);
    this.cursor = (this.cursor + delta + n) % n;
  }

  private pick(): void {
    const item = this.filtered[this.cursor];
    if (item) {
      const value = item.value;
      // Pop the picker before running callbacks. Some callbacks replace the
      // whole stack via restart(); popping afterward would remove the new test.
      this.app.popScreen();
      this.onPick(value);
    }
  }

  handleKey(key: Key): void {
    if (key.type === "escape") return this.app.popScreen();
    if (key.type === "up") this.move(-1);
    else if (key.type === "down") this.move(1);
    else if (key.type === "enter") return this.pick();
    else if (key.type === "backspace") {
      this.query = [...this.query].slice(0, -1).join("");
      this.refilter();
    } else if (key.type === "char") {
      this.query += key.char;
      this.refilter();
    }
    this.render();
  }

  handleMouse(x: number, y: number, kind: MouseKind): void {
    if (kind === "wheel_up") { this.move(-1); return this.render(); }
    if (kind === "wheel_down") { this.move(1); return this.render(); }
    if (kind !== "press") return;
    const id = this.clicks.hit(x, y);
    if (id?.startsWith("item:")) {
      this.cursor = parseInt(id.slice(5), 10);
      this.pick();
    }
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
    private mask = false,
  ) {
    this.value = initial;
  }

  render(): void {
    const p = this.app.p;
    const f = new Frame(p);
    const { rows, cols } = size();
    centerRow(f, Math.floor(rows / 2) - 2, p.main(BOLD + this.title));
    const err = this.validate(this.value);
    const shown = this.mask ? "•".repeat([...this.value].length) : this.value;
    const display = shown.length > cols - 12
      ? "…" + shown.slice(-(cols - 13))
      : shown;
    centerRow(f, Math.floor(rows / 2), p.text(display) + INVERSE + p.fgCaret + " " + RESET + p.bg);
    if (err) centerRow(f, Math.floor(rows / 2) + 2, p.error(err));
    centerRow(f, rows - 2, p.sub("enter confirm  esc cancel"));
    f.flush();
  }

  handleKey(key: Key): void {
    if (key.type === "escape") return this.app.popScreen();
    if (key.type === "enter") {
      if (this.validate(this.value) === null) {
        const value = this.value;
        this.app.popScreen();
        this.onSubmit(value);
        return;
      }
    } else if (key.type === "backspace") {
      this.value = [...this.value].slice(0, -1).join("");
    } else if (key.type === "ctrl_backspace") {
      this.value = "";
    } else if (key.type === "char") {
      this.value += key.char;
    }
    this.render();
  }
}

// ---------- shared picker launchers ----------

function openThemePicker(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(
    new PickerScreen(app, "theme",
      themeNames.map((n) => ({ label: n.replace(/_/g, " "), value: n })),
      cfg.theme,
      (v) => { cfg.theme = v; app.applyTheme(); app.save(); }),
  );
}

function openLanguagePicker(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(
    new PickerScreen(app, "language",
      baseLanguageNames().map((n) => ({ label: n.replace(/_/g, " "), value: n })),
      cfg.language,
      (v) => { cfg.language = v; app.save(); void app.restart(); }),
  );
}

function openModePicker(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(
    new PickerScreen<Mode>(app, "mode",
      (["time", "words", "quote", "zen", "custom"] as Mode[]).map((m) => ({ label: m, value: m })),
      cfg.mode,
      (v) => { cfg.mode = v; app.save(); void app.restart(); }),
  );
}

function openTimePicker(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(
    new PickerScreen<number>(app, "time",
      [15, 30, 60, 120].map((t) => ({ label: `${t}`, value: t })).concat([{ label: "custom…", value: -1 }]),
      [15, 30, 60, 120].includes(cfg.time) ? cfg.time : -1,
      (v) => {
        if (v === -1) {
          app.pushScreen(new InputScreen(app, "time (seconds)", String(cfg.time),
            (s) => (/^\d+$/.test(s) && +s > 0 ? null : "enter a positive number"),
            (s) => { cfg.time = +s; app.save(); void app.restart(); }));
        } else { cfg.time = v; cfg.mode = "time"; app.save(); void app.restart(); }
      }),
  );
}

function openWordsPicker(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(
    new PickerScreen<number>(app, "words",
      [10, 25, 50, 100].map((t) => ({ label: `${t}`, value: t })).concat([{ label: "custom…", value: -1 }]),
      [10, 25, 50, 100].includes(cfg.words) ? cfg.words : -1,
      (v) => {
        if (v === -1) {
          app.pushScreen(new InputScreen(app, "word count", String(cfg.words),
            (s) => (/^\d+$/.test(s) && +s > 0 ? null : "enter a positive number"),
            (s) => { cfg.words = +s; app.save(); void app.restart(); }));
        } else { cfg.words = v; cfg.mode = "words"; app.save(); void app.restart(); }
      }),
  );
}

function openQuoteLengthPicker(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(
    new PickerScreen(app, "quote length",
      ["short", "medium", "long", "thicc", "all"].map((q) => ({ label: q, value: q })),
      cfg.quoteLength,
      (v) => { cfg.quoteLength = v as Config["quoteLength"]; app.save(); void app.restart(); }),
  );
}

function openCustomTextInput(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(new InputScreen(app, "custom text", cfg.customText,
    (s) => (s.trim().length > 0 ? null : "text cannot be empty"),
    (s) => { cfg.customText = s.trim(); app.save(); void app.restart(); }));
}

function openCustomLimitPicker(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(
    new PickerScreen(app, "custom limit",
      [{ label: "none (type text once)", value: "none" },
       { label: "word limit", value: "words" },
       { label: "time limit", value: "time" }],
      cfg.customLimit,
      (v) => {
        cfg.customLimit = v as Config["customLimit"];
        app.save();
        if (v !== "none") {
          app.pushScreen(new InputScreen(app, `custom ${v} limit`, String(cfg.customLimitValue),
            (s) => (/^\d+$/.test(s) && +s > 0 ? null : "enter a positive number"),
            (s) => { cfg.customLimitValue = +s; app.save(); void app.restart(); }));
        } else void app.restart();
      }),
  );
}

function openLoginFlow(app: App): void {
  const cfg = app.cfg;
  app.pushScreen(new InputScreen(app,
    "monkeytype account email",
    cfg.authEmail,
    (s) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim()) ? null : "enter a valid email"),
    (email) => {
      app.pushScreen(new InputScreen(app,
        "monkeytype account password (not stored)",
        "",
        (s) => (s.length > 0 ? null : "password cannot be empty"),
        (password) => {
          app.notify("signing in…");
          void signInWithEmailPassword(email.trim(), password).then((outcome) => {
            if (outcome.ok && outcome.refreshToken) {
              cfg.authEmail = outcome.email ?? email.trim();
              cfg.authRefreshToken = outcome.refreshToken;
              app.save();
              app.notify(`signed in as ${cfg.authEmail} — results will sync`);
            } else {
              app.notify("sign-in failed: " + outcome.message);
            }
          });
        },
        true));
    }));
}

function openAccount(app: App): void {
  const cfg = app.cfg;
  if (!cfg.authRefreshToken) return openLoginFlow(app);
  app.pushScreen(new PickerScreen(app, "account",
    [
      { label: `signed in as ${cfg.authEmail}`, value: "keep", hint: "keep session" },
      { label: "switch account", value: "switch" },
      { label: "sign out", value: "signout" },
    ],
    "keep",
    (value) => {
      if (value === "switch") openLoginFlow(app);
      else if (value === "signout") {
        cfg.authEmail = "";
        cfg.authRefreshToken = "";
        app.save();
        app.notify("signed out");
      }
    }));
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
  private clicks = new ClickMap();

  constructor(private app: App) {
    const cfg = app.cfg;
    this.entries = [
      { label: "theme", value: () => cfg.theme, action: () => openThemePicker(app) },
      { label: "language", value: () => cfg.language, action: () => openLanguagePicker(app) },
      { label: "mode", value: () => cfg.mode, action: () => openModePicker(app) },
      { label: "time", value: () => `${cfg.time}s`, action: () => openTimePicker(app) },
      { label: "word count", value: () => `${cfg.words}`, action: () => openWordsPicker(app) },
      { label: "quote length", value: () => cfg.quoteLength, action: () => openQuoteLengthPicker(app) },
      {
        label: "punctuation",
        value: () => (cfg.punctuation ? "on" : "off"),
        action: () => { cfg.punctuation = !cfg.punctuation; app.save(); void app.restart(); },
      },
      {
        label: "numbers",
        value: () => (cfg.numbers ? "on" : "off"),
        action: () => { cfg.numbers = !cfg.numbers; app.save(); void app.restart(); },
      },
      {
        label: "custom text",
        value: () => (cfg.customText.length > 30 ? cfg.customText.slice(0, 30) + "…" : cfg.customText),
        action: () => openCustomTextInput(app),
      },
      {
        label: "custom limit",
        value: () => cfg.customLimit === "none" ? "none" : `${cfg.customLimitValue} ${cfg.customLimit}`,
        action: () => openCustomLimitPicker(app),
      },
      {
        label: "live wpm",
        value: () => (cfg.liveWpm ? "on" : "off"),
        action: () => { cfg.liveWpm = !cfg.liveWpm; app.save(); this.render(); },
      },
      {
        label: "account",
        value: () => (cfg.authRefreshToken ? cfg.authEmail : "not signed in"),
        action: () => openAccount(app),
      },
    ];
  }

  render(): void {
    const p = this.app.p;
    const f = new Frame(p);
    const { rows } = size();
    this.clicks = new ClickMap();
    centerRow(f, 2, p.main(BOLD + "settings"));
    const top = 4;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      const selected = i === this.cursor;
      const label = (selected ? p.main("❯ " + e.label) : p.text("  " + e.label));
      const val = selected ? p.main(e.value()) : p.sub(e.value());
      f.put(top + i, 8, label);
      f.put(top + i, 30, val);
      this.clicks.add(top + i, 6, 60, `entry:${i}`);
    }
    const notice = this.app.consumeNotice();
    if (notice) centerRow(f, top + this.entries.length + 1, p.main(notice));
    centerRow(f, rows - 2, p.sub("↑/↓ navigate  enter/click change  esc back"));
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

  handleMouse(x: number, y: number, kind: MouseKind): void {
    if (kind === "wheel_up") {
      this.cursor = (this.cursor - 1 + this.entries.length) % this.entries.length;
      return this.render();
    }
    if (kind === "wheel_down") {
      this.cursor = (this.cursor + 1) % this.entries.length;
      return this.render();
    }
    if (kind !== "press") return;
    const id = this.clicks.hit(x, y);
    if (id?.startsWith("entry:")) {
      this.cursor = parseInt(id.slice(6), 10);
      this.entries[this.cursor]!.action();
    }
  }
}

// ---------- results screen ----------

export class ResultsScreen implements Screen {
  private syncStatus: string | null = null;
  private clicks = new ClickMap();

  constructor(private app: App, private result: TestResult, engine: Engine) {
    const cfg = app.cfg;
    if (cfg.authRefreshToken) {
      if (result.acc < 50 || result.wpm < 1 || result.testDuration < 1) {
        this.syncStatus = "test invalid/too short — not saved";
      } else {
        this.syncStatus = "saving result…";
        void submitResult(cfg.authRefreshToken, engine).then((outcome) => {
          if (outcome.refreshToken && outcome.refreshToken !== cfg.authRefreshToken) {
            cfg.authRefreshToken = outcome.refreshToken;
            app.save();
          }
          this.syncStatus = outcome.ok
            ? "☁ " + outcome.message
            : "save failed: " + outcome.message;
          if (app.current === this) this.render();
        });
      }
    }
  }

  render(): void {
    const p = this.app.p;
    const r = this.result;
    const f = new Frame(p);
    const { rows, cols } = size();
    this.clicks = new ClickMap();

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
    const modeLabel = r.mode === "quote" ? `quote ${r.mode2}` : `${r.mode}${r.mode2 && r.mode2 !== "custom" && r.mode2 !== "zen" ? " " + r.mode2 : ""}`;
    kv(0, "test type", modeLabel);
    kv(1, "raw", String(Math.round(r.rawWpm)));
    kv(2, "characters", `${r.charStats.correct}/${r.charStats.incorrect}/${r.charStats.extra}/${r.charStats.missed}`);
    kv(3, "consistency", Math.round(r.consistency) + "%");
    kv(4, "time", r.testDuration.toFixed(1) + "s");
    kv(5, "language", r.language.replace(/_/g, " "));
    if (r.punctuation) f.put(row + 6, rc, p.sub("punctuation"));
    if (r.numbers) f.put(row + 6, rc + 12, p.sub("numbers"));

    // chart
    const chartWidth = Math.min(72, cols - 16);
    centerRow(f, mid + 2, sparkline(r.wpmHistory, chartWidth, p));
    centerRow(f, mid + 3, p.sub("wpm per second"));
    const errTotal = r.errHistory.reduce((a, b) => a + b, 0);
    if (errTotal > 0) {
      centerRow(f, mid + 4, p.sub("errors: ") + p.error(String(errTotal)));
    }
    if (r.quoteSource) {
      centerRow(f, mid + 5, p.sub("— " + r.quoteSource));
    }

    if (this.syncStatus) {
      centerRow(f, mid + 7, this.syncStatus.startsWith("save failed") || this.syncStatus.includes("invalid")
        ? p.error(this.syncStatus)
        : p.main(this.syncStatus));
    } else if (!this.app.cfg.authRefreshToken) {
      centerRow(f, mid + 7, p.sub("sign in via esc → account to sync results"));
    }

    const footer = p.main("next test") + p.sub("  (tab/enter)   ") + p.main("settings") + p.sub("  (esc)   ctrl+c quit");
    const startCol = centerRow(f, rows - 2, footer);
    this.clicks.add(rows - 2, startCol, startCol + 9, "next");
    this.clicks.add(rows - 2, startCol + 25, startCol + 33, "settings");
    f.flush();
  }

  private next(): void {
    this.app.popScreen();
    void this.app.restart();
  }

  private settings(): void {
    this.app.popScreen();
    this.app.pushScreen(new MenuScreen(this.app));
  }

  handleKey(key: Key): void {
    if (key.type === "tab" || key.type === "enter") this.next();
    else if (key.type === "escape") this.settings();
  }

  handleMouse(x: number, y: number, kind: MouseKind): void {
    if (kind !== "press") return;
    const id = this.clicks.hit(x, y);
    if (id === "next") return this.next();
    if (id === "settings") return this.settings();
    // Some terminals report the alternate-buffer height differently by a
    // row or two. Keep the visible footer broadly clickable.
    const { cols, rows } = size();
    if (y >= rows - 4) {
      if (x < cols / 2 + 8) this.next();
      else this.settings();
    }
  }
}

// ---------- test screen ----------

interface BarSegment {
  label: string;
  id: string;
  active: boolean;
}

export class TestScreen implements Screen {
  engine: Engine | null = null;
  private clicks = new ClickMap();

  constructor(private app: App) {}

  async init(): Promise<void> {
    this.engine = await Engine.create(this.app.cfg);
    this.render();
  }

  private layout(width: number): Array<{ start: number; end: number }> {
    const eng = this.engine!;
    const lines: Array<{ start: number; end: number }> = [];
    let lineStart = 0;
    let len = 0;
    for (let i = 0; i < eng.words.length; i++) {
      const wl = [...eng.words[i]!].length;
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
    this.clicks = new ClickMap();

    centerRow(f, 1, p.main(BOLD + "monkey") + p.text(BOLD + "type") + p.sub(" cli"));

    // clickable config bar
    const barStart = this.renderConfigBar(f, 2);

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

    // words area
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

    // notice (e.g. after signing in)
    const notice = this.app.peekNotice();
    if (notice) centerRow(f, rows - 4, p.main(notice));

    centerRow(f, rows - 2, p.sub("tab restart  esc settings  ctrl+c quit"));
    f.flush();
  }

  /** Renders the config bar centered; registers click regions. Returns start col. */
  private renderConfigBar(f: Frame, row: number): number {
    const p = this.app.p;
    const cfg = this.app.cfg;
    const { cols } = size();

    const segs: BarSegment[] = [
      { label: "@ punctuation", id: "punctuation", active: cfg.punctuation },
      { label: "# numbers", id: "numbers", active: cfg.numbers },
      { label: "|", id: "", active: false },
      { label: "time", id: "time", active: cfg.mode === "time" },
      ...(cfg.mode === "time" ? [{ label: String(cfg.time), id: "time-value", active: true }] : []),
      { label: "words", id: "words", active: cfg.mode === "words" },
      ...(cfg.mode === "words" ? [{ label: String(cfg.words), id: "words-value", active: true }] : []),
      { label: "quote", id: "quote", active: cfg.mode === "quote" },
      { label: "zen", id: "zen", active: cfg.mode === "zen" },
      { label: "custom", id: "custom", active: cfg.mode === "custom" },
      { label: "|", id: "", active: false },
      { label: cfg.language.replace(/_/g, " "), id: "language", active: false },
    ];

    const gap = 2;
    const totalWidth = segs.reduce((n, s) => n + [...s.label].length, 0) + gap * (segs.length - 1);
    let col = Math.max(0, Math.floor((cols - totalWidth) / 2));
    f.set(row, " ".repeat(cols));
    for (const seg of segs) {
      const styled = seg.id === "" ? p.sub(seg.label) : seg.active ? p.main(seg.label) : p.sub(seg.label);
      f.put(row, col, styled);
      if (seg.id !== "") this.clicks.add(row, col, col + [...seg.label].length - 1, seg.id);
      col += [...seg.label].length + gap;
    }
    return col;
  }

  private handleBarClick(id: string): void {
    const cfg = this.app.cfg;
    const app = this.app;
    switch (id) {
      case "punctuation":
        cfg.punctuation = !cfg.punctuation;
        app.save(); void app.restart();
        break;
      case "numbers":
        cfg.numbers = !cfg.numbers;
        app.save(); void app.restart();
        break;
      case "time":
        if (cfg.mode !== "time") { cfg.mode = "time"; app.save(); void app.restart(); }
        else openTimePicker(app);
        break;
      case "time-value":
        openTimePicker(app);
        break;
      case "words":
        if (cfg.mode !== "words") { cfg.mode = "words"; app.save(); void app.restart(); }
        else openWordsPicker(app);
        break;
      case "words-value":
        openWordsPicker(app);
        break;
      case "quote":
        if (cfg.mode !== "quote") { cfg.mode = "quote"; app.save(); void app.restart(); }
        else openQuoteLengthPicker(app);
        break;
      case "zen":
        cfg.mode = "zen"; app.save(); void app.restart();
        break;
      case "custom":
        if (cfg.mode !== "custom") { cfg.mode = "custom"; app.save(); void app.restart(); }
        else openCustomTextInput(app);
        break;
      case "language":
        openLanguagePicker(app);
        break;
    }
  }

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
    for (let i = tChars.length; i < yChars.length; i++) {
      out += p.fgErrorExtra + yChars[i];
    }
    if (isCurrent) {
      const caretPos = yChars.length;
      const before = this.sliceAnsi(out, caretPos);
      const at = tChars[caretPos] ?? " ";
      out = before + INVERSE + p.fgCaret + at + RESET + p.bg + this.sliceAnsiFrom(out, caretPos + 1);
    }
    f.put(row, col, out);
    return Math.max(tChars.length, yChars.length);
  }

  private sliceAnsi(s: string, n: number): string {
    let vis = 0, i = 0, out = "";
    while (i < s.length && vis < n) {
      if (s[i] === "\x1b") {
        const m = ANSI_RE.exec(s.slice(i));
        if (m) { out += m[0]; i += m[0].length; continue; }
      }
      out += s[i]!; i++; vis++;
    }
    return out;
  }

  private sliceAnsiFrom(s: string, n: number): string {
    let vis = 0, i = 0;
    while (i < s.length) {
      if (vis >= n) break;
      if (s[i] === "\x1b") {
        const m = ANSI_RE.exec(s.slice(i));
        if (m) { i += m[0].length; continue; }
      }
      i++; vis++;
    }
    return s.slice(i);
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
        this.app.pushScreen(new ResultsScreen(this.app, eng.result(), eng));
      } else {
        this.render();
      }
    }
  }

  handleMouse(x: number, y: number, kind: MouseKind): void {
    if (kind !== "press") return;
    const id = this.clicks.hit(x, y);
    if (id) this.handleBarClick(id);
  }

  tick(): void {
    const eng = this.engine;
    if (!eng || eng.isFinished) return;
    if (eng.tick()) {
      this.app.pushScreen(new ResultsScreen(this.app, eng.result(), eng));
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
  private notice: string | null = null;
  private noticeShownAt = 0;

  constructor(public cfg: Config, private onSave: () => void) {
    this.theme = getTheme(cfg.theme);
    this.p = painter(this.theme);
  }

  applyTheme(): void {
    this.theme = getTheme(this.cfg.theme);
    this.p = painter(this.theme);
    write("\x1b[2J" + moveTo(1, 1));
    this.render();
  }

  save(): void {
    this.onSave();
  }

  notify(msg: string): void {
    this.notice = msg;
    this.noticeShownAt = Date.now();
    this.render();
  }

  /** Show notice without clearing (for test screen). */
  peekNotice(): string | null {
    if (this.notice && Date.now() - this.noticeShownAt < 5000) return this.notice;
    return null;
  }

  /** Show notice once then clear (for menus). */
  consumeNotice(): string | null {
    const n = this.peekNotice();
    if (n) this.notice = null;
    return n;
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

  render(): void {
    this.current?.render();
  }

  handleKey(key: Key): void {
    if (key.type === "mouse") {
      this.current?.handleMouse?.(key.x, key.y, key.kind);
      return;
    }
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
