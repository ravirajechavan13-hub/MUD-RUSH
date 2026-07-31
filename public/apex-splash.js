/*!
 * APEX SPLASH — drop-in starting animation (5 sec, no loading bar)
 * ----------------------------------------------------------------
 * Use (game ke index.html me <body> ke andar sabse upar):
 *
 *   <script src="apex-splash.js"></script>
 *
 * Bas itna. 5 second baad apne aap hat jayega aur game dikhne lagega.
 *
 * Optional settings (script tag se pehle):
 *   <script>
 *     window.APEX_SPLASH = {
 *       title: "APE|X",      // "|" ke baad ka hissa orange hoga
 *       sub: "ENGINE",       // niche ka chhota text ("" = hata do)
 *       duration: 5000,      // total time (ms)
 *       waitForGame: false   // true = jab tak ApexSplash.done() na ho, splash rukega
 *     };
 *   </script>
 *
 * Manual close (jab game load ho jaye):
 *   ApexSplash.done();
 */
(function () {
  "use strict";

  var cfg = window.APEX_SPLASH || {};
  var TOTAL = cfg.duration || 5000;
  var FADE = 600;
  var HOLD = Math.max(TOTAL - FADE, 600);
  var TITLE = cfg.title || "APE|X";
  var SUB = cfg.sub === undefined ? "ENGINE" : cfg.sub;
  var WAIT = !!cfg.waitForGame;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var parts = TITLE.split("|");
  var titleHTML = esc(parts[0]) + (parts[1] ? "<span>" + esc(parts[1]) + "</span>" : "");

  /* ---------- styles ---------- */
  var css =
    "#apex-splash{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;" +
    'overflow:hidden;font-family:"Courier New",Courier,monospace;color:#eef2f7;' +
    "background:radial-gradient(circle at 50% 50%,rgba(255,108,44,.15),transparent 46%)," +
    "radial-gradient(circle at 50% 92%,rgba(255,150,60,.06),transparent 55%),#080a0d}" +
    "#apex-splash *{box-sizing:border-box}" +
    "#apex-splash.ax-out{animation:ax-out .6s ease-in forwards}" +
    "#apex-splash .ax-scan{position:absolute;inset:0;opacity:.5;pointer-events:none;" +
    "background:repeating-linear-gradient(180deg,rgba(255,255,255,.022) 0 1px,transparent 1px 4px)}" +
    "#apex-splash .ax-bloom{position:absolute;top:50%;left:50%;width:min(94vw,640px);height:min(94vw,640px);" +
    "border-radius:50%;filter:blur(30px);transform:translate(-50%,-50%);" +
    "background:radial-gradient(circle,rgba(255,112,40,.2),transparent 62%);animation:ax-bloom 3.4s ease-in-out infinite}" +
    "#apex-splash .ax-center{position:relative;display:grid;justify-items:center;text-align:center}" +
    "#apex-splash .ax-logo{width:clamp(130px,32vw,210px);height:auto;overflow:visible;" +
    "margin-bottom:clamp(20px,4.5vh,34px);filter:drop-shadow(0 0 22px rgba(255,110,45,.35));" +
    "animation:ax-logo .9s cubic-bezier(.16,1,.3,1) both}" +
    "#apex-splash .ax-o{stroke:#ff6a2c;stroke-width:7;stroke-linecap:round;stroke-linejoin:round;" +
    "stroke-dasharray:420;stroke-dashoffset:420;filter:drop-shadow(0 0 8px rgba(255,106,44,.8));" +
    "animation:ax-draw 1.1s .15s cubic-bezier(.65,0,.35,1) forwards}" +
    "#apex-splash .ax-i{stroke:#34e2c2;stroke-width:7;stroke-linecap:round;stroke-linejoin:round;" +
    "stroke-dasharray:220;stroke-dashoffset:220;filter:drop-shadow(0 0 8px rgba(52,226,194,.75));" +
    "animation:ax-draw .9s .75s cubic-bezier(.65,0,.35,1) forwards}" +
    "#apex-splash .ax-b{stroke:#ffb547;stroke-width:6;stroke-linecap:round;stroke-dasharray:132;" +
    "stroke-dashoffset:132;filter:drop-shadow(0 0 10px rgba(255,181,71,.9));" +
    "animation:ax-draw .7s 1.15s ease-out forwards}" +
    "#apex-splash .ax-s{fill:#ff7a35;opacity:0;filter:drop-shadow(0 0 10px #ff8b3d);" +
    "animation:ax-sp .5s 1.15s ease-out forwards,ax-pulse 2.2s 1.7s ease-in-out infinite}" +
    "#apex-splash h1{margin:0;color:#f2f6fb;font-family:Arial,Helvetica,sans-serif;font-weight:800;" +
    "font-size:clamp(3.4rem,16vw,7rem);line-height:.95;letter-spacing:.04em;text-indent:.04em;" +
    "animation:ax-word .9s 1.1s cubic-bezier(.16,1,.3,1) both}" +
    "#apex-splash h1 span{color:#ff6a2c;text-shadow:0 0 26px rgba(255,106,44,.55)}" +
    "#apex-splash .ax-sub{margin:clamp(10px,1.8vh,16px) 0 0;color:#7d8794;" +
    "font-size:clamp(.7rem,2.8vw,1rem);letter-spacing:.58em;text-indent:.58em;" +
    "animation:ax-sub .8s 1.45s cubic-bezier(.16,1,.3,1) both}" +
    "@keyframes ax-draw{to{stroke-dashoffset:0}}" +
    "@keyframes ax-logo{from{opacity:0;transform:translateY(18px) scale(.86)}to{opacity:1;transform:none}}" +
    "@keyframes ax-sp{from{opacity:0;transform:scale(.2)}to{opacity:1;transform:scale(1)}}" +
    "@keyframes ax-pulse{0%,100%{opacity:.65}50%{opacity:1}}" +
    "@keyframes ax-word{from{opacity:0;letter-spacing:.35em;transform:translateY(20px);filter:blur(10px)}" +
    "to{opacity:1;letter-spacing:.04em;transform:none;filter:blur(0)}}" +
    "@keyframes ax-sub{from{opacity:0;letter-spacing:1em}to{opacity:1;letter-spacing:.58em}}" +
    "@keyframes ax-bloom{0%,100%{opacity:.55;transform:translate(-50%,-50%) scale(.9)}" +
    "50%{opacity:1;transform:translate(-50%,-50%) scale(1.08)}}" +
    "@keyframes ax-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(1.04)}}";

  /* ---------- markup ---------- */
  var html =
    '<div class="ax-scan"></div><div class="ax-bloom"></div>' +
    '<div class="ax-center">' +
    '<svg class="ax-logo" viewBox="0 0 200 170" fill="none" aria-hidden="true">' +
    '<path class="ax-o" d="M100 22 178 152H22L100 22Z"/>' +
    '<path class="ax-i" d="M100 84 137 152H63L100 84Z"/>' +
    '<path class="ax-b" d="M34 152h132"/>' +
    '<circle class="ax-s" cx="100" cy="22" r="5"/></svg>' +
    "<h1>" + titleHTML + "</h1>" +
    (SUB ? '<p class="ax-sub">' + esc(SUB) + "</p>" : "") +
    "</div>";

  var el, tFade, tEnd, finished = false, startAt = 0;

  function mount() {
    if (document.getElementById("apex-splash")) return;

    var style = document.createElement("style");
    style.id = "apex-splash-style";
    style.textContent = css;
    document.head.appendChild(style);

    el = document.createElement("div");
    el.id = "apex-splash";
    el.innerHTML = html;
    document.body.appendChild(el);

    startAt = performance.now();
    if (!WAIT) tFade = setTimeout(close, HOLD);
  }

  function close() {
    if (finished || !el) return;
    finished = true;
    clearTimeout(tFade);
    el.classList.add("ax-out");
    tEnd = setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      var s = document.getElementById("apex-splash-style");
      if (s && s.parentNode) s.parentNode.removeChild(s);
      window.dispatchEvent(new Event("apex-splash-end"));
      if (typeof cfg.onDone === "function") cfg.onDone();
    }, FADE);
  }

  /* public API */
  window.ApexSplash = {
    /* game ready hone par call karo — minimum time pura hone ke baad hatega */
    done: function () {
      var left = HOLD - (performance.now() - startAt);
      if (left > 0) setTimeout(close, left);
      else close();
    },
    /* turant band karo */
    hide: close,
    /* dobara chalao (testing) */
    replay: function () {
      finished = false;
      clearTimeout(tEnd);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
      mount();
    },
  };

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
