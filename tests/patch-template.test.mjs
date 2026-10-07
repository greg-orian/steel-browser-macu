import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  BASE_TEMPLATE_SHA256,
  patchTemplate,
  sha256,
  verifyPatchedTemplate,
} from "../scripts/patch-template.mjs";

const baseImage =
  "ghcr.io/steel-dev/steel-browser@sha256:f5cd68fbc2cb27e5d7766269860fd0fb29cbe5fe506245a49c82f85ba210e7da";

const fixture = [
  "          let tabs = {};",
  "          let activeTabId = null;",
  "          let activeConnectionRetries = {}; // Track reconnection attempts",
  "",
  "          // Default dimensions until we get first image",
  "          const defaultWidth = 1920;",
  "          const defaultHeight = 1080;",
  "",
  "          function createWebSocketUrl(pageId) {",
  "              return 'wss://private.invalid/' + pageId;",
  "          }",
  "",
  "          // Function to establish WebSocket connection for a tab",
  "          function connectTabWebSocket(pageId) {",
  "              const ws = new WebSocket(createWebSocketUrl(pageId));",
  "              tabs[pageId].websocket = ws;",
  "              return ws;",
  "          }",
  "",
  "          // Function to create a new tab",
  "          function createTab(pageId) { return tabs[pageId]; }",
  "",
  "          function activateTab(pageId) {",
  "              if (!tabs[pageId]) return;",
  "              if (activeTabId && tabs[activeTabId]) {",
  "                  tabs[activeTabId].tab.classList.remove('active');",
  "                  tabs[activeTabId].canvasContainer.classList.remove('active');",
  "",
  "                  // Intentionally close the WebSocket for the inactive tab if it exists to save resources",
  "                  if (tabs[activeTabId].websocket &&",
  "                      tabs[activeTabId].websocket.readyState === WebSocket.OPEN) {",
  "                      tabs[activeTabId].intentionalClose = true;",
  "                      tabs[activeTabId].websocket.close();",
  "                      tabs[activeTabId].websocket = null;",
  "                      console.log(`Closed WebSocket for inactive tab ${activeTabId}`);",
  "                  }",
  "              }",
  "              activeTabId = pageId;",
  "              tabs[pageId].tab.classList.add('active');",
  "              tabs[pageId].canvasContainer.classList.add('active');",
  "              if (!tabs[pageId].websocket ||",
  "                  tabs[pageId].websocket.readyState === WebSocket.CLOSED ||",
  "                  tabs[pageId].websocket.readyState === WebSocket.CLOSING) {",
  "                  connectTabWebSocket(pageId);",
  "              }",
  "          }",
  "",
  "          // Function to attempt reconnection for a tab WebSocket",
  "          function attemptReconnect(pageId) {",
  "              tabs[pageId].reconnecting = true;",
  "          }",
  "",
  "          // Set up WebSocket-related event listeners for a canvas",
  "          function setupCanvasEventListeners() {}",
  "",
  "          function testManualNavigation(url) {",
  "                          // Send message to parent frame about manual URL change",
  "                          window.parent.postMessage({",
  "                              type: 'navigation',",
  "                              url: url",
  "                          }, '*');",
  "",
  "                          urlText.blur();",
  "          }",
  "",
  "          function handleTabList(tabList) {",
  "              const currentPageIds = tabList.map(tab => tab.id);",
  "              Object.keys(tabs).forEach(pageId => {",
  "                  if (pageId !== 'tab-discovery' && !currentPageIds.includes(pageId)) {",
  "                      // Only remove DOM elements, don't send closeTab message since",
  "                      // the server already knows this tab is closed",
  "                      closeTab(pageId);",
  "                  }",
  "              });",
  "          }",
  "",
  "          // Function to handle tab closed by server",
  "          function handleTabClosed(pageId) {",
  "              if (!tabs[pageId]) return;",
  "              closeTab(pageId);",
  "          }",
  "",
  "          // Function to close a tab manually",
  "",
  "          function closeTab(pageId) {",
  "              if (!tabs[pageId]) return;",
  "              const tabIndexes = Object.keys(tabs).filter(id => id !== 'tab-discovery');",
  "              if (tabIndexes.length <= 1) return;",
  "              // Intentionally close the WebSocket",
  "              if (tabs[pageId].websocket) {",
  "                  tabs[pageId].intentionalClose = true;",
  "                  tabs[pageId].websocket.send(JSON.stringify({",
  "                      type: 'closeTab',",
  "                      pageId: pageId",
  "                  }));",
  "                  tabs[pageId].websocket.close();",
  "                  tabs[pageId].websocket = null;",
  "              }",
  "              delete tabs[pageId];",
  "          }",
  "",
  "          // Initialize connection - in single-page mode we have only one connection",
  "          function initializeConnection() {}",
  "",
  "          // Add the missing updateCanvasSize function",
  "          function updateCanvasSize(pageId) {",
  "              if (!tabs[pageId]) return;",
  "              const tabData = tabs[pageId];",
  "              const canvas = tabData.canvas;",
  "              const ctx = tabData.ctx;",
  "              if (!ctx) return;",
  "              canvas.width = 1280;",
  "              canvas.height = 720;",
  "              if (tabData.lastImageData) {",
  "                  const img = new Image();",
  "                  img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); };",
  "                  img.src = tabData.lastImageData;",
  "              }",
  "          }",
  "",
  "          // Add a function to handle tab loading state",
  "          function setTabLoadingState() {}",
  "",
  "          let clipboardRequestId = 0;",
  "          const pendingRequests = new Map();",
  "          const originalConnectTabWebSocket = connectTabWebSocket;",
  "          connectTabWebSocket = function(pageId) {",
  "              const ws = originalConnectTabWebSocket(pageId);",
  "",
  "              const originalOnMessage = ws.onmessage;",
  "              ws.onmessage = function(event) {",
  "                  const payload = JSON.parse(event.data);",
  "                  if (payload.type === 'selectedTextResponse') return;",
  "                  originalOnMessage.call(this, event);",
  "              };",
  "              return ws;",
  "          };",
  "",
  "          function testActivate(pageId) {",
  "              activeTabId = pageId;",
  "              const classes = new Set();",
  "              tabs[pageId] = {",
  "                  tab: { classList: { add() {}, remove() {} }, remove() {} },",
  "                  canvas: { width: 1280, height: 720, style: {} },",
  "                  canvasContainer: {",
  "                      clientHeight: 720,",
  "                      classList: {",
  "                          add(value) { classes.add(value); },",
  "                          remove(value) { classes.delete(value); },",
  "                          contains(value) { return classes.has(value); }",
  "                      },",
  "                      style: {},",
  "                      remove() {}",
  "                  },",
  "                  ctx: {",
  "                      drawImage(img) { drawCount += 1; drawnImages.push(img.value); },",
  "                      scale() {},",
  "                      setTransform() {}",
  "                  },",
  "                  frameCount: 0,",
  "                  intentionalClose: false,",
  "                  isLoading: false,",
  "                  reconnecting: false,",
  "                  receivedFirstFrame: false,",
  "                  lastImageData: null,",
  "                  websocket: null",
  "              };",
  "          }",
  "          function testSetActive(pageId) { activeTabId = pageId; }",
].join("\n");

class FakeClock {
  now = 0;
  #nextId = 1;
  #timers = new Map();

  setTimeout = (callback, delay) => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.now + Number(delay), callback });
    return id;
  };

  clearTimeout = (id) => {
    this.#timers.delete(id);
  };

  tick(milliseconds) {
    const target = this.now + milliseconds;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }

  pendingDelays() {
    return [...this.#timers.values()].map((timer) => timer.at - this.now).sort((a, b) => a - b);
  }
}

function buildHarness(patched, options = {}) {
  const clock = new FakeClock();
  const posted = [];
  const constructedAfterMessageCount = [];
  const listeners = new Map();
  const parent = { postMessage(message) { posted.push(structuredClone(message)); } };

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];
    static throwCount = 0;

    constructor(url) {
      constructedAfterMessageCount.push(posted.length);
      if (FakeWebSocket.throwCount > 0) {
        FakeWebSocket.throwCount -= 1;
        throw new Error("private constructor failure");
      }
      this.readyState = FakeWebSocket.CONNECTING;
      this.url = url;
      this.closeCalls = 0;
      FakeWebSocket.instances.push(this);
    }

    send(value) { this.lastSent = value; }
    close() { this.closeCalls += 1; this.readyState = FakeWebSocket.CLOSING; }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    error() { this.onerror?.({ privateDetail: "secret" }); }
    closeEvent(wasClean = false) {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ wasClean, code: 1006, reason: "private detail" });
    }
    message(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  }

  class FakeImage {
    static autoLoad = options.autoLoadImages ?? true;
    static pending = [];
    constructor() { this.naturalWidth = 1280; this.naturalHeight = 720; }
    set src(value) {
      this.value = value;
      if (FakeImage.autoLoad) this.onload?.();
      else FakeImage.pending.push(this);
    }
  }

  const fakeMath = Object.create(Math);
  fakeMath.random = () => options.random ?? 0.5;
  class FakeDate extends Date { static now() { return clock.now; } }
  const window = {
    devicePixelRatio: 1,
    parent,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
  };
  const context = vm.createContext({
    Array,
    Boolean,
    Date: FakeDate,
    Image: FakeImage,
    JSON,
    Map,
    Math: fakeMath,
    Number,
    Object,
    Set,
    WebSocket: FakeWebSocket,
    clearTimeout: clock.clearTimeout,
    console: { log() {}, error() {} },
    document: { activeElement: null },
    drawCount: 0,
    drawnImages: [],
    setConnectionStatus() {},
    setTabLoadingState() {},
    setTimeout: clock.setTimeout,
    structuredClone,
    updateCanvasSize() {},
    updateSecurityIcon() {},
    updateTabInfo() {},
    updateUrlBar() {},
    urlText: { disabled: true, blur() {} },
    window,
  });
  vm.runInContext(patched, context);

  return {
    activateOnly(pageId) { vm.runInContext(`testActivate(${JSON.stringify(pageId)})`, context); },
    closeTab(pageId) { vm.runInContext(`closeTab(${JSON.stringify(pageId)})`, context); },
    connect(pageId) {
      vm.runInContext(`testActivate(${JSON.stringify(pageId)})`, context);
      return vm.runInContext(`connectTabWebSocket(${JSON.stringify(pageId)})`, context);
    },
    connectDiscovery() { return vm.runInContext("connectTabWebSocket('tab-discovery')", context); },
    controller(pageId) {
      return vm.runInContext(`macuTransportControllers.get(${JSON.stringify(pageId)})`, context);
    },
    dispatch(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener(event); },
    reconcile(pageIds) {
      vm.runInContext(`handleTabList(${JSON.stringify(pageIds.map((id) => ({ id })))})`, context);
    },
    serverClose(pageId) { vm.runInContext(`handleTabClosed(${JSON.stringify(pageId)})`, context); },
    setActive(pageId) { vm.runInContext(`testSetActive(${JSON.stringify(pageId)})`, context); },
    switchTo(pageId) { vm.runInContext(`activateTab(${JSON.stringify(pageId)})`, context); },
    clock,
    context,
    constructedAfterMessageCount,
    FakeImage,
    FakeWebSocket,
    parent,
    posted,
    window,
  };
}

function frame(data = "jpeg-payload") {
  return {
    data,
    url: "https://private.invalid/path?token=secret",
    favicon: "https://private.invalid/favicon?token=secret",
  };
}

test("patch is deterministic and rejects an unexpected source", () => {
  const expected = sha256(fixture);
  const first = patchTemplate(fixture, expected);
  assert.equal(first, patchTemplate(fixture, expected));
  assert.equal(verifyPatchedTemplate(first), true);
  assert.throws(() => patchTemplate(fixture, "0".repeat(64)), /Input SHA256 mismatch/);
});

test("container and workflow retain the reviewed immutable inputs", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.equal(
    dockerfile.split(/\r?\n/u).filter((line) => line.startsWith(`FROM ${baseImage}`)).length,
    2,
  );
  assert.equal(dockerfile.split(BASE_TEMPLATE_SHA256).length - 1, 2);
  assert.match(dockerfile, /\/app\/api\/build\/templates\/live-session-streamer\.ejs/);
  assert.match(dockerfile, /\/app\/api\/src\/templates\/live-session-streamer\.ejs/);
  assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/greg-orian\/steel-browser-macu"/);
  assert.match(workflow, /^\s+platforms: linux\/amd64$/m);
  assert.match(workflow, /^\s+push: \$\{\{ github\.event_name != 'pull_request' \}\}$/m);
  assert.doesNotMatch(workflow, /^\s+uses: [^\s]+@v\d+/m);
});

test("patch fails closed when an upstream anchor drifts", () => {
  const drifted = fixture.replace(
    "// Function to establish WebSocket connection for a tab",
    "// Function to open a WebSocket for a tab",
  );
  assert.throws(
    () => patchTemplate(drifted, sha256(drifted)),
    /Patch start anchor not found: robust tab websocket transport/,
  );
});

test("lifecycle is first-frame based, replayable, epoch-scoped, and metadata-free", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const socket = harness.connect("private-page-id");
  assert.equal(harness.constructedAfterMessageCount[0], 1);
  assert.deepEqual(harness.posted[0], { schema_version: 1, type: "steel:connecting" });
  socket.open();
  assert.deepEqual(harness.posted[1], { schema_version: 1, type: "steel:connected" });
  socket.message(frame());
  socket.message(frame());
  assert.equal(harness.context.drawCount, 4);
  assert.deepEqual(harness.posted.slice(2), [{ schema_version: 1, type: "navigation" }]);

  const beforeWrongSource = harness.posted.length;
  harness.dispatch("message", {
    source: {},
    data: { schema_version: 1, type: "steel:get-state", probe_id: "ignored" },
  });
  assert.equal(harness.posted.length, beforeWrongSource);
  harness.dispatch("message", {
    source: harness.parent,
    data: { schema_version: 1, type: "steel:get-state", probe_id: "probe-123" },
  });
  assert.deepEqual(harness.posted.at(-1), {
    schema_version: 1,
    type: "steel:state",
    state: "ready",
    videoWidth: 1280,
    videoHeight: 720,
    probe_id: "probe-123",
  });

  for (const message of harness.posted) {
    assert.equal(message.schema_version, 1);
    assert.equal("url" in message, false);
    assert.equal("favicon" in message, false);
    assert.equal("pageId" in message, false);
    assert.equal("sessionId" in message, false);
    assert.equal("token" in message, false);
    assert.equal("endpoint" in message, false);
    assert.equal("error" in message, false);
    assert.equal("code" in message, false);
    assert.doesNotMatch(JSON.stringify(message), /private|secret/i);
  }
});

test("error and close coalesce into four retries with the exact backoff policy", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  let socket = harness.connect("retry-tab");
  const expectedDelays = [500, 1000, 2000, 5000];
  for (const delay of expectedDelays) {
    socket.error();
    socket.closeEvent(false);
    assert.equal(harness.FakeWebSocket.instances.length, expectedDelays.indexOf(delay) + 1);
    assert.ok(!vm.runInContext("tabs['retry-tab'].canvasContainer.classList.contains('error')", harness.context));
    harness.clock.tick(delay - 1);
    assert.equal(harness.FakeWebSocket.instances.length, expectedDelays.indexOf(delay) + 1);
    harness.clock.tick(1);
    socket = harness.FakeWebSocket.instances.at(-1);
  }
  socket.error();
  socket.closeEvent(false);
  assert.equal(harness.FakeWebSocket.instances.length, 5);
  assert.equal(harness.posted.filter((item) => item.type === "steel:connecting").length, 5);
  assert.equal(harness.posted.filter((item) => item.type === "steel:error").length, 1);
  assert.equal(harness.posted.filter((item) => item.type === "steel:disconnected").length, 0);
  assert.ok(vm.runInContext("tabs['retry-tab'].canvasContainer.classList.contains('error')", harness.context));
});

test("jitter is bounded to plus or minus twenty percent", () => {
  for (const [random, expected] of [[0, 400], [1, 600]]) {
    const harness = buildHarness(patchTemplate(fixture, sha256(fixture)), { random });
    harness.connect("jitter-tab").error();
    const delays = harness.clock.pendingDelays();
    assert.ok(delays.includes(expected));
  }
});

test("constructor failure and ten-second connect timeout enter bounded recovery", () => {
  const constructorHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  constructorHarness.FakeWebSocket.throwCount = 1;
  assert.equal(constructorHarness.connect("constructor-tab"), null);
  assert.equal(constructorHarness.posted.some((item) => item.type === "steel:error"), false);
  constructorHarness.clock.tick(500);
  assert.equal(constructorHarness.FakeWebSocket.instances.length, 1);

  const timeoutHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const first = timeoutHarness.connect("timeout-tab");
  timeoutHarness.clock.tick(9999);
  assert.equal(timeoutHarness.FakeWebSocket.instances.length, 1);
  timeoutHarness.clock.tick(1);
  assert.equal(first.closeCalls, 1);
  timeoutHarness.clock.tick(500);
  assert.equal(timeoutHarness.FakeWebSocket.instances.length, 2);
});

test("an open socket without a frame exhausts the thirty-second recovery window", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const socket = harness.connect("no-frame-tab");
  socket.open();
  harness.clock.tick(29999);
  assert.equal(harness.posted.some((item) => item.type === "steel:error"), false);
  harness.clock.tick(1);
  assert.equal(socket.closeCalls, 1);
  assert.equal(harness.posted.filter((item) => item.type === "steel:error").length, 1);
  assert.ok(vm.runInContext("tabs['no-frame-tab'].canvasContainer.classList.contains('error')", harness.context));
});

test("only a drawn frame resets retry budget and a later abnormal close starts fresh recovery", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const first = harness.connect("healthy-tab");
  first.error();
  harness.clock.tick(500);
  const second = harness.FakeWebSocket.instances.at(-1);
  assert.equal(harness.controller("healthy-tab").retryIndex, 1);
  second.open();
  assert.equal(harness.controller("healthy-tab").retryIndex, 1);
  second.message(frame());
  assert.equal(harness.controller("healthy-tab").retryIndex, 0);
  assert.equal(harness.controller("healthy-tab").recoveryDeadline, 0);

  second.closeEvent(false);
  assert.ok(harness.controller("healthy-tab").recoveryDeadline > harness.clock.now);
  harness.clock.tick(499);
  assert.equal(harness.FakeWebSocket.instances.length, 2);
  harness.clock.tick(1);
  assert.equal(harness.FakeWebSocket.instances.length, 3);
  assert.equal(harness.posted.some((item) => item.type === "steel:disconnected"), false);
});

test("a clean provider close is treated as session end without retry or terminal marker", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const socket = harness.connect("session-end-tab");
  socket.open();
  socket.message(frame());
  const instanceCount = harness.FakeWebSocket.instances.length;
  socket.closeEvent(true);
  assert.equal(harness.controller("session-end-tab").cancelled, true);
  harness.clock.tick(30000);
  assert.equal(harness.FakeWebSocket.instances.length, instanceCount);
  assert.equal(harness.posted.some((item) => /error|disconnected/.test(item.type)), false);
});

test("stale socket messages and delayed image callbacks cannot mutate a new epoch", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)), { autoLoadImages: false });
  const first = harness.connect("stale-tab");
  first.open();
  first.message(frame());
  assert.equal(harness.FakeImage.pending.length, 1);
  first.error();
  harness.clock.tick(500);
  const second = harness.FakeWebSocket.instances.at(-1);
  second.open();
  first.message(frame());
  harness.FakeImage.pending[0].onload();
  assert.equal(harness.context.drawCount, 0);
  assert.equal(harness.posted.some((item) => item.type === "navigation"), false);

  second.message(frame());
  harness.FakeImage.pending.at(-1).onload();
  assert.equal(harness.context.drawCount, 1);
  assert.equal(harness.posted.filter((item) => item.type === "navigation").length, 1);
});

test("recovery retains the last frame and announces navigation once per recovered epoch", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const first = harness.connect("frame-tab");
  first.open();
  first.message(frame());
  const retained = vm.runInContext("tabs['frame-tab'].lastImageData", harness.context);
  first.closeEvent(false);
  assert.equal(vm.runInContext("tabs['frame-tab'].lastImageData", harness.context), retained);
  assert.ok(!vm.runInContext("tabs['frame-tab'].canvasContainer.classList.contains('error')", harness.context));
  harness.clock.tick(500);
  const second = harness.FakeWebSocket.instances.at(-1);
  second.open();
  second.message(frame());
  assert.equal(harness.posted.filter((item) => item.type === "navigation").length, 2);
  assert.equal(vm.runInContext("tabs['frame-tab'].lastImageData", harness.context), retained);
});

test("a delayed resize redraw from an older epoch cannot overwrite the recovered frame", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)), { autoLoadImages: false });
  const first = harness.connect("resize-tab");
  first.open();
  first.message(frame("frame-one"));
  const firstDecode = harness.FakeImage.pending[0];
  firstDecode.onload();
  const staleResize = harness.FakeImage.pending[1];
  assert.deepEqual(harness.context.drawnImages, ["data:image/jpeg;base64,frame-one"]);

  first.closeEvent(false);
  harness.clock.tick(500);
  const second = harness.FakeWebSocket.instances.at(-1);
  second.open();
  second.message(frame("frame-two"));
  const secondDecode = harness.FakeImage.pending[2];
  secondDecode.onload();
  const currentResize = harness.FakeImage.pending[3];
  assert.equal(harness.context.drawnImages.at(-1), "data:image/jpeg;base64,frame-two");

  const beforeStaleResize = harness.context.drawCount;
  staleResize.onload();
  assert.equal(harness.context.drawCount, beforeStaleResize);
  assert.equal(harness.context.drawnImages.at(-1), "data:image/jpeg;base64,frame-two");

  currentResize.onload();
  assert.equal(harness.context.drawnImages.at(-1), "data:image/jpeg;base64,frame-two");
});

test("close-only exhaustion emits one disconnected marker", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  let socket = harness.connect("disconnect-tab");
  for (const delay of [500, 1000, 2000, 5000]) {
    socket.closeEvent(false);
    harness.clock.tick(delay);
    socket = harness.FakeWebSocket.instances.at(-1);
  }
  socket.closeEvent(false);
  assert.equal(harness.posted.filter((item) => item.type === "steel:disconnected").length, 1);
  assert.equal(harness.posted.filter((item) => item.type === "steel:error").length, 0);
});

test("pagehide, tab switch, manual close, and server close cancel CONNECTING transports", () => {
  const pageHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const pageSocket = pageHarness.connect("pagehide-tab");
  pageHarness.dispatch("pagehide");
  assert.equal(pageSocket.closeCalls, 1);
  pageHarness.clock.tick(30000);
  assert.equal(pageHarness.FakeWebSocket.instances.length, 1);
  assert.equal(pageHarness.posted.some((item) => /error|disconnected/.test(item.type)), false);

  const switchHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const oldSocket = switchHarness.connect("old-tab");
  switchHarness.activateOnly("new-tab");
  switchHarness.setActive("old-tab");
  switchHarness.switchTo("new-tab");
  assert.equal(oldSocket.closeCalls, 1);
  assert.equal(switchHarness.controller("old-tab").cancelled, true);

  const closeHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const closing = closeHarness.connect("closing-tab");
  closing.open();
  closeHarness.activateOnly("other-tab");
  closeHarness.setActive("closing-tab");
  closeHarness.closeTab("closing-tab");
  assert.equal(closing.closeCalls, 1);
  assert.match(closing.lastSent, /closeTab/);
  assert.equal(vm.runInContext("tabs['closing-tab']", closeHarness.context), undefined);
  assert.equal(vm.runInContext("activeTabId", closeHarness.context), "other-tab");
  closeHarness.clock.tick(30000);
  assert.equal(
    closeHarness.FakeWebSocket.instances.filter((socket) => socket.url.endsWith("/closing-tab")).length,
    1,
  );

  const serverHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const serverSocket = serverHarness.connect("server-closed-tab");
  serverHarness.serverClose("server-closed-tab");
  assert.equal(serverSocket.closeCalls, 1);
  assert.equal(vm.runInContext("tabs['server-closed-tab']", serverHarness.context), undefined);
  serverHarness.clock.tick(30000);
  assert.equal(serverHarness.FakeWebSocket.instances.length, 1);

  const multiHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  multiHarness.connect("stale-a");
  multiHarness.activateOnly("stale-b");
  multiHarness.setActive("stale-a");
  multiHarness.reconcile([]);
  assert.equal(multiHarness.FakeWebSocket.instances.length, 1);
  assert.equal(vm.runInContext("Object.keys(tabs).length", multiHarness.context), 0);
});

test("server reconciliation can remove the last tab while manual close preserves it", () => {
  const manualHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const manualSocket = manualHarness.connect("only-tab");
  manualSocket.open();
  manualHarness.closeTab("only-tab");
  assert.notEqual(vm.runInContext("tabs['only-tab']", manualHarness.context), undefined);
  assert.equal(manualSocket.lastSent, undefined);
  assert.equal(manualSocket.closeCalls, 0);

  const serverHarness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const removedSocket = serverHarness.connect("removed-tab");
  serverHarness.reconcile([]);
  assert.equal(removedSocket.closeCalls, 1);
  assert.equal(vm.runInContext("tabs['removed-tab']", serverHarness.context), undefined);
  assert.equal(serverHarness.controller("removed-tab"), undefined);
  assert.equal(vm.runInContext("activeTabId", serverHarness.context), null);
  serverHarness.clock.tick(30000);
  assert.equal(serverHarness.FakeWebSocket.instances.length, 1);
});

test("tab discovery reconnects silently", () => {
  const harness = buildHarness(patchTemplate(fixture, sha256(fixture)));
  const discovery = harness.connectDiscovery();
  discovery.error();
  discovery.closeEvent(false);
  harness.clock.tick(500);
  assert.equal(harness.FakeWebSocket.instances.length, 2);
  assert.deepEqual(harness.posted, []);
});
