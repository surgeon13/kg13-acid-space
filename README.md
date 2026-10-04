# kg13-acid-space

TB303 based synth emulator for web usage.

A small browser-based TB-303-style acid synth: mono synth engine (saw/square
oscillator, resonant filter with LP/HP/BP, full ADSR), a drum machine (kick,
clap, hats), a pattern generator with several acid-flavored styles and
scales, a 9-mode oscilloscope, a color theme toggle, per-knob automation
lanes, WAV export (up to 64 steps), and an 8/16-step sequencer — all
touch-friendly, all in one self-contained HTML file. No build step, no
dependencies beyond two Google Fonts loaded at runtime (Orbitron, Rajdhani).

## Files

```
kg13-acid-space/
├── index.html          the whole app — source of truth, single file
├── embed/
│   ├── snippet.html     copy-paste iframe embed code
│   └── example.html     full demo page showing it embedded in a mock site
└── README.md            this file
```

## Running it

Just open `index.html` in a browser, or serve the folder with any static
file server. It's fully self-contained — audio is synthesized live with the
Web Audio API, nothing is fetched except the two fonts.

## Features

- **Synth**: saw/square oscillator, resonant LP/HP/BP filter, full ADSR
  envelope (also modulates filter cutoff via DEPTH), drive/overdrive, tune,
  accent.
- **Drum machine**: kick, clap, hats, independently sequenced.
- **💨 Secret fart mode**: tap the 💨 button in the header to turn the machine into a
  Fart Machine — brown skin, no tempo or sequencer. Three TB-303-style oscillators
  (LOW / MID / HIGH), each with saw or square, cutoff, resonance, ADSR and a
  drawable pitch editor (±4 octaves). The oscillator is a "flapping" oscillator —
  a train of individual puffs with random timing, loudness and dropouts — shaped by
  shared Jitter / Shimmer / Sputter / Breath / Wobble / Squelch / Drive knobs. A small mixer
  (fader + mute per oscillator, plus master) sits above the oscillator panels. Hold a pad to sustain. 8 presets, 🎲 Surprise Me, toilet echo, and
  "save the last 12 seconds as WAV". Tap 💨 again to go back to acid.
- **MIDI export**: "Download MIDI" writes the current pattern as a .mid file
  (format 1: tempo track, acid line, drums on channel 10). Accents are louder notes,
  slides are overlapping legato notes, and enabled cutoff / reso / attack / release
  automation lanes are written as CC 74 / 71 / 73 / 72. Drag it into Ableton.
- **Pattern generator**: 6 styles (Classic 88, Rolling, Screamer, Minimal,
  Dubby, Chaos) × 5 scales (Phrygian, Minor, Minor Pentatonic, Harmonic
  Minor, Chromatic) — rule-based, not random noise: notes anchor to the root
  on strong beats, slides only occur between two live steps, accents weight
  toward the pulse.
- **Automation**: 10 knobs (tune, accent, freq, reso, mix, attack, decay,
  sustain, release, depth) can each hold a 16-step value lane, drawn by hand
  on a single shared graph. Drive and filter-type are intentionally left
  out — a WaveShaper curve can't be scheduled over time, so animating it
  wouldn't do anything per-step.
- **Oscilloscope**: 9 visualization modes (wave, mirror, filled, spectrum,
  blocks, radial, XY/Lissajous, waterfall, level meters).
- **WAV export**: renders the current pattern + automation to a downloadable
  16-bit WAV file, up to 64 steps. Uses a completely separate
  `OfflineAudioContext` graph mirroring the live signal path exactly, so the
  export sounds identical to what you hear live. Includes a normalize +
  soft-clip safety pass so extreme automation (e.g. resonance swept to its
  max) can't produce hard-clipped output.
- **Theme toggle**: 5 accent color palettes.
- **8/16-step toggle**: fewer steps = bigger touch targets on mobile.
- **Reset button**: restores every knob to default and clears all
  automation lanes.

## Embedding elsewhere (e.g. via iframe)

See `embed/snippet.html` for a copy-paste block, and `embed/example.html`
for a working demo of it inside a mock page. The app posts its content
height to the parent window on load and on change
(`postMessage({type:'acid-machine:height', ...})`), and the snippet's
listener script resizes the iframe to match — no inner scrollbar, and it
keeps working as the app's content grows in future updates.

If the embedding page sends a `Content-Security-Policy` header, make sure
`font-src` allows `fonts.gstatic.com` and `style-src` allows
`fonts.googleapis.com` — or ask for a self-hosted-fonts version instead.
