# todoai CLI

CLI for [TODOforAI](https://todofor.ai) — create, watch, and inspect AI-powered todos.

## Install

```bash
bun install -g @todoforai/cli
```

## Setup

Just run `todoai` — on first use it opens a browser for **device login** and saves the API key to `~/.todoforai/credentials.json` (shared with the edge daemon).

```bash
todoai                # prompts device login if no key found
todoai login          # explicit login
```

API URL resolution: `--api-url` flag → `TODOFORAI_API_URL` env → `https://api.todofor.ai`.

Auth resolution: `--api-key` flag → `TODOFORAI_API_KEY` env → shared credentials (`~/.todoforai/credentials.json`) → device login.

Project, agent, and last-todo state are stored **per API URL** under `per_api_url[<url>]` in the config — switching between e.g. `https://api.todofor.ai` and `http://localhost:4000` keeps each environment's defaults isolated. Legacy top-level fields are auto-migrated on first run.

## Edge daemon

The CLI talks to the backend over WebSocket; **shell execution, file I/O, and tool calls happen in the edge daemon** running locally. On every run `todoai` spawns a detached edge process if none is running (PID-locked at `~/.todoforai/edge-<hash>.lock`, logs at `~/.todoforai/edge.log`). It keeps running after the CLI exits, so long-running tasks survive `Ctrl+D`.

Disable with `--no-edge` if you manage the edge yourself (e.g. systemd, separate terminal).

## Usage

### Create a todo from a prompt

```bash
todoai "Fix the login bug"
todoai -n "Quick task"                    # non-interactive (run and exit)
echo "content" | todoai                   # pipe from stdin
todoai --path /my/project "Fix bug"       # explicit workspace
```

### Start from a registry template

```bash
todoai --template alternativeto-listing                          # interactive input prompts
todoai --template f5bot-monitoring-setup --input "monitoring_details=My Brand"  # with inputs
todoai --template f5bot-monitoring-setup --no-watch --json       # create only
```

When inputs are missing, the CLI prompts interactively (unless `-n`).

### Inspect a todo (read-only)

```bash
todoai --inspect <todo-id>
```

Prints the full chat log: messages, tool calls (type, status, path/cmd), results, and errors. No logo, no interactive mode.

### Resume / continue

```bash
todoai -c                     # continue most recent todo
todoai --resume <todo-id>     # resume specific todo
```

## All Options

```
--path <dir>                    Workspace path (default: cwd)
--project <id>                  Project ID
--agent, -a <name>              Agent name (partial match)
--api-url <url>                 API URL
--api-key <key>                 API key
--template, -t <id>             Start from a registry template
--input <key=value>             Template input (repeatable)
--inspect, -i <todo-id>         Print full chat log (read-only)
--resume, -r [todo-id]          Resume existing todo
--continue, -c                  Continue most recent todo
--non-interactive, -n           Run to completion and exit
--dangerously-skip-permissions  Auto-approve all blocks (CI/benchmarks)
--allow-all                     Set permissions to allow all tools (no approval needed)
--no-watch                      Create todo and exit
--no-edge                       Do not auto-spawn edge daemon
--json                          Output as JSON
--safe                          Validate API key upfront
--debug, -d                     Debug output
--show-config                   Show config
--reset-config                  Reset config file
--help, -h                      Show this help
```
