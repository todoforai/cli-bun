/** Watch todo execution and handle block approvals — port of watch.py */

import { FrontendWebSocket } from "@todoforai/edge/src/frontend-ws";
import { singleChar } from "./select";
import { getBlockPatterns } from "@shared/fbe/bashPatterns";
import { getNewPatterns } from "@shared/fbe/permissionUtils";
import { renderDiff } from "./diff-view";
import { YELLOW, GREEN, RED, DIM, CYAN, RESET } from "./colors";

type DiffEntry = { originalContent: string; modifiedContent: string };
const diffStoreByWs = new WeakMap<FrontendWebSocket, Map<string, DiffEntry>>();

// ── block classification ─────────────────────────────────────────────

function classifyBlock(info: any): string {
  const inner = (info.block_type || "").toLowerCase();
  if (["create", "createfile"].includes(inner)) return "create";
  if (["modify", "modifyfile", "update", "edit"].includes(inner)) return "edit";
  if (["catfile", "read", "readfile"].includes(inner)) return "read";
  if (inner === "mcp") return "mcp";
  if (["shell", "bash"].includes(inner) || info.cmd) return "shell";
  return "unknown";
}

function blockDisplay(info: any): [string, string] {
  const labels: Record<string, string> = { create: "File", edit: "Edit", read: "Read File", mcp: "MCP", shell: "Shell" };
  const kind = classifyBlock(info);
  const typeLabel = labels[kind] || info.block_type || "Tool";
  const skipKeys = new Set([
    "userId", "messageId", "todoId", "blockId", "block_type", "edge_id", "timeout", "updates",
    "changes", "originalContent", "modifiedContent", "approvalContext", "generalized_pattern",
    "status", "toolCallId", "result",
  ]);
  const knownKeys = new Set(["path", "filePath", "content", "cmd", "name"]);

  let display = info.path || info.filePath || info.content || info.cmd || info.name || "";
  const rest = Object.entries(info).filter(([k, v]) => !skipKeys.has(k) && !knownKeys.has(k) && v);
  if (rest.length) {
    const extra = rest.map(([k, v]) => `${k}=${v}`).join(" ");
    display = display ? `${display} (${extra})` : extra;
  }
  if (!display) display = "<pending>";
  if (display.length > 200) display = display.slice(0, 200) + "...";
  return [typeLabel, display];
}

// ── approval helpers ─────────────────────────────────────────────────

function sendApproval(ws: FrontendWebSocket, blockId: string, messageId: string, todoId: string, decision: string = "allow_once", patterns?: string[]): void {
  const payload: any = { todoId, messageId, blockId, decision };
  if (patterns && patterns.length > 0) {
    payload.patterns = patterns;
  }
  (ws as any).ws?.send(JSON.stringify({
    type: "BLOCK_APPROVAL_INTENT",
    payload,
  }));
}

// ── main watch function ──────────────────────────────────────────────

export interface WatchOpts {
  json?: boolean;
  autoApprove?: boolean;
  agentSettings?: any;
  interruptOnCancel?: boolean;
  suppressCancelNotice?: boolean;
  activityEvent?: { set(): void };
  /** Messages buffered during callback handoff to replay before watching. */
  replayMessages?: Array<[string, any]>;
}

export async function watchTodo(
  ws: FrontendWebSocket,
  todoId: string,
  projectId: string,
  opts: WatchOpts = {},
): Promise<boolean> {
  const ignore = new Set([
    "todo:msg_start", "todo:msg_done", "todo:msg_stop_sequence",
    "todo:msg_meta_ai", "todo:new_message_created",
    "block:end", "block:sh_msg_start", "block:sh_done",
  ]);
  // Old-style block start events — store info but don't display
  const blockStartEvents = new Set([
    "block:start_shell", "block:start_createfile",
    "block:start_modifyfile", "block:start_mcp", "block:start_catfile",
  ]);

  const signalActivity = () => opts.activityEvent?.set();

  // Resolve edge_id + root_path from agent settings
  let edgeId: string | undefined;
  let rootPath = "";
  if (opts.agentSettings) {
    const emc = opts.agentSettings.edgesMcpConfigs || {};
    edgeId = Object.keys(emc)[0];
    if (edgeId) {
      const ec = emc[edgeId];
      const tc = ec?.todoai_edge || ec?.todoai || {};
      rootPath = (tc.workspacePaths || [])[0] || "";
    }
  }

  // Track block info from start events + BLOCK_UPDATE updates
  const blocksStore = new Map<string, Record<string, any>>();
  // Persist diffs across watchTodo instances for a given websocket connection
  const diffStore = diffStoreByWs.get(ws) ?? new Map<string, DiffEntry>();
  diffStoreByWs.set(ws, diffStore);
  const diffRendered = new Set<string>();

  let approveAll = !!opts.autoApprove;
  let interruptCount = 0;

  // Set up Ctrl+C handler
  const origHandler = process.listeners("SIGINT").slice();
  process.removeAllListeners("SIGINT");
  process.on("SIGINT", () => {
    interruptCount++;
    if (interruptCount >= 2) {
      process.stderr.write(`\n${RED}Force exit (double Ctrl+C)${RESET}\n`);
      process.exit(130);
    }
    process.stderr.write(`\n${YELLOW}Interrupting... (Ctrl+C again to force exit)${RESET}\n`);
    if (opts.interruptOnCancel !== false) {
      ws.sendInterrupt(projectId, todoId);
    }
  });

  // Pending approval blocks
  const pendingBlocks: any[] = [];
  let approvalPromptActive = false;
  // Blocks currently shown in approval prompt (for late-arriving diff rendering)
  let activeApprovalBlocks: any[] = [];

  async function handleApprovals() {
    if (approvalPromptActive || pendingBlocks.length === 0) return;
    approvalPromptActive = true;

    const blocks = pendingBlocks.splice(0).map(bi => {
      const latest = bi?.blockId ? (blocksStore.get(bi.blockId) || {}) : {};
      return { ...latest, ...bi };
    });

    if (approveAll) {
      for (const bi of blocks) {
        const [tl, disp] = blockDisplay(bi);
        process.stderr.write(`\n${YELLOW}⚠ Auto-approving [${tl}]${RESET} ${disp}\n`);
        sendApproval(ws, bi.blockId, bi.messageId, todoId);
      }
      approvalPromptActive = false;
      if (pendingBlocks.length > 0) {
        void handleApprovals();
      }
      return;
    }

    // Register blocks now so late-arriving diffs can render during the wait
    activeApprovalBlocks = blocks;
    // Brief pause so preprocess_tool's async diff BLOCK_UPDATE can arrive before we render
    const hasFileBlocks = blocks.some(bi => ["create", "edit"].includes(classifyBlock(bi)));
    if (hasFileBlocks) await new Promise(r => setTimeout(r, 1500));
    process.stderr.write(`\n${YELLOW}⚠ ${blocks.length} action(s) awaiting approval:${RESET}\n`);
    for (const bi of blocks) {
      const [tl, disp] = blockDisplay(bi);
      process.stderr.write(`  ${YELLOW}[${tl}]${RESET} ${disp}\n`);
      const ctx = bi.approvalContext || {};
      const installs = ctx.toolInstalls || [];
      if (installs.length) {
        process.stderr.write(`  ${CYAN}↳ Install tools: ${installs.join(", ")}${RESET}\n`);
      }
      // Show word-level diff if already available
      const diff = diffStore.get(bi.blockId);
      if (diff && !diffRendered.has(bi.blockId)) {
        diffRendered.add(bi.blockId);
        const filePath = bi.path || bi.filePath || "file";
        process.stderr.write(renderDiff(diff.originalContent, diff.modifiedContent, filePath));
      }
    }

    // Pre-compute patterns for the remember hint (hide already-allowed)
    const allPatterns = blocks.flatMap(bi => getBlockPatterns({
      type: bi.block_type || "unknown",
      generalized_pattern: bi.generalized_pattern,
      cmd: bi.cmd,
    }));
    const newPatterns = getNewPatterns(allPatterns, opts.agentSettings?.permissions);
    const stripPrefix = (p: string) => p.replace(/^todoai_(edge|cloud):/, '');
    const patternHint = newPatterns.length ? ` ${DIM}${newPatterns.map(stripPrefix).join(", ")}${RESET}` : "";

    try {
      const response = await singleChar(`  [Y]es / [n]o / [a]ll / [r]emember${patternHint}? `);
      if (response === "a") {
        approveAll = true;
      }
      if (response === "a" || response === "y" || response === "" || response === "r") {
        const decision = response === "r" ? "allow_remember" : "allow_once";
        for (const bi of blocks) {
          let patterns: string[] | undefined;
          if (response === "r") {
            // Compute patterns from merged block info (block:start_universal + BLOCK_UPDATE)
            patterns = getBlockPatterns({
              type: bi.block_type || "unknown",
              generalized_pattern: bi.generalized_pattern,
              cmd: bi.cmd,
            });
            if (patterns.length > 0) {
              process.stderr.write(`  ${GREEN}✓ Remembering: ${patterns.map(stripPrefix).join(", ")}${RESET}\n`);
            }
          }
          sendApproval(ws, bi.blockId, bi.messageId, todoId, decision, patterns);
        }
      } else {
        for (const bi of blocks) {
          ws.sendBlockDeny(todoId, bi.messageId, bi.blockId);
        }
        process.stderr.write(`  ${RED}✗ Denied${RESET}\n`);
      }
    } catch {
      // Interrupted — auto-approve
      for (const bi of blocks) {
        sendApproval(ws, bi.blockId, bi.messageId, todoId);
      }
    }
    activeApprovalBlocks = [];
    approvalPromptActive = false;
    if (pendingBlocks.length > 0) {
      void handleApprovals();
    }
  }

  const callback = (msgType: string, payload: any) => {
    if (msgType === "block:message") {
      process.stdout.write(payload.content || "");
      signalActivity();
    } else if (msgType === "BLOCK_UPDATE") {
      const updates = payload.updates || {};
      const status = updates.status;
      const result = updates.result;
      // Merge updates into blocksStore (includes originalContent/modifiedContent for diffs)
      if (payload.blockId && Object.keys(updates).length) {
        const stored = blocksStore.get(payload.blockId) || {};
        blocksStore.set(payload.blockId, { ...stored, ...updates });
      }
      if (payload.blockId && (updates.originalContent !== undefined || updates.modifiedContent !== undefined)) {
        diffStore.set(payload.blockId, {
          originalContent: updates.originalContent ?? "",
          modifiedContent: updates.modifiedContent ?? "",
        });
      }
      // Render diff whenever originalContent/modifiedContent arrive (approval, auto-approve, or post-completion)
      if ((updates.originalContent !== undefined || updates.modifiedContent !== undefined) && !diffRendered.has(payload.blockId)) {
        diffRendered.add(payload.blockId);
        const bi = blocksStore.get(payload.blockId) || {};
        const filePath = bi.path || bi.filePath || updates.path || "file";
        process.stderr.write(renderDiff(updates.originalContent || "", updates.modifiedContent || "", filePath));
      }
      if (result) {
        process.stderr.write(`\n${DIM}--- Block Result ---\n${result}${RESET}\n`);
        signalActivity();
      } else if (status === "AWAITING_APPROVAL") {
        // Merge stored block start info so classifyBlock/blockDisplay/getBlockPatterns work
        const stored = blocksStore.get(payload.blockId) || {};
        pendingBlocks.push({ ...stored, ...payload, ...updates });
        void handleApprovals();
        signalActivity();
      } else if (status && status !== "COMPLETED" && status !== "RUNNING") {
        process.stderr.write(`\n[block:update] status=${status}\n`);
        signalActivity();
      }
    } else if (msgType === "block:start_universal") {
      const skip = new Set(["userId", "messageId", "todoId", "blockId", "block_type", "edge_id", "timeout", "parentBlockId"]);
      const blockType = payload.block_type || "UNIVERSAL";
      const isEdit = classifyBlock(payload) === "edit";
      const parts = Object.entries(payload)
        .filter(([k]) => !skip.has(k) && !(isEdit && k === "changes"))
        .map(([k, v]) => `${k}=${v}`);
      const extra = parts.length ? ` ${parts.join(" ")}` : "";
      process.stderr.write(`\n${YELLOW}*${RESET} ${YELLOW}${blockType}${RESET}${extra}\n`);
      // Store block info for later use in approval pattern computation
      if (payload.blockId) {
        blocksStore.set(payload.blockId, payload);
      }
      signalActivity();
    } else if (msgType === "block:sh_msg_result") {
      const content = payload.content || "";
      if (content) {
        const lines = content.trim().split("\n");
        const preview = lines.slice(0, 4).map((l: string) => `  ${DIM}│${RESET} ${l}`).join("\n");
        const extra = lines.length > 4 ? `\n  ${DIM}│ +${lines.length - 4} lines${RESET}` : "";
        process.stderr.write(`${preview}${extra}\n`);
        signalActivity();
      }
    } else if (msgType === "todo:status") {
      const status = payload.status || "";
      process.stderr.write(`\n${DIM}[todo:status] ${status}${RESET}\n`);
      signalActivity();
    } else if (blockStartEvents.has(msgType)) {
      // Store block info from old-style start events for approval pattern computation
      if (payload.blockId) {
        blocksStore.set(payload.blockId, payload);
      }
    } else if (!ignore.has(msgType)) {
      process.stderr.write(`\n[${msgType}]\n`);
      signalActivity();
    }
  };

  // Replay any messages buffered during callback handoff
  if (opts.replayMessages) {
    for (const [msgType, payload] of opts.replayMessages) {
      callback(msgType, payload);
    }
  }

  try {
    const result = await ws.waitForCompletion(todoId, callback);
    process.stdout.write("\n");
    if (!result?.success) {
      const status = result?.payload?.status || result?.type || "unknown";
      process.stderr.write(`Warning: Stopped: ${status}\n`);
    }
    return true;
  } catch (e: any) {
    if (!opts.suppressCancelNotice) {
      process.stderr.write(`${YELLOW}Interrupted${RESET}\n`);
    }
    return false;
  } finally {
    // Restore SIGINT handlers
    process.removeAllListeners("SIGINT");
    for (const fn of origHandler) process.on("SIGINT", fn as any);
  }
}
