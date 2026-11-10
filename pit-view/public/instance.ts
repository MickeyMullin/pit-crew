// public/instance.ts
// which instance served the page: a named one, such as dev, is marked in the title and the header

// pid lets pnpm service:status tell the agent's server from a manual start
export type InstanceInfo = { name: string, configPath: string, pid: number, loginAgent?: { installed: boolean } }

// the Settings page's line for the optional login agent: whether its plist is installed, with no claim that anything depends on it
export const loginAgentText = (agent: InstanceInfo['loginAgent']): string =>
  agent === undefined ? 'Unknown' : agent.installed ? 'Installed' : 'Not installed'

// the default instance keeps the title as it is; a named one leads with its name
export const instanceTitle = (title: string, name: string): string => name === '' ? title : `${name} · ${title}`

export const loadInstance = async (): Promise<InstanceInfo | null> => {
  try {
    const response = await fetch('/api/instance', { cache: 'no-store' })
    if (!response.ok) return null
    return await response.json() as InstanceInfo
  } catch {
    return null
  }
}

// once per page load: the title and the header badge, which stays hidden for the default instance
export const showInstance = (info: InstanceInfo): void => {
  document.title = instanceTitle(document.title, info.name)
  const badge = document.getElementById('instance')
  if (badge === null) return
  badge.textContent = info.name
  badge.hidden = info.name === ''
}

// the login a page served through the proxy was signed in as, from <meta name="pit-view-signed-in">; null on loopback, which needs no sign-in
export const signedInAs = (doc: Document): string | null =>
  doc.querySelector('meta[name="pit-view-signed-in"]')?.getAttribute('content') ?? null

// the header's Sign out, shown only on a signed-in page
export const showSignOut = (doc: Document): void => {
  const login = signedInAs(doc)
  const form = doc.getElementById('sign-out')
  if (form === null || login === null) return
  form.title = `Sign out ${login}`
  form.hidden = false
}
