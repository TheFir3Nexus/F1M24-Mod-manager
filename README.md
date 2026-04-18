# F1M24 Mod Manager
### THEFIRENEXUS PACK

A desktop mod manager for F1 Manager 2024.

---

## Requirements

- [Node.js](https://nodejs.org/) v18 or newer
- Windows 10/11

---

## Setup & Run

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode
npm start
```

---

## Build a .exe installer

```bash
npm run build
```

Output goes to `dist/` — produces a Windows NSIS installer.

You'll need an `assets/icon.ico` file for the build step.
To skip the icon requirement temporarily, remove the `"icon"` line from `package.json`.

---

## Features

### PAK Mods tab
- Lists all `.zip` files in `C:\F1M24 Mod Manager` that contain `.pak` / `.ucas` / `.utoc`
- Shows installed PAK mods in `<GameDir>\F1Manager24\Content\Paks`
- Install copies the three files; Delete removes all three

### UE4SS / Lua tab
- Lists all `.zip` files that contain `.lua` files
- Shows installed mod folders in `<GameDir>\F1Manager24\Binaries\Win64\ue4ss\Mods`
- Install extracts the folder; Delete removes it

### Browse Overtake tab
- Opens Overtake.gg in a hidden Chromium window and reads the mod listings
- Filter by type, search by name
- "Save to repo" pre-fills the download URL — go to Settings and hit Download

### Settings
- Set your game directory (saved across sessions)
- Paste a direct `.zip` URL to download to `C:\F1M24 Mod Manager`

---

## File detection logic

| Files in zip | Type |
|---|---|
| `.pak` / `.ucas` / `.utoc` | PAK mod |
| `.lua` | Lua / UE4SS mod |
| Neither | Unknown (shown but not installable to a specific folder) |

---

## Directory structure

```
C:\F1M24 Mod Manager\          ← repository (downloaded zips)

<GameDir>\
  F1Manager24\
    Content\Paks\              ← PAK mods go here
    Binaries\Win64\ue4ss\Mods\ ← Lua mods go here
```
