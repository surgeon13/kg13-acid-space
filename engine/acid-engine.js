/* acid-engine.js - the Acid Machine's sound engine without its interface.
 *
 * A TB-303 style bass line and a TR-909 style drum kit on one 16-step
 * sequencer, all synthesized live with the Web Audio API (no samples).
 * The 303 voice, its envelopes and the pattern generator are the same as in
 * ../index.html; the 909 kit (kick, snare, clap, closed and open hat, rim)
 * is new. Embedders build their own controls on top (Nevet's farm uses it
 * for the party-mode synth).
 *
 *   var eng = AcidEngine.create({ bpm: 128 });
 *   eng.onStep = function (info) { ... };      // every 16th as it is heard
 *   eng.start();                               // call from a tap: browsers need a gesture for sound
 *   eng.acid[3].active = true;                 // edit the pattern any time
 *   eng.set303('cutoff', 900); eng.setBpm(135); eng.generate('rolling');
 *
 * Plain ES5, no dependencies, one global: window.AcidEngine.
 */
(function (root) {
  'use strict';

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var ROOT_FREQ = 55;                    // A1, as in the Acid Machine
  var SCALES = {
    phrygian: [0, 1, 3, 5, 7, 8, 10], minor: [0, 2, 3, 5, 7, 8, 10], minorPent: [0, 3, 5, 7, 10],
    harmMinor: [0, 2, 3, 5, 7, 8, 11], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  };
  // style presets bias the generator (same flavours as the Acid Machine)
  var STYLES = {
    classic: { density: 0.62, slides: 0.30, accents: 0.25, octjump: 0.20, rootPull: 0.55, maxRest: 3, stepBias: 'even' },
    rolling: { density: 0.95, slides: 0.45, accents: 0.30, octjump: 0.15, rootPull: 0.40, maxRest: 2, stepBias: 'rolling' },
    hoover: { density: 0.70, slides: 0.55, accents: 0.45, octjump: 0.45, rootPull: 0.30, maxRest: 3, stepBias: 'wide' },
    minimal: { density: 0.35, slides: 0.20, accents: 0.20, octjump: 0.10, rootPull: 0.70, maxRest: 6, stepBias: 'sparse' },
    dub: { density: 0.45, slides: 0.60, accents: 0.15, octjump: 0.25, rootPull: 0.60, maxRest: 5, stepBias: 'offbeat' },
    chaos: { density: 0.75, slides: 0.40, accents: 0.40, octjump: 0.60, rootPull: 0.15, maxRest: 3, stepBias: 'wide' }
  };
  var DRUMS = ['bd', 'sd', 'cp', 'ch', 'oh', 'rs'];
  var DRUM_NAMES = { bd: 'Kick', sd: 'Snare', cp: 'Clap', ch: 'Closed hat', oh: 'Open hat', rs: 'Rim' };
  var P303_RANGES = {
    cutoff: [60, 6000], reso: [0.5, 28], decay: [0.03, 0.8], accent: [0, 1.5], drive: [0, 1],
    depth: [0, 1.5], tune: [-12, 12], attack: [0.001, 0.2], sustain: [0, 1], release: [0.005, 0.4]
  };

  function chance(p) { return Math.random() < p; }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function makeDriveCurve(amount) {      // gentle tanh saturation (from the Acid Machine)
    var k = 1 + amount * 7, n = 1024, curve = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * k) / Math.tanh(k); }
    return curve;
  }
  function stepWeight(i, bias) {
    var onBeat = i % 4 === 0, offBeat = i % 4 === 2, sixteenth = i % 2 === 1;
    if (bias === 'sparse') return onBeat ? 1.0 : (offBeat ? 0.30 : 0.08);
    if (bias === 'offbeat') return onBeat ? 0.7 : (offBeat ? 1.0 : 0.28);
    if (bias === 'wide') return onBeat ? 1.0 : (offBeat ? 0.75 : 0.60);
    if (bias === 'rolling') return onBeat ? 1.0 : (offBeat ? 0.95 : 0.90);
    return onBeat ? 1.0 : (offBeat ? 0.65 : sixteenth ? 0.45 : 0.55);
  }
  function emptyStep() { return { active: false, degreeIndex: 0, accent: false, slide: false, octave: 0 }; }
  function presetAcid() {                 // the Acid Machine's opening line
    var p = [[0, 1, 0], [null], [1, 0, 1], [0, 0, 0], [null], [2, 0, 1], [0, 0, 0], [null],
             [0, 1, 0], [null], [1, 0, 0], [0, 0, 1], [null], [4, 0, 0], [0, 0, 1], [null]];
    return p.map(function (s) { return { active: s[0] !== null, degreeIndex: s[0] || 0, accent: !!s[1], slide: !!s[2], octave: 0 }; });
  }
  function row(on) { var r = []; for (var i = 0; i < 16; i++) r.push(on.indexOf(i) >= 0); return r; }

  function create(opts) {
    opts = opts || {};
    var eng = {
      bpm: opts.bpm || 128,
      swing: 0,                                         // 0 .. 0.6: how late the off 16ths are
      steps: 16,
      scale: 'phrygian',
      degrees: SCALES.phrygian.concat([12]),
      acid: presetAcid(),
      p303: { wave: 'sawtooth', cutoff: 420, reso: 12, decay: 0.22, accent: 0.6, drive: 0.22, depth: 0.7, tune: 0,
              attack: 0.004, sustain: 0.15, release: 0.08 },
      drums: { bd: row([0, 4, 8, 12]), sd: row([4, 12]), cp: row([]), ch: row([2, 6, 10, 14]), oh: row([]), rs: row([]) },
      p909: { level: { bd: 1, sd: 0.8, cp: 0.8, ch: 0.6, oh: 0.6, rs: 0.6 }, tune: { bd: 0, sd: 0, cp: 0, ch: 0, oh: 0, rs: 0 },
              decay: { bd: 0.5, sd: 0.5, cp: 0.5, ch: 0.5, oh: 0.5, rs: 0.5 } },
      mute: { tb303: false, tr909: false },
      volume: { tb303: 0.8, tr909: 0.9 },
      playing: false, step: 0,
      onStep: null, onTransport: null,
      ctx: null, analyser: null
    };
    var ctx = null, master, bus303, bus909, voice, noise, timer = null, nextT = 0, prevActive = false, ohGain = null;

    function init() {
      if (ctx) return;
      var AC = root.AudioContext || root.webkitAudioContext;
      ctx = eng.ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.6;
      var lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -8; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.001; lim.release.value = 0.25;
      eng.analyser = ctx.createAnalyser(); eng.analyser.fftSize = 512;
      master.connect(lim); lim.connect(eng.analyser); lim.connect(ctx.destination);
      bus303 = ctx.createGain(); bus909 = ctx.createGain();
      bus303.connect(master); bus909.connect(master);
      applyMix();
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var d = noise.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // the 303 voice: osc -> drive -> resonant low-pass -> amp (drive before the filter, as in the Acid Machine)
      var p = eng.p303, osc = ctx.createOscillator(), pre = ctx.createGain(), shaper = ctx.createWaveShaper(),
          filt = ctx.createBiquadFilter(), amp = ctx.createGain();
      osc.type = p.wave; filt.type = 'lowpass'; filt.frequency.value = p.cutoff; filt.Q.value = p.reso;
      pre.gain.value = 1 + p.drive * 3; shaper.curve = makeDriveCurve(p.drive); shaper.oversample = '2x'; amp.gain.value = 0;
      osc.connect(pre); pre.connect(shaper); shaper.connect(filt); filt.connect(amp); amp.connect(bus303);
      osc.start();
      voice = { osc: osc, pre: pre, shaper: shaper, filt: filt, amp: amp };
    }
    function applyMix() {
      if (!ctx) return;
      bus303.gain.setTargetAtTime(eng.mute.tb303 ? 0 : eng.volume.tb303, ctx.currentTime, 0.02);
      bus909.gain.setTargetAtTime(eng.mute.tr909 ? 0 : eng.volume.tr909, ctx.currentTime, 0.02);
    }
    function stepDur() { return 60 / eng.bpm / 4; }

    // ---- TB-303 (envelopes scaled to fit the step, from the Acid Machine)
    function envelope(param, base, peakDelta, t, dur, accented) {
      var p = eng.p303, a = Math.max(p.attack, 0.001), d = Math.max(p.decay, 0.005), r = Math.max(p.release, 0.005), s = p.sustain;
      var len = dur * 0.98, minS = len * 0.06;
      a = Math.min(a, len * 0.4);
      var room = len - a - minS;
      if (d + r > room) { var k = room / (d + r); d *= k; r *= k; }
      var peak = base + peakDelta * (accented ? 1 + p.accent : 1), sus = base + (peak - base) * s;
      var tA = t + a, tD = tA + d, tR = Math.max(tD, t + len - r);
      param.cancelScheduledValues(t); param.setValueAtTime(base, t);
      param.linearRampToValueAtTime(peak, tA); param.linearRampToValueAtTime(sus, tD);
      param.setValueAtTime(sus, tR); param.linearRampToValueAtTime(base, tR + r);
    }
    function freqOf(s) { return ROOT_FREQ * Math.pow(2, (eng.p303.tune + eng.degrees[s.degreeIndex % eng.degrees.length] + 12 * s.octave) / 12); }
    function play303(i, t) {
      var s = eng.acid[i];
      if (!s.active) { prevActive = false; return; }
      var f = freqOf(s);
      voice.osc.frequency.cancelScheduledValues(t);
      if (s.slide && prevActive) voice.osc.frequency.setTargetAtTime(f, t, 0.055);
      else {
        voice.osc.frequency.setValueAtTime(f, t);
        envelope(voice.amp.gain, 0, 0.9, t, stepDur(), s.accent);
        envelope(voice.filt.frequency, eng.p303.cutoff, eng.p303.depth * 4000, t, stepDur(), s.accent);
      }
      prevActive = true;
    }

    // ---- TR-909 (synthesized)
    function out(level, t) { var g = ctx.createGain(); g.gain.value = level; g.connect(bus909); return g; }
    function noiseSrc(t, len) { var n = ctx.createBufferSource(); n.buffer = noise; n.start(t); n.stop(t + len); return n; }
    var KIT = {
      bd: function (t, lv, tu, dc) {             // pitch-swept sine with a click
        var o = ctx.createOscillator(), g = ctx.createGain(), len = 0.25 + dc * 0.5, f0 = 60 * Math.pow(2, tu / 12);
        o.type = 'sine'; o.frequency.setValueAtTime(f0 * 4.2, t); o.frequency.exponentialRampToValueAtTime(f0, t + 0.07);
        g.gain.setValueAtTime(1.4 * lv, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
        o.connect(g).connect(bus909); o.start(t); o.stop(t + len + 0.02);
        var c = noiseSrc(t, 0.012), hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
        c.connect(hp).connect(out(0.35 * lv, t));
      },
      sd: function (t, lv, tu, dc) {             // two tones + a snappy noise burst
        var len = 0.12 + dc * 0.25;
        [180, 330].forEach(function (f, k) {
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'triangle'; o.frequency.setValueAtTime(f * Math.pow(2, tu / 12) * 1.4, t); o.frequency.exponentialRampToValueAtTime(f * Math.pow(2, tu / 12), t + 0.03);
          g.gain.setValueAtTime((k ? 0.35 : 0.55) * lv, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1 + dc * 0.08);
          o.connect(g).connect(bus909); o.start(t); o.stop(t + 0.25);
        });
        var n = noiseSrc(t, len + 0.02), hp = ctx.createBiquadFilter(), g2 = ctx.createGain();
        hp.type = 'highpass'; hp.frequency.value = 1500;
        g2.gain.setValueAtTime(0.7 * lv, t); g2.gain.exponentialRampToValueAtTime(0.001, t + len);
        n.connect(hp).connect(g2).connect(bus909);
      },
      cp: function (t, lv, tu, dc) {             // a few quick bursts, then the tail (as in the Acid Machine)
        [0, 0.01, 0.02, 0.032].forEach(function (off, k) {
          var n = noiseSrc(t + off, 0.3), bp = ctx.createBiquadFilter(), g = ctx.createGain(), len = k === 3 ? 0.12 + dc * 0.25 : 0.03;
          bp.type = 'bandpass'; bp.frequency.value = 1200 * Math.pow(2, tu / 12); bp.Q.value = 1.4;
          g.gain.setValueAtTime(0.9 * lv, t + off); g.gain.exponentialRampToValueAtTime(0.001, t + off + len);
          n.connect(bp).connect(g).connect(bus909);
        });
      },
      ch: function (t, lv, tu, dc) { hat(t, lv, tu, 0.03 + dc * 0.06, false); },
      oh: function (t, lv, tu, dc) { hat(t, lv, tu, 0.18 + dc * 0.45, true); },
      rs: function (t, lv, tu, dc) {             // rim: a short high click
        var o = ctx.createOscillator(), g = ctx.createGain(), bp = ctx.createBiquadFilter();
        o.type = 'triangle'; o.frequency.value = 1700 * Math.pow(2, tu / 12);
        bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 3;
        g.gain.setValueAtTime(0.9 * lv, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.03 + dc * 0.04);
        o.connect(bp).connect(g).connect(bus909); o.start(t); o.stop(t + 0.12);
      }
    };
    function hat(t, lv, tu, len, open) {         // six square partials through a band-pass: the metal shimmer
      var g = ctx.createGain(), bp = ctx.createBiquadFilter(), hp = ctx.createBiquadFilter(), k = Math.pow(2, tu / 12);
      bp.type = 'bandpass'; bp.frequency.value = 10000 * k; bp.Q.value = 0.8; hp.type = 'highpass'; hp.frequency.value = 7000;
      g.gain.setValueAtTime(0.32 * lv, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      [263, 400, 421, 474, 587, 845].forEach(function (f) {
        var o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f * 1.9 * k;
        o.connect(bp); o.start(t); o.stop(t + len + 0.02);
      });
      bp.connect(hp).connect(g).connect(bus909);
      if (open) ohGain = g;
      else if (ohGain) { ohGain.gain.cancelScheduledValues(t); ohGain.gain.setTargetAtTime(0.0001, t, 0.01); ohGain = null; }   // closed chokes open
    }
    function play909(i, t) {
      var p = eng.p909;
      DRUMS.forEach(function (d) { if (eng.drums[d][i]) KIT[d](t, p.level[d], p.tune[d], p.decay[d]); });
    }

    // ---- the sequencer: schedule a little ahead, tell the page when each step is heard
    function info(i) {
      var s = eng.acid[i], d = {};
      DRUMS.forEach(function (k) { d[k] = !!eng.drums[k][i]; });
      return { step: i, steps: eng.steps, bpm: eng.bpm, note: s.active ? eng.noteName(i) : null,
               accent: s.active && s.accent, slide: s.active && s.slide, drums: d,
               kick: d.bd && !eng.mute.tr909, clap: (d.cp || d.sd) && !eng.mute.tr909, hat: (d.ch || d.oh) && !eng.mute.tr909,
               cutoff: eng.p303.cutoff, reso: eng.p303.reso, mute: { tb303: eng.mute.tb303, tr909: eng.mute.tr909 } };
    }
    function tick() {
      while (nextT < ctx.currentTime + 0.12) {
        var i = eng.step, t = nextT + (i % 2 ? eng.swing * stepDur() * 0.5 : 0);
        play303(i, t); play909(i, t);
        (function (i, t) {
          setTimeout(function () { if (eng.playing && eng.onStep) eng.onStep(info(i)); }, Math.max(0, (t - ctx.currentTime) * 1000));
        })(i, t);
        nextT += stepDur();
        eng.step = (i + 1) % eng.steps;
      }
    }
    function transport() { if (eng.onTransport) eng.onTransport({ playing: eng.playing, bpm: eng.bpm }); }

    eng.start = function () {
      init();
      if (ctx.state === 'suspended') ctx.resume();
      if (eng.playing) return;
      eng.playing = true; eng.step = 0; prevActive = false; nextT = ctx.currentTime + 0.06;
      timer = setInterval(tick, 25); tick();
      transport();
    };
    eng.stop = function () {
      if (!eng.playing) return;
      eng.playing = false; clearInterval(timer); timer = null;
      if (voice) { voice.amp.gain.cancelScheduledValues(ctx.currentTime); voice.amp.gain.setTargetAtTime(0, ctx.currentTime, 0.03); }
      transport();
    };
    eng.toggle = function () { if (eng.playing) eng.stop(); else eng.start(); return eng.playing; };
    eng.setBpm = function (b) { eng.bpm = Math.round(clamp(b, 60, 180)); transport(); };
    eng.set303 = function (k, v) {
      var r = P303_RANGES[k]; if (r) v = clamp(v, r[0], r[1]);
      eng.p303[k] = v;
      if (!voice) return;
      var now = ctx.currentTime;
      if (k === 'reso') voice.filt.Q.setTargetAtTime(v, now, 0.02);
      if (k === 'cutoff' && !eng.playing) voice.filt.frequency.setTargetAtTime(v, now, 0.02);
      if (k === 'drive') { voice.pre.gain.setTargetAtTime(1 + v * 3, now, 0.02); voice.shaper.curve = makeDriveCurve(v); }
      if (k === 'wave') voice.osc.type = v;
    };
    eng.setMute = function (which, on) { eng.mute[which] = !!on; applyMix(); };
    eng.setVolume = function (which, v) { eng.volume[which] = clamp(v, 0, 1); applyMix(); };
    eng.setScale = function (name) { if (SCALES[name]) { eng.scale = name; eng.degrees = SCALES[name].concat([12]); } };
    eng.noteName = function (i) {
      var s = eng.acid[i], semi = eng.degrees[s.degreeIndex % eng.degrees.length] + 12 * s.octave + 9 + Math.round(eng.p303.tune);
      return NOTE_NAMES[((semi % 12) + 12) % 12] + (1 + Math.floor(semi / 12));
    };
    eng.generateAcid = function (style) {          // the Acid Machine's generator: rule-based, not random noise
      var st = STYLES[style] || STYLES.classic, degs = eng.degrees, steps = [], restRun = 0;
      for (var i = 0; i < 16; i++) {
        var active = chance(st.density * stepWeight(i, st.stepBias));
        if (!active) restRun++; else restRun = 0;
        if (restRun >= st.maxRest) { active = true; restRun = 0; }
        if (!active) { steps.push(emptyStep()); continue; }
        var di = (i % 4 === 0 && chance(st.rootPull)) || chance(0.3) ? 0 : Math.floor(Math.random() * degs.length);
        var oct = i !== 0 && chance(st.octjump * 0.5) ? pick([-1, 1, 1]) : 0;
        var accW = i % 4 === 0 ? 1.6 : (i % 2 === 0 ? 0.9 : 0.5);
        steps.push({ active: true, degreeIndex: di, accent: chance(st.accents * accW), slide: false, octave: oct });
      }
      for (var j = 1; j < 16; j++) if (steps[j].active && steps[j - 1].active && chance(st.slides)) steps[j].slide = true;
      if (!steps[0].active) steps[0] = { active: true, degreeIndex: 0, accent: true, slide: false, octave: 0 };
      steps[0].slide = false;
      eng.acid = steps;
    };
    eng.generateDrums = function (style) {         // four on the floor and friends
      var r = function () { return row([]); }, d = { bd: r(), sd: r(), cp: r(), ch: r(), oh: r(), rs: r() };
      for (var i = 0; i < 16; i += 4) d.bd[i] = true;
      if (style === 'rolling' || style === 'chaos') { if (chance(0.6)) d.bd[14] = true; }
      if (style === 'minimal' && chance(0.4)) d.bd[8] = false;
      d.cp[4] = d.cp[12] = true;
      if (style !== 'minimal') d.sd[12] = chance(0.6);
      if (style === 'chaos' && chance(0.5)) d.cp[14] = true;
      var hatStep = style === 'rolling' || style === 'chaos' ? 1 : 2;
      for (var h = 0; h < 16; h += hatStep) if (!(style === 'minimal' && h % 4 === 0)) d.ch[h] = chance(0.85);
      for (var o = 2; o < 16; o += 4) if (chance(style === 'dub' ? 0.9 : 0.35)) { d.oh[o] = true; d.ch[o] = false; }
      if (style === 'dub') for (var x = 0; x < 16; x++) d.rs[x] = x % 8 === 6;
      else if (chance(0.4)) d.rs[pick([3, 7, 11, 15])] = true;
      eng.drums = d;
    };
    eng.generate = function (style) { style = style || pick(Object.keys(STYLES)); eng.generateAcid(style); eng.generateDrums(style); return style; };
    return eng;
  }

  root.AcidEngine = { create: create, STYLES: Object.keys(STYLES), SCALES: Object.keys(SCALES), DRUMS: DRUMS, DRUM_NAMES: DRUM_NAMES,
                      P303_RANGES: P303_RANGES, version: 1 };
})(typeof window !== 'undefined' ? window : this);
