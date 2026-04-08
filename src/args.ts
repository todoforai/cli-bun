/** CLI argument parsing and usage */

import { parseArgs } from "util";

export const DEFAULT_API_URL = "https://api.todofor.ai";

export function getEnv(name: string): string {
  return process.env[`TODOFORAI_${name}`] || process.env[`TODO4AI_${name}`] || "";
}

export function printUsage() {
  process.stderr.write(`
todoai — TODOforAI CLI (Bun)

Usage:
  todoai "prompt text"                  # Prompt as argument
  todoai -n "Quick task"               # Non-interactive (run and exit)
  echo "content" | todoai              # Pipe from stdin
  todoai --path /my/project "Fix bug"  # Explicit workspace path
  todoai -c                            # Resume last todo
  todoai --resume <todo-id>            # Resume specific todo
  todoai --inspect <todo-id>           # Print full chat log (read-only)
  todoai --template <id> [--input k=v] # Start from a registry template

Options:
  --path <dir>                    Workspace path (default: cwd)
  --project <id>                  Project ID
  --agent, -a <name>              Agent name (partial match)
  --api-url <url>                 API URL
  --api-key <key>                 API key
  --inspect, -i <todo-id>        Print full chat log (read-only, no interactive)
  --template, -t <id>            Start from a registry template
  --input <key=value>            Template input (repeatable)
  --resume, -r [todo-id]          Resume existing todo
  --continue, -c                  Continue most recent todo
  --non-interactive, -n           Run to completion and exit without interactive prompt
  --dangerously-skip-permissions  Auto-approve all blocks (for CI/benchmarks)
  --no-watch                      Create todo and exit
  --json                          Output as JSON
  --safe                          Validate API key upfront
  --debug, -d                     Debug output
  --show-config                   Show config
  --set-defaults                  Interactive defaults setup
  --set-default-api-url           Set default API URL
  --set-default-api-key           Set default API key
  --reset-config                  Reset config file
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
      "api-url": { type: "string" },
      "api-key": { type: "string" },
      inspect: { type: "string", short: "i" },
      template: { type: "string", short: "t" },
      input: { type: "string", multiple: true },
      resume: { type: "string", short: "r" },
      continue: { type: "boolean", short: "c", default: false },
      "non-interactive": { type: "boolean", short: "n", default: false },
      "dangerously-skip-permissions": { type: "boolean", default: false },
      "no-watch": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      safe: { type: "boolean", default: false },
      debug: { type: "boolean", short: "d", default: false },
      "show-config": { type: "boolean", default: false },
      "set-defaults": { type: "boolean", default: false },
      "set-default-api-url": { type: "string" },
      "set-default-api-key": { type: "string" },
      "reset-config": { type: "boolean", default: false },
      "config-path": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  return { values, positionals };
}
