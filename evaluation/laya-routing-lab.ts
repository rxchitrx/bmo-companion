import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LayaRouter, type VoiceRoute } from "../electron/laya-router.js";

const cases: Array<[VoiceRoute, string]> = [
  ["conversation", "Hello BMO, how are you today?"],
  ["conversation", "Explain what an isolated Git worktree is."],
  ["conversation", "What did we decide about the project plan?"],
  ["conversation", "Tell me a short joke."],
  ["conversation", "How does a calendar work?"],
  ["project", "Switch to my BMO project."],
  ["project", "Make Moksh my active project."],
  ["project", "Which coding project is selected?"],
  ["project", "Use the Atlas folder for my next coding task."],
  ["project", "Show me the projects I have saved."],
  ["coding", "Fix the login bug in the BMO repository."],
  ["coding", "Add a unit test for the parser."],
  ["coding", "Refactor the TypeScript task engine."],
  ["coding", "Create a Python function to sort these records in my project."],
  ["coding", "Debug the failing build and edit the source code."],
  ["connector", "What's on my calendar tomorrow?"],
  ["connector", "Read the latest email from Alex."],
  ["connector", "Add a Todoist task for Friday."],
  ["connector", "Find the GitHub issue assigned to me."],
  ["connector", "Create a reminder to call Mom."],
  ["browser", "Open the documentation website in the browser."],
  ["browser", "Search the web for trains to Mumbai."],
  ["browser", "Click the checkout button on this website."],
  ["browser", "Navigate to the company careers page."],
  ["browser", "Fill in this web form."],
  ["computer", "Open Finder and move this window to the other display."],
  ["computer", "Change the Mac volume to 30 percent."],
  ["computer", "Switch to the Notes app on my Mac."],
  ["computer", "Take a screenshot of the current desktop."],
  ["computer", "Close the active desktop application."],
];
const router = new LayaRouter();
if (!router.available) throw new Error("Local Laya runtime is not installed. Set BMO_LAYA_PYTHON.");
const rows = [];
try {
  await router.route("Hello", 30_000); // Cold model load is outside measured calls.
  for (const [expected, text] of cases) {
    const start = performance.now();
    const decision = await router.route(text, 10_000);
    rows.push({ expected, text, predicted: decision?.route ?? null, confidence: decision?.confidence ?? null, ms: Math.round(performance.now() - start), correct: decision?.route === expected });
  }
} finally { router.close(); }
const correct = rows.filter((row) => row.correct).length;
const confident = rows.filter((row) => (row.confidence ?? 0) >= 0.8);
const wrongConfident = confident.filter((row) => !row.correct);
const report = { model: "aac6fef/laya-mlx", samples: rows.length, correct, accuracy: correct / rows.length,
  highConfidence: confident.length, wrongHighConfidence: wrongConfident.length,
  medianMs: [...rows.map((row) => row.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)], rows };
const outputIndex = process.argv.indexOf("--output");
const output = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] ?? "outputs/evaluation/laya-routing-2026-09-28.json" : "outputs/evaluation/laya-routing-2026-09-28.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ samples: report.samples, correct, accuracy: report.accuracy, highConfidence: report.highConfidence, wrongHighConfidence: report.wrongHighConfidence, medianMs: report.medianMs, output })}\n`);
if (wrongConfident.length) process.exitCode = 1;
