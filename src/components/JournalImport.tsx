import { DownloadOutlined, InboxOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Checkbox, Col, DatePicker, Drawer, InputNumber, Progress, Row, Segmented, Select, Space, Table, Tag, Typography, Upload } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { useAuth } from '../lib/auth'
import type { Json } from '../lib/database.types'
import { errorText } from '../lib/errors'
import { parseFlow, useFlow } from '../lib/flow'
import { money } from '../lib/format'
import { useT } from '../lib/i18n'
import { moduleColor, notifyJournalChanged, RECEIPT_MODULE, scopeOf, SCOPE_TITLE } from '../lib/journal'
import type { JournalScope } from '../lib/journal'
import {
  acctKey,
  autoAccount,
  findJournalHeaderRow,
  groupMoves,
  guessJournalMapping,
  hasAmountCol,
  itemPayload,
  itemReceiptPayload,
  J_FIELDS,
  J_TEMPLATE,
  matchModule,
  moveDate,
  resolveItems,
  rowRange,
} from '../lib/journalImport'
import type { ExistingEntry, JField, JItem, JMapping, JStatus, LineLite, LineState, SkipReason } from '../lib/journalImport'
import type { ExistingReceipt, Issue, Rate, VehicleLite } from '../lib/receiptImport'
import { useRefData } from '../lib/refdata'
import { notifySubmissionsChanged } from '../lib/submissions'
import { fetchAll, supabase } from '../lib/supabase'
import type { Account } from '../lib/supabase'

// 日记账批量导入：选 Excel（照《终端解款表》的格式）→ 对列 → 账户对照 → 预览（勾要导的）→ 一笔一笔存：
// 收付、账户互转调 save_cash_entry，和点「记一笔银行交易 / 记一笔现金」存的一样（银行流水已经导了的马上对上，没导的等流水）；
// 车款（设备回款）调 save_receipt 存成到账，和到账录入的批量导入一样走审批流，批完进车辆台账，也进日记账。
// 系统里已经有的默认不勾，同一个文件导两次不会重复。整理的规则见 lib/journalImport.ts。

type Filter = 'all' | 'new' | 'receipt' | 'exists' | 'error' | 'skip'
type Outcome = { key: number; rows: number[]; kind: JItem['kind']; id?: number; matched?: boolean; bank?: boolean; error?: string; approveError?: string }
type Summary = {
  entries: number
  transfers: number
  matched: number
  waiting: number
  receipts: number
  approved: number
  pending: number
  failed: Outcome[]
  approveFailed: Outcome[]
  stopped: boolean
}

const LABEL = new Map(J_FIELDS.map((f) => [f.key, f.label]))
const VEHICLE_COLS = 'id, vin, customer_id, customer_name, salesperson_id, salesperson_name, payment_method, received_usd, down_payment_usd, balance_usd, model'
const colName = (i: number) => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
const addDays = (d: string, k: number) => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10)
const CASH_MODULES = new Set(['现金存现', '现金存现-库马西', '银行取现'])
/** 只碰现金账户的几笔可以同时存几笔（不用对银行流水）；碰到银行账户、到账的一笔一笔来 */
const PARALLEL = 3

type Existing = { key: string; entries: ExistingEntry[]; lines: LineLite[]; receipts: ExistingReceipt[] }
const NOTHING: Existing = { key: '', entries: [], lines: [], receipts: [] }
type EntryRow = { id: number; entry_no: string; entry_date: string; account_id: number; direction: string; amount: number; module: string; peer_id: number | null; fee_of: number | null }
type LineRow = { id: number; account_id: number; line_date: string; amount_orig: number; entry_id: number | null; receipt_id: number | null; ignored: boolean }
type ReceiptRow = { id: number | null; receipt_no: string | null; account_id: number | null; receipt_date: string | null; amount_orig: number | null; bank_ref: string | null }

export default function JournalImport({ open, scope, onClose }: { open: boolean; scope: JournalScope; onClose: (changed: boolean) => void }) {
  const t = useT()
  const { message } = App.useApp()
  const { isAdmin, canEdit } = useAuth()
  const { accounts, accountById, customers, salespersons, natures } = useRefData()
  const rflow = useFlow('receipt')
  // 车款导成到账要「到账录入」能编辑；没有的跳过
  const carOk = canEdit('receipts')
  const [fileName, setFileName] = useState('')
  const [book, setBook] = useState<XLSX.WorkBook | null>(null)
  const [sheet, setSheet] = useState('')
  const [sheetRows, setSheetRows] = useState<unknown[][]>([])
  const [headerRow, setHeaderRow] = useState(1)
  const [mapping, setMapping] = useState<JMapping>({})
  // 账户对照：文件里的写法（大写）→ 系统账户；选了空的（undefined）= 这个账户不导
  const [acctPick, setAcctPick] = useState<Record<string, number | undefined>>({})
  // 现金存现、银行取现的另一边：币种 → 现金账户
  const [cashPick, setCashPick] = useState<Record<string, number | undefined>>({})
  const [range, setRange] = useState<[string, string] | null>(null)
  // 车、汇率（文件里有车款时读一次）；系统里已有的收支、流水、到账（key 对得上才算读好了）
  const [cars, setCars] = useState<{ vehicles: Map<string, VehicleLite>; rates: Rate[] } | null>(null)
  const [found, setFound] = useState<Existing | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  // 这次导进去的：哪一笔（key）存成了哪一笔收支（id，互转是转出那边）/ 哪张到账。导完查重时先认回自己那笔
  const [created, setCreated] = useState<Map<number, number>>(new Map())
  const [createdR, setCreatedR] = useState<Map<number, number>>(new Map())
  // 勾选：用户点过的记在这里，没点过的按默认（能导入的勾上；系统里已有、很可能记过了的不勾）
  const [pick, setPick] = useState<Record<number, boolean>>({})
  const [filter, setFilter] = useState<Filter>('all')
  const [direct, setDirect] = useState(false)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const changed = useRef<{ journal: boolean; receipts: boolean }>({ journal: false, receipts: false })
  const stop = useRef(false)

  const scopeAccounts = useMemo(() => accounts.filter((a) => scopeOf(a) === scope), [accounts, scope])
  const cashAccounts = useMemo(() => accounts.filter((a) => a.kind !== 'bank' && a.active), [accounts])

  const close = () => {
    if (importing) return
    const c = changed.current
    changed.current = { journal: false, receipts: false }
    setFileName('')
    setBook(null)
    setSheet('')
    setSheetRows([])
    setMapping({})
    setAcctPick({})
    setCashPick({})
    setRange(null)
    setPick({})
    setCreated(new Map())
    setCreatedR(new Map())
    setFilter('all')
    setDirect(false)
    setSummary(null)
    setProgress(null)
    setCars(null)
    setFound(null)
    onClose(c.journal || c.receipts)
  }

  // ---------- 读文件 ----------
  const sheetToRows = (wb: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '' })
  const applyHeaderRow = (rows: unknown[][], hr: number) => {
    setHeaderRow(hr)
    setMapping(guessJournalMapping((rows[hr - 1] ?? []).map((c) => String(c ?? ''))))
  }
  const loadSheet = (wb: XLSX.WorkBook, name: string) => {
    const rows = sheetToRows(wb, name)
    setSheet(name)
    setSheetRows(rows)
    setAcctPick({})
    setRange(null)
    setPick({})
    setCreated(new Map())
    setCreatedR(new Map())
    setSummary(null)
    setProgress(null)
    applyHeaderRow(rows, findJournalHeaderRow(rows) || 1)
  }
  const readFile = async (file: File) => {
    let wb: XLSX.WorkBook
    try {
      // raw：CSV 里的 08/11/2026 原样留着，按“日在前”认；Excel 里的日期是数字，另外换算
      wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true, cellDates: false })
    } catch {
      message.error(t('读不了这个文件。有密码的 Excel 请先另存一份没有密码的'))
      return
    }
    setBook(wb)
    setFileName(file.name)
    // 解款表一个文件几张表：银行日记账先挑银行存款那张，现金日记账先挑现金那张
    const named = wb.SheetNames.filter((n) => findJournalHeaderRow(sheetToRows(wb, n)) > 0)
    const prefer = named.find((n) => (scope === 'cash' ? /现金|cash/i : /银行|bank/i).test(n))
    loadSheet(wb, prefer ?? named[0] ?? wb.SheetNames[0])
  }

  const downloadTemplate = () => {
    const head = J_TEMPLATE.map((k) => t(LABEL.get(k) ?? k))
    const ws = XLSX.utils.aoa_to_sheet([head])
    const widths: Partial<Record<JField, number>> = { date: 12, module: 12, counterparty: 22, summary: 40, account: 26, vin: 20, nature: 10, note: 16 }
    ws['!cols'] = J_TEMPLATE.map((k) => ({ wch: widths[k] ?? 11 }))
    const row = (v: Partial<Record<JField, string | number>>) => J_TEMPLATE.map((k) => v[k] ?? '')
    const bank = scope === 'bank'
    const examples = bank
      ? [
          row({ date: '2026-11-03', module: t('设备回款'), counterparty: 'ABC MOTORS LTD', summary: 'ABC MOTORS LTD 6X4 120,000GHS/12=$10,000 LZZEXAMPLE0000001', fx_rate: 12, usd: 10000, amount: 120000, account: 'FET AUTO GCB GHS-7773', nature: t('分期款') }),
          row({ date: '2026-11-04', module: t('手续费'), counterparty: 'GCB BANK', summary: t('银行手续费'), amount: -35, account: 'FET AUTO GCB GHS-7773' }),
          row({ date: '2026-11-05', module: t('配件回款'), counterparty: 'XYZ BUILDING LTD', summary: t('收配件款和维修费'), split: 8000, amount: 10000, account: 'FET AUTO ECO GHS-8651' }),
          row({ module: t('维修收入'), counterparty: 'XYZ BUILDING LTD', summary: t('维修费'), split: 2000 }),
          row({ date: '2026-11-06', module: t('资金拨付'), summary: t('资金拨付【8651户转7773户】'), amount: -50000, account: 'FET AUTO ECO GHS-8651' }),
          row({ date: '2026-11-06', module: t('资金拨付'), summary: t('资金拨付【8651户转7773户】'), amount: 50000, account: 'FET AUTO GCB GHS-7773' }),
          row({ date: '2026-11-07', module: t('现金存现'), summary: t('现金存现'), amount: 30000, account: 'FET AUTO GCB GHS-7773' }),
        ]
      : [
          row({ date: '2026-11-03', module: t('设备回款'), counterparty: 'ABC MOTORS LTD', summary: 'ABC MOTORS LTD $2,000 (CASH) LZZEXAMPLE0000002', fx_rate: 1, usd: 2000, amount: 2000, account: 'Cash USD', nature: t('全款尾款') }),
          row({ date: '2026-11-04', module: t('其他费用'), counterparty: 'KOFI STATIONERY', summary: t('买办公用品'), amount: -350, account: 'Cash GHS' }),
          row({ date: '2026-11-05', module: t('配件回款'), counterparty: 'XYZ BUILDING LTD', summary: t('收配件款和维修费'), split: 1200, amount: 1500, account: 'momo' }),
          row({ module: t('维修收入'), counterparty: 'XYZ BUILDING LTD', summary: t('维修费'), split: 300 }),
          row({ date: '2026-11-07', module: t('现金存现'), summary: t('现金存现【7773户】'), amount: -30000, account: 'Cash GHS' }),
        ]
    const help = XLSX.utils.aoa_to_sheet([
      [t('一行一笔钱，必填：日期、业务模块、账户、收/支款金额（收为正、付为负；也可以分「收入」「支出」两列，都写正数）。')],
      [t('一笔钱里有几种业务：第一行写收/支款金额，下面几行不写收/支款金额，只写业务模块、客户、摘要、拆分金额，拆分金额加起来等于这笔钱。')],
      [
        bank
          ? t('账户之间的钱（资金拨付、货币兑换、现金存现、银行取现）：转出写负数、转入写正数，两边各一行；只有一边的，摘要里写清两个账户，如 资金拨付【8651户转7773户】。现金存现、银行取现只写银行这一边，另一边记到导入时选的现金账户。')
          : t('账户之间的钱：转出写负数、转入写正数，两边各一行。现金存现、银行取现先在银行日记账里导银行那一边，这里就认成系统里已有；或者摘要里写上银行账户的后 4 位，如 现金存现【7773户】。'),
      ],
      [t('车款（业务模块写设备回款）导成到账，走到账审批流，批完进车辆台账：大架号写在大架号列或者摘要里，没写的或者系统里没有的先记在客户名下（大架号未锁定）。GHS 账户要写汇率（或者 USD金额），不写就用基础资料里的汇率。')],
      [t('系统里已有的（同账户、同一天、同方向、同金额；到账是同账户、同日期、同金额）默认不导，同一个文件导两次不会重复。')],
      [t('不导的：没写业务模块的、账户选了不导的、账户停用了的、在期初日期之前的。')],
      [],
      [t('示例（导入时不读这张表）：')],
      head,
      ...examples,
    ])
    help['!cols'] = J_TEMPLATE.map((k) => ({ wch: widths[k] ?? 11 }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, t(SCOPE_TITLE[scope]))
    XLSX.utils.book_append_sheet(wb, help, t('说明'))
    XLSX.writeFile(wb, `${t('日记账批量导入模板')}.xlsx`)
  }

  // ---------- 整理成一笔笔钱 ----------
  const headers = useMemo(() => (sheetRows[headerRow - 1] ?? []).map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()), [sheetRows, headerRow])
  const amountOk = hasAmountCol(mapping)
  const missingRequired = J_FIELDS.filter((f) => f.required && mapping[f.key] === undefined)
  const canGroup = sheetRows.length > 0 && amountOk && !missingRequired.length
  const grouped = useMemo(() => (canGroup ? groupMoves(sheetRows, headerRow, mapping) : { moves: [], ignored: [] }), [canGroup, sheetRows, headerRow, mapping])
  const needCars = useMemo(() => carOk && grouped.moves.some((m) => m.parts.some((p) => matchModule(p.module) === RECEIPT_MODULE)), [carOk, grouped])

  // 文件里出现的账户写法，和自动对上的系统账户（停用了的也对，对上了算「账户停用」不导）
  const acctGroups = useMemo(() => {
    const m = new Map<string, { key: string; text: string; count: number; auto?: number }>()
    for (const mv of grouped.moves) {
      const k = acctKey(mv.account)
      if (!k) continue
      const g = m.get(k) ?? { key: k, text: mv.account, count: 0, auto: autoAccount(mv.account, scope, accounts) }
      g.count++
      m.set(k, g)
    }
    return [...m.values()].sort((a, b) => b.count - a.count)
  }, [grouped, scope, accounts])
  const autoAcct = useMemo(() => new Map(acctGroups.map((g) => [g.key, g.auto])), [acctGroups])
  const accountFor = useMemo(
    () =>
      (text: string): number | 'skip' | undefined => {
        const k = acctKey(text)
        if (!k) return undefined
        return (k in acctPick ? acctPick[k] : autoAcct.get(k)) ?? 'skip'
      },
    [acctPick, autoAcct],
  )
  // 现金存现、银行取现：哪几个币种的银行账户上有，另一边记到哪个现金账户（默认这个币种唯一的一个现金账户）
  const cashNeed = useMemo(() => {
    if (scope !== 'bank') return []
    const cur = new Set<string>()
    for (const mv of grouped.moves) {
      const id = accountFor(mv.account)
      const a = typeof id === 'number' ? accountById.get(id) : undefined
      if (a?.kind === 'bank' && mv.parts.some((p) => CASH_MODULES.has(matchModule(p.module) ?? ''))) cur.add(a.currency)
    }
    return [...cur].sort()
  }, [scope, grouped, accountFor, accountById])
  const cashDefault = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of new Set(cashAccounts.map((a) => a.currency))) {
      const hits = cashAccounts.filter((a) => a.kind === 'cash' && a.currency === c)
      if (hits.length === 1) m.set(c, hits[0].id)
    }
    return m
  }, [cashAccounts])
  const cashFor = useMemo(() => (cur: string) => (cur in cashPick ? cashPick[cur] : cashDefault.get(cur)), [cashPick, cashDefault])

  // 文件里的日期段（日期空着的用摘要里写的）
  const fileRange = useMemo(() => {
    let lo = ''
    let hi = ''
    for (const mv of grouped.moves) {
      const d = moveDate(mv)
      if (!d) continue
      if (!lo || d < lo) lo = d
      if (!hi || d > hi) hi = d
    }
    return lo ? ([lo, hi] as [string, string]) : null
  }, [grouped])

  // ---------- 车、汇率：文件里有车款时读一次（认大架号、补汇率用） ----------
  useEffect(() => {
    if (!open || !needCars) return
    let quit = false
    void (async () => {
      const [v, r] = await Promise.all([
        fetchAll<VehicleLite>(() => supabase.from('v_vehicle_ledger').select(VEHICLE_COLS).order('id')),
        fetchAll<Rate>(() => supabase.from('fx_rates').select('currency, rate_date, rate').order('rate_date').order('currency')),
      ])
      if (quit) return
      if (v.error || r.error) message.error(errorText(v.error ?? r.error))
      setCars({ vehicles: new Map(v.data.filter((x) => x.vin).map((x) => [String(x.vin).toUpperCase(), x])), rates: r.data.map((x) => ({ ...x, rate: Number(x.rate) })) })
    })()
    return () => {
      quit = true
    }
  }, [open, needCars, message])

  // ---------- 系统里已有的：这段日期（前后多看 3 天）的收支、银行流水、到账 ----------
  const dedupKey = fileRange ? `${addDays(fileRange[0], -3)}|${addDays(fileRange[1], 3)}|${needCars ? 1 : 0}|${refreshKey}` : ''
  useEffect(() => {
    if (!dedupKey) return
    let quit = false
    const [lo, hi, withCars] = dedupKey.split('|')
    void (async () => {
      const [e, l, r] = await Promise.all([
        fetchAll<EntryRow>(() =>
          supabase.from('cash_entries').select('id, entry_no, entry_date, account_id, direction, amount, module, peer_id, fee_of').gte('entry_date', lo).lte('entry_date', hi).order('id'),
        ),
        fetchAll<LineRow>(() =>
          supabase.from('bank_statement_lines').select('id, account_id, line_date, amount_orig, entry_id, receipt_id, ignored').gte('line_date', lo).lte('line_date', hi).order('id'),
        ),
        withCars === '1'
          ? fetchAll<ReceiptRow>(() =>
              supabase.from('v_bank_receipts').select('id, receipt_no, account_id, receipt_date, amount_orig, bank_ref').gte('receipt_date', lo).lte('receipt_date', hi).order('id'),
            )
          : Promise.resolve({ data: [] as ReceiptRow[], error: null }),
      ])
      if (quit) return
      const err = e.error ?? l.error ?? r.error
      if (err) message.error(errorText(err))
      const byId = new Map(e.data.map((x) => [x.id, x]))
      setFound({
        key: dedupKey,
        entries: e.data.map((x) => {
          const peer = x.peer_id ? byId.get(x.peer_id) : undefined
          return {
            id: x.id,
            entry_no: x.entry_no,
            entry_date: x.entry_date,
            account_id: x.account_id,
            direction: x.direction === 'in' ? 'in' : 'out',
            amount: Number(x.amount),
            module: x.module,
            peer_id: x.peer_id,
            peer_account_id: peer?.account_id ?? null,
            peer_amount: peer ? Number(peer.amount) : null,
            fee_of: x.fee_of,
          }
        }),
        lines: l.data.map((x) => ({ id: x.id, account_id: x.account_id, line_date: x.line_date, amount: Number(x.amount_orig), entry_id: x.entry_id, receipt_id: x.receipt_id, ignored: x.ignored })),
        receipts: r.data.flatMap((x) =>
          x.id && x.account_id && x.receipt_date
            ? [{ id: x.id, receipt_no: x.receipt_no ?? '', account_id: x.account_id, receipt_date: x.receipt_date, amount_orig: Number(x.amount_orig), bank_ref: x.bank_ref }]
            : [],
        ),
      })
    })()
    return () => {
      quit = true
    }
  }, [dedupKey, message])
  const existing = !dedupKey ? NOTHING : found?.key === dedupKey ? found : null

  // ---------- 每笔的情况 ----------
  const carsReady = !needCars || cars !== null
  const ready = canGroup && existing !== null && carsReady
  const items: JItem[] = useMemo(
    () =>
      ready
        ? resolveItems(grouped.moves, {
            accountFor,
            accountById,
            cashFor,
            existing: existing!.entries,
            lines: existing!.lines,
            pinned: created,
            receipt: carOk
              ? { customers, salespersons, natures, vehicles: cars?.vehicles ?? new Map(), rates: cars?.rates ?? [], existing: existing!.receipts, pinned: createdR }
              : undefined,
          })
        : [],
    [ready, grouped, accountFor, accountById, cashFor, existing, created, createdR, carOk, customers, salespersons, natures, cars],
  )
  const inRange = (it: JItem) => !range || (!!it.date && it.date >= range[0] && it.date <= range[1])
  const list = useMemo(() => (range ? items.filter((it) => !!it.date && it.date >= range[0] && it.date <= range[1]) : items), [items, range])
  const selectable = (it: JItem) => it.status === 'new' || it.status === 'exists'
  const isPicked = (it: JItem) => selectable(it) && inRange(it) && (pick[it.key] ?? (it.status === 'new' && !it.suspect))
  const selected = list.filter(isPicked)
  const count = (s: JStatus) => list.filter((it) => it.status === s).length
  const newOf = (k: JItem['kind']) => list.filter((it) => it.status === 'new' && it.kind === k).length
  const skips = useMemo(() => {
    const m = new Map<SkipReason, number>()
    for (const it of list) if (it.skip) m.set(it.skip, (m.get(it.skip) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [list])
  const hasLevels = rflow.active.length > 0
  const selReceipts = selected.filter((it) => it.kind === 'receipt').length

  // ---------- 导入 ----------
  /** 管理员把这笔到账的审批一级一级批完（和在到账页上一级一级点“通过”一样） */
  const approveAll = async (id: number): Promise<string | null> => {
    const { data, error } = await supabase.from('v_bank_receipts').select('status, step, flow').eq('id', id).maybeSingle()
    if (error) return errorText(error)
    if (!data || data.status !== 'pending') return null
    const flow = parseFlow(data.flow)
    for (let i = flow.findIndex((f) => f.step === data.step); i >= 0 && i < flow.length; i++) {
      const r = await supabase.rpc('receipt_action', { p_id: id, p_action: `approve_${flow[i].step}` })
      if (r.error) return errorText(r.error)
    }
    return null
  }

  const touchesBank = (it: JItem) => [it.account_id, it.to_account_id].some((id) => id && accountById.get(id)?.kind === 'bank')

  const saveOne = async (it: JItem): Promise<Outcome> => {
    const base: Outcome = { key: it.key, rows: it.rows, kind: it.kind, bank: touchesBank(it) }
    if (it.kind === 'receipt') {
      const pl = itemReceiptPayload(it)
      if (!pl) return { ...base, error: t('车款没整理好，请刷新后再试') }
      const { data, error } = await supabase.rpc('save_receipt', { p_receipt: pl.p_receipt as unknown as Json, p_claims: pl.p_claims as unknown as Json })
      if (error || !data) return { ...base, error: errorText(error) }
      changed.current.receipts = true
      const o: Outcome = { ...base, id: Number(data) }
      if (direct && isAdmin && hasLevels) {
        const e = await approveAll(o.id!)
        if (e) o.approveError = e
      }
      return o
    }
    const { data, error } = await supabase.rpc('save_cash_entry', { p: itemPayload(it) as Json })
    const res = data as { id?: number; matched?: number[] } | null
    if (error || !res?.id) return { ...base, error: errorText(error) }
    changed.current.journal = true
    return { ...base, id: Number(res.id), matched: (res.matched ?? []).length > 0 }
  }

  const doImport = async () => {
    const todo = [...selected].sort((a, b) => a.key - b.key)
    if (!todo.length) return message.warning(t('没有勾选要导入的'))
    setImporting(true)
    setSummary(null)
    stop.current = false
    setProgress({ done: 0, total: todo.length })
    const outcomes: Outcome[] = []
    let done = 0
    const tick = (o: Outcome) => {
      outcomes.push(o)
      done++
      setProgress({ done, total: todo.length })
    }
    // 只碰现金账户的收支几笔一起存；碰到银行账户的（要对流水）、到账（要审批）一笔一笔来，按文件里的先后
    let i = 0
    while (i < todo.length && !stop.current) {
      const it = todo[i]
      if (it.kind !== 'receipt' && !touchesBank(it)) {
        const batch: JItem[] = []
        while (i < todo.length && batch.length < PARALLEL && todo[i].kind !== 'receipt' && !touchesBank(todo[i])) batch.push(todo[i++])
        for (const o of await Promise.all(batch.map(saveOne))) tick(o)
      } else {
        tick(await saveOne(it))
        i++
      }
    }
    const stopped = stop.current && done < todo.length
    // 导完看一眼到账：生效了几笔
    const rids = outcomes.filter((o) => o.kind === 'receipt' && o.id).map((o) => o.id!)
    const after: { status: string | null }[] = []
    for (let k = 0; k < rids.length; k += 150) {
      const { data } = await supabase.from('v_bank_receipts').select('status').in('id', rids.slice(k, k + 150))
      after.push(...(data ?? []))
    }
    const saved = outcomes.filter((o) => o.id && o.kind !== 'receipt')
    setSummary({
      entries: saved.filter((o) => o.kind !== 'transfer').length,
      transfers: saved.filter((o) => o.kind === 'transfer').length,
      matched: saved.filter((o) => o.matched).length,
      waiting: saved.filter((o) => o.bank && !o.matched).length,
      receipts: rids.length,
      approved: after.filter((r) => r.status === 'approved').length,
      pending: after.filter((r) => r.status === 'pending').length,
      failed: outcomes.filter((o) => o.error),
      approveFailed: outcomes.filter((o) => o.approveError),
      stopped,
    })
    setImporting(false)
    const pins = (kind: 'receipt' | 'entry') => outcomes.flatMap((o): [number, number][] => (o.id && (o.kind === 'receipt') === (kind === 'receipt') ? [[o.key, o.id]] : []))
    setCreated((old) => new Map([...old, ...pins('entry')]))
    setCreatedR((old) => new Map([...old, ...pins('receipt')]))
    // 导过的这几笔回到默认勾法（导进去的变成“系统里已有”不勾，没导进去的还勾着）
    setPick((old) => {
      const next = { ...old }
      for (const it of todo) delete next[it.key]
      return next
    })
    setRefreshKey((k) => k + 1)
    if (changed.current.journal) notifyJournalChanged()
    if (rids.length) notifySubmissionsChanged()
  }

  // ---------- 表格 ----------
  const issueText = (i: Issue) => t(i.key, Object.fromEntries(Object.entries(i.vars ?? {}).map(([k, v]) => [k, typeof v === 'string' ? t(v) : v])))
  const STATUS: Record<JStatus, [string, string]> = {
    new: ['green', t('可以导入')],
    exists: ['default', t('系统里已有')],
    skip: ['default', t('不导')],
    error: ['red', t('有问题，不能导入')],
  }
  const SKIP: Record<SkipReason, string> = {
    receipt: t('车款：要有「到账录入」的编辑权限才能导成到账'),
    receipt_mixed:
      scope === 'bank'
        ? t('车款和别的业务在一笔里：导流水以后在银行对账里录成到账，再填剩下的')
        : t('车款和别的业务在一笔里：车款在到账录入里录，剩下的点「记一笔现金」'),
    no_module: t('没写业务模块'),
    account: t('账户选了不导（或没对上）'),
    inactive: t('账户已经停用（要导先到基础资料里启用）'),
    opening: t('在账户的期初日期之前（日记账里不算）'),
    self: t('同一个账户一出一进、金额一样，互相抵消'),
  }
  const KIND: Record<NonNullable<JItem['kind']>, [string, string]> = {
    in: ['green', t('收入')],
    out: ['orange', t('支出')],
    transfer: ['purple', t('账户互转')],
    receipt: ['blue', t('车款 → 到账')],
  }
  const LINE: Record<LineState, string> = { free: t('流水已导，导入后对上'), none: t('等流水'), cash: '' }
  const OTHER: Record<string, string> = { summary: t('另一边按摘要'), cash: t('另一边：选的现金账户') }
  // 银行日记账：可以导入的这一笔导进去以后是马上对上已导的流水，还是等流水（互转两边分开写）
  const lineHint = (it: JItem) => {
    if (it.status !== 'new') return null
    const a = it.line ? LINE[it.line] : ''
    const b = it.toLine ? LINE[it.toLine] : ''
    if (it.kind === 'transfer' && (a || b))
      return (
        <div className="hint">
          {a && <div>{t('转出：{s}', { s: a })}</div>}
          {b && <div>{t('转入：{s}', { s: b })}</div>}
        </div>
      )
    return a ? <div className="hint">{a}</div> : null
  }
  const acctName = (id: number | null, text: string) => (id ? (accountById.get(id)?.short_name ?? text) : text || t('（空）'))
  const columns: ColumnsType<JItem> = [
    { title: t('行'), width: 56, fixed: 'left', render: (_, it) => rowRange(it.rows) },
    {
      title: t('状态'),
      width: 210,
      render: (_, it) => (
        <div className="ri-status">
          <Tag color={STATUS[it.status][0]}>{STATUS[it.status][1]}</Tag>
          {it.existing && <span className="hint ri-no">{it.existing.entry_no}</span>}
          {it.receipt?.existing && <span className="hint ri-no">{it.receipt.existing.receipt_no}</span>}
          {scope === 'bank' && lineHint(it)}
          {it.skip && <div className="hint">{SKIP[it.skip]}</div>}
          {it.errors.map((e, i) => (
            <div key={`e${i}`} className="text-danger">
              {issueText(e)}
            </div>
          ))}
          {it.warnings.map((w, i) => (
            <div key={`w${i}`} className="text-warn">
              {issueText(w)}
            </div>
          ))}
          {it.infos.map((w, i) => (
            <div key={`i${i}`} className="hint">
              {issueText(w)}
            </div>
          ))}
        </div>
      ),
    },
    {
      title: t('日期 / 类型'),
      width: 128,
      render: (_, it) => (
        <div>
          <div>{it.date}</div>
          {it.kind && (
            <Tag color={KIND[it.kind][0]} style={{ marginTop: 4 }}>
              {KIND[it.kind][1]}
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: t('账户'),
      width: 190,
      render: (_, it) =>
        it.kind === 'transfer' ? (
          <div>
            <div>
              {acctName(it.account_id, it.account_text)} → {acctName(it.to_account_id, it.to_account_text)}
            </div>
            {it.other && OTHER[it.other] && <div className="hint">{OTHER[it.other]}</div>}
          </div>
        ) : it.account_id ? (
          <span>
            {accountById.get(it.account_id)?.short_name}
            {it.account_text && acctKey(it.account_text) !== acctKey(accountById.get(it.account_id)?.short_name ?? '') && <div className="hint">{it.account_text}</div>}
          </span>
        ) : (
          <span className={it.skip ? 'hint' : 'text-danger'}>{it.account_text || t('（空）')}</span>
        ),
    },
    {
      title: t('金额'),
      width: 140,
      align: 'right',
      render: (_, it) =>
        it.amount === null ? (
          ''
        ) : (
          <div className="num">
            <div>{`${it.currency} ${money(it.amount)}`}</div>
            {it.kind === 'transfer' && it.to_amount !== null && it.to_currency && it.to_currency !== it.currency && <div className="hint">{`→ ${it.to_currency} ${money(it.to_amount)}`}</div>}
            {it.fx_rate !== null && it.currency !== 'USD' && <div className="hint">{t('汇率 {rate}', { rate: it.fx_rate })}</div>}
          </div>
        ),
    },
    {
      title: t('业务 / 拆到车'),
      width: 260,
      render: (_, it) =>
        it.kind === 'receipt' && it.receipt ? (
          it.receipt.claims.length === 0 ? (
            <span className="hint">{t('没拆分（导进去是未认领，之后点开拆）')}</span>
          ) : (
            <div className="ri-claims">
              {it.receipt.claims.map((c, i) => (
                <div key={i} className={c.dropped ? 'ri-claim ri-dropped' : 'ri-claim'}>
                  <div className="ri-claim-top">
                    <span>
                      {c.vehicle ? <span className="cv-vin">{c.vehicle.vin}</span> : <Tag color="orange">{t('大架号未锁定')}</Tag>}
                      {c.dropped && <Tag style={{ marginLeft: 6 }}>{t('不导')}</Tag>}
                    </span>
                    {c.amount !== null && <span className="num ri-amt">{money(c.amount)}</span>}
                  </div>
                  <div>
                    {c.customer_name || c.vin}
                    <span className="hint"> · {t(c.nature)}</span>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="ri-claims">
            {it.parts.map((p, i) => (
              <div key={i} className="ri-claim">
                <div className="ri-claim-top">
                  <span>
                    <Tag color={moduleColor(p.module)}>{t(p.module)}</Tag>
                    {p.counterparty}
                  </span>
                  {it.parts.length > 1 && <span className="num ri-amt">{money(p.amount)}</span>}
                </div>
              </div>
            ))}
          </div>
        ),
    },
    {
      title: t('摘要'),
      render: (_, it) => (
        <div>
          {it.summary}
          {it.bank_ref && <div className="hint">{t('参考号 {v}', { v: it.bank_ref })}</div>}
          {it.cheque_no && <div className="hint">{t('支票号 {v}', { v: it.cheque_no })}</div>}
          {it.note && <div className="hint">{it.note}</div>}
        </div>
      ),
    },
  ]
  const shown = list.filter((it) => filter === 'all' || (filter === 'receipt' ? it.kind === 'receipt' && it.status === 'new' : it.status === filter))
  const colOptions = headers.map((h, i) => ({ value: i, label: `${colName(i)} · ${h || t('（空）')}` }))
  const ignoredText = (reason: string) => (reason === 'total' ? t('合计行') : reason === 'orphan' ? t('只有拆分金额，前面没有一笔钱') : t('没写金额'))

  // 账户下拉：这本日记账的账户，停用了的放后面、标出来
  const acctOptions = useMemo(() => {
    const opt = (a: Account) => ({ value: a.id, label: a.active ? a.short_name : t('{name}（已停用）', { name: a.short_name }) })
    return [...scopeAccounts.filter((a) => a.active).map(opt), ...scopeAccounts.filter((a) => !a.active).map(opt)]
  }, [scopeAccounts, t])

  const fieldSelect = (f: (typeof J_FIELDS)[number]) => {
    const need = f.required || (['amount', 'income', 'expense'].includes(f.key) && !amountOk)
    return (
      <Col key={f.key} xs={12} md={8} lg={4}>
        <div className="hint">
          {t(f.label)}
          {f.required && <span className="text-danger"> *</span>}
        </div>
        <Select
          allowClear
          style={{ width: '100%' }}
          value={mapping[f.key]}
          status={need && mapping[f.key] === undefined ? 'error' : undefined}
          placeholder={t('没有')}
          showSearch={{ optionFilterProp: 'label' }}
          options={colOptions}
          onChange={(v: number | undefined) => {
            setMapping((m) => ({ ...m, [f.key]: v }))
            setPick({})
          }}
        />
      </Col>
    )
  }

  const bank = scope === 'bank'
  return (
    <Drawer
      open={open}
      className="receipt-import journal-import"
      title={t('{book}：批量导入', { book: t(SCOPE_TITLE[scope]) })}
      size={Math.min(1320, typeof window !== 'undefined' ? window.innerWidth : 1320)}
      onClose={close}
      maskClosable={!importing}
      closable={!importing}
      destroyOnHidden
    >
      <Card size="small" title={t('1. 选文件')} style={{ marginBottom: 12 }} extra={<Button icon={<DownloadOutlined />} onClick={downloadTemplate}>{t('下载模板')}</Button>}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {bank
            ? t('照《终端解款表》银行存款那张的格式：一行一笔收付（收为正、付为负），下面只写拆分金额的行是这一笔里的另一种业务。导进来和点「记一笔银行交易」一样：银行流水已经导了的马上对上，没导的等流水。车款（设备回款）导成到账，走审批流，批完进车辆台账。系统里已有的默认不导。')
            : t('照《终端解款表》现金回款那张的格式：一行一笔收付（收为正、付为负），下面只写拆分金额的行是这一笔里的另一种业务。导进来和点「记一笔现金」一样。车款（设备回款）导成到账，走审批流，批完进车辆台账。系统里已有的默认不导。')}
        </Typography.Paragraph>
        <Upload.Dragger
          accept=".xlsx,.xls,.csv"
          showUploadList={false}
          disabled={importing}
          beforeUpload={(f) => {
            void readFile(f as File)
            return false
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">{fileName ? t('已读取：{fileName}（点这里换一个文件）', { fileName }) : t('把 Excel 拖到这里，或点击选择')}</p>
        </Upload.Dragger>
      </Card>

      {sheetRows.length > 0 && (
        <Card size="small" title={t('2. 对应列')} style={{ marginBottom: 12 }}>
          <Row gutter={[12, 12]}>
            {book && book.SheetNames.length > 1 && (
              <Col xs={24} md={8} lg={6}>
                <div className="hint">{t('工作表')}</div>
                <Select style={{ width: '100%' }} value={sheet} disabled={importing} onChange={(n: string) => loadSheet(book, n)} options={book.SheetNames.map((n) => ({ value: n, label: n }))} />
              </Col>
            )}
            <Col xs={12} md={8} lg={4}>
              <div className="hint">{t('表头在第几行')}</div>
              <InputNumber
                min={1}
                max={50}
                value={headerRow}
                disabled={importing}
                onChange={(v) => {
                  applyHeaderRow(sheetRows, v ?? 1)
                  setPick({})
                }}
                style={{ width: '100%' }}
              />
            </Col>
          </Row>
          <div className="ri-part">{t('一笔钱')}</div>
          <Row gutter={[12, 12]}>{J_FIELDS.filter((f) => !f.car).map(fieldSelect)}</Row>
          <div className="ri-part">{t('车款导成到账用（可以不对，大架号会从摘要里认）')}</div>
          <Row gutter={[12, 12]}>{J_FIELDS.filter((f) => f.car).map(fieldSelect)}</Row>
          {(missingRequired.length > 0 || !amountOk) && (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 12 }}
              title={t('还没对上的必填列：{list}', {
                list: [...missingRequired.map((f) => t(f.label)), ...(amountOk ? [] : [t('收/支款金额（或收入、支出）')])].join(t('、')),
              })}
            />
          )}
        </Card>
      )}

      {canGroup && (
        <Card size="small" title={t('3. 账户对照')} style={{ marginBottom: 12 }}>
          <div className="hint" style={{ marginBottom: 8 }}>
            {bank ? t('空着的账户不导（代付、已经不用的账户……）。') : t('空着的账户不导：分部的现金箱系统里没有对应的现金账户，空着就是不导；要导的话选一个现金账户。')}
          </div>
          <Table
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={acctGroups}
            scroll={{ y: 320 }}
            columns={[
              { title: t('文件里的写法'), dataIndex: 'text', ellipsis: true },
              { title: t('几笔'), dataIndex: 'count', width: 80, align: 'right' },
              {
                title: t('系统里的账户'),
                width: 340,
                render: (_, g) => {
                  const v = g.key in acctPick ? acctPick[g.key] : g.auto
                  const a = v ? accountById.get(v) : undefined
                  return (
                    <Space size={6} style={{ width: '100%' }}>
                      <Select
                        allowClear
                        size="small"
                        style={{ width: 260 }}
                        placeholder={t('不导')}
                        disabled={importing}
                        showSearch={{ optionFilterProp: 'label' }}
                        options={acctOptions}
                        value={v}
                        onChange={(x: number | undefined) => {
                          setAcctPick((p) => ({ ...p, [g.key]: x }))
                          setPick({})
                        }}
                      />
                      {a && !a.active && <Tag>{t('已停用')}</Tag>}
                    </Space>
                  )
                },
              },
            ]}
          />
          {cashNeed.length > 0 && (
            <Space wrap style={{ marginTop: 12 }}>
              <span>{t('现金存现、银行取现的另一边记到：')}</span>
              {cashNeed.map((cur) => (
                <Space key={cur} size={4}>
                  <span className="hint">{cur}</span>
                  <Select
                    allowClear
                    size="small"
                    style={{ width: 200 }}
                    disabled={importing}
                    status={cashFor(cur) ? undefined : 'error'}
                    placeholder={t('选现金账户')}
                    options={cashAccounts.filter((a) => a.currency === cur).map((a) => ({ value: a.id, label: a.short_name }))}
                    value={cashFor(cur)}
                    onChange={(x: number | undefined) => {
                      setCashPick((p) => ({ ...p, [cur]: x }))
                      setPick({})
                    }}
                  />
                </Space>
              ))}
            </Space>
          )}
        </Card>
      )}

      {canGroup && (
        <Card size="small" title={t('4. 预览和导入')}>
          <Space orientation="vertical" style={{ width: '100%' }} size={8}>
            {!ready ? (
              <div className="hint">{needCars ? t('正在查系统里已有的收支、银行流水、到账和车…') : t('正在查系统里已有的收支和银行流水…')}</div>
            ) : (
              <>
                <Space wrap>
                  <span>{t('只导这段日期：')}</span>
                  <DatePicker.RangePicker
                    allowClear
                    disabled={importing}
                    value={range ? [dayjs(range[0]), dayjs(range[1])] : null}
                    onChange={(v) => {
                      setRange(v && v[0] && v[1] ? [v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD')] : null)
                    }}
                  />
                  {fileRange && <span className="hint">{t('文件里是 {a} 至 {b}', { a: fileRange[0], b: fileRange[1] })}</span>}
                </Space>
                <div>
                  {t('共 {n} 笔：可以导入 {a} 笔（收入 {i}、支出 {o}、账户互转 {x}、车款导成到账 {r}），系统里已有 {b} 笔，有问题 {c} 笔，不导 {d} 笔。', {
                    n: list.length,
                    a: count('new'),
                    i: newOf('in'),
                    o: newOf('out'),
                    x: newOf('transfer'),
                    r: newOf('receipt'),
                    b: count('exists'),
                    c: count('error'),
                    d: count('skip'),
                  })}
                </div>
                {skips.length > 0 && (
                  <div className="hint">
                    {t('不导的：{list}', { list: skips.map(([k, n]) => t('{why} {n} 笔', { why: SKIP[k], n })).join(t('；')) })}
                  </div>
                )}
                {grouped.ignored.length > 0 && (
                  <div className="hint">
                    {t('这些行没当成一笔钱：{list}', {
                      list: grouped.ignored
                        .slice(0, 12)
                        .map((x) => t('第 {row} 行（{why}）', { row: x.row, why: ignoredText(x.reason) }))
                        .join(t('、')),
                    })}
                    {grouped.ignored.length > 12 && t('…等 {n} 行', { n: grouped.ignored.length })}
                  </div>
                )}
              </>
            )}
            <Space wrap>
              {isAdmin && hasLevels && selReceipts > 0 && (
                <Checkbox checked={direct} disabled={importing} onChange={(e) => setDirect(e.target.checked)}>
                  {t('车款到账导入后直接生效（我以管理员身份批完每一级）')}
                </Checkbox>
              )}
              <Button type="primary" loading={importing} disabled={!ready || !selected.length} onClick={() => void doImport()}>
                {t('导入选中的 {n} 笔', { n: selected.length })}
              </Button>
              {importing && (
                <Button
                  onClick={() => {
                    stop.current = true
                  }}
                >
                  {t('停下')}
                </Button>
              )}
            </Space>
            {selReceipts > 0 &&
              (hasLevels ? (
                <div className="hint">
                  {direct && isAdmin
                    ? t('车款到账导入后直接生效，审批记录里记着是你批的。')
                    : t('车款到账导入后从第一级“{name}”开始审批，批完才进车辆台账。', { name: rflow.name(rflow.active[0]?.key) })}
                </div>
              ) : (
                <div className="hint">{t('现在到账没有设审批级别，车款到账导入后直接生效。')}</div>
              ))}
            {progress && importing && (
              <div>
                <Progress percent={Math.round((progress.done / progress.total) * 100)} />
                <div className="hint">{t('已存 {done} / {total} 笔。导的时候别关这个窗口；中途停下或断了，再导一次，存过的会认成系统里已有。', progress)}</div>
              </div>
            )}
            {summary && (
              <Alert
                type={summary.failed.length && !(summary.entries + summary.transfers + summary.receipts) ? 'error' : summary.failed.length || summary.approveFailed.length || summary.stopped ? 'warning' : 'success'}
                showIcon
                title={t('导入了收入、支出 {e} 笔，账户互转 {x} 笔（和银行流水对上 {m} 笔，等流水 {w} 笔）；车款到账 {r} 笔（已生效 {a} 笔，审批中 {p} 笔）。', {
                  e: summary.entries,
                  x: summary.transfers,
                  m: summary.matched,
                  w: summary.waiting,
                  r: summary.receipts,
                  a: summary.approved,
                  p: summary.pending,
                })}
                description={
                  summary.failed.length || summary.approveFailed.length || summary.stopped ? (
                    <div>
                      {summary.stopped && <div>{t('中途停下了：没导的还勾着，再点导入接着导。')}</div>}
                      {summary.failed.length > 0 && <div className="text-danger">{t('有 {n} 笔没导进去（改好后再导一次，导过的不会重复）：', { n: summary.failed.length })}</div>}
                      {summary.failed.map((o) => (
                        <div key={`f${o.key}`}>{t('第 {rows} 行没导进去：{err}', { rows: rowRange(o.rows), err: o.error ?? '' })}</div>
                      ))}
                      {summary.approveFailed.map((o) => (
                        <div key={`a${o.key}`}>{t('第 {rows} 行导进去了，但没批完：{err}', { rows: rowRange(o.rows), err: o.approveError ?? '' })}</div>
                      ))}
                    </div>
                  ) : undefined
                }
              />
            )}
            <Segmented
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              options={[
                { value: 'all', label: t('全部 {n}', { n: list.length }) },
                { value: 'new', label: t('可以导入 {n}', { n: count('new') }) },
                ...(needCars ? [{ value: 'receipt', label: t('车款 → 到账 {n}', { n: newOf('receipt') }) }] : []),
                { value: 'exists', label: t('系统里已有 {n}', { n: count('exists') }) },
                { value: 'error', label: t('有问题 {n}', { n: count('error') }) },
                { value: 'skip', label: t('不导 {n}', { n: count('skip') }) },
              ]}
            />
            <Table
              rowKey="key"
              size="small"
              dataSource={shown}
              columns={columns}
              scroll={{ x: 1200 }}
              pagination={{ defaultPageSize: 50, showSizeChanger: true }}
              rowSelection={{
                selectedRowKeys: shown.filter(isPicked).map((it) => it.key),
                getCheckboxProps: (it) => ({ disabled: !selectable(it) || importing }),
                onChange: (keys) => {
                  const on = new Set(keys.map(Number))
                  setPick((old) => {
                    const next = { ...old }
                    for (const it of shown) if (selectable(it)) next[it.key] = on.has(it.key)
                    return next
                  })
                },
              }}
            />
          </Space>
        </Card>
      )}
    </Drawer>
  )
}
