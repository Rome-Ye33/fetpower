// 维护模式（数据库 39）：管理员维护系统时，除管理员以外的人登录了也只看到“系统维护中”。
// 45 起开始、结束维护时给大家发邮件：管理员读状态时多三项（开关、会发给几个人、这一次的邮件发得怎么样），开关用 setNotify 改。
// 真正挡人的是数据库：每个请求先过总闸（maintenance_gate），维护期间别人的请求一律回 423。
// 这里只管：读状态；登录的非管理员页面开着时最多每 5 秒确认一次（别的请求刚成功过就不另外查，切到后台不查），
// 维护一开始换成维护提示页，一结束整页刷新（顺便换上新版本）；管理员的开关和每页顶上的提示；登录页的提示。
// 读不到状态（网络、数据库还没装 39）就当没在维护，照常用。
import { Spin } from 'antd'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from './auth'
import { lastApiOkAt, MAINT_EVENT, supabase } from './supabase'

/** 这一次维护的通知邮件发得怎么样（45，只有管理员读得到）：维护开着时是这次开始的，关着时是上次结束的 */
export type MaintMail = {
  event: 'start' | 'end'
  /** 开始 / 结束的时间 */
  at: string | null
  total: number
  sent: number
  /** 还没发（等着发、正在发、等重试） */
  waiting: number
  failed: number
  /** 不发了（开关关了、维护已经结束了……） */
  skipped: number
  /** 没发出去的原因（数据库或发信服务器给的） */
  error: string | null
}

export type MaintStatus = {
  active: boolean
  /** 管理员写给大家的说明 */
  note: string | null
  /** 开始时间 */
  since: string | null
  /** 现在登录的这个账号被挡在外面 */
  blocked: boolean
  /** 这次读状态的请求过了数据库的总闸（null = 不知道，比如读不到） */
  gate: boolean | null
  /** 开始、结束维护时发不发邮件（45，只有管理员读得到；null = 不知道：不是管理员、数据库还没装 45） */
  notify: boolean | null
  /** 现在开始维护的话会发给几个人（除管理员以外开通了的账号） */
  mailTo: number | null
  mail: MaintMail | null
  /** 邮件那部分读不到时数据库给的原因（维护本身照常） */
  mailError: string | null
}

type MaintState = MaintStatus & {
  /** 现在这个账号（或没登录）的状态读过了 */
  ready: boolean
  /** 上一次读状态出错了（照常放行；管理员的开关上提示读不到） */
  failed: boolean
  refresh: () => Promise<MaintStatus | null>
  /** 管理员开始 / 结束维护；开着时再开始一次 = 只改说明。出错时抛出 */
  set: (active: boolean, note?: string | null) => Promise<void>
  /** 管理员开 / 关维护的邮件通知（45）。出错时抛出 */
  setNotify: (on: boolean) => Promise<void>
}

const MAIL_OFF = { notify: null, mailTo: null, mail: null, mailError: null }
const OFF: MaintStatus = { active: false, note: null, since: null, blocked: false, gate: null, ...MAIL_OFF }
/**
 * 登录的非管理员（包括已经被挡在外面的）多久确认一次维护开没开、结束没结束（Rome 2026-11-15：5 秒内换成维护页）。
 * 只是一行表按主键读一下；这段时间里别的请求成功过（也过了总闸）就不另外查；窗口在后台时不查
 */
const POLL_MS = 5_000
/** 读不到状态（网络、数据库忙、还没装 39）时越隔越久再试（10、20、40 秒……），最多 1 分钟一次：数据库忙的时候别让大家还每 5 秒来一下 */
const MAX_GAP_MS = 60_000
/** 两次因为请求被拒（423）去读状态，至少隔这么久 */
const HIT_GAP_MS = 1_000
/** 管理员切回窗口时，离上次读不到这么久就不重读 */
const ADMIN_FOCUS_GAP_MS = 60_000

type RpcError = { message?: string; code?: string; details?: string | null; hint?: string | null } | null

/** 总闸拒绝时的报错：code MAINT、hint maintenance、details 里是 {note, since} */
export function isMaintError(e: RpcError | undefined, status?: number): boolean {
  return status === 423 || e?.code === 'MAINT' || e?.hint === 'maintenance'
}

function fromGateError(e: RpcError): MaintStatus {
  let note: string | null = null
  let since: string | null = null
  try {
    const d = JSON.parse(e?.details ?? 'null') as { note?: string | null; since?: string | null } | null
    note = d?.note ?? null
    since = d?.since ?? null
  } catch {
    // 说明读不出来就不显示
  }
  return { active: true, note, since, blocked: true, gate: true, ...MAIL_OFF }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function mailFrom(v: unknown): MaintMail | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const d = v as Record<string, unknown>
  if (d.event !== 'start' && d.event !== 'end') return null
  return {
    event: d.event,
    at: str(d.at),
    total: num(d.total) ?? 0,
    sent: num(d.sent) ?? 0,
    waiting: num(d.waiting) ?? 0,
    failed: num(d.failed) ?? 0,
    skipped: num(d.skipped) ?? 0,
    error: str(d.error),
  }
}

function fromData(data: unknown): MaintStatus {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return OFF
  const d = data as Record<string, unknown>
  return {
    active: d.active === true,
    note: str(d.note),
    since: str(d.since),
    blocked: d.blocked === true,
    gate: typeof d.gate === 'boolean' ? d.gate : null,
    notify: typeof d.notify === 'boolean' ? d.notify : null,
    mailTo: num(d.mail_to),
    mail: mailFrom(d.mail),
    mailError: str(d.mail_error),
  }
}

const sameMail = (a: MaintMail | null, b: MaintMail | null) =>
  a === b ||
  (!!a && !!b && a.event === b.event && a.at === b.at && a.total === b.total && a.sent === b.sent && a.waiting === b.waiting &&
    a.failed === b.failed && a.skipped === b.skipped && a.error === b.error)

const sameStatus = (a: MaintStatus, b: MaintStatus) =>
  a.active === b.active && a.note === b.note && a.since === b.since && a.blocked === b.blocked && a.gate === b.gate &&
  a.notify === b.notify && a.mailTo === b.mailTo && a.mailError === b.mailError && sameMail(a.mail, b.mail)

const Ctx = createContext<MaintState | null>(null)

export function MaintenanceProvider({ children }: { children: ReactNode }) {
  const { session, loading, isAdmin } = useAuth()
  const uid = session?.user.id ?? null
  // 刚打开网页时先等登录信息读出来（有没有登录），免得先按“没登录”读一次、登录信息到了再读一次
  const authKnown = !!session || !loading
  const [status, setStatus] = useState<MaintStatus>(OFF)
  /** 状态是替哪个账号读的（'' = 没登录）；undefined = 还没读过 */
  const [readFor, setReadFor] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  /** 现在登录的是谁（读状态时比对：读的时候换了账号就作废） */
  const uidRef = useRef(uid)
  const blockedRef = useRef(false)
  const lastRead = useRef(0)
  /** 上次读到的 gate：总闸真的装上了，别的请求成功才能当作“没被挡”的证明 */
  const gateOn = useRef(false)
  /** 接连读不到几次了（读到了就清零） */
  const fails = useRef(0)
  const running = useRef<{ uid: string; job: Promise<MaintStatus | null> } | null>(null)

  const refresh = useCallback(async (): Promise<MaintStatus | null> => {
    const forUid = uidRef.current ?? ''
    // 同一个账号正在读：等那一次的结果；换了账号就另读一次
    if (running.current?.uid === forUid) return running.current.job
    const job = (async () => {
      lastRead.current = Date.now()
      const { data, error, status: http } = await supabase.rpc('maintenance_status')
      if ((uidRef.current ?? '') !== forUid) return null // 读的时候换了账号：作废，换号那边会再读
      let next: MaintStatus | null
      if (error && isMaintError(error, http)) next = fromGateError(error)
      else if (error) next = null
      else next = fromData(data)
      if (!next) {
        // 读不到：已经被挡着的照旧挡着（别因为一次网络问题放进去又挡出来），其余的当没在维护
        fails.current += 1
        setFailed(true)
        setReadFor(forUid)
        return null
      }
      fails.current = 0
      setFailed(false)
      // 被挡着的人等到维护结束：整页刷新，重新读资料、换上可能刚上线的新版本
      if (blockedRef.current && !next.blocked && forUid) {
        window.location.reload()
        return next
      }
      blockedRef.current = next.blocked && !!forUid
      gateOn.current = next.gate === true
      // 没变就不换对象，免得每 5 秒让用到维护状态的地方都重画一遍
      setStatus((cur) => (sameStatus(cur, next) ? cur : next))
      setReadFor(forUid)
      return next
    })()
    const mine = { uid: forUid, job }
    running.current = mine
    try {
      return await job
    } finally {
      if (running.current === mine) running.current = null
    }
  }, [])

  // 登录、退出、换账号：重新读（被不被挡要看是谁）
  useEffect(() => {
    uidRef.current = uid
    if (!authKnown) return
    blockedRef.current = false
    void refresh()
  }, [uid, authKnown, refresh])

  // 网站别的请求被总闸拒绝了（维护刚开始）：读状态，换成维护提示页。
  // 一下子被拒好几个只读一次；离上次读不到 1 秒的，等到 1 秒再读（不能丢掉，否则要等下一次确认才发现）
  useEffect(() => {
    let timer = 0
    const onHit = () => {
      if (blockedRef.current || timer) return
      const wait = Math.max(0, HIT_GAP_MS - (Date.now() - lastRead.current))
      timer = window.setTimeout(() => {
        timer = 0
        if (!blockedRef.current) void refresh()
      }, wait)
    }
    window.addEventListener(MAINT_EVENT, onHit)
    return () => {
      window.removeEventListener(MAINT_EVENT, onHit)
      window.clearTimeout(timer)
    }
  }, [refresh])

  const blocked = status.blocked && readFor === (uid ?? '') && !!uid

  // 登录的非管理员（包括已经被挡在外面的）：页面开着时最多每 5 秒确认一次。网站别的请求刚成功过（说明那一刻没被总闸挡）
  // 就往后推，不另外查；窗口在后台时停下，切回来马上确认一次。维护开始 → 换成维护提示页；结束 → 整页刷新回来
  const watch = !!uid && !loading && !isAdmin
  useEffect(() => {
    if (!watch) return
    let timer = 0
    let stopped = false
    function arm(ms: number) {
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, ms)
    }
    const gap = () => Math.min(POLL_MS * 2 ** fails.current, MAX_GAP_MS)
    function tick() {
      if (stopped || document.hidden) return
      const since = Date.now() - Math.max(gateOn.current ? lastApiOkAt() : 0, lastRead.current)
      if (since < gap()) {
        arm(gap() - since)
        return
      }
      void refresh().finally(() => {
        if (!stopped) arm(gap())
      })
    }
    const onShow = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onShow)
    arm(POLL_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [watch, refresh])

  // 管理员：切回窗口时重读（在另一台设备上开始 / 结束了维护，这边顶上的提示跟着变）
  useEffect(() => {
    if (!isAdmin) return
    const onShow = () => {
      if (!document.hidden && Date.now() - lastRead.current >= ADMIN_FOCUS_GAP_MS) void refresh()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [isAdmin, refresh])

  const set = useCallback(async (active: boolean, note?: string | null) => {
    const { data, error } = await supabase.rpc('set_maintenance', { p_active: active, p_note: note?.trim() || undefined })
    if (error) throw error
    const next = fromData(data)
    // 开关是经 Data API 调的，也过了总闸：数据库说的 gate 照样可信
    setStatus(next)
    setFailed(false)
    setReadFor(uidRef.current ?? '')
  }, [])

  const setNotify = useCallback(async (on: boolean) => {
    const { data, error } = await supabase.rpc('set_maintenance_notify', { p_on: on })
    if (error) throw error
    setStatus(fromData(data))
    setFailed(false)
    setReadFor(uidRef.current ?? '')
  }, [])

  const value = useMemo<MaintState>(
    () => ({ ...status, blocked, ready: readFor === (uid ?? ''), failed, refresh, set, setNotify }),
    [status, blocked, readFor, uid, failed, refresh, set, setNotify],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMaintenance(): MaintState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useMaintenance must be used inside MaintenanceProvider')
  return ctx
}

/**
 * 包在网站外面：登录的人被挡在外面时整个换成维护提示页（里面的页面、菜单角标都不挂上，也就不再发请求）；
 * 刚登录、状态还没读到时先转圈，免得闪一下别的页面。
 */
export function MaintenanceGate({ blockedView, children }: { blockedView: ReactNode; children: ReactNode }) {
  const { session } = useAuth()
  const m = useMaintenance()
  if (session && !m.ready) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }
  if (session && m.blocked) return <>{blockedView}</>
  return <>{children}</>
}
