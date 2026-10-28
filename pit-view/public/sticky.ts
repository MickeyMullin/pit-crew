// public/sticky.ts
// the sticky bars: the header on both pages and the Settings page's save bar. Each bar's height is
// kept in a custom property on the root element, which styles.css turns into the page's scroll
// padding, and the header gets data-scrolled once content has scrolled under it, which styles.css
// draws as its bottom border and shadow. Observers do all of it, so nothing listens to scroll
import { h } from './dom.ts'

// a bar wraps onto more lines at narrow widths, so its height is measured, not assumed
export const trackHeight = (bar: HTMLElement, property: string): void => {
  new ResizeObserver(() => {
    document.documentElement.style.setProperty(property, `${Math.ceil(bar.getBoundingClientRect().height)}px`)
  }).observe(bar)
}

export const mountStickyHeader = (header: HTMLElement): void => {
  trackHeight(header, '--header-height')
  // a 1px marker at the very top of the page: once it leaves the viewport, the page has scrolled
  const sentinel = h('div', { class: 'header-sentinel', 'aria-hidden': 'true' })
  document.body.prepend(sentinel)
  new IntersectionObserver((entries) => {
    const entry = entries.at(-1)
    if (entry !== undefined) header.dataset.scrolled = String(!entry.isIntersecting)
  }).observe(sentinel)
}
