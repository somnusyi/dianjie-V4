export type DeliveryProduct = {
  name: string; spec: string | null; unit: string; code: string
  category?: string | null
  location?: string | null
}

/** Display-only ordering; never alters stored lines, quantities or money. */
export function sortDeliveryNoteItems<T extends { product?: DeliveryProduct }>(items: T[], categories: string[] = []): T[] {
  const ranks = new Map(categories.map((name, index) => [name, index]))
  const collator = new Intl.Collator('zh-CN', { numeric: true })
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const ac = a.item.product?.category?.trim() || '其他'
    const bc = b.item.product?.category?.trim() || '其他'
    return (ranks.get(ac) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(bc) ?? Number.MAX_SAFE_INTEGER)
      || collator.compare(ac, bc)
      || Number(!a.item.product?.location?.trim()) - Number(!b.item.product?.location?.trim())
      || collator.compare(a.item.product?.location?.trim() || '', b.item.product?.location?.trim() || '')
      || collator.compare(a.item.product?.name || '', b.item.product?.name || '')
      || collator.compare(a.item.product?.code || '', b.item.product?.code || '')
      || a.index - b.index
  }).map(row => row.item)
}

export const deliveryNoteStyles = `
@font-face { font-family:'HarmonyOS Sans SC'; src:url('/fonts/harmonyos/HarmonyOS_Sans_SC_Medium.ttf') format('truetype'); font-weight:500; font-style:normal; font-display:block; }
@font-face { font-family:'HarmonyOS Sans SC'; src:url('/fonts/harmonyos/HarmonyOS_Sans_SC_Black.ttf') format('truetype'); font-weight:900; font-style:normal; font-display:block; }
[data-delivery-note-print] { box-sizing:border-box; color:#000; background:#fff; font-family:'HarmonyOS Sans SC',sans-serif; font-weight:500; font-synthesis:none; font-size:13px; line-height:20px; }
[data-delivery-note-print] * { box-sizing:border-box; font-family:inherit; }
[data-delivery-note-letterhead] { display:flex; align-items:baseline; justify-content:space-between; gap:16px; border-bottom:2px solid #000; padding-bottom:5px; }
[data-delivery-note-letterhead] h1 { margin:0; font-size:26px; line-height:32px; font-weight:900; white-space:nowrap; }
[data-delivery-note-company] { font-size:14px; line-height:20px; text-align:right; font-weight:500; }
[data-delivery-note-references] { display:grid; grid-template-columns:max-content minmax(0,1fr); column-gap:18px; align-items:start; margin:6px 0 4px; font-size:12px; line-height:18px; }
[data-delivery-note-time] { white-space:nowrap; }
[data-delivery-note-numbers] { display:flex; flex-wrap:wrap; gap:0 10px; min-width:0; }
[data-delivery-note-reference] { white-space:nowrap; }
[data-delivery-note-parties] { display:grid; grid-template-columns:1fr 1fr; column-gap:14px; row-gap:2px; }
[data-delivery-note-parties] > div { min-width:0; overflow-wrap:anywhere; }
[data-delivery-note-parties] .delivery-contact { white-space:nowrap; overflow-wrap:normal; }
[data-delivery-note-address] { margin-top:2px; overflow-wrap:anywhere; }
[data-delivery-note-print] table { width:100%; table-layout:fixed; border-collapse:collapse; margin-top:8px; font-size:16px; line-height:20px; }
[data-delivery-note-print] th,[data-delivery-note-print] td { border:1px solid #000; padding:6px 3px; vertical-align:middle; overflow-wrap:anywhere; }
[data-delivery-note-print] th { font-weight:900; text-align:left; background:#fff; }

[data-delivery-note-print] .delivery-name { font-weight:900; }
[data-delivery-note-print] .delivery-center { text-align:center; }
[data-delivery-note-print] .delivery-number { text-align:right; font-size:16px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow-wrap:normal; }
[data-delivery-note-print] .delivery-adjustment { display:block; font-size:12px; line-height:16px; white-space:nowrap; }
[data-delivery-note-totals] { font-weight:900; }
[data-delivery-note-footer] { font-size:13px; line-height:20px; padding-top:8px; }
[data-delivery-note-footer] p { margin:0 0 3px; overflow-wrap:anywhere; }
.delivery-footer-info { display:flex; justify-content:space-between; gap:12px; }
[data-delivery-note-signature] { display:flex; justify-content:flex-end; gap:18px; padding:12px 0 8px; }
[data-delivery-note-bottom] { display:flex; justify-content:space-between; border-top:1px solid #000; padding-top:4px; font-size:11px; line-height:16px; }
[data-delivery-note-page-number] { font-size:11px; line-height:16px; text-align:right; padding-top:6px; }
`

export async function waitForDeliveryNoteFonts() {
  await Promise.all([document.fonts.load('500 16px "HarmonyOS Sans SC"'), document.fonts.load('900 16px "HarmonyOS Sans SC"')])
  if (!document.fonts.check('500 16px "HarmonyOS Sans SC"') || !document.fonts.check('900 16px "HarmonyOS Sans SC"')) {
    throw new Error('送货单字体加载失败，请重试')
  }
}

