import type { GraphNodeKind } from "./types";
export const NODE_REGISTRY: Record<GraphNodeKind, { label: string; color: string }> = {
  target: { label: "目标", color: "#7bdcf5" }, service: { label: "服务", color: "#7bdcf5" }, endpoint: { label: "端点", color: "#7bdcf5" }, artifact: { label: "工件", color: "#b9a1ff" },
  action: { label: "动作", color: "#55d8ae" }, evidence: { label: "证据", color: "#63d9c3" }, hypothesis: { label: "假设", color: "#b597ff" }, candidate: { label: "候选", color: "#e6bc64" }, verification: { label: "验证", color: "#68df9a" }, finding: { label: "发现", color: "#68df9a" },
};
