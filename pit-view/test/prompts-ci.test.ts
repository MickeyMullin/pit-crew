// test/prompts-ci.test.ts
// the review prompts' rules for CI and the head before a post, read from the prompt sources at the repository's root: a run never posts a comment in place of a verdict CI has not settled, reads only the reviewed head's newest run of each workflow, and re-reads the head before any post. A rewording that drops one of these changes what an unattended review posts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { doneText, parseResult } from '../src/launcher.ts'

const root = join(import.meta.dirname, '..', '..')
const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8')

const waitRule = '- **CI that has not finished never selects a comment: wait, or post nothing.**'
const newestRule = '- **Only the reviewed head\'s newest run of each workflow counts.**'
const headRule = '- **Re-read the head before any post.**'
const ciNote = 'CI had not finished: nothing is posted'
const headNote = 'the head moved since the review: nothing is posted'

// the bullet that starts with this marker, up to the next bullet at its level, so a pin reads the rule and not the whole file
const bullet = (prompt: string, marker: string): string => {
  const at = prompt.indexOf(marker)
  assert.ok(at >= 0, `${marker} is present`)
  assert.equal(prompt.indexOf(marker, at + 1), -1, `${marker} appears once`)
  const end = prompt.indexOf('\n- ', at + marker.length)
  return prompt.slice(at, end < 0 ? undefined : end)
}

const choosers = [
  { name: 'review-pr', path: 'prompts/review/review-pr.md' },
  { name: 'review-stack', path: 'prompts/review/review-stack.md' },
  { name: 'review-dependabot', path: 'prompts/review/review-dependabot.md' },
]

for (const { name, path } of choosers) {
  test(`${name} never posts a comment because CI has not finished: it waits, and posts nothing when the wait cannot conclude`, async () => {
    const rule = bullet(await read(path), waitRule)
    assert.match(rule, /never as a stand-in for a verdict CI has not settled/)
    assert.match(rule, /`gh pr checks <[a-z-]+> --watch/)
    assert.match(rule, /posts nothing in any form/)
  })

  test(`${name} reads CI for the reviewed head only, and only the newest run of each workflow`, async () => {
    const rule = bullet(await read(path), newestRule)
    assert.match(rule, /only its newest run/)
    assert.match(rule, /gh run list --commit <full-sha>/)
    assert.match(rule, /is not "CI failed"/)
    assert.match(rule, /a check canceled because a newer run replaced it/)
    assert.match(rule, /a gate job that failed only because the jobs it requires were canceled that way/)
    assert.match(rule, /not finished for this head/)
    assert.match(rule, /Only a failure in the newest run on the reviewed head is CI failed\./)
  })

  test(`${name} re-reads the head before any post, and posts nothing in any form when it moved`, async () => {
    const rule = bullet(await read(path), headRule)
    assert.match(rule, /`gh pr view <[a-z-]+> --json headRefOid --jq \.headRefOid`/)
    assert.match(rule, /full SHA of the (commit|tip) this run reviewed/)
    assert.match(rule, /post nothing, in any form: an approval, a request for changes, and a comment alike/)
  })

  test(`${name} names both skip notes, and says nothing was posted and why`, async () => {
    const prompt = await read(path)
    assert.ok(prompt.includes(`\`${ciNote}\``), 'the CI note')
    assert.ok(prompt.includes(`\`${headNote}\``), 'the head note')
    assert.match(prompt, /nothing was posted and why/)
  })

  test(`${name} writes notPostedReason ciPending or headMoved, never null, when nothing is posted because CI had not finished or the head moved`, async () => {
    const prompt = await read(path)
    const nothing = bullet(prompt, '- **When nothing is posted because CI had not finished or the head moved**')
    assert.ok(nothing.includes('`"notPostedReason": "ciPending"`'), 'the CI reason')
    assert.ok(nothing.includes('`"notPostedReason": "headMoved"`'), 'the head reason')
    assert.ok(!nothing.includes('"notPostedReason": null'), 'no null for either')
  })

  test(`${name} still requests changes on P0, P1, or P2 without waiting for CI`, async () => {
    const prompt = await read(path)
    assert.match(prompt, /\*\*Any P0, P1, or P2 finding: request changes\.?\*\*[^\n]*This form never waits for CI\./)
  })
}

test('no prompt keeps the step that fell through to a plain comment when the wait for CI could not finish', async () => {
  for (const path of [...choosers.map((entry) => entry.path), 'prompts/review/review-dependabot-sweep.md', 'prompts/review/emit-json.md', 'prompts/review/no-post.md']) {
    const prompt = await read(path)
    assert.doesNotMatch(prompt, /fall(s|ing)? through to the plain-comment form/i, path)
    assert.doesNotMatch(prompt, /straight to the plain-comment form/, path)
    assert.doesNotMatch(prompt, /stop waiting, fall through/, path)
  }
  const dependabot = await read('prompts/review/review-dependabot.md')
  assert.ok(!dependabot.includes('anything else means a plain comment'), 'review-dependabot no longer comments on anything but green')
  assert.ok(!dependabot.includes('post a plain comment and say in the closing notes that CI was unresolved'), 'review-dependabot no longer comments when the wait errors out')
  const stack = await read('prompts/review/review-stack.md')
  assert.ok(!stack.includes('but CI not green: plain comment'), 'review-stack no longer comments while CI is pending')
  assert.ok(!stack.includes('and fall through to the plain-comment form instead'), 'review-stack no longer sends a pending check to a comment')
})

test('a real failure on the reviewed head\'s newest run still posts the plain comment, and is still the only case that does', async () => {
  for (const path of ['prompts/review/review-pr.md', 'prompts/review/review-stack.md']) {
    const prompt = await read(path)
    const line = prompt.split('\n').find((entry) => entry.includes('This is the only case that posts a plain comment.'))
    assert.ok(line, `${path}: the comment form is present`)
    assert.match(line, /but CI failed on the reviewed head's newest run: plain comment\.\*\*/)
  }
  const dependabot = await read('prompts/review/review-dependabot.md')
  assert.match(dependabot, /green means approve, and a failure in the newest run means a plain comment/)
  assert.match(dependabot, /CI that has not finished is never that failed condition/)
})

test('review-pr waits for CI and, when the wait cannot conclude, posts nothing and says why', async () => {
  const prompt = await read('prompts/review/review-pr.md')
  const wait = bullet(prompt, '- **Waiting for CI to finish:**')
  assert.match(wait, /stop waiting and post nothing: CI had not finished/)
  assert.ok(!wait.includes('plain-comment form'), 'the wait never ends in a comment')
  const nothing = bullet(prompt, '- **When nothing is posted because CI had not finished or the head moved**')
  assert.match(nothing, /`"posted": null`, with `"notPostedReason": "ciPending"` when CI had not finished and `"notPostedReason": "headMoved"` when the head moved/)
  assert.match(nothing, /add a line to its closing notes/)
})

test('review-pr keeps the decline path, the owner\'s own action in an interactive session, as it was', async () => {
  const prompt = await read('prompts/review/review-pr.md')
  assert.ok(prompt.includes('- If the user declines to continue, post the current report on the PR so the outstanding findings are recorded, and say that you did. Post it as a plain `gh pr comment` whatever its findings\' priorities — this is your own PR, so the request-changes and approve forms under "Posting the report" do not apply to it.'))
})

test('review-stack waits before it names a form, makes no offer when CI has not finished, and re-reads the head after the yes', async () => {
  const prompt = await read('prompts/review/review-stack.md')
  assert.match(bullet(prompt, waitRule), /makes no offer/)
  assert.match(bullet(prompt, headRule), /after the user's explicit yes/i)
  assert.match(prompt, /a check not finished waits, as above, and only a failed check in the newest run selects the plain-comment form/)
})

test('review-dependabot chooses the form before the report, and its Posted as line says when nothing was posted', async () => {
  const prompt = await read('prompts/review/review-dependabot.md')
  assert.match(prompt, /- Posted as: approval, comment, or request changes, and why, or `not posted` and why/)
  assert.match(bullet(prompt, headRule), /rewrite the report's `Posted as:` line/)
  assert.match(prompt, /If `--watch` itself errors out rather than completing, or the wait ends any other way without CI concluding, post nothing: CI had not finished\./)
})

test('the sweep states the three rules for each reviewer\'s post and reviews a clean bump left unposted fresh', async () => {
  const prompt = await read('prompts/review/review-dependabot-sweep.md')
  const rule = bullet(prompt, '- **Each reviewer\'s post follows `review-dependabot.md`\'s CI and head rules.**')
  assert.match(rule, /only the newest run of each workflow counts/)
  assert.match(rule, /posts nothing when the wait cannot conclude, never a comment in its place/)
  assert.match(rule, /re-reads the PR's head before any post/)
  assert.ok(rule.includes('`Posted: not posted: CI had not finished`'))
  assert.ok(rule.includes('`Posted: not posted: the head moved since the review`'))
  assert.match(prompt, /because it was not posted when CI had not finished/)
  // the sweep's own reason is about the sweep: a row left unposted for either reason says so in its notes, and the reasons stay a single review's
  const reason = bullet(prompt, '- `notPostedReason`: `"noPost"` when the invocation carried `--no-post`, otherwise `null`.')
  assert.match(reason, /`ciPending` and `headMoved` are a single review's reasons in `review-result@1`, which a sweep's result never carries/)
  assert.ok(rule.includes('its row\'s `notes` say `not posted: CI had not finished` or `not posted: the head moved since the review`'), 'the row\'s notes')
  assert.match(prompt, /the set failing now in the head's newest run of each workflow/)
})

test('emit-json lists the two new skip notes beside the others, and notPostedReason gains ciPending and headMoved', async () => {
  const emit = await read('prompts/review/emit-json.md')
  const notes = emit.split('\n').find((line) => line.startsWith('- Each step records `started` and then `done`'))
  assert.ok(notes, 'the skip-note line is present')
  assert.ok(notes.includes(`\`run with --no-post\`, \`${ciNote}\`, or \`${headNote}\``), 'the new notes follow the existing ones')
  const nullLine = emit.split('\n').find((line) => line.startsWith('  - It is null as well when nothing was posted'))
  assert.ok(nullLine, 'the null line is present')
  assert.match(nullLine, /the run failed before the post, no PR exists to post to, or the user declined the offer to post\./)
  assert.doesNotMatch(nullLine, /CI had not finished|the head moved/)
  const section = emit.slice(emit.indexOf('- `notPostedReason`: null when the post landed.'), emit.indexOf('- `report`: the report file\'s path'))
  assert.deepEqual([...section.matchAll(/^ {2}- `"([a-zA-Z]+)"`/gm)].map((match) => match[1]), ['noPost', 'ownPr', 'awaitingAnswer', 'ghFailed', 'postBlocked', 'ciPending', 'headMoved'])
  assert.match(section, /- `"ciPending"`: CI had not finished: /)
  assert.match(section, /- `"headMoved"`: the PR's head, re-read immediately before the post, /)
  assert.doesNotMatch(emit, /on `done` for [^.]*a CI wait that gave up/, 'a CI wait that gave up is a skip, not a done post')
  const stack = emit.split('\n').find((line) => line.startsWith('- **`review-stack`\'s offer to post**'))
  assert.ok(stack?.includes(`\`${ciNote}\``), 'the stack offer names the CI note')
  assert.ok(stack?.includes(`\`${headNote}\``), 'the stack offer names the head note')
  assert.ok(stack?.includes('with `notPostedReason` `"headMoved"`'), 'the stack offer writes headMoved')
  assert.ok(stack?.includes('`notPostedReason` `"ciPending"`'), 'the stack offer writes ciPending')
  assert.ok(!stack?.includes('`notPostedReason` null'), 'the stack offer writes null for neither')
  const skipped = emit.split('\n').find((line) => line.startsWith('- Each step records `started` and then `done`'))
  assert.match(skipped ?? '', /A run skipped for either still ends `"done"`, with its report written and `notPostedReason` `"ciPending"` or `"headMoved"`\./)
})

test('no-post is unchanged: with --no-post nothing posts and nothing waits', async () => {
  const prompt = await read('prompts/review/no-post.md')
  assert.match(prompt, /- \*\*No CI wait\.\*\* The wait that exists only to choose the post's form \(`gh pr checks <number> --watch`\) does not run, since there is no post\./)
})

test('a run that posted nothing because CI had not finished or the head moved reads as not posted in Pit View, and one written before the reasons existed reads as before', () => {
  const result = {
    schema: 'pit-crew/review-result@1', command: 'review-pr', status: 'done', target: { repo: 'octo-example/orbit', pr: 4123 },
    reviewed: { kind: 'commit', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }, verdict: 'clean', recommendation: null, findings: [],
    ci: 'pending', fixAttempts: 0, posted: null, notPostedReason: 'ciPending', report: '~/agents/output/PR-4123.md', question: null, error: null,
  }
  const text = (patch: Record<string, unknown>): string => {
    const parsed = parseResult(JSON.stringify({ ...result, ...patch }))
    assert.equal(parsed.ok, true)
    return parsed.ok ? doneText({ status: 'done', note: null, result: parsed.value, origin: 'auto' }, false) : ''
  }
  assert.equal(text({}), 'Clean · not posted')
  const changes = { verdict: 'changesRequested', ci: 'green', findings: [{ priority: 'P2', summary: 'Retry never backs off', files: ['src/retry.ts'] }] }
  assert.equal(text({ ...changes, notPostedReason: 'headMoved' }), 'Changes requested · not posted')
  // a result an earlier prompt wrote, with null for either case, reads as its verdict alone, as it did
  assert.equal(text({ notPostedReason: null }), 'Clean')
  assert.equal(text({ ...changes, notPostedReason: null }), 'Changes requested')
})

test('the specification states the rules the prompts do', async () => {
  const design = await read('pit-view/DESIGN.md')
  const lines = design.split('\n')
  const reason = lines.find((line) => line.startsWith('| `notPostedReason` | null when posted;'))
  assert.match(reason ?? '', /`ciPending` \(CI had not finished/)
  assert.match(reason ?? '', /`headMoved` \(the PR's head, re-read before the post/)
  assert.match(reason ?? '', /also null when nothing was posted for another reason \(the run failed first, no PR exists, or the owner declined the offer\)/)
  const ci = lines.find((line) => line.startsWith('| `ci` |'))
  assert.match(ci ?? '', /newest run of each workflow/)
  assert.match(design, /in the form the findings and CI select, and none while CI has not finished or once the head has moved off the commit reviewed/)
  assert.doesNotMatch(design, /reads as its verdict alone/)
  assert.match(design, /" · not posted" for `ciPending` or `headMoved`, whatever started the run/)
  assert.doesNotMatch(design, /a manual run, a run allowed to post, a stack review/)
  assert.match(design, /a run allowed to post, unless it reads `ciPending` or `headMoved`/)
})

test('the README no longer says a stack comments while CI is pending', async () => {
  const readme = await read('README.md')
  assert.ok(!readme.includes('(a plain comment when CI is not green)'))
  assert.match(readme, /nothing while CI has not finished or once the head has moved/)
})
