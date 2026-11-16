import type { Json } from '../lib/database.types'
import { changeLabel, changeValue, isListKey, itemText, listDiff, parseChanges } from '../lib/editChanges'
import { useT } from '../lib/i18n'

// 审批记录里“已修改”那一行下面：改了哪几项、改前 → 改后；拆分、车辆、付款列出去掉的和加上的（42）
// 支票详情的「记录」里「已修改」下面也用它（43）。币种也改了的，改前的金额带改前的币种

export default function EditChanges({ changes, currency }: { changes: Json | null | undefined; currency?: string }) {
  const t = useT()
  const list = parseChanges(changes)
  if (!list.length) return null
  const curChange = list.find((c) => c.k === 'currency')
  const curOf = (v: Json | undefined) => (typeof v === 'string' && v ? v : currency)
  const curA = curChange ? curOf(curChange.a) : currency
  const curB = curChange ? curOf(curChange.b) : currency
  return (
    <div className="edit-changes">
      {list.map((c) => {
        const label = changeLabel(c.k, t)
        if (isListKey(c.k)) {
          const { removed, added } = listDiff(c.a, c.b)
          return (
            <div key={c.k} className="edit-change">
              <span className="edit-label">{label}：</span>
              {!removed.length && !added.length && <span>{t('顺序变了')}</span>}
              {removed.map((x, i) => (
                <div key={`r${i}`} className="edit-removed">
                  − {itemText(c.k, x, t, currency)}
                </div>
              ))}
              {added.map((x, i) => (
                <div key={`a${i}`} className="edit-added">
                  + {itemText(c.k, x, t, currency)}
                </div>
              ))}
            </div>
          )
        }
        return (
          <div key={c.k} className="edit-change">
            <span className="edit-label">{label}：</span>
            <span className="edit-before">{changeValue(c.k, c.a, t, curA)}</span>
            <span className="edit-arrow"> → </span>
            <span className="edit-after">{changeValue(c.k, c.b, t, curB)}</span>
          </div>
        )
      })}
    </div>
  )
}
