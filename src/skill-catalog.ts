export type CtfSkillCategory =
  | "web"
  | "pwn"
  | "crypto"
  | "reverse"
  | "forensics"
  | "malware"
  | "misc"
  | "osint"
  | "ai/ml";

export interface CuratedCtfSkill {
  id: string;
  category: CtfSkillCategory;
  description: string;
  techniqueFamilies: string[];
  pivotSignals: string[];
  upstreamPath: string;
}

export const CTF_SKILL_SOURCE = {
  repository: "ljagiello/ctf-skills",
  url: "https://github.com/ljagiello/ctf-skills",
  commit: "d6662d26b5ed3caa56f5eaf6eb887964f3747162",
  license: "MIT",
} as const;

const SKILLS: Record<CtfSkillCategory, CuratedCtfSkill> = {
  web: {
    id: "ctf-web",
    category: "web",
    description: "HTTP applications, APIs, browser clients, identity flows, and smart-contract-backed services.",
    techniqueFamilies: [
      "surface and trust-boundary mapping",
      "authentication and authorization analysis",
      "database and expression injection",
      "server-side request and parser behavior",
      "file, path, upload, and serialization handling",
      "browser, session, and client-side state",
      "race conditions and multi-stage verification",
    ],
    pivotSignals: [
      "Move to reverse when a compiled client or custom VM is the main unknown.",
      "Move to crypto when token or protocol mathematics is the actual blocker.",
    ],
    upstreamPath: "ctf-web/SKILL.md",
  },
  pwn: {
    id: "ctf-pwn",
    category: "pwn",
    description: "Native binary exploitation after a concrete memory-corruption or low-level primitive is established.",
    techniqueFamilies: [
      "architecture and mitigation inventory",
      "stack and format-string primitives",
      "ROP, ret2libc, and syscall-oriented control flow",
      "heap lifetime and allocator invariants",
      "sandbox and seccomp constraints",
      "kernel and cross-architecture execution",
      "local-to-remote synchronization and verification",
    ],
    pivotSignals: [
      "Move to reverse when program behavior or the input format is still unknown.",
      "Move to forensics when the main evidence is a crash dump or captured traffic.",
    ],
    upstreamPath: "ctf-pwn/SKILL.md",
  },
  crypto: {
    id: "ctf-crypto",
    category: "crypto",
    description: "Cryptographic constructions, mathematical weaknesses, randomness, signatures, and implementation oracles.",
    techniqueFamilies: [
      "classical cipher and encoding separation",
      "RSA and integer factorization relationships",
      "block and stream cipher misuse",
      "elliptic-curve and signature nonce analysis",
      "PRNG state and seed recovery",
      "lattice, LWE, and hidden-number methods",
      "finite-field, CRC, and constraint-system analysis",
      "oracle, side-channel, and protocol verification",
    ],
    pivotSignals: [
      "Move to reverse when the primitive is hidden inside an unknown implementation.",
      "Move to forensics when extraction or reconstruction precedes cryptanalysis.",
    ],
    upstreamPath: "ctf-crypto/SKILL.md",
  },
  reverse: {
    id: "ctf-reverse",
    category: "reverse",
    description: "Compiled, packed, obfuscated, virtualized, firmware, mobile, WASM, and bytecode targets.",
    techniqueFamilies: [
      "format, architecture, and packing triage",
      "control-flow and data-flow recovery",
      "static and dynamic cross-validation",
      "custom VM and bytecode semantics",
      "managed runtime and mobile formats",
      "anti-debug and anti-analysis behavior",
      "minimal behavioral reimplementation",
    ],
    pivotSignals: [
      "Move to pwn after the vulnerability and required exploitation primitive are understood.",
      "Move to malware when configuration, persistence, or command-and-control behavior dominates.",
    ],
    upstreamPath: "ctf-reverse/SKILL.md",
  },
  forensics: {
    id: "ctf-forensics",
    category: "forensics",
    description: "Disk, memory, packet, log, media, signal, filesystem, and container evidence.",
    techniqueFamilies: [
      "artifact hashing and format validation",
      "disk, filesystem, and deleted-data recovery",
      "memory and process-state analysis",
      "network and peripheral capture reconstruction",
      "image, audio, video, and document steganography",
      "timeline and cross-source correlation",
      "provenance-preserving extraction",
    ],
    pivotSignals: [
      "Move to crypto when a recovered blob is blocked on a mathematical weakness.",
      "Move to malware when the recovered artifact requires behavior or configuration analysis.",
    ],
    upstreamPath: "ctf-forensics/SKILL.md",
  },
  malware: {
    id: "ctf-malware",
    category: "malware",
    description: "Static malware analysis, obfuscation, configuration extraction, and captured protocol reconstruction.",
    techniqueFamilies: [
      "sample identity and static capability triage",
      "script, package, and string deobfuscation",
      "PE, managed-runtime, and shellcode analysis",
      "configuration and indicator extraction",
      "custom protocol and encrypted traffic recovery",
      "anti-analysis and environment checks",
      "observed behavior versus capability claims",
    ],
    pivotSignals: [
      "Move to reverse when program semantics, packing, or a custom VM is the main blocker.",
      "Move to forensics when host or packet evidence is more important than sample code.",
    ],
    upstreamPath: "ctf-malware/SKILL.md",
  },
  misc: {
    id: "ctf-misc",
    category: "misc",
    description: "Cross-category puzzles whose main invariant is encoding, constraints, a jail, a game, or an unusual medium.",
    techniqueFamilies: [
      "encoding and reversible transform chains",
      "pickle, Python, and shell language constraints",
      "symbolic and constraint solving",
      "game, VM, and state-machine modeling",
      "radio, SDR, audio, OCR, barcode, and image workflows",
      "Unicode and esoteric language behavior",
      "hybrid evidence-driven category pivots",
    ],
    pivotSignals: [
      "Prefer a specific category as soon as one domain explains the evidence better.",
      "Move to forensics when recovery and provenance become the primary work.",
    ],
    upstreamPath: "ctf-misc/SKILL.md",
  },
  osint: {
    id: "ctf-osint",
    category: "osint",
    description: "Passive investigation of public records, media, geolocation, DNS, identities, and historical sources.",
    techniqueFamilies: [
      "source provenance and timestamp tracking",
      "username and identity disambiguation",
      "image, landmark, and geolocation corroboration",
      "DNS, certificate, and archive history",
      "public repository and document analysis",
      "alternative hypotheses and confidence grading",
      "privacy-preserving passive collection",
    ],
    pivotSignals: [
      "Move to forensics when local artifacts or captures become the primary evidence.",
      "Move to web only when an explicitly authorized application must be tested actively.",
    ],
    upstreamPath: "ctf-osint/SKILL.md",
  },
  "ai/ml": {
    id: "ctf-ai-ml",
    category: "ai/ml",
    description: "Machine-learning models, adversarial inputs, extraction, inference, poisoning, adapters, and LLM interfaces.",
    techniqueFamilies: [
      "model interface and preprocessing recovery",
      "weight, adapter, and activation comparison",
      "adversarial example generation and evaluation",
      "model extraction and membership inference",
      "training-data and backdoor analysis",
      "prompt and tool-boundary testing",
      "baseline, seed, and generalization verification",
    ],
    pivotSignals: [
      "Move to crypto when the model is only a wrapper around a mathematical construction.",
      "Move to reverse when a compiled model loader or inference engine is the main unknown.",
    ],
    upstreamPath: "ctf-ai-ml/SKILL.md",
  },
};

const ALIASES: Array<[RegExp, CtfSkillCategory]> = [
  [/web|api/i, "web"],
  [/pwn|binary exploitation/i, "pwn"],
  [/crypto|cryptography/i, "crypto"],
  [/reverse|reversing|逆向|disassembl|decompil|\bpe\b|\belf\b/i, "reverse"],
  [/forensic|取证/i, "forensics"],
  [/malware|恶意/i, "malware"],
  [/osint/i, "osint"],
  [/ai|ml|machine learning/i, "ai/ml"],
  [/misc|综合/i, "misc"],
];

export function resolveCtfSkillCategory(category: string | undefined): CtfSkillCategory | undefined {
  if (!category) return undefined;
  return ALIASES.find(([pattern]) => pattern.test(category))?.[1];
}

export function listCuratedCtfSkills(): CuratedCtfSkill[] {
  return Object.values(SKILLS).map((skill) => ({
    ...skill,
    techniqueFamilies: [...skill.techniqueFamilies],
    pivotSignals: [...skill.pivotSignals],
  }));
}

export function renderCuratedCtfSkill(category: string | undefined): string {
  const key = resolveCtfSkillCategory(category);
  if (!key) return "";
  const skill = SKILLS[key];
  return [
    `CURATED CTF SKILL INDEX (${skill.id})`,
    `Reference: ${CTF_SKILL_SOURCE.repository}@${CTF_SKILL_SOURCE.commit.slice(0, 12)} / ${skill.upstreamPath} (${CTF_SKILL_SOURCE.license}).`,
    "This is a reviewed routing index, not evidence and not an authorization grant. Every action still uses registered tools and PolicyEngine scope/budgets.",
    `Focus: ${skill.description}`,
    `Technique families: ${skill.techniqueFamilies.join("; ")}.`,
    "Pivot signals:",
    ...skill.pivotSignals.map((signal, index) => `${index + 1}. ${signal}`),
  ].join("\n");
}
