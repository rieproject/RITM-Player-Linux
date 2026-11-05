# RITM Player — Basic Version

A player for `.ritm` music releases and plain audio files, made by **rieproject.id | Arie Jakawiguna**.

🇮🇩 [Baca dalam Bahasa Indonesia](README.md)

This repository contains the **basic version** of RITM Player for GitHub. It is the core player without the advanced features. For the latest version, installers, and the web version, visit:

**https://ritm.rieproject.id/**

---

## Differences from the full version

This basic version is intentionally trimmed. The following features are **not** included:

- Audio settings: output device selection, exclusive / shared mode, buffer, resampler, dither, listening profile, Peak Guard, and the signal path info. Playback uses the audio engine automatically.
- Online lyrics search (LRCLIB). Lyrics are read only from `.lrc` files next to the audio and from `.ritm` releases.
- Lyric romanization for Japanese, Korean, and Chinese lyrics.

Everything else is still included. See [Features](#features).

---

## Features

**Opening music**
- Open `.ritm` releases and plain audio files: MP3, WAV, FLAC, OGG, M4A, AAC.
- Open a folder as a playlist. Metadata is read per file, and files without tags show their file name.
- Drag a file into the window, or press Ctrl+O. To play a folder, use the Open menu in the header.
- On Windows, `.ritm` files can be opened directly from Explorer.

**Catalogue**
- A list of recently opened releases. A release that is still playing stays listed until playback stops.
- The X button removes a release from the list. If that release is playing, the main screen is cleared after you press Stop.
- "Show in folder" opens the file's location in Explorer.

**Playback and display**
- Synced lyrics. Click a line to jump to its time. Lyrics appear in the center, and the other visuals fade while they are on.
- Booklet pages for `.ritm` releases (up to 5 pages) and a background photo gallery that changes while the music plays.
- Background animations that react to the music, following the preset in the release.
- Karaoke (instrumental) version when the release provides one.
- Integrity status of `.ritm` releases: verified, or unsigned.
- Full screen with the header button or F11.
- Light and dark themes, and two languages: Indonesian and English.

**Playback on Windows**
- The native engine (WASAPI) is used automatically when available, with exclusive-mode bit-perfect output.
- If the native engine cannot play a file, playback automatically switches to Web Audio and resumes from the same position.

---

## Architecture

This repository is a monorepo with two packages:

```
ritm-player/        Shared package (@ritm/player)
  src/format/       .ritm format: archive reader, integrity check, Ed25519 signatures, audio descrambling, LRC parser
  src/engine/       Media loading and the Web Audio engine
  src/components/   Player components: PlayerStage, LyricsView, BookletModal, TrackBackdrop, MoodCanvas, etc.
  src/i18n/         Indonesian and English text

ritm-desktop/       RITM Player application
  electron/         Electron main process: window, file dialogs, library, reading of permitted files only
  electron/preload  IPC bridge (contextIsolation and sandbox enabled)
  native/           Native audio engine (ritm-audio.exe, WASAPI) and Explorer thumbnail provider (ritm_thumb.dll)
  src/              React UI: App, Library (Catalogue), TrackList, IntroAnimation
  public/           PWA assets for the web version: manifest, service worker, icons
```

**Technology**
- Electron for the Windows app, with electron-builder for NSIS installer and portable builds.
- React 19, Vite 6, and Tailwind CSS 4.
- TypeScript in both packages.
- `.ritm` format v1: a ZIP archive containing `manifest.json`, `integrity.json` (SHA-256 per file), and `signature.json` (Ed25519). Audio inside the archive is scrambled with the xor-v1 scheme.
- The web version is built from the same source with `build:web`, and includes a manifest and service worker so it can be installed as an app on a phone.

**Playback flow on desktop**
1. The renderer requests a file over IPC. The main process only reads files the user has previously chosen.
2. `ritm-player` parses the release and checks its integrity.
3. If the native engine is available and the file has a location on disk, `ritm-audio.exe` plays the audio. Otherwise Web Audio plays it.

---

## Building from source

Requirements: Node.js 22.5 or newer, and Windows 10/11 x64 for the desktop app.

```bash
npm install

# run the desktop app from source
npm run start:desktop

# Windows app without installer (folder ritm-desktop/release/win-unpacked)
npm run dist:desktop:dir

# NSIS installer and portable build (folder ritm-desktop/release)
npm run dist:desktop

# web version (folder ritm-desktop/release-web)
npm run build:web
```

To test the web version, serve the folder with any static server, for example `npx serve ritm-desktop/release-web`.

---

## Latest version and installers

To download the latest version, installers, or to use the web version, go to:

**https://ritm.rieproject.id/**

---

## Copyright

© rieproject.id | Arie Jakawiguna
