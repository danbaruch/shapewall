# Third-party components

The optional server-side Buzz bridge verifies BIP-340/Nostr signatures with `@noble/curves` 2.4.0 and its `@noble/hashes` 2.4.0
dependency (MIT), and decodes NIP-19 keys with `@scure/base` 2.4.0 (MIT). These libraries are runtime npm dependencies, not browser
bundles. Their licenses ship with their packages. Source: [noble-curves](https://github.com/paulmillr/noble-curves),
[noble-hashes](https://github.com/paulmillr/noble-hashes), [scure-base](https://github.com/paulmillr/scure-base).

Shapewall is Apache 2.0 (with `src/hosted` under FSL 1.1, see `NOTICE`). This file lists third-party code and data that ship inside
the built board (`dist/client`, and the public demo) beyond the usual npm dependencies, or that the board downloads at run time. Each
component keeps its own license; none of them is GPL or LGPL.

## Natural read-aloud voices (`client/src/chat/tts`, built as `assets/tts-*`)

Loaded only when someone turns natural voices on (docs/agents.md, "Natural voices"). Everything runs in the browser.

| Component                                                                           | What it is                                                                                                                                                                                                                                                                        | License                                                                                | Shipped or downloaded                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (hexgrad)                   | The speech model and its voice style files                                                                                                                                                                                                                                        | Apache 2.0                                                                             | Downloaded from Hugging Face on first use, never in this repo |
| [Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)  | ONNX export of it (8-bit `model_quantized.onnx`, tokenizer)                                                                                                                                                                                                                       | Apache 2.0                                                                             | Downloaded from Hugging Face on first use (pinned revision)   |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.31                   | The WebAssembly inference runtime (`ort-wasm-simd-threaded`)                                                                                                                                                                                                                      | MIT; its own [third-party notices][ort-notices] apply                                  | Bundled                                                       |
| ONNX Runtime Web's JavaScript dependencies                                          | flatbuffers, long / guid-typescript / platform / protobufjs                                                                                                                                                                                                                       | Apache 2.0 / Apache 2.0, ISC, MIT, BSD-3-Clause                                        | Bundled                                                       |
| [@titan-design/speech-g2p](https://github.com/HJewkes/titan-platform)               | A JavaScript port of misaki's US English G2P                                                                                                                                                                                                                                      | MIT                                                                                    | Bundled                                                       |
| [misaki](https://github.com/hexgrad/misaki) 0.9.4 lexicons (`us_gold`, `us_silver`) | Kokoro's own US pronunciation dictionaries                                                                                                                                                                                                                                        | Apache 2.0                                                                             | Bundled (inside speech-g2p, byte for byte)                    |
| [spaCy](https://github.com/explosion/spaCy) 3.8 tokenizer rules                     | Word splitting rules (inside speech-g2p)                                                                                                                                                                                                                                          | MIT                                                                                    | Bundled                                                       |
| [compromise](https://github.com/spencermountain/compromise) 14                      | Part-of-speech tags (read vs. read)                                                                                                                                                                                                                                               | MIT (and its deps efrt, grad-school, suffix-thumb: MIT)                                | Bundled                                                       |
| [phonemize](https://github.com/hans00/phonemize) 2 (`phonemize/en-g2p`)             | Rules for words not in the lexicon                                                                                                                                                                                                                                                | MIT                                                                                    | Bundled                                                       |
| phonemize's English lexicon                                                         | From [ipa-dict](https://github.com/open-dict-data/ipa-dict) `en_US` (from [cmudict-ipa](https://github.com/lingz/cmudict-ipa), from the [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict)), homographs from [g2p_en](https://github.com/Kyubyong/g2p) and misaki | MIT (ipa-dict, cmudict-ipa), BSD-2-Clause style (CMUdict), Apache 2.0 (g2p_en, misaki) | Bundled                                                       |

Notes:

- **Not used:** espeak-ng and the `phonemizer` npm package (which embeds an espeak-ng WebAssembly build, GPL-3.0), and so not
  `kokoro-js`, which depends on it. Shapewall's own wrapper (`client/src/chat/tts/tts.worker.js`) calls ONNX Runtime Web directly
  (transformers.js is not used either).
- ONNX Runtime's third-party notices include Eigen (MPL 2.0, file-level; its source is public at https://gitlab.com/libeigen/eigen)
  and Mbed TLS (used under Apache 2.0). They cover the whole ONNX Runtime project; the WebAssembly build contains a subset.
- `@titan-design/speech-g2p` keeps its `NOTICE` (misaki, spaCy) in `node_modules/@titan-design/speech-g2p/NOTICE`.
- `@titan-design/speech-g2p` is a single-author `0.0.0` package, so it is pinned exactly (`0.0.0`, no range) and locked by
  `package-lock.json`'s integrity hash; it has no install scripts. It is not vendored because its 6 MB of lexicon JSON would then
  live in this repo's history. **Any bump of it (or a change to its lock entry) needs a fresh review** of its code and data before
  it merges, like a new dependency.
- The model, tokenizer and voice files are pinned to Hugging Face's published sizes and SHA-256s at the pinned revision
  (`client/src/chat/tts/voices.js`) and verified in the browser before they are cached or used; a mismatch is deleted.
- [number-to-words](https://github.com/marlun78/number-to-words) (MIT) is a dependency of `phonemize`, but the English rules used
  here (`phonemize/en-g2p`) carry their own number reader and never import it, so it is not in the build.

[ort-notices]: https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt

## Agent product marks (`src/agent/agent-logos.js`)

The board shows the product mark of a coding agent you connected as that agent's default icon (docs/agents.md, "Name and icon"). The
marks are data in one file, each a single-colour SVG path used exactly as sourced: not redrawn, not recoloured, not combined with
anything else. They ship inside the npm package and the built board.

| Mark          | Shown for   | Trademark of                                                                               | Source                                                                                                                                                                                                                                                                   | Terms of the source                                                                                                                                  |
| ------------- | ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude        | Claude Code | Anthropic, PBC                                                                             | [Simple Icons](https://simpleicons.org) 16.37.0 (npm `simple-icons`), `icons/claude.svg`                                                                                                                                                                                 | CC0 1.0 (the Simple Icons project)                                                                                                                   |
| OpenAI        | Codex       | OpenAI                                                                                     | Simple Icons 15.22.0 (npm `simple-icons@15.22.0`, published 2025-11-23), `icons/openai.svg`; taken 2026-11-11                                                                                                                                                            | CC0 1.0 (the Simple Icons project); see the note below                                                                                               |
| goose         | goose       | LF Projects, LLC (the goose project, founded by Block, now with the Agentic AI Foundation) | The project's own repository, <https://github.com/aaif-goose/goose> (where `github.com/block/goose` redirects), `documentation/static/img/goose.svg` at commit `0c5b5e2f2e7933fca4de5377d239645dcbe4cbb3` (file last changed in `bf760fd`, 2025-03-24); taken 2026-11-11 | Apache 2.0 (the repository's licence); the name and logo under the [LF Projects trademark policy](https://lfprojects.org/policies/trademark-policy/) |
| Google Gemini | Gemini CLI  | Google LLC                                                                                 | Simple Icons 16.37.0, `icons/googlegemini.svg`                                                                                                                                                                                                                           | CC0 1.0 (the Simple Icons project)                                                                                                                   |

Notes:

- Simple Icons releases its collection under CC0 1.0 and records no separate licence for these two marks. Its
  [disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md) says a brand may still set its own terms, and
  CC0 waives no trademark rights: the marks remain trademarks of their owners. Shapewall uses them only to identify the agent the
  owner connected, at icon size, with no endorsement or affiliation implied (see `NOTICE`).
- **The OpenAI mark's provenance.** It is the "blossom" monogram (no wordmark), byte for byte the path of `icons/openai.svg` in
  `simple-icons@15.22.0`, the last release that has it. Simple Icons **removed** the icon in 16.0.0 (2025-11-30,
  [pull request 13944](https://github.com/simple-icons/simple-icons/pull/13944), "Remove OpenAI ... assuming no permissions are
  sought/obtained before then", closing [issue 12739](https://github.com/simple-icons/simple-icons/issues/12739), which asked
  whether the icon still matched OpenAI's 2025 rebrand). So the CC0 statement of that release covers the file as Simple Icons
  published it, but Simple Icons itself no longer distributes it, the drawing may predate the 2025 redraw, and OpenAI's own brand
  guidelines (<https://openai.com/brand>) apply to any use of the mark. That page could not be fetched from the build machine when
  this was added (it answered 403 to a plain request), so the guidelines were **not** reviewed against this use. The project owner
  chose to ship the mark for Codex with this provenance; check the guidelines, or ask OpenAI, before relying on it.
- **The goose mark** is the single path of the project's own `goose.svg` (one colour, 45 by 45), unchanged; only the file's empty
  clipping frame is left out. The repository is Apache 2.0, whose section 6 grants no trademark rights; its `GOVERNANCE.md` points
  to the LF Projects policies for the trademark. That policy asks, among other things, that a logo is not altered, not shown "with
  color variations" or with other elements on top of it, and not used to promote a product without written permission. Shapewall
  shows it only as the icon of a goose you connected. Like the other marks it is drawn in the board's text colour (near black on
  light, near white on dark), where the file itself is near black (`#101010`): if that counts as a colour variation, the dark theme
  needs a look.
- Nothing here was drawn to resemble a mark and nothing was copied from an unofficial site.
- Adding or removing a mark is one entry in `src/agent/agent-logos.js` and one row here. The twelve built-in avatars
  (`client/src/chat/agentIcons.jsx`) are original drawings made for Shapewall and are not third-party material.

## Live board presence

Yjs 13.6.33 and y-protocols 1.0.7 provide transient awareness state; lib0 is their shared utility dependency. These are MIT-licensed and
bundled in the board client. The hosted WebSocket transport uses ws 8.22.1 (MIT) on the server. No Yjs document content or hosted
collaboration service is used. Licences ship with the corresponding npm packages.

### Presence dependency notices

The following notices are copied from the installed, pinned npm packages.

#### ws

```text
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### yjs

```text
The MIT License (MIT)

Copyright (c) 2023
  - Kevin Jahns <kevin.jahns@protonmail.com>.
  - Chair of Computer Science 5 (Databases & Information Systems), RWTH Aachen University, Germany

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### y-protocols

```text
The MIT License (MIT)

Copyright (c) 2019 Kevin Jahns <kevin.jahns@protonmail.com>.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### lib0

```text
The MIT License (MIT)

Copyright (c) 2019 Kevin Jahns <kevin.jahns@protonmail.com>.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Local accessibility diagnostics

The CLI directly depends on [axe-core](https://github.com/dequelabs/axe-core) 4.14.0 under MPL-2.0. Its unmodified engine runs only in explicitly requested local original-page accessibility checks. It is not bundled into the wall or public demo. The installed npm package includes its license and source; Shapewall stores only bounded rule identifiers and counts from its results.
