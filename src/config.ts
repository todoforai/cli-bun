/** Cross-platform config store — port of todoai_cli/config_store.py */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir, platform } from "os";

function getConfigDir(): string {
  const sys = platform();
  if (sys === "win32") {
    const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(base, "todoai-cli");
  }
  if (sys === "darwin") {
    return join(homedir(), "Library", "Application Support", "todoai-cli");
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "todoai-cli");
}

/** Per-apiUrl state (project + agent + last todo). */
export interface ApiUrlScope {
  default_project_id: string | null;
  default_project_name: string | null;
  default_agent_name: string | null;
  default_agent_settings: any | null;
  default_agent_settings_updated_at: string | null;
  recent_projects: { id: string; name: string }[];
  recent_agents: string[];
  last_todo_id: string | null;
}

export interface ConfigData {
  input_history: string[];
  per_api_url: Record<string, ApiUrlScope>;
}

function defaultScope(): ApiUrlScope {
  return {
    default_project_id: null,
    default_project_name: null,
    default_agent_name: null,
    default_agent_settings: null,
    default_agent_settings_updated_at: null,
    recent_projects: [],
    recent_agents: [],
    last_todo_id: null,
  };
}

function defaultConfig(): ConfigData {
  return {
    input_history: [],
    per_api_url: {},
  };
}

/** Migrate legacy top-level fields into per_api_url[<default_api_url or "https://api.todofor.ai">]. */
function migrate(raw: any): ConfigData {
  const cfg: ConfigData = { ...defaultConfig(), ...raw, per_api_url: raw.per_api_url || {} };
  const legacyKeys = [
    "default_project_id", "default_project_name",
    "default_agent_name", "default_agent_settings", "default_agent_settings_updated_at",
    "recent_projects", "recent_agents", "last_todo_id",
  ] as const;
  const hasLegacy = legacyKeys.some((k) => raw[k] != null);
  if (hasLegacy) {
    const url = raw.default_api_url || "https://api.todofor.ai";
    const scope: ApiUrlScope = { ...defaultScope(), ...(cfg.per_api_url[url] || {}) };
    for (const k of legacyKeys) if (raw[k] != null) (scope as any)[k] = raw[k];
    cfg.per_api_url[url] = scope;
  }
  for (const k of legacyKeys) delete (cfg as any)[k];
  delete (cfg as any).default_api_url;
  return cfg;
}

export class ConfigStore {
  path: string;
  data: ConfigData;

  constructor(pathArg?: string) {
    if (pathArg) {
      const p = resolve(pathArg.replace(/^~/, homedir()));
      this.path = p.endsWith(".json") ? p : join(p, "config.json");
    } else {
      this.path = join(getConfigDir(), "config.json");
    }
    this.data = this.load();
  }

  private load(): ConfigData {
    if (!existsSync(this.path)) return defaultConfig();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      delete raw.default_api_key; // legacy field — credentials live in ~/.todoforai/credentials.json
      const cfg = migrate(raw);
      // Persist migration immediately so legacy top-level fields disappear from disk.
      const needsMigration = raw.per_api_url == null;
      if (needsMigration) {
        this.data = cfg;
        this.save();
      }
      return cfg;
    } catch {
      return defaultConfig();
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
    } catch {}
  }

  /** Get (creating if missing) the per-apiUrl scope. */
  scope(apiUrl: string): ScopedConfig {
    if (!this.data.per_api_url[apiUrl]) this.data.per_api_url[apiUrl] = defaultScope();
    return new ScopedConfig(this, apiUrl);
  }

  addToHistory(input: string): void {
    const trimmed = input.trim();
    if (!trimmed) return;
    // Remove duplicates and add to end
    this.data.input_history = this.data.input_history.filter((h) => h !== trimmed);
    this.data.input_history.push(trimmed);
    // Keep last 1000 entries
    if (this.data.input_history.length > 1000) {
      this.data.input_history = this.data.input_history.slice(-1000);
    }
    this.save();
  }

  getHistory(): string[] {
    return this.data.input_history || [];
  }
}

/** Per-apiUrl view: read/write project & agent state for a specific API URL. */
export class ScopedConfig {
  constructor(private store: ConfigStore, private apiUrl: string) {}

  get data(): ApiUrlScope {
    return this.store.data.per_api_url[this.apiUrl];
  }

  setDefaultProject(id: string, name?: string): void {
    const s = this.data;
    s.default_project_id = id;
    s.default_project_name = name || id;
    s.recent_projects = [{ id, name: name || id }, ...s.recent_projects.filter((p) => p.id !== id)].slice(0, 10);
    this.store.save();
  }

  setDefaultAgent(name: string, settings?: any): void {
    const s = this.data;
    s.default_agent_name = name;
    s.default_agent_settings = settings || null;
    s.default_agent_settings_updated_at = new Date().toISOString();
    s.recent_agents = [name, ...s.recent_agents.filter((a) => a !== name)].slice(0, 10);
    this.store.save();
  }

  setLastTodoId(id: string): void {
    this.data.last_todo_id = id;
    this.store.save();
  }
}
