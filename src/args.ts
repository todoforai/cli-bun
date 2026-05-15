/** CLI argument parsing and usage */

import { parseArgs } from "util";
import pkg from "../package.json" with { type: "json" };

export const DEFAULT_API_URL = "https://api.todofor.ai";
export const VERSION: string = pkg.version;

export function getEnv(name: string): string {
  return process.env[`TODOFORAI_${name}`] || process.env[`TODO4AI_${name}`] || "";
}

export function printUsage() {
  process.stderr.write(`
todoai — TODOforAI CLI (Bun)

Usage:
  todoai login                          # Browser-based device auth
  todoai "prompt text"                  # Prompt as argument
  todoai -n "Quick task"               # Non-interactive (run and exit)
  echo "content" | todoai              # Pipe from stdin
  todoai --path /my/project "Fix bug"  # Explicit workspace path
  todoai -c                            # Resume last todo
  todoai --resume <todo-id>            # Resume specific todo
  todoai --inspect <todo-id>           # Print full chat log (read-only)
  todoai --template <id> [--input k=v] # Start from a registry template
  todoai --list-agents                 # List available agents and exit

Options:
  --path <dir>                    Workspace path (default: cwd)
  --project <id>                  Project ID
  --agent, -a <name>              Agent name (partial match)
  --list-agents                   List available agents (name, id, workspace paths) and exit
  --api-url <url>                 API URL
  --api-key <key>                 API key
  --inspect, -i <todo-id>        Print full chat log (read-only, no interactive)
  --template, -t <id>            Start from a registry template
  --input <key=value>            Template input (repeatable)
  --resume, -r [todo-id]          Resume existing todo
  --continue, -c                  Continue most recent todo
  --non-interactive, -n           Run to completion and exit without interactive prompt
  --dangerously-skip-permissions  Auto-approve all blocks (for CI/benchmarks)
  --allow-all                     Set permissions to allow all tools (no approval needed)
  --no-watch                      Create todo and exit
  --no-edge                       Do not auto-spawn edge daemon
  --json                          Output as JSON
  --safe                          Validate API key upfront
  --debug, -d                     Debug output
  --show-config                   Show config
  --set-default-api-url           Set default API URL
  --reset-config                  Reset config file
  --version, -v                   Print version and exit
  --help, -h                      Show this help
`);
}

export function parseCliArgs() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      path: { type: "string", default: "." },
      project: { type: "string" },
      agent: { type: "string", short: "a" },
      "list-agents": { type: "boolean", default: false },
      "api-url": { type: "string" },
      "api-key": { type: "string" },
      inspect: { type: "string", short: "i" },
      template: { type: "string", short: "t" },
      input: { type: "string", multiple: true },
      resume: { type: "string", short: "r" },
      continue: { type: "boolean", short: "c", default: false },
      "non-interactive": { type: "boolean", short: "n", default: false },
      "dangerously-skip-permissions": { type: "boolean", default: false },
      "allow-all": { type: "boolean", default: false },
      "no-watch": { type: "boolean", default: false },
      "no-edge": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      safe: { type: "boolean", default: false },
      debug: { type: "boolean", short: "d", default: false },
      "show-config": { type: "boolean", default: false },
      "set-default-api-url": { type: "string" },
      "reset-config": { type: "boolean", default: false },
      "config-path": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  return { values, positionals };
}
