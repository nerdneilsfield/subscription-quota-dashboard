# Third-party notices

[English](THIRD_PARTY_NOTICES.md) | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

This project is distributed under the MIT License in
[`LICENSE`](LICENSE). The notices below apply to third-party source or
reference material used by provider adapters. They do not change the license
of independently written project code.

## cc-switch

Provider quota mappings and parsing behavior in the following files were
adapted from or verified against `cc-switch` provider implementations:

- `src/server/providers/shared.ts`
- `src/server/providers/deepseek.ts`
- `src/server/providers/stepfun.ts`
- `src/server/providers/siliconflow.ts`
- `src/server/providers/openrouter.ts`
- `src/server/providers/novita.ts`
- `src/server/providers/kimi.ts`
- `src/server/providers/zhipu.ts`
- `src/server/providers/minimax.ts`
- `src/server/providers/zenmux.ts`
- `src/server/providers/volcengine.ts`
- `src/server/providers/volcengine-sig.ts`
- `src/server/providers/cliproxy.ts`

Upstream: [farion1231/cc-switch](https://github.com/farion1231/cc-switch)

Copyright (c) 2025 Jason Young

License: MIT

```text
MIT License

Copyright (c) 2025 Jason Young

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

## CPA Manager Plus

The xAI quota response shape and parsing reference in
`src/server/providers/cliproxy.ts` was also checked against the CPAMP project.
This repository does not bundle CPAMP or depend on its runtime.

Upstream: [seakee/CPA-Manager-Plus](https://github.com/seakee/CPA-Manager-Plus)

Copyright (c) 2026 Seakee

License: MIT

```text
MIT License

Copyright (c) 2026 Seakee

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

## Provider services and credentials

MiMo, OpenCode Go, CLIProxyAPI, and upstream services queried through them are
third-party services. Their terms, authentication rules, and endpoint
availability are separate from this repository's software license. Users must
use their own credentials and comply with each provider's terms. This project
does not grant access to any provider account or service.

## Brand assets

Provider names, logos, and marks identify the corresponding services. They are
not licensed under this repository's MIT License. Verify the relevant brand
guidelines or replace the assets before redistributing a branded build.
