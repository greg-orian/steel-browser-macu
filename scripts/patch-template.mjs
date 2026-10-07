#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BASE_TEMPLATE_SHA256 =
  "2de2e9328a568d00df9dd8d11b36fde58b3d1da97e71f9cacb863530a215064d";

const lifecycleHelpers = String.raw`
          // MACU overlay: expose only a small, credential-free lifecycle contract.
          const macuNavigationTabs = new Set();
          let macuLifecycleState = 'connecting';
          let macuVideoWidth = null;
          let macuVideoHeight = null;

          function positiveMacuDimension(value) {
              return Number.isFinite(value) && value > 0;
          }

          function safeMacuProbeId(value) {
              if (typeof value === 'string' && value.length <= 128) {
                  return value;
              }
              if (Number.isSafeInteger(value)) {
                  return value;
              }
              return null;
          }

          function postMacuLifecycle(type, state, options = {}) {
              const message = {
                  schema_version: 1,
                  type
              };

              if (type === 'steel:state' && state) {
                  message.state = state;
              }

              if (
                  type === 'steel:state'
                  && state === 'ready'
                  && positiveMacuDimension(options.videoWidth)
                  && positiveMacuDimension(options.videoHeight)
              ) {
                  message.videoWidth = options.videoWidth;
                  message.videoHeight = options.videoHeight;
              }

              const probeId = safeMacuProbeId(options.probeId);
              if (probeId !== null) {
                  message.probe_id = probeId;
              }

              window.parent.postMessage(message, '*');
          }

          function setMacuLifecycle(type, state, options = {}) {
              macuLifecycleState = state;
              if (
                  state === 'ready'
                  && positiveMacuDimension(options.videoWidth)
                  && positiveMacuDimension(options.videoHeight)
              ) {
                  macuVideoWidth = options.videoWidth;
                  macuVideoHeight = options.videoHeight;
              } else {
                  macuVideoWidth = null;
                  macuVideoHeight = null;
              }
              postMacuLifecycle(type, state, options);
          }

          function announceMacuRenderedFrame(pageId, videoWidth, videoHeight) {
              if (
                  pageId !== activeTabId
                  || !positiveMacuDimension(videoWidth)
                  || !positiveMacuDimension(videoHeight)
              ) {
                  return;
              }

              macuLifecycleState = 'ready';
              macuVideoWidth = videoWidth;
              macuVideoHeight = videoHeight;

              if (!macuNavigationTabs.has(pageId)) {
                  macuNavigationTabs.add(pageId);
                  postMacuLifecycle('navigation');
              }
          }

          function handleMacuStateRequest(event) {
              if (event.source !== window.parent) {
                  return;
              }

              const request = event.data;
              if (
                  !request
                  || typeof request !== 'object'
                  || Array.isArray(request)
                  || request.schema_version !== 1
                  || request.type !== 'steel:get-state'
              ) {
                  return;
              }

              postMacuLifecycle('steel:state', macuLifecycleState, {
                  videoWidth: macuVideoWidth,
                  videoHeight: macuVideoHeight,
                  probeId: request.probe_id
              });
          }

          window.addEventListener('message', handleMacuStateRequest);
`;

const patches = [
  {
    label: "lifecycle helpers",
    before: String.raw`          let activeConnectionRetries = {}; // Track reconnection attempts

          // Default dimensions until we get first image`,
    after: String.raw`          let activeConnectionRetries = {}; // Track reconnection attempts
${lifecycleHelpers}
          // Default dimensions until we get first image`,
  },
  {
    label: "connecting before WebSocket construction",
    before: String.raw`              // Create a new WebSocket for this tab
              const ws = new WebSocket(createWebSocketUrl(pageId));`,
    after: String.raw`              // Create a new WebSocket for this tab
              const macuConnectionState = { errored: false };
              if (tabs[pageId]) {
                  tabs[pageId].macuConnectionState = macuConnectionState;
              }
              const reportMacuConnectionError = () => {
                  if (
                      pageId === 'tab-discovery'
                      || macuConnectionState.errored
                      || (
                          tabs[pageId]?.macuConnectionState
                          && tabs[pageId].macuConnectionState !== macuConnectionState
                      )
                  ) {
                      return;
                  }
                  macuConnectionState.errored = true;
                  if (activeTabId === pageId) {
                      setMacuLifecycle('steel:error', 'error');
                  }
              };
              if (pageId !== 'tab-discovery') {
                  if (activeTabId === pageId) {
                      setMacuLifecycle('steel:connecting', 'connecting');
                  }
              }
              let ws;
              try {
                  ws = new WebSocket(createWebSocketUrl(pageId));
              } catch (error) {
                  reportMacuConnectionError();
                  throw error;
              }`,
  },
  {
    label: "connected on WebSocket open",
    before: [
      "              ws.onopen = () => {",
      "                  console.log(`WebSocket connection opened for tab ${pageId}`);",
    ].join("\n"),
    after: [
      "              ws.onopen = () => {",
      "                  console.log(`WebSocket connection opened for tab ${pageId}`);",
      "                  if (pageId !== 'tab-discovery' && activeTabId === pageId) {",
      "                      setMacuLifecycle('steel:connected', 'connected');",
      "                  }",
    ].join("\n"),
  },
  {
    label: "abnormal WebSocket disconnect",
    before: [
      "              ws.onclose = () => {",
      "                  console.log(`WebSocket connection closed for tab ${pageId}`);",
      "",
      "                  if (tabs[pageId]) {",
    ].join("\n"),
    after: [
      "              ws.onclose = (event) => {",
      "                  console.log(`WebSocket connection closed for tab ${pageId}`);",
      "",
      "                  const macuAbnormalClose = event?.wasClean !== true;",
      "                  const macuIntentionalClose = Boolean(tabs[pageId]?.intentionalClose);",
      "                  const macuSupersededConnection = Boolean(",
      "                      tabs[pageId]?.macuConnectionState",
      "                      && tabs[pageId].macuConnectionState !== macuConnectionState",
      "                  );",
      "                  if (",
      "                      pageId !== 'tab-discovery'",
      "                      && activeTabId === pageId",
      "                      && macuAbnormalClose",
      "                      && !macuConnectionState.errored",
      "                      && !macuIntentionalClose",
      "                      && !macuSupersededConnection",
      "                  ) {",
      "                      setMacuLifecycle('steel:disconnected', 'disconnected');",
      "                  }",
      "",
      "                  if (tabs[pageId]) {",
    ].join("\n"),
  },
  {
    label: "WebSocket error",
    before: [
      "              ws.onerror = () => {",
      "                  console.log(`WebSocket connection error for tab ${pageId}`);",
      "",
      "                  if(pageId === 'tab-discovery') {",
    ].join("\n"),
    after: [
      "              ws.onerror = () => {",
      "                  console.log(`WebSocket connection error for tab ${pageId}`);",
      "",
      "                  reportMacuConnectionError();",
      "",
      "                  if(pageId === 'tab-discovery') {",
    ].join("\n"),
  },
  {
    label: "unsafe navigation payload",
    before: String.raw`                      window.parent.postMessage({
                          type: 'navigation',
                          url: payload.url,
                          favicon: payload.favicon
                      }, '*');

                const img = new Image();`,
    after: String.raw`                const img = new Image();`,
  },
  {
    label: "premature manual navigation payload",
    before: String.raw`                          // Send message to parent frame about manual URL change
                          window.parent.postMessage({
                              type: 'navigation',
                              url: url
                          }, '*');

                          urlText.blur();`,
    after: String.raw`                          // Parent readiness is announced only after a JPEG has been drawn.
                          urlText.blur();`,
  },
  {
    label: "first rendered JPEG lifecycle",
    before: String.raw`                          tabs[pageId].ctx.drawImage(
                        img,
                        0,
                        0,
                              Math.floor(tabs[pageId].canvas.width / window.devicePixelRatio),
                              Math.floor(tabs[pageId].canvas.height / window.devicePixelRatio)
                          );

                          tabs[pageId].canvasContainer.style.backgroundColor = 'var(--bg-secondary)';`,
    after: String.raw`                          tabs[pageId].ctx.drawImage(
                        img,
                        0,
                        0,
                              Math.floor(tabs[pageId].canvas.width / window.devicePixelRatio),
                              Math.floor(tabs[pageId].canvas.height / window.devicePixelRatio)
                          );
                          announceMacuRenderedFrame(
                              pageId,
                              img.naturalWidth,
                              img.naturalHeight
                          );

                          tabs[pageId].canvasContainer.style.backgroundColor = 'var(--bg-secondary)';`,
  },
];

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) {
    throw new Error(`Patch anchor not found: ${label}`);
  }
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function verifyPatchedTemplate(source) {
  const required = [
    "schema_version: 1",
    "'steel:connecting'",
    "'steel:connected'",
    "'steel:error'",
    "'steel:disconnected'",
    "'steel:get-state'",
    "'steel:state'",
    "probe_id",
    "announceMacuRenderedFrame(",
  ];
  for (const fragment of required) {
    if (!source.includes(fragment)) {
      throw new Error(`Patched template is missing required fragment: ${fragment}`);
    }
  }
  if (source.includes("url: payload.url") || source.includes("favicon: payload.favicon")) {
    throw new Error("Patched navigation message still contains sensitive page metadata");
  }
  const directParentMessage =
    /window\.parent\.postMessage\(\s*\{([\s\S]*?)\}\s*,\s*['"]\*['"]\s*\);/g;
  for (const match of source.matchAll(directParentMessage)) {
    if (/\btype\s*:\s*['"]navigation['"]/.test(match[1])) {
      throw new Error("Patched template still has a direct parent navigation payload");
    }
  }
  if (source.split("postMacuLifecycle('navigation')").length - 1 !== 1) {
    throw new Error("Patched template must have exactly one sanitized navigation marker");
  }
  if (source.includes("postMacuLifecycle('steel:ready'")) {
    throw new Error("Patched template must not emit a standalone steel:ready marker");
  }
  return true;
}

export function patchTemplate(source, expectedSha256 = BASE_TEMPLATE_SHA256) {
  const actualSha256 = sha256(source);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Input SHA256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }

  let patched = source;
  for (const patch of patches) {
    patched = replaceExactlyOnce(patched, patch.before, patch.after, patch.label);
  }
  verifyPatchedTemplate(patched);
  return patched;
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("Usage: patch-template.mjs --input PATH --output PATH [--expected-sha256 HEX]");
    }
    options.set(name.slice(2), value);
  }
  if (!options.has("input") || !options.has("output")) {
    throw new Error("Both --input and --output are required");
  }
  return {
    input: resolve(options.get("input")),
    output: resolve(options.get("output")),
    expectedSha256: options.get("expected-sha256") ?? BASE_TEMPLATE_SHA256,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = await readFile(options.input, "utf8");
  const patched = patchTemplate(source, options.expectedSha256);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, patched, "utf8");
  process.stdout.write(`${options.output} ${sha256(patched)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
