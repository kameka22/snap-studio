// node scripts/test-camera.js — the camera's picture in its full-size box.
const assert = require("assert");
const C = require("../ui/camera-logic.js");

// A box wider than the picture: bands left and right.
assert.deepStrictEqual(C.camPictureRect(1600, 900, 640, 480), { x: 200, y: 0, w: 1200, h: 900 });
// Taller than the picture: bands above and below.
assert.deepStrictEqual(C.camPictureRect(800, 1000, 1280, 720), { x: 0, y: 275, w: 800, h: 450 });
// Same shape: no band.
assert.deepStrictEqual(C.camPictureRect(1280, 720, 640, 360), { x: 0, y: 0, w: 1280, h: 720 });
// No frame yet (naturalWidth 0) or an empty box: the whole box.
assert.deepStrictEqual(C.camPictureRect(800, 600, 0, 0), { x: 0, y: 0, w: 800, h: 600 });
assert.deepStrictEqual(C.camPictureRect(0, 0, 640, 480), { x: 0, y: 0, w: 0, h: 0 });
assert.deepStrictEqual(C.camPictureRect(800, 600, undefined, 480), { x: 0, y: 0, w: 800, h: 600 });

// On the picture or beside it.
const r = C.camPictureRect(1600, 900, 640, 480);
assert.strictEqual(C.camInside(r, 800, 450), true, "centre");
assert.strictEqual(C.camInside(r, 100, 450), false, "left band");
assert.strictEqual(C.camInside(r, 1500, 450), false, "right band");
assert.strictEqual(C.camInside(r, 200, 0), true, "edge counts as the picture");
assert.strictEqual(C.camInside(C.camPictureRect(800, 600, 0, 0), 5, 5), true, "no frame: the whole box");

console.log("camera: ok");
