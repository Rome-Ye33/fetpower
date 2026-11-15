import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL || 'https://lltqxosyzzbpellfljpv.supabase.co'
const key = import.meta.env.VITE_SUPABASE_KEY || 'sb_publishable_kGF93JQzkOgPsUXA6jqoHQ_dIpw_YVl'

/** 维护模式（39）：数据库的总闸拒绝了一个请求（HTTP 423）时发出这个事件，maintenance.tsx 马上去读状态、换成维护提示页 */
export const MAINT_EVENT = 'maintenance-hit'

let lastApiOk = 0
/**
 * 上一个成功（2xx）的 Data API 请求是什么时候发出的：每个请求都先过维护的总闸，成功就说明那一刻没被挡，
 * 维护状态的定时确认可以往后推（正在用网站的人不用另外查）
 */
export const lastApiOkAt = () => lastApiOk

// 每个请求原样发出去，只看一眼回来的状态码，不读内容
const watchFetch: typeof fetch = async (input, init) => {
  const started = Date.now()
  const res = await fetch(input, init)
  if (res.status === 423 && typeof window !== 'undefined') window.dispatchEvent(new Event(MAINT_EVENT))
  else if (res.ok && (input instanceof Request ? input.url : String(input)).includes('/rest/v1/')) lastApiOk = Math.max(lastApiOk, started)
  return res
}

export const supabase = createClient<Database>(url, key, { global: { fetch: watchFetch } })

type PublicSchema = Database['public']
export type TableRow<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row']
export type ViewRow<T extends keyof PublicSchema['Views']> = PublicSchema['Views'][T]['Row']

export type AppRole = PublicSchema['Enums']['app_role']
export type Account = TableRow<'bank_accounts'>
export type Nature = TableRow<'payment_natures'>
export type Salesperson = TableRow<'salespersons'>
export type ChequeBank = TableRow<'cheque_banks'>
export type Customer = TableRow<'customers'>
export type Profile = TableRow<'profiles'>
export type Invite = TableRow<'user_invites'>
export type FxRate = TableRow<'fx_rates'>
export type ImportFormat = TableRow<'bank_import_formats'>
export type Receipt = ViewRow<'v_bank_receipts'>
export type Claim = ViewRow<'v_receipt_claims'>
export type Vehicle = ViewRow<'v_vehicle_ledger'>
export type StatementLine = ViewRow<'v_statement_lines'>
export type ReceiptReport = ViewRow<'v_receipt_reports'>

export const VOUCHER_BUCKET = 'vouchers'

type Page<T> = { data: T[] | null; error: { message: string } | null }
/**
 * Supabase 的接口每次最多回 1000 行，超过的分页取完（车、客户导入后都会超过 1000）。
 * make 每次新建同一个查询；排序要唯一（最后带上 id），翻页才不会重复或漏行。
 */
export async function fetchAll<T>(
  make: () => { range: (from: number, to: number) => PromiseLike<Page<T>> },
  pageSize = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await make().range(from, from + pageSize - 1)
    if (error) return { data: out, error }
    out.push(...(data ?? []))
    if (!data || data.length < pageSize) return { data: out, error: null }
  }
}
