import assert from "node:assert/strict";
import test from "node:test";
import { CompanionMemoryService, type MemoryCandidate, type MemoryStore } from "../electron/memory-service.ts";

class InMemoryStore implements MemoryStore {
  records: MemoryCandidate[] = [];
  async load() { return structuredClone(this.records); }
  async save(records: MemoryCandidate[]) { this.records = structuredClone(records); }
}

test("recalls only relevant bounded local memories and exposes their ledger/source references", async () => {
  const store = new InMemoryStore();
  const memory = new CompanionMemoryService(store, () => "2026-07-27T00:00:00.000Z");
  await memory.rememberCompletedTask({ taskId: "website", goal: "Publish the BMO website", summary: "Published the companion website", artifacts: [{ label: "Published site", sourceName: "GitHub Pages", sourceUrl: "https://example.test/site" }] });
  await memory.rememberCompletedTask({ taskId: "taxes", goal: "Prepare tax notes", summary: "Tax notes are ready" });

  const answer = await memory.recall("What happened with the website?");
  assert.match(answer.answer, /Published the companion website/);
  assert.doesNotMatch(answer.answer, /Tax notes/);
  assert.equal(answer.references[0]?.ledgerReference, "ledger://tasks/website");
  assert.equal(answer.references.some((reference) => reference.source?.sourceName === "GitHub Pages"), true);
  assert.equal(JSON.stringify(store.records).includes("rawSourceContent"), false);
});

test("sensitive, uncertain, or uncorroborated candidates stay reviewable and cannot be recalled", async () => {
  const memory = new CompanionMemoryService(new InMemoryStore());
  const candidates = await memory.rememberCompletedTask({ taskId: "private", goal: "Handle a private matter", summary: "A sensitive outcome", sensitivity: "sensitive", confidence: 0.99, corroborated: true });
  assert.equal(candidates.every((candidate) => candidate.state === "review"), true);
  assert.equal((await memory.recall("private sensitive outcome")).references.length, 0);
});

test("rejects raw External Source content at the local-memory boundary", async () => {
  const memory = new CompanionMemoryService(new InMemoryStore());
  await assert.rejects(
    () => memory.rememberCompletedTask({ taskId: "mail", goal: "Read mail", summary: "Done", artifacts: [{ label: "Mail", sourceName: "Gmail", content: "private mail body" }] } as never),
    /cannot be stored/,
  );
});
