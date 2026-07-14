# SOTA cyber-agent reference matrix

This document records design ideas only; it does not claim parity with any
referenced system. No third-party agent framework code was copied.

| Reference | Transferable idea | Not adopted | Project mapping | Status |
|---|---|---|---|---|
| EnIGMA | persistent agent-computer interaction and grounded observations | framework/runtime copy | Worker PTY, Observation Authority | partial |
| CAI | specialist handoff, hierarchical roles, traces | vendor swarm implementation | future pattern service | planned |
| CTF-Dojo | isolated executable tasks and verified trajectories | external dataset/code | Worker, trajectory store | partial |
| ATLANTIS / OSS-CRS | deterministic analysis beside LLM planning | platform-specific pipeline | Analysis Bus | planned |
| Fuzzing Brain | fuzzer owns execution; LLM guides seeds/results | unrestricted fuzzing | Fuzzing engine adapter | planned |
| CTFusion | live evaluation, isolation, standard submission | external benchmark claims | Blind Evaluation profile | planned |

Only project-owned code and existing dependencies are used. New dependencies
must be reviewed for license and recorded before introduction.
