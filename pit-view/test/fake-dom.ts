// test/fake-dom.ts
// a small stand-in for the browser's document, enough for the real public/drawer.ts and public/settings.ts to run under Node: elements with attributes, children, text, form values, events, focus, and the few selectors those files use. It is strict on purpose: a selector or call it does not know throws, so a test cannot pass by the fake quietly ignoring something the page does

type Listener = (event: FakeEvent) => void
export type FakeEvent = { type: string, target: FakeElement, preventDefault: () => void }
export type FakeText = { textNode: true, data: string, textContent: string, parentNode: FakeElement | null }
type Child = FakeElement | FakeText
type Compound = { tag: string | null, id: string | null, classes: string[], attrs: [string, string | null][], nth: number | null }

export type FakeElement = {
  tag: string
  doc: FakeDocument
  parentNode: FakeElement | null
  childNodes: Child[]
  children: FakeElement[]
  id: string
  className: string
  value: string
  checked: boolean
  hidden: boolean
  disabled: boolean
  title: string
  placeholder: string
  dataset: Record<string, string | undefined>
  textContent: string
  isConnected: boolean
  scrollTop: number
  selectionStart: number
  selectionEnd: number
  style: { colorScheme: string, setProperty: (name: string, value: string) => void }
  getBoundingClientRect: () => { height: number }
  prepend: (...nodes: (Child | string)[]) => void
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
  removeAttribute: (name: string) => void
  appendChild: <T extends Child>(node: T) => T
  append: (...nodes: (Child | string)[]) => void
  replaceChildren: (...nodes: (Child | string)[]) => void
  insertBefore: (node: FakeElement, before: FakeElement | null) => void
  remove: () => void
  replaceWith: (node: FakeElement) => void
  contains: (other: FakeElement | null) => boolean
  addEventListener: (type: string, listener: Listener) => void
  dispatch: (type: string) => void
  focus: () => void
  setSelectionRange: (start: number, end: number) => void
  scrollIntoView: () => void
  matches: (compound: Compound) => boolean
  querySelector: (selector: string) => FakeElement | null
  querySelectorAll: (selector: string) => FakeElement[]
}

export type FakeDocument = {
  documentElement: FakeElement
  body: FakeElement
  activeElement: FakeElement | null
  title: string
  createElement: (tag: string) => FakeElement
  createElementNS: (namespace: string, tag: string) => FakeElement
  createTextNode: (text: string) => FakeText
  getElementById: (id: string) => FakeElement | null
  querySelector: (selector: string) => FakeElement | null
  querySelectorAll: (selector: string) => FakeElement[]
  settleFocus: () => void
  loadPage: (html: string) => void
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)


const parseCompound = (selector: string): Compound => {
  const found: Compound = { tag: null, id: null, classes: [], attrs: [], nth: null }
  let rest = selector
  const tag = /^[a-z][a-z0-9]*/i.exec(rest)
  if (tag !== null) {
    found.tag = tag[0].toLowerCase()
    rest = rest.slice(tag[0].length)
  }
  while (rest !== '') {
    const id = /^#([\w-]+)/.exec(rest)
    const cls = /^\.([\w-]+)/.exec(rest)
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest)
    const nth = /^:nth-of-type\((\d+)\)/.exec(rest)
    const hit = id ?? cls ?? attr ?? nth
    if (hit === null) throw new Error(`the fake document does not know the selector ${selector}`)
    if (id !== null) found.id = id[1] as string
    else if (cls !== null) found.classes.push(cls[1] as string)
    else if (attr !== null) found.attrs.push([attr[1] as string, attr[2] ?? null])
    else if (nth !== null) found.nth = Number(nth[1])
    rest = rest.slice(hit[0].length)
  }
  return found
}

const isText = (node: Child): node is FakeText => 'textNode' in node

// what instanceof HTMLElement and instanceof HTMLTextAreaElement ask about, answered for the fake's elements
const everyElement = new WeakSet<object>()
const everyTextArea = new WeakSet<object>()

const makeText = (data: string): FakeText => {
  const node: FakeText = { textNode: true, data, parentNode: null, get textContent() {
    return node.data
  }, set textContent(text: string) {
    node.data = text
  } }
  return node
}

const makeElement = (doc: FakeDocument, tag: string): FakeElement => {
  const attrs = new Map<string, string>()
  const listeners = new Map<string, Listener[]>()
  const live: { value?: string, checked?: boolean } = {}
  const flag = (name: string): boolean => attrs.has(name)
  const setFlag = (name: string, on: boolean): void => {
    if (on) attrs.set(name, '')
    else attrs.delete(name)
  }
  const adopt = (node: Child | string): Child => {
    const made = typeof node === 'string' ? makeText(node) : node
    if (made.parentNode !== null) made.parentNode.childNodes = made.parentNode.childNodes.filter((child) => child !== made)
    made.parentNode = element
    return made
  }
  const matches = (compound: Compound): boolean => {
    if (compound.tag !== null && compound.tag !== element.tag) return false
    if (compound.id !== null && compound.id !== element.id) return false
    const classes = element.className.split(/\s+/)
    if (compound.classes.some((name) => !classes.includes(name))) return false
    for (const [name, value] of compound.attrs) {
      const have = attrs.get(name)
      if (have === undefined || (value !== null && have !== value)) return false
    }
    if (compound.nth !== null) {
      const same = element.parentNode?.children.filter((sibling) => sibling.tag === element.tag) ?? []
      if (same.indexOf(element) !== compound.nth - 1) return false
    }
    return true
  }
  const element: FakeElement = {
    tag: tag.toLowerCase(),
    doc,
    parentNode: null,
    childNodes: [],
    scrollTop: 0,
    style: { colorScheme: '', setProperty: () => undefined },
    getBoundingClientRect: () => ({ height: 0 }),
    prepend: (...nodes) => {
      element.childNodes.unshift(...nodes.map(adopt))
    },
    selectionStart: 0,
    selectionEnd: 0,
    get children() {
      return element.childNodes.filter((node): node is FakeElement => !isText(node))
    },
    get id() {
      return attrs.get('id') ?? ''
    },
    get className() {
      return attrs.get('class') ?? ''
    },
    // an attribute sets the starting value, as in a browser, until the user or a script changes the property
    get value() {
      return live.value ?? ''
    },
    set value(text: string) {
      live.value = text
    },
    get checked() {
      return live.checked ?? false
    },
    set checked(on: boolean) {
      live.checked = on
    },
    get hidden() {
      return flag('hidden')
    },
    set hidden(on: boolean) {
      setFlag('hidden', on)
    },
    get disabled() {
      return flag('disabled')
    },
    set disabled(on: boolean) {
      setFlag('disabled', on)
    },
    get title() {
      return attrs.get('title') ?? ''
    },
    set title(text: string) {
      attrs.set('title', text)
    },
    get placeholder() {
      return attrs.get('placeholder') ?? ''
    },
    set placeholder(text: string) {
      attrs.set('placeholder', text)
    },
    get dataset() {
      return new Proxy({}, {
        get: (_, name) => typeof name === 'string' ? attrs.get(`data-${kebab(name)}`) : undefined,
        set: (_, name, value) => {
          attrs.set(`data-${kebab(String(name))}`, String(value))
          return true
        },
        deleteProperty: (_, name) => {
          attrs.delete(`data-${kebab(String(name))}`)
          return true
        },
      })
    },
    get textContent() {
      return element.childNodes.map((node) => node.textContent).join('')
    },
    set textContent(text: string) {
      element.replaceChildren(...(text === '' ? [] : [text]))
    },
    get isConnected() {
      for (let at: FakeElement | null = element; at !== null; at = at.parentNode) if (at === doc.documentElement) return true
      return false
    },
    setAttribute: (name, value) => {
      attrs.set(name, value)
      if (name === 'checked') live.checked = true
      if (name === 'value') live.value = value
    },
    getAttribute: (name) => attrs.get(name) ?? null,
    removeAttribute: (name) => {
      attrs.delete(name)
    },
    appendChild: (node) => {
      element.childNodes.push(adopt(node))
      return node
    },
    append: (...nodes) => {
      for (const node of nodes) element.childNodes.push(adopt(node))
    },
    replaceChildren: (...nodes) => {
      for (const child of element.childNodes) child.parentNode = null
      element.childNodes = []
      element.append(...nodes)
      doc.settleFocus()
    },
    insertBefore: (node, before) => {
      const made = adopt(node)
      const at = before === null ? -1 : element.childNodes.indexOf(before)
      if (at < 0) element.childNodes.push(made)
      else element.childNodes.splice(at, 0, made)
    },
    remove: () => {
      if (element.parentNode === null) return
      element.parentNode.childNodes = element.parentNode.childNodes.filter((child) => child !== element)
      element.parentNode = null
      doc.settleFocus()
    },
    replaceWith: (node) => {
      const parent = element.parentNode
      if (parent === null) return
      parent.insertBefore(node, element)
      element.remove()
    },
    contains: (other) => {
      for (let at = other; at !== null; at = at.parentNode) if (at === element) return true
      return false
    },
    addEventListener: (type, listener) => {
      listeners.set(type, [...listeners.get(type) ?? [], listener])
    },
    dispatch: (type) => {
      const event: FakeEvent = { type, target: element, preventDefault: () => undefined }
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
    focus: () => {
      doc.activeElement = element
    },
    setSelectionRange: (start, end) => {
      element.selectionStart = start
      element.selectionEnd = end
    },
    scrollIntoView: () => undefined,
    matches,
    querySelectorAll: (selector) => {
      const compound = parseCompound(selector)
      const found: FakeElement[] = []
      const walk = (parent: FakeElement): void => {
        for (const child of parent.children) {
          if (child.matches(compound)) found.push(child)
          walk(child)
        }
      }
      walk(element)
      return found
    },
    querySelector: (selector) => element.querySelectorAll(selector)[0] ?? null,
  }
  everyElement.add(element)
  if (tag === 'textarea') everyTextArea.add(element)
  return element
}

export const makeDocument = (): FakeDocument => {
  const doc: FakeDocument = {
    documentElement: undefined as unknown as FakeElement,
    body: undefined as unknown as FakeElement,
    activeElement: null,
    title: '',
    createElement: (tag) => makeElement(doc, tag),
    createElementNS: (_namespace, tag) => makeElement(doc, tag),
    createTextNode: makeText,
    getElementById: (id) => doc.documentElement.querySelector(`#${id}`),
    querySelector: (selector) => doc.documentElement.querySelector(selector),
    querySelectorAll: (selector) => doc.documentElement.querySelectorAll(selector),
    // as in a browser, focus falls back to the body when the focused element leaves the page
    settleFocus: () => {
      if (doc.activeElement !== null && !doc.activeElement.isConnected) doc.activeElement = doc.body
    },
    // puts the elements of a served page's markup that carry an id in the document, each with its own tag and attributes, so the code under test finds the same ids and tags the real page has and throws for one it lacks. Their nesting is not kept
    loadPage: (html) => {
      for (const match of html.matchAll(/<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>(?:([^<]*)<\/\1>)?/g)) {
        const [, tag = '', attributes = '', text = ''] = match
        if (!/\sid="/.test(attributes)) continue
        const element = doc.createElement(tag)
        for (const attribute of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) element.setAttribute(attribute[1] as string, attribute[2] ?? '')
        if (text !== '') element.textContent = text
        doc.body.appendChild(element)
      }
    },
  }
  doc.documentElement = makeElement(doc, 'html')
  doc.body = makeElement(doc, 'body')
  doc.documentElement.appendChild(doc.body)
  doc.activeElement = doc.body
  return doc
}

export type FakeBrowser = { document: FakeDocument, restore: () => void }

// installs the fake as the page's globals, with the fetch the test supplies; restore puts back what was there
export const installFakeBrowser = (fetchImpl: typeof fetch, hash = ''): FakeBrowser => {
  const doc = makeDocument()
  const names = ['document', 'HTMLElement', 'HTMLTextAreaElement', 'window', 'fetch', 'ResizeObserver', 'IntersectionObserver']
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const set = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  set('document', doc)
  set('HTMLElement', { [Symbol.hasInstance]: (value: unknown) => typeof value === 'object' && value !== null && everyElement.has(value) })
  set('HTMLTextAreaElement', { [Symbol.hasInstance]: (value: unknown) => typeof value === 'object' && value !== null && everyTextArea.has(value) })
  set('window', { location: { hash }, addEventListener: () => undefined })
  set('fetch', fetchImpl)
  // the page's observers only measure and scroll, which a fake page has none of
  const observer = new Proxy(Object, { construct: () => ({ observe: () => undefined, disconnect: () => undefined }) })
  set('ResizeObserver', observer)
  set('IntersectionObserver', observer)
  return {
    document: doc,
    restore: () => {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name]
        else Object.defineProperty(globalThis, name, descriptor)
      }
    },
  }
}

// what a person does to a control: each change the page listens for, after the property a browser would already have set
export const tick = (box: FakeElement): void => {
  box.checked = !box.checked
  box.dispatch('change')
}

export const typeInto = (field: FakeElement, text: string): void => {
  field.value = text
  field.dispatch('input')
}

export const press = (button: FakeElement): void => button.dispatch('click')
