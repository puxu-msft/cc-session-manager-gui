import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { openDb, type Db } from './db/db'
import { PROJECTS_ROOT, CLAUDE_JSON, TRASH_ROOT } from '@shared/constants'

let db: Db
export function getEnv() {
  if (!db) {
    const dir = app.getPath('userData'); mkdirSync(dir, { recursive: true })
    db = openDb(join(dir, 'index.db'))
  }
  return { db, projectsRoot: PROJECTS_ROOT(), claudeJsonPath: CLAUDE_JSON(), trashRoot: TRASH_ROOT() }
}
