// public/dom.ts
// a small element builder and keyed reconciliation, so a patch changes only what it touched

export type Child = Node | string | number | null | undefined | false
type AttrValue = string | number | boolean | null | undefined
export type Attrs = Record<string, AttrValue>

// attributes are set as given; false, null and undefined leave one off, true sets it empty
export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue
    element.setAttribute(name, value === true ? '' : String(value))
  }
  append(element, children)
  return element
}

export const append = (parent: Node, children: readonly (Child | Child[])[]): void => {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
  }
}

const svgNs = 'http://www.w3.org/2000/svg'

// decorative icons, drawn in currentColor; shapes are [tag, attributes] pairs
export type Shape = [string, Record<string, string>]

export const svg = (shapes: readonly Shape[], { size = 16, stroke = '2', fill = false, className = '' } = {}): SVGSVGElement => {
  const icon = document.createElementNS(svgNs, 'svg')
  const attributes: Record<string, string> = {
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: fill ? 'currentColor' : 'none',
    stroke: fill ? 'none' : 'currentColor',
    'stroke-width': stroke,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }
  if (className !== '') attributes.class = className
  for (const [name, value] of Object.entries(attributes)) icon.setAttribute(name, value)
  for (const [tag, shapeAttributes] of shapes) {
    const shape = document.createElementNS(svgNs, tag)
    for (const [name, value] of Object.entries(shapeAttributes)) shape.setAttribute(name, value)
    icon.appendChild(shape)
  }
  return icon
}

// every GitHub or ticket link opens in a new tab, so the dashboard's own tab never navigates away
export const newTab = { target: '_blank', rel: 'noopener' } as const

// a part of a parent: rebuilt only when its signature changes
export type Part = { key: string, sig: string, build: () => Element }

// an element kept for as long as its key is wanted, updated in place on every pass
export type Keyed = { key: string, create: () => Element, update: (element: Element) => void }

const keys = new WeakMap<Element, string>()
const sigs = new WeakMap<Element, string>()

const keyedChildren = (parent: Element): Map<string, Element> => {
  const found = new Map<string, Element>()
  for (const child of parent.children) {
    const key = keys.get(child)
    if (key !== undefined) found.set(key, child)
  }
  return found
}

// puts exactly these elements in parent, in order, moving only those out of place
const order = (parent: Element, wanted: readonly Element[]): void => {
  const keep = new Set(wanted)
  for (const child of [...parent.children]) {
    if (!keep.has(child)) child.remove()
  }
  wanted.forEach((element, index) => {
    const at = parent.children[index] ?? null
    if (at !== element) parent.insertBefore(element, at)
  })
}

const isPart = (item: Part | Keyed): item is Part => 'build' in item

// makes parent hold exactly these items, in order: a part is reused while its signature holds
// and rebuilt in place when it changes; a keyed element is kept and updated on every pass
export const sync = (parent: Element, items: readonly (Part | Keyed)[]): void => {
  const existing = keyedChildren(parent)
  const wanted = items.map((item) => {
    const old = existing.get(item.key)
    if (isPart(item)) {
      if (old !== undefined && sigs.get(old) === item.sig) return old
      const element = item.build()
      keys.set(element, item.key)
      sigs.set(element, item.sig)
      if (old !== undefined) old.replaceWith(element)
      return element
    }
    let element = old
    if (element === undefined || sigs.has(element)) {
      element = item.create()
      keys.set(element, item.key)
    }
    item.update(element)
    return element
  })
  order(parent, wanted)
}

// sets text only when it differs, so unchanged text never churns the DOM
export const setText = (element: Element, text: string): void => {
  if (element.textContent !== text) element.textContent = text
}

export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`index.html has no #${id}`)
  return element as T
}
