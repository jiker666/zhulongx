# Third-Party Notices

## Claude Agent SDK

The embedded agent runtime uses `@anthropic-ai/claude-agent-sdk` 0.3.268 (© Anthropic PBC. All rights reserved.
Use is subject to the Legal Agreements outlined at https://code.claude.com/docs/en/legal-and-compliance), with
required peers `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod`. Platform-specific CLI binaries ship as
optional dependencies of the SDK package.

## MIT-Licensed Runtime Dependencies

`@modelcontextprotocol/sdk`, `zod`, `typebox`, `yaml`, `undici`, `yauzl`, `domhandler`, `htmlparser2`, and
`playwright` are distributed under the MIT license. Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
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

The core image fetches hash-verified release archives for Radare2 6.2.0 (LGPL-3.0-or-later with mixed-license
plugins) and JADX 1.5.5 (Apache-2.0). It also installs Pwntools 4.15.0 (MIT) from the pinned Python requirements.
These remain third-party image contents, not vendored source. Redistributors must retain and comply with the
licenses supplied by those upstream releases and packages.

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

The manifest also records operator-managed references that are not installed or advertised as default runtime
capabilities. `jvdsn/crypto-attacks` is recorded at `d42a3df980bf029f682f218fa2893ed2d6af98d8`
under MIT, and `maple3142/gf2bv` at `4357db5cae0dc1213526b93180b9a26f14a91070` under
GPL-2.0. `lll_cvp`, `lattice-based-cryptanalysis`, and the intended `cuso` upstream remain disabled until an
operator verifies their repository-wide license and reproducible installation/smoke-test contract. Ghidra and
UPX are operator-installed extensions. Merely appearing in this review list does not add a
program to the sandbox image or the runtime allowlist.

## Agent Architecture References

The following repositories were reviewed at fixed commits as architectural and capability references:

- `FishCodeTech/muteki` at `a585a2943a15efc4de78b00a385335fc9b1f23f1` (AGPL-3.0).
- `verialabs/ctf-agent` at `3366d569557c4fda3fd153040632de65e255396d` (MIT).
- `Yeti-791/Tsec-Hackathon` at `7b264c7f20cf11e790855194692a494aedbdb21c` (competition materials; no repository-wide LICENSE file was present at review time).
- `deepseek-ai/deepseek-harness` at `47f943859bef60e4160492346772ded9b24f765a` (MIT).

No source from Muteki or target-specific Tsec competition skills/MCP packages is included. General concepts such
as evidence blackboards, heterogeneous races, trace-based review, provenance gates, worker cancellation, and
tool-profile coverage were independently implemented under this project's policy and audit model. See
`docs/reference-agent-study.md` for the evidence and benchmark caveats.

DeepSeek Harness was used as a design reference for append-only session events, source-oriented trajectory views,
request-context snapshots, event-sequence forks, and replay-derived UI. No DeepSeek Harness source code or package
dependency is included; the corresponding behavior was independently implemented on top of this project's existing
SHA-256 audit chain, secret sanitization, bounded artifacts, and `PolicyEngine` boundary.

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
