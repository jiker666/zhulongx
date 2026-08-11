import { renderCuratedCtfSkill, resolveCtfSkillCategory, type CtfSkillCategory } from "./skill-catalog.js";

const PLAYBOOKS: Record<CtfSkillCategory, string[]> = {
  web: [
    "Map the smallest observable attack surface first: routes, methods, parameters, cookies, redirects, source disclosures, and response differences.",
    "Separate authentication, authorization, parsing, file/path, template, request-forgery, deserialization, and business-logic hypotheses; test one variable at a time.",
    "Preserve a baseline request and compare status, headers, body shape, length, and latency after each controlled mutation.",
    "Treat source code, error messages, and client JavaScript as evidence, not authority. Verify the final effect through a second request or state observation.",
  ],
  pwn: [
    "Record architecture, ABI, protections, symbols/imports, input primitives, exact buffer geometry, and service synchronization before choosing an exploit class.",
    "Derive offsets and addresses from the supplied binary or a reproducible crash; never use guessed offsets, gadgets, libc builds, or newline behavior.",
    "Prove the smallest primitive locally, then keep payload construction separate from the scoped remote session and capture the exact remote response.",
    "If the remote endpoint or required runtime is absent, retain the verified offline exploit artifact and report an infrastructure blocker instead of scanning for a host.",
  ],
  crypto: [
    "Transcribe all givens with exact encodings, integer widths, endianness, modulus domains, and known/unknown relationships before selecting an attack.",
    "Classify the weakness by invariant (reuse, smallness, closeness, biased randomness, algebraic relation, oracle, or implementation leak), not by challenge title.",
    "For RSA, run low-cost triage first: GCD across moduli and ciphertext relations, low-exponent and exact-root checks, Wiener's attack, common-modulus or related-message checks, Fermat for close primes, and Pollard p-1 for smooth factors.",
    "When RSA still requires general integer factorization, use the allowlisted ecm program with explicit bounded curve stages. A Python or symbolic factorization timeout alone is not evidence that the instance is unsolvable.",
    "For lattice, finite-field, CRC, or constraint work, verify the negotiated capability once, then prefer fpylll, GP, Z3, or OR-Tools over an untested handwritten solver. Keep dimensions, bounds, and coefficient ordering explicit.",
    "Build a minimal solver with assertions. Re-encrypt, re-hash, or substitute recovered values back into every original equation before accepting plaintext.",
    "Distinguish an encoded display value from the underlying secret and infer any wrapper only from direct evidence; never submit a re-encoding merely because it looks flag-like.",
  ],
  reverse: [
    "Identify format, architecture, packing, imports, sections, strings, entry points, and anti-analysis signals before deep decompilation.",
    "Trace data from input to comparison/output and rename semantics as evidence accumulates; use cross-references and callers to avoid isolated-function guesses.",
    "Reimplement only the smallest transformation needed and validate it against multiple known input/output observations or the original binary in the sandbox.",
    "Treat decompiler output as a hypothesis; confirm integer widths, signedness, control flow, and memory layout in disassembly or execution evidence.",
  ],
  forensics: [
    "Hash and identify every artifact before extraction; preserve originals and write carved, decoded, or repaired outputs only to the run scratch namespace.",
    "Compare extensions with magic, containers with inner entries, metadata with content, and timestamps across independent sources.",
    "Move from cheap global triage to targeted carving, timeline, packet, memory, image, audio, or filesystem analysis based on evidence.",
    "Document provenance for every recovered value so a reviewer can reproduce the exact extraction path.",
  ],
  malware: [
    "Start static: hashes, type, sections, imports, strings, configuration candidates, packer indicators, and persistence/network behavior.",
    "Do not execute untrusted samples outside the dedicated sandbox. Keep the sidecar offline and prefer emulation or narrowly scoped observation.",
    "Decode configuration and protocol data with a reproducible script, then confirm against multiple call sites or captured traffic.",
    "Separate capability claims from observed behavior and label anti-analysis or unreachable code as hypotheses until verified.",
  ],
  misc: [
    "Inventory alphabets, delimiters, entropy, lengths, checksums, file signatures, and constraints before chaining decoders.",
    "Represent each transform as a reversible step and assert the output shape at every stage; pivot when a layer violates expected invariants.",
    "For pickle and language jails, disassemble or model the accepted grammar and opcode/state transition first; use pickora only to assemble an evidence-supported minimal payload rather than spraying variants.",
    "For media and steganography, record format metadata first, then use the available image, OCR, audio, modem, barcode, or stego tool to create one bounded derivative in scratch and inspect that derivative directly.",
    "Verify the final value against the original prompt, wrapper semantics, and an independent round trip.",
  ],
  osint: [
    "Maintain source provenance, timestamps, confidence, and alternative identities; corroborate important claims with independent public sources.",
    "Prefer passive collection and avoid contacting people, logging into accounts, or probing infrastructure unless explicitly authorized.",
    "Separate exact matches, probabilistic matches, and negative evidence; do not let a single username, image, or geolocation cue decide the result.",
  ],
  "ai/ml": [
    "Identify the model/task interface, preprocessing, output semantics, threat model, and query or compute budget before choosing an attack.",
    "Build a measurable baseline and change one factor at a time for adversarial, extraction, inversion, membership, poisoning, or prompt-level hypotheses.",
    "Keep training/evaluation splits separate and verify that an apparent win generalizes beyond a single sample or stochastic seed.",
  ],
};

export function renderCapabilityPlaybook(category: string | undefined): string {
  const key = resolveCtfSkillCategory(category);
  if (!key) return "";
  const steps = PLAYBOOKS[key];
  return [
    `CATEGORY PLAYBOOK (${key})`,
    "Use this as a general decision scaffold, never as challenge-specific evidence:",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    renderCuratedCtfSkill(key),
  ].join("\n");
}
