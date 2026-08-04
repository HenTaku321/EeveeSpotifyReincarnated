"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "Sources/EeveeSpotify/ShareEditor");

function read(name) {
  return fs.readFileSync(path.join(sourceDir, name), "utf8");
}

test("native timeline bridge exposes authenticated segment GET and revisioned PUT", () => {
  const configuration = read("LyricsShareEditorConfiguration.swift");
  const controller = read("LyricsTimelineEditorViewController.swift");

  assert.match(configuration, /segmentsEndpointPath\s*=\s*"v1\/segments"/);
  assert.match(configuration, /let segmentsEndpointURL: URL/);
  assert.match(controller, /case segmentsGet/);
  assert.match(controller, /case segmentsPut/);
  assert.match(controller, /case "segmentsGet"/);
  assert.match(controller, /case "segmentsPut"/);
  assert.match(controller, /URLQueryItem\(name: "trackId", value: track\.trackId\)/);
  assert.match(controller, /case \.segmentsPut:[\s\S]{0,180}method = "PUT"/);
  assert.match(controller, /X-MITM-Lyrics-Token/);
  assert.doesNotMatch(controller, /URLQueryItem\(name: "(?:token|auth|key)"/);
});

test("native conflict callback includes the server document for explicit user resolution", () => {
  const controller = read("LyricsTimelineEditorViewController.swift");
  assert.match(controller, /if let document = serverObject\?\["document"\] as\? \[String: Any\]/);
  assert.match(controller, /error\["document"\] = document/);
});
