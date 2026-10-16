/* Address of one of the app's own protocols (thumb, cam, mesh, gcode).

   Tauri serves a custom protocol as `<scheme>://localhost/…` on macOS and
   Linux, but WebView2 (Windows) cannot: there it is `http://<scheme>.localhost/…`.
   A hard-coded `thumb://` URL is never loaded on Windows, and an <img> has
   no fallback: the thumbnail stays a gray placeholder. */
const IS_WINDOWS = /Windows/i.test(navigator.userAgent || "");

function schemeUrl(scheme, rest, windows = IS_WINDOWS) {
  return (windows ? `http://${scheme}.localhost` : `${scheme}://localhost`) + rest;
}

/* Both forms, the platform's first: for fetch() callers that try in turn. */
function schemeBases(scheme, windows = IS_WINDOWS) {
  const a = `${scheme}://localhost`, b = `http://${scheme}.localhost`;
  return windows ? [b, a] : [a, b];
}

/* Thumbnail of a file: `path` is sent as is (encoded), backslashes,
   drive letters and UNC paths included — the backend decodes it. */
function thumbSrc(path, size, kind = 0, version) {
  return schemeUrl("thumb", `/t?p=${encodeURIComponent(path)}&s=${size}&k=${kind}${version != null ? `&v=${version}` : ""}`);
}

if (typeof module !== "undefined") module.exports = { schemeUrl, schemeBases, thumbSrc };
