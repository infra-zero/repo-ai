/**
 * The dashboard page (#282): one file, no build step, no framework. Every
 * value from GitHub or a worker is set with `textContent`, never parsed as
 * HTML, so a hostile title is inert.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>repo-ai loop</title>
<style>
:root { --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#d7dce5; --dim:#7d8596; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --run:#58a6ff; --accent:#a371f7; }
@media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --panel:#fff; --line:#e3e6eb; --text:#1f2328; --dim:#6b7280; } }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace }
header { display:flex; gap:16px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap }
header h1 { font-size:15px; margin:0 }
main { padding:16px; display:grid; gap:16px; grid-template-columns:minmax(0,2fr) minmax(0,1fr) }
@media (max-width: 900px) { main { grid-template-columns:1fr } }
section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px }
h2 { font-size:13px; margin:0 0 10px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em }
.pill { display:inline-block; padding:1px 8px; border-radius:99px; border:1px solid var(--line); font-size:12px }
.ok { color:var(--ok) } .warn { color:var(--warn) } .bad { color:var(--bad) } .run { color:var(--run) } .dim { color:var(--dim) }
.counts { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px }
.card { border:1px solid var(--line); border-radius:6px; padding:8px 10px; margin:6px 0 }
.card .top { display:flex; gap:8px; justify-content:space-between }
.card a { color:inherit }
.pipe { color:var(--dim); font-size:12px; margin-top:2px }
.pipe b { color:var(--accent) }
table { width:100%; border-collapse:collapse } td,th { text-align:left; padding:4px 6px; border-top:1px solid var(--line); vertical-align:top }
th { color:var(--dim); font-weight:normal }
input,select,button { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:3px 6px }
button { cursor:pointer } button.primary { border-color:var(--accent) }
.feed div { padding:2px 0; border-top:1px solid var(--line) }
.full { grid-column:1 / -1 }
#err { color:var(--bad) }
</style>
</head>
<body>
<header><h1>repo-ai loop</h1><span id="status" class="dim"></span><span id="err"></span></header>
<main>
  <div id="boards"></div>
  <div>
    <section><h2>Agents</h2><div id="agents"></div></section>
    <section style="margin-top:16px"><h2>Activity</h2><div id="feed" class="feed"></div></section>
  </div>
  <section class="full"><h2>Setup</h2><div id="setup"></div></section>
</main>
<script>
const STAGES = ['blocked','merge-ready','changes','conflicts','fixing','review','wip','ready','holding']
const PIPE = ['ready','wip','review','fixing','merge-ready']
const REVIEW = { pass:['✓','ok'], running:['◌','run'], changes:['✗','bad'], pending:['·','dim'] }
const CI = { green:['CI ✓','ok'], red:['CI ✗','bad'], pending:['CI ◌','run'], none:['no CI','dim'] }
let state = null, draft = null, dirty = false

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)))
  return e
}
const ago = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd' }
const clock = (t) => new Date(t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
const safeUrl = (u) => /^https:\\/\\/github\\.com\\//.test(u) ? u : null

function card(it) {
  const stage = it.stage
  const pipe = PIPE.map((s) => s === stage ? el('b', null, '▶' + s) : s)
  const bits = []
  if (it.reviews) for (const arm of ['code','sec']) { const [g, c] = REVIEW[it.reviews[arm]]; bits.push(el('span', { class:c }, arm + ' ' + g)) }
  if (it.ci) { const [t, c] = CI[it.ci]; bits.push(el('span', { class:c }, t)) }
  if (it.merge && it.merge !== 'CLEAN') bits.push(el('span', { class:'warn' }, it.merge))
  if (it.dependabot) bits.push(el('span', { class:'dim' }, 'dependabot'))
  if (it.assignees.length) bits.push(el('span', { class:'dim' }, '→ ' + it.assignees.join(', ')))
  const href = safeUrl(it.url)
  return el('div', { class:'card' },
    el('div', { class:'top' },
      el('span', null, href ? el('a', { href, target:'_blank', rel:'noopener' }, '#' + it.number) : '#' + it.number, ' ', it.title),
      el('span', { class:'dim' }, (it.kind === 'pr' ? 'PR · ' : 'issue · ') + ago(it.ageMinutes * 60000))),
    PIPE.includes(stage) ? el('div', { class:'pipe' }, pipe.flatMap((p, i) => i ? [' ─ ', p] : [p])) : el('div', { class:'pipe' }, el('b', { class: stage === 'blocked' ? 'bad' : '' }, stage)),
    bits.length ? el('div', { class:'pipe' }, bits.flatMap((b, i) => i ? ['   ', b] : [b])) : null)
}

function boards() {
  const root = document.getElementById('boards'); root.replaceChildren()
  if (!state.repos.length) root.append(el('section', null, el('h2', null, 'Boards'), el('div', { class:'dim' }, 'No repos yet — add one under Setup.')))
  for (const r of state.repos) {
    const s = r.state
    const counts = STAGES.map((st) => [st, s ? s.board.filter((b) => b.stage === st).length : 0]).filter(([, n]) => n)
    root.append(el('section', { style:'margin-bottom:16px' },
      el('h2', null, r.repo, ' ', r.enabled ? '' : el('span', { class:'pill dim' }, 'paused')),
      el('div', { class:'counts' },
        s ? el('span', { class:'pill ' + (s.halt ? 'bad' : '') }, s.halt ? '⚠ ' + s.halt : s.summary || '…') : el('span', { class:'pill dim' }, 'not ticked yet'),
        counts.map(([st, n]) => el('span', { class:'pill' }, st + ' ' + n)),
        s && s.releaseGated ? el('span', { class:'pill dim' }, 'release-gated') : null,
        el('span', { class:'pill dim' }, 'next tick ' + clock(r.nextTick))),
      s ? s.board.map(card) : null,
      s && !s.board.length ? el('div', { class:'dim' }, 'Nothing in flight.') : null,
      s ? [...s.warnings.map((w) => el('div', { class:'warn' }, 'warn: ' + w)), ...s.errors.map((e) => el('div', { class:'bad' }, 'error: ' + e))] : null))
  }
}

function agents() {
  const root = document.getElementById('agents'); root.replaceChildren()
  const running = Object.fromEntries(state.tasks.filter((t) => t.state === 'running').map((t) => [t.id, t]))
  const queued = state.tasks.filter((t) => t.state === 'queued')
  if (!state.workers.length) root.append(el('div', { class:'dim' }, state.workerSecret ? 'No workers have connected. Start them with docker compose.' : 'REPO_AI_WORKER_SECRET is unset — workers cannot connect.'))
  root.append(el('table', null, state.workers.map((w) => {
    const t = w.task && running[w.task]
    return el('tr', null,
      el('td', null, el('span', { class: w.online ? 'ok' : 'bad' }, '● '), w.id, el('div', { class:'dim' }, w.role + (w.claudeAuth === false ? ' · no Claude credential' : ''))),
      el('td', null, t ? [el('span', { class:'run' }, t.repo + ' #' + t.number + ' ' + t.label), el('div', { class:'dim' }, ago(state.now - t.startedAt) + ' · ' + (t.progress || 'starting'))] : el('span', { class:'dim' }, 'idle')))
  })))
  root.append(el('div', { class:'dim', style:'margin-top:8px' },
    queued.length + ' queued · today ' + state.today.tasks + ' tasks, ' + Math.round(state.today.outputTokens / 1000) + 'k output tokens, $' + state.today.costUsd.toFixed(2)))
  for (const t of state.tasks.filter((x) => x.state === 'failed').slice(0, 5))
    root.append(el('div', { class:'bad' }, '✗ ' + t.repo + ' #' + t.number + ' ' + t.label + ': ' + (t.result && (t.result.error || t.result.summary) || 'failed')))
}

function feed() {
  const root = document.getElementById('feed')
  root.replaceChildren(...(state.events.length ? state.events.map((e) => el('div', null, el('span', { class:'dim' }, clock(e.t) + ' '), e.repo.split('/')[1] + (e.number ? ' #' + e.number : '') + ' ', e.what)) : [el('div', { class:'dim' }, 'Nothing yet.')]))
}

function setup() {
  const root = document.getElementById('setup')
  if (dirty) return
  draft = JSON.parse(JSON.stringify(state.config))
  const ids = [...new Set([...state.workers.map((w) => w.id), ...Object.keys(draft.workers)])]
  const repoInput = el('input', { placeholder:'owner/repo', size:30 })
  root.replaceChildren(
    state.app ? null : el('p', { class:'bad' }, 'No GitHub App credentials — set GITHUB_APP_ID and the private key in docker/.env, then restart.'),
    el('table', null,
      el('tr', null, el('th', null, 'repo'), el('th', null, 'enabled'), el('th', null, 'Dependabot → review'), el('th')),
      draft.repos.map((r, i) => el('tr', null,
        el('td', null, r.repo),
        el('td', null, el('input', { type:'checkbox', checked:r.enabled, onchange:(e) => { r.enabled = e.target.checked } })),
        el('td', null, el('input', { type:'checkbox', checked:r.dependabotAutoReview, onchange:(e) => { r.dependabotAutoReview = e.target.checked } })),
        el('td', null, el('button', { onclick:() => { draft.repos.splice(i, 1); save() } }, 'remove'))))),
    el('p', null, repoInput, ' ', el('button', { onclick:() => { const v = repoInput.value.trim(); if (v) { draft.repos.push({ repo:v, enabled:true, dependabotAutoReview:false }); save() } } }, 'add repo'),
      '   poll every ', el('input', { type:'number', min:60, value:draft.pollSeconds, style:'width:6em', onchange:(e) => { draft.pollSeconds = Number(e.target.value) } }), ' s'),
    el('table', null,
      el('tr', null, el('th', null, 'worker'), el('th', null, 'role'), el('th', null, 'repos (none ticked = all)')),
      ids.map((id) => {
        const w = draft.workers[id] || (draft.workers[id] = { role:'any', repos:[] })
        return el('tr', null, el('td', null, id),
          el('td', null, el('select', { onchange:(e) => { w.role = e.target.value } }, ['any','implementer','reviewer','fixer'].map((r) => el('option', { value:r, selected:w.role === r }, r)))),
          el('td', null, draft.repos.map((r) => el('label', { style:'margin-right:10px' }, el('input', { type:'checkbox', checked:w.repos.includes(r.repo), onchange:(e) => { w.repos = e.target.checked ? [...w.repos, r.repo] : w.repos.filter((x) => x !== r.repo) } }), ' ' + r.repo))))
      })),
    el('p', null, el('button', { class:'primary', onclick:save }, 'Save')))
}

async function save() {
  const res = await fetch('/api/config', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(draft) })
  const body = await res.json()
  document.getElementById('err').textContent = res.ok ? '' : body.error
  if (res.ok) { state = body; dirty = false; render() }
}

function render() {
  const live = state.workers.filter((w) => w.online).length
  document.getElementById('status').textContent = state.repos.length + ' repos · ' + live + '/' + state.workers.length + ' workers online · ' + state.tasks.filter((t) => t.state === 'running').length + ' running'
  boards(); agents(); feed(); setup()
}

async function poll() {
  try {
    const res = await fetch('/api/state')
    state = await res.json(); render()
  } catch (e) { document.getElementById('err').textContent = 'dashboard unreachable' }
}
for (const ev of ['change', 'input']) document.getElementById('setup').addEventListener(ev, () => { dirty = true })
poll(); setInterval(poll, 5000)
</script>
</body>
</html>
`
