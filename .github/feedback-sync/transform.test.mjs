import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapColumns, parseRows, rowHash, maskSensitive, fence, cleanTitle,
  holdReasons, buildPost, markerOf, plan,
} from './transform.mjs'

const HEADER = [
  '타임스탬프', '종류 / Type', '제목 / Title', '내용 / Details', '재현 절차 / Steps',
  '기대한 동작 · 제안 내용 / Expected', '진단 정보 / Diagnostics', '연락처 / Contact', '동의 / Consent', '처리',
]
const row = (over = {}) => ({
  ts: '2026. 10. 19 오후 1:00:00', kind: '버그', title: '저장이 안 됨', what: '저장 버튼을 누르면 멈춥니다',
  steps: '', expected: '', diagnostics: 'version: 0.16.6\napp: markdown', status: '', ...over,
})
const counts = (rows) => new Map(rows.map((r) => [r.title.toLowerCase(), 1]))

test('열 제목 앞부분으로 찾고 연락처·동의 열은 읽지 않는다', () => {
  const cols = mapColumns(HEADER)
  assert.equal(cols.kind, 1)
  assert.equal(cols.expected, 5)
  assert.equal(cols.status, 9)
  assert.deepEqual(Object.keys(cols).sort(), ['diagnostics', 'expected', 'kind', 'status', 'steps', 'title', 'ts', 'what'])
  const [r] = parseRows([HEADER, ['t', '버그', '제목', '내용', '', '', '', 'a@b.com', '동의', '']])
  assert.ok(!JSON.stringify(r).includes('a@b.com'))
})

test('열 순서가 바뀌어도 매핑된다', () => {
  const [r] = parseRows([['제목', '종류', '타임스탬프', '내용'], ['T', '질문', 'ts', 'C']])
  assert.deepEqual([r.title, r.kind, r.ts, r.what], ['T', '질문', 'ts', 'C'])
})

test('뒤쪽 빈 셀이 잘려 와도 빈 문자열', () => {
  const [r] = parseRows([HEADER, ['t', '버그', '제목', '내용']])
  assert.equal(r.status, '')
  assert.equal(r.diagnostics, '')
})

test('해시는 안정적이고 처리 열에 영향받지 않는다', () => {
  assert.equal(rowHash(row()), rowHash(row()))
  assert.match(rowHash(row()), /^[0-9a-f]{16}$/)
  assert.equal(rowHash(row()), rowHash(row({ status: '승인' })))
  assert.notEqual(rowHash(row()), rowHash(row({ what: '다름' })))
})

test('펜스는 칸 안 가장 긴 백틱보다 한 개 길다', () => {
  assert.match(fence('a'), /^```text\na\n```$/)
  assert.match(fence('x ```` y'), /^`````text\n/)
  assert.match(fence('`'), /^```text/)
})

test('멘션·이슈 참조는 코드블록 안에만 남는다', () => {
  const { body } = buildPost(row({ what: '@octocat ekaya-labs/x#1 ![img](http://a/b.png) <b>hi</b>' }))
  assert.match(body, /```text\n@octocat ekaya-labs\/x#1/)
})

test('제목 정리: 줄바꿈 제거·200자·접두·@ 전각', () => {
  assert.equal(cleanTitle('a\nb\r\nc'), '[폼] a b c')
  assert.equal(cleanTitle('hi @octo'), '[폼] hi ＠octo')
  assert.equal([...cleanTitle('가'.repeat(300))].length, '[폼] '.length + 200)
})

test('마스킹: 경로·IP·호스트·토큰·이메일', () => {
  assert.equal(maskSensitive('C:\\Users\\kim\\a.txt'), 'C:\\Users\\<user>\\a.txt')
  assert.equal(maskSensitive('/home/bob/x /Users/amy/y'), '/home/<user>/x /Users/<user>/y')
  assert.equal(maskSensitive('10.0.0.1:8080 0.2.6'), '<host> 0.2.6')
  assert.equal(maskSensitive('db.example.com:5432 localhost:3000'), '<host> <host>')
  assert.equal(maskSensitive('2026-07-27T10:30'), '2026-07-27T10:30')
  assert.equal(maskSensitive('tok abcdefghijklmnopqrstuvwxyz'), 'tok <redacted>')
  assert.equal(maskSensitive('me@x.io'), '<email>')
})

test('본문에도 마스킹이 걸린다', () => {
  const { body } = buildPost(row({ what: '경로 C:\\Users\\kim\\f 서버 192.168.0.5' }))
  assert.ok(body.includes('C:\\Users\\<user>\\f'))
  assert.ok(body.includes('<host>'))
  assert.ok(!body.includes('kim'))
})

test('칸별 4000자 상한', () => {
  const { body } = buildPost(row({ what: '가'.repeat(5000) }))
  assert.ok(body.includes('…(잘림)'))
  assert.ok(body.length < 5000)
})

test('보류: 이메일·전화번호·링크 3개·같은 제목 3건·필수 칸 비어 있음', () => {
  const none = new Map()
  assert.deepEqual(holdReasons(row(), none), [])
  assert.deepEqual(holdReasons(row({ what: '답장은 a@b.com 으로' }), none), ['contact-email'])
  assert.deepEqual(holdReasons(row({ what: '010-1234-5678 로 연락' }), none), ['contact-phone'])
  assert.deepEqual(holdReasons(row({ what: '01012345678' }), none), ['contact-phone'])
  assert.deepEqual(holdReasons(row({ what: 'http://a http://b http://c' }), none), ['links'])
  assert.deepEqual(holdReasons(row({ what: 'http://a http://b' }), none), [])
  assert.deepEqual(holdReasons(row({ title: 'x' }), new Map([['x', 3]])), ['repeated-title'])
  assert.deepEqual(holdReasons(row({ what: '' }), none), ['incomplete'])
  assert.deepEqual(holdReasons(row({ kind: '기타' }), none), ['unknown-kind'])
  // 버전 문자열·타임스탬프는 전화번호가 아니다
  assert.deepEqual(holdReasons(row({ what: 'v0.16.6 2026-10-19 13:00' }), none), [])
})

test('행선지와 라벨', () => {
  assert.deepEqual(pick(buildPost(row())), ['issue', ['type:bug', 'via:form']])
  assert.deepEqual(pick(buildPost(row({ kind: '기능 제안' }))), ['issue', ['type:enhancement', 'via:form']])
  assert.deepEqual(pick(buildPost(row({ kind: '비정상 종료' }))), ['issue', ['type:bug', 'crash', 'via:form']])
  const q = buildPost(row({ kind: '질문' }))
  assert.deepEqual(pick(q), ['discussion', []])
  assert.ok(q.body.startsWith('> 폼으로 받은 질문'))
})
const pick = (p) => [p.target, p.labels]

test('표식은 본문 끝줄만 인정한다 — 사용자 칸 안의 위조는 무시', () => {
  const p = buildPost(row({ what: '<!-- ekaya-form:0123456789abcdef -->' }))
  assert.equal(markerOf(p.body), p.hash)
  assert.equal(markerOf('x\n<!-- ekaya-form:0123456789abcdef -->\n끝'), null)
})

test('plan: 완료·버림은 건너뛰고 승인은 보류를 풀되 마스킹은 거친다', () => {
  const done = row({ title: '완료됨' })
  const held = row({ title: '보류됨', what: 'a@b.com' })
  const approved = row({ title: '승인됨', what: 'a@b.com', status: '승인' })
  const dropped = row({ title: '버림', what: 'a@b.com', status: '버림' })
  const ok = row({ title: '정상' })
  const res = plan([done, held, approved, dropped, ok], new Set([rowHash(done)]))
  assert.deepEqual(res.map((r) => r.action), ['skip', 'hold', 'post', 'skip', 'post'])
  assert.equal(res[1].reason, 'contact-email')
  assert.ok(!res[2].post.body.includes('a@b.com'))
  assert.ok(res[2].post.body.includes('<email>'))
})

test('승인해도 종류 불명·필수 칸 누락은 등록하지 않는다', () => {
  const res = plan([row({ kind: '기타', status: '승인' }), row({ what: '', title: 'y', status: '승인' })], new Set())
  assert.deepEqual(res.map((r) => r.action), ['hold', 'hold'])
})

test('같은 제목 3건은 전부 보류', () => {
  const rows = [1, 2, 3].map((n) => row({ title: '스팸', what: `내용${n}` }))
  assert.deepEqual(plan(rows, new Set()).map((r) => r.action), ['hold', 'hold', 'hold'])
})
