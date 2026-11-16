// 工作台搜索（Rome 2026-11-16「我需要工作台能搜索」）：一个框管五栏，和种类筛选叠加。在数据库里筛（列表照旧一页 20 条），
// 栏目上的数字也按搜索数，看得出别的栏里有没有。不用改数据库：v_workbench 本来就有单号、客户、大架号、业务员、金额、账户。
// 这里只有纯函数（只引类型），node 可以直接 import 来测。
import type { Json } from './database.types'
import type { Account, Salesperson } from './supabase'

/** 搜索框里的字拆成词，最多 4 个。金额的千分位逗号先去掉（490,000.00 → 490000.00），
 *  再去掉会破坏 PostgREST or() 写法的字符（逗号、括号、通配符、引号、反斜杠） */
export function searchWords(q: string): string[] {
  const s = q.replace(/(\d),(?=\d{3}(?!\d))/g, '$1').replace(/[,()%*\\"]/g, ' ')
  return [...new Set(s.split(/\s+/).filter(Boolean))].slice(0, 4)
}

/** 词是不是一个金额：490000、490000.00、$100、GHS490000 */
export function searchAmount(w: string): { n: number; whole: boolean } | null {
  const m = /^(?:\$|¢|₵|GH₵|GHS|USD)?(\d{1,12})(?:\.(\d{1,2}))?$/i.exec(w)
  if (!m) return null
  return { n: Number(m[2] ? `${m[1]}.${m[2]}` : m[1]), whole: !m[2] }
}

/** 搜索要用的基础资料：账户（按名字找）、业务员（到账的业务员在拆分里，按名字找） */
export type SearchRef = {
  accounts: Pick<Account, 'id' | 'short_name' | 'list_name'>[]
  salespersons: Pick<Salesperson, 'name'>[]
}

const hasWord = (s: string | null | undefined, w: string) => !!s && s.toLowerCase().includes(w.toLowerCase())
/** PostgREST 值加双引号，里面有逗号、括号也不会拆错 */
const quoted = (v: string) => `"${v.replace(/[\\"]/g, (c) => '\\' + c)}"`
/** 拆分（claims）里有一行包含这些值 */
const claimHas = (o: Record<string, string | number>) => `claims.cs.${quoted(JSON.stringify([o]))}`
/** 名字里有这个词的业务员超过这么多个，就不在拆分里逐个比了（词太泛） */
const MAX_SP = 8

/** 一个词：在单号、客户、大架号、业务员、金额、账户里任一对上就算 */
function wordConditions(w: string, ref: SearchRef): string[] {
  const like = `%${w}%`
  // 单号（TC- / SK-）、到账提交通过后的到账编号、客户、大架号、业务员（到账提交、提成单）
  const out = ['doc_no', 'receipt_no', 'customer_name', 'vins', 'salesperson_name'].map((c) => `${c}.ilike.${like}`)
  // 币种：GHS、USD
  if (/^[a-z]{3}$/i.test(w)) out.push(`currency.eq.${w.toUpperCase()}`)
  // 账户：简称或全称里有这个词（ECO、8651、Cash、momo）
  const acc = ref.accounts.filter((a) => hasWord(a.short_name, w) || hasWord(a.list_name, w)).map((a) => a.id)
  if (acc.length) out.push(`account_id.in.(${acc.join(',')})`)
  // 到账的业务员：视图里在拆分每一行的 salesperson_name
  const sps = ref.salespersons.filter((s) => hasWord(s.name, w))
  if (sps.length <= MAX_SP) for (const s of sps) out.push(claimHas({ salesperson_name: s.name }))
  // 金额：整数对上 490000.00～490000.99；折美元卡片上四舍五入显示（≈ $ 40,833），按四舍五入比；拆分里某一行的金额也算
  const a = searchAmount(w)
  if (a) {
    if (a.whole) out.push(`and(amount.gte.${a.n},amount.lt.${a.n + 1})`, `and(amount_usd.gte.${a.n - 0.5},amount_usd.lt.${a.n + 0.5})`)
    else out.push(`amount.eq.${a.n}`, `amount_usd.eq.${a.n}`)
    out.push(claimHas({ amount_orig: a.n }))
  }
  return out
}

/** 搜索条件：PostgREST 逻辑树的一个节点，给 .or() 用（也能套进别的 and / or 里）。
 *  每个词都要对上（and），词在哪一列对上都行（or）。没有词时 null */
export function searchFilter(words: string[], ref: SearchRef): string | null {
  if (!words.length) return null
  const groups = words.map((w) => `or(${wordConditions(w, ref).join(',')})`)
  return groups.length === 1 ? groups[0] : `and(${groups.join(',')})`
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 卡片上把搜到的字标出来用：词拼成一个正则（不分大小写），没有词时 null */
export function searchRegex(words: string[]): RegExp | null {
  if (!words.length) return null
  return new RegExp('(' + words.map(escapeRegex).join('|') + ')', 'gi')
}

/** 到账拆分里的业务员（视图在 claims 每一行带 salesperson_name），去重 */
export function claimSalespersons(claims: Json | null | undefined): string[] {
  if (!Array.isArray(claims)) return []
  const names = claims.map((c) => (c && typeof c === 'object' && !Array.isArray(c) && typeof c.salesperson_name === 'string' ? c.salesperson_name : ''))
  return [...new Set(names.filter(Boolean))]
}
