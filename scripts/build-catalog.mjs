#!/usr/bin/env node
// Собирает catalog.json — индекс сценариев, который читает Pajama, — и проверяет каждый сценарий.
//   node scripts/build-catalog.mjs          записать catalog.json
//   node scripts/build-catalog.mjs --check  только проверить: ошибки или устаревший catalog.json дают код 1
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORMAT = 1
const NEED_KINDS = ['info', 'account', 'money', 'document', 'tool']
const STATUSES = ['trial', 'stable']
const MAX_FILE = 100_000
const MAX_FILES = 60
const FORBIDDEN = [
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, why: 'скачать и сразу выполнить' },
  { re: /\bsk-[A-Za-z0-9]{20,}/, why: 'похоже на ключ API' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'похоже на ключ облака' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'закрытый ключ' }
]

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v) => typeof v === 'string' && v.trim().length > 0
const both = (v) => isObj(v) && text(v.ru) && text(v.en)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** Все файлы папки, пути относительно root, через «/». */
function walk(root, dir) {
  const out = []
  const abs = join(root, dir)
  if (!existsSync(abs)) return out
  for (const name of readdirSync(abs).sort()) {
    if (name.startsWith('.')) continue
    const rel = posix.join(dir, name)
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel))
    else out.push(rel)
  }
  return out
}

/** Заголовок файла между `---`: только строки «ключ: значение». */
export function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  const data = {}
  if (!m) return data
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) data[kv[1]] = kv[2].trim()
  }
  return data
}

export function validateManifest(m, dirName) {
  const errors = []
  const err = (s) => errors.push(s)
  if (!isObj(m)) return ['scenario.json: не объект']
  if (m.id !== dirName) err(`id «${m.id}» не совпадает с папкой «${dirName}»`)
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(m.id))) err('id: латиница, цифры и дефисы')
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version))) err('version: формат 1.2.3')
  if (!STATUSES.includes(m.status)) err(`status: ${STATUSES.join(' или ')}`)
  if (m.order !== undefined && !Number.isInteger(m.order)) err('order: целое число (порядок в списке)')
  if (!text(m.icon)) err('icon: нужно имя значка')
  if (typeof m.legal !== 'boolean') err('legal: true или false')
  if (m.legal && !/^\d{4}-\d{2}-\d{2}$/.test(String(m.checked))) err('checked: юридическому сценарию нужна дата проверки ГГГГ-ММ-ДД')
  if (m.checked !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(m.checked))) err('checked: формат ГГГГ-ММ-ДД')
  if (!/^\d+\.\d+\.\d+$/.test(String(m.minApp))) err('minApp: формат 1.2.3')
  for (const key of ['title', 'summary', 'result', 'time', 'startPrompt']) if (!both(m[key])) err(`${key}: нужны тексты ru и en`)
  if (!Array.isArray(m.needs) || m.needs.length === 0) err('needs: список «что понадобится» не может быть пустым')
  else m.needs.forEach((n, i) => (!isObj(n) || !NEED_KINDS.includes(n.kind) || !both(n) ? err(`needs[${i}]: kind из ${NEED_KINDS.join('/')} и тексты ru и en`) : undefined))
  if (!text(m.lead)) err('lead: имя ведущего помощника')
  if (!Array.isArray(m.shared)) err('shared: список общих правил')
  else {
    for (const need of ['style', 'money-and-publish']) if (!m.shared.includes(need)) err(`shared: обязательно «${need}»`)
    if (m.legal && !m.shared.includes('legal-disclaimer')) err('shared: юридическому сценарию нужно «legal-disclaimer»')
  }
  if (!Array.isArray(m.skills) || m.skills.length === 0) err('skills: нужен хотя бы один навык')
  return errors
}

function readText(root, rel, errors) {
  const buf = readFileSync(join(root, rel))
  if (buf.length > MAX_FILE) errors.push(`${rel}: больше ${MAX_FILE} байт`)
  const src = buf.toString('utf8')
  for (const f of FORBIDDEN) if (f.re.test(src)) errors.push(`${rel}: запрещённое (${f.why})`)
  return { buf, src }
}

function buildScenario(root, id) {
  const errors = []
  const dir = `scenarios/${id}`
  const manifestPath = `${dir}/scenario.json`
  let m
  try {
    m = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'))
  } catch (e) {
    return { errors: [`${manifestPath}: ${e.message}`] }
  }
  errors.push(...validateManifest(m, id))
  if (errors.length) return { errors: errors.map((e) => `${id}: ${e}`) }

  const files = []
  const add = (rel, role, dest) => {
    const { buf } = readText(root, rel, errors)
    files.push({ path: rel, sha256: sha256(buf), size: buf.length, role, ...(dest ? { dest } : {}) })
  }
  add(manifestPath, 'manifest')

  // Правила проекта: сначала общие в порядке из manifest, последним — свои.
  for (const name of m.shared) {
    const rel = `shared/${name}.md`
    if (!existsSync(join(root, rel))) errors.push(`shared «${name}»: нет файла ${rel}`)
    else add(rel, 'rules')
  }
  if (existsSync(join(root, `${dir}/CLAUDE.md`))) add(`${dir}/CLAUDE.md`, 'rules')
  else errors.push(`${dir}/CLAUDE.md: нет файла`)
  const money = join(root, 'shared/money-and-publish.md')
  if (existsSync(money) && !readFileSync(money, 'utf8').includes('Здесь платите вы')) errors.push('shared/money-and-publish.md: нет блока «Здесь платите вы»')

  // Помощники.
  const agents = walk(root, `${dir}/agents`).filter((p) => p.endsWith('.md'))
  if (!agents.includes(`${dir}/agents/${m.lead}.md`)) errors.push(`lead «${m.lead}»: нет файла agents/${m.lead}.md`)
  for (const rel of agents) {
    const { src } = readText(root, rel, errors)
    const fm = frontmatter(src)
    const name = basename(rel, '.md')
    if (fm.name !== name) errors.push(`${rel}: name в заголовке должен быть «${name}»`)
    if (!text(fm.description)) errors.push(`${rel}: нет description`)
    if (/^tools:.*mcp__/m.test(src.split('---')[1] ?? '')) errors.push(`${rel}: помощнику нельзя выдавать инструменты MCP (покупки только руками человека)`)
    add(rel, 'agent', `${name}.md`)
  }

  // Навыки: свои в папке сценария, общие — «shared:имя» в shared/skills.
  for (const ref of m.skills) {
    const shared = String(ref).startsWith('shared:')
    const name = shared ? String(ref).slice(7) : String(ref)
    const base = shared ? `shared/skills/${name}` : `${dir}/skills/${name}`
    const skillFiles = walk(root, base)
    if (!skillFiles.includes(`${base}/SKILL.md`)) {
      errors.push(`навык «${ref}»: нет ${base}/SKILL.md`)
      continue
    }
    const fm = frontmatter(readFileSync(join(root, `${base}/SKILL.md`), 'utf8'))
    if (fm.name !== name) errors.push(`${base}/SKILL.md: name должен быть «${name}»`)
    if (!text(fm.description)) errors.push(`${base}/SKILL.md: нет description`)
    for (const rel of skillFiles) add(rel, 'skill', `${name}/${rel.slice(base.length + 1)}`)
  }
  if (files.length > MAX_FILES) errors.push(`файлов больше ${MAX_FILES}`)
  if (errors.length) return { errors: errors.map((e) => `${id}: ${e}`) }

  return {
    errors,
    entry: {
      id: m.id,
      version: m.version,
      status: m.status,
      ...(Number.isInteger(m.order) ? { order: m.order } : {}),
      icon: m.icon,
      legal: m.legal,
      ...(m.checked ? { checked: m.checked } : {}),
      minApp: m.minApp,
      title: m.title,
      summary: m.summary,
      result: m.result,
      time: m.time,
      needs: m.needs,
      lead: m.lead,
      skills: m.skills,
      startPrompt: m.startPrompt,
      files
    }
  }
}

/** Индекс по всем сценариям. prevRevision — номер из прежнего catalog.json. */
export function buildCatalog(root, previous) {
  const errors = []
  const scenarios = []
  const ids = existsSync(join(root, 'scenarios')) ? readdirSync(join(root, 'scenarios')).filter((n) => statSync(join(root, 'scenarios', n)).isDirectory()).sort() : []
  for (const id of ids) {
    const r = buildScenario(root, id)
    errors.push(...r.errors)
    if (r.entry) scenarios.push(r.entry)
  }
  const body = { format: FORMAT, scenarios }
  const same = previous && previous.format === FORMAT && JSON.stringify(previous.scenarios) === JSON.stringify(scenarios)
  const revision = same ? previous.revision : (Number.isInteger(previous?.revision) ? previous.revision : 0) + 1
  return { errors, catalog: { format: FORMAT, revision, scenarios: body.scenarios } }
}

export const serialize = (catalog) => `${JSON.stringify(catalog, null, 2)}\n`

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const file = join(root, 'catalog.json')
  const check = process.argv.includes('--check')
  let previous
  try {
    previous = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    previous = undefined
  }
  const { errors, catalog } = buildCatalog(root, previous)
  if (errors.length) {
    console.error(errors.map((e) => `ОШИБКА ${e}`).join('\n'))
    process.exit(1)
  }
  const next = serialize(catalog)
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (check) {
    if (current !== next) {
      console.error('catalog.json устарел: выполните «node scripts/build-catalog.mjs» и закоммитьте его')
      process.exit(1)
    }
    console.log(`catalog.json актуален: сценариев ${catalog.scenarios.length}, версия индекса ${catalog.revision}`)
    return
  }
  if (current !== next) writeFileSync(file, next)
  console.log(`catalog.json: сценариев ${catalog.scenarios.length}, версия индекса ${catalog.revision}${current === next ? ' (без изменений)' : ''}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
