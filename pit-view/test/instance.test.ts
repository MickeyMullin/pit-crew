// test/instance.test.ts
// the instance override: folders, ports and refusals, and how a named instance marks its pages
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cacheFile, configFile, stateDir, tildePath } from '../src/config.ts'
import { resolveRuntime } from '../src/server.ts'
import { instanceTitle } from '../public/instance.ts'

const home = '/home/tester'

test('the default instance is the app: port 4791 and the pit-view folders', () => {
  assert.deepEqual(resolveRuntime({}, home), {
    instance: '',
    port: 4791,
    configPath: '/home/tester/.config/pit-view/config.json',
    cachePath: '/home/tester/.local/state/pit-view/cache.sqlite',
    stateDir: '/home/tester/.local/state/pit-view',
  })
  assert.equal(resolveRuntime({ PIT_VIEW_INSTANCE: '', PIT_VIEW_PORT: '' }, home).port, 4791)
})

test('PIT_VIEW_INSTANCE=dev moves the port to 4792 and every folder to pit-view-dev', () => {
  assert.deepEqual(resolveRuntime({ PIT_VIEW_INSTANCE: 'dev' }, home), {
    instance: 'dev',
    port: 4792,
    configPath: '/home/tester/.config/pit-view-dev/config.json',
    cachePath: '/home/tester/.local/state/pit-view-dev/cache.sqlite',
    stateDir: '/home/tester/.local/state/pit-view-dev',
  })
  assert.equal(configFile(home, 'dev'), '/home/tester/.config/pit-view-dev/config.json')
  assert.equal(cacheFile(home, 'dev'), '/home/tester/.local/state/pit-view-dev/cache.sqlite')
  assert.equal(stateDir(home, 'dev'), '/home/tester/.local/state/pit-view-dev')
})

test('PIT_VIEW_PORT overrides the port of either instance', () => {
  assert.equal(resolveRuntime({ PIT_VIEW_PORT: '5000' }, home).port, 5000)
  assert.equal(resolveRuntime({ PIT_VIEW_INSTANCE: 'dev', PIT_VIEW_PORT: '5001' }, home).port, 5001)
  assert.throws(() => resolveRuntime({ PIT_VIEW_PORT: 'abc' }, home), /PIT_VIEW_PORT must be a port number/)
  assert.throws(() => resolveRuntime({ PIT_VIEW_PORT: '70000' }, home), /PIT_VIEW_PORT must be a port number/)
})

test('another instance name needs its own port, and a name that is not a plain word is refused', () => {
  assert.throws(() => resolveRuntime({ PIT_VIEW_INSTANCE: 'demo' }, home), /no default port; set PIT_VIEW_PORT/)
  assert.equal(resolveRuntime({ PIT_VIEW_INSTANCE: 'demo', PIT_VIEW_PORT: '4793' }, home).configPath, '/home/tester/.config/pit-view-demo/config.json')
  assert.throws(() => resolveRuntime({ PIT_VIEW_INSTANCE: 'constructor' }, home), /no default port/)
  for (const name of ['Dev', '../x', 'a/b', '-dev', 'dev ', '1dev']) {
    assert.throws(() => resolveRuntime({ PIT_VIEW_INSTANCE: name, PIT_VIEW_PORT: '4793' }, home), /PIT_VIEW_INSTANCE must be/, name)
  }
})

test('paths under home are shown with ~', () => {
  assert.equal(tildePath('/home/tester/.config/pit-view-dev/config.json', home), '~/.config/pit-view-dev/config.json')
  assert.equal(tildePath(home, home), '~')
  assert.equal(tildePath('/home/tester2/x', home), '/home/tester2/x')
  assert.equal(tildePath('/srv/x', home), '/srv/x')
})

test('a named instance leads the page title with its name; the app keeps its title', () => {
  assert.equal(instanceTitle('Pit View', ''), 'Pit View')
  assert.equal(instanceTitle('Pit View', 'dev'), 'dev · Pit View')
  assert.equal(instanceTitle('Settings · Pit View', 'dev'), 'dev · Settings · Pit View')
})
