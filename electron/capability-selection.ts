import type {
  Connector,
  ConnectorActionSummary,
  ConnectorStatus,
} from "./connector-types.js";

export const CAPABILITY_MANIFEST_VERSION = 1 as const;
export const CAPABILITY_SELECTION_LIMITS = Object.freeze({
  maxRequestChars: 500,
  maxRequestTokens: 24,
  maxRequestedCapabilityIds: 16,
  maxServices: 4,
  maxActions: 8,
} as const);

// Adding a connector action does not make it model-visible automatically. A reviewer
// must add its stable id here before the selector can place it in a manifest.
export const MODEL_VISIBLE_CAPABILITY_ALLOWLIST: ReadonlySet<string> = new Set([
  "calendar.list_calendars",
  "calendar.list_events",
  "calendar.create_event",
  "calendar.update_event",
  "reminders.list_reminder_lists",
  "reminders.list_reminders",
  "reminders.create_reminder",
  "reminders.update_reminder",
  "reminders.complete_reminder",
  "contacts.search_contacts",
  "contacts.create_contact",
  "contacts.update_contact",
  "notes.search_notes",
  "notes.read_note",
  "notes.create_note",
  "notes.append_note",
  "shortcuts.list_shortcuts",
  "shortcuts.run_shortcut",
  "music.now_playing",
  "music.playpause",
  "music.next",
  "music.previous",
  "music.play_track",
  "files.search_files",
  "google.search_gmail",
  "google.read_gmail",
  "google.send_email",
  "google.search_drive",
  "google.upload_drive_file",
  "google.read_doc",
  "google.create_doc",
  "google.read_sheet",
  "google.append_sheet",
  "todoist.list_tasks",
  "todoist.create_task",
  "todoist.complete_task",
  "todoist.update_task",
  "github.list_issues",
  "github.view_issue",
  "github.list_pull_requests",
  "github.view_pull_request",
  "github.comment_issue",
  "github.create_issue",
  "github.notifications",
  "obsidian.search_notes",
  "obsidian.read_note",
  "obsidian.create_note",
  "obsidian.append_note",
]);

export interface CapabilitySelectionRequest {
  task: string;
  requestedCapabilityIds?: readonly string[];
}

export interface CapabilityManifestService {
  id: string;
  label: string;
  category: ConnectorStatus["category"];
  actions: ConnectorActionSummary[];
}

export interface CapabilityManifest {
  version: typeof CAPABILITY_MANIFEST_VERSION;
  authority: "selection-only";
  limits: typeof CAPABILITY_SELECTION_LIMITS;
  request: {
    charsConsidered: number;
    tokenCount: number;
    truncated: boolean;
  };
  capabilities: CapabilityManifestService[];
  selectedCapabilityIds: string[];
  omitted: {
    notAllowlisted: number;
    irrelevant: number;
    overLimit: number;
  };
}

type Candidate = {
  connector: Connector;
  action: ConnectorActionSummary;
  id: string;
  serviceMatches: number;
  actionMatches: number;
  requested: boolean;
};

const tokens = (value: string, maximum = Number.POSITIVE_INFINITY) =>
  [...new Set(value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])]
    .slice(0, maximum);

const overlap = (left: readonly string[], right: ReadonlySet<string>) =>
  left.reduce((count, token) => count + Number(right.has(token)), 0);

function actionSummary(action: Connector["actions"][number]): ConnectorActionSummary {
  const { run: _run, ...summary } = action;
  return summary;
}

export function selectCapabilityManifest(
  connectors: readonly Connector[],
  request: CapabilitySelectionRequest,
  allowlist: ReadonlySet<string> = MODEL_VISIBLE_CAPABILITY_ALLOWLIST,
): CapabilityManifest {
  const boundedTask = request.task.slice(0, CAPABILITY_SELECTION_LIMITS.maxRequestChars);
  const requestTokens = tokens(boundedTask, CAPABILITY_SELECTION_LIMITS.maxRequestTokens);
  const requestTokenSet = new Set(requestTokens);
  const requestedIds = new Set(
    [...(request.requestedCapabilityIds ?? [])]
      .slice(0, CAPABILITY_SELECTION_LIMITS.maxRequestedCapabilityIds)
      .filter((id) => id.length <= 128)
      .filter((id) => allowlist.has(id))
      .sort(),
  );
  let notAllowlisted = 0;
  const candidates: Candidate[] = [];

  for (const connector of connectors) {
    const serviceTokens = tokens(`${connector.id} ${connector.label} ${connector.category}`);
    const serviceTokenSet = new Set(serviceTokens);
    const serviceMatches = overlap(requestTokens, serviceTokenSet);
    for (const connectorAction of connector.actions) {
      const id = `${connector.id}.${connectorAction.name}`;
      if (!allowlist.has(id)) {
        notAllowlisted += 1;
        continue;
      }
      const actionTokens = tokens([
        connectorAction.name,
        connectorAction.label,
        connectorAction.description,
        ...connectorAction.parameters.flatMap((parameter) => [
          parameter.name,
          parameter.description,
        ]),
      ].join(" ")).filter((token) => !serviceTokenSet.has(token));
      candidates.push({
        connector,
        action: actionSummary(connectorAction),
        id,
        serviceMatches,
        actionMatches: overlap(actionTokens, requestTokenSet),
        requested: requestedIds.has(id),
      });
    }
  }

  const relevant = candidates.filter((candidate) => {
    if (candidate.requested) return true;
    if (requestTokens.length === 0) return false;
    if (candidate.actionMatches > 0) return true;
    if (candidate.serviceMatches === 0) return false;
    return !candidates.some((other) =>
      other.connector.id === candidate.connector.id && other.actionMatches > 0);
  });
  relevant.sort((left, right) =>
    Number(right.requested) - Number(left.requested) ||
    right.actionMatches - left.actionMatches ||
    right.serviceMatches - left.serviceMatches ||
    left.id.localeCompare(right.id));

  const selected: Candidate[] = [];
  const selectedServices = new Set<string>();
  for (const candidate of relevant) {
    if (selected.length >= CAPABILITY_SELECTION_LIMITS.maxActions) break;
    const isNewService = !selectedServices.has(candidate.connector.id);
    if (isNewService && selectedServices.size >= CAPABILITY_SELECTION_LIMITS.maxServices) continue;
    selected.push(candidate);
    selectedServices.add(candidate.connector.id);
  }

  const capabilities = [...selectedServices]
    .sort()
    .map((serviceId) => {
      const matching = selected.filter((candidate) => candidate.connector.id === serviceId);
      const connector = matching[0]!.connector;
      return {
        id: connector.id,
        label: connector.label,
        category: connector.category,
        actions: matching.map((candidate) => candidate.action),
      };
    });

  return {
    version: CAPABILITY_MANIFEST_VERSION,
    authority: "selection-only",
    limits: CAPABILITY_SELECTION_LIMITS,
    request: {
      charsConsidered: boundedTask.length,
      tokenCount: requestTokens.length,
      truncated: boundedTask.length !== request.task.length,
    },
    capabilities,
    selectedCapabilityIds: selected.map((candidate) => candidate.id),
    omitted: {
      notAllowlisted,
      irrelevant: candidates.length - relevant.length,
      overLimit: relevant.length - selected.length,
    },
  };
}
