import { useCallback, useEffect, useState } from 'react'
import type { JournalLine } from './journal'
import { supabase } from './supabase'

// 「对上已记的」（数据库 40）用的：等流水的（银行账户先记的收付、银行流水里还没有的到账），v_journal.waiting = true。
// 自动配对只配分得清的（号码对得上，或者同账户、同金额、3 天内一对一）；分不清的、日期隔得远的、号码没写的，由人在待填的流水上选。

/** 要对上的那条流水（待填的） */
export type PairLine = {
  line_id: number
  account_id: number
  /** 收为正、付为负 */
  amount: number
  entry_date: string
  currency: string
  bank_summary: string | null
}

/** 日记账里的一条待填流水 → 要对上的那条 */
export const pairLineOf = (l: JournalLine): PairLine | null =>
  l.line_id && l.account_id
    ? {
        line_id: l.line_id,
        account_id: l.account_id,
        amount: l.amount_in ? Number(l.amount_in) : -Number(l.amount_out ?? 0),
        entry_date: l.entry_date ?? '',
        currency: l.currency ?? '',
        bank_summary: l.bank_summary,
      }
    : null

/** 等流水的一笔：哪个账户、金额（收为正、付为负）、到账还是收支 */
type Waiting = { account_id: number; signed: number; source: 'entry' | 'receipt' }

/** 这个账户里等流水的、和这条流水方向一样的（收为正 1、付为负 -1） */
export async function fetchWaiting(accountId: number, sign: 1 | -1) {
  const q = supabase.from('v_journal').select('*').eq('account_id', accountId).eq('waiting', true)
  const { data, error } = await (sign > 0 ? q.not('amount_in', 'is', null) : q.not('amount_out', 'is', null))
  return { rows: (data ?? []) as JournalLine[], error }
}

/** 一条流水能对上几笔等流水的：any 同方向的，same 其中同金额的 */
export type WaitingCount = { any: number; same: number }
/** 能配哪几种：收支（要能改“银行日记账”）、到账（要能改“银行对账”） */
export type WaitingSources = { entry: boolean; receipt: boolean }

/**
 * 等流水的各账户、各方向有哪些金额：待填的流水上要不要出「对上已记的」（同金额的有几笔）。
 * enabled = 有待填的流水、有权限的时候才读；accountId 空 = 全部账户；version 一变就重读（对上了、记了一笔……）
 */
export function useWaitingIndex(enabled: boolean, accountId: number | undefined, version: number) {
  const [rows, setRows] = useState<Waiting[]>([])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let q = supabase.from('v_journal').select('account_id, source, amount_in, amount_out').eq('waiting', true).limit(5000)
    if (accountId) q = q.eq('account_id', accountId)
    void q.then(({ data }) => {
      if (!alive) return
      setRows(
        (data ?? []).map((r) => ({
          account_id: Number(r.account_id),
          signed: r.amount_in != null ? Number(r.amount_in) : -Number(r.amount_out ?? 0),
          source: r.source === 'receipt' ? 'receipt' : 'entry',
        })),
      )
    })
    return () => {
      alive = false
    }
  }, [enabled, accountId, version])
  return useCallback(
    (acc: number | null | undefined, signed: number, src: WaitingSources): WaitingCount => {
      let any = 0
      let same = 0
      if (!enabled || !acc || !signed) return { any, same }
      for (const w of rows) {
        if (w.account_id !== acc || Math.sign(w.signed) !== Math.sign(signed) || !src[w.source]) continue
        any++
        if (Math.abs(w.signed - signed) < 0.005) same++
      }
      return { any, same }
    },
    [rows, enabled],
  )
}
