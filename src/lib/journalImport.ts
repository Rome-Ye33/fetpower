// 日记账批量导入（银行日记账 / 现金日记账 →「批量导入」）：照《终端解款表》银行存款 / 现金回款那张的格式读 Excel，
// 一笔钱记成一笔，存法和点「记一笔银行交易」「记一笔现金」一样（save_cash_entry）：银行流水已经导进来的马上对上，没导的「等流水」，
// 导流水时自动对上；现金、MOMO 没有流水。
//
// 一笔钱怎么认：
// - 写了收/支款金额（收为正、付为负；也可以分开写「收入」「支出」两列）的行是一笔新的钱。
// - 下面没写金额、只写了拆分金额的行，是这笔钱里的另一种业务（解款表的「拆分金额」），拆分金额加起来要等于这笔钱。
// - 账户之间的钱（资金拨付、货币兑换、现金存现、银行取现……）记成账户互转：转出、转入两行配成一笔（同业务模块、前后 3 天、币种一样的金额也一样）；
//   摘要里写了两个账户的（资金拨付【8651户转7773户】）照摘要配；只有一边的，另一边记到摘要里写的账户（那边等流水），
//   现金存现、银行取现只有银行那一边，另一边记到选的现金账户。
// - 车款（设备回款）导成到账（和「到账录入 → 批量导入」一样走 save_receipt、审批流），审批通过后进车辆台账，也进日记账：
//   大架号写在大架号列或者摘要里（解款表多半写在摘要里），没写的先记在客户名下（大架号未锁定）；款项性质照款项性质列或摘要里的字。
//   车款和别的业务在一笔里的跳过（导流水以后在银行对账里录成到账、再填剩下的）。没写业务模块的也跳过。
// 查重：系统里同账户、同一天、同方向、同金额的收支（互转：同两个账户、同金额、前后 3 天）一笔对一笔，算「系统里已有」，默认不导，
//   同一个文件导两次不会记重。日期差几天的同一笔、同金额的银行流水已经填了的，提醒一下，默认也不勾。
import { EN } from '../i18n/en'
import type { Json } from './database.types'
import { money, round2, todayAccra } from './format'
import { CURRENCY_ZH, JOURNAL_MODULES, RECEIPT_MODULE, transferSummary } from './journal'
import { parseReceiptDate, receiptPayload, resolveReceipts, splitVins } from './receiptImport'
import type { Ctx as ReceiptCtx, Draft, Issue, PReceipt } from './receiptImport'
import { matchAccount, parseAmount } from './statement'
import type { Account } from './supabase'

export type JField =
  | 'date'
  | 'account'
  | 'amount'
  | 'income'
  | 'expense'
  | 'split'
  | 'module'
  | 'counterparty'
  | 'summary'
  | 'fx_rate'
  | 'usd'
  | 'vin'
  | 'nature'
  | 'bank_ref'
  | 'cheque_no'
  | 'note'
export type JMapping = Partial<Record<JField, number>>

/** car = 只有车款（导成到账）用得上的列 */
type FieldDef = { key: JField; label: string; required?: boolean; car?: boolean; patterns: RegExp[]; exclude?: RegExp }

/** 字段：界面名（中文，同时是翻译的 key；模板的表头也用它）、认表头的规则（先严后宽）、不要的列。金额三选一：收/支款金额，或者收入、支出两列 */
export const J_FIELDS: FieldDef[] = [
  {
    key: 'date',
    label: '日期',
    required: true,
    patterns: [/^(日期|交易日期|入账日期|记账日期|date|value\s*date|transaction\s*date)$/i, /日期|date/i],
    exclude: /到期|开票|创建|修改|签约|合同|due|create|modif|contract/i,
  },
  {
    key: 'account',
    label: '账户',
    required: true,
    patterns: [/^(回款银行|账户|银行账户|收款账户|付款账户|收付款账户|银行|account|bank\s*account|bank)$/i, /回款银行|银行账户|收款账户|付款账户|账户|bank\s*account|account/i],
    exclude: /户名|开户|编码|摘要|参考|account\s*name|code|narration|ref/i,
  },
  {
    key: 'amount',
    label: '收/支款金额',
    patterns: [
      /^(收\s*\/\s*支款金额|收\s*\/\s*支金额|收\s*\/\s*付款金额|收支金额|发生额|金额|amount)$/i,
      /收.{0,2}支.{0,2}金额|收.{0,2}付.{0,2}金额|收款金额|发生额|金额|amount/i,
    ],
    exclude: /拆分|余额|本位币|优惠|美元|美金|usd|折|split|balance|allocat|discount/i,
  },
  { key: 'income', label: '收入', patterns: [/^(收入|收入金额|income|money\s*in|credit|cr\.?)$/i] },
  { key: 'expense', label: '支出', patterns: [/^(支出|支出金额|expense|expenses|money\s*out|debit|dr\.?)$/i] },
  {
    key: 'split',
    label: '拆分金额',
    patterns: [/^(拆分金额|金额拆分|分项金额|split\s*amount|allocated\s*amount)$/i, /拆分|split/i],
    exclude: /usd|美元|美金/i,
  },
  { key: 'module', label: '业务模块', required: true, patterns: [/^(业务模块|模块|业务类型|类别|category|module)$/i, /业务模块|业务类型|category/i] },
  {
    key: 'counterparty',
    label: '客户 / 供应商',
    patterns: [
      /^(客户\s*\/\s*供应商(名称)?|客户|供应商|往来单位|对方单位|对方|counterparty|customer\s*\/\s*supplier|customer|supplier)$/i,
      /客户|供应商|往来单位|counterparty|customer|supplier/i,
    ],
    exclude: /编码|编号|电话|代码|code|phone/i,
  },
  {
    key: 'summary',
    label: '摘要',
    patterns: [/^(摘要|摘要\s*\/\s*单据备注|说明|用途|narration|description|summary|memo)$/i, /摘要|用途|narration|description/i],
    exclude: /银行摘要|bank/i,
  },
  { key: 'fx_rate', label: '汇率', patterns: [/^(汇率|rate|fx\s*rate|exchange\s*rate)$/i, /汇率|exchange\s*rate/i] },
  {
    key: 'usd',
    label: 'USD金额',
    car: true,
    patterns: [/^(usd|usd\s*金额|美元金额|折美元|回款约定本位币|本位币金额|usd\s*amount|amount\s*usd)$/i, /usd|美元|美金|折美|本位币/i],
    exclude: /拆分|余额|优惠|split|balance|allocat|discount/i,
  },
  { key: 'vin', label: '大架号', car: true, patterns: [/^(大架号|车架号|vin|chassis(\s*no\.?)?)$/i, /大架号|车架号|\bvin\b|chassis/i], exclude: /金蝶/ },
  {
    key: 'nature',
    label: '款项性质',
    car: true,
    patterns: [/^(款项性质|款项类型|性质|payment\s*type)$/i, /款项|性质|payment\s*type/i],
    exclude: /付款方式|车|设备|payment\s*(method|terms)|vehicle|model/i,
  },
  {
    key: 'bank_ref',
    label: '参考号',
    patterns: [/^(参考号|银行参考号|流水号|reference|ref\.?(\s*no\.?)?|bank\s*ref\.?)$/i, /参考号|流水号|reference/i],
  },
  {
    key: 'cheque_no',
    label: '支票号',
    patterns: [/^(支票号|支票号码|cheque\s*no\.?|cheque\s*number|cheque)$/i, /支票号|cheque\s*no/i],
    exclude: /银行|bank/i,
  },
  { key: 'note', label: '备注', patterns: [/^(备注|note|notes|remarks?)$/i, /备注|remark/i], exclude: /摘要|单据备注/ },
]

/** 模板的列，照《终端解款表》的顺序（收入、支出两列不放：模板用一列收/支款金额） */
export const J_TEMPLATE: JField[] = ['date', 'module', 'counterparty', 'summary', 'fx_rate', 'usd', 'split', 'amount', 'account', 'vin', 'nature', 'bank_ref', 'cheque_no', 'note']

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()
/** 账户写法比较用：去掉多余的空白、大写 */
export const acctKey = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase()

export function guessJournalMapping(headers: string[]): JMapping {
  const m: JMapping = {}
  const used = new Set<number>()
  for (const f of J_FIELDS) {
    for (const re of f.patterns) {
      const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(clean(h)) && !f.exclude?.test(clean(h)))
      if (i >= 0) {
        m[f.key] = i
        used.add(i)
        break
      }
    }
  }
  return m
}

/** 金额的列对上了没有：收/支款金额一列，或者收入、支出（至少一列） */
export const hasAmountCol = (m: JMapping) => m.amount !== undefined || m.income !== undefined || m.expense !== undefined

/** 表头在第几行（1 起）：前 20 行里第一行认得出日期、业务模块、金额的；认不出返回 0 */
export function findJournalHeaderRow(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const m = guessJournalMapping((rows[i] ?? []).map((c) => String(c ?? '')))
    if (m.date !== undefined && m.module !== undefined && hasAmountCol(m)) return i + 1
  }
  return 0
}

// ---------------------------------------------------------------- 账户
const normName = (s: string) => s.toUpperCase().replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '')
const CODES = ['GHS', 'USD', 'SLL', 'SLE', 'GNF', 'EUR', 'GBP', 'CNY', 'XOF', 'NGN']
/** 币种的中文叫法（解款表里的：FET AUTO-塞地、FET AUTO-美元），长的先比（几内亚法郎在西非法郎前面也不会比错） */
const CUR_WORDS: [string, string][] = [
  ...Object.entries(CURRENCY_ZH).map(([code, zh]): [string, string] => [zh, code]),
  ['美金', 'USD'] as [string, string],
  ['赛地', 'GHS'] as [string, string],
].sort((a, b) => b[0].length - a[0].length)

/**
 * 现金账户的写法对到系统里（现金日记账导入用）：先比全名；带 MOMO 的是 momo；只写了公司和币种的（FET AUTO-塞地、FET AUTO-美元）
 * 对到那个币种唯一的一个现金账户。分部的现金箱（库马西-塞地、特马-塞地）不自动对，在账户对照里选。
 */
export function matchCashAccount(raw: string, accounts: Account[], companies: string[]): number | undefined {
  const n = normName(raw)
  if (!n) return undefined
  const exact = accounts.filter((a) => [a.list_name, a.short_name].some((x) => x && normName(x) === n))
  if (exact.length === 1) return exact[0].id
  const live = accounts.filter((a) => a.active)
  if (n.includes('MOMO')) {
    const m = live.filter((a) => a.kind === 'momo')
    return m.length === 1 ? m[0].id : undefined
  }
  let rest = n
  for (const c of [...companies].sort((a, b) => b.length - a.length)) rest = rest.split(normName(c)).join('')
  let cur: string | undefined
  for (const code of CODES)
    if (rest.includes(code)) {
      cur ??= code
      rest = rest.split(code).join('')
    }
  for (const [zh, code] of CUR_WORDS)
    if (rest.includes(zh)) {
      cur ??= code
      rest = rest.split(zh).join('')
    }
  rest = rest.replace(/CASH|现金/g, '').replace(/[^0-9A-Z一-鿿]/g, '')
  if (!cur || rest) return undefined
  const hits = live.filter((a) => a.kind === 'cash' && a.currency === cur)
  return hits.length === 1 ? hits[0].id : undefined
}

/** 文件里的账户写法自动对到哪个账户：银行日记账对银行账户（全名、币种 + 后 4 位），现金日记账对现金账户 */
export function autoAccount(raw: string, scope: 'bank' | 'cash', accounts: Account[]): number | undefined {
  if (scope === 'bank')
    return matchAccount(
      raw,
      accounts.filter((a) => a.kind === 'bank'),
    )
  const companies = [...new Set(accounts.map((a) => a.company).filter((c): c is string => !!c))]
  return matchCashAccount(
    raw,
    accounts.filter((a) => a.kind !== 'bank'),
    companies,
  )
}

// ---------------------------------------------------------------- 读单元格
type Note = Issue & { level: 'error' | 'warn' | 'info' }

/** 合计、小计这类行不是一笔钱 */
const TOTAL_ROW = /^(合\s*计|总\s*计|小\s*计|共\s*计|本日合计|本月合计|total|grand\s*total|sub\s*total|sum)\s*[:：]?$/i

type Raw = {
  row: number
  dateText: string
  date: string | null
  account: string
  /** 金额那一格写的字（收入、支出两列的是写了的那一列） */
  amountText: string
  /** 带正负：收为正、付为负；不是数字为 null */
  amount: number | null
  /** 收入、支出两列都写了 */
  both: boolean
  splitText: string
  split: number | null
  module: string
  counterparty: string
  summary: string
  rateText: string
  rate: number | null
  usdText: string
  usd: number | null
  vin: string
  nature: string
  bank_ref: string
  cheque_no: string
  note: string
}

function readRow(r: unknown[], row: number, m: JMapping): Raw {
  const cell = (k: JField) => (m[k] === undefined ? '' : r[m[k] as number])
  const text = (k: JField) => clean(cell(k))
  const num = (k: JField) => (text(k) === '' ? null : parseAmount(cell(k)))
  let amountText = ''
  let amount: number | null = null
  let both = false
  if (m.amount !== undefined) {
    amountText = text('amount')
    amount = num('amount')
  } else {
    // 收入、支出分两列：写 0 的当没写；写了不是数字的照样带出来，报“不是数字”
    const it = text('income')
    const et = text('expense')
    const iv = num('income')
    const ev = num('expense')
    const inc = iv !== null && iv !== 0
    const exp = ev !== null && ev !== 0
    both = inc && exp
    if (inc) {
      amountText = it
      amount = Math.abs(iv)
    } else if (exp) {
      amountText = et
      amount = -Math.abs(ev)
    } else if (it && iv === null) amountText = it
    else if (et && ev === null) amountText = et
  }
  return {
    row,
    dateText: text('date'),
    date: text('date') === '' ? null : parseReceiptDate(cell('date')),
    account: text('account'),
    amountText,
    amount,
    both,
    splitText: text('split'),
    split: num('split'),
    module: text('module'),
    counterparty: text('counterparty'),
    summary: text('summary'),
    rateText: text('fx_rate'),
    rate: num('fx_rate'),
    usdText: text('usd'),
    usd: num('usd'),
    vin: text('vin'),
    nature: text('nature'),
    bank_ref: text('bank_ref'),
    cheque_no: text('cheque_no'),
    note: text('note'),
  }
}

// ---------------------------------------------------------------- 整理成一笔笔钱
export type MovePart = {
  row: number
  module: string
  counterparty: string
  summary: string
  splitText: string
  split: number | null
  /** 车款用：这一行的 USD、大架号、款项性质 */
  usd: number | null
  vin: string
  nature: string
}

/** 表里的一笔钱：写了收/支款金额的那一行，加上下面只写了拆分金额的几行 */
export type Move = {
  key: number
  rows: number[]
  dateText: string
  date: string | null
  account: string
  amountText: string
  /** 带正负 */
  amount: number | null
  rateText: string
  rate: number | null
  bank_ref: string
  cheque_no: string
  note: string
  parts: MovePart[]
  notes: Note[]
}

export type Ignored = { row: number; reason: 'total' | 'no_amount' | 'orphan' }

const toPart = (r: Raw): MovePart => ({
  row: r.row,
  module: r.module,
  counterparty: r.counterparty,
  summary: r.summary,
  splitText: r.splitText,
  split: r.split,
  usd: r.usd,
  vin: r.vin,
  nature: r.nature,
})

export function groupMoves(rows: unknown[][], headerRow: number, m: JMapping): { moves: Move[]; ignored: Ignored[] } {
  const moves: Move[] = []
  const ignored: Ignored[] = []
  let cur: Move | null = null
  for (let i = Math.max(headerRow, 1); i < rows.length; i++) {
    const cells = rows[i] ?? []
    const any = J_FIELDS.some((f) => m[f.key] !== undefined && clean(cells[m[f.key] as number]) !== '')
    if (!any) continue // 空行
    const r = readRow(cells, i + 1, m)
    if (cells.some((c) => TOTAL_ROW.test(clean(c)))) {
      ignored.push({ row: r.row, reason: 'total' })
      continue
    }
    if (r.amountText) {
      cur = {
        key: r.row,
        rows: [r.row],
        dateText: r.dateText,
        date: r.date,
        account: r.account,
        amountText: r.amountText,
        amount: r.amount,
        rateText: r.rateText,
        rate: r.rate,
        bank_ref: r.bank_ref,
        cheque_no: r.cheque_no,
        note: r.note,
        parts: [toPart(r)],
        notes: r.both ? [{ level: 'error', key: '这一行「收入」「支出」都写了，一行只能是一笔收或一笔付' }] : [],
      }
      moves.push(cur)
      continue
    }
    if (r.splitText) {
      // 没写金额、写了拆分金额：上面那一笔钱里的另一种业务。日期、账户写了的要和上面那一笔一样
      if (!cur) {
        ignored.push({ row: r.row, reason: 'orphan' })
        continue
      }
      if ((r.dateText && r.date !== cur.date) || (r.account && acctKey(r.account) !== acctKey(cur.account)))
        cur.notes.push({
          level: 'error',
          key: '第 {row} 行没写收/支款金额，是第 {first} 行那一笔的拆分，可日期或账户和它不一样',
          vars: { row: r.row, first: cur.key },
        })
      cur.rows.push(r.row)
      cur.parts.push(toPart(r))
      continue
    }
    ignored.push({ row: r.row, reason: 'no_amount' })
  }
  return { moves, ignored }
}

// ---------------------------------------------------------------- 业务模块
const modNorm = (s: string) =>
  s
    .toLowerCase()
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[\s_\-－—/]+/g, '')
const MODULE_BY = new Map<string, string>()
for (const mod of JOURNAL_MODULES) {
  MODULE_BY.set(modNorm(mod.name), mod.name)
  if (EN[mod.name]) MODULE_BY.set(modNorm(EN[mod.name]), mod.name)
}
/** 表里写的业务模块 → 系统里的（英文名也认）；认不出 null */
export const matchModule = (text: string): string | null => MODULE_BY.get(modNorm(text)) ?? null
const TRANSFER_MODULES = new Set(JOURNAL_MODULES.filter((x) => x.transfer).map((x) => x.name))
const MODULE_DIR = new Map(JOURNAL_MODULES.map((x) => [x.name, x.dir]))
const CASH_IN = new Set(['现金存现', '现金存现-库马西'])
const CASH_OUT = new Set(['银行取现'])

// ---------------------------------------------------------------- 对到系统里
export type ExistingEntry = {
  id: number
  entry_no: string
  entry_date: string
  account_id: number
  direction: 'in' | 'out'
  amount: number
  module: string
  peer_id: number | null
  /** 互转另一边的账户、金额 */
  peer_account_id: number | null
  peer_amount: number | null
  fee_of: number | null
}
export type LineLite = { id: number; account_id: number; line_date: string; amount: number; entry_id: number | null; receipt_id: number | null; ignored: boolean }

export type JStatus = 'new' | 'exists' | 'skip' | 'error'
/** 不导的原因：车款、车款和别的业务在一笔里、没写业务模块、账户选了不导（或没对上）、账户停用了、在期初日期之前、同一个账户一出一进互相抵消 */
export type SkipReason = 'receipt' | 'receipt_mixed' | 'no_module' | 'account' | 'inactive' | 'opening' | 'self'
/** 银行流水：free 已经导进来了、还没填（导入后试着对上）；none 还没有（等流水）；cash 现金账户，没有流水 */
export type LineState = 'free' | 'none' | 'cash'

export type JPart = { row: number; module: string; counterparty: string | null; summary: string | null; amount: number }

/** 一笔要导的：一笔收 / 付（可以分几种业务），或者一笔账户互转（转出、转入两行） */
export type JItem = {
  key: number
  rows: number[]
  /** receipt = 车款，导成到账 */
  kind: 'in' | 'out' | 'transfer' | 'receipt' | null
  status: JStatus
  skip: SkipReason | null
  date: string | null
  /** 收付的账户；互转是转出的账户 */
  account_id: number | null
  account_text: string
  to_account_id: number | null
  to_account_text: string
  currency: string
  to_currency: string
  /** 正数 */
  amount: number | null
  to_amount: number | null
  module: string
  counterparty: string
  summary: string
  parts: JPart[]
  fx_rate: number | null
  bank_ref: string
  cheque_no: string
  note: string
  /** 账户互转的另一边怎么来的：文件里配上的一行 / 摘要里写的账户 / 选的现金账户 */
  other: 'file' | 'summary' | 'cash' | null
  /** 银行流水对得上吗（收付是这个账户；互转是转出那边） */
  line: LineState | null
  /** 互转转入那边 */
  toLine: LineState | null
  existing: ExistingEntry | null
  /** 车款：整理好的到账（拆到哪几台车、汇率、系统里已有的那张） */
  receipt: PReceipt | null
  /** 很可能已经记过了（日期差几天的同一笔、同金额的流水已经填了）：默认不勾 */
  suspect: boolean
  errors: Issue[]
  warnings: Issue[]
  infos: Issue[]
}

/** 车款导成到账要的：车、客户、业务员、款项性质、汇率、系统里已有的到账（和到账录入的批量导入一样） */
export type JReceiptCtx = Omit<ReceiptCtx, 'accountFor' | 'accountById' | 'today'>

export type JCtx = {
  /** 文件里的账户写法 → 系统账户 id；'skip' = 这个账户不导；undefined = 没对上 */
  accountFor: (text: string) => number | 'skip' | undefined
  accountById: Map<number, Account>
  /** 现金存现、银行取现的另一边：按币种选的现金账户 */
  cashFor: (currency: string) => number | undefined
  existing: ExistingEntry[]
  lines: LineLite[]
  /** 这次刚导进去的：哪一笔（key）存成了哪一笔（id，互转是转出那一边）。查重时先认回自己那笔 */
  pinned?: Map<number, number>
  /** 车款：没有就不导成到账（跳过） */
  receipt?: JReceiptCtx
  today?: string
}

const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000)
const amtKey = (n: number) => round2(n).toFixed(2)
export const rowRange = (rows: number[]) => {
  const s = [...rows].sort((a, b) => a - b)
  return s.length > 1 && s[s.length - 1] - s[0] === s.length - 1 ? `${s[0]}–${s[s.length - 1]}` : s.join('、')
}

/** 摘要里写的另一个账户：资金拨付【8651户转7773户】、货币兑换【5662户塞地兑换美元至1727户】，自己的后 4 位以外那个；对不上唯一一个账户就不算 */
export function summaryOther(summary: string, own: Account, accounts: Account[]): number | null {
  const tails = [...summary.matchAll(/(\d{4})\s*户/g)].map((x) => x[1])
  // 银行账户：两个后 4 位，一个是自己；现金账户没有后 4 位，写一个就是银行那边（银行取现【7773户】）
  const others = tails.filter((x) => x !== own.last4)
  if (own.last4 ? tails.length < 2 || others.length !== tails.length - 1 : !tails.length) return null
  if (new Set(others).size !== 1) return null
  const hits = accounts.filter((a) => a.kind === 'bank' && a.last4 === others[0] && a.id !== own.id)
  return hits.length === 1 ? hits[0].id : null
}

/** 一笔钱的日期：日期那一格空着的，用摘要里写的「日期：2026-11-02」（报款的格式） */
export function moveDate(mv: Pick<Move, 'date' | 'dateText' | 'parts'>): string | null {
  if (mv.dateText) return mv.date
  const m = (mv.parts[0]?.summary ?? '').match(/日期\s*[:：]\s*(\d{4}\s*[-./年]\s*\d{1,2}\s*[-./月]\s*\d{1,2})/)
  return m ? parseReceiptDate(m[1]) : null
}

/** 整理中的一笔：带着表里那一笔钱；half = 账户互转只有这一边、另一边找不到时的原因（查重时系统里有就算已有，没有才报） */
type Base = JItem & { move: Move; half?: Issue; halfOut?: boolean }

/** 一笔钱 → 一笔收付；账户互转的先单独一边，下面再配 */
function baseItem(mv: Move, ctx: JCtx, today: string): Base {
  const errors: Issue[] = mv.notes.filter((n) => n.level === 'error').map(({ key, vars }) => ({ key, vars }))
  const warnings: Issue[] = mv.notes.filter((n) => n.level === 'warn').map(({ key, vars }) => ({ key, vars }))
  const infos: Issue[] = []
  let skip: SkipReason | null = null

  // ---- 业务模块：车款、没写的跳过；认不出的、互转和别的放在一起的不行
  const parts = mv.parts.map((p) => ({ ...p, mod: p.module ? matchModule(p.module) : null }))
  const blank = parts.filter((p) => !p.module)
  if (blank.length === parts.length) skip = 'no_module'
  else if (blank.length) errors.push({ key: '第 {rows} 行没写业务模块', vars: { rows: rowRange(blank.map((p) => p.row)) } })
  for (const p of parts) if (p.module && !p.mod) errors.push({ key: '第 {row} 行：业务模块“{text}”系统里没有', vars: { row: p.row, text: p.module } })
  // 车款：整笔都是车款的导成到账；和别的业务在一笔里的跳过（导流水以后在银行对账里录成到账、再填剩下的）
  const cars = parts.filter((p) => p.mod === RECEIPT_MODULE)
  const receipt = !skip && cars.length > 0 && cars.length === parts.length
  if (!skip && cars.length && !receipt) skip = 'receipt_mixed'
  const transfer = parts.some((p) => p.mod && TRANSFER_MODULES.has(p.mod))
  if (transfer && parts.length > 1) errors.push({ key: '账户互转不能和别的业务放在一笔里，请分开写' })

  // ---- 账户
  const res = ctx.accountFor(mv.account)
  const acc = typeof res === 'number' ? ctx.accountById.get(res) : undefined
  if (res === 'skip') skip ??= 'account'
  else if (!acc) errors.push(mv.account ? { key: '账户“{text}”没对上，请在“账户对照”里选', vars: { text: mv.account } } : { key: '账户空着' })

  // ---- 日期、金额。日期空着的看摘要里有没有写「日期：2026-11-02」（报款的格式）
  const date = moveDate(mv)
  if (!mv.dateText) {
    if (date) infos.push({ key: '日期空着，用的是摘要里写的日期 {date}', vars: { date } })
    else errors.push({ key: '日期空着' })
  } else if (!date) errors.push({ key: '日期“{text}”认不出来', vars: { text: mv.dateText } })
  if (date && date > today) errors.push({ key: '日期 {date} 在今天以后', vars: { date } })
  if (mv.amount === null) errors.push({ key: '金额“{text}”不是数字', vars: { text: mv.amountText } })
  else if (round2(mv.amount) === 0) errors.push({ key: '金额是 0' })
  const total = mv.amount !== null && round2(mv.amount) !== 0 ? round2(Math.abs(mv.amount)) : null
  const kind: 'in' | 'out' | null = total === null ? null : (mv.amount ?? 0) > 0 ? 'in' : 'out'
  if (receipt && kind === 'out') errors.push({ key: '车款（设备回款）这一笔是付出去的钱，到账只能是收进来的，请核对' })

  // ---- 几种业务：一行的是整笔；几行的每行写拆分金额（解款表收为正、付为负，都写正数也认），加起来等于这笔钱
  let amounts: (number | null)[] = parts.map(() => null)
  if (parts.length === 1 && parts[0].splitText === '') amounts = [total]
  else {
    const bad = parts.filter((p) => p.splitText && p.split === null)
    for (const p of bad) errors.push({ key: '第 {row} 行：拆分金额“{text}”不是数字', vars: { row: p.row, text: p.splitText } })
    const none = parts.filter((p) => !p.splitText)
    if (none.length) errors.push({ key: '第 {rows} 行没写拆分金额', vars: { rows: rowRange(none.map((p) => p.row)) } })
    const vals = parts.map((p) => p.split)
    if (!bad.length && !none.length && total !== null) {
      const sign = Math.sign(mv.amount ?? 0)
      const same = vals.every((v) => v !== null && Math.sign(v) === sign)
      const allPos = vals.every((v) => v !== null && v > 0)
      if (!same && !allPos) errors.push({ key: '拆分金额有正有负，几种业务要么都是收、要么都是付' })
      else {
        amounts = vals.map((v) => round2(Math.abs(v ?? 0)))
        const sum = round2(amounts.reduce<number>((s, x) => s + (x ?? 0), 0))
        if (amounts.some((x) => !x)) errors.push({ key: '拆分金额不能是 0' })
        else if (Math.abs(sum - total) >= 0.005)
          errors.push({ key: '拆分金额加起来是 {sum}，收/支款金额是 {total}，对不上', vars: { sum: money(sum), total: money(total) } })
      }
    }
  }
  const jparts: JPart[] = parts.map((p, i) => ({
    row: p.row,
    module: p.mod ?? p.module,
    counterparty: p.counterparty || null,
    summary: p.summary || null,
    amount: amounts[i] ?? 0,
  }))
  // 数据库里客户 / 供应商最多 200 字、摘要最多 500 字：长的截掉，提醒一下
  for (const p of jparts) {
    if (p.counterparty && p.counterparty.length > 200) {
      p.counterparty = p.counterparty.slice(0, 200)
      warnings.push({ key: '第 {row} 行：客户 / 供应商超过 {n} 字，只导前 {n} 字', vars: { row: p.row, n: 200 } })
    }
    if (p.summary && p.summary.length > 500) {
      p.summary = p.summary.slice(0, 500)
      warnings.push({ key: '第 {row} 行：摘要超过 {n} 字，只导前 {n} 字', vars: { row: p.row, n: 500 } })
    }
  }

  // ---- 摘要：第一种业务的；都没写就用业务模块 + 客户
  const first = jparts[0]
  let summary = jparts.find((p) => p.summary)?.summary ?? ''
  if (!summary && !skip && first?.module) {
    summary = [first.module, first.counterparty].filter(Boolean).join(' ')
    infos.push({ key: '摘要空着，记成“{text}”', vars: { text: summary } })
  }

  // ---- 收进来的记成了付款的业务（或者反过来）：数据库不拦，提醒核对
  if (!skip && kind && !receipt)
    for (const p of jparts) {
      const dir = MODULE_DIR.get(p.module)
      if (dir && dir !== kind)
        warnings.push({
          key: dir === 'in' ? '第 {row} 行：「{module}」一般是收进来的钱，这一笔是付出去的，请核对' : '第 {row} 行：「{module}」一般是付出去的钱，这一笔是收进来的，请核对',
          vars: { row: p.row, module: p.module },
        })
    }

  // ---- 汇率：本币账户写了就用（1 美元换多少本币），没写数据库按基础资料的汇率。车款的汇率下面整理到账时再看
  let fx_rate: number | null = null
  if (mv.rateText && mv.rate === null) warnings.push({ key: '汇率“{text}”不是数字，没用', vars: { text: mv.rateText } })
  if (acc && acc.currency !== 'USD' && mv.rate !== null && mv.rate > 0 && !receipt) {
    if (mv.rate >= 1) fx_rate = mv.rate
    else warnings.push({ key: '汇率 {rate} 看着不对（是 1 美元换多少 {currency}），没用', vars: { rate: mv.rate, currency: acc.currency } })
  }

  return {
    move: mv,
    key: mv.key,
    rows: mv.rows,
    kind: transfer ? 'transfer' : receipt ? 'receipt' : kind,
    status: 'new',
    skip,
    date,
    account_id: acc?.id ?? null,
    account_text: mv.account,
    to_account_id: null,
    to_account_text: '',
    currency: acc?.currency ?? '',
    to_currency: '',
    amount: total,
    to_amount: null,
    module: first?.module ?? '',
    counterparty: first?.counterparty ?? '',
    summary,
    parts: jparts,
    fx_rate,
    bank_ref: mv.bank_ref,
    cheque_no: mv.cheque_no,
    note: mv.note,
    other: null,
    line: null,
    toLine: null,
    existing: null,
    receipt: null,
    suspect: false,
    errors,
    warnings,
    infos,
  }
}

// ---------------------------------------------------------------- 车款 → 到账
/** resolveReceipts 提醒「很像的一笔」用的话（这里拿来认：有这句的默认不勾） */
const NEAR_RECEIPT = '系统里有一笔很像的：{no}（{date}，同账户同金额），请确认不是同一笔'
/** 摘要里的大架号：17 位（没有 I、O、Q），有字母、至少 4 个数字；一个摘要里可以写几个 */
export function summaryVins(text: string): string[] {
  const out: string[] = []
  for (const m of text.toUpperCase().matchAll(/(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/g)) {
    const v = m[0]
    if (/[A-Z]/.test(v) && (v.match(/[0-9]/g)?.length ?? 0) >= 4 && !out.includes(v)) out.push(v)
  }
  return out
}

/** 款项性质的说法：先认首付，再分期（分期款尾款也是分期），再尾款、预付，最后全款 */
const NATURE_WORDS: [RegExp, string][] = [
  [/首付/, '首付款'],
  [/分期|月供|逾期/, '分期款'],
  [/尾款|余款/, '全款尾款'],
  [/预付|预收|定金|订金/, '预付款'],
  [/全款/, '全款'],
]
/** 款项性质：写了「款项类型：预付款」的照它，不然看摘要里的字；认不出返回空（按车猜，没车的先按全款） */
export function natureFromText(text: string): string {
  const m = text.match(/款项(?:类型|性质)\s*[:：]\s*([^\s,，;；。]+)/)
  const s = m ? m[1] : text
  for (const [re, name] of NATURE_WORDS) if (re.test(s)) return name
  return ''
}

/** 一笔车款 → 到账录入批量导入的一笔（Draft），交给 resolveReceipts 认车、客户、款项性质、汇率、查重 */
function receiptDraft(it: Base): { draft: Draft; infos: Issue[] } {
  const mv = it.move
  const infos: Issue[] = []
  const many = mv.parts.length > 1
  // 大架号：大架号列写了用它，没写的看摘要
  const own = mv.parts.map((p) => {
    const col = splitVins(p.vin)
    return col.vins.length || col.short.length ? { ...col, col: true } : { vins: summaryVins(p.summary), short: [] as string[], col: false }
  })
  // 几行拆分抄的是同一个摘要（解款表常这样）：摘要里的大架号是整笔的。个数和行数一样的按顺序一行一台；只有一个的都是这台；对不上的先不认车
  if (many && own.every((o) => !o.col) && new Set(mv.parts.map((p) => p.summary)).size === 1 && own[0].vins.length) {
    const all = own[0].vins
    if (all.length === mv.parts.length) {
      own.forEach((o, i) => (o.vins = [all[i]]))
      infos.push({ key: '摘要里写了 {k} 个大架号、拆成了 {k} 行：按顺序一行一台车，请核对', vars: { k: all.length } })
    } else if (all.length > 1) {
      own.forEach((o) => (o.vins = []))
      infos.push({ key: '摘要里写了 {k} 个大架号、拆成了 {n} 行，分不清哪行是哪台车：先记在客户名下（大架号未锁定），导完在到账录入里选车', vars: { k: all.length, n: mv.parts.length } })
    }
  }
  const usds = mv.parts.map((p) => p.usd)
  const usd = usds.every((u) => u !== null && u > 0) ? round2(usds.reduce<number>((s, u) => s + (u ?? 0), 0)) : null
  const rate = mv.rate !== null && mv.rate > 0 ? Math.round(mv.rate * 1e6) / 1e6 : null
  const draft: Draft = {
    key: it.key,
    rows: it.rows,
    group: '',
    date: it.date,
    dateText: mv.dateText || (it.date ?? ''),
    dateFilled: false,
    account: mv.account,
    accountFilled: false,
    amountText: mv.amountText,
    amount: it.amount,
    amountCur: null,
    // 汇率不是数字的上面提醒过了：这里当没写，按 金额 ÷ USD 或者基础资料里的汇率
    rateText: rate === null ? '' : String(rate),
    rate,
    usdText: usd === null ? '' : String(usd),
    usd,
    payer: it.summary,
    bank_ref: mv.bank_ref,
    cheque_no: mv.cheque_no,
    note: mv.note,
    lines: mv.parts.map((p, i) => ({
      row: p.row,
      vins: own[i].vins,
      shortVins: own[i].short,
      customer: p.counterparty,
      nature: p.nature ? natureFromText(p.nature) || p.nature : natureFromText(p.summary),
      // 一行的是整笔（写了几个大架号的按余额或平均分）；几行的照拆分金额
      claimText: many ? String(it.parts[i].amount) : '',
      claim: many ? it.parts[i].amount : null,
      salesperson: '',
      model: '',
    })),
    notes: [],
    bare: false,
  }
  return { draft, infos }
}

type Leg = { it: Base; acc: Account; out: boolean; amount: number; date: string; hint: number | null }

/** 账户互转：转出、转入两行配成一笔；配不上的按摘要里的账户、选的现金账户补另一边 */
function pairTransfers(base: Base[], ctx: JCtx): Base[] {
  const all = [...ctx.accountById.values()]
  const legs: Leg[] = []
  for (const it of base) {
    if (it.kind !== 'transfer' || it.skip || it.errors.length || !it.account_id || !it.date || !it.amount) continue
    const acc = ctx.accountById.get(it.account_id)!
    legs.push({ it, acc, out: it.move.amount! < 0, amount: it.amount, date: it.date, hint: summaryOther(it.summary, acc, all) })
  }
  const outs = legs.filter((l) => l.out)
  const ins = legs.filter((l) => !l.out)
  const fits = (o: Leg, i: Leg) =>
    o.it.module === i.it.module &&
    o.acc.id !== i.acc.id &&
    Math.abs(days(o.date, i.date)) <= 3 &&
    (o.acc.currency !== i.acc.currency || Math.abs(o.amount - i.amount) < 0.005) &&
    (o.hint === null || o.hint === i.acc.id) &&
    (i.hint === null || i.hint === o.acc.id)
  const score = (o: Leg, i: Leg) => (o.hint === i.acc.id ? 1 : 0) + (i.hint === o.acc.id ? 1 : 0)
  const usedO = new Set<Leg>()
  const usedI = new Set<Leg>()
  const pairs: [Leg, Leg][] = []
  const take = (o: Leg, i: Leg) => {
    pairs.push([o, i])
    usedO.add(o)
    usedI.add(i)
  }
  // 先配两边摘要都写了对方的，再配一边写了的：同一天几笔的，大的配大的（换汇时钱多的换得多）
  const byDate = (a: Leg, b: Leg) => a.date.localeCompare(b.date) || b.amount - a.amount || a.it.key - b.it.key
  for (const need of [2, 1]) {
    for (const o of [...outs].sort(byDate)) {
      if (usedO.has(o)) continue
      const c = ins
        .filter((i) => !usedI.has(i) && fits(o, i) && score(o, i) >= need)
        .sort((a, b) => Math.abs(days(o.date, a.date)) - Math.abs(days(o.date, b.date)) || b.amount - a.amount || a.it.key - b.it.key)
      if (c.length) take(o, c[0])
    }
  }
  // 两边都没写对方的：只认一对一（这一行只有那一行能配，那一行也只有这一行能配）
  for (const o of [...outs].sort(byDate)) {
    if (usedO.has(o)) continue
    const c = ins.filter((i) => !usedI.has(i) && fits(o, i))
    if (c.length !== 1) continue
    const back = outs.filter((x) => !usedO.has(x) && fits(x, c[0]))
    if (back.length === 1) take(o, c[0])
  }

  const out: Base[] = []
  const merged = new Set<Base>()
  for (const [o, i] of pairs) {
    merged.add(o.it)
    merged.add(i.it)
    const it: Base = {
      ...o.it,
      key: Math.min(o.it.key, i.it.key),
      rows: [...o.it.rows, ...i.it.rows].sort((a, b) => a - b),
      to_account_id: i.acc.id,
      to_account_text: i.it.account_text,
      to_currency: i.acc.currency,
      to_amount: i.amount,
      summary: o.it.summary || i.it.summary,
      other: 'file',
      warnings: [...o.it.warnings, ...i.it.warnings],
      infos: [...o.it.infos, ...i.it.infos],
    }
    if (o.date !== i.date) it.infos.push({ key: '转出 {a}、转入 {b}，一起记在 {a}', vars: { a: o.date, b: i.date } })
    out.push(it)
  }

  // 同一个账户一出一进、金额一样（退回、几个现金箱对成了同一个账户）：互相抵消，两行都不导
  const rest = legs.filter((l) => !usedO.has(l) && !usedI.has(l))
  const self = new Set<Leg>()
  for (const o of rest.filter((l) => l.out).sort(byDate)) {
    const i = rest.find(
      (x) => !x.out && !self.has(x) && x.acc.id === o.acc.id && x.it.module === o.it.module && Math.abs(x.amount - o.amount) < 0.005 && Math.abs(days(x.date, o.date)) <= 3,
    )
    if (!i) continue
    self.add(o)
    self.add(i)
    merged.add(o.it)
    merged.add(i.it)
    out.push({ ...o.it, key: Math.min(o.it.key, i.it.key), rows: [...o.it.rows, ...i.it.rows].sort((a, b) => a - b), skip: 'self' })
  }

  const fileAccounts = new Set(base.map((b) => b.account_id).filter((x): x is number => !!x))
  for (const l of rest) {
    if (self.has(l)) continue
    merged.add(l.it)
    const it: Base = { ...l.it, warnings: [...l.it.warnings], infos: [...l.it.infos], errors: [...l.it.errors] }
    const mod = it.module
    const cashLeg = l.acc.kind !== 'bank'
    let other: number | null = null
    if (CASH_IN.has(mod) || CASH_OUT.has(mod)) {
      // 存现：现金 → 银行；取现：银行 → 现金。银行账户上存现是收、取现是付；现金账户上反过来
      const wantOut = cashLeg ? CASH_IN.has(mod) : CASH_OUT.has(mod)
      if (wantOut !== l.out)
        it.errors.push({
          key: wantOut ? '「{module}」在这个账户上应该是付出去的钱，这一行却是收进来的' : '「{module}」在这个账户上应该是收进来的钱，这一行却是付出去的',
          vars: { module: mod },
        })
      else if (!cashLeg) {
        other = ctx.cashFor(l.acc.currency) ?? null
        if (!other) it.errors.push({ key: '{currency} 的现金账户没选（在“账户对照”下面选现金存现、银行取现记到哪个现金账户）', vars: { currency: l.acc.currency } })
        else it.other = 'cash'
      } else if (l.hint && ctx.accountById.get(l.hint)?.currency === l.acc.currency) {
        other = l.hint
        it.other = 'summary'
      } else
        it.half = {
          key: '「{module}」的银行那一边找不到：先在银行日记账里导银行那一边，这一行就会认成系统里已有；或者在摘要里写上银行账户的后 4 位（如 7773户）',
          vars: { module: mod },
        }
    } else if (l.hint) {
      const o = ctx.accountById.get(l.hint)!
      if (o.currency !== l.acc.currency)
        it.half = { key: '货币兑换只找到这一边（{acct} 那边文件里没有对应的一行），不知道换了多少，请在表里补上另一边', vars: { acct: o.short_name } }
      else {
        other = o.id
        it.other = 'summary'
        if (fileAccounts.has(o.id))
          it.warnings.push({ key: '摘要里写的另一边“{acct}”在文件里没找到对应的一行（前后 3 天、同金额），导进去那边记一笔等流水，请核对', vars: { acct: o.short_name } })
        else it.infos.push({ key: '另一边“{acct}”不在这个文件里，按摘要记，那边等流水', vars: { acct: o.short_name } })
      }
    } else
      it.half = {
        key: '账户互转找不到另一边：表里两边都写上（转出写负数、转入写正数），或者摘要里写清两个账户，如 资金拨付【8651户转7773户】',
      }
    if (other) {
      const oa = ctx.accountById.get(other)!
      if (l.out) {
        it.to_account_id = oa.id
        it.to_account_text = oa.short_name
        it.to_currency = oa.currency
        it.to_amount = l.amount
      } else {
        // 只有转入这一边：转出的是另一个账户
        it.to_account_id = l.acc.id
        it.to_account_text = it.account_text
        it.to_currency = l.acc.currency
        it.to_amount = l.amount
        it.account_id = oa.id
        it.account_text = oa.short_name
        it.currency = oa.currency
      }
    } else if (!l.out) {
      // 配不上的转入那一边：页面上照样显示在转入的账户上
      it.to_account_id = l.acc.id
      it.to_account_text = it.account_text
      it.to_currency = l.acc.currency
      it.to_amount = l.amount
      it.account_id = null
      it.account_text = ''
      it.currency = ''
    }
    if (it.half) it.halfOut = l.out
    if (it.summary === '' && it.account_id && it.to_account_id) it.summary = transferSummary(mod, ctx.accountById.get(it.account_id), ctx.accountById.get(it.to_account_id))
    out.push(it)
  }
  return [...base.filter((b) => !merged.has(b)), ...out].sort((a, b) => a.key - b.key)
}

export function resolveItems(moves: Move[], ctx: JCtx): JItem[] {
  const today = ctx.today ?? todayAccra()
  const items = pairTransfers(
    moves.map((m) => baseItem(m, ctx, today)),
    ctx,
  )

  // ---- 账户停用了的不导（要导先到基础资料里启用）；在期初日期之前的不导（日记账里不算）。车款照导：车辆台账要算
  for (const it of items) {
    if (it.skip) continue
    const accs = [it.account_id, it.to_account_id].map((id) => (id ? ctx.accountById.get(id) : undefined)).filter((a): a is Account => !!a)
    const before = !!it.date && accs.some((a) => a.opening_date && it.date! < a.opening_date)
    if (accs.some((a) => !a.active)) it.skip = 'inactive'
    else if (before && it.kind === 'receipt') it.infos.push({ key: '在账户的期初日期之前：日记账里不显示，车辆台账照算' })
    else if (before) it.skip = 'opening'
  }

  // ---- 车款：和到账录入的批量导入一样整理成到账（认车、客户、款项性质、汇率），和系统里的到账查重。没给到账要的资料（没有到账录入的权限）就不导
  const cars = items.filter((it) => it.kind === 'receipt' && !it.skip && !it.errors.length)
  if (!ctx.receipt) for (const it of cars) it.skip = 'receipt'
  else if (cars.length) {
    const ds = cars.map(receiptDraft)
    const ps = resolveReceipts(
      ds.map((d) => d.draft),
      {
        ...ctx.receipt,
        accountFor: (t) => {
          const r = ctx.accountFor(t)
          return typeof r === 'number' ? r : undefined
        },
        accountById: ctx.accountById,
        today,
      },
    )
    cars.forEach((it, i) => {
      const p = ps[i]
      it.receipt = p
      it.fx_rate = p.fx_rate
      it.errors.push(...p.errors)
      it.warnings.push(...p.warnings)
      it.infos.push(...ds[i].infos, ...p.infos)
      // 日期差几天的同一笔（到账录入里已经录过的，日期按银行的写了）：默认不勾
      if (p.warnings.some((w) => w.key === NEAR_RECEIPT)) it.suspect = true
    })
  }

  // ---- 查重：收付按 账户 + 方向 + 金额 + 同一天，一笔对一笔；互转按 两个账户 + 金额 + 前后 3 天；
  //      找不到另一边的互转（只有这一边）：系统里这个账户上同方向、同金额、前后 3 天有一笔互转，就是另一本日记账导过、记过了
  const pinned = ctx.pinned ?? new Map<number, number>()
  const used = new Set<number>()
  const byKey = new Map<string, ExistingEntry[]>()
  for (const e of ctx.existing) {
    if (e.peer_id !== null) continue
    const k = `${e.account_id}|${e.direction}|${amtKey(e.amount)}`
    byKey.set(k, [...(byKey.get(k) ?? []), e])
  }
  const transfers = ctx.existing.filter((e) => e.peer_id !== null && e.direction === 'out')
  const legsOf = ctx.existing.filter((e) => e.peer_id !== null)
  const live = items.filter((it) => !it.skip && !it.errors.length)
  const rank = (it: JItem) => (pinned.has(it.key) ? 0 : 1)
  const order = [...live].sort((a, b) => rank(a) - rank(b) || a.key - b.key)
  const keyOf = (it: JItem) => `${it.account_id}|${it.kind}|${amtKey(it.amount ?? 0)}`
  const near3 = (d: string, it: JItem) => Math.abs(days(d, it.date!)) <= 3
  for (const it of order) {
    if (it.kind === 'receipt') continue
    if (it.half) {
      const own = it.halfOut ? it.account_id : it.to_account_id
      const amt = it.halfOut ? it.amount : it.to_amount
      const same = legsOf
        .filter((e) => !used.has(e.id) && e.account_id === own && e.direction === (it.halfOut ? 'out' : 'in') && Math.abs(e.amount - (amt ?? 0)) < 0.005 && near3(e.entry_date, it))
        .sort((a, b) => Math.abs(days(a.entry_date, it.date!)) - Math.abs(days(b.entry_date, it.date!)))[0]
      if (same) {
        used.add(same.id)
        it.existing = same
      } else it.errors.push(it.half)
      continue
    }
    if (it.kind === 'transfer') {
      const ok = (e: ExistingEntry) =>
        !used.has(e.id) && e.account_id === it.account_id && e.peer_account_id === it.to_account_id && Math.abs(e.amount - (it.amount ?? 0)) < 0.005 && near3(e.entry_date, it)
      const mine = pinned.has(it.key) ? transfers.find((e) => e.id === pinned.get(it.key) && ok(e)) : undefined
      const same = mine ?? transfers.filter(ok).sort((a, b) => Math.abs(days(a.entry_date, it.date!)) - Math.abs(days(b.entry_date, it.date!)))[0]
      if (same) {
        used.add(same.id)
        it.existing = same
      }
      continue
    }
    const list = byKey.get(keyOf(it)) ?? []
    const mine = pinned.has(it.key) ? list.find((e) => e.id === pinned.get(it.key) && !used.has(e.id) && e.entry_date === it.date) : undefined
    const same = mine ?? list.find((e) => !used.has(e.id) && e.entry_date === it.date)
    if (same) {
      used.add(same.id)
      it.existing = same
    }
  }
  // 找不到另一边、也没导过的：上面已经记成有问题。别的没对上的半边（还有别的问题）也把原因加上
  for (const it of items) if (it.half && !it.existing && !it.errors.includes(it.half)) it.errors.push(it.half)
  // 日期差几天的同一笔：提醒一下，默认不勾
  for (const it of order) {
    if (it.existing || it.kind === 'transfer' || it.kind === 'receipt' || it.errors.length) continue
    const near = (byKey.get(keyOf(it)) ?? []).find((e) => !used.has(e.id) && near3(e.entry_date, it))
    if (near) {
      it.suspect = true
      it.warnings.push({ key: '系统里有一笔很像的：{no}（{date}，同账户同金额），请确认不是同一笔', vars: { no: near.entry_no, date: near.entry_date } })
    }
  }

  // ---- 银行流水：同账户、同金额、前后 3 天，还没填的有没有（导入后试着对上）；只有已经填了的，多半已经记过了
  const lineBy = new Map<string, LineLite[]>()
  for (const l of ctx.lines) {
    const k = `${l.account_id}|${amtKey(l.amount)}`
    lineBy.set(k, [...(lineBy.get(k) ?? []), l])
  }
  const entryById = new Map(ctx.existing.map((e) => [e.id, e]))
  const usedReceipt = new Set(items.map((it) => it.receipt?.existing?.id).filter((x): x is number => !!x))
  const usedLine = new Set<number>()
  const lineFor = (accountId: number | null, signed: number, date: string): { state: LineState; taken: LineLite | null } => {
    const a = accountId ? ctx.accountById.get(accountId) : undefined
    if (!a || a.kind !== 'bank') return { state: 'cash', taken: null }
    const near = (lineBy.get(`${a.id}|${amtKey(signed)}`) ?? []).filter((l) => Math.abs(days(l.line_date, date)) <= 3)
    const free = near
      .filter((l) => !usedLine.has(l.id) && !l.entry_id && !l.receipt_id && !l.ignored)
      .sort((x, y) => Math.abs(days(x.line_date, date)) - Math.abs(days(y.line_date, date)))
    if (free.length) {
      usedLine.add(free[0].id)
      return { state: 'free', taken: null }
    }
    // 填这条流水的那一笔已经算给文件里别的行了（同金额的两笔，银行只导进来一条）：不算记过
    const taken = near.find((l) => (l.entry_id && !used.has(l.entry_id)) || (l.receipt_id && !usedReceipt.has(l.receipt_id)) || l.ignored) ?? null
    return { state: 'none', taken }
  }
  for (const it of order) {
    if (it.existing || it.receipt?.existing || it.errors.length || !it.date || !it.amount) continue
    if (it.kind === 'transfer') {
      it.line = lineFor(it.account_id, -it.amount, it.date).state
      it.toLine = lineFor(it.to_account_id, it.to_amount ?? 0, it.date).state
      continue
    }
    const r = lineFor(it.account_id, it.kind === 'out' ? -it.amount : it.amount, it.date)
    it.line = r.state
    if (r.taken) {
      it.suspect = true
      const e = r.taken.entry_id ? entryById.get(r.taken.entry_id) : undefined
      it.warnings.push(
        r.taken.entry_id
          ? { key: '银行流水 {date} 已经填成了“{module}”，可能已经记过了', vars: { date: r.taken.line_date, module: e?.module ?? '' } }
          : r.taken.receipt_id
            ? { key: '银行流水 {date} 已经配上了到账，可能已经记过了', vars: { date: r.taken.line_date } }
            : { key: '银行流水 {date} 已经忽略了，请核对', vars: { date: r.taken.line_date } },
      )
    }
  }

  for (const it of items) {
    if (it.skip) {
      it.status = 'skip'
      it.errors = []
      it.warnings = []
      it.infos = []
    } else it.status = it.existing || it.receipt?.existing ? 'exists' : it.errors.length ? 'error' : 'new'
  }
  return items.map(({ move: _m, half: _h, halfOut: _o, ...rest }) => rest)
}

/** 车款交给 save_receipt 的内容（和到账录入的批量导入一样） */
export const itemReceiptPayload = (it: JItem) => (it.receipt ? receiptPayload(it.receipt) : null)

/** 交给 save_cash_entry 的内容（和「记一笔银行交易」存的一样）；查重在预览里做过了，带 confirm_dup */
export function itemPayload(it: JItem): Record<string, Json> {
  const common = {
    entry_date: it.date,
    account_id: it.account_id,
    amount: it.amount,
    summary: it.summary,
    bank_ref: it.bank_ref || null,
    cheque_no: it.cheque_no || null,
    note: it.note || null,
    attachments: [] as string[],
    confirm_dup: true,
  }
  if (it.kind === 'transfer') return { ...common, kind: 'transfer', module: it.module, to_account_id: it.to_account_id, to_amount: it.to_amount }
  const split = it.parts.length > 1
  return {
    ...common,
    kind: it.kind,
    module: it.parts[0]?.module ?? it.module,
    counterparty: it.parts[0]?.counterparty ?? null,
    parts: split ? it.parts.map((p) => ({ module: p.module, counterparty: p.counterparty, summary: p.summary, amount: p.amount })) : null,
    fx_rate: it.fx_rate,
  }
}
