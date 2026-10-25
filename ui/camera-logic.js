"use strict";
/* The printer camera's full size (printers.js): where the picture is drawn
   in its box. Pure, for scripts/test-camera.js. */

/* The rectangle an image of imgW × imgH takes in a box of boxW × boxH with
   object-fit: contain — centred, the bands left around it empty. No image
   size yet: the whole box. */
function camPictureRect(boxW, boxH, imgW, imgH) {
  if (!(imgW > 0 && imgH > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, w: Math.max(0, boxW || 0), h: Math.max(0, boxH || 0) };
  const s = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * s, h = imgH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/* Whether a point of the box is on the picture (its edge included). */
const camInside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

if (typeof module !== "undefined") module.exports = { camPictureRect, camInside };
