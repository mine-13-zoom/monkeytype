// Persistent user configuration, stored at $XDG_CONFIG_HOME/monkeytypecli/config.json

export type Mode = "time" | "words" | "quote" | "zen" | "custom";
export type QuoteLength = "short" | "medium" | "long" | "thicc" | "all";
export type CustomLimit = "none" | "words" | "time";

export interface Config {
  theme: string;
  language: string;
  mode: Mode;
  time: number; // seconds for time mode
  words: number; // count for words mode
  quoteLength: QuoteLength;
  punctuation: boolean;
  numbers: boolean;
  customText: string;
  customLimit: CustomLimit;
  customLimitValue: number;
  liveWpm: boolean;
}

export const defaultConfig: Config = {
  theme: "serika_dark",
  language: "english",
  mode: "time",
  time: 30,
  words: 25,
  quoteLength: "all",
  punctuation: false,
  numbers: false,
  customText: "the quick brown fox jumps over the lazy dog",
  customLimit: "none",
  customLimitValue: 50,
  liveWpm: true,
};

function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? process.env.HOME + "/.config";
  return xdg + "/monkeytypecli/config.json";
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await Bun.file(configPath()).json();
    return { ...defaultConfig, ...raw };
  } catch {
    return { ...defaultConfig };
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  try {
    const path = configPath();
    await Bun.$`mkdir -p ${path.slice(0, path.lastIndexOf("/"))}`.quiet();
    await Bun.write(path, JSON.stringify(cfg, null, 2));
  } catch {
    // non-fatal
  }
}
