/**
 * 폼 응답 시트 한 행 → 이슈/Discussions 본문 변환 (순수 함수 — 네트워크·파일 접근 없음).
 *
 * 규격: ekaya-studio 레포 docs/tracks/platform/2026-10-19-feedback-channel-expansion SPEC §3.
 * 이 레포는 public이다 — 여기 쓰는 모든 것이 공개된다. 시트 ID·키·내부 정보를 적지 않는다.
 */
import { createHash } from 'node:crypto'

/**
 * 시트 열 이름 화이트리스트. **여기 없는 열(연락처·동의)은 읽지 않는다** — 열 순서에 기대지 않고
 * 열 제목 앞부분(「종류 / Type」→「종류」)으로 찾는다(SPEC §3.1).
 * 「기대한 동작 · 제안 내용」은 앞쪽 「기대한 동작」으로 찾는다.
 */
const COLUMNS = {
  ts: ['타임스탬프', 'Timestamp'],
  kind: ['종류'],
  title: ['제목'],
  what: ['내용'],
  steps: ['재현 절차'],
  expected: ['기대한 동작'],
  diagnostics: ['진단 정보'],
  status: ['처리'],
}

/** 종류 객관식 선택지 글자 → 내부 key. 앱의 FORM_KIND_LABEL(formUrl.ts)과 같다. */
const KIND = { 버그: 'bug', '기능 제안': 'feature', 질문: 'question', '비정상 종료': 'crash' }

/** §3.6 행선지. 질문만 Discussions Q&A. */
const DEST = {
  bug: { target: 'issue', labels: ['type:bug', 'via:form'] },
  feature: { target: 'issue', labels: ['type:enhancement', 'via:form'] },
  crash: { target: 'issue', labels: ['type:bug', 'crash', 'via:form'] },
  question: { target: 'discussion', labels: [] },
}

export const FIELD_LIMIT = 4000
export const TITLE_LIMIT = 200
const BODY_LIMIT = 65000

/** 열 제목 행 → { key: 열 번호 }. 화이트리스트에 없는 열은 결과에 없다. */
export function mapColumns(header) {
  const map = {}
  header.forEach((raw, i) => {
    const head = String(raw ?? '').split('/')[0].trim()
    for (const [key, names] of Object.entries(COLUMNS)) {
      if (key in map) continue
      if (names.some((n) => head === n || head.startsWith(n))) map[key] = i
    }
  })
  return map
}

/** 시트 values(첫 행 = 제목) → 행 객체. 연락처·동의 열은 여기서 이미 없다. */
export function parseRows(values) {
  if (!values?.length) return []
  const cols = mapColumns(values[0])
  return values.slice(1).map((cells) => {
    const row = {}
    for (const key of Object.keys(COLUMNS)) {
      row[key] = key in cols ? String(cells[cols[key]] ?? '').trim() : ''
    }
    return row
  })
}

/** SHA-256(타임스탬프 + 연락처를 뺀 칸들) 앞 16자. 「처리」 열은 사람이 바꾸므로 넣지 않는다. */
export function rowHash(row) {
  const parts = [row.ts, row.kind, row.title, row.what, row.steps, row.expected, row.diagnostics]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

/**
 * 선행 SPEC §3.3 maskSensitive의 사본 — 원본은 ekaya-studio
 * `src/frontend/services/feedback/diagnostics.ts`. 규칙을 고치면 양쪽을 같이 고친다.
 * 폼 경로에서는 사용자가 쓴 본문에도 건다(이 트랙 SPEC §3.3).
 */
export function maskSensitive(text) {
  if (!text) return text
  let out = text
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\/:*?"<>|\r\n]+/g, '$1<user>')
  out = out.replace(/(\/home\/)[^/\s:]+/g, '$1<user>')
  out = out.replace(/(\/Users\/)[^/\s:]+/g, '$1<user>')
  out = out.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d{1,5})?\b/g, '<host>')
  out = out.replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:\d{2,5}\b/g, '<host>')
  out = out.replace(/\b[A-Za-z][A-Za-z0-9-]*[A-Za-z]:\d{2,5}\b/g, '<host>')
  out = out.replace(/[A-Za-z0-9_-]+/g, (m) => (m.length >= 20 ? '<redacted>' : m))
  return out
}

/** 칸 전체를 펜스 코드블록으로. 펜스는 칸 안 가장 긴 백틱 연속보다 한 개 길게(최소 3). */
export function fence(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const bar = '`'.repeat(Math.max(3, longest + 1))
  return `${bar}text\n${text}\n${bar}`
}

/** 줄바꿈 제거·200자 절단·`[폼]` 접두·`@`→`＠`(제목은 코드블록이 없다). */
export function cleanTitle(raw) {
  const flat = maskSensitive(raw).replace(/\s*[\r\n]+\s*/g, ' ').trim()
  const cut = [...flat].slice(0, TITLE_LIMIT).join('')
  return `[폼] ${cut}`.replaceAll('@', '＠')
}

function clip(text) {
  const chars = [...text]
  return chars.length > FIELD_LIMIT ? `${chars.slice(0, FIELD_LIMIT).join('')}\n…(잘림)` : text
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE = /(?:\+?\d{1,3}[-.\s])?\(?\d{2,4}\)?[-.\s]\d{3,4}[-.\s]\d{4}\b|\b01[016789]\d{7,8}\b/
const LINK = /https?:\/\/|www\./gi

function userText(row) {
  return [row.title, row.what, row.steps, row.expected].join('\n')
}

/**
 * §3.4 보류 사유. 행 내용만으로 정해진다(상태를 저장하지 않는다) — 매 회차 같은 결과.
 * `titleCounts`: 이번에 읽은 행 전체의 정규화한 제목 → 건수.
 *
 * shortcut: 「필수 칸이 프리필 기본값 그대로」는 앱이 기본값 문구를 프리필하지 않아 비었는지만 본다.
 * 앱이 기본 문구를 넣게 되면 여기서 그 문구와 비교한다.
 */
export function holdReasons(row, titleCounts) {
  const reasons = []
  if (!(row.kind in KIND)) reasons.push('unknown-kind')
  if (!row.title || !row.what) reasons.push('incomplete')
  const text = userText(row)
  if (EMAIL.test(text) || EMAIL.test(row.diagnostics)) reasons.push('contact-email')
  if (PHONE.test(text)) reasons.push('contact-phone')
  const links = (`${text}\n${row.diagnostics}`.match(LINK) ?? []).length
  if (links >= 3) reasons.push('links')
  if ((titleCounts.get(normTitle(row.title)) ?? 0) >= 3) reasons.push('repeated-title')
  return reasons
}

function normTitle(t) {
  return t.toLowerCase().replace(/\s+/g, ' ').trim()
}

function section(name, text) {
  return text ? `### ${name}\n\n${fence(clip(maskSensitive(text)))}\n\n` : ''
}

/** 이슈/Discussions에 올릴 내용. 질문이면 본문 첫 줄에 「폼으로 받은 질문」. */
export function buildPost(row) {
  const kind = KIND[row.kind]
  const hash = rowHash(row)
  const dest = DEST[kind]
  let body = kind === 'question' ? '> 폼으로 받은 질문\n\n' : '> 구글 폼으로 접수된 제보입니다.\n\n'
  body += section('내용', row.what)
  body += section('재현 절차', row.steps)
  body += section('기대한 동작 · 제안 내용', row.expected)
  body += section('진단 정보', row.diagnostics)
  body = body.slice(0, BODY_LIMIT).trimEnd()
  body += `\n\n<!-- ekaya-form:${hash} -->`
  return { hash, kind, target: dest.target, labels: dest.labels, title: cleanTitle(row.title), body }
}

const MARKER = /<!-- ekaya-form:([0-9a-f]{16}) -->\s*$/

/** 이슈·Discussions 본문 끝의 표식 해시. 사용자 칸은 코드블록 안이라 끝줄 표식만 본다. */
export function markerOf(body) {
  return MARKER.exec(body ?? '')?.[1] ?? null
}

/**
 * 행 전체 → 처리 계획. `known`: 이미 등록된 해시 집합.
 * 반환 각 항목: { hash, action: 'post'|'hold'|'skip', reason?, post? }
 * 처리 열 `버림` → skip, `승인` → 보류 사유를 무시하고 post(마스킹·코드블록은 그대로 거친다).
 */
export function plan(rows, known) {
  const titleCounts = new Map()
  for (const r of rows) {
    const k = normTitle(r.title)
    if (k) titleCounts.set(k, (titleCounts.get(k) ?? 0) + 1)
  }
  return rows.map((row) => {
    const hash = rowHash(row)
    if (known.has(hash)) return { hash, action: 'skip', reason: 'done' }
    if (row.status === '버림') return { hash, action: 'skip', reason: 'discarded' }
    const reasons = holdReasons(row, titleCounts)
    const blocking = reasons.filter((r) => r === 'unknown-kind' || r === 'incomplete')
    if (blocking.length) return { hash, action: 'hold', reason: blocking.join(',') }
    if (reasons.length && row.status !== '승인') return { hash, action: 'hold', reason: reasons.join(',') }
    return { hash, action: 'post', post: buildPost(row) }
  })
}
