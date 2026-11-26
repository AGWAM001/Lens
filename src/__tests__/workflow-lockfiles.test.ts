import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import YAML from 'js-yaml'
import { expect, it } from 'vitest'

type Workflow = {
  jobs?: Record<string, { steps?: { run?: string }[] }>
}

it('requires lockfile installs in GitHub Actions', () => {
  const directory = resolve(__dirname, '../../.github/workflows')
  const files = readdirSync(directory).filter(file => /\.ya?ml$/.test(file))
  const violations: string[] = []
  const bareInstall = /(?:^|[;&|])\s*npm\s+install(?:\s+--?[\w-]+(?:=[^\s;&|]+)?)*\s*(?:$|[;&|#])/

  for (const file of files) {
    const workflow = YAML.load(readFileSync(join(directory, file), 'utf8')) as Workflow
    for (const [job, config] of Object.entries(workflow.jobs ?? {})) {
      for (const step of config.steps ?? []) {
        if (step.run?.split(/\r?\n/).some(line => bareInstall.test(line))) {
          violations.push(`${file} (${job})`)
        }
      }
    }
  }

  expect(violations, 'Use npm ci to install dependencies from the lockfile').toEqual([])
})
