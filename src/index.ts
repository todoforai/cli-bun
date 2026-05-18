#!/usr/bin/env bun
/**
 * TODOforAI CLI (Bun) — Create and manage todos
 * Usage: todoai "prompt text" | echo "content" | todoai [options]
 */

import { realpathSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

import { randomTip } from "./tips";
import { ApiClient, type RegistryTemplate, type RegistryTemplateInput } from "@todoforai/edge/src/api";
import { FrontendWebSocket } from "@todoforai/edge/src/frontend-ws";
import { normalizeApiUrl } from "@todoforai/edge/src/config";

import { DEFAULT_API_URL, VERSION, getEnv, printUsage, parseCliArgs } from "./args";
import { readLine, readMultiline, readStdin } from "./input";
import { getAgentWorkspacePaths, autoCreateAgent } from "./agent";
import { ConfigStore } from "./config";
import { readCredential, writeCredential } from "./credentials";
import { BRIGHT_WHITE, CYAN, DIM, GREEN, YELLOW, RED, BRAND, RESET } from "./colors";
import { printLogo } from "./logo";
import { printFullChat } from "./inspect";
import { selectProject, selectAgent, getDisplayName, getItemId } from "./select";
import { watchTodo } from "./watch";
import { listAgentsCommand } from "./list-agents";
import { ensureEdgeRunning } from "./ensure-edge";

// ── helpers ──────────────────────────────────────────────────────────

function formatPathWithTilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? path.replace(home, "~") : path;
}

function getFrontendUrl(apiUrl: string, projectId: string, todoId: string): string {
  if (apiUrl.includes("localhost:4000") || apiUrl.includes("127.0.0.1:4000")) {
    return `http://localhost:3000/${projectId}/${todoId}`;
  }
  return `https://todofor.ai/${projectId}/${todoId}`;
}

// ── interactive loop ─────────────────────────────────────────────────

async function interactiveLoop(
  ws: FrontendWebSocket,
  api: ApiClient,
  todoId: string,
  projectId: string,
  agent: any,
  json: boolean,
  autoApprove: boolean,
  cfg: ConfigStore,
) {
  while (true) {
    try {
      let activityResolve: (() => void) | null = null;
      const activityPromise = new Promise<void>((res) => { activityResolve = res; });

      // Lightweight callback — detect activity and buffer messages so none
      // are lost in the handoff to the full watchTodo callback.
      const ignoreActivity = new Set([
        "todo:msg_start", "todo:msg_done", "todo:msg_stop_sequence",
        "todo:msg_meta_ai", "todo:status", "todo:new_message_created",
        "block:end", "block:sh_msg_start", "block:sh_done",
      ]);
      const buffered: Array<[string, any]> = [];
      ws.setCallback(todoId, (msgType: string, payload: any) => {
        buffered.push([msgType, payload]);
        if (!ignoreActivity.has(msgType)) activityResolve?.();
      });

      const { promise: inputPromise, cancel: cancelInput } = readMultiline(`${BRIGHT_WHITE}TODO>${RESET} `, cfg.getHistory());

      const winner = await Promise.race([
        inputPromise.then((v) => ({ tag: "input" as const, value: v })),
        activityPromise.then(() => ({ tag: "activity" as const, value: "" })),
      ]);

      if (winner.tag === "activity") {
        // Server sent output — cancel prompt, hand buffered messages to watchTodo
        cancelInput();
        inputPromise.catch(() => {}); // swallow cancel rejection
        process.stderr.write("\r\x1b[K"); // clear prompt line
        await watchTodo(ws, todoId, projectId, {
          json, autoApprove, agentSettings: agent,
          replayMessages: buffered,
        });
        continue;
      }
      // User input won — remove lightweight callback
      ws.setCallback(todoId);

      const input = winner.value;
      if (!input) continue;
      if (["/exit", "/quit", "/q", "q", "exit"].includes(input)) break;
      if (["/help", "?"].includes(input)) {
        process.stderr.write("  /exit, /quit, /q  - quit\n  /help, ?          - show help\n");
        continue;
      }
      cfg.addToHistory(input);
      process.stderr.write("─".repeat(40) + "\n");
      await api.addMessage(projectId, input, agent, todoId);
      await watchTodo(ws, todoId, projectId, {
        json, autoApprove, agentSettings: agent,
      });
    } catch {
      break;
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  // Handle SIGINT
  process.on("SIGINT", () => {
    process.stderr.write("\nCancelled by user (Ctrl+C)\n");
    process.exit(130);
  });

  const { values: args, positionals } = parseCliArgs();

  if (args.version) { console.log(VERSION); process.exit(0); }
  if (args.help) { printUsage(); process.exit(0); }

  // ensureEdgeRunning is intentionally NOT called here — it's invoked
  // per-branch below, only on paths that actually need the bridge daemon
  // (template / resume / create-todo). Read-only paths (--list-agents,
  // --inspect, --show-config, login, etc.) must not spawn it, otherwise
  // tool-catalog probes like `todoai --version` from the bridge end up
  // forking yet another bridge — feedback loop.

  const cfg = new ConfigStore(args["config-path"] as string);

  // ── config commands ──
  if (args["show-config"]) {
    console.log(`Config file: ${formatPathWithTilde(cfg.path)}`);
    console.log(JSON.stringify(cfg.data, null, 2));
    return;
  }
  if (args["reset-config"]) {
    const { existsSync, unlinkSync } = await import("fs");
    if (existsSync(cfg.path)) { unlinkSync(cfg.path); console.log(`Configuration reset: ${formatPathWithTilde(cfg.path)}`); }
    else console.log("No configuration file to reset");
    return;
  }
  // ── resolve API URL (shared by login + normal flow) ──
  const apiUrl = normalizeApiUrl(
    (args["api-url"] as string) || getEnv("API_URL") || DEFAULT_API_URL,
  );
  const cfgScope = cfg.scope(apiUrl);

  // ── device login ──
  async function deviceLogin(): Promise<string> {
    const loginApi = new ApiClient(apiUrl, ""); // no key needed for init
    const { code, url, expiresIn } = await loginApi.initDeviceLogin("cli");

    const userCode = new URL(url).searchParams.get("user_code") || code.slice(-8).toUpperCase();
    process.stderr.write(`\n🔑 Open this URL to authorize:\n`);
    process.stderr.write(`${CYAN}${url}${RESET}\n`);
    process.stderr.write(`Verification code: ${BRIGHT_WHITE}${userCode}${RESET}\n\n`);

    // Best-effort open browser
    try {
      const { spawn } = await import("child_process");
      if (process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
      } else {
        const cmd = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
      }
    } catch {}

    process.stderr.write(`Waiting for approval (expires in ${Math.round(expiresIn / 60)}min)...\n`);
    const deadline = Date.now() + expiresIn * 1000;
    let failures = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const poll = await loginApi.pollDeviceLogin(code);
        failures = 0;
        if (poll.status === "complete" && poll.apiKey) {
          writeCredential(apiUrl, poll.apiKey);
          process.stderr.write(`${GREEN}✅ Login successful! API key saved.${RESET}\n`);
          return poll.apiKey;
        }
        if (poll.status === "expired") break;
      } catch (e: any) {
        if (++failures >= 5) {
          process.stderr.write(`${RED}Poll failed: ${e.message}${RESET}\n`);
          process.exit(1);
        }
      }
    }
    process.stderr.write(`${RED}Login expired or failed.${RESET}\n`);
    process.exit(1);
  }

  if (positionals[0] === "login" && positionals.length === 1) {
    await deviceLogin();
    return;
  }

  // ── resolve API client ──
  // Priority: CLI flag > env > shared credentials.json (device-login)
  let apiKey = (args["api-key"] as string)
    || getEnv("API_KEY")
    || readCredential(apiUrl)
    || "";

  if (!apiKey) {
    apiKey = await deviceLogin();
  }

  const api = new ApiClient(apiUrl, apiKey);

  if (args["list-agents"]) { await listAgentsCommand(api, { json: !!args.json, formatPath: formatPathWithTilde }); return; }

  // ── inspect mode (read-only, no logo/tips) ──
  if (args.inspect) {
    const todoId = args.inspect as string;
    const todo = await api.getTodo(todoId);
    printFullChat(todo, getFrontendUrl(apiUrl, todo.projectId, todoId));
    return;
  }

  // ── logo ──
  if (process.stderr.isTTY) printLogo();

  // ── template mode ──
  if (args.template) {
    if (!args["no-edge"] && !args["no-watch"]) ensureEdgeRunning(apiUrl, apiKey);
    const templateId = args.template as string;
    const inputValues: Record<string, string> = {};
    for (const kv of (args.input as string[] || [])) {
      const eq = kv.indexOf("=");
      if (eq > 0) inputValues[kv.slice(0, eq)] = kv.slice(eq + 1);
    }

    // Fetch template to show info and prompt for missing inputs
    const template: RegistryTemplate = await api.getRegistryTemplate(templateId);
    process.stderr.write(`${DIM}Template:${RESET} ${BRAND}${template.todoname}${RESET}\n`);
    if (template.description) process.stderr.write(`${DIM}${template.description}${RESET}\n`);

    // Prompt for missing inputs (interactive only)
    const templateInputs: RegistryTemplateInput[] = template.inputs || [];
    if (templateInputs.length && !args["non-interactive"]) {
      for (const inp of templateInputs) {
        const key = inp.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
        if (inputValues[key]) continue;
        const req = inp.required ? ` ${RED}*${RESET}` : "";
        const hint = inp.placeholder ? ` ${DIM}(${inp.placeholder.split("\n")[0]})${RESET}` : "";
        const val = await readLine(`${inp.label}${req}${hint}: `);
        if (val) inputValues[key] = val;
      }
    }

    if (Object.keys(inputValues).length) {
      process.stderr.write(`${DIM}Inputs:${RESET} ${JSON.stringify(inputValues)}\n`);
    }

    // Resolve project
    const projects = await api.listProjects();
    let projectId = args.project as string;
    if (!projectId) {
      projectId = cfgScope.data.default_project_id
        || projects.find((p: any) => p.project?.isDefault)?.project?.id
        || projects[0]?.project?.id;
    }
    if (!projectId) { process.stderr.write("Error: No project found\n"); process.exit(1); }

    const todo = await api.startFromTemplate(projectId, templateId, { inputValues });
    const todoId = todo.id;
    cfgScope.setLastTodoId(todoId);

    const frontendUrl = getFrontendUrl(apiUrl, projectId, todoId);

    if (args.json) {
      console.log(JSON.stringify({ ...todo, frontend_url: frontendUrl }, null, 2));
    } else {
      process.stderr.write(`${DIM}TODO:${RESET} ${CYAN}${frontendUrl}${RESET}\n`);
    }

    if (!args["no-watch"]) {
      const ws = new FrontendWebSocket(apiUrl, apiKey);
      await ws.connect();
      const autoApprove = !!args["dangerously-skip-permissions"];
      let agent: any = todo.agentSettings || { id: todo.agentSettingsId };
      if (args["allow-all"]) {
        const perms = agent.permissions || { allow: [], ask: [], deny: [] };
        agent = { ...agent, permissions: { ...perms, allow: [...(perms.allow || []), "*:*"] } };
      }

      await watchTodo(ws, todoId, projectId, {
        json: !!args.json, autoApprove, agentSettings: agent,
      });

      if (!args["non-interactive"]) {
        process.stderr.write(`\n${"─".repeat(40)}\n`);
        await interactiveLoop(ws, api, todoId, projectId, agent, !!args.json, autoApprove, cfg);
      }

      await ws.close();
    }
    return;
  }

  // Validate if --safe
  if (args.safe) {
    const v = await api.validateApiKey();
    if (!v.valid) { process.stderr.write(`Error: ${v.error}\n`); process.exit(1); }
    process.stderr.write(`API key valid (user: ${v.userId})\n`);
  }

  // ── resume mode ──
  if (args.resume || args.continue) {
    if (!args["no-edge"]) ensureEdgeRunning(apiUrl, apiKey);
    const todoId = (args.resume as string) || cfgScope.data.last_todo_id;
    if (!todoId) { process.stderr.write("Error: No recent todo found\n"); process.exit(1); }

    const todo = await api.getTodo(todoId);
    const projectId = todo.projectId;
    const agent = todo.agentSettings || { name: "default" };

    // Display existing messages
    for (const msg of todo.messages || []) {
      const role = msg.role === "user" ? `${CYAN}You${RESET}` : `${GREEN}AI${RESET}`;
      process.stderr.write(`${role}: ${(msg.content || "").slice(0, 200)}\n`);
    }

    process.stderr.write(`\n${"─".repeat(40)}\nResumed todo: ${todoId}\n`);

    const ws = new FrontendWebSocket(apiUrl, apiKey);
    await ws.connect();

    await interactiveLoop(ws, api, todoId, projectId, agent, !!args.json, false, cfg);
    await ws.close();
    return;
  }

  // ── pre-resolve agent by --agent name or --path ──
  let preMatchedAgent: any = null;
  let agents: any[] | null = null;

  if (args.agent) {
    const matches = await api.listAgentSettings({ name: args.agent as string });
    if (matches.length > 0) {
      preMatchedAgent = matches[0];
    } else {
      process.stderr.write(`Error: Agent '${args.agent}' not found\n`);
      process.exit(1);
    }
    cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
  } else {
    // Resolve from --path or cwd
    const pathArg = (args.path as string) || ".";
    const resolved = realpathSync(resolve(pathArg));
    const matches = await api.listAgentSettings({ workspacePath: resolved });
    if (matches.length > 0) {
      preMatchedAgent = matches[0];
      cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
    } else if (args.path) {
      // Explicit --path with no match — auto-create
      process.stderr.write(`No agent found for '${formatPathWithTilde(resolved)}', creating one...\n`);
      try {
        preMatchedAgent = await autoCreateAgent(api, resolved);
        cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
      } catch (e: any) {
        process.stderr.write(`Error: Failed to auto-create agent: ${e.message}\n`);
        process.exit(1);
      }
    }
  }

  if (preMatchedAgent) {
    const paths = getAgentWorkspacePaths(preMatchedAgent);
    const pathLabel = paths.length === 1 ? "Path" : "Paths";
    const pathStr = paths.length === 1 
      ? formatPathWithTilde(paths[0]) 
      : JSON.stringify(paths.map(formatPathWithTilde));
    const model = (args.model as string) || preMatchedAgent.model;
    const modelSuffix = model ? ` ${DIM}│ Model:${RESET} ${CYAN}${model}${RESET}` : "";
    process.stderr.write(
      `${DIM}Agent:${RESET} ${BRAND}${getDisplayName(preMatchedAgent)}${RESET} ${DIM}│ ${pathLabel}:${RESET} ${CYAN}${pathStr}${RESET}${modelSuffix}\n`,
    );
  }
  process.stderr.write(`${DIM}Tip: ${randomTip()}${RESET}\n`);

  // From here on we're creating + watching a new todo, which needs the edge.
  if (!args["no-edge"] && !args["no-watch"]) ensureEdgeRunning(apiUrl, apiKey);

  // ── read content ──
  let content: string;
  if (positionals.length > 0) {
    content = positionals.join(" ");
  } else {
    content = await readStdin();
  }

  // ── select project + agent ──
  const hasProject = args.project || cfgScope.data.default_project_id;
  const storedAgent = cfgScope.data.default_agent_settings;
  const hasAgent = preMatchedAgent || (storedAgent?.id && !args.agent);

  let projects: any[] | null = null;
  if (!hasProject || !hasAgent || args.safe || args.debug) {
    projects = await api.listProjects();
    if (!hasAgent && !agents) agents = await api.listAgentSettings();
  }

  // Select project
  let projectId: string;
  let projectName: string;
  if (args.project) {
    projectId = args.project as string;
    projectName = projectId;
    if (projects) {
      const match = projects.find((p: any) => getItemId(p) === projectId);
      if (match) projectName = getDisplayName(match);
    }
  } else if (cfgScope.data.default_project_id && !projects) {
    projectId = cfgScope.data.default_project_id;
    projectName = cfgScope.data.default_project_name || projectId;
  } else {
    const sel = await selectProject(
      projects!,
      cfgScope.data.default_project_id,
      (id, name) => cfgScope.setDefaultProject(id, name),
    );
    projectId = sel.id;
    projectName = sel.name;
  }

  // Select agent
  let agent: any;
  if (preMatchedAgent) {
    agent = preMatchedAgent;
  } else if (storedAgent?.id && !agents) {
    agent = storedAgent;
  } else {
    agent = await selectAgent(
      agents!,
      cfgScope.data.default_agent_name,
      (name, settings) => cfgScope.setDefaultAgent(name, settings),
    );
  }

  // ── connect WS before creating todo to avoid missing early events ──
  const ws = args["no-watch"] ? null : new FrontendWebSocket(apiUrl, apiKey);
  if (ws) await ws.connect();

  // ── create todo ──
  if (args.model) agent = { ...agent, model: args.model };
  if (args["allow-all"]) {
    const perms = agent.permissions || { allow: [], ask: [], deny: [] };
    agent = { ...agent, permissions: { ...perms, allow: [...(perms.allow || []), "*:*"] } };
  }
  cfg.addToHistory(content);
  const todo = await api.addMessage(projectId, content, agent);
  const actualTodoId = todo.id || crypto.randomUUID();
  cfgScope.setLastTodoId(actualTodoId);

  const frontendUrl = getFrontendUrl(apiUrl, projectId, actualTodoId);

  if (args.json) {
    console.log(JSON.stringify({ ...todo, frontend_url: frontendUrl }, null, 2));
  } else {
    process.stderr.write(`${DIM}TODO:${RESET} ${CYAN}${frontendUrl}${RESET}\n`);
  }

  // ── watch ──
  if (ws) {
    const autoApprove = !!args["dangerously-skip-permissions"];

    await watchTodo(ws, actualTodoId, projectId, {
      json: !!args.json,
      autoApprove,
      agentSettings: agent,
    });

    // ── interactive follow-up ──
    if (!args["non-interactive"]) {
      process.stderr.write(`\n${"─".repeat(40)}\n`);
      await interactiveLoop(ws, api, actualTodoId, projectId, agent, !!args.json, autoApprove, cfg);
    }

    await ws.close();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
