/* =============================================================================
   FRESH COLLECTIBLES — SHARED BACKGROUND AUDIO  (audio-vault.js)
   -----------------------------------------------------------------------------
   One AudioContext, five procedural background tracks, one floating selector
   that looks and behaves the same on every page:

       index.html      welcome.html      homepage.html

   The two protected pages (inventory.html, add-item.html) deliberately load
   gate-audio.js instead: no dock, just the "A Journey Awaits" login theme.

   The visitor's choice (on/off + which track) is stored in localStorage, so it
   carries across pages. Nothing is streamed — every note is synthesised live,
   so the file is tiny and works offline.

   v2: the five tracks were replaced with a more produced set (pads, FM keys,
   delay + reverb sends, gentle bus compression) and the dock now shows the
   SOUND button first with the track list underneath it.

   Public API (window.AudioVault):
       start()            turn background sound on
       stop()             turn it off
       toggle()           flip it
       isPlaying()        boolean
       setTrack(id)       switch track (starts playback if it was off)
       getTrack()         current track descriptor
       tracks             [{ id, name, blurb }, ...]
   Legacy shims are also installed so the existing header buttons keep working:
       toggleRetroAudio() / startRetroAudio() / stopRetroAudio()
   A bubbling "audiovaultchange" CustomEvent fires on every state change.
   ========================================================================== */
(function () {
  "use strict";

  var STORAGE_KEY = "fresh.audio.v1";
  var MASTER_LEVEL = 0.5;
  var LOOKAHEAD = 0.2;
  var TICK_MS = 25;
  var DEFAULT_TRACK = "sunset";

  /* ---------------------------------------------------------------- state */
  var ctx = null;
  var master = null;
  var comp = null;
  var music = null;
  var verbSend = null;
  var verb = null;
  var delaySend = null;
  var dly = null;
  var noiseBuf = null;
  var timer = null;
  var playing = false;
  var nextTime = 0;
  var stepIndex = 0;
  var trackId = DEFAULT_TRACK;
  var dock = null;
  var api = null;

  var saved = readSaved();

  function readSaved() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function save(patch) {
    try {
      var next = readSaved();
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      /* private mode / storage disabled — audio still works for this page */
    }
  }

  /* -------------------------------------------------------------- context */
  function makeImpulse(seconds, decay) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function ensureCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();

      /* master -> gentle bus compressor -> speakers */
      master = ctx.createGain();
      master.gain.value = MASTER_LEVEL;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 30;
      comp.ratio.value = 3;
      comp.attack.value = 0.006;
      comp.release.value = 0.3;
      master.connect(comp);
      comp.connect(ctx.destination);

      music = ctx.createGain();
      music.gain.value = 0.0001;
      music.connect(master);

      /* reverb (generated impulse — no external files) */
      verbSend = ctx.createGain();
      verbSend.gain.value = 1;
      verb = ctx.createConvolver();
      verb.buffer = makeImpulse(2.4, 2.6);
      var verbReturn = ctx.createGain();
      verbReturn.gain.value = 0.85;
      verbSend.connect(verb);
      verb.connect(verbReturn);
      verbReturn.connect(master);

      /* feedback delay */
      delaySend = ctx.createGain();
      delaySend.gain.value = 1;
      dly = ctx.createDelay(1.5);
      dly.delayTime.value = 0.4;
      var dlyLp = ctx.createBiquadFilter();
      dlyLp.type = "lowpass";
      dlyLp.frequency.value = 2600;
      var dlyFb = ctx.createGain();
      dlyFb.gain.value = 0.33;
      var dlyReturn = ctx.createGain();
      dlyReturn.gain.value = 0.75;
      delaySend.connect(dly);
      dly.connect(dlyLp);
      dlyLp.connect(dlyReturn);
      dlyReturn.connect(master);
      dlyLp.connect(dlyFb);
      dlyFb.connect(dly);
    }
    if (ctx.state === "suspended") {
      try {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }
    return ctx;
  }

  function makeNoise() {
    var len = Math.floor(ctx.sampleRate * 1.0);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function noiseSource() {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf || makeNoise();
    src.loop = true;
    return src;
  }

  function panner(v) {
    if (!ctx.createStereoPanner) return null;
    var p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, v || 0));
    return p;
  }

  function connectOut(node, o) {
    o = o || {};
    var p = panner(o.pan || 0);
    var tail = node;
    if (p) {
      node.connect(p);
      tail = p;
    }
    tail.connect(music);
    if (o.verb) {
      var vg = ctx.createGain();
      vg.gain.value = o.verb;
      tail.connect(vg);
      vg.connect(verbSend);
    }
    if (o.delay) {
      var dg = ctx.createGain();
      dg.gain.value = o.delay;
      tail.connect(dg);
      dg.connect(delaySend);
    }
    return tail;
  }

  /* --------------------------------------------------------- sound blocks */
  function note(t, o) {
    if (!o.freq || o.freq <= 0) return;
    var osc = ctx.createOscillator();
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);

    var node = osc;
    if (o.filter) {
      var f = ctx.createBiquadFilter();
      f.type = o.filter.type || "lowpass";
      f.frequency.setValueAtTime(o.filter.freq || 1800, t);
      if (o.filter.to) {
        f.frequency.exponentialRampToValueAtTime(Math.max(40, o.filter.to), t + (o.dur || 0.2));
      }
      if (o.filter.q) f.Q.setValueAtTime(o.filter.q, t);
      node.connect(f);
      node = f;
    }

    var g = ctx.createGain();
    node.connect(g);
    connectOut(g, o);

    var dur = o.dur || 0.2;
    var atk = o.attack == null ? 0.006 : o.attack;
    var peak = o.gain == null ? 0.08 : o.gain;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(atk + 0.05, dur));

    osc.start(t);
    osc.stop(t + Math.max(atk + 0.08, dur + 0.06));
  }

  function pad(t, freqs, o) {
    o = o || {};
    var dur = o.dur || 2.0;
    for (var i = 0; i < freqs.length; i++) {
      note(t, {
        freq: freqs[i],
        type: o.type || "sawtooth",
        dur: dur,
        gain: o.gain == null ? 0.03 : o.gain,
        attack: o.attack == null ? dur * 0.22 : o.attack,
        filter: { type: "lowpass", freq: o.cut || 1000, to: o.cutTo || 700, q: 0.6 },
        pan: (i - (freqs.length - 1) / 2) * 0.16,
        detune: i % 2 ? 6 : -6,
        verb: o.verb == null ? 0.5 : o.verb
      });
    }
  }

  function bass(t, o) {
    var dur = o.dur || 0.22;
    var g = ctx.createGain();
    var f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(o.cut || 700, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, o.cutTo || 160), t + dur);
    f.Q.setValueAtTime(o.q || 4, t);
    f.connect(g);
    connectOut(g, { pan: o.pan || 0 });

    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain == null ? 0.18 : o.gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    var a = ctx.createOscillator();
    a.type = o.type || "sawtooth";
    a.frequency.setValueAtTime(o.freq, t);
    var b = ctx.createOscillator();
    b.type = "sine";
    b.frequency.setValueAtTime(o.freq / 2, t);

    a.connect(f);
    b.connect(f);
    a.start(t);
    a.stop(t + dur + 0.03);
    b.start(t);
    b.stop(t + dur + 0.03);
  }

  /* two-operator FM — electric-piano / bell family */
  function keys(t, o) {
    var dur = o.dur || 0.5;
    var carrier = ctx.createOscillator();
    carrier.type = "sine";
    carrier.frequency.setValueAtTime(o.freq, t);

    var mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.setValueAtTime(o.freq * (o.ratio || 3), t);
    var mg = ctx.createGain();
    mg.gain.setValueAtTime(o.freq * (o.index || 2), t);
    mg.gain.exponentialRampToValueAtTime(o.freq * 0.08, t + dur * 0.65);
    mod.connect(mg);
    mg.connect(carrier.frequency);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain == null ? 0.08 : o.gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    carrier.connect(g);
    connectOut(g, o);

    carrier.start(t);
    carrier.stop(t + dur + 0.04);
    mod.start(t);
    mod.stop(t + dur + 0.04);
  }

  function kick(t, o) {
    o = o || {};
    var dur = o.dur || 0.2;
    var g = ctx.createGain();
    g.connect(music);
    var osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(o.from || 150, t);
    osc.frequency.exponentialRampToValueAtTime(o.to || 44, t + dur * 0.85);
    g.gain.setValueAtTime(o.gain == null ? 0.6 : o.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    osc.start(t);
    osc.stop(t + dur + 0.02);

    var click = ctx.createOscillator();
    click.type = "triangle";
    click.frequency.setValueAtTime(1100, t);
    var cg = ctx.createGain();
    cg.gain.setValueAtTime(0.12, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
    click.connect(cg);
    cg.connect(music);
    click.start(t);
    click.stop(t + 0.03);
  }

  function snare(t, o) {
    o = o || {};
    var dur = o.dur || 0.16;
    var src = noiseSource();
    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = o.freq || 1900;
    bp.Q.value = 0.9;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(o.gain == null ? 0.2 : o.gain, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(ng);
    connectOut(ng, { verb: o.verb || 0.18 });
    src.start(t);
    src.stop(t + dur + 0.02);

    var body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(190, t);
    body.frequency.exponentialRampToValueAtTime(120, t + dur * 0.7);
    var bg = ctx.createGain();
    bg.gain.setValueAtTime(0.12, t);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.7);
    body.connect(bg);
    bg.connect(music);
    body.start(t);
    body.stop(t + dur);
  }

  function hat(t, o) {
    o = o || {};
    var dur = o.dur || (o.open ? 0.18 : 0.035);
    var src = noiseSource();
    var hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = o.freq || 8500;
    var g = ctx.createGain();
    g.gain.setValueAtTime(o.gain == null ? 0.06 : o.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp);
    hp.connect(g);
    connectOut(g, { pan: o.pan || 0.18, verb: o.verb || 0 });
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  function shaker(t, o) {
    o = o || {};
    var dur = o.dur || 0.06;
    var src = noiseSource();
    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = o.freq || 6500;
    bp.Q.value = 1.2;
    var g = ctx.createGain();
    g.gain.setValueAtTime(o.gain == null ? 0.02 : o.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    connectOut(g, { pan: o.pan || 0.22 });
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  function rim(t, o) {
    o = o || {};
    var dur = o.dur || 0.05;
    var src = noiseSource();
    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = o.freq || 2600;
    bp.Q.value = 8;
    var g = ctx.createGain();
    g.gain.setValueAtTime(o.gain == null ? 0.06 : o.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    connectOut(g, { pan: o.pan == null ? -0.3 : o.pan, verb: o.verb || 0.3 });
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  function wash(t, dur, gain) {
    var src = noiseSource();
    var lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.linearRampToValueAtTime(900, t + dur * 0.5);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp);
    lp.connect(g);
    connectOut(g, { pan: 0, verb: 0.7 });
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /* ------------------------------------------------------------- the tracks */
  var TRACKS = [
    {
      id: "sunset",
      name: "Sunset Drive",
      blurb: "Outrun cruiser: warm pads, glassy arp, steady beat",
      stepDur: 0.1364,
      delayTime: 0.41,
      step: function (t, i) {
        var bar = Math.floor(i / 16) % 4;
        var pos = i % 16;
        var chords = [
          [220.0, 261.63, 329.63],          // Am
          [174.61, 220.0, 261.63, 349.23],  // F
          [261.63, 329.63, 392.0],          // C
          [196.0, 246.94, 293.66]           // G
        ];
        var roots = [110.0, 87.31, 130.81, 98.0];
        var chord = chords[bar];

        if (pos === 0) {
          pad(t, chord, { dur: 1.9, gain: 0.03, cut: 1200, cutTo: 800, verb: 0.5 });
          wash(t, 1.7, 0.012);
        }

        var bassSteps = [0, 3, 6, 8, 11, 14];
        if (bassSteps.indexOf(pos) >= 0) {
          var oct = pos === 6 || pos === 14 ? 2 : 1;
          bass(t, { freq: roots[bar] * oct, dur: 0.2, gain: 0.17, cut: 620, cutTo: 150, q: 4 });
        }

        var arpMap = [0, 1, 2, 3, 2, 1, 2, 1, 0, 1, 2, 3, 3, 2, 1, 0];
        var arpNote = chord[arpMap[pos] % chord.length];
        if (arpMap[pos] === 3) arpNote = chord[chord.length - 1] * 2;
        note(t, {
          freq: arpNote,
          type: "triangle",
          dur: 0.11,
          gain: 0.036,
          pan: pos % 2 ? 0.24 : -0.24,
          filter: { type: "lowpass", freq: 3400 },
          delay: 0.35,
          verb: 0.15
        });

        if (pos === 0 || pos === 8) kick(t, { gain: 0.6 });
        if (pos === 4 || pos === 12) snare(t, { gain: 0.19 });
        if (pos % 2 === 1) hat(t, { gain: 0.045 });
        if (pos === 14) hat(t, { open: true, gain: 0.05 });

        var lead = [
          0, 0, 0, 0, 659.25, 0, 0, 587.33, 0, 0, 523.25, 0, 587.33, 0, 0, 0,
          0, 0, 0, 0, 523.25, 0, 0, 493.88, 0, 0, 440.0, 0, 493.88, 0, 0, 0,
          0, 0, 0, 0, 659.25, 0, 698.46, 0, 783.99, 0, 0, 698.46, 659.25, 0, 0, 0,
          0, 0, 0, 0, 587.33, 0, 0, 523.25, 0, 493.88, 0, 0, 440.0, 0, 0, 0
        ];
        var mel = lead[i % 64];
        if (mel) {
          note(t, {
            freq: mel,
            type: "square",
            dur: 0.17,
            gain: 0.042,
            filter: { type: "lowpass", freq: 2500 },
            delay: 0.45,
            verb: 0.2
          });
        }
      }
    },
    {
      id: "glass",
      name: "Glass Horizon",
      blurb: "Chill ambience: warm chords, soft bells, no drum kit",
      stepDur: 0.1786,
      delayTime: 0.53,
      step: function (t, i) {
        var bar = Math.floor(i / 16) % 4;
        var pos = i % 16;
        var prog = [
          [293.66, 349.23, 440.0, 523.25],  // Dm add9
          [233.08, 293.66, 349.23, 440.0],  // Bb maj7
          [196.0, 233.08, 293.66, 349.23],  // Gm7
          [220.0, 293.66, 329.63, 440.0]    // A7 sus
        ];
        var roots = [73.42, 58.27, 49.0, 55.0];

        if (pos === 0) {
          pad(t, prog[bar], { dur: 2.7, gain: 0.026, attack: 0.9, cut: 900, cutTo: 620, verb: 0.95 });
          note(t, { freq: roots[bar], type: "sine", dur: 2.3, gain: 0.13, attack: 0.35 });
          wash(t, 2.6, 0.014);
        }
        if (pos === 8) {
          note(t, { freq: roots[bar] * 1.5, type: "sine", dur: 1.7, gain: 0.055, attack: 0.3 });
        }

        var bells = [
          0, 0, 0, 587.33, 0, 0, 880.0, 0, 0, 0, 698.46, 0, 0, 523.25, 0, 0,
          0, 0, 0, 659.25, 0, 0, 987.77, 0, 0, 587.33, 0, 0, 523.25, 0, 0, 0
        ];
        var bell = bells[i % 32];
        if (bell) {
          keys(t, {
            freq: bell,
            ratio: 7,
            index: 1.2,
            dur: 1.3,
            gain: 0.045,
            pan: bell > 700 ? 0.3 : -0.3,
            delay: 0.4,
            verb: 0.6
          });
        }

        if (pos === 0) kick(t, { gain: 0.22, dur: 0.3, from: 95, to: 44 });
        if (pos % 2 === 0) shaker(t, { gain: 0.014 });
        if (pos === 4 || pos === 12) rim(t, { gain: 0.03, verb: 0.5 });
      }
    },
    {
      id: "tokyo",
      name: "Neon Tokyo",
      blurb: "Citypop groove: FM keys, syncopated bass, shaker",
      stepDur: 0.1442,
      delayTime: 0.43,
      step: function (t, i) {
        var bar = Math.floor(i / 16) % 4;
        var pos = i % 16;
        var prog = [
          [174.61, 220.0, 261.63, 329.63],  // Fmaj7
          [196.0, 246.94, 293.66, 349.23],  // G7
          [164.81, 196.0, 246.94, 293.66],  // Em7
          [220.0, 261.63, 329.63, 392.0]    // Am7
        ];
        var roots = [87.31, 98.0, 82.41, 110.0];

        if (pos === 2 || pos === 6 || pos === 10 || pos === 14) {
          var stab = prog[bar];
          var pan = pos % 4 === 0 ? -0.2 : 0.2;
          for (var s = 0; s < stab.length; s++) {
            keys(t, {
              freq: stab[s],
              ratio: 4,
              index: 1.6,
              dur: 0.2,
              gain: 0.026,
              pan: pan + (s - 1.5) * 0.08,
              verb: 0.25
            });
          }
        }
        if (pos === 0) wash(t, 1.2, 0.008);

        var bassHits = { 0: 1, 3: 1.5, 6: 1, 8: 2, 11: 1.5, 14: 1 };
        if (bassHits[pos]) {
          bass(t, {
            freq: roots[bar] * bassHits[pos],
            dur: 0.19,
            gain: 0.17,
            cut: 700,
            cutTo: 180,
            q: 6
          });
        }

        if (pos === 0 || pos === 7 || pos === 10) kick(t, { gain: 0.5 });
        if (pos === 4 || pos === 12) snare(t, { gain: 0.17 });
        if (pos % 2 === 0) shaker(t, { gain: 0.02, pan: pos % 4 === 0 ? 0.24 : -0.18 });
        if (pos === 15) hat(t, { open: true, gain: 0.04 });

        var lead = [
          0, 0, 0, 0, 0, 0, 0, 0, 523.25, 0, 0, 587.33, 0, 0, 0, 0,
          0, 0, 0, 0, 659.25, 0, 587.33, 0, 0, 523.25, 0, 0, 466.16, 0, 0, 0
        ];
        var mel = lead[i % 32];
        if (mel) {
          keys(t, {
            freq: mel,
            ratio: 5,
            index: 1.8,
            dur: 0.42,
            gain: 0.05,
            pan: -0.15,
            delay: 0.35,
            verb: 0.3
          });
        }
      }
    },
    {
      id: "vector",
      name: "Vector Rush",
      blurb: "Chiptune action: melodic square lead with echo",
      stepDur: 0.1172,
      delayTime: 0.35,
      step: function (t, i) {
        var pos = i % 16;
        var lead = [
          523.25, 0, 659.25, 0, 783.99, 0, 659.25, 0, 523.25, 0, 466.16, 0, 392.0, 0, 0, 0,
          440.0, 0, 523.25, 0, 659.25, 0, 523.25, 0, 466.16, 0, 392.0, 0, 349.23, 0, 0, 0
        ];
        var mel = lead[i % 32];
        if (mel) {
          note(t, {
            freq: mel,
            type: "square",
            dur: 0.1,
            gain: 0.045,
            filter: { type: "lowpass", freq: 3200 },
            delay: 0.4,
            verb: 0.12
          });
          if (i % 32 > 15) {
            note(t, { freq: mel / 2, type: "square", dur: 0.09, gain: 0.018, filter: { type: "lowpass", freq: 1600 } });
          }
        }

        var bassLine = [130.81, 0, 130.81, 0, 98.0, 0, 98.0, 0, 110.0, 0, 110.0, 0, 87.31, 0, 87.31, 0];
        if (bassLine[pos]) {
          bass(t, { freq: bassLine[pos], dur: 0.1, gain: 0.15, cut: 900, cutTo: 220, q: 3 });
        }

        if (pos === 0 || pos === 8) kick(t, { gain: 0.5, dur: 0.14 });
        if (pos === 4 || pos === 12) snare(t, { gain: 0.16, dur: 0.12 });
        if (pos % 2 === 1) hat(t, { gain: 0.035 });
        if (pos === 14) hat(t, { open: true, gain: 0.04 });
      }
    },
    {
      id: "signal",
      name: "Deep Signal",
      blurb: "Ambient techno: deep pulse, noise washes, sparse clicks",
      stepDur: 0.125,
      delayTime: 0.375,
      step: function (t, i) {
        var pos = i % 32;

        if (i % 4 === 0) {
          note(t, { freq: 55.0, type: "sine", dur: 0.55, gain: 0.15, attack: 0.02 });
        }
        if (i % 32 === 0) wash(t, 3.8, 0.028);
        if (pos === 16) {
          pad(t, [146.83, 174.61, 220.0, 261.63], {
            dur: 2.7,
            gain: 0.02,
            attack: 1.2,
            cut: 800,
            cutTo: 480,
            verb: 1.0
          });
        }
        if (pos === 6 || pos === 22) rim(t, { gain: 0.05, verb: 0.5 });
        if (pos % 4 === 2) hat(t, { gain: 0.022, pan: 0.3, freq: 9500 });
        if (pos === 14) {
          note(t, { freq: 880.0, type: "sine", dur: 0.4, gain: 0.028, delay: 0.6, verb: 0.5 });
        }
        if (pos === 27) {
          note(t, { freq: 659.25, type: "triangle", dur: 0.5, gain: 0.022, delay: 0.55, verb: 0.5 });
        }
      }
    }
  ];

  function getTrackById(id) {
    for (var i = 0; i < TRACKS.length; i++) {
      if (TRACKS[i].id === id) return TRACKS[i];
    }
    for (var j = 0; j < TRACKS.length; j++) {
      if (TRACKS[j].id === DEFAULT_TRACK) return TRACKS[j];
    }
    return TRACKS[0];
  }

  function currentTrack() {
    return getTrackById(trackId);
  }

  /* -------------------------------------------------------------- playback */
  function schedule() {
    if (!playing) return;
    if (ctx && ctx.state === "running") {
      var guard = 0;
      if (nextTime < ctx.currentTime - 0.3) nextTime = ctx.currentTime + 0.05;
      while (nextTime < ctx.currentTime + LOOKAHEAD && guard < 40) {
        try {
          currentTrack().step(nextTime, stepIndex);
        } catch (e) {
          /* one bad note must never kill the loop */
        }
        nextTime += currentTrack().stepDur;
        stepIndex++;
        guard++;
      }
    }
    timer = window.setTimeout(schedule, TICK_MS);
  }

  function start() {
    if (!ensureCtx()) return false;
    if (playing) return true;
    playing = true;
    stepIndex = 0;
    nextTime = ctx.currentTime + 0.08;
    try {
      music.gain.cancelScheduledValues(ctx.currentTime);
      music.gain.setValueAtTime(0.0001, ctx.currentTime);
      music.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.45);
    } catch (e) {}
    save({ enabled: true });
    schedule();
    syncUI();
    return true;
  }

  function stop() {
    if (!playing && !timer) {
      save({ enabled: false });
      syncUI();
      return;
    }
    playing = false;
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (ctx) {
      try {
        var now = ctx.currentTime;
        music.gain.cancelScheduledValues(now);
        music.gain.setValueAtTime(music.gain.value, now);
        music.gain.linearRampToValueAtTime(0.0001, now + 0.22);
      } catch (e) {}
    }
    save({ enabled: false });
    syncUI();
  }

  function toggle() {
    if (playing) {
      stop();
      return false;
    }
    return start();
  }

  function setTrack(id) {
    var next = getTrackById(id);
    trackId = next.id;
    save({ track: trackId });
    stepIndex = 0;
    if (ctx) {
      nextTime = ctx.currentTime + 0.06;
      if (dly && next.delayTime) {
        try { dly.delayTime.setValueAtTime(next.delayTime, ctx.currentTime); } catch (e) {}
      }
      try {
        music.gain.cancelScheduledValues(ctx.currentTime);
        music.gain.setValueAtTime(Math.max(0.0001, music.gain.value), ctx.currentTime);
        music.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.25);
      } catch (e) {}
    }
    if (!playing) start();
    syncUI();
    return next.id;
  }

  /* -------------------------------------------------------------- helpers */
  function isPlaying() {
    return playing;
  }

  function trackName() {
    return currentTrack().name;
  }

  function emit() {
    try {
      window.dispatchEvent(new CustomEvent("audiovaultchange", {
        detail: { playing: playing, track: trackId, name: trackName() }
      }));
    } catch (e) {}
  }

  function syncUI() {
    /* Floating dock */
    if (dock) {
      var pill = dock.querySelector("#avToggle");
      var label = dock.querySelector("#avLabel");
      var nameEl = dock.querySelector("#avName");
      var eq = dock.querySelector("#avEq");
      var offBtn = dock.querySelector("#avOffBtn");
      var isOn = playing;

      pill.classList.toggle("is-off", !isOn);
      pill.setAttribute("aria-pressed", isOn ? "true" : "false");
      pill.title = isOn ? "Background sound on — click to mute" : "Background sound off — click to play";
      if (label) label.textContent = isOn ? "SOUND: ON" : "SOUND: OFF";
      if (nameEl) nameEl.textContent = trackName();
      if (eq) eq.classList.toggle("is-on", isOn);
      if (offBtn) offBtn.textContent = isOn ? "SOUND OFF" : "SOUND ON";

      var opts = dock.querySelectorAll(".av-opt");
      for (var i = 0; i < opts.length; i++) {
        var on = opts[i].getAttribute("data-track") === trackId;
        opts[i].classList.toggle("is-active", on);
        opts[i].setAttribute("aria-checked", on ? "true" : "false");
      }
    }

    /* Legacy header button on welcome.html / homepage.html */
    var legacy = document.getElementById("soundToggleBtn");
    if (legacy) {
      legacy.classList.toggle("sound-active", playing);
      var icon = document.getElementById("soundIcon");
      var legacyLabel = document.getElementById("soundLabel");
      if (icon) icon.textContent = playing ? "\uD83D\uDD0A" : "\uD83D\uDD07";
      if (legacyLabel) legacyLabel.textContent = playing ? "SOUND: ON" : "SOUND: OFF";
      legacy.title = playing
        ? "Background sound: " + trackName() + " (click to mute)"
        : "Background sound off (click to play)";
    }

    /* Legacy splash button on index.html */
    var splash = document.getElementById("audioToggleBtn");
    if (splash) {
      var splashLabel = document.getElementById("audioStatusLabel");
      var eqBox = document.getElementById("eqContainer");
      if (splashLabel) splashLabel.textContent = playing ? "AUDIO: ON" : "AUDIO: OFF";
      if (eqBox) eqBox.classList.toggle("eq-playing", playing);
      splash.classList.toggle("text-cyan-200", playing);
      splash.classList.toggle("text-pink-200", !playing);
      splash.title = playing
        ? "Background sound: " + trackName() + " (click to mute)"
        : "Background sound off (click to play)";
    }

    emit();
  }

  /* ------------------------------------------------------------------- UI */
  var CSS = [
    "#avDock{position:fixed;left:14px;bottom:14px;z-index:80;font-family:'Share Tech Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#dff9ff;-webkit-text-size-adjust:100%}",
    "#avDock *{box-sizing:border-box}",
    "#avDock #avLabel,#avDock .av-name,#avDock .av-sep{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
    "#avDock .av-row{display:flex;align-items:stretch;gap:6px}",
    "#avDock .av-btn{appearance:none;-webkit-appearance:none;cursor:pointer;border:1px solid rgba(0,243,255,.55);background:linear-gradient(135deg,#1b0736 0%,#3d0952 55%,#12052a 100%);color:#9fe9ff;border-radius:9px;padding:8px 10px;font-family:inherit;font-size:10px;line-height:1;letter-spacing:.16em;text-transform:uppercase;display:inline-flex;align-items:center;gap:7px;box-shadow:0 0 12px rgba(0,243,255,.18),inset 0 0 14px rgba(157,0,255,.12);transition:border-color .15s,box-shadow .15s,color .15s;white-space:nowrap}",
    "#avDock .av-btn:hover{border-color:#fff;color:#fff;box-shadow:0 0 18px rgba(0,243,255,.5),0 0 24px rgba(255,0,127,.25)}",
    "#avDock .av-btn.is-off{border-color:rgba(157,0,255,.55);color:#c9b6ff;box-shadow:0 0 10px rgba(157,0,255,.2)}",
    "#avDock .av-btn:focus-visible{outline:2px solid #ff007f;outline-offset:2px}",
    "#avDock .av-caret{padding:8px 9px;flex:0 0 auto}",
    "#avDock .av-eq{display:inline-flex;align-items:flex-end;gap:2px;height:11px;width:12px;flex:0 0 auto}",
    "#avDock .av-eq i{display:block;width:2px;height:3px;border-radius:1px;background:#00f3ff;box-shadow:0 0 5px #00f3ff;transition:height .15s}",
    "#avDock .av-eq.is-on i{animation:avEq .75s ease-in-out infinite alternate}",
    "#avDock .av-eq.is-on i:nth-child(2){animation-delay:.14s}",
    "#avDock .av-eq.is-on i:nth-child(3){animation-delay:.28s}",
    "#avDock .av-eq.is-on i:nth-child(4){animation-delay:.42s}",
    "#avDock .av-btn.is-off .av-eq i{background:#9d00ff;box-shadow:0 0 4px #9d00ff}",
    "@keyframes avEq{from{height:2px}to{height:11px}}",
    "#avDock .av-name{color:#fff;font-size:9px;letter-spacing:.12em;max-width:150px;overflow:hidden;text-overflow:ellipsis}",
    "#avDock .av-sep{color:rgba(0,243,255,.5)}",
    "#avDock .av-panel{display:none;margin-top:7px;width:300px;max-width:calc(100vw - 28px);border:1px solid rgba(0,243,255,.35);border-radius:12px;background:linear-gradient(160deg,rgba(27,7,54,.985) 0%,rgba(7,2,18,.99) 60%,rgba(17,5,40,.985) 100%);box-shadow:0 14px 40px rgba(0,0,0,.7),0 0 24px rgba(157,0,255,.2);padding:10px}",
    "#avDock .av-panel.is-open{display:block}",
    "#avDock .av-head{font-size:9px;letter-spacing:.28em;text-transform:uppercase;color:#9a8fc9;padding:2px 4px 8px}",
    "#avDock .av-power{display:flex;gap:6px;padding-bottom:9px;border-bottom:1px solid rgba(157,0,255,.25);margin-bottom:9px}",
    "#avDock .av-off{flex:1;justify-content:center}",
    "#avDock .av-sub{font-size:8px;letter-spacing:.24em;text-transform:uppercase;color:#8b7fc7;padding:0 4px 6px}",
    "#avDock .av-opt{display:flex;width:100%;text-align:left;align-items:flex-start;gap:8px;padding:7px 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:#cfe9ff;cursor:pointer;font-family:inherit;font-size:11px;letter-spacing:.03em;transition:background .12s,border-color .12s}",
    "#avDock .av-opt:hover{background:rgba(0,243,255,.09);border-color:rgba(0,243,255,.3)}",
    "#avDock .av-opt:focus-visible{outline:2px solid #00f3ff;outline-offset:-2px}",
    "#avDock .av-opt.is-active{border-color:rgba(255,0,127,.7);background:rgba(255,0,127,.12);color:#fff}",
    "#avDock .av-dot{width:8px;height:8px;margin-top:3px;border-radius:50%;border:1px solid #00f3ff;flex:0 0 auto}",
    "#avDock .av-opt.is-active .av-dot{background:#ff007f;border-color:#ff007f;box-shadow:0 0 8px #ff007f}",
    "#avDock .av-opt b{display:block;font-weight:400;letter-spacing:.14em;text-transform:uppercase;font-size:10px}",
    "#avDock .av-opt small{display:block;color:#8b7fc7;font-size:9px;letter-spacing:.02em;margin-top:3px;line-height:1.35}",
    "#avDock .av-opt.is-active small{color:#bfaee8}",
    "#avDock .av-hint{font-size:8px;color:#6e628f;letter-spacing:.1em;margin-top:8px;padding:0 4px;border-top:1px solid rgba(157,0,255,.25);padding-top:8px;line-height:1.4}",
    "@media(max-width:520px){#avDock{left:10px;bottom:10px}#avDock .av-name{display:none}#avDock .av-sep{display:none}#avDock .av-btn{font-size:9px;padding:8px 9px}}",
    "@media(prefers-reduced-motion:reduce){#avDock .av-eq.is-on i{animation:none;height:6px}}"
  ].join("\n");

  function injectCss() {
    if (document.getElementById("avStyles")) return;
    var style = document.createElement("style");
    style.id = "avStyles";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildDock() {
    injectCss();
    if (document.getElementById("avDock")) {
      dock = document.getElementById("avDock");
      return;
    }

    dock = document.createElement("div");
    dock.id = "avDock";

    var opts = TRACKS.map(function (tr) {
      return '<button type="button" class="av-opt" data-track="' + tr.id + '" role="radio" aria-checked="false">' +
        '<span class="av-dot" aria-hidden="true"></span>' +
        '<span><b>' + tr.name + '</b><small>' + tr.blurb + '</small></span>' +
        '</button>';
    }).join("");

    /* SOUND button first, track list underneath it. */
    dock.innerHTML =
      '<div class="av-row">' +
        '<button type="button" class="av-btn" id="avToggle" aria-pressed="false">' +
          '<span class="av-eq" id="avEq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
          '<span id="avLabel">SOUND: ON</span>' +
          '<span class="av-sep" aria-hidden="true">//</span>' +
          '<span class="av-name" id="avName">Sunset Drive</span>' +
        '</button>' +
        '<button type="button" class="av-btn av-caret" id="avOpen" aria-expanded="false" aria-controls="avPanel" title="Choose a background sound">\u25BC</button>' +
      '</div>' +
      '<div class="av-panel" id="avPanel" role="group" aria-label="Background sound">' +
        '<div class="av-head">BACKGROUND SOUND</div>' +
        '<div class="av-power">' +
          '<button type="button" class="av-btn av-off" id="avOffBtn">SOUND OFF</button>' +
        '</div>' +
        '<div class="av-sub">Choose a track</div>' +
        '<div role="radiogroup" aria-label="Choose a background track">' + opts + '</div>' +
        '<div class="av-hint">Saved on this device and carried across every page.</div>' +
      '</div>';

    document.body.appendChild(dock);

    var panel = dock.querySelector("#avPanel");
    var openBtn = dock.querySelector("#avOpen");

    function setOpen(open) {
      panel.classList.toggle("is-open", open);
      openBtn.setAttribute("aria-expanded", open ? "true" : "false");
      openBtn.textContent = open ? "\u25B2" : "\u25BC";
    }

    dock.querySelector("#avToggle").addEventListener("click", function () {
      toggle();
    });

    openBtn.addEventListener("click", function () {
      setOpen(!panel.classList.contains("is-open"));
    });

    dock.querySelector("#avOffBtn").addEventListener("click", function () {
      toggle();
    });

    dock.querySelectorAll(".av-opt").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTrack(btn.getAttribute("data-track"));
        setOpen(false);
      });
    });

    document.addEventListener("pointerdown", function (e) {
      if (dock && !dock.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });

    syncUI();
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    trackId = getTrackById(saved.track || DEFAULT_TRACK).id;
    buildDock();
    var enabled = saved.enabled !== false;
    if (enabled) start();
    else syncUI();

    /* Autoplay policy: the context starts suspended until a real gesture. */
    var unlock = function () {
      if (ctx && ctx.state === "suspended") {
        try {
          var p = ctx.resume();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
    };
    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
      window.addEventListener(ev, unlock, { passive: true });
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) unlock();
    });
  }

  /* ---------------------------------------------------------------- export */
  api = {
    start: start,
    stop: stop,
    toggle: toggle,
    isPlaying: isPlaying,
    setTrack: setTrack,
    getTrack: function () {
      var tr = currentTrack();
      return { id: tr.id, name: tr.name, blurb: tr.blurb };
    },
    tracks: TRACKS.map(function (tr) {
      return { id: tr.id, name: tr.name, blurb: tr.blurb };
    }),
    context: ensureCtx
  };

  window.AudioVault = api;

  /* Back-compat shims for the inline onclick handlers on the older pages. */
  window.toggleRetroAudio = toggle;
  window.startRetroAudio = start;
  window.stopRetroAudio = stop;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
