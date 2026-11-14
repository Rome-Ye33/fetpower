// 大架号未锁定：到账款、期初拆到客户名下，还没定是哪台车（receipt_claims.vehicle_id 空着）。
// 到账录入、车辆台账、菜单角标都按这一个口径算：审批中的也算（录的时候就没定车），退回、撤回的不算。
export const UNLOCKED_KINDS = ['payment', 'opening']
/** v_receipt_claims 的 .or()：期初（不挂到账）+ 挂在审批中、已生效到账上的 */
export const UNLOCKED_LIVE = 'receipt_status.is.null,receipt_status.in.(pending,approved)'
