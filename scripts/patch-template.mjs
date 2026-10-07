#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BASE_TEMPLATE_SHA256 =
  "2de2e9328a568d00df9dd8d11b36fde58b3d1da97e71f9cacb863530a215064d";

const lifecycleAndTransportHelpers = String.raw`
          // MACU overlay: expose only a small, credential-free lifecycle contract.
          const macuTransportControllers = new Map();
          const macuRetryDelays = [500, 1000, 2000, 5000];
          const macuConnectTimeoutMs = 10000;
          const macuRecoveryWindowMs = 30000;
          let macuLifecycleState = 'connecting';
          let macuVideoWidth = null;
          let macuVideoHeight = null;

          function positiveMacuDimension(value) {
              return Number.isFinite(value) && value > 0;
          }

          function safeMacuProbeId(value) {
              if (typeof value === 'string' && value.length <= 128) return value;
              if (Number.isSafeInteger(value)) return value;
              return null;
          }

          function postMacuLifecycle(type, state, options = {}) {
              const message = { schema_version: 1, type };
              if (type === 'steel:state' && state) message.state = state;
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
              if (probeId !== null) message.probe_id = probeId;
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

          function getMacuTransportController(pageId) {
              let controller = macuTransportControllers.get(pageId);
              if (!controller) {
                  controller = {
                      pageId,
                      epoch: 0,
                      socket: null,
                      connectTimer: null,
                      retryTimer: null,
                      recoveryTimer: null,
                      retryIndex: 0,
                      recoveryDeadline: 0,
                      failureEpoch: null,
                      navigationEpoch: null,
                      terminal: false,
                      terminalMarkerSent: false,
                      cancelled: false,
                      sawError: false,
                      silent: pageId === 'tab-discovery'
                  };
                  macuTransportControllers.set(pageId, controller);
              }
              return controller;
          }

          function clearMacuTimer(controller, name) {
              if (controller[name] !== null) {
                  clearTimeout(controller[name]);
                  controller[name] = null;
              }
          }

          function clearMacuTransportTimers(controller) {
              clearMacuTimer(controller, 'connectTimer');
              clearMacuTimer(controller, 'retryTimer');
              clearMacuTimer(controller, 'recoveryTimer');
          }

          function currentMacuTransport(controller, epoch, socket = null) {
              return Boolean(
                  controller
                  && !controller.cancelled
                  && !controller.terminal
                  && controller.epoch === epoch
                  && (socket === null || controller.socket === socket)
              );
          }

          function shouldRunMacuTransport(pageId) {
              return pageId === 'tab-discovery' || Boolean(tabs[pageId] && activeTabId === pageId);
          }

          function closeMacuSocket(socket) {
              if (!socket) return;
              if (
                  socket.readyState === WebSocket.CONNECTING
                  || socket.readyState === WebSocket.OPEN
              ) {
                  try {
                      socket.close();
                  } catch (_error) {
                      // The epoch guard already makes this socket inert.
                  }
              }
          }

          function resetMacuTransportController(controller) {
              clearMacuTransportTimers(controller);
              controller.epoch += 1;
              controller.socket = null;
              controller.retryIndex = 0;
              controller.recoveryDeadline = 0;
              controller.failureEpoch = null;
              controller.navigationEpoch = null;
              controller.terminal = false;
              controller.terminalMarkerSent = false;
              controller.cancelled = false;
              controller.sawError = false;
              activeConnectionRetries[controller.pageId] = 0;
          }

          function cancelMacuTransport(pageId, options = {}) {
              const controller = macuTransportControllers.get(pageId);
              const tab = tabs[pageId];
              if (!controller) {
                  if (tab) {
                      tab.websocket = null;
                      tab.reconnecting = false;
                      tab.intentionalClose = true;
                  }
                  return;
              }
              const socket = controller.socket;
              controller.cancelled = true;
              controller.terminal = true;
              controller.epoch += 1;
              controller.socket = null;
              clearMacuTransportTimers(controller);
              if (tab) {
                  tab.intentionalClose = true;
                  tab.websocket = null;
                  tab.reconnecting = false;
              }
              closeMacuSocket(socket);
              if (options.remove === true) {
                  macuTransportControllers.delete(pageId);
                  delete activeConnectionRetries[pageId];
              }
          }

          function cancelAllMacuTransports() {
              for (const pageId of Array.from(macuTransportControllers.keys())) {
                  cancelMacuTransport(pageId, { remove: true });
              }
          }

          function exhaustMacuTransport(pageId, controller, state) {
              if (controller.terminal || controller.cancelled) return;
              const socket = controller.socket;
              controller.terminal = true;
              controller.socket = null;
              clearMacuTransportTimers(controller);
              closeMacuSocket(socket);
              const tab = tabs[pageId];
              if (tab) {
                  if (tab.websocket === socket) tab.websocket = null;
                  tab.reconnecting = false;
                  tab.canvasContainer.classList.remove('loading');
                  tab.canvasContainer.classList.add('error');
              }
              if (!controller.silent && activeTabId === pageId && !controller.terminalMarkerSent) {
                  controller.terminalMarkerSent = true;
                  setConnectionStatus(false);
                  if (state === 'error' || controller.sawError) {
                      setMacuLifecycle('steel:error', 'error');
                  } else {
                      setMacuLifecycle('steel:disconnected', 'disconnected');
                  }
              }
          }

          function startMacuRecoveryWindow(pageId, controller) {
              if (controller.recoveryDeadline > 0) return;
              controller.recoveryDeadline = Date.now() + macuRecoveryWindowMs;
              const expectedDeadline = controller.recoveryDeadline;
              controller.recoveryTimer = setTimeout(() => {
                  if (
                      controller.cancelled
                      || controller.terminal
                      || controller.recoveryDeadline !== expectedDeadline
                  ) return;
                  controller.sawError = true;
                  exhaustMacuTransport(pageId, controller, 'error');
              }, macuRecoveryWindowMs);
          }

          function scheduleMacuRetry(pageId, controller) {
              if (controller.cancelled || controller.terminal) return;
              if (!shouldRunMacuTransport(pageId)) {
                  cancelMacuTransport(pageId);
                  return;
              }
              if (
                  controller.retryIndex >= macuRetryDelays.length
                  || Date.now() >= controller.recoveryDeadline
              ) {
                  exhaustMacuTransport(pageId, controller, controller.sawError ? 'error' : 'disconnected');
                  return;
              }
              const baseDelay = macuRetryDelays[controller.retryIndex];
              const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
              if (Date.now() + delay >= controller.recoveryDeadline) {
                  exhaustMacuTransport(pageId, controller, controller.sawError ? 'error' : 'disconnected');
                  return;
              }
              controller.retryIndex += 1;
              activeConnectionRetries[pageId] = controller.retryIndex;
              controller.retryTimer = setTimeout(() => {
                  controller.retryTimer = null;
                  if (!controller.cancelled && !controller.terminal && shouldRunMacuTransport(pageId)) {
                      connectTabWebSocket(pageId);
                  }
              }, delay);
          }

          function failMacuTransport(pageId, controller, epoch, socket, state) {
              if (!currentMacuTransport(controller, epoch, socket)) return;
              if (controller.failureEpoch === epoch) return;
              controller.failureEpoch = epoch;
              if (state === 'error') controller.sawError = true;
              clearMacuTimer(controller, 'connectTimer');
              controller.socket = null;
              const tab = tabs[pageId];
              if (tab) {
                  if (tab.websocket === socket) tab.websocket = null;
                  tab.reconnecting = true;
                  if (activeTabId === pageId) setConnectionStatus(false);
              }
              closeMacuSocket(socket);
              // A healthy prior epoch clears its recovery window. A later loss starts a new one.
              startMacuRecoveryWindow(pageId, controller);
              scheduleMacuRetry(pageId, controller);
          }

          function markMacuTransportHealthy(pageId, controller, epoch, socket) {
              if (!currentMacuTransport(controller, epoch, socket)) return false;
              clearMacuTimer(controller, 'recoveryTimer');
              controller.retryIndex = 0;
              controller.recoveryDeadline = 0;
              controller.failureEpoch = null;
              controller.terminalMarkerSent = false;
              controller.sawError = false;
              activeConnectionRetries[pageId] = 0;
              const tab = tabs[pageId];
              if (tab) {
                  tab.reconnecting = false;
                  tab.canvasContainer.classList.remove('loading');
                  tab.canvasContainer.classList.remove('error');
                  if (activeTabId === pageId) setConnectionStatus(true);
              }
              return true;
          }

          function announceMacuRenderedFrame(pageId, controller, epoch, socket, videoWidth, videoHeight) {
              if (
                  pageId !== activeTabId
                  || !currentMacuTransport(controller, epoch, socket)
                  || !positiveMacuDimension(videoWidth)
                  || !positiveMacuDimension(videoHeight)
              ) return;
              macuLifecycleState = 'ready';
              macuVideoWidth = videoWidth;
              macuVideoHeight = videoHeight;
              if (controller.navigationEpoch !== epoch) {
                  controller.navigationEpoch = epoch;
                  postMacuLifecycle('navigation');
              }
          }

          function handleMacuStateRequest(event) {
              if (event.source !== window.parent) return;
              const request = event.data;
              if (
                  !request
                  || typeof request !== 'object'
                  || Array.isArray(request)
                  || request.schema_version !== 1
                  || request.type !== 'steel:get-state'
              ) return;
              postMacuLifecycle('steel:state', macuLifecycleState, {
                  videoWidth: macuVideoWidth,
                  videoHeight: macuVideoHeight,
                  probeId: request.probe_id
              });
          }

          window.addEventListener('message', handleMacuStateRequest);
          window.addEventListener('pagehide', cancelAllMacuTransports);
`;

const robustConnectFunction = String.raw`          // Function to establish WebSocket connection for a tab
          function connectTabWebSocket(pageId) {
              const controller = getMacuTransportController(pageId);
              if (controller.cancelled || controller.terminal) resetMacuTransportController(controller);
              if (controller.retryTimer !== null) return controller.socket;
              if (
                  controller.socket
                  && (
                      controller.socket.readyState === WebSocket.OPEN
                      || controller.socket.readyState === WebSocket.CONNECTING
                  )
              ) return controller.socket;
              if (!shouldRunMacuTransport(pageId)) return null;

              startMacuRecoveryWindow(pageId, controller);
              controller.epoch += 1;
              const epoch = controller.epoch;
              controller.failureEpoch = null;
              const tab = tabs[pageId];
              if (tab) {
                  tab.intentionalClose = false;
                  tab.reconnecting = controller.retryIndex > 0;
                  tab.canvasContainer.classList.remove('error');
                  if (!tab.receivedFirstFrame) tab.canvasContainer.classList.add('loading');
              }
              if (!controller.silent && activeTabId === pageId) {
                  setMacuLifecycle('steel:connecting', 'connecting');
              }

              let ws;
              try {
                  ws = new WebSocket(createWebSocketUrl(pageId));
              } catch (_error) {
                  failMacuTransport(pageId, controller, epoch, null, 'error');
                  return null;
              }
              controller.socket = ws;
              if (tab) tab.websocket = ws;
              controller.connectTimer = setTimeout(() => {
                  failMacuTransport(pageId, controller, epoch, ws, 'error');
              }, macuConnectTimeoutMs);

              ws.onopen = () => {
                  if (!currentMacuTransport(controller, epoch, ws)) return;
                  clearMacuTimer(controller, 'connectTimer');
                  if (tab && pageId !== 'tab-discovery' && tab.canvas) {
                      setupCanvasEventListeners(tab.canvas, pageId, ws);
                  }
                  if (!controller.silent && activeTabId === pageId) {
                      setConnectionStatus(true);
                      setMacuLifecycle('steel:connected', 'connected');
                  }
              };

              ws.onerror = () => {
                  failMacuTransport(pageId, controller, epoch, ws, 'error');
              };

              ws.onclose = (event) => {
                  if (!currentMacuTransport(controller, epoch, ws)) return;
                  if (tabs[pageId]?.intentionalClose || event?.wasClean === true) {
                      cancelMacuTransport(pageId);
                      return;
                  }
                  failMacuTransport(pageId, controller, epoch, ws, 'disconnected');
              };

              ws.onmessage = (event) => {
                  if (!currentMacuTransport(controller, epoch, ws)) return;
                  const payload = JSON.parse(event.data);
                  if (pageId === 'tab-discovery') {
                      markMacuTransportHealthy(pageId, controller, epoch, ws);
                      if (payload.type === 'tabList') {
                          handleTabList(payload.tabs, payload.firstTabId);
                      } else if (payload.type === 'tabClosed') {
                          handleTabClosed(payload.pageId);
                      } else if (payload.type === 'activeTabChange') {
                          if (tabs[payload.pageId] && activeTabId !== payload.pageId) {
                              activateTab(payload.pageId);
                          }
                      }
                      return;
                  }
                  if (payload.type === 'tabUpdate') {
                      updateTabInfo(pageId, payload.url, payload.title, payload.favicon);
                      return;
                  }
                  if (payload.type === 'targetClosed') {
                      handleTabClosed(pageId);
                      return;
                  }
                  if (!payload.data || !tabs[pageId]) return;
                  if (urlText && document.activeElement !== urlText) {
                      updateUrlBar(payload.url);
                      updateSecurityIcon(payload.url);
                      updateTabInfo(pageId, payload.url, payload.title, payload.favicon);
                  }
                  const img = new Image();
                  const imageData = 'data:image/jpeg;base64,' + payload.data;
                  img.onload = () => {
                      if (!currentMacuTransport(controller, epoch, ws) || !tabs[pageId]) return;
                      const currentTab = tabs[pageId];
                      currentTab.currentImageWidth = img.naturalWidth;
                      currentTab.currentImageHeight = img.naturalHeight;
                      currentTab.lastImageData = imageData;
                      updateCanvasSize(pageId, {
                          controller,
                          epoch,
                          socket: ws,
                          expectedImageData: imageData
                      });
                      currentTab.ctx.drawImage(
                          img,
                          0,
                          0,
                          Math.floor(currentTab.canvas.width / window.devicePixelRatio),
                          Math.floor(currentTab.canvas.height / window.devicePixelRatio)
                      );
                      currentTab.receivedFirstFrame = true;
                      currentTab.canvasContainer.classList.remove('tab-switching');
                      currentTab.canvasContainer.style.backgroundColor = 'var(--bg-secondary)';
                      if (urlText) urlText.disabled = false;
                      if (currentTab.isLoading) {
                          currentTab.frameCount += 1;
                          if (currentTab.frameCount >= 2) setTabLoadingState(pageId, false);
                      }
                      if (markMacuTransportHealthy(pageId, controller, epoch, ws)) {
                          announceMacuRenderedFrame(
                              pageId,
                              controller,
                              epoch,
                              ws,
                              img.naturalWidth,
                              img.naturalHeight
                          );
                      }
                  };
                  img.src = imageData;
              };

              return ws;
          }

`;

const patches = [
  {
    label: "lifecycle and transport helpers",
    before: String.raw`          let activeConnectionRetries = {}; // Track reconnection attempts

          // Default dimensions until we get first image`,
    after: String.raw`          let activeConnectionRetries = {}; // Track reconnection attempts
${lifecycleAndTransportHelpers}
          // Default dimensions until we get first image`,
  },
  {
    label: "robust tab websocket transport",
    start: String.raw`          // Function to establish WebSocket connection for a tab
          function connectTabWebSocket(pageId) {`,
    end: String.raw`          // Function to create a new tab`,
    replacement: robustConnectFunction,
  },
  {
    label: "cancel inactive tab transport",
    before: [
      "                  // Intentionally close the WebSocket for the inactive tab if it exists to save resources",
      "                  if (tabs[activeTabId].websocket &&",
      "                      tabs[activeTabId].websocket.readyState === WebSocket.OPEN) {",
      "                      tabs[activeTabId].intentionalClose = true;",
      "                      tabs[activeTabId].websocket.close();",
      "                      tabs[activeTabId].websocket = null;",
      "                      console.log(`Closed WebSocket for inactive tab ${activeTabId}`);",
      "                  }",
    ].join("\n"),
    after: String.raw`                  // Cancel OPEN and CONNECTING sockets as well as pending recovery timers.
                  if (activeTabId !== pageId) {
                      cancelMacuTransport(activeTabId);
                  }`,
  },
  {
    label: "replace inert upstream reconnect helper",
    start: String.raw`          // Function to attempt reconnection for a tab WebSocket
          function attemptReconnect(pageId) {`,
    end: String.raw`          // Set up WebSocket-related event listeners for a canvas`,
    replacement: String.raw`          // Reconnection is owned by the per-tab transport controller above.
          function attemptReconnect(pageId) {
              return connectTabWebSocket(pageId);
          }

`,
  },
  {
    label: "server reconciliation uses local removal",
    before: String.raw`                      // Only remove DOM elements, don't send closeTab message since
                      // the server already knows this tab is closed
                      closeTab(pageId);`,
    after: String.raw`                      // The server already closed this page; never send a closeTab message back.
                      // Defer activation until reconciliation has removed every stale page.
                      removeMacuLocalTab(pageId, { activateReplacement: false });`,
  },
  {
    label: "robust local and manual tab removal",
    start: String.raw`          // Function to handle tab closed by server
          function handleTabClosed(pageId) {`,
    end: String.raw`          // Initialize connection - in single-page mode we have only one connection`,
    replacement: String.raw`          // Remove a page already closed by the provider without notifying it again.
          function removeMacuLocalTab(pageId, options = {}) {
              if (!tabs[pageId]) return;

              const wasActive = activeTabId === pageId;
              const priorOrder = Object.keys(tabs).filter(id => id !== 'tab-discovery');
              const priorIndex = Math.max(0, priorOrder.indexOf(pageId));
              cancelMacuTransport(pageId, { remove: true });
              if (tabs[pageId].tab) tabs[pageId].tab.remove();
              if (tabs[pageId].canvasContainer) tabs[pageId].canvasContainer.remove();
              delete tabs[pageId];

              if (wasActive) {
                  activeTabId = null;
                  const remaining = Object.keys(tabs).filter(id => id !== 'tab-discovery');
                  if (options.activateReplacement !== false && remaining.length > 0) {
                      activateTab(remaining[Math.min(priorIndex, remaining.length - 1)]);
                  } else {
                      setConnectionStatus(false);
                  }
              }
          }

          // Function to handle tab closed by server.
          function handleTabClosed(pageId) {
              removeMacuLocalTab(pageId);
          }

          // Manual close preserves the upstream last-tab policy and notifies the provider once.
          function closeTab(pageId) {
              if (!tabs[pageId]) return;
              const tabIndexes = Object.keys(tabs).filter(id => id !== 'tab-discovery');
              if (tabIndexes.length <= 1) return;

              if (
                  tabs[pageId].websocket
                  && tabs[pageId].websocket.readyState === WebSocket.OPEN
              ) {
                  tabs[pageId].websocket.send(JSON.stringify({
                      type: 'closeTab',
                      pageId: pageId
                  }));
              }
              removeMacuLocalTab(pageId);
          }

`,
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
    label: "null-safe clipboard websocket wrapper",
    before: String.raw`          const originalConnectTabWebSocket = connectTabWebSocket;
          connectTabWebSocket = function(pageId) {
              const ws = originalConnectTabWebSocket(pageId);

              const originalOnMessage = ws.onmessage;`,
    after: String.raw`          const originalConnectTabWebSocket = connectTabWebSocket;
          connectTabWebSocket = function(pageId) {
              const ws = originalConnectTabWebSocket(pageId);
              if (!ws || ws.macuClipboardWrapped === true) {
                  return ws;
              }
              ws.macuClipboardWrapped = true;

              const originalOnMessage = ws.onmessage;
              const macuController = getMacuTransportController(pageId);
              const macuEpoch = macuController.epoch;`,
  },
  {
    label: "epoch-safe clipboard websocket wrapper",
    before: String.raw`              ws.onmessage = function(event) {
                  const payload = JSON.parse(event.data);`,
    after: String.raw`              ws.onmessage = function(event) {
                  if (!currentMacuTransport(macuController, macuEpoch, ws)) {
                      return;
                  }
                  const payload = JSON.parse(event.data);`,
  },
  {
    label: "epoch-safe canvas resize redraw",
    start: String.raw`          // Add the missing updateCanvasSize function
          function updateCanvasSize(pageId) {`,
    end: String.raw`          // Add a function to handle tab loading state`,
    replacement: String.raw`          // Add the missing updateCanvasSize function
          function updateCanvasSize(pageId, transport = null) {
              if (!tabs[pageId]) return;

              const tabData = tabs[pageId];
              const container = tabData.canvasContainer;
              const canvas = tabData.canvas;
              const ctx = tabData.ctx;
              if (!ctx) return;

              const parentHeight = container.clientHeight;
              const targetHeight = parentHeight;
              const targetWidth = targetHeight * (tabData.currentImageWidth / tabData.currentImageHeight);
              const dpr = window.devicePixelRatio || 1;
              canvas.width = targetWidth * dpr;
              canvas.height = targetHeight * dpr;
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.scale(dpr, dpr);
              canvas.style.height = '100%';
              canvas.style.width = 'auto';

              const expectedTab = tabData;
              const expectedImageData = transport?.expectedImageData ?? tabData.lastImageData;
              if (expectedImageData) {
                  const img = new Image();
                  img.onload = () => {
                      if (
                          tabs[pageId] !== expectedTab
                          || expectedTab.lastImageData !== expectedImageData
                      ) return;
                      if (
                          transport?.controller
                          && !currentMacuTransport(
                              transport.controller,
                              transport.epoch,
                              transport.socket
                          )
                      ) return;
                      ctx.drawImage(
                          img,
                          0,
                          0,
                          Math.floor(canvas.width / window.devicePixelRatio),
                          Math.floor(canvas.height / window.devicePixelRatio)
                      );
                  };
                  img.src = expectedImageData;
              }
          }

`,
  },
];

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`Patch anchor not found: ${label}`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceRangeExactlyOnce(source, start, end, replacement, label) {
  const first = source.indexOf(start);
  if (first === -1) throw new Error(`Patch start anchor not found: ${label}`);
  if (source.indexOf(start, first + start.length) !== -1) {
    throw new Error(`Patch start anchor is not unique: ${label}`);
  }
  const endIndex = source.indexOf(end, first + start.length);
  if (endIndex === -1) throw new Error(`Patch end anchor not found: ${label}`);
  if (source.indexOf(end, endIndex + end.length) !== -1) {
    throw new Error(`Patch end anchor is not unique: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(endIndex);
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
    "macuRetryDelays = [500, 1000, 2000, 5000]",
    "macuConnectTimeoutMs = 10000",
    "macuRecoveryWindowMs = 30000",
    "announceMacuRenderedFrame(",
    "currentMacuTransport(controller, epoch, ws)",
    "window.addEventListener('pagehide', cancelAllMacuTransports)",
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
    throw new Error(`Input SHA256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  let patched = source;
  for (const patch of patches) {
    patched = patch.start
      ? replaceRangeExactlyOnce(patched, patch.start, patch.end, patch.replacement, patch.label)
      : replaceExactlyOnce(patched, patch.before, patch.after, patch.label);
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
