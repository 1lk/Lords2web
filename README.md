# Lords of the Realm II (demo): WebAssembly port

An unofficial port of the 1996 Windows demo of *Lords of the Realm II* that runs in a web browser, with a portrait phone
layout and touch controls.

It is not a wrapper and not an emulator. The game's x86 code was translated ahead of time to C and compiled to
WebAssembly. No CPU emulator and no DOSBox run at any point. The Windows and DirectX calls the game makes are provided by
a small re-implementation written for this port.

## Play

If GitHub Pages is switched on for this repository, the game is at <https://1lk.github.io/Lords2web/>. The files also
work on any static host that serves them over HTTPS (or from `http://localhost`); `file://` does not work, because the page
uses ES modules, WebAssembly and IndexedDB.

1. Open the page and give it your own copy of the demo installer, `lorddemo.exe` (7.5 MB; the Internet Archive item
   *LordsoftheRealmII_1020* offers it). The page checks it, unpacks it in your browser and keeps a copy in the browser's
   local storage, so the file is asked for once. Nothing is uploaded.
2. Tap **Play**.

## Controls

| On a phone / tablet | Does |
| --- | --- |
| Tap | Left click |
| Hold a finger (0.65 s) | Right click. A magnifier shows where the pointer is while you aim. |
| Two-finger tap | Right click |
| **Info** button, then tap | Right click on the next tap |
| Drag | Left-button drag |
| Pinch / two-finger drag | Zoom and pan the picture |
| **Zoom** button | Cycles three zoom levels |
| Pad (bottom left) | Scrolls the campaign map in eight directions |
| **Keys** button | Soft keyboard plus a strip with Home, End, arrows, Del, Backspace, Clear and Enter |

The game's information popup (right click) closes only on another right click. A plain tap closes it for you. The
tutorial hint balloons at the start of a game also close when you tap.

On a computer: left and right mouse buttons, arrow keys or the window edge to scroll, ordinary typing.

The game's text boxes (a save name, the player name) overwrite instead of inserting, as in the original. Use **Clear** on
the key strip to empty a box first.

## Known limits

* Only the demo is supported. Another version of the game would need to go through the translator again and may call
  Windows functions this runtime does not provide.
* "Head to Head" (linked two-player game) needs a network or serial connection. The game shows its connection dialog, the
  port cancels it, and you are back on the setup screen.
* The demo ends after 24 game turns ("More to Come!").
* iPhone and iPad: the ring/silent switch mutes web audio. Turn it off to hear the music.
* Tested in desktop Chromium with real touch events and a mouse. Not yet tested on real phones.

## Rights

This is an unofficial fan project. It is not affiliated with or endorsed by Sierra, Impressions Games or any owner of
the game's rights.

`lords2.wasm` is a translation of the demo's original program (`LORDS2.EXE`) and is derived from it. This repository
contains none of the game's data: no graphics, sound, maps or text. Those come from the demo installer you supply. If you
hold rights to the game and have a concern about this project, please contact the repository owner.

The page itself (HTML, CSS, JavaScript, icons) is original work.

## Files

| File | |
| --- | --- |
| `index.html`, `style.css`, `main.js` | Page, layout, touch / mouse / keyboard input |
| `runtime.js` | Loads the wasm, feeds it the game files, paints the 8-bit screen, mixes audio |
| `loader.js` | Reads the installer in the browser (nested PKZIP self-extractors), builds the program image, saved games |
| `lords2.wasm` | The recompiled game plus the Windows/DirectX layer |
| `sw.js`, `manifest.webmanifest`, icons | Offline copy and "install to home screen" |
