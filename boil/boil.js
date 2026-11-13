/*
 * Self-Healing boil animations
 *
 * Stop-motion "boil" cel animations built from the 19 cut-paper pieces in the
 * intro screen on self-healing.art, driven the same way the intro is:
 *   - each piece is normalised to 150 units tall and centred on its anchor,
 *     and every piece stays that one size: pictures are made only by
 *     placing, overlapping and turning pieces
 *   - every piece sits at translate(x y) rotate(r) scale(s)
 *   - 10 jitter frames are pre-rolled with the same seeded RNG (1234):
 *     +/-4 units of shift and +/-2.5 degrees of turn per piece
 *   - the frames are stepped at 7 fps, so the pieces "boil" like re-shot cels
 *   - pieces start in the intro's face and ease (cubic in-out, 1s, after a
 *     1.2s hold) into the new picture, exactly like the intro's face-to-heart;
 *     pieces a picture doesn't need fade out under it, as in the intro
 *
 * Usage:
 *   <div data-boil="smiley"></div>
 *   <div data-boil="palette"></div>
 *   <script src="boil.js"></script>
 *
 * Options (data attributes):
 *   data-boil-from="none"   skip the face-to-picture assembly, just boil
 */
(function () {
  "use strict";

  // The intro's pieces, verbatim: path, natural size, fill, and their spot in
  // the intro face as [x, y, rotation, scale].
  var PIECES = [
    /*  0 */ {d:"M0,118.89l22.84,3.87,97.05-3.87-1.22-29.77L121.49.37C81.24-.75.73,1.04.73,1.04l-.73,117.86Z",w:121.49,h:122.76,fill:"#a83c44",face:[612,734,0,1]},
    /*  1 */ {d:"M8.16 0 0 104.42 117.44 104.42 111.32 74.6 96.64 44.85 73.81 22.84 37.11 6.52 8.16 0Z",w:117.44,h:104.42,fill:"#6d8566",face:[752,1005,0,0.85]},
    /*  2 */ {d:"M116.21 97.89 117.03 0 0 1.63 2.93 101.97 116.21 97.89Z",w:117.03,h:101.97,fill:"#64843f",face:[744,600,0,0.94]},
    /*  3 */ {d:"M115.16 96.26 119.07 1.63 1.22 0 0 97.89 115.16 96.26Z",w:119.07,h:97.89,fill:"#738f57",face:[474,1008,0,0.82]},
    /*  4 */ {d:"M7.75 101.97 117.03 97.89 118.25 0 81.15 0 37.92 22.84 1.22 60.35 0 89.3 7.75 101.97Z",w:118.25,h:101.97,fill:"#64843f",face:[329,1016,0,0.87]},
    /*  5 */ {d:"M112.82,0l-18.19,1.84L0,0v114.5c27.65,0,54.21,2.03,81.85,1.2,11.46,0,21.71-1.17,31.54-2.91l1.88-8.85L112.82,0Z",w:115.27,h:115.9,fill:"#64843f",face:[331,345,0,1]},
    /*  6 */ {d:"M84.02,1.2C56.38,2.03,28.73,2.39,1.09,2.4L0,119.15l6.72,3.87,46.54-11.61,28.9-14.68,18.02-28.95,14.81-42.03,1.68-24.97c-10.34-1.96-21.19.42-32.65.42Z",w:116.67,h:123.02,fill:"#a83c44",face:[748,738,0,1]},
    /*  7 */ {d:"M0,1.46v111.07c37.9,1.03,75.8,4.39,113.7,4.37L110.67,0,0,1.46Z",w:113.7,h:116.9,fill:"#738f57",face:[329,603,0,1]},
    /*  8 */ {d:"M0,3.94v127.09h112.37l1.7-116.62-.37-14.4C75.8.02,37.84,1.17,0,3.94Z",w:114.07,h:131.02,fill:"#a83c44",face:[486,737,0,1]},
    /*  9 */ {d:"M.46,8.56L.06,65.65v44.85l-.06,8.92c40.24,1.61,82.73,3.15,122.97,4.27L124.66,0,.46,8.56Z",w:124.66,h:123.69,fill:"#64843f",face:[468,600,0,1]},
    /* 10 */ {d:"M117.44,0L0,2.04l5.42,107.14c33.41,1.3,68.85,1.75,101.92,3.16,6.49.26,15.48-2.16,21.97-1.9l-4.54-65.59L117.44,0Z",w:129.32,h:112.36,fill:"#64843f",face:[599,596,0,0.86]},
    /* 11 */ {d:"M0,.43l3.04,43.41,3.91,22.02,21.2,28.54,22.02,22.02,30.17,6.52,42.41,1.22L119.09,1.2c-6.49-.26-12.99-1.21-19.47-.78C67.2,2.54,35.48-1.22,0,.43Z",w:122.76,h:124.17,fill:"#a83c44",face:[334,738,0,1]},
    /* 12 */ {d:"M1.69,0v70.19l-1.69,14.58s39.55,5.32,49.7,0,50.46-29.41,52.74-49.7c2.28-20.28,3.55-33.98,3.55-33.98L44.63,0H1.69Z",w:105.99,h:87.13,fill:"#1f231e",face:[750,473,0,0.8]},
    /* 13 */ {d:"M0 3.22 108.82 0 108.82 86.33 57.31 86.33 25.11 68.9 11.59 47.65 6.44 36.7 3.86 30.26 0 22.54 0 14.81 0 3.22Z",w:108.82,h:86.33,fill:"#e8d9a9",face:[609,477,0,0.83]},
    /* 14 */ {d:"M0,130.73h237.84v-48.83l-11.03-34.65-40.95-33.08L118.92,0l-48.04,14.18S31.5,28.35,18.9,50.4C6.3,72.46,0,130.73,0,130.73Z",w:237.84,h:130.73,fill:"#618729",face:[676,337,0,1]},
    /* 15 */ {d:"M0,0v89.74s53.11,4.44,65.28-16.89c5.98-10.48,13.41-22.15,19.42-31.32,6.85-10.44,8.39-23.48,4.18-35.23l-1.93-5.4L0,0Z",w:91.22,h:90.13,fill:"#1f231e",face:[480,479,0,0.87]},
    /* 16 */ {d:"M0,3.91L89.45.48l20.36-.48v95.85s-55.54,5.72-68.5-9.59C28.36,70.96,4.29,35.47,4.29,35.47L0,3.91Z",w:109.81,h:96.9,fill:"#e8d9a9",face:[325,479,0,0.86]},
    /* 17 */ {d:"M.57,0v64.83l-.57,54.36,23.18,3.27h85.22V57.18l-13.91-31.97S66,5.65,45.13,4.52C24.27,3.38.57,0,.57,0Z",w:108.39,h:122.46,fill:"#64843f",face:[480,335,0,1]},
    /* 18 */ {d:"M0 0 0 89.14 0 122.46 59.13 122.46 106.09 122.46 106.09 65.73 106.09 15.76 106.09 .9 0 0Z",w:106.09,h:122.46,fill:"#64843f",face:[614,1003,0,1]}
  ];

  // Every piece keeps one size, the intro's own: 150 units tall at scale 1.
  // Pictures are built only by placing, overlapping and turning pieces.
  var SIZE = 1;

  // Place pieces around an ellipse, each turned so its top edge faces out.
  // Each item is [piece, angle, extraTurn?].
  function ring(cx, cy, rx, ry, items) {
    return items.map(function (it) {
      var a = (it[1] * Math.PI) / 180;
      return [it[0], cx + rx * Math.cos(a), cy + ry * Math.sin(a), it[1] + 90 + (it[2] || 0)];
    });
  }

  // Place pieces along an arc, each turned so its bottom edge faces out
  // (used for the grin). Each item is [piece, angle, extraTurn?].
  function smile(cx, cy, r, items) {
    return items.map(function (it) {
      var a = (it[1] * Math.PI) / 180;
      return [it[0], cx + r * Math.cos(a), cy + r * Math.sin(a), it[1] - 90 + (it[2] || 0)];
    });
  }

  // Each layout is a draw-ordered list of [piece, x, y, rotation], in the same
  // coordinate space as the intro face (centre ~ 545, 675).
  var CX = 545, CY = 675;
  // Turn a whole layout around a point, baking the turn into each piece.
  function tilt(layout, deg, cx, cy) {
    var a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return layout.map(function (p) {
      var dx = p[1] - cx, dy = p[2] - cy;
      return [p[0], cx + dx * c - dy * s, cy + dx * s + dy * c, p[3] + deg, p[4]];
    });
  }

  function at(cx, cy, items) {
    return items.map(function (it) { return [it[0], cx + it[1], cy + it[2], it[3] || 0, it[4]]; });
  }

  var LAYOUTS = {
    // Built like the intro face: a rough grid of full-size pieces, with the
    // features as cells in the grid.
    smiley: at(CX, CY, [
      // forehead: cut corner, dome, curved corner
      [4, -175, -205, 0], [14, 0, -215, 0], [17, 175, -205, 0],
      // eye row and mouth-corner row, greens at the edges and between
      [7, -268, -70, 0], [9, 0, -70, 0], [2, 268, -70, 0],
      [3, -262, 72, 0], [10, 0, 66, 0], [18, 262, 72, 0],
      // chin: rounded corners turned down
      [5, -165, 205, 180], [1, 175, 200, 90],
      // eyes: a sliver of cream behind each black piece, like the intro's eyes
      [16, -158, -98, -6], [13, 158, -98, 6],
      [15, -132, -70, 0], [12, 132, -70, 90],
      // the smile: reds turned up at the corners, rounded ends outward
      [11, -138, 80, 28], [6, 138, 80, -28],
      [8, -68, 192, 8], [0, 68, 192, -8]
    ]),
    palette: tilt(at(CX, CY, [
      // pieces the palette doesn't need tuck under the board and fade,
      // the way the intro fades the pieces its heart doesn't use
      [8, 40, 0, 0, "hide"], [6, 40, 0, 0, "hide"], [12, 40, 0, 0, "hide"],
      [16, 40, 0, 0, "hide"],
      // the board: 3-5-3 rows of greens, an oval with the dome on top
      [4, -165, -140, 0], [14, 10, -150, 0], [17, 185, -140, 0],
      [7, -330, 0, 0], [9, -170, 0, 0], [10, 0, 0, 0], [2, 170, 0, 0], [1, 330, 0, 90],
      [3, -150, 140, 0], [18, 10, 145, 0], [5, 170, 140, 180],
      // thumb hole
      [15, -235, 35, -20],
      // paint dabs, green showing between them
      [11, -25, -75, -40],
      [13, 150, -70, 25],
      [0, 120, 110, 45]
    ]), -8, CX, CY)
  };

  // Each picture's frame: a square holding both the intro face it starts as
  // and the finished picture.
  var FRAMING = {
    smiley: { viewBox: "105 235 880 880" },
    palette: { viewBox: "105 235 880 880" }
  };
  var FPS = 7, FRAMES = 10, HOLD = 1.2, MORPH = 1;

  // Same RNG, seed and frame recipe as the intro.
  var seed = 1234;
  function rand() {
    var e = Math.imul((seed = (seed + 0x6d2b79f5) | 0) ^ (seed >>> 15), 1 | seed);
    return (((e = (e + Math.imul(e ^ (e >>> 7), 61 | e)) ^ e) ^ (e >>> 14)) >>> 0) / 4294967296;
  }
  var JITTER = [];
  for (var f = 0; f < FRAMES; f++) {
    JITTER.push(PIECES.map(function () {
      return [(2 * rand() - 1) * 4, (2 * rand() - 1) * 4, (2 * rand() - 1) * 2.5];
    }));
  }

  var NS = "http://www.w3.org/2000/svg";
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function xf(x, y, r, s) { return "translate(" + x + " " + y + ") rotate(" + r + ") scale(" + s + ")"; }

  function mount(el, name, opts) {
    opts = opts || {};
    var layout = LAYOUTS[name];
    if (!layout) throw new Error("Unknown boil layout: " + name);
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var assemble = opts.from !== "none" && !reduce;

    var svg = document.createElementNS(NS, "svg");
    var frame = FRAMING[name];
    svg.setAttribute("viewBox", frame.viewBox);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.label || (name === "smiley" ? "A cut-paper smiley face" : "A cut-paper painter's palette"));
    svg.style.display = "block";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";

    var nodes = layout.map(function (spot) {
      var p = PIECES[spot[0]], n = 150 / p.h;
      var g = document.createElementNS(NS, "g");
      var path = document.createElementNS(NS, "path");
      path.setAttribute("d", p.d);
      path.setAttribute("fill", p.fill);
      path.setAttribute("transform", "translate(" + (-p.w * n / 2) + " -75) scale(" + n + ")");
      g.appendChild(path);
      svg.appendChild(g);
      var f = p.face;
      return { g: g, from: [f[0], f[1], f[2], SIZE], to: [spot[1], spot[2], spot[3], SIZE], i: spot[0], hide: spot[4] === "hide" };
    });
    el.appendChild(svg);

    function draw(progress, frame) {
      var jit = frame == null ? null : JITTER[frame];
      nodes.forEach(function (node) {
        var a = node.from, b = node.to;
        var j = jit ? jit[node.i] : [0, 0, 0];
        node.g.setAttribute("transform", xf(
          lerp(a[0], b[0], progress) + j[0],
          lerp(a[1], b[1], progress) + j[1],
          lerp(a[2], b[2], progress) + j[2],
          SIZE
        ));
        if (node.hide) node.g.style.opacity = String(1 - Math.min(1, 1.5 * progress));
      });
    }

    if (reduce) { draw(1, null); return { destroy: function () { el.removeChild(svg); } }; }

    var raf = 0, start = 0, running = false, lastFrame = -1, lastProgress = -1;
    function tick(now) {
      if (!start) start = now;
      var t = (now - start) / 1000;
      var progress = assemble ? ease(Math.min(1, Math.max(0, (t - HOLD) / MORPH))) : 1;
      var frame = Math.floor(t * FPS) % FRAMES;
      // only touch the DOM when the cel actually changes
      if (frame !== lastFrame || progress !== lastProgress) {
        draw(progress, frame);
        lastFrame = frame; lastProgress = progress;
      }
      raf = requestAnimationFrame(tick);
    }
    function play() { if (!running) { running = true; raf = requestAnimationFrame(tick); } }

    draw(assemble ? 0 : 1, 0);

    // Only animate while on screen; the assembly plays the first time it is seen.
    var io = null, pausedAt = 0;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            if (pausedAt && start) start += performance.now() - pausedAt;
            pausedAt = 0; play();
          } else if (running) {
            pausedAt = performance.now(); running = false; cancelAnimationFrame(raf);
          }
        });
      }, { threshold: 0.35 });
      io.observe(el);
    } else {
      play();
    }

    return {
      destroy: function () {
        cancelAnimationFrame(raf);
        if (io) io.disconnect();
        el.removeChild(svg);
      }
    };
  }

  function autoMount() {
    var els = document.querySelectorAll("[data-boil]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.__boil) continue;
      el.__boil = mount(el, el.getAttribute("data-boil"), {
        from: el.getAttribute("data-boil-from"),
        label: el.getAttribute("aria-label")
      });
    }
  }

  window.SelfHealingBoil = { mount: mount, layouts: Object.keys(LAYOUTS) };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();
})();
