// test/timetext.ts
// the time text rule, judged by the type checker: outside public/format.ts, no code the browser runs holds a value whose type is Date or Intl, and it calls the Date constructor only for a number (milliseconds, for arithmetic and comparison); so a time can become text only through the shared formatter, whatever method, conversion, or template would write it
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { SyntaxKind, type Node, type SourceFile } from 'typescript/unstable/ast'
import { isCallExpression, isExportDeclaration, isExpression, isImportDeclaration, isPropertyAccessExpression, isStringLiteral } from 'typescript/unstable/ast/is'
import { API, SymbolFlags, TypeFlags, type Type } from 'typescript/unstable/sync'

export const root = join(import.meta.dirname, '..')

// the one file allowed to turn a time into text
export const formatter = join(root, 'public/format.ts')

export type Source = { path: string, text: string }

// a browser file the checker reads as code, by extension; inline scripts in a page are read as JavaScript
export const codeExtensions = new Set(['.ts', '.mts', '.js', '.mjs'])

// a page is checked through its inline scripts; the other served files are data and must hold no script
export const pageExtensions = new Set(['.html'])
export const inertExtensions = new Set(['.css', '.json', '.png', '.ico', '.webp', '.woff2', '.svg'])

const walk = async (dir: string): Promise<string[]> => {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

export const publicFiles = async (): Promise<string[]> => (await walk(join(root, 'public'))).sort()

// a page's classic and module scripts that carry their code inline, each as its own JavaScript source beside the page
export const inlineScripts = (page: string, html: string): Source[] =>
  [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match, at) => ({ path: `${page}.inline-${at + 1}.js`, text: match[1] ?? '' }))

// value imports only: an import type is erased before the browser sees the file, and anything else (an import of named types included) still loads the module
const valueImports = (file: SourceFile): string[] => {
  const specifiers: string[] = []
  for (const statement of file.statements) {
    if (isImportDeclaration(statement) && statement.importClause?.phaseModifier !== SyntaxKind.TypeKeyword && isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
    if (isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier !== undefined && isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
  }
  return specifiers.filter((specifier) => specifier.startsWith('.')).map((specifier) => resolve(dirname(file.fileName), specifier))
}

type Checked = { offenders: string[], shipped: string[] }

// the checker itself: reads the given sources over the real tree (a source at a real path stands in for that file), follows value imports from them, and reports every expression outside the formatter that breaks the rule as path:line: code
export const checkTimeText = (sources: readonly Source[]): Checked => {
  const overlay = new Map(sources.map((source) => [source.path, source.text]))
  const config = join(root, 'tsconfig.timetext.json')
  overlay.set(config, JSON.stringify({ extends: './tsconfig.json', compilerOptions: { allowJs: true, checkJs: false }, include: [], files: sources.map((source) => source.path) }))
  const api = new API({
    cwd: root,
    fs: {
      readFile: (name) => overlay.get(name),
      fileExists: (name) => overlay.has(name) ? true : undefined,
    },
  })
  try {
    const snapshot = api.updateSnapshot({ openProject: config })
    const project = snapshot.getProject(config)
    if (project === undefined) throw new Error('the time text project did not load')
    const { checker, program } = project
    const fileOf = (path: string): SourceFile => {
      const file = program.getSourceFile(path)
      if (file === undefined) throw new Error(`${path} is not in the time text project`)
      return file
    }

    // the browser runs the given sources and everything they reach by a value import
    const shipped = new Set<string>()
    const pending = sources.map((source) => source.path)
    while (pending.length > 0) {
      const path = pending.pop() ?? ''
      if (shipped.has(path)) continue
      shipped.add(path)
      pending.push(...valueImports(fileOf(path)))
    }

    const anchor = fileOf(sources[0]?.path ?? formatter)
    const globalType = (name: string, meaning: SymbolFlags): number => {
      const symbol = checker.resolveName(name, meaning, anchor)
      if (symbol === undefined) throw new Error(`the global ${name} was not found`)
      return (meaning === SymbolFlags.Type ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeOfSymbol(symbol))?.id ?? -1
    }
    // a Date instance can be written as a clock in any number of ways, and every Intl formatter is reached through the Intl namespace
    const held = new Set([globalType('Date', SymbolFlags.Type), globalType('Intl', SymbolFlags.Value)])
    const constructorType = globalType('Date', SymbolFlags.Value)

    const holds = (type: Type | undefined, ids: ReadonlySet<number>): boolean => {
      if (type === undefined) return false
      if (ids.has(type.id)) return true
      return (type.isUnionType() || type.isIntersectionType()) && type.getTypes().some((member) => holds(member, ids))
    }
    const isNumber = (type: Type | undefined): boolean => type !== undefined && (type.flags & TypeFlags.NumberLike) !== 0

    const offenders: string[] = []
    for (const path of [...shipped].sort()) {
      if (path === formatter) continue
      const file = fileOf(path)
      const nodes: Node[] = []
      const visit = (node: Node): void => {
        if (isExpression(node)) nodes.push(node)
        node.forEachChild(visit)
      }
      file.forEachChild(visit)
      const types = checker.getTypeAtLocation(nodes)
      const typeOf = new Map(nodes.map((node, at) => [node, types[at]]))
      const offending = new Set<Node>()
      // the constructor is allowed only as Date.member(...) answering a number: Date.now() and Date.parse(iso) are milliseconds; Date() is a string and new Date() a Date
      const countsMilliseconds = (node: Node): boolean => {
        const access = node.parent
        const call = access?.parent
        return access !== undefined && isPropertyAccessExpression(access) && access.expression === node && call !== undefined && isCallExpression(call) && call.expression === access && isNumber(typeOf.get(call))
      }
      nodes.forEach((node, at) => {
        const type = types[at]
        const offends = holds(type, held) || (holds(type, new Set([constructorType])) && !countsMilliseconds(node))
        // report the outermost offending expression once, not each part of it
        const parent = node.parent
        const parentOffends = parent !== undefined && isExpression(parent) && offending.has(parent)
        if (offends) offending.add(node)
        if (offends && !parentOffends) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
          offenders.push(`${path.slice(root.length + 1)}:${line + 1}: ${file.text.slice(node.getStart(file), node.end).replace(/\s+/g, ' ').slice(0, 100)}`)
        }
      })
    }
    return { offenders, shipped: [...shipped].map((path) => path.slice(root.length + 1)).sort() }
  } finally {
    api.close()
  }
}

// every code source the browser can load from public/: its scripts and modules as they are, and each page's inline scripts
export const browserSources = async (): Promise<Source[]> => {
  const sources: Source[] = []
  for (const path of await publicFiles()) {
    const extension = extname(path).toLowerCase()
    if (codeExtensions.has(extension)) sources.push({ path, text: await readFile(path, 'utf8') })
    if (pageExtensions.has(extension)) sources.push(...inlineScripts(path, await readFile(path, 'utf8')))
  }
  return sources
}
