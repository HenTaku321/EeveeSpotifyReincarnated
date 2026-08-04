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

test("native commands cannot cancel an in-flight lyrics save", () => {
  const controller = read("LyricsTimelineEditorViewController.swift");
  const perform = controller.slice(
    controller.indexOf("private func perform(request:"),
    controller.indexOf("private func sendSaveResult"),
  );

  assert.match(controller, /private var requestTasks: \[UUID: URLSessionDataTask\] = \[:\]/);
  assert.match(controller, /private var requestSessions: \[UUID: URLSession\] = \[:\]/);
  assert.match(controller, /private var requestDelegates: \[UUID: LyricsShareEditorSessionDelegate\] = \[:\]/);
  assert.match(perform, /requestTasks\[id\] = task/);
  assert.match(perform, /requestSessions\.removeValue\(forKey: id\)/);
  assert.doesNotMatch(perform, /requestTask\?\.cancel\(\)|requestSession\?\.invalidateAndCancel\(\)/);
});

test("a successful lyrics save requires a fresh valid semantic hash", () => {
  const controller = read("LyricsTimelineEditorViewController.swift");
  const finishSave = controller.slice(
    controller.indexOf("private func finishSave"),
    controller.indexOf("private func perform(request:"),
  );

  assert.match(finishSave, /guard let rawHash = object\?\["hash"\] as\? String,/);
  assert.match(finishSave, /Self\.isHash\(rawHash\)/);
  assert.doesNotMatch(finishSave, /\?\? activeHash/);
});
