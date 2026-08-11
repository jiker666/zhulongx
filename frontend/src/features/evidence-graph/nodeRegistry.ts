import type { GraphNodeKind } from "./types";
export const NODE_REGISTRY: Record<GraphNodeKind, { label: string; color: string }> = {
  target: { label: "目标", color: "#4d748b" }, service: { label: "服务", color: "#4d748b" }, endpoint: { label: "端点", color: "#4d748b" }, artifact: { label: "工件", color: "#756394" },
  action: { label: "动作", color: "#4f7d67" }, evidence: { label: "证据", color: "#4d806f" }, hypothesis: { label: "假设", color: "#756394" }, candidate: { label: "候选", color: "#9b6e30" }, verification: { label: "验证", color: "#4f7d67" }, finding: { label: "发现", color: "#4f7d67" },
};
