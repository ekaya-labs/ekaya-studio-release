/**
 * 구글 폼 응답 시트 → 이슈/Discussions 등록 (feedback-sync.yml이 부른다).
 *
 * 의존성 없음 — Node 내장(crypto·fetch)으로 서비스 계정 JWT 서명과 REST/GraphQL 호출을 한다.
 * 변환 규칙은 transform.mjs(순수 함수, 단위 테스트).
 *
 * **이 레포는 public이라 로그를 누구나 본다.** 행 내용·제목·오류 응답 본문을 찍지 않는다.
 * 찍는 것: 건수, 해시, 이슈 번호, 오류 종류(이름·HTTP 상태)뿐.
 */
import { createSign } from 'node:crypto'
import { markerOf, parseRows, plan } from './transform.mjs'

const MAX_POSTS_PER_RUN = 5
const API = 'https://api.github.com'

const env = (name) => {
  const v = process.env[name]
  if (!v) throw new Error(`env-missing:${name}`)
  return v
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** 서비스 계정 JSON → 읽기 전용 Sheets 액세스 토큰. */
async function sheetsToken(sa) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${b64url(sig)}`,
    }),
  })
  if (!res.ok) throw new Error(`google-token:${res.status}`)
  return (await res.json()).access_token
}

async function readSheet(token, sheetId, tab) {
  const range = encodeURIComponent(`'${tab}'`)
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`sheets-read:${res.status}`)
  return (await res.json()).values ?? []
}

const gh = (token) => async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  if (!res.ok) throw new Error(`github:${init.method ?? 'GET'}:${res.status}`)
  return res.json()
}

async function graphql(token, query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`github-graphql:${res.status}`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(`github-graphql:${json.errors[0].type ?? 'error'}`)
  return json.data
}

/** 이미 등록된 해시 — 이슈·Discussions 본문 끝 표식. **이슈 자체가 상태 기록**이다(SPEC §3.5). */
async function knownHashes(request, token, owner, repo) {
  const known = new Set()
  for (let page = 1; page <= 20; page++) {
    const items = await request(`/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`)
    for (const it of items) {
      const h = markerOf(it.body)
      if (h) known.add(h)
    }
    if (items.length < 100) break
  }
  let after = null
  for (let i = 0; i < 20; i++) {
    const data = await graphql(token, `query($o:String!,$r:String!,$a:String){
      repository(owner:$o,name:$r){discussions(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{body}}}}`,
    { o: owner, r: repo, a: after })
    const d = data.repository.discussions
    for (const n of d.nodes) {
      const h = markerOf(n.body)
      if (h) known.add(h)
    }
    if (!d.pageInfo.hasNextPage) break
    after = d.pageInfo.endCursor
  }
  return known
}

async function main() {
  const sa = JSON.parse(env('EKAYA_FEEDBACK_SHEETS_SA'))
  // 시크릿은 Actions가 가리지만, 파싱한 키 줄이 다시 찍혀도 가려지게 한 번 더 건다.
  for (const line of String(sa.private_key ?? '').split('\n')) if (line.length > 20) console.log(`::add-mask::${line}`)
  const ghToken = env('GITHUB_TOKEN')
  const [owner, repo] = env('GITHUB_REPOSITORY').split('/')
  const tab = process.env.EKAYA_FEEDBACK_SHEET_TAB || '설문지 응답 1'

  const values = await readSheet(await sheetsToken(sa), env('EKAYA_FEEDBACK_SHEET_ID'), tab)
  const rows = parseRows(values)
  const request = gh(ghToken)
  const known = await knownHashes(request, ghToken, owner, repo)
  const items = plan(rows, known)

  const existing = new Set((await request(`/repos/${owner}/${repo}/labels?per_page=100`)).map((l) => l.name))
  let category = null
  const posted = []
  let held = 0
  let capped = false

  for (const it of items) {
    if (it.action === 'hold') {
      held++
      console.log(`hold ${it.hash} ${it.reason}`)
      continue
    }
    if (it.action !== 'post') continue
    if (posted.length >= MAX_POSTS_PER_RUN) {
      capped = true
      continue
    }
    const p = it.post
    if (p.target === 'issue') {
      const labels = p.labels.filter((l) => existing.has(l))
      const issue = await request(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: p.title, body: p.body, labels }),
      })
      posted.push(`issue#${issue.number}`)
      console.log(`posted ${it.hash} issue#${issue.number}`)
    } else {
      category ??= await qaCategory(ghToken, owner, repo)
      const data = await graphql(ghToken, `mutation($r:ID!,$c:ID!,$t:String!,$b:String!){
        createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){discussion{number}}}`,
      { r: category.repoId, c: category.id, t: p.title, b: p.body })
      const n = data.createDiscussion.discussion.number
      posted.push(`discussion#${n}`)
      console.log(`posted ${it.hash} discussion#${n}`)
    }
  }

  const skipped = items.filter((i) => i.action === 'skip').length
  console.log(`rows=${rows.length} posted=${posted.length} held=${held} skipped=${skipped}${capped ? ' cap-reached' : ''}`)
}

async function qaCategory(token, owner, repo) {
  const data = await graphql(token, `query($o:String!,$r:String!){
    repository(owner:$o,name:$r){id discussionCategories(first:20){nodes{id name}}}}`, { o: owner, r: repo })
  const cat = data.repository.discussionCategories.nodes.find((c) => c.name === 'Q&A')
  if (!cat) throw new Error('discussion-category-missing')
  return { id: cat.id, repoId: data.repository.id }
}

main().catch((e) => {
  // 메시지 원문에 응답 본문이 섞이지 않도록 우리가 만든 코드 문자열만 찍는다.
  const msg = String(e?.message ?? '')
  console.log(`::error::feedback-sync failed (${/^[a-z0-9:-]+(:\w+)*$/i.test(msg) ? msg : e?.name ?? 'Error'})`)
  process.exit(1)
})
