import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchAll, supabase } from './supabase'
import type { Account, ChequeBank, Customer, Nature, Salesperson } from './supabase'
import { useAuth } from './auth'
import type { ApprovalStep } from './flow'
import { tr } from './i18n'

/** 客户、业务员名单 */
export type People = { customers: Customer[]; salespersons: Salesperson[] }
type Ids = readonly (number | null | undefined)[]

// 下拉框用的基础资料：账户、款项性质、业务员、客户，还有提成单审批流的级别。登录后加载一次，改动后调用 reload。
//
// 客户、业务员别的标签页、别人也会新建（比如导车辆时自动建的），这个标签页登录时读的名单就旧了（2026-11-28 Rome
// 录支票：选的车是刚导进来的客户的，客户框里显示不出来，手打名字新建又报「这个客户名称已经存在」）。所以：
// 用到的 id 名单里没有时 ensureKnown 重新读；按名字找客户、打开客户下拉时 refreshPeople 读最新的。
type RefData = {
  loaded: boolean
  accounts: Account[]
  natures: Nature[]
  salespersons: Salesperson[]
  customers: Customer[]
  /** 支票银行（客户开票的银行），在基础资料里维护 */
  chequeBanks: ChequeBank[]
  /** 提成单审批流的级别（含已经删掉的，旧单据显示名字用） */
  steps: ApprovalStep[]
  accountById: Map<number, Account>
  natureByName: Map<string, Nature>
  reload: () => Promise<void>
  /** 管理员改了审批流以后只重新读级别 */
  reloadSteps: () => Promise<void>
  /**
   * 重新读客户、业务员名单，返回最新的。
   * maxAgeMs 大于 0：这么久以内读过就不再读（正在读就等那一次）；
   * 不传：一定是这次调用以后读到的（正在读的那次可能是刚才的改动之前发出去的，就等它读完再读一次）。
   * 读失败保留原来的名单。
   */
  refreshPeople: (maxAgeMs?: number) => Promise<People>
  /** 这些客户 / 业务员 id 名单里没有（别人刚建的）就重新读一次名单。同一个 id 一分钟内只找一次（还找不到的多半是没权限看） */
  ensureKnown: (ids: { customers?: Ids; salespersons?: Ids }) => Promise<void>
}

const RefContext = createContext<RefData | null>(null)

export function RefDataProvider({ children }: { children: ReactNode }) {
  const { role } = useAuth()
  const [loaded, setLoaded] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [natures, setNatures] = useState<Nature[]>([])
  const [salespersons, setSalespersons] = useState<Salesperson[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [chequeBanks, setChequeBanks] = useState<ChequeBank[]>([])
  const [steps, setSteps] = useState<ApprovalStep[]>([])

  // 客户、业务员名单的最新值（回调里要马上用，不能等重新渲染）、上次读好的时间、正在读的和排着队的那一次、找过哪些 id
  const people = useRef<People>({ customers: [], salespersons: [] })
  const peopleAt = useRef(0)
  const running = useRef<Promise<People> | null>(null)
  const queued = useRef<Promise<People> | null>(null)
  const looked = useRef(new Map<string, number>())

  const loadPeople = useCallback(async (): Promise<People> => {
    try {
      const [c, s] = await Promise.all([
        fetchAll<Customer>(() => supabase.from('customers').select('*').order('name').order('id')),
        supabase.from('salespersons').select('*').order('name'),
      ])
      // 内容没变就还用原来的数组：用到名单的页面不用白白重算、重新查
      if (!c.error && JSON.stringify(c.data) !== JSON.stringify(people.current.customers)) {
        people.current = { ...people.current, customers: c.data }
        setCustomers(c.data)
      }
      if (!s.error && s.data && JSON.stringify(s.data) !== JSON.stringify(people.current.salespersons)) {
        people.current = { ...people.current, salespersons: s.data }
        setSalespersons(s.data)
      }
      if (!c.error && !s.error) peopleAt.current = Date.now()
    } catch {
      // 网断了：还用原来的名单
    }
    return people.current
  }, [])

  const startPeople = useCallback(() => {
    const p: Promise<People> = loadPeople().finally(() => {
      if (running.current === p) running.current = null
    })
    running.current = p
    return p
  }, [loadPeople])

  const refreshPeople = useCallback(
    (maxAgeMs = 0): Promise<People> => {
      if (maxAgeMs > 0) {
        if (running.current) return running.current
        if (Date.now() - peopleAt.current < maxAgeMs) return Promise.resolve(people.current)
      }
      if (!running.current) return startPeople()
      // 等正在读的那次读完再读一次；排着队的那一次大家共用
      if (!queued.current) {
        queued.current = running.current.then(() => {
          queued.current = null
          return startPeople()
        })
      }
      return queued.current
    },
    [startPeople],
  )

  const ensureKnown = useCallback(
    async ({ customers: cs = [], salespersons: ss = [] }: { customers?: Ids; salespersons?: Ids }) => {
      if (running.current) await running.current
      const now = Date.now()
      const haveC = new Set(people.current.customers.map((x) => x.id))
      const haveS = new Set(people.current.salespersons.map((x) => x.id))
      const miss = [
        ...cs.filter((id): id is number => id != null && id > 0 && !haveC.has(id)).map((id) => `c${id}`),
        ...ss.filter((id): id is number => id != null && id > 0 && !haveS.has(id)).map((id) => `s${id}`),
      ].filter((k) => now - (looked.current.get(k) ?? 0) > 60_000)
      if (!miss.length) return
      for (const k of miss) looked.current.set(k, now)
      await refreshPeople()
    },
    [refreshPeople],
  )

  const reloadSteps = useCallback(async () => {
    const { data } = await supabase.from('approval_steps').select('*').order('position').order('key')
    setSteps(data ?? [])
  }, [])

  const reload = useCallback(async () => {
    const [a, n, , b] = await Promise.all([
      supabase.from('bank_accounts').select('*').order('company').order('short_name'),
      supabase.from('payment_natures').select('*').order('sort_order'),
      refreshPeople(),
      supabase.from('cheque_banks').select('*').order('sort_order').order('name'),
      reloadSteps(),
    ])
    setAccounts(a.data ?? [])
    setNatures(n.data ?? [])
    setChequeBanks(b.data ?? [])
    setLoaded(true)
  }, [reloadSteps, refreshPeople])

  useEffect(() => {
    if (role) void reload()
  }, [role, reload])

  const value = useMemo<RefData>(
    () => ({
      loaded,
      accounts,
      natures,
      salespersons,
      customers,
      chequeBanks,
      steps,
      accountById: new Map(accounts.map((a) => [a.id, a])),
      natureByName: new Map(natures.map((n) => [n.name, n])),
      reload,
      reloadSteps,
      refreshPeople,
      ensureKnown,
    }),
    [loaded, accounts, natures, salespersons, customers, chequeBanks, steps, reload, reloadSteps, refreshPeople, ensureKnown],
  )
  return <RefContext.Provider value={value}>{children}</RefContext.Provider>
}

export function useRefData(): RefData {
  const ctx = useContext(RefContext)
  if (!ctx) throw new Error('useRefData must be used inside RefDataProvider')
  return ctx
}

/** 页面上用到的客户 / 业务员 id 名单里没有（别的标签页、别人刚建的）就重新读一次名单，好显示名字而不是一个数字 */
export function useEnsureKnown(customerIds: Ids = [], salespersonIds: Ids = []) {
  const { loaded, ensureKnown } = useRefData()
  const c = customerIds.filter((x) => x != null && x > 0).join(',')
  const s = salespersonIds.filter((x) => x != null && x > 0).join(',')
  useEffect(() => {
    if (!loaded || (!c && !s)) return
    const ids = (k: string) => (k ? k.split(',').map(Number) : [])
    void ensureKnown({ customers: ids(c), salespersons: ids(s) })
  }, [loaded, c, s, ensureKnown])
}

/** 打开对话框时把客户、业务员名单读成最新的（一分钟以内读过就不读）：按名字找客户、业务员的导入和表单用 */
export function useFreshPeople(open: boolean) {
  const { loaded, refreshPeople } = useRefData()
  useEffect(() => {
    if (open && loaded) void refreshPeople(60_000)
  }, [open, loaded, refreshPeople])
}

/** 某币种在某天（或之前最近一天）的汇率，没有返回 null */
export async function lookupRate(currency: string, date: string): Promise<number | null> {
  if (currency === 'USD') return 1
  const { data } = await supabase
    .from('fx_rates')
    .select('rate')
    .eq('currency', currency)
    .lte('rate_date', date)
    .order('rate_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? Number(data.rate) : null
}

/** 账户下拉选项：按公司分组 */
export function accountOptions(accounts: Account[], onlyActive = true) {
  const groups = new Map<string, { label: string; value: number }[]>()
  for (const a of accounts) {
    if (onlyActive && !a.active) continue
    const g = a.kind === 'bank' ? a.company || tr('其他') : tr('现金 / momo')
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push({ label: a.short_name, value: a.id })
  }
  return [...groups.entries()].map(([label, options]) => ({ label, options }))
}
