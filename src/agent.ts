/** Agent resolution — workspace path matching and auto-creation */

import { realpathSync } from "fs";
import { resolve, basename } from "path";
import { ApiClient } from "@todoforai/edge/src/api";

export function getAgentWorkspacePaths(agent: any): string[] {
  const paths: string[] = [];
  for (const ec of Object.values(agent.edgesMcpConfigs || {}) as any[]) {
    const tc = ec?.todoai_edge || ec?.todoai || {};
    paths.push(...(tc.workspacePaths || []));
  }
  return paths;
}

export function findAgentByPath(agents: any[], path: string): any | null {
  const resolved = realpathSync(resolve(path));
  for (const agent of agents) {
    for (const wp of getAgentWorkspacePaths(agent)) {
      try {
        if (realpathSync(resolve(wp)) === resolved) return agent;
      } catch {}
    }
  }
  return null;
}

export async function autoCreateAgent(api: ApiClient, resolvedPath: string): Promise<any> {
  const folderName = basename(resolvedPath) || "default";

  // 1. Create agent
  const resp = await api.createAgent();
  const agentId = resp.id || resp.agentSettingsId;
  if (!agentId) throw new Error(`Failed to create agent: ${JSON.stringify(resp)}`);
  const agentSettingsId = resp.agentSettingsId || agentId;

  // 2. Set name
  await api.updateAgentSettings(agentId, agentSettingsId, { name: folderName });

  // 3. Find edge ID
  const edges = await api.listEdges();
  const edgeId = Array.isArray(edges) && edges.length ? edges[0].id : null;
  if (!edgeId) throw new Error("No edge available to configure workspace path");

  // 4. Set workspace path
  await api.setAgentEdgeMcpConfig(agentId, agentSettingsId, edgeId, "todoai_edge", { workspacePaths: [resolvedPath] });

  // 5. Re-fetch enriched agent
  const matches = await api.listAgentSettings({ workspacePath: resolvedPath });
  if (matches.length) return matches[0];

  // Fallback — construct from what we know
  resp.name = folderName;
  resp.edgesMcpConfigs = { [edgeId]: { todoai_edge: { workspacePaths: [resolvedPath] } } };
  return resp;
}
