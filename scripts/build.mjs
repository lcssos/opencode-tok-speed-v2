#!/usr/bin/env node
/**
 * 把 tui.tsx 预编译成 tui.js。
 *
 * 为什么必须预编译：OpenCode 的 solid JSX 转译插件只处理 node_modules 之外的文件
 * （`bun-plugin-solid` 的 onLoad filter 显式排除了 node_modules）。插件从 npm 装进来
 * 时入口位于 node_modules 内，`tui.tsx` 里的 JSX 不会被转译，运行时去解析
 * `@opentui/solid/jsx-dev-runtime` 直接失败：
 *
 *   Cannot find package '@opentui/solid' imported from
 *   .../node_modules/opencode-tok-speed-v2/tui.tsx
 *
 * 所以发布包里必须提供已经转译好的 .js，`package.json` 的 `exports["./tui"]`
 * 也指向 .js。编译参数与 OpenCode 宿主自身保持一致（`generate: "universal"`），
 * 这样产出的 `createElement` / `createComponent` 调用与宿主运行时是同一套。
 */
import { readFile, writeFile } from "node:fs/promises"
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"

const SOURCE = "tui.tsx"
const OUTPUT = "tui.js"

const source = await readFile(SOURCE, "utf8")
const result = await transformAsync(source, {
  filename: SOURCE,
  configFile: false,
  babelrc: false,
  // 参数对齐 OpenCode 宿主：moduleName 唯一，generate 用 universal。
  presets: [
    [solid, { moduleName: "@opentui/solid", generate: "universal" }],
    [typescript, {}],
  ],
})

if (!result?.code) {
  throw new Error(`编译 ${SOURCE} 失败：没有产出代码`)
}

if (/\bjsxDEV?\s*\(/.test(result.code)) {
  throw new Error(`${OUTPUT} 里仍残留未转译的 JSX，运行时会在 node_modules 内解析失败`)
}

await writeFile(OUTPUT, result.code, "utf8")
console.log(`${SOURCE} → ${OUTPUT}（${Buffer.byteLength(result.code)} 字节）`)
