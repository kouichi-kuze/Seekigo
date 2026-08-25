/**
 * shell:false で tsx スクリプトを安全に実行する（Windows / macOS 両対応）。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

export function runTsxScript(
  scriptRelative: string,
  envExtra: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(rootDir, scriptRelative)

    const child = spawn(process.execPath, [tsxCli, scriptPath], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        ...envExtra,
      },
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(`${scriptRelative} failed with exit code ${code ?? 'unknown'}`),
      )
    })
  })
}
