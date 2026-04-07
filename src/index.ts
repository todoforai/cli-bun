#!/usr/bin/env bun
/**
 * TODOforAI CLI (Bun) — Create and manage todos
 * Usage: todoai "prompt text" | echo "content" | todoai [options]
 */

import { realpathSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

import { randomTip } from "./tips";
import { ApiClient } from "@todoforai/edge/src/api";
import { FrontendWebSocket } from "@todoforai/edge/src/frontend-ws";
import { normalizeApiUrl } from "@todoforai/edge/src/config";

import { DEFAULT_API_URL, getEnv, printUsage, parseCliArgs } from "./args";
import { readLine, readMultiline, readStdin } from "./input";
import { getAgentWorkspacePaths, autoCreateAgent } from "./agent";
import { ConfigStore } from "./config";
import { BRIGHT_WHITE, CYAN, DIM, GREEN, YELLOW, RED, BOLD, BRAND, RESET } from "./colors";
import { printLogo } from "./logo";
import { selectProject, selectAgent, getDisplayName, getItemId } from "./select";
import { watchTodo } from "./watch";

// ── helpers ──────────────────────────────────────────────────────────

function formatPathWithTilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? path.replace(home, "~") : path;
}

function printFullChat(todo: any, apiUrl: string) {
  const url = getFrontendUrl(apiUrl, todo.projectId, todo.id);
  const statusColors: Record<string, string> = {
    DONE: GREEN, READY: GREEN, READY_CHECKED: GREEN,
    ERROR: RED, ERROR_CHECKED: RED, CANCELLED: RED, CANCELLED_CHECKED: RED,
    RUNNING: YELLOW, STOPPING: YELLOW, TODO: CYAN,
  };
  const statusColor = statusColors[todo.status] || DIM;

  process.stderr.write(`${BOLD}TODO${RESET} ${todo.id}\n`);
  process.stderr.write(`${DIM}Status:${RESET} ${statusColor}${todo.status}${RESET}\n`);
  process.stderr.write(`${DIM}URL:${RESET}    ${CYAN}${url}${RESET}\n`);
  process.stderr.write(`${DIM}Created:${RESET} ${new Date(todo.createdAt).toLocaleString()}\n`);
  if (todo.agentSettingsId) process.stderr.write(`${DIM}Agent:${RESET}  ${todo.agentSettingsId}\n`);
  process.stderr.write("─".repeat(60) + "\n");

  const messages = todo.messages || [];
  if (!messages.length) {
    process.stderr.write(`${DIM}(no messages)${RESET}\n`);
    return;
  }

  for (const msg of messages) {
    const isUser = msg.role === "user";
    const roleLabel = isUser ? `${CYAN}▶ USER${RESET}` : `${GREEN}◀ ASSISTANT${RESET}`;
    process.stderr.write(`\n${roleLabel} ${DIM}${new Date(msg.createdAt).toLocaleTimeString()}${RESET}\n`);

    // Message content
    if (msg.content) {
      const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + `\n${DIM}... (${msg.content.length} chars total)${RESET}` : msg.content;
      process.stdout.write(content + "\n");
    }

    // Blocks (tool calls)
    for (const block of msg.blocks || []) {
      const blockStatusColor = block.status === "COMPLETED" ? GREEN : block.status === "ERROR" ? RED : block.status === "DENIED" ? RED : YELLOW;
      process.stderr.write(`\n  ${YELLOW}[${block.type}]${RESET} ${blockStatusColor}${block.status}${RESET}`);
      if (block.path) process.stderr.write(` ${DIM}path=${RESET}${block.path}`);
      if (block.cmd) process.stderr.write(` ${DIM}cmd=${RESET}${block.cmd}`);
      if (block.name) process.stderr.write(` ${DIM}name=${RESET}${block.name}`);
      if (block.server_name) process.stderr.write(` ${DIM}server=${RESET}${block.server_name}`);
      if (block.tool_name) process.stderr.write(` ${DIM}tool=${RESET}${block.tool_name}`);
      process.stderr.write("\n");

      // Block content (the tool call input / code)
      if (block.content) {
        const content = block.content.length > 500 ? block.content.slice(0, 500) + `\n${DIM}... (${block.content.length} chars)${RESET}` : block.content;
        process.stdout.write(`  ${DIM}│${RESET} ${content.split("\n").join(`\n  ${DIM}│${RESET} `)}\n`);
      }

      // Block result
      if (block.result) {
        const result = block.result.length > 500 ? block.result.slice(0, 500) + `\n${DIM}... (${block.result.length} chars)${RESET}` : block.result;
        process.stderr.write(`  ${DIM}└─ result:${RESET} ${result.split("\n").join(`\n  ${DIM}│${RESET}  `)}\n`);
      }

      // Error
      if (block.error_message) {
        process.stderr.write(`  ${RED}└─ error: ${block.error_message}${RESET}\n`);
      }
      if (block.stacktrace) {
        const st = block.stacktrace.length > 300 ? block.stacktrace.slice(0, 300) + "..." : block.stacktrace;
        process.stderr.write(`  ${DIM}${st}${RESET}\n`);
      }
    }
  }

  process.stderr.write("\n" + "─".repeat(60) + "\n");
  const blockCount = messages.reduce((n: number, m: any) => n + (m.blocks?.length || 0), 0);
  const errorBlocks = messages.reduce((n: number, m: any) => n + (m.blocks || []).filter((b: any) => b.status === "ERROR" || b.type === "error").length, 0);
  process.stderr.write(`${DIM}Messages: ${messages.length} | Blocks: ${blockCount} | Errors: ${errorBlocks}${RESET}\n`);
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

      const { promise: inputPromise, cancel: cancelInput } = readMultiline(`${BRIGHT_WHITE}TODO>${RESET} `);

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

  if (args.help) { printUsage(); process.exit(0); }

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
  if (args["set-default-api-url"]) { cfg.setDefaultApiUrl(args["set-default-api-url"] as string); console.log(`Default API URL set to: ${args["set-default-api-url"]}`); return; }
  if (args["set-default-api-key"]) { cfg.setDefaultApiKey(args["set-default-api-key"] as string); console.log("Default API key set"); return; }
  if (args["set-defaults"]) {
    // Interactive defaults — simple version
    const url = await readLine(`API URL [${cfg.data.default_api_url || DEFAULT_API_URL}]: `);
    if (url) cfg.setDefaultApiUrl(url);
    const key = await readLine("API Key: ");
    if (key) cfg.setDefaultApiKey(key);
    console.log("Defaults saved.");
    return;
  }

  // ── resolve API client ──
  // Priority: CLI flag > config > env > default
  const apiUrl = normalizeApiUrl(
    (args["api-url"] as string) || cfg.data.default_api_url || getEnv("API_URL") || DEFAULT_API_URL,
  );
  const apiKey = (args["api-key"] as string) || cfg.data.default_api_key || getEnv("API_KEY") || "";

  if (!apiKey) {
    process.stderr.write("Error: No API key. Set via --api-key, TODOFORAI_API_KEY env, or --set-default-api-key\n");
    process.exit(1);
  }

  const api = new ApiClient(apiUrl, apiKey);

  // ── inspect mode (read-only, no logo/tips) ──
  if (args.inspect) {
    const todoId = args.inspect as string;
    const todo = await api.getTodo(todoId);
    printFullChat(todo, apiUrl);
    return;
  }

  // ── logo ──
  if (process.stderr.isTTY) printLogo();

  // Validate if --safe
  if (args.safe) {
    const v = await api.validateApiKey();
    if (!v.valid) { process.stderr.write(`Error: ${v.error}\n`); process.exit(1); }
    process.stderr.write(`API key valid (user: ${v.userId})\n`);
  }

  // ── resume mode ──
  if (args.resume || args.continue) {
    const todoId = (args.resume as string) || cfg.data.last_todo_id;
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

    await interactiveLoop(ws, api, todoId, projectId, agent, !!args.json, false);
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
    cfg.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
  } else {
    // Resolve from --path or cwd
    const pathArg = (args.path as string) || ".";
    const resolved = realpathSync(resolve(pathArg));
    const matches = await api.listAgentSettings({ workspacePath: resolved });
    if (matches.length > 0) {
      preMatchedAgent = matches[0];
      cfg.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
    } else if (args.path) {
      // Explicit --path with no match — auto-create
      process.stderr.write(`No agent found for '${formatPathWithTilde(resolved)}', creating one...\n`);
      try {
        preMatchedAgent = await autoCreateAgent(api, resolved);
        cfg.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
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
    process.stderr.write(
      `${DIM}Agent:${RESET} ${BRAND}${getDisplayName(preMatchedAgent)}${RESET} ${DIM}│ ${pathLabel}:${RESET} ${CYAN}${pathStr}${RESET}\n`,
    );
  }
  process.stderr.write(`${DIM}Tip: ${randomTip()}${RESET}\n`);

  // ── read content ──
  let content: string;
  if (positionals.length > 0) {
    content = positionals.join(" ");
  } else {
    content = await readStdin();
  }

  // ── select project + agent ──
  const hasProject = args.project || cfg.data.default_project_id;
  const storedAgent = cfg.data.default_agent_settings;
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
  } else if (cfg.data.default_project_id && !projects) {
    projectId = cfg.data.default_project_id;
    projectName = cfg.data.default_project_name || projectId;
  } else {
    const sel = await selectProject(
      projects!,
      cfg.data.default_project_id,
      (id, name) => cfg.setDefaultProject(id, name),
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
      cfg.data.default_agent_name,
      (name, settings) => cfg.setDefaultAgent(name, settings),
    );
  }

  // ── create todo ──
  const todo = await api.addMessage(projectId, content, agent);
  const actualTodoId = todo.id || crypto.randomUUID();
  cfg.data.last_todo_id = actualTodoId;
  cfg.save();

  const frontendUrl = getFrontendUrl(apiUrl, projectId, actualTodoId);

  if (args.json) {
    console.log(JSON.stringify({ ...todo, frontend_url: frontendUrl }, null, 2));
  } else {
    process.stderr.write(`${DIM}TODO:${RESET} ${CYAN}${frontendUrl}${RESET}\n`);
  }

  // ── watch ──
  if (!args["no-watch"]) {
    const ws = new FrontendWebSocket(apiUrl, apiKey);
    await ws.connect();
    const autoApprove = !!args["dangerously-skip-permissions"];

    await watchTodo(ws, actualTodoId, projectId, {
      json: !!args.json,
      autoApprove,
      agentSettings: agent,
    });

    // ── interactive follow-up ──
    if (!args["non-interactive"]) {
      process.stderr.write(`\n${"─".repeat(40)}\n`);
      await interactiveLoop(ws, api, actualTodoId, projectId, agent, !!args.json, autoApprove);
    }

    await ws.close();
  }
}

main().catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
