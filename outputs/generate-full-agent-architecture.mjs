#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const canvas = { width: 2800, height: 2000 };

const palette = {
  ink: "#172033",
  muted: "#52606d",
  line: "#64748b",
  canvas: "#f8fafc",
  group: "#ffffff",
  fork: "#cfe8ff",
  adapt: "#d9f7e8",
  reference: "#fff0c2",
  invoke: "#e8dcff",
  own: "#e7edf4",
  external: "#ffdfe5",
  warning: "#fff4e6",
};

const nodes = [
  {
    id: "user",
    x: 1110,
    y: 105,
    width: 580,
    height: 95,
    fill: "#0f766e",
    color: "#ffffff",
    title: "YOU",
    body: "continuous voice · interruptions · “show me” · approvals",
  },
  {
    id: "character",
    x: 100,
    y: 310,
    width: 560,
    height: 200,
    fill: palette.fork,
    title: "FULL-SCREEN CHARACTER STAGE",
    body:
      "Rive face + animation state machine\nwake word · captions · content panels\nexternal-display ownership\n\nSOURCE: FORK SAMUEL",
  },
  {
    id: "realtime",
    x: 760,
    y: 310,
    width: 560,
    height: 200,
    fill: palette.invoke,
    title: "REALTIME VOICE CONTROLLER",
    body:
      "WebRTC v3 · local wake word · oai-events\nVAD · transcript · interruption\ndelegation/handoff into Codex turns\n\nSOURCE: CODEX PROTOCOL + SAMUEL AUDIO",
  },
  {
    id: "showme",
    x: 1480,
    y: 310,
    width: 520,
    height: 200,
    fill: palette.fork,
    title: "SHOW ME CANVAS",
    body:
      "task timeline · live window/browser feed\nartifacts · results · restore character\n\nSOURCE: SAMUEL PANELS + OUR BRIDGE",
  },
  {
    id: "approval_ui",
    x: 2140,
    y: 310,
    width: 560,
    height: 200,
    fill: palette.adapt,
    title: "APPROVAL + ELICITATION UX",
    body:
      "one approval per task · scoped capability\nre-prompt for irreversible actions\nvoice and on-screen answers\n\nSOURCE: ADAPT OPENCLAW",
  },
  {
    id: "memory",
    x: 100,
    y: 690,
    width: 610,
    height: 230,
    fill: palette.reference,
    title: "DURABLE MEMORY SERVICE",
    body:
      "Companion Store + Activity Ledger\nidentity · facts · episodes · references\nEvidence Cache · bounded recall\n\nSOURCE: OSAURUS + HERMES PROVIDER",
  },
  {
    id: "orchestrator",
    x: 850,
    y: 650,
    width: 740,
    height: 250,
    fill: palette.own,
    title: "THIN TASK ORCHESTRATOR + EVENT BUS",
    body:
      "task lifetime · directives · routing policy\nevent schema · cancellation · result routing\nNO planning · NO app-specific recipes\n\nSOURCE: OUR CODE",
  },
  {
    id: "codex_adapter",
    x: 1750,
    y: 650,
    width: 950,
    height: 250,
    fill: palette.adapt,
    title: "CODEX ADAPTER / PROCESS SUPERVISOR",
    body:
      "stdio JSON-RPC · thread registry · turns\nsteer/interrupt · approvals · event projection\nhealth checks · timeouts · crash/orphan cleanup\n\nSOURCE: CODEX APP-SERVER + ADAPT OPENCLAW extensions/codex",
  },
  {
    id: "learning",
    x: 100,
    y: 990,
    width: 610,
    height: 230,
    fill: palette.reference,
    title: "CONTROLLED SELF-IMPROVEMENT",
    body:
      "successful/corrected trajectory → candidate\nreview · security scan · replay test\nversion · activate · rollback\n\nSOURCE: ADAPT HERMES PROCEDURAL LEARNING",
  },
  {
    id: "connectors",
    x: 850,
    y: 990,
    width: 740,
    height: 230,
    fill: palette.invoke,
    title: "CONNECTOR + CAPABILITY HUB",
    body:
      "discover/vet connectors · plugin inventory\nMCP registry · capability metadata\nGmail · Calendar · Drive · GitHub · Todoist\n\nSOURCE: CODEX APPS/PLUGINS + OFFICIAL MCP",
  },
  {
    id: "native_helper",
    x: 1750,
    y: 990,
    width: 950,
    height: 230,
    fill: palette.reference,
    title: "AMBIENT SCHEDULER + MAC HELPER",
    body:
      "Signals · Local Gate · dedupe · cooldowns\nScreenCaptureKit · Keychain · TCC checks\nresource-aware throttling\n\nSOURCE: OUR CODE + macOS AGENT REFERENCE",
  },
  {
    id: "codex_realtime",
    x: 120,
    y: 1400,
    width: 580,
    height: 180,
    fill: palette.invoke,
    title: "REALTIME v3",
    body:
      "thread/realtime/start\nWebRTC + transcript + delegation\n\nINVOKE INSTALLED CODEX",
  },
  {
    id: "codex_threads",
    x: 790,
    y: 1400,
    width: 580,
    height: 180,
    fill: palette.invoke,
    title: "THREAD / TURN + WORKERS",
    body:
      "planning · persistent threads · workers\nsteering · recovery · verification\n\nINVOKE INSTALLED CODEX",
  },
  {
    id: "codex_control",
    x: 1460,
    y: 1400,
    width: 580,
    height: 180,
    fill: palette.invoke,
    title: "EXECUTION PLANE",
    body:
      "Computer Use · Browser Use\nterminal · coding · filesystem\n\nINVOKE BUNDLED COMPONENTS IN PLACE",
  },
  {
    id: "codex_apps",
    x: 2130,
    y: 1400,
    width: 550,
    height: 180,
    fill: palette.invoke,
    title: "APP / MCP TOOL PLANE",
    body:
      "authenticated apps · plugins\nMCP servers · tool manifests\n\nINVOKE THROUGH CODEX",
  },
  {
    id: "mac_world",
    x: 100,
    y: 1760,
    width: 590,
    height: 135,
    fill: palette.external,
    title: "MAC + WEB",
    body: "apps · browser · terminal · files · GitHub",
  },
  {
    id: "personal_cloud",
    x: 790,
    y: 1760,
    width: 590,
    height: 135,
    fill: palette.external,
    title: "PERSONAL SERVICES",
    body: "Gmail · Calendar · Drive · Todoist · future services",
  },
  {
    id: "local_data",
    x: 1480,
    y: 1760,
    width: 590,
    height: 135,
    fill: palette.external,
    title: "LOCAL PRIVATE DATA",
    body: "memory.db · task events · artifacts · audit trail",
  },
  {
    id: "skills",
    x: 2170,
    y: 1760,
    width: 530,
    height: 135,
    fill: palette.external,
    title: "Z.AI UTILITY + SKILLS",
    body:
      "stateless Utility Packets · no tools\ntriage · summaries · candidates\nskills: candidate · active · rollback",
  },
];

const edges = [
  ["user", "character", "voice / attention", "primary"],
  ["character", "realtime", "mic + UI state", "primary"],
  ["realtime", "character", "speech + animation", "primary"],
  ["realtime", "orchestrator", "delegated goal", "primary"],
  ["orchestrator", "codex_adapter", "general task", "primary"],
  ["codex_adapter", "orchestrator", "projected events", "primary"],
  ["orchestrator", "character", "status", "event"],
  ["orchestrator", "showme", "preview/artifacts", "event"],
  ["codex_adapter", "approval_ui", "approval request", "event"],
  ["approval_ui", "codex_adapter", "scoped decision", "event"],
  ["orchestrator", "memory", "recall / write", "data"],
  ["memory", "orchestrator", "bounded context", "data"],
  ["orchestrator", "learning", "verified trajectory", "data"],
  ["learning", "skills", "versioned skill", "data"],
  ["skills", "orchestrator", "retrieved procedure", "data"],
  ["orchestrator", "skills", "utility packet", "data"],
  ["skills", "orchestrator", "candidate", "data"],
  ["orchestrator", "connectors", "capability lookup", "data"],
  ["showme", "native_helper", "capture selected surface", "event"],
  ["native_helper", "character", "display/TCC state", "event"],
  ["realtime", "codex_realtime", "WebRTC v3", "primary"],
  ["codex_adapter", "codex_threads", "JSON-RPC", "primary"],
  ["codex_adapter", "codex_control", "tool execution", "primary"],
  ["connectors", "codex_apps", "app/MCP registry", "primary"],
  ["codex_threads", "codex_control", "plans + verifies", "primary"],
  ["codex_threads", "codex_apps", "selects tools", "primary"],
  ["codex_control", "mac_world", "observe / act / verify", "primary"],
  ["codex_apps", "personal_cloud", "scoped API actions", "primary"],
  ["memory", "local_data", "private persistence", "data"],
  ["learning", "local_data", "audit + evidence", "data"],
];

const groups = [
  {
    id: "experience_group",
    x: 55,
    y: 245,
    width: 2690,
    height: 325,
    label: "1 · FULL-SCREEN EXPERIENCE — Electron / React / Rive",
  },
  {
    id: "host_group",
    x: 55,
    y: 590,
    width: 2690,
    height: 690,
    label: "2 · APP-OWNED CONTROL PLANE — small, generic, local-first",
  },
  {
    id: "codex_group",
    x: 55,
    y: 1325,
    width: 2690,
    height: 315,
    label:
      "3 · MANAGED CODEX APP-SERVER — ChatGPT authenticated; do not fork or extract bundled control",
  },
  {
    id: "external_group",
    x: 55,
    y: 1690,
    width: 2690,
    height: 255,
    label: "4 · CONTROLLED SYSTEMS + PRIVATE DATA",
  },
];

const centers = Object.fromEntries(
  nodes.map((node) => [
    node.id,
    {
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
      node,
    },
  ]),
);

function connectionPoints(from, to) {
  const a = centers[from];
  const b = centers[to];
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0
      ? [
          a.node.x + a.node.width,
          a.y,
          b.node.x,
          b.y,
        ]
      : [
          a.node.x,
          a.y,
          b.node.x + b.node.width,
          b.y,
        ];
  }
  return dy > 0
    ? [
        a.x,
        a.node.y + a.node.height,
        b.x,
        b.node.y,
      ]
    : [
        a.x,
        a.node.y,
        b.x,
        b.node.y + b.node.height,
      ];
}

let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function baseElement(id, type, x, y, width, height) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: palette.ink,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: idCounter * 101 + 7,
    version: 1,
    versionNonce: idCounter * 997 + 17,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  };
}

function rectangleElement(item, dashed = false) {
  const element = baseElement(
    item.id,
    "rectangle",
    item.x,
    item.y,
    item.width,
    item.height,
  );
  element.backgroundColor = item.fill || "transparent";
  element.strokeColor = item.stroke || palette.line;
  element.strokeWidth = dashed ? 2 : 3;
  element.strokeStyle = dashed ? "dashed" : "solid";
  element.opacity = dashed ? 65 : 100;
  return element;
}

function textElement({
  id = nextId("text"),
  x,
  y,
  width,
  height,
  text,
  size = 22,
  color = palette.ink,
  align = "left",
  weight = false,
}) {
  const element = baseElement(id, "text", x, y, width, height);
  element.strokeColor = color;
  element.backgroundColor = "transparent";
  element.strokeWidth = 1;
  element.fontSize = size;
  element.fontFamily = 5;
  element.text = text;
  element.originalText = text;
  element.textAlign = align;
  element.verticalAlign = "top";
  element.containerId = null;
  element.autoResize = false;
  element.lineHeight = weight ? 1.15 : 1.25;
  return element;
}

function arrowElement(from, to, label, kind) {
  const [startX, startY, endX, endY] = connectionPoints(from, to);
  const style = {
    primary: { color: "#5b3cc4", width: 4, dash: "solid" },
    event: { color: "#2563eb", width: 3, dash: "dashed" },
    data: { color: "#0f766e", width: 3, dash: "dotted" },
  }[kind];
  const element = baseElement(
    nextId("arrow"),
    "arrow",
    startX,
    startY,
    endX - startX,
    endY - startY,
  );
  element.strokeColor = style.color;
  element.strokeWidth = style.width;
  element.strokeStyle = style.dash;
  element.roundness = { type: 2 };
  element.points = [
    [0, 0],
    [endX - startX, endY - startY],
  ];
  element.lastCommittedPoint = null;
  element.startBinding = null;
  element.endBinding = null;
  element.startArrowhead = null;
  element.endArrowhead = "arrow";
  element.elbowed = false;
  return {
    element,
    label: textElement({
      x: (startX + endX) / 2 - 95,
      y: (startY + endY) / 2 - 18,
      width: 190,
      height: 28,
      text: label,
      size: 15,
      color: style.color,
      align: "center",
    }),
  };
}

const excalidrawElements = [];

excalidrawElements.push(
  textElement({
    id: "diagram-title",
    x: 75,
    y: 30,
    width: 2650,
    height: 50,
    text: "FULL-SCREEN REALTIME MAC AGENT — COMPLETE IMPLEMENTATION ARCHITECTURE",
    size: 34,
    color: palette.ink,
    align: "center",
    weight: true,
  }),
);
excalidrawElements.push(
  textElement({
    id: "diagram-subtitle",
    x: 75,
    y: 78,
    width: 2650,
    height: 30,
    text:
      "Purple = main execution flow · Blue dashed = UI/events · Green dotted = memory/learning/data",
    size: 18,
    color: palette.muted,
    align: "center",
  }),
);

for (const group of groups) {
  excalidrawElements.push(rectangleElement(group, true));
  excalidrawElements.push(
    textElement({
      id: `${group.id}-label`,
      x: group.x + 25,
      y: group.y + 12,
      width: group.width - 50,
      height: 28,
      text: group.label,
      size: 19,
      color: palette.muted,
      weight: true,
    }),
  );
}

for (const [from, to, label, kind] of edges) {
  const arrow = arrowElement(from, to, label, kind);
  excalidrawElements.push(arrow.element, arrow.label);
}

for (const node of nodes) {
  excalidrawElements.push(rectangleElement(node));
  excalidrawElements.push(
    textElement({
      id: `${node.id}-title`,
      x: node.x + 22,
      y: node.y + 18,
      width: node.width - 44,
      height: 32,
      text: node.title,
      size: node.id === "user" ? 25 : 20,
      color: node.color || palette.ink,
      align: node.id === "user" ? "center" : "left",
      weight: true,
    }),
  );
  excalidrawElements.push(
    textElement({
      id: `${node.id}-body`,
      x: node.x + 22,
      y: node.y + (node.id === "user" ? 53 : 58),
      width: node.width - 44,
      height: node.height - 70,
      text: node.body,
      size: node.id === "user" ? 17 : 17,
      color: node.color || palette.ink,
      align: node.id === "user" ? "center" : "left",
    }),
  );
}

const excalidraw = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: excalidrawElements,
  appState: {
    viewBackgroundColor: palette.canvas,
    gridSize: 20,
  },
  files: {},
};

writeFileSync(
  join(outputDirectory, "full-agent-architecture.excalidraw"),
  `${JSON.stringify(excalidraw, null, 2)}\n`,
);

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgMultilineText(node) {
  const lines = node.body.split("\n");
  const bodyY = node.y + (node.id === "user" ? 61 : 72);
  return lines
    .map(
      (line, index) =>
        `<text x="${node.id === "user" ? node.x + node.width / 2 : node.x + 24}" y="${bodyY + index * 23}" font-size="${node.id === "user" ? 17 : 17}" fill="${node.color || palette.ink}" text-anchor="${node.id === "user" ? "middle" : "start"}">${escapeXml(line || " ")}</text>`,
    )
    .join("\n");
}

const markerDefinitions = `
  <defs>
    <marker id="arrow-primary" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#5b3cc4"/></marker>
    <marker id="arrow-event" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#2563eb"/></marker>
    <marker id="arrow-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/></marker>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-opacity="0.12"/></filter>
  </defs>`;

const svgGroups = groups
  .map(
    (group) => `
  <rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="22" fill="#ffffff" fill-opacity="0.72" stroke="#94a3b8" stroke-width="2" stroke-dasharray="10 8"/>
  <text x="${group.x + 25}" y="${group.y + 31}" font-size="19" font-weight="700" fill="${palette.muted}">${escapeXml(group.label)}</text>`,
  )
  .join("\n");

const svgEdges = edges
  .map(([from, to, label, kind]) => {
    const [x1, y1, x2, y2] = connectionPoints(from, to);
    const style = {
      primary: { color: "#5b3cc4", width: 4, dash: "" },
      event: { color: "#2563eb", width: 3, dash: 'stroke-dasharray="10 8"' },
      data: { color: "#0f766e", width: 3, dash: 'stroke-dasharray="3 8"' },
    }[kind];
    return `
  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${style.color}" stroke-width="${style.width}" ${style.dash} marker-end="url(#arrow-${kind})"/>
  <rect x="${(x1 + x2) / 2 - 92}" y="${(y1 + y2) / 2 - 19}" width="184" height="25" rx="8" fill="${palette.canvas}" fill-opacity="0.9"/>
  <text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2}" font-size="14" font-weight="600" fill="${style.color}" text-anchor="middle">${escapeXml(label)}</text>`;
  })
  .join("\n");

const svgNodes = nodes
  .map(
    (node) => `
  <g filter="url(#shadow)">
    <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="18" fill="${node.fill}" stroke="${node.color || palette.line}" stroke-width="3"/>
  </g>
  <text x="${node.id === "user" ? node.x + node.width / 2 : node.x + 24}" y="${node.y + 38}" font-size="${node.id === "user" ? 25 : 20}" font-weight="800" fill="${node.color || palette.ink}" text-anchor="${node.id === "user" ? "middle" : "start"}">${escapeXml(node.title)}</text>
  ${svgMultilineText(node)}`,
  )
  .join("\n");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">
  ${markerDefinitions}
  <rect width="100%" height="100%" fill="${palette.canvas}"/>
  <text x="1400" y="62" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800" fill="${palette.ink}" text-anchor="middle">FULL-SCREEN REALTIME MAC AGENT — COMPLETE IMPLEMENTATION ARCHITECTURE</text>
  <text x="1400" y="94" font-family="Inter, Arial, sans-serif" font-size="18" fill="${palette.muted}" text-anchor="middle">Purple = main execution flow · Blue dashed = UI/events · Green dotted = memory/learning/data</text>
  <g font-family="Inter, Arial, sans-serif">
    ${svgGroups}
    ${svgEdges}
    ${svgNodes}
  </g>
</svg>
`;

writeFileSync(join(outputDirectory, "full-agent-architecture.svg"), svg);

console.log(
  JSON.stringify(
    {
      excalidraw: join(outputDirectory, "full-agent-architecture.excalidraw"),
      svg: join(outputDirectory, "full-agent-architecture.svg"),
      nodes: nodes.length,
      arrows: edges.length,
      elements: excalidrawElements.length,
    },
    null,
    2,
  ),
);
