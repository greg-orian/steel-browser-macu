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
  "          function connectTabWebSocket(pageId) {",
  "              // Create a new WebSocket for this tab",
  "              const ws = new WebSocket(createWebSocketUrl(pageId));",
  "              console.log(`Connecting websocket for tab ${pageId}`);",
  "              tabs[pageId].websocket = ws;",
  "",
  "              ws.onopen = () => {",
  "                  console.log(`WebSocket connection opened for tab ${pageId}`);",
  "                  tabs[pageId].reconnecting = false;",
  "              };",
  "",
  "              ws.onclose = () => {",
  "                  console.log(`WebSocket connection closed for tab ${pageId}`);",
  "",
  "                  if (tabs[pageId]) {",
  "                      tabs[pageId].reconnecting = false;",
  "                      tabs[pageId].intentionalClose = false;",
  "                  }",
  "              };",
  "",
  "              // Add error handler to explicitly handle connection failures",
  "              ws.onerror = () => {",
  "                  console.log(`WebSocket connection error for tab ${pageId}`);",
  "",
  "                  if(pageId === 'tab-discovery') {",
  "                    setConnectionStatus(false);",
  "                  }",
  "              };",
  "",
  "              ws.onmessage = (event) => {",
  "                  const payload = JSON.parse(event.data);",
  "                  if (payload.data) {",
  "                      if (!tabs[pageId]) {",
  "                          return;",
  "                      }",
  "                      tabs[pageId].canvasContainer.classList.remove('tab-switching');",
  "                      tabs[pageId].receivedFirstFrame = true;",
  "                      if(urlText) urlText.disabled = false;",
  "",
  "                      if (urlText && document.activeElement !== urlText){",
  "                        updateUrlBar(payload.url);",
  "                        updateSecurityIcon(payload.url);",
  "                        updateTabInfo(pageId, payload.url, payload.title, payload.favicon);",
  "                      }",
  "",
  "                      if (tabs[pageId].isLoading) {",
  "                          tabs[pageId].frameCount++;",
  "                          if (tabs[pageId].frameCount >= 2) {",
  "                              setTabLoadingState(pageId, false);",
  "                          }",
  "                      }",
  "                      window.parent.postMessage({",
  "                          type: 'navigation',",
  "                          url: payload.url,",
  "                          favicon: payload.favicon",
  "                      }, '*');",
  "",
  "                const img = new Image();",
  "                      const imageData = 'data:image/jpeg;base64,' + payload.data;",
  "                      tabs[pageId].lastImageData = imageData;",
  "",
  "                img.onload = () => {",
  "                          tabs[pageId].currentImageWidth = img.naturalWidth;",
  "                          tabs[pageId].currentImageHeight = img.naturalHeight;",
  "                          updateCanvasSize(pageId);",
  "",
  "                          tabs[pageId].ctx.drawImage(",
  "                        img,",
  "                        0,",
  "                        0,",
  "                              Math.floor(tabs[pageId].canvas.width / window.devicePixelRatio),",
  "                              Math.floor(tabs[pageId].canvas.height / window.devicePixelRatio)",
  "                          );",
  "",
  "                          tabs[pageId].canvasContainer.style.backgroundColor = 'var(--bg-secondary)';",
  "                      };",
  "",
  "                      img.src = imageData;",
  "                  }",
  "              };",
  "",
  "              return ws;",
  "          }",
  "",
  "          function testManualNavigation(url) {",
  "              const ws = tabs[activeTabId].websocket;",
  "              ws.send(JSON.stringify({",
  "                  type: 'navigation',",
  "                  pageId: activeTabId,",
  "                  event: { url: url }",
  "              }));",
  "",
  "                          // Send message to parent frame about manual URL change",
  "                          window.parent.postMessage({",
  "                              type: 'navigation',",
  "                              url: url",
  "                          }, '*');",
  "",
  "                          urlText.blur();",
  "          }",
  "",
  "          function testActivate(pageId) {",
  "              activeTabId = pageId;",
  "              tabs[pageId] = {",
  "                  canvas: { width: 1280, height: 720 },",
  "                  canvasContainer: {",
  "                      classList: { add() {}, remove() {} },",
  "                      style: {}",
  "                  },",
  "                  ctx: { drawImage() { drawCount += 1; } },",
  "                  frameCount: 0,",
  "                  intentionalClose: false,",
  "                  isLoading: false,",
  "                  reconnecting: false",
  "              };",
  "          }",
  "",
  "          function testIntentionalClose(pageId) {",
  "              tabs[pageId].intentionalClose = true;",
  "          }",
  "",
  "          function testSetActive(pageId) {",
  "              activeTabId = pageId;",
  "          }",
].join("\n");

function buildHarness(patched) {
  const posted = [];
  const constructedAfterMessageCount = [];
  const parent = {
    postMessage(message) {
      posted.push(structuredClone(message));
    },
  };

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];
    static throwOnConstruct = false;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      constructedAfterMessageCount.push(posted.length);
      FakeWebSocket.instances.push(this);
      if (FakeWebSocket.throwOnConstruct) {
        FakeWebSocket.throwOnConstruct = false;
        throw new Error("private constructor failure");
      }
    }

    send(value) {
      this.lastSent = value;
    }
  }

  class FakeImage {
    constructor() {
      this.naturalWidth = 1280;
      this.naturalHeight = 720;
    }

    set src(_value) {
      this.onload();
    }
  }

  const window = {
    devicePixelRatio: 1,
    parent,
    addEventListener(type, listener) {
      if (type === "message") this.messageListener = listener;
    },
  };
  const context = vm.createContext({
    Array,
    Boolean,
    Image: FakeImage,
    JSON,
    Math,
    Number,
    Object,
    Set,
    WebSocket: FakeWebSocket,
    console: { log() {}, error() {} },
    createWebSocketUrl: (pageId) => `wss://private.invalid/${pageId}`,
    document: { activeElement: null },
    drawCount: 0,
    setConnectionStatus() {},
    setTabLoadingState() {},
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
    connect(pageId) {
      return vm.runInContext(
        `testActivate(${JSON.stringify(pageId)}); connectTabWebSocket(${JSON.stringify(pageId)});`,
        context,
      );
    },
    reconnect(pageId) {
      return vm.runInContext(
        `connectTabWebSocket(${JSON.stringify(pageId)});`,
        context,
      );
    },
    context,
    constructedAfterMessageCount,
    FakeWebSocket,
    parent,
    posted,
    window,
  };
}

test("patch is deterministic and rejects an unexpected source", () => {
  const expected = sha256(fixture);
  const first = patchTemplate(fixture, expected);
  const second = patchTemplate(fixture, expected);
  assert.equal(first, second);
  assert.equal(verifyPatchedTemplate(first), true);
  assert.throws(
    () => patchTemplate(fixture, "0".repeat(64)),
    /Input SHA256 mismatch/,
  );
});

test("container and workflow retain the reviewed immutable inputs", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const workflow = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const pinnedFromLines = dockerfile
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`FROM ${baseImage}`));
  assert.equal(pinnedFromLines.length, 2);
  assert.equal(dockerfile.split(BASE_TEMPLATE_SHA256).length - 1, 2);
  assert.match(
    dockerfile,
    /\/app\/api\/build\/templates\/live-session-streamer\.ejs/,
  );
  assert.match(
    dockerfile,
    /\/app\/api\/src\/templates\/live-session-streamer\.ejs/,
  );
  assert.match(
    dockerfile,
    /org\.opencontainers\.image\.source="https:\/\/github\.com\/greg-orian\/steel-browser-macu"/,
  );
  assert.match(
    dockerfile,
    /org\.opencontainers\.image\.base\.name="ghcr\.io\/steel-dev\/steel-browser@sha256:f5cd68fbc2cb27e5d7766269860fd0fb29cbe5fe506245a49c82f85ba210e7da"/,
  );
  assert.match(workflow, /^\s+platforms: linux\/amd64$/m);
  assert.match(workflow, /^\s+push: \$\{\{ github\.event_name != 'pull_request' \}\}$/m);
  assert.doesNotMatch(workflow, /^\s+uses: [^\s]+@v\d+/m);
});

test("patch fails closed when an upstream anchor drifts", () => {
  const drifted = fixture.replace(
    "// Create a new WebSocket for this tab",
    "// Create the WebSocket for this tab",
  );
  assert.throws(
    () => patchTemplate(drifted, sha256(drifted)),
    /Patch anchor not found: connecting before WebSocket construction/,
  );
});

test("lifecycle messages are ordered, replayable, and metadata-free", () => {
  const patched = patchTemplate(fixture, sha256(fixture));
  const harness = buildHarness(patched);
  const socket = harness.connect("private-page-id");

  assert.equal(harness.constructedAfterMessageCount[0], 1);
  assert.deepEqual(harness.posted[0], {
    schema_version: 1,
    type: "steel:connecting",
  });

  socket.onopen();
  assert.deepEqual(harness.posted[1], {
    schema_version: 1,
    type: "steel:connected",
  });

  const beforeManualNavigation = harness.posted.length;
  vm.runInContext(
    "testManualNavigation('https://private.invalid/manual?token=secret')",
    harness.context,
  );
  assert.equal(harness.posted.length, beforeManualNavigation);
  assert.match(socket.lastSent, /private\.invalid\/manual/);

  const frame = {
    data: "jpeg-payload",
    url: "https://private.invalid/path?token=secret",
    favicon: "https://private.invalid/favicon?token=secret",
  };
  vm.runInContext("testSetActive('background-tab')", harness.context);
  socket.onmessage({ data: JSON.stringify(frame) });
  assert.equal(harness.posted.length, beforeManualNavigation);
  vm.runInContext("testSetActive('private-page-id')", harness.context);
  socket.onmessage({ data: JSON.stringify(frame) });
  socket.onmessage({ data: JSON.stringify(frame) });

  assert.equal(harness.context.drawCount, 3);
  assert.deepEqual(harness.posted.slice(2), [
    {
      schema_version: 1,
      type: "navigation",
    },
  ]);

  const beforeWrongSource = harness.posted.length;
  harness.window.messageListener({
    source: {},
    data: { schema_version: 1, type: "steel:get-state", probe_id: "ignored" },
  });
  assert.equal(harness.posted.length, beforeWrongSource);

  for (const schemaVersion of [undefined, 0, 2, true, "1"]) {
    harness.window.messageListener({
      source: harness.parent,
      data: {
        schema_version: schemaVersion,
        type: "steel:get-state",
        probe_id: "ignored",
      },
    });
  }
  assert.equal(harness.posted.length, beforeWrongSource);

  harness.window.messageListener({
    source: harness.parent,
    data: {
      schema_version: 1,
      type: "steel:get-state",
      probe_id: "probe-123",
    },
  });
  assert.deepEqual(harness.posted.at(-1), {
    schema_version: 1,
    type: "steel:state",
    state: "ready",
    videoWidth: 1280,
    videoHeight: 720,
    probe_id: "probe-123",
  });

  harness.window.messageListener({
    source: harness.parent,
    data: {
      schema_version: 1,
      type: "steel:get-state",
      probe_id: "x".repeat(129),
    },
  });
  assert.equal("probe_id" in harness.posted.at(-1), false);

  for (const message of harness.posted) {
    assert.equal(message.schema_version, 1);
    if (message.type !== "steel:state") {
      assert.equal("state" in message, false);
    }
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

test("only an abnormal close without an error or intent emits disconnected", () => {
  const patched = patchTemplate(fixture, sha256(fixture));
  const harness = buildHarness(patched);

  const errored = harness.connect("error-tab");
  errored.onerror();
  errored.onerror();
  errored.onclose({ wasClean: false, code: 1006, reason: "private detail" });
  assert.deepEqual(harness.posted, [
    { schema_version: 1, type: "steel:connecting" },
    { schema_version: 1, type: "steel:error" },
  ]);

  harness.posted.length = 0;
  const intentional = harness.connect("intentional-tab");
  vm.runInContext("testIntentionalClose('intentional-tab')", harness.context);
  intentional.onclose({ wasClean: false, code: 1006, reason: "private detail" });
  assert.deepEqual(harness.posted, [
    { schema_version: 1, type: "steel:connecting" },
  ]);

  harness.posted.length = 0;
  const clean = harness.connect("clean-tab");
  clean.onclose({ wasClean: true, code: 1000, reason: "private detail" });
  assert.deepEqual(harness.posted, [
    { schema_version: 1, type: "steel:connecting" },
  ]);

  harness.posted.length = 0;
  const abnormal = harness.connect("abnormal-tab");
  abnormal.onclose({ wasClean: false, code: 1006, reason: "private detail" });
  assert.deepEqual(harness.posted, [
    { schema_version: 1, type: "steel:connecting" },
    { schema_version: 1, type: "steel:disconnected" },
  ]);
});

test("a synchronous WebSocket constructor failure emits one sanitized error and rethrows", () => {
  const patched = patchTemplate(fixture, sha256(fixture));
  const harness = buildHarness(patched);
  const previousSocket = harness.connect("constructor-error-tab");
  harness.posted.length = 0;
  previousSocket.readyState = harness.FakeWebSocket.CLOSING;
  harness.FakeWebSocket.throwOnConstruct = true;

  assert.throws(
    () => harness.reconnect("constructor-error-tab"),
    /private constructor failure/,
  );
  assert.deepEqual(harness.posted, [
    {
      schema_version: 1,
      type: "steel:connecting",
    },
    {
      schema_version: 1,
      type: "steel:error",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(harness.posted), /private|constructor|failure/i);
  assert.equal(harness.FakeWebSocket.instances.at(-1).onclose, undefined);

  previousSocket.onclose({
    wasClean: false,
    code: 1006,
    reason: "private close detail",
  });
  assert.equal(harness.posted.length, 2);
});
