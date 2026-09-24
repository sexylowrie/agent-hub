import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paneFor, parsePanes, parsePpids } from '../../src/scanner/tmux.ts'

const PANES = 'dev:0.0\t500\tzsh\ndev:1.0\t600\tclaude\nwork:0.1\t700\tnode\n'
const PS = '  1     0\n 500     1\n 600     1\n 610   600\n 700     1\n 710   700\n 720   710\n 900     1\n'

test('parsePanes / parsePpids：tmux 与 ps 输出', () => {
  assert.deepEqual(parsePanes(PANES)[1], { target: 'dev:1.0', pid: 600, cmd: 'claude' })
  assert.equal(parsePanes('garbage\n').length, 0)
  assert.equal(parsePpids(PS).get(720), 710)
})

test('paneFor：沿父进程链找到前台是 agent 的 pane；前台是 shell 的 pane 不算', () => {
  const panes = parsePanes(PANES)
  const ppids = parsePpids(PS)
  assert.equal(paneFor(610, panes, ppids)?.target, 'dev:1.0')
  assert.equal(paneFor(720, panes, ppids)?.target, 'work:0.1')
  assert.equal(paneFor(900, panes, ppids), undefined)
  // pane 前台是 zsh（agent 已退出）：不注入
  assert.equal(paneFor(510, panes, new Map([[510, 500], [500, 1]])), undefined)
})
