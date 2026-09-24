import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionView } from '../../src/core/events.ts'
import { defaultOpenGroup, groupOf, groupSessions } from '../../web/src/util.ts'

const s = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id, vendor: 'claude', vendorSessionId: id, cwd: '/tmp', title: id, origin: 'cli',
  state: 'idle', resumable: true, archived: false, updatedAt: 0, ...patch,
})

test('groupOf：进行中的状态优先；可续聊要求空闲、可续接、未归档；其余进「其他」', () => {
  assert.equal(groupOf(s('a', { state: 'awaiting_approval', archived: true })), 'awaiting')
  assert.equal(groupOf(s('b', { state: 'running', resumable: false })), 'running')
  assert.equal(groupOf(s('c', { state: 'error' })), 'error')
  assert.equal(groupOf(s('d')), 'idle')
  assert.equal(groupOf(s('e', { archived: true })), 'other')
  assert.equal(groupOf(s('f', { resumable: false })), 'other')
  assert.equal(groupOf(s('g', { state: 'unknown' })), 'other')
})

test('groupSessions 按最近更新倒序；defaultOpenGroup 取第一个有会话的组', () => {
  const g = groupSessions([s('old', { vendorUpdatedAt: 1 }), s('new', { vendorUpdatedAt: 3 }), s('mid', { updatedAt: 2 }), s('x', { archived: true })])
  assert.deepEqual(g.idle.map((x) => x.id), ['new', 'mid', 'old'])
  assert.equal(defaultOpenGroup(g), 'idle')
  assert.equal(defaultOpenGroup(groupSessions([s('r', { state: 'running' }), s('a', { state: 'awaiting_approval' })])), 'awaiting')
  assert.equal(defaultOpenGroup(groupSessions([])), undefined)
})
