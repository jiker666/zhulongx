# Third-Party Notices

## Pi Agent Harness

This project uses the following MIT-licensed packages from the Pi Agent Harness:

- `@earendil-works/pi-agent-core` 0.83.0
- `@earendil-works/pi-ai` 0.83.0

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Reference-Only Repository

`jiker666/claude-code-master` was reviewed only as an architectural reference. Its repository metadata says
`UNLICENSED` and describes recovered materials with unresolved redistribution rights. No source code from that
repository is included in this project.

## CTF Sandbox Tool Profile

The optional CTF sandbox image installs third-party command-line tools, Python packages, Ruby gems, and Debian
packages listed in `tools/ctf/capabilities.json`, `tools/ctf/requirements-core.txt`, and
`tools/ctf/requirements-heavy.txt`. These tools are not vendored into this repository; they are fetched by the
sandbox Docker build or by an operator running the install scripts. Operators are responsible for reviewing and
complying with each upstream package license before redistribution or competition deployment.

The opt-in heavy profile fetches the following source tools at the commits recorded in
`tools/ctf/capabilities.json`:

- RsaCtfTool (`7c98848f1945de3e67a420871e8672f5ad9aa5d5`), MIT.
- stegseek (`58969789a5724701048d5d5510af84098cc1f1ea`), GPL-2.0.
- flatter (`d2b8026f29b4a69e987b15d4b240f8a5053275d3`), LGPL-3.0.
- radare2 (`77618b4c7feaa294782c12040a634d5863ea71c1`), LGPL-3.0-or-later with mixed-license plugins.
- CADO-NFS (`9bb8fc0799bbaaf0b47a1edf573ecf5e0cf8e46a`), LGPL-2.1.

The RsaCtfTool and CADO-NFS source trees remain in the generated image. The build copies the upstream stegseek,
flatter, and radare2 license files to `/usr/share/doc/xuanshu-heavy/` before deleting their build trees.
Redistributors must preserve these notices and independently satisfy source-distribution, relinking, or other
copyleft obligations for the image they distribute; a pinned upstream URL alone is not a substitute for those
obligations.

## Agent Architecture References

The following repositories were reviewed at fixed commits as architectural and capability references:

- `FishCodeTech/muteki` at `a585a2943a15efc4de78b00a385335fc9b1f23f1` (AGPL-3.0).
- `verialabs/ctf-agent` at `3366d569557c4fda3fd153040632de65e255396d` (MIT).
- `Yeti-791/Tsec-Hackathon` at `7b264c7f20cf11e790855194692a494aedbdb21c` (competition materials; no repository-wide LICENSE file was present at review time).

No source from Muteki or target-specific Tsec competition skills/MCP packages is included. General concepts such
as evidence blackboards, heterogeneous races, trace-based review, provenance gates, worker cancellation, and
tool-profile coverage were independently implemented under this project's policy and audit model. See
`docs/reference-agent-study.md` for the evidence and benchmark caveats.

## Curated CTF Skill Index

The category names, technique-family classification, and routing cues in `src/skill-catalog.ts` are adapted from
[`ljagiello/ctf-skills`](https://github.com/ljagiello/ctf-skills) at commit
`d6662d26b5ed3caa56f5eaf6eb887964f3747162`. The upstream project is licensed under the MIT License.
Challenge-specific examples, payloads, fixed targets, and upstream executable scripts are not included.

Copyright (c) 2026 Lukasz Jagiello

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
## NSSCTF Agent Arena Skill

The user-supplied `nssctf-agent-arena` skill archive declares the MIT license. Its reference material is included under `skills/nssctf-agent-arena/`; the project adaptation does not import its direct shell or network permission declarations. Arena execution remains implemented by this project's `ArenaClient`, `PolicyEngine`, scope configuration, budgets, and audit chain.

## Imported CTF Web Skill

The user requested import of `tokeii0-ctfskill-ctf-web-skill` version 1.0.1 from LobeHub. The package is retained as Markdown reference material under `skills/tokeii0-ctfskill-ctf-web-skill/`. Its upstream license was not present in the downloaded archive; review the upstream licensing terms before redistribution. No executable files are included in the imported package.
