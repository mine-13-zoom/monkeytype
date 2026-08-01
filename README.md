# monkeytypecli

A [monkeytype](https://monkeytype.com) clone for the terminal, written in TypeScript for [Bun](https://bun.sh). Zero runtime dependencies — raw ANSI, truecolor themes.

Themes, languages, quotes and test logic are ported directly from the official
[monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype) repo.

## Features

- **All 187 official themes** (serika_dark, dracula, catppuccin, 8008, …) rendered in truecolor
- **All test modes**: `time` (15/30/60/120/custom), `words` (10/25/50/100/custom), `quote` (short/medium/long/thicc/all), `zen`, `custom` (with word/time limits)
- **446 language word lists** and **87 quote languages** from the official data
- **Punctuation & numbers** modes, following monkeytype's `words-generator.ts` rules
- **Monkeytype-accurate stats**: wpm, raw wpm, accuracy, consistency (kogasa formula), char stats (correct/incorrect/extra/missed)
- Results screen with a per-second wpm sparkline chart
- Searchable pickers for themes/languages, persistent config at `~/.config/monkeytypecli/config.json`

## Run

```sh
bun run src/index.ts
# or
bun start
```

### CLI flags

```sh
bun run src/index.ts --mode time --time 60 --theme dracula --punctuation --numbers
bun run src/index.ts --list-themes
bun run src/index.ts --list-languages
```

Flags override your saved config (and become the new saved defaults).

## Keys

| key | action |
| --- | --- |
| type | take the test |
| `tab` | restart test |
| `esc` | settings menu (theme / language / mode / …) |
| `enter` | next test (on results) / finish (in zen) |
| `backspace` | correct mistakes (can return to an incorrect previous word) |
| `ctrl+backspace` | delete word |
| `ctrl+c` | quit |

In pickers: type to filter, `↑`/`↓` to move, `enter` to select.

## Project layout

```
src/
  index.ts      entry, CLI flags
  term.ts       raw-mode input parsing + ANSI helpers
  theme.ts      187 themes (extracted from monkeytype's themes.ts)
  data.ts       language word lists + quotes loading
  config.ts     persistent user config
  generator.ts  word/quote generation (port of words-generator.ts)
  engine.ts     test state machine + stats (port of test-logic.ts math)
  ui.ts         screens: test, settings menu, pickers, results
data/           themes.json, languages/, quotes/ (from monkeytype frontend/static)
scripts/        extract-themes.ts (re-extract themes from a monkeytype checkout)
```

## Roadmap

- account auth + result syncing with monkeytype.com
- funbox modes, custom themes, tape mode
