// public/openrouterkey.ts
// the Settings card for Pit View's OpenRouter key (section 8 of DESIGN.md, The OpenRouter key): three read-only status lines, whether the key file and the Hermes profile's .env each hold a key and whether the two agree. The page never sends, shows, or stores a key, and has nothing to edit it with
export type Presence = 'set' | 'missing' | 'problem'

export type KeyView = {
  keyFile: Presence
  profileEnv: Presence
  sync: 'in sync' | 'differs' | 'unknown'
  prefixes: { keyFile: string, profileEnv: string } | null
  problems: { keyFile: string | null, profileEnv: string | null }
}

export type KeyLine = { id: 'keyFile' | 'profileEnv' | 'sync', text: string, tone: 'normal' | 'ok' | 'error' }

export const keyRoute = '/api/openrouter-key'

const side = (label: string, state: Presence, problem: string | null): KeyLine['text'] =>
  state === 'set' ? `${label}: set.` : state === 'missing' ? `${label}: not set.` : `${label}: not usable${problem === null ? '' : `, ${problem}`}`

// what the card says: only the fields the server answers with are read, and a prefix is shown only when the two differ
export const keyLines = (view: KeyView | null): KeyLine[] => {
  if (view === null) return [{ id: 'sync', text: 'Could not read the state of the OpenRouter key.', tone: 'error' }]
  const prefixes = view.sync === 'differs' && view.prefixes !== null ? view.prefixes : null
  const sync: KeyLine = view.sync === 'in sync'
    ? { id: 'sync', text: 'The two keys are in sync.', tone: 'ok' }
    : view.sync === 'differs'
      ? { id: 'sync', text: `The two keys differ${prefixes === null ? '' : `: key file ${prefixes.keyFile}, profile .env ${prefixes.profileEnv}`}.`, tone: 'error' }
      : { id: 'sync', text: 'The two keys cannot be compared until both are set.', tone: 'normal' }
  return [
    { id: 'keyFile', text: side('Key file', view.keyFile, view.problems.keyFile), tone: view.keyFile === 'set' ? 'ok' : view.keyFile === 'problem' ? 'error' : 'normal' },
    { id: 'profileEnv', text: side('Profile .env', view.profileEnv, view.problems.profileEnv), tone: view.profileEnv === 'set' ? 'ok' : view.profileEnv === 'problem' ? 'error' : 'normal' },
    sync,
  ]
}
