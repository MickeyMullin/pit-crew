// public/instance.ts
// which instance served the page: a named one, such as dev, is marked in the title and the header

// pid lets pnpm service:status tell the agent's server from a manual start
export type InstanceInfo = { name: string, configPath: string, pid: number }

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
