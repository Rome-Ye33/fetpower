import * as XLSX from 'xlsx'
import { round2 } from './format'
import { parseParts } from './journal'
import type { JournalLine } from './journal'

// 日记账导出 Excel，列照 Rome 的《终端解款表》排（日期、单号、业务模块、客户 / 供应商、入账人员、摘要……拆分金额、回款银行）。
// 一条流水分了几种业务（数据库 37）：每种一行，各写业务模块、客户、摘要、大架号、拆分金额；收入 / 支出、余额只写在第一行，
// 所以收入、支出两列加起来还是等于银行流水。拆分金额每行都写，收为正、付为负，没分的 = 整笔（和解款表一样），按业务模块汇总加这一列。

type T = (s: string, vars?: Record<string, string | number>) => string
type Cell = string | number | null

const AMT = '#,##0.00'
const RATE = '0.0000'

/** 一列：表头（已经翻译好）、列宽、数字格式 */
type Col = { key: string; title: string; width: number; fmt?: string }

/** 表头一行 + 数据，设好列宽、金额格式、自动筛选 */
function sheet(cols: Col[], rows: Record<string, Cell | undefined>[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([cols.map((c) => c.title), ...rows.map((r) => cols.map((c) => r[c.key] ?? null))])
  ws['!cols'] = cols.map((c) => ({ wch: c.width }))
  for (let i = 1; i <= rows.length; i++)
    cols.forEach((c, j) => {
      const cell = ws[XLSX.utils.encode_cell({ r: i, c: j })]
      if (c.fmt && cell && typeof cell.v === 'number') cell.z = c.fmt
    })
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: cols.length - 1 } }) }
  return ws
}

/** 文件名里不能有的字符换成 _ */
export const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim()

export function saveBook(sheetName: string, ws: XLSX.WorkSheet, fileName: string) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, fileSafe(sheetName).slice(0, 31))
  XLSX.writeFile(wb, `${fileSafe(fileName)}.xlsx`)
}

export type LedgerExport = {
  t: T
  lines: JournalLine[]
  /** 每条（key）记完以后的余额：只有选了一个账户、没筛选时才有 */
  balances: Map<string, number> | null
  /** 期初那一行：日期、余额 */
  opening: { date: string; amount: number } | null
  closing: number | null
  /** 只拆了一台车（或没拆）的到账：大架号（拆了两台以上的在 parts 里，每台一行） */
  vins: Map<number, string[]>
}

/** 日记账明细这一张表 */
export function ledgerSheet(o: LedgerExport): XLSX.WorkSheet {
  const { t } = o
  const cols: Col[] = [
    { key: 'date', title: t('日期'), width: 11 },
    { key: 'doc', title: t('单号'), width: 18 },
    { key: 'module', title: t('业务模块'), width: 12 },
    { key: 'who', title: t('客户 / 供应商'), width: 26 },
    { key: 'by', title: t('入账人员'), width: 10 },
    { key: 'summary', title: t('摘要'), width: 44 },
    { key: 'vin', title: t('大架号'), width: 20 },
    { key: 'cur', title: t('币别'), width: 6 },
    { key: 'rate', title: t('汇率'), width: 9, fmt: RATE },
    { key: 'usd', title: t('折美元'), width: 12, fmt: AMT },
    { key: 'split', title: t('拆分金额'), width: 14, fmt: AMT },
    { key: 'in', title: t('收入'), width: 14, fmt: AMT },
    { key: 'out', title: t('支出'), width: 14, fmt: AMT },
    ...(o.balances ? [{ key: 'bal', title: t('余额'), width: 16, fmt: AMT }] : []),
    { key: 'acct', title: t('账户'), width: 26 },
    { key: 'bank', title: t('银行摘要'), width: 40 },
    { key: 'ref', title: t('银行参考号'), width: 16 },
    { key: 'status', title: t('状态'), width: 8 },
  ]
  const rows: Record<string, Cell>[] = []
  if (o.opening) rows.push({ date: o.opening.date, summary: t('期初余额'), bal: o.opening.amount })
  let sumIn = 0
  let sumOut = 0
  for (const l of o.lines) {
    const inn = Number(l.amount_in ?? 0)
    const out = Number(l.amount_out ?? 0)
    sumIn += inn
    sumOut += out
    const sign = out ? -1 : 1
    const total = inn || out
    const rate = l.currency === 'USD' ? 1 : Number(l.fx_rate ?? 0) || null
    const usdOf = (x: number) => (rate ? round2(x / rate) : null)
    const todo = l.fill_status === '待填' || l.fill_status === '已忽略'
    // 互转没有客户：写转到哪个账户、从哪个账户转进来
    const who = l.peer_account_name
      ? out
        ? t('转到 {name}', { name: l.peer_account_name })
        : t('从 {name} 转入', { name: l.peer_account_name })
      : (l.counterparty ?? '')
    // 每行都一样的几列
    const same = {
      date: l.entry_date,
      by: l.created_by_name ?? '',
      cur: l.currency ?? '',
      rate,
      acct: l.account_name ?? '',
      bank: l.bank_summary ?? '',
      ref: l.bank_ref ?? '',
      status: l.fill_status ? t(l.fill_status) : '',
    }
    // 第一行才写收入 / 支出、余额
    const first = { in: inn || null, out: out || null, bal: o.balances?.get(l.key ?? `${l.source}-${l.source_id}`) ?? null }
    const parts = parseParts(l.parts)
    if (!parts.length) {
      rows.push({
        ...same,
        ...first,
        doc: l.doc_no ?? '',
        module: todo || !l.module ? '' : t(l.module),
        who,
        summary: l.summary || l.bank_summary || '',
        vin: l.receipt_id ? (o.vins.get(l.receipt_id) ?? []).join('、') : '',
        usd: usdOf(sign * total),
        split: sign * total,
      })
      continue
    }
    parts.forEach((p, i) =>
      rows.push({
        ...same,
        ...(i === 0 ? first : {}),
        doc: p.doc_no ?? l.doc_no ?? '',
        module: p.module ? t(p.module) : '',
        who: p.counterparty ?? '',
        summary: p.summary ?? '',
        vin: p.vin ?? '',
        usd: usdOf(sign * p.amount),
        split: sign * p.amount,
      }),
    )
    // 到账里还有没拆到车的钱：也写一行，几行的拆分金额加起来等于整笔
    const left = round2(total - parts.reduce((s, p) => s + p.amount, 0))
    if (left >= 0.005) {
      const rc = parts.find((p) => p.receipt_id)
      rows.push({
        ...same,
        doc: rc?.doc_no ?? l.doc_no ?? '',
        module: rc ? t(rc.module) : '',
        who: rc?.counterparty ?? '',
        summary: t('到账里还有没拆到车的'),
        usd: usdOf(sign * left),
        split: sign * left,
      })
    }
  }
  if (o.lines.length) rows.push({ summary: t('本期合计'), in: round2(sumIn), out: round2(sumOut), bal: o.closing })
  return sheet(cols, rows)
}

/** 账户余额导出的一行（页面上显示的字已经翻译好）：账户一行，或者组末按币种的合计 */
export type SummaryExportRow = {
  group: string
  currency: string
  account: string
  opening: number
  income: number
  expense: number
  closing: number
  bankBalance?: number | null
  bankDate?: string | null
  status?: string
}

/** 账户余额这一张表：每个账户一行，按分组，组末按币种合计（和页面一样） */
export function summarySheet(t: T, rows: SummaryExportRow[], bank: boolean, isLast: boolean): XLSX.WorkSheet {
  const cols: Col[] = [
    { key: 'group', title: t('分组'), width: 14 },
    { key: 'currency', title: t('币别'), width: 8 },
    { key: 'account', title: t('账户'), width: 30 },
    { key: 'opening', title: t('月初余额'), width: 16, fmt: AMT },
    { key: 'income', title: t('本月收款'), width: 16, fmt: AMT },
    { key: 'expense', title: t('本月支出'), width: 16, fmt: AMT },
    { key: 'closing', title: isLast ? t('现在余额') : t('月末余额'), width: 16, fmt: AMT },
    ...(bank
      ? [
          { key: 'bankBalance', title: t('银行余额'), width: 16, fmt: AMT },
          { key: 'bankDate', title: t('流水到'), width: 11 },
          { key: 'status', title: t('流水'), width: 14 },
        ]
      : []),
  ]
  return sheet(cols, rows)
}
