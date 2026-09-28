import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type VerificationPreset = "npm-test" | "python-unittest" | "pytest";
export interface SavedProject { id: string; name: string; aliases: string[]; root: string; verification: VerificationPreset; }
export interface CodeProjectRef extends SavedProject { baseCommit: string; }
interface ProjectState { version: 1; activeId?: string; projects: SavedProject[]; }

function cleanName(value: string) {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error("Project name must be 1–80 visible characters.");
  return name;
}
function key(value: string) { return value.trim().replace(/\s+/g, " ").toLocaleLowerCase(); }
function validPreset(value: unknown): value is VerificationPreset {
  return value === "npm-test" || value === "python-unittest" || value === "pytest";
}

export class ProjectRegistry {
  constructor(private readonly path: string) {}

  private async load(): Promise<ProjectState> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as ProjectState;
      if (state.version !== 1 || !Array.isArray(state.projects)) throw new Error("Project registry is invalid.");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [] };
      throw error;
    }
  }
  private async save(state: ProjectState) {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }
  async list(): Promise<{ projects: SavedProject[]; activeId?: string }> {
    const state = await this.load();
    return { projects: state.projects, activeId: state.activeId };
  }
  async add(directory: string, rawName: string, verification: VerificationPreset, aliases: string[] = []): Promise<SavedProject> {
    if (!validPreset(verification)) throw new Error("Choose a supported verification preset.");
    const root = await realpath(resolve(directory));
    if (!(await stat(root)).isDirectory()) throw new Error("Choose a project folder.");
    const name = cleanName(rawName);
    const names = [name, ...aliases.map(cleanName)];
    const state = await this.load();
    if (state.projects.some((project) => project.root === root)) throw new Error("This folder is already saved.");
    if (state.projects.some((project) => [project.name, ...project.aliases].some((alias) => names.some((candidate) => key(alias) === key(candidate))))) {
      throw new Error("That project name or alias is already in use.");
    }
    const project = { id: randomUUID(), name, aliases: names.slice(1), root, verification };
    state.projects.push(project);
    state.activeId ??= project.id;
    await this.save(state);
    return project;
  }
  async rename(id: string, rawName: string, aliases: string[] = []) {
    const state = await this.load();
    const project = state.projects.find((entry) => entry.id === id);
    if (!project) throw new Error("Unknown project.");
    const name = cleanName(rawName), nextAliases = aliases.map(cleanName);
    if (state.projects.some((other) => other.id !== id && [other.name, ...other.aliases].some((alias) => [name, ...nextAliases].some((candidate) => key(alias) === key(candidate))))) {
      throw new Error("That project name or alias is already in use.");
    }
    project.name = name; project.aliases = nextAliases;
    await this.save(state);
    return project;
  }
  async remove(id: string) {
    const state = await this.load();
    if (!state.projects.some((project) => project.id === id)) throw new Error("Unknown project.");
    state.projects = state.projects.filter((project) => project.id !== id);
    if (state.activeId === id) state.activeId = undefined;
    await this.save(state);
  }
  async select(query: string): Promise<SavedProject> {
    const state = await this.load();
    const matches = state.projects.filter((project) => project.id === query || [project.name, ...project.aliases].some((alias) => key(alias) === key(query)));
    if (matches.length !== 1) throw new Error(matches.length ? "Project name is ambiguous." : "Project not found. Add its folder first.");
    const project = matches[0]!;
    if (await realpath(project.root).catch(() => "") !== project.root) throw new Error("Project folder moved or changed. Re-add it before use.");
    state.activeId = project.id;
    await this.save(state);
    return project;
  }
  async selected(query?: string): Promise<SavedProject> {
    const state = await this.load();
    const candidate = query ?? state.activeId;
    if (!candidate) throw new Error("Choose a project before starting a coding Task.");
    const matches = state.projects.filter((project) => project.id === candidate || [project.name, ...project.aliases].some((alias) => key(alias) === key(candidate)));
    if (matches.length !== 1) throw new Error(matches.length ? "Project name is ambiguous." : "Project not found. Add its folder first.");
    const project = matches[0]!;
    if (await realpath(project.root).catch(() => "") !== project.root) throw new Error("Project folder moved or changed. Re-add it before use.");
    return project;
  }
  async snapshot(query?: string): Promise<CodeProjectRef> {
    const project = await this.selected(query);
    let baseCommit = "";
    try {
      const root = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: project.root, timeout: 10_000 })).stdout.trim();
      if (await realpath(root) !== project.root) throw new Error("Folder is not the Git root.");
      baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: project.root, timeout: 10_000 })).stdout.trim();
    } catch { throw new Error("Coding needs a Git project root with a commit. Choose a different folder or initialize Git."); }
    return { ...project, baseCommit };
  }
}
