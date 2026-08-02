// monkeytype — a monkeytype clone for the terminal.
import { startTerminal, stopTerminal, type Key } from "./term";
import { loadConfig, saveConfig, type Config, type Mode } from "./config";
import { App, TestScreen } from "./ui";
import { themeNames } from "./theme";
import { baseLanguageNames } from "./data";

function printHelp(): void {
  console.log(`monkeytype — a monkeytype clone for the terminal

usage: monkeytype [options]

options:
  -m, --mode <mode>        time | words | quote | zen | custom
  -t, --time <seconds>     time mode duration (15/30/60/120/…)
  -w, --words <count>      words mode count (10/25/50/100/…)
  --theme <name>           theme name (e.g. serika_dark, dracula)
  --language <name>        language (e.g. english, german_1k)
  --punctuation            enable punctuation
  --numbers                enable numbers
  --list-themes            print all theme names
  --list-languages         print all language names
  -h, --help               show this help

keys during a test:
  tab      restart test
  esc      settings menu (theme, language, mode, …)
  ctrl+c   quit
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--list-themes")) {
    console.log(themeNames.join("\n"));
    return;
  }
  if (args.includes("--list-languages")) {
    console.log(baseLanguageNames().join("\n"));
    return;
  }
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  const cfg: Config = await loadConfig();

  const flag = (names: string[]): string | undefined => {
    for (const n of names) {
      const i = args.indexOf(n);
      if (i >= 0 && i + 1 < args.length) return args[i + 1];
    }
    return undefined;
  };

  const mode = flag(["-m", "--mode"]);
  if (mode && ["time", "words", "quote", "zen", "custom"].includes(mode)) cfg.mode = mode as Mode;
  const time = flag(["-t", "--time"]);
  if (time && /^\d+$/.test(time)) { cfg.time = +time; cfg.mode = "time"; }
  const words = flag(["-w", "--words"]);
  if (words && /^\d+$/.test(words)) { cfg.words = +words; cfg.mode = "words"; }
  const theme = flag(["--theme"]);
  if (theme && themeNames.includes(theme)) cfg.theme = theme;
  const lang = flag(["--language"]);
  if (lang) cfg.language = lang;
  if (args.includes("--punctuation")) cfg.punctuation = true;
  if (args.includes("--numbers")) cfg.numbers = true;

  if (!process.stdin.isTTY) {
    console.error("monkeytype needs an interactive terminal");
    process.exit(1);
  }

  const app = new App(cfg, () => void saveConfig(cfg));

  startTerminal({
    onKey: (key: Key) => {
      if (key.type === "ctrl_c") {
        shutdown();
        return;
      }
      app.handleKey(key);
    },
    onResize: () => app.render(),
  });

  const ts = new TestScreen(app);
  app.setRoot(ts);
  await ts.init();
  app.startTimer();

  function shutdown(): void {
    app.stopTimer();
    stopTerminal();
    void saveConfig(cfg).finally(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
