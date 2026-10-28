// public/safeurl.ts
// a link the page builds from a string the server passed on (a posted review's URL, a CI job, a
// ticket, a PR) becomes an anchor only when it is an absolute http or https URL; anything else,
// such as a javascript: or data: URL, a scheme split by whitespace or an entity, or a relative
// form, is shown as plain text. The URL is rewritten to its parsed form, so what the browser
// follows is what was checked

export const safeHref = (value: unknown): string | null => {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || /[\u0000- \u007f-\u009f]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

// an image source: the same, or this server's own avatar endpoint
export const safeImage = (value: unknown): string | null => {
  if (typeof value === 'string' && /^\/api\/avatar\/[^\s?#]+$/.test(value)) return value
  return safeHref(value)
}
