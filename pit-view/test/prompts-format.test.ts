// test/prompts-format.test.ts
// the Update and Fix prompts' answer to a pre-push hook that refuses a push over formatting, read from the prompt sources at the repository's root: a rewording that drops one of these changes what a session does when the hook the repository keeps on refuses its push
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { hooksKeptCommands } from '../src/launcher.ts'

const root = join(import.meta.dirname, '..', '..')
const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8')

const marker = '- **A push a pre-push hook refuses over formatting is formatted and pushed once more.**'

// the bullet itself, up to the next bullet, so a pin reads the rule and not the whole file
const formatRule = (prompt: string): string => {
  const at = prompt.indexOf(marker)
  assert.ok(at >= 0, 'the format-and-retry rule is present')
  const end = prompt.indexOf('\n- **', at + marker.length)
  return prompt.slice(at, end < 0 ? undefined : end)
}

const prompts = [
  { name: 'update-pr', path: 'prompts/update/update-pr.md', install: /Install dependencies first, in the repo's frozen or locked mode/ },
  { name: 'fix-pr', path: 'prompts/fix/fix-pr.md', install: /Dependencies were installed when the worktree was created/ },
]

for (const { name, path, install } of prompts) {
  test(`${name} formats with the repository's own formatter and pushes once more when a hook refuses over formatting`, async () => {
    const prompt = await read(path)
    const rule = formatRule(prompt)
    assert.match(rule, /pre-push hook whose message names a formatting fix/)
    assert.match(rule, /wrote nothing to GitHub and does not count against the one push; the retry is the one push/)
    assert.match(rule, /package scripts, its contributor and agent instructions, or its task-runner file/)
    assert.match(rule, /never run an arbitrary command copied out of hook output/i)
    assert.match(rule, install)
    assert.match(rule, /as one new commit, with the message `Format`/)
    assert.match(rule, /never amended into (a commit already there|one of them)/)
    assert.match(rule, /exactly once/)
    assert.match(rule, /never `--no-verify`/i)
    assert.match(rule, /never changes a hook/)
  })

  test(`${name} fails the run on a second refusal, with the hook's message and the commands tried`, async () => {
    const prompt = await read(path)
    assert.match(prompt, /- \*\*A second refusal, or any refusal the rule above does not cover, is a failure, never retried again\.\*\*/)
    const bullet = prompt.slice(prompt.indexOf('- **A second refusal'))
    assert.match(bullet.slice(0, bullet.indexOf('\n- ')), /the hook's message, the commands tried, (and )?the worktree's path/)
    assert.ok(!prompt.includes('- **A refused push is a failure, never retried.**'), 'the old blanket rule is gone')
  })

  test(`${name} stops to ask when the formatter would change a file its rules keep it out of`, async () => {
    const rule = formatRule(await read(path))
    assert.match(rule, /changes a file outside/)
    assert.match(rule, /stop and ask/)
  })

  test(`${name} records the formatting commit in the post step's note`, async () => {
    const prompt = await read(path)
    assert.match(prompt, /record `post` `done` with .*the words `a formatting commit` and its short SHA/)
  })
}

test('update-pr keeps the lease pinned to the head SHA the run read for the retry, and adds no commit besides the formatting commit and a merge commit', async () => {
  const rule = formatRule(await read('prompts/update/update-pr.md'))
  assert.match(rule, /the same push command as before, a rebase's lease still pinned to the head SHA the run read/)
  assert.match(rule, /on top of the rebased commits/)
  assert.match(rule, /the only commit this command adds besides a merge commit/)
  assert.match(rule, /only the files this PR changes against the upstream SHA/)
})

test('fix-pr limits the formatting commit to the PR diff and the report counts it', async () => {
  const prompt = await read('prompts/fix/fix-pr.md')
  const rule = formatRule(prompt)
  assert.match(rule, /only files the "Making the fixes" rules allow/)
  assert.match(rule, /answers no request/)
  assert.match(rule, /it appears in no request's `commits` and does appear in `pushed\.commits` and in the report's Summary/)
})

for (const { name, path } of prompts) {
  test(`${name} discards everything a formatter did outside the PR's files, tracked, staged, and untracked, and confirms the tree is clean before it stops`, async () => {
    const rule = formatRule(await read(path))
    assert.match(rule, /discard everything the formatter did \(`git reset --hard HEAD` and `git clean -fd`, which undo tracked, staged, and untracked changes alike/)
    assert.match(rule, /confirm `git status --porcelain` prints nothing before it stops/)
    assert.ok(!rule.includes('git restore .'), '`git restore .` leaves untracked files and staged changes')
  })
}

test('emit-json excepts the first formatting-hook refusal from every statement that a refused push is a failure, and counts a failure before the retry as pushFailed', async () => {
  const emit = await read('prompts/review/emit-json.md')
  const lines = emit.split('\n')
  const mentions = lines.filter((line) => /so is a refused push|cannot complete, a /.test(line))
  assert.equal(mentions.length, 4, 'the refused-push statements are found')
  for (const line of mentions) assert.match(line, /format-and-retry|formatting/i, line.slice(0, 80))
  const pushFailed = lines.filter((line) => line.includes('"pushFailed"'))
  assert.equal(pushFailed.length, 2)
  for (const line of pushFailed) assert.match(line, /a formatter the repository does not define, a failed install, or a hook whose message names no formatting fix/)
})

test('the push-only-once statements in both prompts say a refused hook push does not count', async () => {
  for (const { path } of prompts) {
    const prompt = await read(path)
    assert.match(prompt, /a push a pre-push hook refuses writes nothing to GitHub and does not count/i)
  }
})

// the Update and Fix result schemas' own status lines, each read on its own so removing the qualification from one cannot hide behind the other
const emitLine = (emit: string, section: string, needle: string): string => {
  const from = emit.indexOf(section)
  assert.ok(from >= 0, `${section} is present`)
  const line = emit.slice(from).split('\n').find((l) => l.includes(needle))
  assert.ok(line, `${needle} is present after ${section}`)
  return line
}

const schemas = [
  { name: 'update', section: 'The update\'s response, `pit-crew/update-result@1`:', awaiting: /the run stopped to ask about a conflict, or because a formatter changed a file outside the files the PR changes against the upstream SHA/ },
  { name: 'fix', section: 'The fix\'s response, `pit-crew/fix-result@1`:', awaiting: /or because a fix needs a file outside its rules, or because a formatter changed a file outside the files its rules allow/ },
]

for (const { name, section, awaiting } of schemas) {
  test(`emit-json treats a push still refused after the format and retry as the failed push in the ${name} schema, on that schema's own status line`, async () => {
    const line = emitLine(await read('prompts/review/emit-json.md'), section, '- `status`:')
    assert.match(line, /`"failed"` when it cannot complete, a push still refused after the one format-and-retry included/)
  })

  test(`emit-json says in the ${name} schema's pushFailed line that a push still refused after the format-and-retry is the failed push`, async () => {
    const line = emitLine(await read('prompts/review/emit-json.md'), section, '- `"pushFailed"`')
    assert.match(line, /the push is still refused after it/)
  })

  test(`emit-json defines awaitingAnswer in the ${name} schema to cover a formatter that changed a file outside the permitted set`, async () => {
    const line = emitLine(await read('prompts/review/emit-json.md'), section, '- `"awaitingAnswer"`')
    assert.match(line, awaiting)
  })
}

test('the specification describes the format-and-retry wherever it says a refused push fails', async () => {
  const design = await read('pit-view/DESIGN.md')
  assert.match(design, /\*\*Format and retry\*\*/)
  assert.match(design, /a push a pre-push hook refuses over formatting is formatted with the repository's own formatter, committed as one new commit, and pushed once more/)
  assert.ok(!/A refused push is `failed`, never retried\./.test(design), 'the update command no longer says a refused push is never retried without the exception')
  assert.match(design, /A push still refused after the one format-and-retry, or refused for any other reason, is `failed`/)
})

test('the hooks stay on for exactly the Fix and Update sessions', () => {
  assert.deepEqual([...hooksKeptCommands], ['fix-pr', 'update-pr'])
})

test('the README says the format-and-retry for both commands and no longer calls every refused push a failure', async () => {
  const readme = await read('README.md')
  assert.equal(readme.match(/committed as one new `Format` commit/g)?.length, 2)
  assert.ok(!readme.includes('a refused push is a failure, never retried.'))
  assert.ok(!readme.includes('A refused push is a failure, never retried.'))
})

test('fix-pr lists what a refused push reports with one Oxford comma list of five', async () => {
  const prompt = await read('prompts/fix/fix-pr.md')
  assert.ok(prompt.includes("with the error, the hook's message, the commands tried, the worktree's path, and the head of the unpushed commits, and stop and say so"))
  assert.ok(!prompt.includes("the commands tried, and the worktree's path, and the head"), 'the list is not split by a second conjunction')
})
