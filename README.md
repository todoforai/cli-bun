# todoai CLI

CLI for [TODOforAI](https://todofor.ai) — create, watch, and inspect AI-powered todos.

## Install

```bash
bun install -g @todoforai/cli
```

## Setup

```bash
todoai --set-default-api-url http://localhost:4000   # or https://api.todofor.ai
todoai --set-default-api-key <your-api-key>
```

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
```
