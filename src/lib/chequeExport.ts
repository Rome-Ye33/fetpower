import type * as XLSX from 'xlsx'
import { CHEQUE_STATUS_LABEL, chequeStatus, chequeVins } from './cheques'
import type { Cheque } from './cheques'
import { AMT, sheet } from './journalExport'
import type { Col } from './journalExport'

// 支票台账导出 Excel（Rome 2026-11-21「新增支票数据导出功能」）：导出台账上现在看得见的那些
// （状态、提醒、业务员、存票账户、到期日期、搜索、列头的筛选都照页面，见 ChequesPage），一张支票一行。
// 金额、分期款 USD 是数字（在 Excel 里能直接加）；空白支票的金额写「空白」。几台车的大架号、车型用「 / 」隔开，后面写台数。
// 日期都写成 2026-11-21 这样的文字，排序、筛选都对。

type T = (s: string, vars?: Record<string, string | number>) => string
type Cell = string | number | null

/** 支票台账这一张表；withSales：带不带「业务员」那一列（业务员只看自己的票时不带，和台账一样） */
export function chequeSheet(t: T, list: Cheque[], withSales: boolean): XLSX.WorkSheet {
  const cols: Col[] = [
    { key: 'status', title: t('状态'), width: 11 },
    { key: 'contract', title: t('合同序号'), width: 10 },
    { key: 'inst', title: t('第几期'), width: 7 },
    { key: 'count', title: t('共几期'), width: 7 },
    { key: 'cheque', title: t('支票号'), width: 12 },
    { key: 'bank', title: t('支票银行'), width: 14 },
    { key: 'customer', title: t('客户'), width: 28 },
    { key: 'drawer', title: t('支票名称'), width: 28 },
    { key: 'vins', title: t('大架号'), width: 22 },
    { key: 'models', title: t('车型'), width: 26 },
    { key: 'cars', title: t('台数'), width: 6 },
    ...(withSales ? [{ key: 'sales', title: t('业务员'), width: 14 }] : []),
    { key: 'purpose', title: t('用途'), width: 9 },
    { key: 'cur', title: t('币种'), width: 6 },
    { key: 'amount', title: t('金额'), width: 14, fmt: AMT },
    { key: 'usd', title: t('分期款 USD'), width: 12, fmt: AMT },
    { key: 'due', title: t('到期日期'), width: 11 },
    { key: 'plan', title: t('计划存票日期'), width: 12 },
    { key: 'dep', title: t('存票日期'), width: 11 },
    { key: 'acct', title: t('存票账户'), width: 24 },
    { key: 'rno', title: t('到账单号'), width: 18 },
    { key: 'rdate', title: t('到账日期'), width: 11 },
    { key: 'reason', title: t('退票 / 取消原因'), width: 24 },
    { key: 'note', title: t('备注'), width: 30 },
    { key: 'talk', title: t('最近沟通'), width: 40 },
  ]
  const rows: Record<string, Cell>[] = list.map((c) => {
    const vins = chequeVins(c)
    // 几台车是同一个车型（常见）就只写一次，和台账一样
    const models = [...new Set((c.models ?? c.model ?? '').split(' / ').filter(Boolean))]
    return {
      status: t(CHEQUE_STATUS_LABEL[chequeStatus(c.status)]),
      contract: c.contract_no ?? null,
      inst: c.installment_no ?? null,
      count: c.installment_count ?? null,
      cheque: c.cheque_no ?? null,
      bank: c.drawer_bank ?? null,
      customer: c.customer_name ?? null,
      drawer: c.drawer_name ?? null,
      vins: vins.length ? vins.join(' / ') : null,
      models: models.length ? models.join(' / ') : null,
      cars: vins.length || null,
      sales: c.salesperson_name ?? null,
      purpose: c.purpose ? t(c.purpose) : null,
      cur: c.currency ?? null,
      amount: c.amount == null ? t('空白') : Number(c.amount),
      usd: c.installment_usd == null ? null : Number(c.installment_usd),
      due: c.due_date ?? null,
      plan: c.plan_date ?? null,
      dep: c.deposit_date ?? null,
      acct: c.deposit_account_name ?? null,
      rno: c.receipt_no ?? null,
      rdate: c.receipt_date ?? null,
      reason: c.reason ?? null,
      note: c.note ?? null,
      talk: c.last_note ? `${(c.last_note_at ?? '').slice(0, 10)} ${c.last_note}`.trim() : null,
    }
  })
  return sheet(cols, rows)
}
