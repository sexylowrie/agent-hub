import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { KeepAwake } from '../src/power.ts'

function fakeSpawn() {
  const calls: { cmd: string; args: string[]; killed: boolean }[] = []
  const fn = ((cmd: string, args: string[]) => {
    const p = Object.assign(new EventEmitter(), {
      kill() {
        rec.killed = true
        p.emit('exit')
        return true
      },
    })
    const rec = { cmd, args, killed: false }
    calls.push(rec)
    return p
  }) as any
  return { fn, calls }
}

test('KeepAwake：ac 模式启动即持有 caffeinate -s -w <pid>', () => {
  const { fn, calls } = fakeSpawn()
  const k = new KeepAwake('ac', fn, () => {})
  k.start()
  k.onBusyChange(0)
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [['caffeinate', '-s', '-w', String(process.pid)]])
  assert.equal(k.holding, true)
})

test('KeepAwake：turn 模式随轮次开关，不重复拉起', () => {
  const { fn, calls } = fakeSpawn()
  const k = new KeepAwake('turn', fn, () => {})
  k.start()
  assert.equal(calls.length, 0)
  k.onBusyChange(1)
  k.onBusyChange(2)
  assert.equal(calls.length, 1)
  k.onBusyChange(0)
  assert.equal(calls[0].killed, true)
  assert.equal(k.holding, false)
})

test('KeepAwake：off 模式什么都不做', () => {
  const { fn, calls } = fakeSpawn()
  const k = new KeepAwake('off', fn, () => {})
  k.start()
  k.onBusyChange(1)
  assert.equal(calls.length, 0)
})
