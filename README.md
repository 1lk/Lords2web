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

1. Open the page. The first time, it downloads the demo installer (7.5 MB) from the Internet Archive item
   [*LordsoftheRealmII_1020*](https://archive.org/details/LordsoftheRealmII_1020) into your browser, checks it, unpacks it
   and keeps a copy in the browser's local storage, so the download happens once. Nothing is uploaded anywhere.
2. Tap **Play**.

If the download is not possible (you are offline, or the Internet Archive does not let the page read the file), the page
says so and shows a file picker instead: download `lorddemo.zip` from the item's page and choose it. (The `lorddemo.exe`
inside it works too.) **Use a file of my own instead** does the same at any time, and `?nofetch` on the page address skips
the download.

## Where the game data comes from

This repository contains the recompiled program logic and the page, and none of the game's data: no graphics, sound, maps
or text. Those are in the demo installer, which your browser fetches from the Internet Archive when you open the page.

A page may read another site's files only if that site allows it (CORS). The Internet Archive's ordinary file links do
not, but a file inside a zip is served by a part of the site that does. So `loader.js` asks, in this order: for
`lorddemo.exe` inside `lorddemo.zip` through archive.org's own address; for the same file straight from the data server
named by the item's metadata; and for the whole zip. It takes the first answer that looks like the installer.

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
* The download from the Internet Archive was tested against a stand-in for it, not against archive.org itself. If the real
  site refuses cross-origin reads, the file picker is the way in.

## Rights

This is an unofficial fan project. It is not affiliated with or endorsed by Sierra, Impressions Games or any owner of
the game's rights.

`lords2.wasm` is a translation of the demo's original program (`LORDS2.EXE`) and is derived from it. This repository
contains none of the game's data: no graphics, sound, maps or text. Those come from the demo installer, which the page fetches from the Internet Archive (or which you supply). If you
hold rights to the game and have a concern about this project, please contact the repository owner.

The page itself (HTML, CSS, JavaScript, icons) is original work.

## Files

| File | |
| --- | --- |
| `index.html`, `style.css`, `main.js` | Page, layout, touch / mouse / keyboard input |
| `runtime.js` | Loads the wasm, feeds it the game files, paints the 8-bit screen, mixes audio |
| `loader.js` | Downloads the installer from the Internet Archive, reads it in the browser (nested PKZIP self-extractors), builds the program image, saved games |
| `lords2.wasm` | The recompiled game plus the Windows/DirectX layer |
| `sw.js`, `manifest.webmanifest`, icons | Offline copy and "install to home screen" |
