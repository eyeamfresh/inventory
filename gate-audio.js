/* =============================================================================
   FRESH COLLECTIBLES — LOGIN THEME  (gate-audio.js)
   -----------------------------------------------------------------------------
   Plays "A Journey Awaits" behind the login gate on the two protected pages:

       inventory.html      add-item.html

   Rules
     - Only sounds while the gate is up. The moment it dissolves the track fades
       out and the page goes quiet.
     - These two pages do not load audio-vault.js at all: the floating SOUND
       dock lives on the public pages, and the login screens have no player.
     - The theme always plays, whatever the dock's on/off setting says. It is
       part of the login screen, not background music.
     - Chrome/Safari refuse to start audio until the visitor has interacted
       with the page. play() is tried on load; while the browser is still
       refusing, a small "TAP FOR SOUND" chip sits in the gate footer. The
       first tap, key press or focus anywhere starts it too, so the chip is
       only a hint, never a requirement.

   No dependencies. Loaded instead of audio-vault.js on both login pages.
   ========================================================================== */
(function () {
  "use strict";

  var SRC = "a-journey-awaits.mp3?v=1";
  var TARGET = 0.45;          /* comfortable under a voiceover-free UI */
  var FADE_IN = 1400;
  var FADE_OUT = 700;

  var audio = null;
  var fadeTimer = null;
  var musicOn = false;
  var armed = false;
  var lastLocked = null;
  var hint = null;

  function gateEl() {
    return document.getElementById("loginGate");
  }

  function isLocked() {
    var g = gateEl();
    if (g) return !g.classList.contains("is-gone");
    return document.body.classList.contains("locked");
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = document.createElement("audio");
    audio.src = SRC;
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = 0;
    audio.setAttribute("playsinline", "");
    audio.setAttribute("aria-hidden", "true");
    audio.style.display = "none";
    document.body.appendChild(audio);
    return audio;
  }

  function fadeTo(target, ms, done) {
    var a = ensureAudio();
    if (fadeTimer) {
      window.clearInterval(fadeTimer);
      fadeTimer = null;
    }
    var from = a.volume;
    var steps = Math.max(1, Math.round(ms / 40));
    var i = 0;
    fadeTimer = window.setInterval(function () {
      i++;
      var v = from + (target - from) * (i / steps);
      try {
        a.volume = Math.max(0, Math.min(1, v));
      } catch (e) {}
      if (i >= steps) {
        window.clearInterval(fadeTimer);
        fadeTimer = null;
        if (done) done();
      }
    }, 40);
  }

  /* ------------------------------------------------------- "tap for sound" */
  function showHint() {
    if (hint || musicOn || !isLocked()) return;
    var foot = document.querySelector("#loginGate .gate-foot");
    if (!foot) return;

    hint = document.createElement("button");
    hint.type = "button";
    hint.id = "gateAudioHint";
    hint.textContent = "\u266A ENABLE SOUND";
    hint.setAttribute("aria-label", "Start the login theme");
    hint.style.cssText = [
      "margin-left:auto",
      "padding:2px 7px",
      "border:1px solid rgba(0,243,255,0.45)",
      "border-radius:4px",
      "background:rgba(0,243,255,0.08)",
      "color:#9fe9ff",
      "font-family:'Share Tech Mono',monospace",
      "font-size:8px",
      "letter-spacing:0.18em",
      "text-transform:uppercase",
      "cursor:pointer",
    ].join(";");
    hint.addEventListener("click", function (ev) {
      ev.stopPropagation();
      startMusic();
    });
    foot.appendChild(hint);
  }

  function hideHint() {
    if (!hint) return;
    try { hint.remove(); } catch (e) {}
    hint = null;
  }

  /* ------------------------------------------------------------- playback */
  function armGesture() {
    if (armed) return;
    armed = true;
    ["pointerdown", "mousedown", "touchstart", "keydown", "click", "focusin"].forEach(function (ev) {
      window.addEventListener(ev, function () {
        if (isLocked()) startMusic();
      }, { passive: true, capture: true });
    });
  }

  function startMusic() {
    if (musicOn) return;
    if (!isLocked()) return;

    var a = ensureAudio();
    a.volume = 0;

    var p = a.play();
    if (!p || typeof p.then !== "function") {
      musicOn = true;
      hideHint();
      fadeTo(TARGET, FADE_IN);
      return;
    }
    p.then(function () {
      musicOn = true;
      hideHint();
      fadeTo(TARGET, FADE_IN);
    }).catch(function () {
      musicOn = false;
      armGesture();                        /* wait for a real gesture */
      showHint();                          /* and say so, quietly */
    });
  }

  function stopMusic() {
    if (!audio) return;
    musicOn = false;
    hideHint();
    fadeTo(0, FADE_OUT, function () {
      try { audio.pause(); } catch (e) {}
    });
  }

  function sync() {
    var locked = isLocked();
    if (locked) {
      if (lastLocked !== true) startMusic();
    } else if (lastLocked === true) {
      stopMusic();
    }
    lastLocked = locked;
  }

  function boot() {
    var gate = gateEl();
    if (!gate) return;                     /* public pages have no gate */

    new MutationObserver(sync).observe(gate, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    sync();
    armGesture();

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && isLocked() && musicOn) {
        var p = audio && audio.play();
        if (p && p.catch) p.catch(function () {});
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
