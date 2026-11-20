// 支票管理：客户给的（分期）支票一张一行，从收到 → 存进银行 → 钱到账（对上一笔到账）。
// 写库只走数据库函数 save_cheques / import_cheques / cheque_action；读 v_cheques（带客户、车、账户、到账、最近一条沟通）。
import { useBadges } from './badges'
import type { Json } from './database.types'
import { todayAccra } from './format'
import { supabase } from './supabase'
import type { TableRow, ViewRow } from './supabase'

export type Cheque = ViewRow<'v_cheques'>
export type ChequeLog = TableRow<'cheque_logs'>
export type ChequeStatus = 'pending' | 'confirming' | 'deposited' | 'cleared' | 'bounced' | 'cancelled'
export type ChequeAction = 'note' | 'confirm' | 'plan' | 'deposit' | 'link' | 'unlink' | 'bounce' | 'cancel' | 'reopen'

export const CHEQUE_STATUSES: ChequeStatus[] = ['pending', 'confirming', 'deposited', 'cleared', 'bounced', 'cancelled']
/** 状态的中文（也是翻译的键）：待存 → 等业务确认 → 已存 → 已到账；退票、已取消 */
export const CHEQUE_STATUS_LABEL: Record<ChequeStatus, string> = {
  pending: '待存',
  confirming: '等业务确认',
  deposited: '已存',
  cleared: '已到账',
  bounced: '退票',
  cancelled: '已取消',
}
export const CHEQUE_STATUS_COLOR: Record<ChequeStatus, string> = {
  pending: 'blue',
  confirming: 'orange',
  deposited: 'cyan',
  cleared: 'green',
  bounced: 'red',
  cancelled: 'default',
}
export const CHEQUE_PURPOSES = ['分期款', '预付款', '配件款', '其他'] as const
/** 记录里的动作（cheque_logs.action） */
export const CHEQUE_ACTION_LABEL: Record<string, string> = {
  create: '已录入',
  import: '从表格导入',
  edit: '已修改',
  note: '沟通记录',
  confirm: '请业务确认',
  plan: '定了计划存票日期',
  deposit: '已存进银行',
  link: '对上到账',
  unlink: '取消了和到账的关联',
  bounce: '退票',
  cancel: '已取消',
  reopen: '恢复待存',
}
export const CHEQUE_ACTION_COLOR: Record<string, string> = {
  create: 'blue',
  import: 'blue',
  edit: 'gray',
  note: 'gray',
  confirm: 'orange',
  plan: 'blue',
  deposit: 'cyan',
  link: 'green',
  unlink: 'gray',
  bounce: 'red',
  cancel: 'gray',
  reopen: 'blue',
}

export function chequeStatus(s: string | null | undefined): ChequeStatus {
  return (CHEQUE_STATUSES as string[]).includes(s ?? '') ? (s as ChequeStatus) : 'pending'
}

/** 这张支票对应的车（一张销售订单可能几台，按录入的顺序）；老数据只有 vehicle_id 时也认 */
export function chequeVehicleIds(c: Cheque): number[] {
  if (c.vehicle_ids?.length) return c.vehicle_ids
  return c.vehicle_id ? [c.vehicle_id] : []
}

/** 这张支票对应的大架号（视图里是空格拼起来的） */
export function chequeVins(c: Cheque): string[] {
  const s = c.vins ?? c.vin ?? ''
  return s.split(' ').filter(Boolean)
}

/**
 * 页面顶部的提醒：今天到期 / 明日到期 / 本周到期 / 到期没存 / 已存没到账（“已到账没报回款”随报款一起去掉了，Rome 2026-11-16）。
 * 一张票只落在一个里面：明天的算「明日到期」，「本周到期」从后天算起（Rome 2026-11-19「支票表设置个明日到期的分类」）。
 */
export type ChequeAlert = 'due_today' | 'due_tomorrow' | 'due_week' | 'overdue' | 'deposited'
export const CHEQUE_ALERTS: ChequeAlert[] = ['due_today', 'due_tomorrow', 'due_week', 'overdue', 'deposited']
export const CHEQUE_ALERT_LABEL: Record<ChequeAlert, string> = {
  due_today: '今天到期',
  due_tomorrow: '明日到期',
  due_week: '本周到期',
  overdue: '到期还没存',
  deposited: '已存没到账',
}
const OPEN: string[] = ['pending', 'confirming']

/**
 * 本周（周一到周日）还剩几天：周五还剩 2 天（周六、周日），周日是 0 天。
 * 「本周到期」按它算，不是往后数 7 天（Rome 2026-11-13「支票表设置本周到期，不要显示未来 7 天到期的」）。
 */
export function daysLeftThisWeek(today: string = todayAccra()): number {
  const wd = new Date(today + 'T00:00:00Z').getUTCDay()   // 0 = 周日
  return 7 - (wd === 0 ? 7 : wd)
}

/**
 * 排提醒用的天数：还没存的票定了「计划存票日期」就按计划日期算，没定的按到期日期算。
 * Rome 2026-11-18 17:52「我希望定好存票日后，存票日期当天支票会出现在今天到期列表」：
 * 过期的票定了将来某天的计划，先从「到期还没存」退出来，前一天进「明日到期」，到计划那天进「今天到期」，过了还没存再回去。
 * 「到期日期」那一列显示的还是真正的到期日和「过了 N 天」，不走这里。
 */
export function daysToAct(c: Cheque, today: string = todayAccra()): number | null {
  if (c.plan_date) return Math.round((Date.parse(c.plan_date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
  return c.days_to_due ?? null
}

export function inAlert(c: Cheque, a: ChequeAlert): boolean {
  const d = daysToAct(c)
  switch (a) {
    case 'due_today':
      return OPEN.includes(c.status ?? '') && d === 0
    case 'due_tomorrow':
      // 跨周也算：周日看到的是周一的
      return OPEN.includes(c.status ?? '') && d === 1
    case 'due_week':
      // 今天、明天的分别算在「今天到期」「明日到期」里，这里只算后天到本周日
      return OPEN.includes(c.status ?? '') && d != null && d > 1 && d <= daysLeftThisWeek()
    case 'overdue':
      return OPEN.includes(c.status ?? '') && d != null && d < 0
    case 'deposited':
      return c.status === 'deposited'
  }
}

/** 还没存的票（待存 / 等业务确认）：存票审批单只放这两种 */
export function waitingDeposit(c: Cheque): boolean {
  return OPEN.includes(c.status ?? '')
}

/**
 * 这张票按哪天算（台账的「到期日期」筛选用）：定了「计划存票日期」就按计划日期，没定的按支票上的到期日期，
 * 什么状态都一样（和 daysToAct 一样先看计划日期）。Rome 2026-11-20「修改存票日期后的不会出现在这里吗」
 * 「有计划日期的按计划日期，没有的就按支票上的日期，所有的都是」：到期 11-22 改到 11-23 存的票，选 11-23 出来，选 11-22 不出来。
 */
export function actDate(c: Cheque): string | null {
  return c.plan_date || c.due_date || null
}

/**
 * 支票存票审批单（Rome 2026-11-19：明日到期的列表全选打印，有金额的照印，没写金额的业务部确认金额，
 * 应收会计、财务主管（原来叫财务经理，Rome 11:33 改的）、销售部签字）：新标签页打开打印页，勾中的支票 id 放在地址里。
 */
export function printDepositForm(ids: number[]) {
  const base = window.location.href.split('#')[0]
  window.open(`${base}#/print/cheque-deposit?ids=${ids.join(',')}`, '_blank', 'noopener')
}

/** 支票有变化（录入、存票、对上到账）时让列表和菜单角标重新读 */
export function notifyChequesChanged() {
  window.dispatchEvent(new Event('cheques-changed'))
}

type ActionResult = { status: ChequeStatus; updated_at: string; receipt_id: number | null }
export async function chequeAction(id: number, action: ChequeAction, p: Record<string, Json | undefined> = {}) {
  const { data, error } = await supabase.rpc('cheque_action', { p_id: id, p_action: action, p: p as Json })
  return { data: data as ActionResult | null, error }
}

export async function fetchChequeLogs(id: number): Promise<ChequeLog[]> {
  const { data } = await supabase.from('cheque_logs').select('*').eq('cheque_id', id).order('at').order('id')
  return data ?? []
}

/** 菜单角标：到期还没存的 + 存了 3 天还没到账的（数据库算）。数字由 badges.ts 的共用轮询取，5 分钟一次 */
export function useChequeAlert(enabled: boolean): number {
  return useBadges(enabled, true).cheque
}

/** 批量录入：第一张的号码加 1、到期日按月加（月底顺延到月末），生成 n 张 */
export function nextChequeNo(no: string, step: number): string {
  const m = /^(.*?)(\d+)$/.exec(no.trim())
  if (!m) return no
  const next = String(Number(m[2]) + step)
  return m[1] + next.padStart(m[2].length, '0')
}
