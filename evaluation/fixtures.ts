import type { CanaryAdapter, CanaryObservation } from "./types";

const observations: Readonly<Record<string, CanaryObservation>> = {
  "zero-tool-startup": {
    outputText: "CANARY_OK",
    events: ["turn-complete"],
    toolCallNames: [],
  },
  "ordinary-conversation": {
    outputText: "Hello! How can I help?",
    events: ["turn-complete"],
    toolCallNames: [],
  },
  "approval-pause": {
    outputText: "Waiting for approval.",
    events: ["approval-requested"],
    toolCallNames: [],
  },
  "stop-cancel": {
    outputText: "Task cancelled.",
    events: ["task-started", "stop-requested", "task-cancelled"],
    toolCallNames: [],
  },
  "connector-discovery-budget": {
    outputText: "Connector discovery complete.",
    events: ["connector-discovery-complete"],
    toolCallNames: ["discover_services"],
    connectorDiscoveryBytes: 1_024,
  },
};

export const deterministicFixtureAdapter: CanaryAdapter = {
  mode: "deterministic-fixture",
  async run(canary) {
    const observation = observations[canary.id];
    if (!observation) {
      throw new Error(`No deterministic fixture exists for ${canary.id}`);
    }
    return structuredClone(observation);
  },
};
