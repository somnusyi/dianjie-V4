// 厨师长从自己的采购单详情进入；页面与供应商送货单保持同一打印/PDF口径，
// 读取权限仍由订单 API 按当前角色、门店和创建人范围校验。
export { default } from '@/app/v2/supplier/orders/[id]/delivery-note/page'
