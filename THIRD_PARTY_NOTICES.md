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
