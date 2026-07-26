#!/usr/bin/env node

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const codexBinary =
  process.env.CODEX_CLI_PATH ||
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const runtimeNodeModules =
  process.env.CODEX_RUNTIME_NODE_MODULES ||
  process.env.NODE_PATH;
const browserExecutable =
  process.env.REALTIME_BROWSER_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const timeoutMs = Number(process.env.REALTIME_TEST_TIMEOUT_MS || 45_000);
const realtimeVersion = process.env.REALTIME_VERSION || "v3";
const spokenPrompt =
  process.env.REALTIME_TEST_PROMPT ||
  "Reply with exactly, WebRTC realtime is working.";

if (!existsSync(codexBinary)) {
  console.error(`Codex executable not found: ${codexBinary}`);
  process.exit(1);
}

if (!runtimeNodeModules) {
  console.error(
    "Set CODEX_RUNTIME_NODE_MODULES to the directory containing Playwright before running this proof.",
  );
  process.exit(1);
}

let chromium;
try {
  const runtimeRequire = createRequire(`${runtimeNodeModules}/runtime-loader.cjs`);
  ({ chromium } = runtimeRequire("playwright"));
} catch (error) {
  console.error(`Could not load Playwright from ${runtimeNodeModules}`);
  console.error(error.message);
  process.exit(1);
}

const server = spawn(
  codexBinary,
  [
    "--enable",
    "realtime_conversation",
    "app-server",
    "--listen",
    "stdio://",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  },
);

server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");

let nextId = 1;
let stdoutBuffer = "";
let stderrText = "";
let assistantTranscript = "";
let outputAudioFrames = 0;
const pending = new Map();
const notifications = [];
const notificationWaiters = new Set();

function send(message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
  });
}

function waitForNotification(predicate, label, ms = timeoutMs) {
  const existing = notifications.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        notificationWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label} after ${ms} ms`));
      }, ms),
    };
    notificationWaiters.add(waiter);
  });
}

function handleNotification(message) {
  notifications.push(message);
  const params = message.params || {};

  if (message.method === "thread/realtime/started") {
    console.log(
      `Realtime started: version=${params.version || "unspecified"}, session=${params.realtimeSessionId || "not exposed"}`,
    );
  } else if (message.method === "thread/realtime/sdp") {
    console.log("Received remote WebRTC SDP answer.");
  } else if (message.method === "thread/realtime/transcript/delta") {
    if (params.role === "assistant") {
      assistantTranscript += params.delta || "";
      process.stdout.write(params.delta || "");
    }
  } else if (message.method === "thread/realtime/transcript/done") {
    if (params.role === "assistant") {
      assistantTranscript = params.text || assistantTranscript;
      console.log();
    }
  } else if (message.method === "thread/realtime/outputAudio/delta") {
    outputAudioFrames += 1;
  } else if (message.method === "thread/realtime/error") {
    console.error(`Realtime error: ${params.message || JSON.stringify(params)}`);
  } else if (message.method === "thread/realtime/closed") {
    console.log(`Realtime closed: ${params.reason || "no reason supplied"}`);
  }

  for (const waiter of [...notificationWaiters]) {
    if (!waiter.predicate(message)) continue;
    notificationWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
}

function handleMessage(message) {
  if (message.id != null && message.method) {
    send({
      id: message.id,
      error: {
        code: -32601,
        message: `Diagnostic client cannot answer ${message.method}`,
      },
    });
    return;
  }

  if (message.id != null) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(
          `${waiter.method}: ${message.error.code ?? "error"}: ${message.error.message}`,
        ),
      );
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  if (message.method) handleNotification(message);
}

server.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      console.error(`[unparsed app-server output] ${line}`);
    }
  }
});

server.stderr.on("data", (chunk) => {
  stderrText += chunk;
  if (process.env.DEBUG_REALTIME === "1") process.stderr.write(chunk);
});

server.once("exit", (code, signal) => {
  const error = new Error(
    `Codex app-server exited unexpectedly: code=${code}, signal=${signal}`,
  );
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  for (const waiter of notificationWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  notificationWaiters.clear();
});

let browser;
let page;
let threadId;
let realtimeStarted = false;
let temporaryAudioDirectory;

function createSpokenPrompt() {
  temporaryAudioDirectory = mkdtempSync(
    join(tmpdir(), "codex-realtime-diagnostic-"),
  );
  const aiffPath = join(temporaryAudioDirectory, "prompt.aiff");
  const wavPath = join(temporaryAudioDirectory, "prompt.wav");
  execFileSync("/usr/bin/say", [
    "-v",
    "Samantha",
    "-o",
    aiffPath,
    spokenPrompt,
  ]);
  execFileSync("/usr/bin/afconvert", [
    "-f",
    "WAVE",
    "-d",
    "LEI16@24000",
    aiffPath,
    wavPath,
  ]);
  return readFileSync(wavPath).toString("base64");
}

async function createBrowserOffer() {
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  page = await browser.newPage();

  return page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    window.diagnosticPeerConnection = pc;
    window.diagnosticEvents = [];

    const audioContext = new AudioContext({ sampleRate: 24_000 });
    const mediaDestination = audioContext.createMediaStreamDestination();
    window.diagnosticAudioContext = audioContext;
    window.diagnosticMediaDestination = mediaDestination;
    pc.addTrack(mediaDestination.stream.getAudioTracks()[0], mediaDestination.stream);
    pc.ontrack = (event) => {
      window.diagnosticRemoteStream = event.streams[0];
    };
    const channel = pc.createDataChannel("oai-events");
    window.diagnosticDataChannel = channel;
    channel.onmessage = (event) => {
      window.diagnosticEvents.push(event.data);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (pc.iceGatheringState !== "complete") {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        pc.addEventListener(
          "icegatheringstatechange",
          () => {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(timer);
              resolve();
            }
          },
          { once: false },
        );
      });
    }

    return pc.localDescription.sdp;
  });
}

async function playSpokenPrompt(wavBase64) {
  await page.evaluate(async (base64Audio) => {
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const context = window.diagnosticAudioContext;
    await context.resume();
    const buffer = await context.decodeAudioData(bytes.buffer);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(window.diagnosticMediaDestination);
    source.start();
    await new Promise((resolve) => {
      source.onended = resolve;
    });
  }, wavBase64);
}

async function applyRemoteAnswer(sdp) {
  await page.evaluate(async (answerSdp) => {
    await window.diagnosticPeerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
  }, sdp);
}

async function waitForPeerConnection(ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      connection: window.diagnosticPeerConnection.connectionState,
      ice: window.diagnosticPeerConnection.iceConnectionState,
      channel: window.diagnosticDataChannel.readyState,
    }));
    if (state.connection === "connected" && state.channel === "open") {
      return state;
    }
    if (["failed", "closed"].includes(state.connection)) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return page.evaluate(() => ({
    connection: window.diagnosticPeerConnection.connectionState,
    ice: window.diagnosticPeerConnection.iceConnectionState,
    channel: window.diagnosticDataChannel.readyState,
  }));
}

async function waitForBrowserAssistantTurn(ms = timeoutMs) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rawEvents = await page.evaluate(() =>
      window.diagnosticEvents.splice(0),
    );
    for (const rawEvent of rawEvents) {
      let event;
      try {
        event = JSON.parse(rawEvent);
      } catch {
        continue;
      }
      if (event.type === "error") {
        throw new Error(
          event.error?.message || event.message || JSON.stringify(event),
        );
      }
      if (event.type === "turn.done" && event.turn?.role === "assistant") {
        return {
          source: "browser-data-channel",
          transcript: event.turn.transcript || assistantTranscript,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for browser assistant turn after ${ms} ms`);
}

async function cleanup() {
  if (threadId && realtimeStarted) {
    try {
      await Promise.race([
        request("thread/realtime/stop", { threadId }),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // Process cleanup below is the final fallback.
    }
  }
  if (browser) await browser.close().catch(() => {});
  if (temporaryAudioDirectory) {
    rmSync(temporaryAudioDirectory, { recursive: true, force: true });
  }
  server.stdin.end();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}

try {
  console.log(`Codex binary: ${codexBinary}`);
  const promptAudio = createSpokenPrompt();
  console.log(`Generated local test speech: "${spokenPrompt}"`);
  console.log("Creating a real browser-generated WebRTC offer...");
  const offerSdp = await createBrowserOffer();
  console.log(`Offer created (${offerSdp.length} characters).`);

  await request("initialize", {
    clientInfo: {
      name: "personal-agent-webrtc-diagnostic",
      title: "Personal Agent WebRTC Diagnostic",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized" });

  const account = await request("account/read", { refreshToken: false });
  console.log(
    `Authentication: ${account?.account?.type || account?.authMode || "authenticated account detected"}`,
  );

  const threadResult = await request("thread/start", {
    cwd: process.cwd(),
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  threadId = threadResult.thread.id;
  console.log(`Thread created: ${threadId}`);
  console.log(`Calling thread/realtime/start with WebRTC ${realtimeVersion}...`);

  await request("thread/realtime/start", {
    threadId,
    outputModality: "audio",
    version: realtimeVersion,
    includeStartupContext: false,
    prompt: "You are a realtime connectivity diagnostic.",
    transport: { type: "webrtc", sdp: offerSdp },
  });

  const outcome = await waitForNotification(
    (message) =>
      message.method === "thread/realtime/sdp" ||
      message.method === "thread/realtime/error" ||
      message.method === "thread/realtime/closed",
    "WebRTC SDP answer or realtime error",
  );

  if (outcome.method !== "thread/realtime/sdp") {
    throw new Error(
      outcome.params?.message ||
        outcome.params?.reason ||
        "Realtime closed before returning an SDP answer",
    );
  }

  realtimeStarted = true;
  await applyRemoteAnswer(outcome.params.sdp);
  const peerState = await waitForPeerConnection();
  console.log(
    `Peer state: connection=${peerState.connection}, ice=${peerState.ice}, dataChannel=${peerState.channel}`,
  );

  if (peerState.connection !== "connected" || peerState.channel !== "open") {
    throw new Error(
      "The backend returned an SDP answer, but the WebRTC peer did not fully connect.",
    );
  }

  console.log("Playing genuine speech into the active WebRTC audio track...");
  await playSpokenPrompt(promptAudio);

  const interactionOutcome = await Promise.race([
    waitForNotification(
      (message) =>
        (message.method === "thread/realtime/transcript/done" &&
          message.params?.role === "assistant") ||
        message.method === "thread/realtime/error" ||
        message.method === "thread/realtime/closed",
      "app-server assistant realtime response",
    ).then((message) => ({ source: "app-server", message })),
    waitForBrowserAssistantTurn(),
  ]);

  if (
    interactionOutcome.source === "app-server" &&
    interactionOutcome.message.method !== "thread/realtime/transcript/done"
  ) {
    throw new Error(
      interactionOutcome.message.params?.message ||
        interactionOutcome.message.params?.reason ||
        "Realtime closed before returning an assistant response",
    );
  }
  if (interactionOutcome.transcript) {
    assistantTranscript = interactionOutcome.transcript;
  }

  console.log("\nRESULT: PASS");
  console.log(
    "ChatGPT-authenticated Codex completed a live WebRTC realtime turn without an API key.",
  );
  console.log(`Assistant transcript: ${assistantTranscript.trim()}`);
  console.log(`Completion observed via: ${interactionOutcome.source}`);
  console.log(`App-server audio frames observed: ${outputAudioFrames}`);
} catch (error) {
  console.error("\nRESULT: FAIL");
  console.error(error.message);

  const relevant = stderrText
    .split("\n")
    .filter((line) =>
      /realtime|quota|billing|auth|entitle|forbidden|unauthorized|error/i.test(
        line,
      ),
    )
    .slice(-30);
  if (relevant.length) {
    console.error("\nRelevant app-server diagnostics:");
    console.error(relevant.join("\n"));
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
