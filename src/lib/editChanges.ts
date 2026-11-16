// 审批通过以后改单据（42）：approval_logs 里 action = 'edit' 的那一行，changes = [{k: 哪一项, a: 改前, b: 改后}]，只记改了的。
// 到账：账户（简称）、日期、金额、汇率、支票号、付款方、参考号、内部备注、凭证（个数）、拆分（整张：大架号或客户、性质、原币金额、报款备注）。
// 提成单：表头各项、车辆（大架号、车型、单价、本车提成、备注）、付款（拆分编号、到账编号、大架号、日期、本单美元、备注）。
// 拆分、车辆、付款是整张清单：显示时比一比，只列去掉的和加上的。
import type { Json } from './database.types'
import { money } from './format'

export type EditChange = { k: string; a: Json; b: Json }
type Vars = Record<string, string | number | null | undefined>
export type Tr = (zh: string, vars?: Vars) => string

/** 不翻译，只填占位（打印的提成单用中文） */
export const zhOnly: Tr = (zh, vars) => zh.replace(/\{(\w+)\}/g, (m, k: string) => (vars && k in vars ? String(vars[k] ?? '') : m))

type Obj = { [k: string]: Json | undefined }
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x)

export function parseChanges(x: Json | null | undefined): EditChange[] {
  if (!Array.isArray(x)) return []
  const out: EditChange[] = []
  for (const c of x) if (isObj(c) && typeof c.k === 'string') out.push({ k: c.k, a: c.a ?? null, b: c.b ?? null })
  return out
}

/** 整张清单的那几项 */
export const isListKey = (k: string) => k === 'claims' || k === 'vehicles' || k === 'payments'

/** 哪一项（已翻译） */
export function changeLabel(k: string, t: Tr): string {
  switch (k) {
    // 到账
    case 'account':
      return t('收款账户')
    case 'receipt_date':
      return t('到账日期')
    case 'amount_orig':
      return t('到账金额')
    case 'fx_rate':
      return t('汇率')
    case 'cheque_no':
      return t('支票号')
    case 'payer_summary':
      return t('付款方 / 银行摘要')
    case 'bank_ref':
      return t('银行参考号')
    case 'note':
      return t('内部备注')
    case 'attachments':
      return t('凭证')
    case 'claims':
      return t('拆分到车')
    // 提成单
    case 'voucher_date':
      return t('日期')
    case 'dept':
      return t('申请部门')
    case 'salesperson':
      return t('业务员')
    case 'customer':
      return t('客户')
    case 'qty_model':
      return t('数量与设备型号')
    case 'vehicles':
      return t('车辆')
    case 'other_charges_usd':
      return t('其他费用（USD）')
    case 'charges_note':
      return t('费用说明')
    case 'discount_usd':
      return t('折扣（USD）')
    case 'full_payment':
      return t('是否全款')
    case 'down_payment_usd':
      return t('首付金额（USD）')
    case 'terms_count':
      return t('分期期数')
    case 'per_term_usd':
      return t('每期金额（USD）')
    case 'payments':
      return t('客户付款')
    case 'commission_usd':
      return t('提成金额（USD）')
    case 'payout_ratio':
      return t('本次发放比例')
    case 'payout_rate':
      return t('转赛地汇率')
    case 'remarks':
      return t('备注')
    default:
      return k
  }
}

const str = (v: Json | undefined): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** 一项的值（不是清单的）。cur：到账的币种，金额前面带上 */
export function changeValue(k: string, v: Json, t: Tr, cur?: string): string {
  if (v === null || v === undefined || v === '') return t('（空）')
  switch (k) {
    case 'amount_orig':
      return cur ? `${cur} ${money(v)}` : money(v)
    case 'other_charges_usd':
    case 'discount_usd':
    case 'down_payment_usd':
    case 'per_term_usd':
    case 'commission_usd':
      return '$ ' + money(v)
    case 'fx_rate':
    case 'payout_rate':
      return String(Number(v))
    case 'payout_ratio':
      return `${Math.round(Number(v) * 10000) / 100}%`
    case 'full_payment':
      return v ? t('是') : t('否')
    case 'attachments':
      return t('{n} 个', { n: Number(v) })
    default:
      return str(v)
  }
}

/** 清单里的一行 */
export function itemText(k: string, x: Json, t: Tr, cur?: string): string {
  const o: Obj = isObj(x) ? x : {}
  const parts: string[] = []
  if (k === 'claims') {
    parts.push(o.vin ? str(o.vin) : t('{customer}（没定大架号）', { customer: str(o.customer) }))
    if (o.nature) parts.push(t(str(o.nature)))
    parts.push(cur ? `${cur} ${money(o.amount)}` : money(o.amount))
  } else if (k === 'vehicles') {
    parts.push(o.model ? `${str(o.vin)}（${str(o.model)}）` : str(o.vin))
    if (o.commission !== null && o.commission !== undefined) parts.push(t('本车提成 {amt}', { amt: '$ ' + money(o.commission) }))
  } else if (k === 'payments') {
    parts.push(o.receipt ? str(o.receipt) : t('期初'))
    parts.push(o.vin ? str(o.vin) : t('未锁定'))
    if (o.date) parts.push(str(o.date))
    parts.push('$ ' + money(o.share))
  }
  if (o.note) parts.push(str(o.note))
  return parts.join(' · ')
}

/** 两份清单比一比：去掉的、加上的（一样的不列；改了一行 = 去掉旧的、加上新的） */
export function listDiff(a: Json, b: Json): { removed: Json[]; added: Json[] } {
  const A = Array.isArray(a) ? a : []
  const B = Array.isArray(b) ? b : []
  const key = (x: Json) => JSON.stringify(x)
  const left = new Map<string, number>()
  for (const x of B) left.set(key(x), (left.get(key(x)) ?? 0) + 1)
  const removed: Json[] = []
  for (const x of A) {
    const n = left.get(key(x)) ?? 0
    if (n > 0) left.set(key(x), n - 1)
    else removed.push(x)
  }
  const added: Json[] = []
  for (const x of B) {
    const n = left.get(key(x)) ?? 0
    if (n > 0) {
      added.push(x)
      left.set(key(x), n - 1)
    }
  }
  return { removed, added }
}

/** 一行文字说完改了什么（打印的提成单“审批过程”的意见栏用） */
export function changeSummary(changes: EditChange[], t: Tr, cur?: string): string {
  return changes
    .map((c) => {
      const label = changeLabel(c.k, t)
      if (!isListKey(c.k)) return `${label} ${changeValue(c.k, c.a, t, cur)} → ${changeValue(c.k, c.b, t, cur)}`
      const { removed, added } = listDiff(c.a, c.b)
      const lines = [...removed.map((x) => '− ' + itemText(c.k, x, t, cur)), ...added.map((x) => '+ ' + itemText(c.k, x, t, cur))]
      return `${label}：${lines.length ? lines.join('，') : t('顺序变了')}`
    })
    .join('；')
}
