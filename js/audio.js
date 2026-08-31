'use strict';

/*
 * Spot Kick audio — original procedural WebAudio. Buses: music, effects,
 * ambience, voice (captions partner). Every logical event has a short
 * transient; meaningful audio has a text caption hook. No audio-only gameplay.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickAudio = api;
})(typeof self !== 'undefined' ? self : this, function () {

  let ctx = null;
  let buses = {};               // music, sfx, ambience, voice -> GainNode
  let levels = { music: 0.6, sfx: 0.8, ambience: 0.5, voice: 0.8 };
  let captionSink = null;       // fn(text) for captions/live region
  let ambienceNodes = null;
  let musicTimer = null;
  let started = false;

  function ensureCtx() {
    if (ctx) return true;
    const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    try {
      ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      buses = {};
      for (const name of ['music', 'sfx', 'ambience', 'voice']) {
        const g = ctx.createGain();
        g.gain.value = levels[name];
        g.connect(master);
        buses[name] = g;
      }
      return true;
    } catch (_) { return false; }
  }

  // Call from a user gesture to satisfy autoplay policy.
  function unlock() {
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (!started) { started = true; startAmbience(); startMusic(); }
  }

  function setLevel(bus, v) {
    levels[bus] = Math.max(0, Math.min(1, v));
    if (buses[bus]) buses[bus].gain.setTargetAtTime(levels[bus], ctx.currentTime, 0.05);
  }
  function getLevels() { return Object.assign({}, levels); }

  function caption(text) { if (captionSink) captionSink(text); }
  function onCaption(fn) { captionSink = fn; }

  // ---- primitive synth helpers ----
  function blip(bus, freq, dur, type, gain, slideTo) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(gain || 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(buses[bus]);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function thud(bus, lowFreq, dur, gain) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const len = Math.max(1, (dur * ctx.sampleRate) | 0);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowFreq;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain || 0.4, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(buses[bus]);
    src.start(t);
  }

  function crowd(bus, dur, gain, bright) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const len = (dur * ctx.sampleRate) | 0;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.sin(Math.PI * i / len);
      d[i] = (Math.random() * 2 - 1) * env * env;
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = bright ? 1400 : 500; f.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(buses[bus]);
    src.start(t);
  }

  // ---- authored sample one-shots (sfx/*.opus, see sfx/manifest.json) ----
  // Each logical event prefers its authored sample; procedural synthesis
  // below remains the fallback while the sample loads or if it is missing.
  const SAMPLES = {
    'ui-confirm': 'ui-confirm', 'ui-back': 'ui-back', 'ui-focus': 'ui-focus',
    'invalid': 'invalid', 'dive-committed': 'dive-committed', 'kick': 'kick',
    'goal': 'goal', 'save': 'save', 'offtarget': 'offtarget',
    'whistle-start': 'whistle-start', 'whistle-end': 'whistle-end',
    'win': 'win', 'lose': 'lose', 'achievement': 'achievement', 'tick': 'tick'
  };
  const sampleState = {}; // name -> {buffer} | 'loading' | 'failed'

  // Returns true when a decoded sample was played through the effects bus;
  // otherwise kicks off a lazy fetch/decode (once) so the caller synthesizes.
  function playSample(name) {
    const st = sampleState[name];
    if (st && st.buffer) {
      const src = ctx.createBufferSource();
      src.buffer = st.buffer;
      src.connect(buses.sfx);
      src.start();
      return true;
    }
    if (!st && typeof fetch === 'function') {
      sampleState[name] = 'loading';
      fetch('sfx/' + name + '.opus')
        .then(function (res) {
          if (!res.ok) throw new Error('http ' + res.status);
          return res.arrayBuffer();
        })
        .then(function (ab) { return ctx.decodeAudioData(ab); })
        .then(function (buf) { sampleState[name] = { buffer: buf }; })
        .catch(function () { sampleState[name] = 'failed'; });
    }
    return false;
  }

  // ---- event mapping (logical events -> transients + captions) ----
  function event(name) {
    if (!ctx) { caption(captionFor(name)); return; }
    const sampleName = SAMPLES[name];
    if (sampleName && playSample(sampleName)) { caption(captionFor(name)); return; }
    switch (name) {
      case 'ui-confirm': blip('sfx', 660, 0.07, 'triangle', 0.15); break;
      case 'ui-back': blip('sfx', 330, 0.08, 'triangle', 0.12); break;
      case 'ui-focus': blip('sfx', 520, 0.03, 'sine', 0.05); break;
      case 'invalid': blip('sfx', 180, 0.15, 'square', 0.1, 120); break;
      case 'dive-committed': blip('sfx', 440, 0.06, 'triangle', 0.12); break;
      case 'kick': thud('sfx', 220, 0.18, 0.5); blip('sfx', 90, 0.12, 'sine', 0.3, 50); break;
      case 'goal':
        crowd('sfx', 1.6, 0.5, true);
        blip('sfx', 523, 0.4, 'triangle', 0.2, 784);
        blip('voice', 392, 0.3, 'sine', 0.15, 523);
        break;
      case 'save': thud('sfx', 800, 0.25, 0.4); crowd('sfx', 0.9, 0.25, false); break;
      case 'offtarget': blip('sfx', 700, 0.5, 'sine', 0.15, 180); crowd('sfx', 0.8, 0.15, false); break;
      case 'whistle-start': blip('sfx', 2100, 0.25, 'square', 0.06); break;
      case 'whistle-end': blip('sfx', 2100, 0.2, 'square', 0.06); blip('sfx', 2100, 0.35, 'square', 0.06); break;
      case 'win': crowd('sfx', 2.5, 0.5, true); blip('music', 523, 0.6, 'triangle', 0.2, 1046); break;
      case 'lose': blip('music', 392, 0.8, 'sine', 0.18, 196); crowd('sfx', 1.2, 0.2, false); break;
      case 'achievement': blip('sfx', 880, 0.15, 'triangle', 0.2, 1320); blip('sfx', 1320, 0.3, 'triangle', 0.15); break;
      case 'tick': blip('sfx', 1000, 0.04, 'sine', 0.08); break;
    }
    caption(captionFor(name));
  }

  function captionFor(name) {
    return {
      'ui-confirm': 'Confirmed', 'ui-back': 'Back', 'ui-focus': '',
      'invalid': 'Invalid action', 'dive-committed': 'Dive committed',
      'kick': 'Kick struck', 'goal': 'Goal! Crowd roars',
      'save': 'Saved! Gloved away', 'offtarget': 'Off target — crowd groans',
      'whistle-start': 'Whistle: kickoff', 'whistle-end': 'Whistle: full time',
      'win': 'Victory — stadium erupts', 'lose': 'Defeat — quiet crowd',
      'achievement': 'Achievement unlocked', 'tick': 'Timer tick'
    }[name] || '';
  }

  // ---- quiet night ambience loop ----
  function startAmbience() {
    if (!ctx || ambienceNodes) return;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // brown-ish noise, very quiet
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3;
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320;
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(f); f.connect(g); g.connect(buses.ambience);
    src.start();
    ambienceNodes = { src: src };
  }

  // ---- adaptive music: slow two-chord night pad, tension in sudden death ----
  let musicStep = 0;
  function startMusic() {
    if (!ctx || musicTimer) return;
    const roots = [110, 130.81, 98, 146.83];
    musicTimer = setInterval(() => {
      if (!ctx || ctx.state !== 'running') return;
      const root = roots[musicStep % roots.length];
      musicStep++;
      blip('music', root, 1.8, 'sine', 0.08);
      blip('music', root * 1.5, 1.8, 'sine', 0.05);
      if (musicStep % 4 === 0) blip('music', root * 2, 1.2, 'triangle', 0.04);
    }, 1900);
  }
  function setTension(on) {
    if (buses.music && ctx) buses.music.gain.setTargetAtTime(levels.music * (on ? 1.35 : 1), ctx.currentTime, 0.4);
  }

  // Background tab: duck everything; decorative motion handled by renderer.
  function setBackgrounded(bg) {
    if (!ctx) return;
    for (const name of Object.keys(buses)) {
      buses[name].gain.setTargetAtTime(bg ? levels[name] * 0.15 : levels[name], ctx.currentTime, 0.2);
    }
  }

  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

  return {
    unlock: unlock, event: event, onCaption: onCaption,
    setLevel: setLevel, getLevels: getLevels,
    setTension: setTension, setBackgrounded: setBackgrounded,
    suspend: suspend, resume: resume
  };
});
