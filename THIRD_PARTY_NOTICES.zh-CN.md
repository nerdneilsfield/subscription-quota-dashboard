# 第三方声明

[English](THIRD_PARTY_NOTICES.md) | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

本项目依据 [`LICENSE`](LICENSE) 采用 MIT License 发布。以下声明适用于
provider adapter 使用的第三方源码或参考资料；不改变项目独立编写代码的许可证。

## cc-switch

下列文件中的 provider quota 映射与解析行为，参考或改写自 `cc-switch`
的 provider 实现：

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

上游项目：[farion1231/cc-switch](https://github.com/farion1231/cc-switch)

Copyright (c) 2025 Jason Young

许可证：MIT

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

`src/server/providers/cliproxy.ts` 中的 xAI quota 响应结构与解析参考，另经
CPAMP 项目核对。本仓库不包含 CPAMP，也不依赖其 runtime。

上游项目：[seakee/CPA-Manager-Plus](https://github.com/seakee/CPA-Manager-Plus)

Copyright (c) 2026 Seakee

许可证：MIT

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

## Provider 服务与凭证

MiMo、OpenCode Go、CLIProxyAPI 及其访问的上游服务，均是第三方服务。
它们的 Terms、认证规则与 endpoint 可用性独立于本仓库许可证。用户必须使用
自己的凭证并遵守各 provider 的规则。本项目不授予任何 provider 账号或服务访问权。

## 品牌资源

Provider 名称、logo 与商标仅用于识别对应服务，不包含在本仓库 MIT License
授权范围内。重新分发带品牌的构建产物前，请核对对应品牌规范，或替换为中性资源。
