// node scripts/test-scheme.js — protocol URLs on Windows and macOS/Linux.
const assert = require("assert");
global.navigator = { userAgent: "" };
const { schemeUrl, schemeBases, thumbSrc } = require("../ui/scheme.js");

assert.equal(schemeUrl("thumb", "/t?x=1", false), "thumb://localhost/t?x=1");
assert.equal(schemeUrl("thumb", "/t?x=1", true), "http://thumb.localhost/t?x=1");
assert.deepEqual(schemeBases("mesh", true), ["http://mesh.localhost", "mesh://localhost"]);
assert.deepEqual(schemeBases("mesh", false), ["mesh://localhost", "http://mesh.localhost"]);

// Windows paths survive the query: drive letter, backslashes, spaces, UNC, \\?\.
for (const p of ["C:\\Users\\Ana\\Mes modèles\\pièce #1.3mf", "\\\\NAS\\prints\\a&b.3mf", "\\\\?\\C:\\long\\x.3mf", "/Users/a/b.3mf"]) {
  const u = new URL(thumbSrc(p, 320, 2, 12).replace(/^thumb:\/\/localhost/, "http://x"));
  assert.equal(u.searchParams.get("p"), p);
  assert.equal(u.searchParams.get("s"), "320");
  assert.equal(u.searchParams.get("v"), "12");
}
global.navigator = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/129" };
delete require.cache[require.resolve("../ui/scheme.js")];
assert.ok(require("../ui/scheme.js").thumbSrc("C:\\a.3mf", 46).startsWith("http://thumb.localhost/t?p=C%3A%5Ca.3mf"));
console.log("scheme.js OK");
